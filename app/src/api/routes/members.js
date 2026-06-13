const express = require('express');
const router = express.Router();
const Member = require('../../domain/models/Member');

router.post('/', async (req, res, next) => {
  try {
    const member = await Member.create(req.body);
    res.status(201).json(member);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const member = await Member.findById(req.params.id).populate('policyId');
    if (!member) return res.status(404).json({ error: 'Member not found' });
    res.json(member);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
