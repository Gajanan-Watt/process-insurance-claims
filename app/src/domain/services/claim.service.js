const mongoose = require('mongoose');
const Policy = require('../models/Policy');
const Claim = require('../models/Claim');
const ClaimDecision = require('../models/ClaimDecision');
const Dispute = require('../models/Dispute');
const LimitLedger = require('../models/LimitLedger');
const { adjudicateClaim } = require('./adjudication.service');
const limitService = require('./limit.service');
const deductibleService = require('./deductible.service');
const eventBus = require('../events/eventBus');
const EVENTS = require('../events/events');

// Valid state transitions — all other moves are rejected.
const TRANSITIONS = {
  SUBMITTED: ['UNDER_REVIEW'],
  UNDER_REVIEW: ['APPROVED', 'PARTIALLY_APPROVED', 'DENIED'],
  APPROVED: ['PAID', 'DISPUTED'],
  PARTIALLY_APPROVED: ['PAID', 'DISPUTED'],
  DENIED: ['DISPUTED'],
  PAID: [],
  DISPUTED: ['UNDER_REVIEW']
};

function assertTransition(from, to) {
  if (!TRANSITIONS[from]?.includes(to)) {
    throw Object.assign(new Error(`Invalid transition: ${from} → ${to}`), { statusCode: 422 });
  }
}

async function submitClaim(claimData) {
  // Validate that the policy exists, belongs to this member, and is active.
  const policy = await Policy.findById(claimData.policyId);
  if (!policy) {
    throw Object.assign(new Error('Policy not found'), { statusCode: 404 });
  }
  if (policy.memberId.toString() !== claimData.memberId.toString()) {
    throw Object.assign(new Error('Policy does not belong to this member'), { statusCode: 403 });
  }
  if (policy.status !== 'ACTIVE') {
    throw Object.assign(new Error(`Policy is ${policy.status} and cannot accept new claims`), { statusCode: 422 });
  }

  const claim = new Claim({ ...claimData, status: 'SUBMITTED' });
  await claim.save();
  eventBus.emit(EVENTS.CLAIM_SUBMITTED, {
    claimId: claim._id,
    memberId: claim.memberId,
    policyId: claim.policyId,
    dateOfService: claim.dateOfService,
    itemCount: claim.items.length
  });
  return claim;
}

// Move to UNDER_REVIEW and run adjudication.
async function reviewClaim(claimId, actorId) {
  const claim = await Claim.findById(claimId);
  if (!claim) throw Object.assign(new Error('Claim not found'), { statusCode: 404 });
  assertTransition(claim.status, 'UNDER_REVIEW');

  claim.status = 'UNDER_REVIEW';
  await claim.save();

  eventBus.emit(EVENTS.CLAIM_REVIEW_STARTED, { claimId: claim._id, actorId });

  return adjudicateClaim(claimId, 'INITIAL_SUBMISSION', actorId);
}

// Mark as PAID. No limit ledger changes — consumption happened at adjudication.
async function payClaim(claimId) {
  const claim = await Claim.findById(claimId);
  if (!claim) throw Object.assign(new Error('Claim not found'), { statusCode: 404 });
  assertTransition(claim.status, 'PAID');

  claim.status = 'PAID';
  await claim.save();

  eventBus.emit(EVENTS.CLAIM_PAID, { claimId: claim._id, memberId: claim.memberId });
  return claim;
}

// disputedItemIds: which line items are contested; empty means the entire claim is disputed.
async function disputeClaim(claimId, reason, disputedItemIds = []) {
  const claim = await Claim.findById(claimId);
  if (!claim) throw Object.assign(new Error('Claim not found'), { statusCode: 404 });
  assertTransition(claim.status, 'DISPUTED');

  const dispute = new Dispute({
    claimId: claim._id,
    memberId: claim.memberId,
    disputedItemIds,
    reason
  });
  await dispute.save();

  claim.status = 'DISPUTED';
  claim.activeDisputeId = dispute._id;
  await claim.save();

  eventBus.emit(EVENTS.DISPUTE_FILED, {
    disputeId: dispute._id,
    claimId: claim._id,
    memberId: claim.memberId,
    disputedItemIds,
    reason
  });

  const result = claim.toObject();
  result.disputeReason = reason;
  return result;
}

