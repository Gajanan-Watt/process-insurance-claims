module.exports = {
  // Claim lifecycle
  CLAIM_SUBMITTED:      'ClaimSubmitted',
  CLAIM_REVIEW_STARTED: 'ClaimReviewStarted',
  CLAIM_ADJUDICATED:    'ClaimAdjudicated',
  CLAIM_PAID:           'ClaimPaid',
  CLAIM_REPROCESSED:    'ClaimReprocessed',

  // Per-item decisions
  ITEM_DECISION_MADE:   'ItemDecisionMade',
  DECISION_SUPERSEDED:  'DecisionSuperseded',

  // Benefit limits
  BENEFIT_LIMIT_CONSUMED:  'BenefitLimitConsumed',
  BENEFIT_LIMIT_RELEASED:  'BenefitLimitReleased',
  BENEFIT_LIMIT_EXHAUSTED: 'BenefitLimitExhausted',

  // Disputes
  DISPUTE_FILED:     'DisputeFiled',
  DISPUTE_RESOLVED:  'DisputeResolved',
};
