const mongoose = require('mongoose');

const CLAIM_STATUSES = [
  'SUBMITTED',
  'UNDER_REVIEW',
  'APPROVED',
  'PARTIALLY_APPROVED',
  'DENIED',
  'PAID',
  'DISPUTED'
];

const ITEM_STATUSES = ['PENDING', 'APPROVED', 'PARTIALLY_APPROVED', 'DENIED', 'NEEDS_REVIEW'];

const claimItemSchema = new mongoose.Schema({
  serviceType: { type: String, required: true },
  benefitCategory: {
    type: String,
    required: true,
    enum: ['MEDICAL', 'DENTAL', 'VISION', 'MENTAL_HEALTH', 'PRESCRIPTION']
  },
  billedAmount: { type: Number, required: true, min: 0 },
  description: { type: String, maxlength: 500 },
  status: { type: String, enum: ITEM_STATUSES, default: 'PENDING' }
}, { timestamps: true });

const claimSchema = new mongoose.Schema({
  memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'Member', required: true },
  policyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Policy', required: true },
  // Date the medical service was rendered — determines which PolicyVersion applies
  dateOfService: { type: Date, required: true },
  submittedAt: { type: Date, default: Date.now },
  providerId: { type: String },
  providerName: { type: String, required: true },
  diagnosisCodes: [String],
  status: { type: String, enum: CLAIM_STATUSES, default: 'SUBMITTED' },
  items: { type: [claimItemSchema], required: true, validate: v => v.length > 0 },
  // Points to the active Dispute document; null when no dispute is in flight
  activeDisputeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Dispute', default: null }
}, { timestamps: true });

claimSchema.index({ memberId: 1, status: 1 });
claimSchema.index({ policyId: 1, dateOfService: 1 });

module.exports = mongoose.model('Claim', claimSchema);
