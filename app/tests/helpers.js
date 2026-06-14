const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const Member = require('../src/domain/models/Member');
const Policy = require('../src/domain/models/Policy');
const PolicyVersion = require('../src/domain/models/PolicyVersion');

// Set a deterministic test secret before any module that reads JWT_SECRET is loaded.
process.env.JWT_SECRET = 'test-secret-do-not-use-in-production';

async function connectTestDB() {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(process.env.MONGODB_URI);
  }
}

async function clearCollections() {
  const collections = mongoose.connection.collections;
  for (const key in collections) {
    await collections[key].deleteMany({});
  }
}

// Sign a JWT with the test secret. id should be the actor's string ID.
function makeToken(id, role, expiresIn = '1h') {
  return jwt.sign({ sub: String(id), role }, process.env.JWT_SECRET, { expiresIn });
}

// Returns a ready-to-use Authorization header value for supertest .set('Authorization', ...).
function authHeader(id, role) {
  return `Bearer ${makeToken(id, role)}`;
}

async function seedMemberWithPolicy(overrides = {}) {
  const member = await Member.create({
    name: 'Jane Doe',
    dateOfBirth: new Date('1985-03-15'),
    memberId: `MBR-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  });

  const policy = await Policy.create({
    memberId: member._id,
    planType: 'STANDARD',
    effectiveDate: new Date('2024-01-01'),
    status: 'ACTIVE'
  });

  await Member.findByIdAndUpdate(member._id, { policyId: policy._id });

  const policyVersion = await PolicyVersion.create({
    policyId: policy._id,
    versionNumber: 1,
    effectiveFrom: new Date('2024-01-01'),
    effectiveTo: null,
    coverageRules: overrides.coverageRules || [
      {
        benefitCategory: 'MEDICAL',
        serviceTypes: [],
        coveredPercent: 80,
        annualLimit: 10000,
        annualDeductible: 500,
        requiresPreAuth: false,
        requiresManualReview: false
      },
      {
        benefitCategory: 'DENTAL',
        serviceTypes: [],
        coveredPercent: 50,
        annualLimit: 2000,
        annualDeductible: 0,
        requiresPreAuth: false,
        requiresManualReview: false
      }
    ]
  });

  return { member, policy, policyVersion };
}

module.exports = { connectTestDB, clearCollections, seedMemberWithPolicy, makeToken, authHeader };
