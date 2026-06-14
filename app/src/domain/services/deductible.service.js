const DeductibleLedger = require('../models/DeductibleLedger');

// All operations execute inside a MongoDB session/transaction passed by the caller.
// Keyed by (policyId, memberId, benefitCategory, periodStart) — per-member, per-year.

function calendarYearPeriod(date) {
  const d = new Date(date);
  return {
    periodStart: new Date(d.getFullYear(), 0, 1),
    periodEnd: new Date(d.getFullYear(), 11, 31, 23, 59, 59, 999)
  };
}

async function getOrCreateLedger(policyId, memberId, benefitCategory, date, session) {
  const { periodStart, periodEnd } = calendarYearPeriod(date);

  let ledger = await DeductibleLedger.findOne(
    { policyId, memberId, benefitCategory, periodStart },
    null,
    { session }
  );

  if (!ledger) {
    [ledger] = await DeductibleLedger.create(
      [{ policyId, memberId, benefitCategory, periodStart, periodEnd, entries: [] }],
      { session }
    );
  }

  return ledger;
}

// Returns total deductible applied so far this calendar year for this member/category.
async function getApplied(policyId, memberId, benefitCategory, date, session) {
  const { periodStart } = calendarYearPeriod(date);
  const ledger = await DeductibleLedger.findOne(
    { policyId, memberId, benefitCategory, periodStart },
    null,
    session ? { session } : {}
  );
  if (!ledger) return 0;
  return ledger.computeApplied();
}

// Atomically records deductible consumption for a claim item.
// Returns the amount actually applied (capped at remaining annual deductible).
async function apply(policyId, memberId, benefitCategory, date, claimId, claimItemId, amount, annualDeductible, session) {
  const ledger = await getOrCreateLedger(policyId, memberId, benefitCategory, date, session);
  const alreadyApplied = ledger.computeApplied();
  const remaining = Math.max(0, annualDeductible - alreadyApplied);
  const applyAmount = Math.min(amount, remaining);

  if (applyAmount <= 0) return 0;

  await DeductibleLedger.findByIdAndUpdate(
    ledger._id,
    { $push: { entries: { claimId, claimItemId, type: 'APPLY', amount: applyAmount } } },
    { session }
  );

  return applyAmount;
}

// Releases deductible consumption for a single item (called during reprocessing).
async function release(policyId, memberId, benefitCategory, date, claimId, claimItemId, amount, session) {
  const { periodStart } = calendarYearPeriod(date);
  const ledger = await DeductibleLedger.findOne(
    { policyId, memberId, benefitCategory, periodStart },
    null,
    { session }
  );
  if (!ledger || amount <= 0) return;

  await DeductibleLedger.findByIdAndUpdate(
    ledger._id,
    { $push: { entries: { claimId, claimItemId, type: 'RELEASE', amount } } },
    { session }
  );
}

// Releases all deductible entries for a claim during reprocessing.
// itemDeductibles: [{ benefitCategory, claimItemId, amount }]
async function releaseAllForClaim(policyId, memberId, date, claimId, itemDeductibles, session) {
  for (const { benefitCategory, claimItemId, amount } of itemDeductibles) {
    await release(policyId, memberId, benefitCategory, date, claimId, claimItemId, amount, session);
  }
}

module.exports = { getApplied, apply, release, releaseAllForClaim, calendarYearPeriod };
