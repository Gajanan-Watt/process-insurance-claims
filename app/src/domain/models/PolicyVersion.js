const mongoose = require('mongoose');

const BENEFIT_CATEGORIES = ['MEDICAL', 'DENTAL', 'VISION', 'MENTAL_HEALTH', 'PRESCRIPTION'];

const coverageRuleSchema = new mongoose.Schema({
  benefitCategory: { type: String, required: true, enum: BENEFIT_CATEGORIES },
  // Empty array means rule applies to all service types in this category
  serviceTypes: [String],
  coveredPercent: { type: Number, required: true, min: 0, max: 100 },
  annualLimit: { type: Number, required: true, min: 0 },
  deductible: { type: Number, default: 0, min: 0 },
  requiresPreAuth: { type: Boolean, default: false }
}, { _id: false });

const policyVersionSchema = new mongoose.Schema({
  policyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Policy', required: true },
  versionNumber: { type: Number, required: true },
  effectiveFrom: { type: Date, required: true },
  // null = currently active version
  effectiveTo: { type: Date, default: null },
  coverageRules: { type: [coverageRuleSchema], required: true },
  changeReason: { type: String },
  // true = this version's rules apply retroactively to claims with dateOfService before effectiveFrom
  isRetroactive: { type: Boolean, default: false }
}, { timestamps: true });

policyVersionSchema.index({ policyId: 1, effectiveFrom: -1 });
// Enforce at most one active version (no effectiveTo) per policy
policyVersionSchema.index(
  { policyId: 1, effectiveTo: 1 },
  { unique: true, partialFilterExpression: { effectiveTo: null } }
);

module.exports = mongoose.model('PolicyVersion', policyVersionSchema);
