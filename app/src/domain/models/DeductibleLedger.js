const mongoose = require('mongoose');

// Append-only ledger tracking annual deductible consumption per (policy, member, benefitCategory, year).
// APPLY: deductible amount consumed by an approved claim item.
// RELEASE: reversal of a prior APPLY during reprocessing.
// Remaining deductible = annualDeductible - computeApplied()
const ENTRY_TYPES = ['APPLY', 'RELEASE'];

const ledgerEntrySchema = new mongoose.Schema({
  claimId: { type: mongoose.Schema.Types.ObjectId, ref: 'Claim', required: true },
  claimItemId: { type: mongoose.Schema.Types.ObjectId, required: true },
  type: { type: String, enum: ENTRY_TYPES, required: true },
  amount: { type: Number, required: true, min: 0 },
  recordedAt: { type: Date, default: Date.now }
});

const deductibleLedgerSchema = new mongoose.Schema({
  policyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Policy', required: true },
  memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'Member', required: true },
  benefitCategory: { type: String, required: true },
  periodStart: { type: Date, required: true },
  periodEnd: { type: Date, required: true },
  entries: [ledgerEntrySchema]
});

deductibleLedgerSchema.index(
  { policyId: 1, memberId: 1, benefitCategory: 1, periodStart: 1 },
  { unique: true }
);

deductibleLedgerSchema.methods.computeApplied = function () {
  return this.entries.reduce((sum, e) => {
    return e.type === 'APPLY' ? sum + e.amount : sum - e.amount;
  }, 0);
};

module.exports = mongoose.model('DeductibleLedger', deductibleLedgerSchema);
