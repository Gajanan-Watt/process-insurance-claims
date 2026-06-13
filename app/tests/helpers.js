const mongoose = require('mongoose');
const Member = require('../src/domain/models/Member');
const Policy = require('../src/domain/models/Policy');
const PolicyVersion = require('../src/domain/models/PolicyVersion');

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
        deductible: 500,
        requiresPreAuth: false
      },
      {
        benefitCategory: 'DENTAL',
        serviceTypes: [],
        coveredPercent: 50,
        annualLimit: 2000,
        deductible: 0,
        requiresPreAuth: false
      }
    ]
  });

  return { member, policy, policyVersion };
}

module.exports = { connectTestDB, clearCollections, seedMemberWithPolicy };