// Resolve an active dispute: UPHELD (decision stands), REVERSED (re-adjudicate), WITHDRAWN.
// REVERSED automatically triggers reprocessing; UPHELD and WITHDRAWN close the dispute in place.
async function resolveDispute(claimId, decision, resolution, actorId) {
  const claim = await Claim.findById(claimId).populate('activeDisputeId');
  if (!claim) throw Object.assign(new Error('Claim not found'), { statusCode: 404 });
  if (!claim.activeDisputeId) {
    throw Object.assign(new Error('No active dispute on this claim'), { statusCode: 422 });
  }

  const dispute = claim.activeDisputeId;
  dispute.status = decision;        // UPHELD | REVERSED | WITHDRAWN
  dispute.resolution = resolution;
  dispute.resolvedAt = new Date();
  dispute.resolvedBy = actorId;
  await dispute.save();             // pre-save hook enforces resolvedBy for UPHELD/REVERSED

  claim.activeDisputeId = null;
  await claim.save();

  eventBus.emit(EVENTS.DISPUTE_RESOLVED, {
    disputeId: dispute._id,
    claimId: claim._id,
    memberId: claim.memberId,
    decision,
    actorId
  });

  if (decision === 'REVERSED') {
    const reprocessResult = await reprocessClaim(claimId, 'APPEAL', actorId);
    return { dispute, claim: reprocessResult };
  }

  return { dispute, claim };
}

// Manually adjudicate a single NEEDS_REVIEW item.
// Validates the item is in NEEDS_REVIEW, records the decision, consumes limit if approved.
async function adjudicateItem(claimId, itemId, { decision, approvedAmount, denialCode, denialReason }, actorId) {
  if (!['APPROVED', 'DENIED'].includes(decision)) {
    throw Object.assign(new Error('decision must be APPROVED or DENIED'), { statusCode: 400 });
  }

  const session = await mongoose.startSession();
  let outcome;

  try {
    await session.withTransaction(async () => {
      const claim = await Claim.findById(claimId).session(session);
      if (!claim) throw Object.assign(new Error('Claim not found'), { statusCode: 404 });

      const item = claim.items.id(itemId);
      if (!item) throw Object.assign(new Error('Item not found'), { statusCode: 404 });
      if (item.status !== 'NEEDS_REVIEW') {
        throw Object.assign(new Error(`Item is not in NEEDS_REVIEW status (current: ${item.status})`), { statusCode: 422 });
      }

      let finalApprovedAmount = 0;
      let coverageRemainingAfter = null;
      let explanation;

      if (decision === 'APPROVED') {
        if (approvedAmount == null || approvedAmount <= 0) {
          throw Object.assign(new Error('approvedAmount is required for APPROVED decisions'), { statusCode: 400 });
        }

        // Load the active policy version to get annualLimit for this item's category.
        const { findPolicyVersion, findCoverageRule } = require('./adjudication.service');
        const policyVersion = await findPolicyVersion(claim.policyId, claim.dateOfService, session);
        const rule = policyVersion && findCoverageRule(policyVersion, item);
        const annualLimit = rule?.annualLimit ?? approvedAmount;

        const available = await limitService.getAvailable(
          claim.policyId, claim.memberId, item.benefitCategory,
          claim.dateOfService, annualLimit, session
        );
        const capped = Math.min(approvedAmount, available);

        finalApprovedAmount = await limitService.consume(
          claim.policyId, claim.memberId, item.benefitCategory,
          claim.dateOfService, claim._id, item._id,
          capped, annualLimit, session
        );
        coverageRemainingAfter = available - finalApprovedAmount;
        explanation = `Manually approved by adjuster. Approved: $${finalApprovedAmount.toFixed(2)} of $${item.billedAmount.toFixed(2)} billed.`;
      } else {
        explanation = denialReason
          ? `Denied after manual review: ${denialReason}`
          : `Denied after manual review by adjuster.`;
      }

      // Supersede the existing NEEDS_REVIEW decision with the final one.
      const existing = await ClaimDecision.findOne(
        { claimItemId: item._id, supersededBy: null },
        null,
        { session }
      );
      const newDecision = new ClaimDecision({
        claimId: claim._id,
        claimItemId: item._id,
        benefitCategory: item.benefitCategory,
        policyVersionId: existing?.policyVersionId ?? null,
        performedBy: actorId,
        decisionType: decision,
        billedAmount: item.billedAmount,
        approvedAmount: finalApprovedAmount,
        ruleApplied: existing?.ruleApplied ?? null,
        coverageRemainingAfter,
        denialCode: decision === 'DENIED' ? (denialCode ?? null) : null,
        denialReason: decision === 'DENIED' ? (denialReason ?? null) : null,
        explanation,
        triggeringEvent: 'ADMIN_OVERRIDE',
        versionNumber: existing ? existing.versionNumber + 1 : 1
      });
      await newDecision.save({ session });

      if (existing) {
        existing.supersededBy = newDecision._id;
        await existing.save({ session });
      }

      item.status = decision;

      // Re-evaluate claim status now that this item has a final decision.
      const allStatuses = claim.items.map(i => i.status);
      const hasNeedsReview = allStatuses.includes('NEEDS_REVIEW');
      const approvedCount = allStatuses.filter(s => ['APPROVED', 'PARTIALLY_APPROVED'].includes(s)).length;
      const total = claim.items.length;

      if (hasNeedsReview) {
        claim.status = 'UNDER_REVIEW';
      } else if (approvedCount === total) {
        claim.status = 'APPROVED';
      } else if (approvedCount > 0) {
        claim.status = 'PARTIALLY_APPROVED';
      } else {
        claim.status = 'DENIED';
      }

      await claim.save({ session });
      outcome = { decision: newDecision, claimStatus: claim.status };
    });
  } finally {
    await session.endSession();
  }

  return outcome;
}

