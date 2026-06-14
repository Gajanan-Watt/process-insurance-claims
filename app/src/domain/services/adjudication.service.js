const mongoose = require('mongoose');
const Policy = require('../models/Policy');
const PolicyVersion = require('../models/PolicyVersion');
const ClaimDecision = require('../models/ClaimDecision');
const Claim = require('../models/Claim');
const limitService = require('./limit.service');
const deductibleService = require('./deductible.service');
const eventBus = require('../events/eventBus');
const EVENTS = require('../events/events');

function ruleSnapshot(rule) {
  return {
    benefitCategory: rule.benefitCategory,
    serviceTypes: rule.serviceTypes,
    coveredPercent: rule.coveredPercent,
    annualLimit: rule.annualLimit,
    annualDeductible: rule.annualDeductible,
    requiresPreAuth: rule.requiresPreAuth,
    requiresManualReview: rule.requiresManualReview
  };
}

// Find the PolicyVersion whose rules govern a claim with this dateOfService.
// Primary: version active on the date (effectiveFrom <= date <= effectiveTo or effectiveTo is null).
// Fallback: a retroactive version — covers dates before its own effectiveFrom.
async function findPolicyVersion(policyId, dateOfService, session) {
  const exact = await PolicyVersion.findOne(
    {
      policyId,
      effectiveFrom: { $lte: dateOfService },
      $or: [{ effectiveTo: null }, { effectiveTo: { $gte: dateOfService } }]
    },
    null,
    { session }
  ).sort({ effectiveFrom: -1 });

  if (exact) return exact;

  // Retroactive version: admin marked this version as covering dates before its effectiveFrom.
  return PolicyVersion.findOne(
    { policyId, isRetroactive: true },
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

function approvalExplanation(item, rule, deductibleApplied, approvedAmount, wasLimitCapped) {
  const parts = [
    `Service is covered under your benefit plan at ${rule.coveredPercent}% of the eligible amount.`
  ];
  if (deductibleApplied > 0) {
    parts.push(`$${deductibleApplied.toFixed(2)} applied toward your annual deductible.`);
  }
  if (wasLimitCapped) {
    parts.push(`Approved amount capped at annual limit remaining.`);
  }
  parts.push(`Approved: $${approvedAmount.toFixed(2)} of $${item.billedAmount.toFixed(2)} billed.`);
  return parts.join(' ');
}

// Returns { decision, supersededId } — supersededId is null when no prior decision existed.
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

  return { decision, supersededId: existing ? existing._id : null };
}

// Core adjudication logic — runs inside a transaction.
// Returns { claimStatus, decisions[] }
async function adjudicateClaim(claimId, triggeringEvent = 'INITIAL_SUBMISSION', performedBy = 'system') {
  const session = await mongoose.startSession();

  const supersededEvents = [];
  const consumedEvents = [];

  try {
    let outcome;
    await session.withTransaction(async () => {
      const claim = await Claim.findById(claimId).session(session);
      if (!claim) throw new Error(`Claim not found`);

      // Validate the policy is still active before adjudicating.
      const policy = await Policy.findById(claim.policyId).session(session);
      if (!policy || policy.status !== 'ACTIVE') {
        for (const item of claim.items) {
          const { decision, supersededId } = await createOrSupersede({
            claimId: claim._id,
            claimItemId: item._id,
            benefitCategory: item.benefitCategory,
            policyVersionId: null,
            performedBy,
            decisionType: 'DENIED',
            billedAmount: item.billedAmount,
            approvedAmount: 0,
            ruleApplied: null,
            coverageRemainingAfter: null,
            denialCode: 'POLICY_INACTIVE',
            denialReason: `Policy is ${policy?.status ?? 'not found'}`,
            explanation: `Your policy is not active. All items denied.`,
            triggeringEvent
          }, session);
          if (supersededId) {
            supersededEvents.push({ supersededId, newDecisionId: decision._id, claimId: claim._id, claimItemId: item._id });
          }
          item.status = 'DENIED';
        }
        claim.status = 'DENIED';
        await claim.save({ session });
        outcome = { claimStatus: 'DENIED', decisions: [] };
        return;
      }

      const policyVersion = await findPolicyVersion(claim.policyId, claim.dateOfService, session);

      if (!policyVersion) {
        for (const item of claim.items) {
          const { decision, supersededId } = await createOrSupersede({
            claimId: claim._id,
            claimItemId: item._id,
            benefitCategory: item.benefitCategory,
            policyVersionId: null,
            performedBy,
            decisionType: 'DENIED',
            billedAmount: item.billedAmount,
            approvedAmount: 0,
            ruleApplied: null,
            coverageRemainingAfter: null,
            denialCode: 'NO_COVERAGE_VERSION',
            denialReason: 'No policy coverage was active on the date of service',
            explanation: `No policy version was active on the date of service. All items denied.`,
            triggeringEvent
          }, session);
          if (supersededId) {
            supersededEvents.push({ supersededId, newDecisionId: decision._id, claimId: claim._id, claimItemId: item._id });
          }
          item.status = 'DENIED';
        }
        claim.status = 'DENIED';
        await claim.save({ session });
        outcome = { claimStatus: 'DENIED', decisions: [] };
        return;
      }

      const decisions = [];
      let fullyApprovedCount = 0;
      let partiallyApprovedCount = 0;
      let deniedCount = 0;
      let needsReviewCount = 0;

      for (const item of claim.items) {
        const rule = findCoverageRule(policyVersion, item);

        if (!rule) {
          const { decision: d, supersededId } = await createOrSupersede({
            claimId: claim._id,
            claimItemId: item._id,
            benefitCategory: item.benefitCategory,
            policyVersionId: policyVersion._id,
            performedBy,
            decisionType: 'DENIED',
            billedAmount: item.billedAmount,
            approvedAmount: 0,
            ruleApplied: null,
            coverageRemainingAfter: null,
            denialCode: 'NOT_COVERED',
            denialReason: `Service type not covered under the submitted benefit category`,
            explanation: `This service type is not included in your coverage for this benefit category. See your policy document for covered services.`,
            triggeringEvent
          }, session);
          if (supersededId) {
            supersededEvents.push({ supersededId, newDecisionId: d._id, claimId: claim._id, claimItemId: item._id });
          }
          item.status = 'DENIED';
          decisions.push(d);
          deniedCount++;
          continue;
        }

        if (rule.requiresPreAuth) {
          const { decision: d, supersededId } = await createOrSupersede({
            claimId: claim._id,
            claimItemId: item._id,
            benefitCategory: item.benefitCategory,
            policyVersionId: policyVersion._id,
            performedBy,
            decisionType: 'DENIED',
            billedAmount: item.billedAmount,
            approvedAmount: 0,
            ruleApplied: ruleSnapshot(rule),
            coverageRemainingAfter: null,
            denialCode: 'REQUIRES_PRE_AUTH',
            denialReason: 'Prior authorization required',
            explanation: `This service requires prior authorization. Obtain pre-auth and resubmit.`,
            triggeringEvent
          }, session);
          if (supersededId) {
            supersededEvents.push({ supersededId, newDecisionId: d._id, claimId: claim._id, claimItemId: item._id });
          }
          item.status = 'DENIED';
          decisions.push(d);
          deniedCount++;
          continue;
        }

        // Route to manual review queue — no amount calculated, no limit consumed.
        if (rule.requiresManualReview) {
          const { decision: d, supersededId } = await createOrSupersede({
            claimId: claim._id,
            claimItemId: item._id,
            benefitCategory: item.benefitCategory,
            policyVersionId: policyVersion._id,
            performedBy,
            decisionType: 'NEEDS_REVIEW',
            billedAmount: item.billedAmount,
            approvedAmount: 0,
            ruleApplied: ruleSnapshot(rule),
            coverageRemainingAfter: null,
            explanation: `This service requires manual review by an adjuster.`,
            triggeringEvent
          }, session);
          if (supersededId) {
            supersededEvents.push({ supersededId, newDecisionId: d._id, claimId: claim._id, claimItemId: item._id });
          }
          item.status = 'NEEDS_REVIEW';
          decisions.push(d);
          needsReviewCount++;
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
          const { decision: d, supersededId } = await createOrSupersede({
            claimId: claim._id,
            claimItemId: item._id,
            benefitCategory: item.benefitCategory,
            policyVersionId: policyVersion._id,
            performedBy,
            decisionType: 'DENIED',
            billedAmount: item.billedAmount,
            approvedAmount: 0,
            ruleApplied: ruleSnapshot(rule),
            coverageRemainingAfter: 0,
            denialCode: 'LIMIT_EXHAUSTED',
            denialReason: `Annual benefit limit for this category is exhausted`,
            explanation: `Your annual benefit for this category has been fully used. No further claims can be approved until the new benefit year.`,
            triggeringEvent
          }, session);
          if (supersededId) {
            supersededEvents.push({ supersededId, newDecisionId: d._id, claimId: claim._id, claimItemId: item._id });
          }
          item.status = 'DENIED';
          decisions.push(d);
          deniedCount++;
          continue;
        }

        // Deductible: apply to billed amount first, then coverage percent applies to the remainder.
        // Deductible accumulates annually — only the unmet portion is consumed here.
        const deductibleApplied = await deductibleService.apply(
          claim.policyId,
          claim.memberId,
          item.benefitCategory,
          claim.dateOfService,
          claim._id,
          item._id,
          Math.min(item.billedAmount, rule.annualDeductible),
          rule.annualDeductible,
          session
        );
        const afterDeductible = Math.max(0, item.billedAmount - deductibleApplied);
        const coveredGross = afterDeductible * (rule.coveredPercent / 100);

        // consume() internally caps to available — handles partial approval at limit boundary.
        const approvedAmount = await limitService.consume(
          claim.policyId,
          claim.memberId,
          item.benefitCategory,
          claim.dateOfService,
          claim._id,
          item._id,
          coveredGross,
          rule.annualLimit,
          session
        );

        const wasLimitCapped = approvedAmount < coveredGross;
        const remainingAfter = available - approvedAmount;
        const isPartial = wasLimitCapped;

        const { decision: d, supersededId } = await createOrSupersede({
          claimId: claim._id,
          claimItemId: item._id,
          benefitCategory: item.benefitCategory,
          policyVersionId: policyVersion._id,
          performedBy,
          decisionType: isPartial ? 'PARTIALLY_APPROVED' : 'APPROVED',
          billedAmount: item.billedAmount,
          approvedAmount,
          coveredPercent: rule.coveredPercent,
          deductibleApplied,
          ruleApplied: ruleSnapshot(rule),
          coverageRemainingAfter: remainingAfter,
          explanation: approvalExplanation(item, rule, deductibleApplied, approvedAmount, wasLimitCapped),
          triggeringEvent
        }, session);
        if (supersededId) {
          supersededEvents.push({ supersededId, newDecisionId: d._id, claimId: claim._id, claimItemId: item._id });
        }
        consumedEvents.push({
          policyId: claim.policyId,
          memberId: claim.memberId,
          benefitCategory: item.benefitCategory,
          amount: approvedAmount,
          claimId: claim._id,
          claimItemId: item._id,
          remainingAfter
        });
        item.status = isPartial ? 'PARTIALLY_APPROVED' : 'APPROVED';
        decisions.push(d);
        if (isPartial) partiallyApprovedCount++;
        else fullyApprovedCount++;
      }

      // NEEDS_REVIEW holds the claim open regardless of other item outcomes.
      // APPROVED only when every item is fully approved — any limit-capped item → PARTIALLY_APPROVED.
      if (needsReviewCount > 0) {
        claim.status = 'UNDER_REVIEW';
      } else if (fullyApprovedCount === claim.items.length) {
        claim.status = 'APPROVED';
      } else if (fullyApprovedCount > 0 || partiallyApprovedCount > 0) {
        claim.status = 'PARTIALLY_APPROVED';
      } else {
        claim.status = 'DENIED';
      }

      await claim.save({ session });
      outcome = { claimStatus: claim.status, decisions };
    });

    eventBus.emit(EVENTS.CLAIM_ADJUDICATED, { claimId, claimStatus: outcome.claimStatus, triggeringEvent, performedBy });

    for (const d of outcome.decisions) {
      eventBus.emit(EVENTS.ITEM_DECISION_MADE, {
        claimId,
        claimItemId: d.claimItemId,
        decisionId: d._id,
        decisionType: d.decisionType,
        benefitCategory: d.benefitCategory,
        approvedAmount: d.approvedAmount,
        denialCode: d.denialCode ?? null,
        versionNumber: d.versionNumber
      });
    }

    for (const s of supersededEvents) {
      eventBus.emit(EVENTS.DECISION_SUPERSEDED, s);
    }

    for (const c of consumedEvents) {
      eventBus.emit(EVENTS.BENEFIT_LIMIT_CONSUMED, c);
      if (c.remainingAfter === 0) {
        eventBus.emit(EVENTS.BENEFIT_LIMIT_EXHAUSTED, {
          policyId: c.policyId,
          memberId: c.memberId,
          benefitCategory: c.benefitCategory
        });
      }
    }

    return outcome;
  } finally {
    await session.endSession();
  }
}

module.exports = { adjudicateClaim, findPolicyVersion, findCoverageRule };
