const express = require('express');
const router = express.Router();
const Claim = require('../../domain/models/Claim');
const ClaimDecision = require('../../domain/models/ClaimDecision');
const claimService = require('../../domain/services/claim.service');
const { validateClaimSubmission } = require('../middleware/validate');

// Submit a new claim
router.post('/', validateClaimSubmission, async (req, res, next) => {
  try {
    const claim = await claimService.submitClaim(req.body);
    res.status(201).json(claim);
  } catch (err) {
    next(err);
  }
});

// Get claim with its current (non-superseded) decisions
router.get('/:id', async (req, res, next) => {
  try {
    const claim = await Claim.findById(req.params.id);
    if (!claim) return res.status(404).json({ error: 'Claim not found' });

    const decisions = await ClaimDecision.find({
      claimId: claim._id,
      supersededBy: null
    }).populate('policyVersionId');

    res.json({ claim, decisions });
  } catch (err) {
    next(err);
  }
});

// Get full decision history (including superseded — audit trail)
router.get('/:id/decisions', async (req, res, next) => {
  try {
    const decisions = await ClaimDecision.find({ claimId: req.params.id })
      .sort({ adjudicatedAt: -1 })
      .populate('policyVersionId supersededBy');
    res.json(decisions);
  } catch (err) {
    next(err);
  }
});

// Trigger adjudication
router.post('/:id/review', async (req, res, next) => {
  try {
    const result = await claimService.reviewClaim(req.params.id);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Mark as paid
router.post('/:id/pay', async (req, res, next) => {
  try {
    const claim = await claimService.payClaim(req.params.id);
    res.json(claim);
  } catch (err) {
    next(err);
  }
});

// Member disputes a decision
router.post('/:id/dispute', async (req, res, next) => {
  try {
    const claim = await claimService.disputeClaim(req.params.id, req.body.reason);
    res.json(claim);
  } catch (err) {
    next(err);
  }
});

// Reprocess (appeal or admin correction)
router.post('/:id/reprocess', async (req, res, next) => {
  try {
    const event = req.body.triggeringEvent || 'APPEAL';
    const result = await claimService.reprocessClaim(req.params.id, event);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