// Reprocess: release prior consumed limits and deductibles, reset items, re-adjudicate.
// Only allowed before PAID — once paid, reversals require a separate financial flow.
async function reprocessClaim(claimId, triggeringEvent = 'APPEAL', actorId = 'system') {
  const claim = await Claim.findById(claimId);
  if (!claim) throw Object.assign(new Error('Claim not found'), { statusCode: 404 });

  if (claim.status === 'PAID') {
    throw Object.assign(
      new Error('Cannot reprocess a paid claim. File a financial adjustment instead.'),
      { statusCode: 422 }
    );
  }

  const reprocessableStatuses = ['APPROVED', 'PARTIALLY_APPROVED', 'DENIED', 'DISPUTED', 'UNDER_REVIEW'];
  if (!reprocessableStatuses.includes(claim.status)) {
    throw Object.assign(
      new Error(`Cannot reprocess a claim in status ${claim.status}.`),
      { statusCode: 422 }
    );
  }

  const priorStatus = claim.status;
  let releasedItems = [];

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      // Find all active (non-superseded) decisions that consumed limits or deductibles.
      const approvedDecisions = await ClaimDecision.find({
        claimId: claim._id,
        supersededBy: null,
        approvedAmount: { $gt: 0 }
      }).session(session);

      releasedItems = approvedDecisions.map(d => ({
        benefitCategory: claim.items.id(d.claimItemId)?.benefitCategory,
        claimItemId: d.claimItemId,
        amount: d.approvedAmount,
        deductibleApplied: d.deductibleApplied ?? 0
      })).filter(c => c.benefitCategory);

      await limitService.releaseAllForClaim(
        claim.policyId,
        claim.memberId,
        claim.dateOfService,
        claim._id,
        releasedItems,
        session
      );

      // Release deductible consumption as well so re-adjudication recomputes correctly.
      const deductibleItems = releasedItems.filter(i => i.deductibleApplied > 0).map(i => ({
        benefitCategory: i.benefitCategory,
        claimItemId: i.claimItemId,
        amount: i.deductibleApplied
      }));
      await deductibleService.releaseAllForClaim(
        claim.policyId,
        claim.memberId,
        claim.dateOfService,
        claim._id,
        deductibleItems,
        session
      );

      for (const item of claim.items) {
        item.status = 'PENDING';
      }
      claim.status = 'UNDER_REVIEW';
      await claim.save({ session });
    });
  } finally {
    await session.endSession();
  }

  for (const item of releasedItems) {
    eventBus.emit(EVENTS.BENEFIT_LIMIT_RELEASED, {
      policyId: claim.policyId,
      memberId: claim.memberId,
      benefitCategory: item.benefitCategory,
      claimItemId: item.claimItemId,
      amount: item.amount,
      claimId: claim._id
    });
  }

  const result = await adjudicateClaim(claimId, triggeringEvent, actorId);

  eventBus.emit(EVENTS.CLAIM_REPROCESSED, {
    claimId: claim._id,
    triggeringEvent,
    priorStatus,
    newStatus: result.claimStatus,
    actorId
  });

  return result;
}

module.exports = { submitClaim, reviewClaim, payClaim, disputeClaim, resolveDispute, adjudicateItem, reprocessClaim };
