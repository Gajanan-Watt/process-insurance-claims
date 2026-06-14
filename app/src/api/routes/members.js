const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const Member = require('../../domain/models/Member');
const { validateMemberCreation } = require('../middleware/validate');
const { requireAuth, requireRole } = require('../middleware/auth');

const phiReadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' }
});

// Only ADMIN may create members (typically done via an enrollment system).
router.post('/',
  requireAuth,
  requireRole('ADMIN'),
  validateMemberCreation,
  async (req, res, next) => {
    try {
      const member = await Member.create(req.body);
      res.status(201).json(member);
    } catch (err) {
      next(err);
    }
  }
);

router.get('/:id',
  requireAuth,
  phiReadLimiter,
  async (req, res, next) => {
    try {
      // MEMBER callers may only retrieve their own record.
      if (req.actor.role === 'MEMBER' && req.params.id !== req.actor.id) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const member = await Member.findById(req.params.id)
        // Select only status fields from policy — not coverage rule details.
        .populate('policyId', 'status planType effectiveDate terminationDate');
      if (!member) return res.status(404).json({ error: 'Member not found' });
      res.json(member);
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
