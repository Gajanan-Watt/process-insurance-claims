const mongoose = require('mongoose');
const PolicyVersion = require('../models/PolicyVersion');
const ClaimDecision = require('../models/ClaimDecision');
const Claim = require('../models/Claim');
const limitService = require('./limit.service');

// Find the PolicyVersion whose rules govern a claim with this dateOfService.
// Uses the version active on that date (effectiveFrom <= date <= effectiveTo or effectiveTo is null).
async function findPolicyVersion(policyId, dateOfService, session) {
  return PolicyVersion.findOne(
    {
      policyId,
      effectiveFrom: { $lte: dateOfService },
      $or: [{ effectiveTo: null }, { effectiveTo: { $gte: dateOfService } }]
    },
    null,
    { session }
  ).sort({ effectiveFrom: -1 });
}

function findCoverageRule(policyVersion, item) {
  return policyVersion.coverageRules.find(
    rule =>
      rule.benefitCategory === item.benefitCategory &&
      (rule.serviceTypes.length === 0 || rule.serviceTypes.includes(item.serviceType))
  );
}

function approvalExplanation(item, rule, approvedAmount) {
  const parts = [
    `${item.serviceType} is covered under ${item.benefitCategory} at ${rule.coveredPercent}% of the billed amount.`
  ];
  if (rule.deductible > 0) {
    parts.push(`A deductible of $${rule.deductible.toFixed(2)} was applied.`);
  }
  if (approvedAmount < item.billedAmount * (rule.coveredPercent / 100)) {
    parts.push(`Approved amount capped at annual limit remaining.`);
  }
  parts.push(`Approved: $${approvedAmount.toFixed(2)} of $${item.billedAmount.toFixed(2)} billed.`);
  return parts.join(' ');
}

async function createOrSupersede(decisionData, session) {
  const existing = await ClaimDecision.findOne(
    { claimItemId: decisionData.claimItemId, supersededBy: null },
    null,
    { session }
  );

  const decision = new ClaimDecision({
    ...decisionData,
    versionNumber: existing ? existing.versionNumber + 1 : 1
  });
  await decision.save({ session });

  if (existing) {
    existing.supersededBy = decision._id;
    await existing.save({ session });
  }

  return decision;
}

// Core adjudication logic — runs inside a transaction.
// Returns { claimStatus, decisions[] }
async function adjudicateClaim(claimId, triggeringEvent = 'INITIAL_SUBMISSION') {
  const session = await mongoose.startSession();

  try {
    let outcome;
    await session.withTransaction(async () => {
      const claim = await Claim.findById(claimId).session(session);
      if (!claim) throw new Error(`Claim ${claimId} not found`);

      const policyVersion = await findPolicyVersion(claim.policyId, claim.dateOfService, session);

      if (!policyVersion) {
        for (const item of claim.items) {
          await createOrSupersede({
            claimId: claim._id,
            claimItemId: item._id,
            policyVersionId: null,
            billedAmount: item.billedAmount,
            approvedAmount: 0,
            denialCode: 'NO_COVERAGE_VERSION',
            denialReason: 'No policy coverage was active on the date of service',
            explanation: `No policy version was active on ${claim.dateOfService.toISOString().split('T')[0]}. All items denied.`,
            triggeringEvent
          }, session);
          item.status = 'DENIED';
        }
        claim.status = 'DENIED';
        await claim.save({ session });
        outcome = { claimStatus: 'DENIED', decisions: [] };
        return;
      }

      const decisions = [];
      let approvedCount = 0;
      let deniedCount = 0;

      for (const item of claim.items) {
        const rule = findCoverageRule(policyVersion, item);

        if (!rule) {
          const d = await createOrSupersede({
            claimId: claim._id,
            claimItemId: item._id,
            policyVersionId: policyVersion._id,
            billedAmount: item.billedAmount,
            approvedAmount: 0,
            denialCode: 'NOT_COVERED',
            denialReason: `Service type '${item.serviceType}' in category '${item.benefitCategory}' is not covered`,
            explanation: `${item.serviceType} is not included in your ${item.benefitCategory} coverage. See your policy document for covered services.`,
            triggeringEvent
          }, session);
          item.status = 'DENIED';
          decisions.push(d);
          deniedCount++;
          continue;
        }

        if (rule.requiresPreAuth) {
          const d = await createOrSupersede({
            claimId: claim._id,
            claimItemId: item._id,
            policyVersionId: policyVersion._id,
            billedAmount: item.billedAmount,
            approvedAmount: 0,
            denialCode: 'REQUIRES_PRE_AUTH',
            denialReason: 'Prior authorization required',
            explanation: `${item.serviceType} requires prior authorization. Obtain pre-auth and resubmit.`,
            triggeringEvent
          }, session);
          item.status = 'DENIED';
          decisions.push(d);
          deniedCount++;
          continue;
        }

        const available = await limitService.getAvailable(
          claim.policyId,
          claim.memberId,
          item.benefitCategory,
          claim.dateOfService,
          rule.annualLimit,
          session
        );

        if (available <= 0) {
          const d = await createOrSupersede({
            claimId: claim._id,
            claimItemId: item._id,
            policyVersionId: policyVersion._id,
            billedAmount: item.billedAmount,
            approvedAmount: 0,
            denialCode: 'LIMIT_EXHAUSTED',
            denialReason: `Annual limit of $${rule.annualLimit.toFixed(2)} for ${item.benefitCategory} is exhausted`,
            explanation: `Your $${rule.annualLimit.toFixed(2)} annual benefit for ${item.benefitCategory} has been fully used this year. No further claims for this category can be approved until the new benefit year.`,
            triggeringEvent
          }, session);
          item.status = 'DENIED';
          decisions.push(d);
          deniedCount++;
          continue;
        }

        const coveredGross = item.billedAmount * (rule.coveredPercent / 100);
        const afterDeductible = Math.max(0, coveredGross - rule.deductible);
        // consume() internally caps to available — handles partial approval at limit boundary
        const approvedAmount = await limitService.consume(
          claim.policyId,
          claim.memberId,
          item.benefitCategory,
          claim.dateOfService,
          claim._id,
          item._id,
          afterDeductible,
          rule.annualLimit,
          session
        );

        const d = await createOrSupersede({
          claimId: claim._id,
          claimItemId: item._id,
          policyVersionId: policyVersion._id,
          billedAmount: item.billedAmount,
          approvedAmount,
          coveredPercent: rule.coveredPercent,
          deductibleApplied: rule.deductible,
          explanation: approvalExplanation(item, rule, approvedAmount),
          triggeringEvent
        }, session);
        item.status = 'APPROVED';
        decisions.push(d);
        approvedCount++;
      }

      if (approvedCount === claim.items.length) {
        claim.status = 'APPROVED';
      } else if (approvedCount > 0) {
        claim.status = 'PARTIALLY_APPROVED';
      } else {
        claim.status = 'DENIED';
      }

      await claim.save({ session });
      outcome = { claimStatus: claim.status, decisions };
    });

    return outcome;
  } finally {
    await session.endSession();
  }
}

module.exports = { adjudicateClaim, findPolicyVersion, findCoverageRule };
