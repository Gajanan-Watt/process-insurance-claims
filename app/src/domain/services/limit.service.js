const LimitLedger = require('../models/LimitLedger');

// All limit operations execute inside a MongoDB session/transaction passed by the caller.
// The $push to the same document serializes under write-write conflict detection,
// so two concurrent adjudications can't both read "enough capacity" and both approve.

function calendarYearPeriod(date) {
  const d = new Date(date);
  return {
    periodStart: new Date(d.getFullYear(), 0, 1),
    periodEnd: new Date(d.getFullYear(), 11, 31, 23, 59, 59, 999)
  };
}

async function getOrCreateLedger(policyId, memberId, benefitCategory, date, session) {
  const { periodStart, periodEnd } = calendarYearPeriod(date);

  let ledger = await LimitLedger.findOne(
    { policyId, benefitCategory, periodStart },
    null,
    { session }
  );

  if (!ledger) {
    [ledger] = await LimitLedger.create(
      [{ policyId, memberId, benefitCategory, periodStart, periodEnd, entries: [] }],
      { session }
    );
  }

  return ledger;
}

async function getAvailable(policyId, memberId, benefitCategory, date, annualLimit, session) {
  const { periodStart } = calendarYearPeriod(date);
  const ledger = await LimitLedger.findOne(
    { policyId, benefitCategory, periodStart },
    null,
    session ? { session } : {}
  );
  if (!ledger) return annualLimit;
  return ledger.computeAvailable(annualLimit);
}

// Atomically consume capacity for an approved claim item.
// Returns the actual amount consumed (may be less than requested if near limit).
async function consume(policyId, memberId, benefitCategory, date, claimId, claimItemId, amount, annualLimit, session) {
  const ledger = await getOrCreateLedger(policyId, memberId, benefitCategory, date, session);
  const available = ledger.computeAvailable(annualLimit);

  if (available <= 0) return 0;

  const consumeAmount = Math.min(amount, available);

  await LimitLedger.findByIdAndUpdate(
    ledger._id,
    { $push: { entries: { claimId, claimItemId, type: 'CONSUME', amount: consumeAmount } } },
    { session }
  );

  return consumeAmount;
}

// Release previously consumed capacity (reprocessing or reversal).
async function release(policyId, memberId, benefitCategory, date, claimId, claimItemId, amount, session) {
  const { periodStart } = calendarYearPeriod(date);
  const ledger = await LimitLedger.findOne({ policyId, benefitCategory, periodStart }, null, { session });
  if (!ledger) return;

  await LimitLedger.findByIdAndUpdate(
    ledger._id,
    { $push: { entries: { claimId, claimItemId, type: 'RELEASE', amount } } },
    { session }
  );
}

// Release all CONSUME entries for a claim (used during reprocessing).
async function releaseAllForClaim(policyId, memberId, date, claimId, itemConsumptions, session) {
  for (const { benefitCategory, claimItemId, amount } of itemConsumptions) {
    await release(policyId, memberId, benefitCategory, date, claimId, claimItemId, amount, session);
  }
}

module.exports = { getAvailable, consume, release, releaseAllForClaim, calendarYearPeriod };
