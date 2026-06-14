const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const Claim = require('../../domain/models/Claim');
const ClaimDecision = require('../../domain/models/ClaimDecision');
const claimService = require('../../domain/services/claim.service');
const { validateClaimSubmission } = require('../middleware/validate');
const { requireAuth, requireRole } = require('../middleware/auth');

// Stricter rate limit on read endpoints that return PHI.
const phiReadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' }
});

const SENSITIVE_CATEGORIES = new Set(['MENTAL_HEALTH']);
const CLINICAL_ROLES = new Set(['ADMIN', 'ADJUSTER']);

function projectClaim(claim, role) {
  const obj = claim.toObject ? claim.toObject() : { ...claim };
  if (!CLINICAL_ROLES.has(role)) {
    delete obj.diagnosisCodes;
  }
  return obj;
}

function projectDecision(decision, role) {
  const obj = decision.toObject ? decision.toObject() : { ...decision };
  if (!CLINICAL_ROLES.has(role) && SENSITIVE_CATEGORIES.has(obj.benefitCategory)) {
    obj.explanation = 'Details restricted. Contact your plan administrator for more information.';
    if (obj.denialReason) obj.denialReason = 'See your plan documents.';
  }
  return obj;
}

async function assertClaimOwnership(claim, actor) {
  if (actor.role !== 'MEMBER') return;
  if (!claim || claim.memberId.toString() !== actor.id) {
    throw Object.assign(new Error('Access denied'), { statusCode: 403 });
  }
}

// List claims — members see only their own; adjusters/admins can filter by memberId and/or status.
// Results are capped at 50 until cursor-based pagination is added.
router.get('/',
  requireAuth,
  phiReadLimiter,
  async (req, res, next) => {
    try {
      const filter = {};

      if (req.actor.role === 'MEMBER') {
        filter.memberId = req.actor.id;
      } else if (req.query.memberId) {
        filter.memberId = req.query.memberId;
      }

      if (req.query.status) filter.status = req.query.status;

      const claims = await Claim.find(filter)
        .sort({ createdAt: -1 })
        .limit(50);

      res.json(claims.map(c => projectClaim(c, req.actor.role)));
    } catch (err) {
      next(err);
    }
  }
);

// Submit a new claim
router.post('/',
  requireAuth,
  requireRole('MEMBER', 'ADJUSTER', 'ADMIN'),
  validateClaimSubmission,
  async (req, res, next) => {
    try {
      if (req.actor.role === 'MEMBER' && req.body.memberId !== req.actor.id) {
        return res.status(403).json({ error: 'Members can only submit claims for themselves' });
      }
      const claim = await claimService.submitClaim(req.body);
      res.status(201).json(claim);
    } catch (err) {
      next(err);
    }
  }
);

// Get claim with its current (non-superseded) decisions
router.get('/:id',
  requireAuth,
  phiReadLimiter,
  async (req, res, next) => {
    try {
      const claim = await Claim.findById(req.params.id);
      if (!claim) return res.status(404).json({ error: 'Claim not found' });

      await assertClaimOwnership(claim, req.actor);

      const decisions = await ClaimDecision.find({
        claimId: claim._id,
        supersededBy: null
      }).populate('policyVersionId');

      res.json({
        claim: projectClaim(claim, req.actor.role),
        decisions: decisions.map(d => projectDecision(d, req.actor.role))
      });
    } catch (err) {
      next(err);
    }
  }
);

// Get full decision history including superseded — audit trail only
router.get('/:id/decisions',
  requireAuth,
  requireRole('ADJUSTER', 'ADMIN', 'AUDITOR'),
  phiReadLimiter,
  async (req, res, next) => {
    try {
      const decisions = await ClaimDecision.find({ claimId: req.params.id })
        .sort({ adjudicatedAt: -1 })
        .populate('policyVersionId supersededBy');
      res.json(decisions.map(d => projectDecision(d, req.actor.role)));
    } catch (err) {
      next(err);
    }
  }
);

// Trigger adjudication
router.post('/:id/review',
  requireAuth,
  requireRole('ADJUSTER', 'ADMIN'),
  async (req, res, next) => {
    try {
      const result = await claimService.reviewClaim(req.params.id, req.actor.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

// Mark as paid
router.post('/:id/pay',
  requireAuth,
  requireRole('ADMIN'),
  async (req, res, next) => {
    try {
      const claim = await claimService.payClaim(req.params.id);
      res.json(claim);
    } catch (err) {
      next(err);
    }
  }
);

// Member files a dispute
router.post('/:id/dispute',
  requireAuth,
  requireRole('MEMBER', 'ADMIN'),
  async (req, res, next) => {
    try {
      const claim = await Claim.findById(req.params.id);
      if (!claim) return res.status(404).json({ error: 'Claim not found' });

      await assertClaimOwnership(claim, req.actor);

      const result = await claimService.disputeClaim(
        req.params.id,
        req.body.reason,
        req.body.disputedItemIds
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

// Adjuster resolves an active dispute (UPHELD | REVERSED | WITHDRAWN).
// REVERSED automatically triggers reprocessing.
router.post('/:id/dispute/resolve',
  requireAuth,
  requireRole('ADJUSTER', 'ADMIN'),
  async (req, res, next) => {
    try {
      const { decision, resolution } = req.body;
      if (!['UPHELD', 'REVERSED', 'WITHDRAWN'].includes(decision)) {
        return res.status(400).json({ error: 'decision must be UPHELD, REVERSED, or WITHDRAWN' });
      }
      if (!resolution) {
        return res.status(400).json({ error: 'resolution is required' });
      }
      const result = await claimService.resolveDispute(
        req.params.id, decision, resolution, req.actor.id
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

// Manually adjudicate a NEEDS_REVIEW item
router.post('/:id/items/:itemId/adjudicate',
  requireAuth,
  requireRole('ADJUSTER', 'ADMIN'),
  async (req, res, next) => {
    try {
      const { decision, approvedAmount, denialCode, denialReason } = req.body;
      const result = await claimService.adjudicateItem(
        req.params.id,
        req.params.itemId,
        { decision, approvedAmount, denialCode, denialReason },
        req.actor.id
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

// Reprocess (appeal or admin correction)
router.post('/:id/reprocess',
  requireAuth,
  requireRole('ADJUSTER', 'ADMIN'),
  async (req, res, next) => {
    try {
      const event = req.body.triggeringEvent || 'APPEAL';
      const result = await claimService.reprocessClaim(req.params.id, event, req.actor.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
