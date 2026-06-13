const mongoose = require('mongoose');

const DENIAL_CODES = [
  'NOT_COVERED',            // service type not in coverage rules
  'LIMIT_EXHAUSTED',        // annual limit used up
  'POLICY_INACTIVE',        // policy not active on date of service
  'NO_COVERAGE_VERSION',    // no PolicyVersion was active on date of service
  'REQUIRES_PRE_AUTH'       // pre-authorization required but not obtained
];

const TRIGGERING_EVENTS = [
  'INITIAL_SUBMISSION',
  'APPEAL',
  'RULE_CORRECTION',
  'ADMIN_OVERRIDE'
];

const claimDecisionSchema = new mongoose.Schema({
  claimId: { type: mongoose.Schema.Types.ObjectId, ref: 'Claim', required: true },
  claimItemId: { type: mongoose.Schema.Types.ObjectId, required: true },
  // Monotonically increasing within a claimItemId — version 1 is always the original decision
  versionNumber: { type: Number, required: true, default: 1 },
  // Which PolicyVersion's rules were applied — immutable audit link
  policyVersionId: { type: mongoose.Schema.Types.ObjectId, ref: 'PolicyVersion' },
  adjudicatedAt: { type: Date, default: Date.now },
  billedAmount: { type: Number, required: true },
  approvedAmount: { type: Number, default: 0 },
  coveredPercent: { type: Number },
  deductibleApplied: { type: Number, default: 0 },
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

module.exports = mongoose.model('ClaimDecision', claimDecisionSchema);
