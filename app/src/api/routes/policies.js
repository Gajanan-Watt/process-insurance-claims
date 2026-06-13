const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Policy = require('../../domain/models/Policy');
const PolicyVersion = require('../../domain/models/PolicyVersion');
const { validatePolicyVersion } = require('../middleware/validate');

router.post('/', async (req, res, next) => {
  try {
    const policy = await Policy.create(req.body);
    res.status(201).json(policy);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const policy = await Policy.findById(req.params.id);
    if (!policy) return res.status(404).json({ error: 'Policy not found' });
    const versions = await PolicyVersion.find({ policyId: policy._id }).sort({ effectiveFrom: -1 });
    res.json({ policy, versions });
  } catch (err) {
    next(err);
  }
});

// Add a new PolicyVersion (coverage rule change).
// Closes the current active version before creating the new one.
router.post('/:id/versions', validatePolicyVersion, async (req, res, next) => {
  const session = await mongoose.startSession();
  try {
    let newVersion;
    await session.withTransaction(async () => {
      const policy = await Policy.findById(req.params.id).session(session);
      if (!policy) throw Object.assign(new Error('Policy not found'), { statusCode: 404 });

      const effectiveFrom = new Date(req.body.effectiveFrom);

      // Close any currently-active version
      await PolicyVersion.findOneAndUpdate(
        { policyId: policy._id, effectiveTo: null },
        { effectiveTo: new Date(effectiveFrom.getTime() - 1) },
        { session }
      );

      const count = await PolicyVersion.countDocuments({ policyId: policy._id }).session(session);

      newVersion = await PolicyVersion.create(
        [{
          policyId: policy._id,
          versionNumber: count + 1,
          effectiveFrom,
          coverageRules: req.body.coverageRules,
          changeReason: req.body.changeReason,
          isRetroactive: req.body.isRetroactive ?? false
        }],
        { session }
      );
      newVersion = newVersion[0];
    });
    res.status(201).json(newVersion);
  } catch (err) {
    next(err);
  } finally {
    await session.endSession();
  }
});

module.exports = router;
