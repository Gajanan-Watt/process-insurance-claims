const mongoose = require('mongoose');

const DENIAL_CODES = [
  'NOT_COVERED',
  'LIMIT_EXHAUSTED',
  'POLICY_INACTIVE',
  'NO_COVERAGE_VERSION',
  'REQUIRES_PRE_AUTH'
];

const DECISION_TYPES = ['APPROVED', 'PARTIALLY_APPROVED', 'DENIED', 'NEEDS_REVIEW'];

const TRIGGERING_EVENTS = [
  'INITIAL_SUBMISSION',
  'APPEAL',
  'RULE_CORRECTION',
  'ADMIN_OVERRIDE'
];

const BENEFIT_CATEGORIES = ['MEDICAL', 'DENTAL', 'VISION', 'MENTAL_HEALTH', 'PRESCRIPTION'];

// Snapshot of the coverage rule applied at adjudication time — stored so the explanation
// remains auditable even if the PolicyVersion is later amended.
const ruleSnapshotSchema = new mongoose.Schema({
  benefitCategory: { type: String, required: true },
  serviceTypes: [String],
  coveredPercent: { type: Number, required: true },
  annualLimit: { type: Number, required: true },
  annualDeductible: { type: Number, default: 0 },
  requiresPreAuth: { type: Boolean, default: false },
  requiresManualReview: { type: Boolean, default: false }
}, { _id: false });

const claimDecisionSchema = new mongoose.Schema({
  claimId: { type: mongoose.Schema.Types.ObjectId, ref: 'Claim', required: true },
  claimItemId: { type: mongoose.Schema.Types.ObjectId, required: true },
  // Denormalized from the claim item for efficient filtering without a join.
  benefitCategory: { type: String, enum: BENEFIT_CATEGORIES, required: true },
  // Monotonically increasing within a claimItemId — version 1 is always the original decision
  versionNumber: { type: Number, required: true, default: 1 },
  // Which PolicyVersion's rules were applied — immutable audit link
  policyVersionId: { type: mongoose.Schema.Types.ObjectId, ref: 'PolicyVersion' },
  adjudicatedAt: { type: Date, default: Date.now },
  // Who triggered this adjudication (actorId from JWT, or 'system' for automated runs)
  performedBy: { type: String, required: true },
  // Explicit outcome — not inferred from denialCode/approvedAmount so it's queryable directly
  decisionType: { type: String, enum: DECISION_TYPES, required: true },
  billedAmount: { type: Number, required: true },
  approvedAmount: { type: Number, default: 0 },
  coveredPercent: { type: Number },
  // Actual deductible consumed from this item (may be less than annualDeductible if nearly met)
  deductibleApplied: { type: Number, default: 0 },
  // Snapshot of the matched rule — null when denial occurs before rule matching
  ruleApplied: { type: ruleSnapshotSchema, default: null },
  // Annual limit balance for this benefit category after this decision
  coverageRemainingAfter: { type: Number, default: null },
  denialCode: { type: String, enum: DENIAL_CODES, default: null },
  denialReason: { type: String },
  // Human-readable explanation sent to the member
  explanation: { type: String, required: true },
  // Set when this decision is superseded by a reprocess or appeal
  supersededBy: { type: mongoose.Schema.Types.ObjectId, ref: 'ClaimDecision', default: null },
  triggeringEvent: { type: String, enum: TRIGGERING_EVENTS, default: 'INITIAL_SUBMISSION' }
}, { timestamps: true });

claimDecisionSchema.index({ claimId: 1, claimItemId: 1 });
claimDecisionSchema.index({ claimId: 1, supersededBy: 1 });

// Immutability guard — only supersededBy (and Mongoose internals) may be written after creation.
// This protects the audit trail from silent post-hoc edits.
claimDecisionSchema.pre('save', function (next) {
  if (this.isNew) return next();
  // updatedAt is set automatically by Mongoose timestamps; __v is the internal version key.
  const ALLOWED = new Set(['supersededBy', 'updatedAt', '__v']);
  const illegal = this.modifiedPaths().filter(p => !ALLOWED.has(p));
  if (illegal.length > 0) {
    return next(
      new Error(`ClaimDecision is immutable after creation. Cannot modify: ${illegal.join(', ')}`)
    );
  }
  next();
});

module.exports = mongoose.model('ClaimDecision', claimDecisionSchema);
