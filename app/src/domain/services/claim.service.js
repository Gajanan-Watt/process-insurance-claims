const mongoose = require('mongoose');
const Claim = require('../models/Claim');
const ClaimDecision = require('../models/ClaimDecision');
const LimitLedger = require('../models/LimitLedger');
const { adjudicateClaim } = require('./adjudication.service');
const limitService = require('./limit.service');

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
  const claim = new Claim({ ...claimData, status: 'SUBMITTED' });
  await claim.save();
  return claim;
}

// Move to UNDER_REVIEW and run adjudication.
async function reviewClaim(claimId) {
  const claim = await Claim.findById(claimId);
  if (!claim) throw Object.assign(new Error('Claim not found'), { statusCode: 404 });
  assertTransition(claim.status, 'UNDER_REVIEW');

  claim.status = 'UNDER_REVIEW';
  await claim.save();

  return adjudicateClaim(claimId, 'INITIAL_SUBMISSION');
}

// Mark as PAID. No limit ledger changes — consumption happened at adjudication.
async function payClaim(claimId) {
  const claim = await Claim.findById(claimId);
  if (!claim) throw Object.assign(new Error('Claim not found'), { statusCode: 404 });
  assertTransition(claim.status, 'PAID');

  claim.status = 'PAID';
  await claim.save();
  return claim;
}

async function disputeClaim(claimId, reason) {
  const claim = await Claim.findById(claimId);
  if (!claim) throw Object.assign(new Error('Claim not found'), { statusCode: 404 });
  assertTransition(claim.status, 'DISPUTED');

  claim.status = 'DISPUTED';
  claim.disputeReason = reason;
  await claim.save();
  return claim;
}

// Reprocess: release prior consumed limits, reset items, re-adjudicate.
// Only allowed before PAID — once paid, reversals require a separate financial flow.
async function reprocessClaim(claimId, triggeringEvent = 'APPEAL') {
  const claim = await Claim.findById(claimId);
  if (!claim) throw Object.assign(new Error('Claim not found'), { statusCode: 404 });

  const reprocessableStatuses = ['APPROVED', 'PARTIALLY_APPROVED', 'DENIED', 'DISPUTED'];
  if (claim.status === 'PAID') {
    throw Object.assign(
      new Error('Cannot reprocess a paid claim. File a financial adjustment instead.'),
      { statusCode: 422 }
    );
  }
  if (!reprocessableStatuses.includes(claim.status)) {
    throw Object.assign(
      new Error(`Cannot reprocess a claim in status ${claim.status}. Claim must be adjudicated first.`),
      { statusCode: 422 }
    );
  }

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      // Find all active (non-superseded) approved decisions for this claim
      const approvedDecisions = await ClaimDecision.find({
        claimId: claim._id,
        supersededBy: null,
        approvedAmount: { $gt: 0 }
      }).session(session);

      // Release limit consumption for each approved item
      const consumptions = approvedDecisions.map(d => ({
        benefitCategory: claim.items.id(d.claimItemId)?.benefitCategory,
        claimItemId: d.claimItemId,
        amount: d.approvedAmount
      })).filter(c => c.benefitCategory);

      await limitService.releaseAllForClaim(
        claim.policyId,
        claim.memberId,
        claim.dateOfService,
        claim._id,
        consumptions,
        session
      );

      // Reset all item statuses
      for (const item of claim.items) {
        item.status = 'PENDING';
      }
      claim.status = 'UNDER_REVIEW';
      await claim.save({ session });
    });
  } finally {
    await session.endSession();
  }

  return adjudicateClaim(claimId, triggeringEvent);
}

module.exports = { submitClaim, reviewClaim, payClaim, disputeClaim, reprocessClaim };
