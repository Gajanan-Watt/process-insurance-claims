const mongoose = require('mongoose');

const DISPUTE_STATUSES = ['FILED', 'UNDER_REVIEW', 'UPHELD', 'REVERSED', 'WITHDRAWN'];

const disputeSchema = new mongoose.Schema({
  claimId: { type: mongoose.Schema.Types.ObjectId, ref: 'Claim', required: true },
  memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'Member', required: true },
  // Empty array = entire claim disputed; populated = only these line items are contested
  disputedItemIds: [{ type: mongoose.Schema.Types.ObjectId }],
  reason: { type: String, required: true },
  status: { type: String, enum: DISPUTE_STATUSES, default: 'FILED' },
  // Populated when status moves to UPHELD or REVERSED
  resolution: { type: String },
  resolvedAt: { type: Date },
  resolvedBy: { type: String }
}, { timestamps: true });

disputeSchema.index({ claimId: 1, status: 1 });
disputeSchema.index({ memberId: 1, status: 1 });

// resolvedBy is mandatory whenever a dispute reaches a terminal resolution.
disputeSchema.pre('save', function (next) {
  if (['UPHELD', 'REVERSED'].includes(this.status) && !this.resolvedBy) {
    return next(new Error('resolvedBy is required when a dispute is upheld or reversed'));
  }
  next();
});

module.exports = mongoose.model('Dispute', disputeSchema);
