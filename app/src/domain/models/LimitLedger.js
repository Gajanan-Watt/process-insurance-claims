const mongoose = require('mongoose');

// Append-only ledger. Available limit = annualLimit - sum(CONSUME) + sum(RELEASE).
// CONSUME: capacity locked by an adjudicated-approved decision.
// RELEASE: reversal of a prior CONSUME (reprocessing or denial override).
const ENTRY_TYPES = ['CONSUME', 'RELEASE'];

const ledgerEntrySchema = new mongoose.Schema({
  claimId: { type: mongoose.Schema.Types.ObjectId, ref: 'Claim', required: true },
  claimItemId: { type: mongoose.Schema.Types.ObjectId, required: true },
  type: { type: String, enum: ENTRY_TYPES, required: true },
  amount: { type: Number, required: true, min: 0 },
  recordedAt: { type: Date, default: Date.now }
}, { _id: false });

const limitLedgerSchema = new mongoose.Schema({
  policyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Policy', required: true },
  memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'Member', required: true },
  benefitCategory: { type: String, required: true },
  periodStart: { type: Date, required: true },
  periodEnd: { type: Date, required: true },
  entries: [ledgerEntrySchema]
});

limitLedgerSchema.index({ policyId: 1, benefitCategory: 1, periodStart: 1 }, { unique: true });

limitLedgerSchema.methods.computeConsumed = function () {
  return this.entries.reduce((sum, e) => {
    return e.type === 'CONSUME' ? sum + e.amount : sum - e.amount;
  }, 0);
};

limitLedgerSchema.methods.computeAvailable = function (annualLimit) {
  return annualLimit - this.computeConsumed();
};

module.exports = mongoose.model('LimitLedger', limitLedgerSchema);
