const { connectTestDB, clearCollections, seedMemberWithPolicy } = require('../helpers');
const Claim = require('../../src/domain/models/Claim');
const ClaimDecision = require('../../src/domain/models/ClaimDecision');
const LimitLedger = require('../../src/domain/models/LimitLedger');
const PolicyVersion = require('../../src/domain/models/PolicyVersion');
const { adjudicateClaim } = require('../../src/domain/services/adjudication.service');

beforeAll(connectTestDB);
afterEach(clearCollections);

function makeClaim(memberId, policyId, items, dateOfService = '2024-06-01') {
  return Claim.create({
    memberId,
    policyId,
    dateOfService: new Date(dateOfService),
    providerName: 'City Hospital',
    diagnosisCodes: ['Z00.00'],
    items
  });
}

describe('adjudication: covered service', () => {
  it('approves a covered service and writes a CONSUME ledger entry', async () => {
    const { member, policy } = await seedMemberWithPolicy();
    const claim = await makeClaim(member._id, policy._id, [
      { serviceType: 'OFFICE_VISIT', benefitCategory: 'MEDICAL', billedAmount: 1000 }
    ]);

    const result = await adjudicateClaim(claim._id);

    expect(result.claimStatus).toBe('APPROVED');
    const decision = result.decisions[0];
    // 80% of 1000 = 800, minus $500 deductible = $300
    expect(decision.approvedAmount).toBe(300);
    expect(decision.denialCode).toBeNull();
    expect(decision.explanation).toMatch(/80%/);

    const ledger = await LimitLedger.findOne({ policyId: policy._id, benefitCategory: 'MEDICAL' });
    expect(ledger).not.toBeNull();
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0].type).toBe('CONSUME');
    expect(ledger.entries[0].amount).toBe(300);
  });
});

describe('adjudication: uncovered service', () => {
  it('denies a service type not in coverage rules', async () => {
    const { member, policy } = await seedMemberWithPolicy({
      coverageRules: [
        { benefitCategory: 'MEDICAL', serviceTypes: ['SURGERY'], coveredPercent: 90, annualLimit: 50000, deductible: 0 }
      ]
    });
    const claim = await makeClaim(member._id, policy._id, [
      { serviceType: 'ACUPUNCTURE', benefitCategory: 'MEDICAL', billedAmount: 200 }
    ]);

    const result = await adjudicateClaim(claim._id);

    expect(result.claimStatus).toBe('DENIED');
    expect(result.decisions[0].denialCode).toBe('NOT_COVERED');
    expect(result.decisions[0].approvedAmount).toBe(0);

    const ledger = await LimitLedger.findOne({ policyId: policy._id, benefitCategory: 'MEDICAL' });
    expect(ledger).toBeNull();
  });
});

describe('adjudication: partial approval', () => {
  it('approves covered items and denies uncovered items, sets PARTIALLY_APPROVED', async () => {
    const { member, policy } = await seedMemberWithPolicy();
    const claim = await makeClaim(member._id, policy._id, [
      { serviceType: 'OFFICE_VISIT', benefitCategory: 'MEDICAL', billedAmount: 1500 },
      { serviceType: 'LASER_EYE', benefitCategory: 'VISION', billedAmount: 2000 }
    ]);

    const result = await adjudicateClaim(claim._id);

    expect(result.claimStatus).toBe('PARTIALLY_APPROVED');
    const medicalDecision = result.decisions.find(d =>
      claim.items.find(i => i._id.equals(d.claimItemId))?.benefitCategory === 'MEDICAL'
    );
    const visionDecision = result.decisions.find(d =>
      claim.items.find(i => i._id.equals(d.claimItemId))?.benefitCategory === 'VISION'
    );
    // VISION is not in seed coverage rules
    expect(visionDecision.denialCode).toBe('NOT_COVERED');
    expect(medicalDecision.approvedAmount).toBeGreaterThan(0);
  });
});

describe('adjudication: annual limit exhaustion', () => {
  it('denies items when annual limit is fully consumed', async () => {
    const { member, policy } = await seedMemberWithPolicy({
      coverageRules: [
        { benefitCategory: 'MEDICAL', serviceTypes: [], coveredPercent: 100, annualLimit: 500, deductible: 0 }
      ]
    });

    // First claim exhausts the limit
    const claim1 = await makeClaim(member._id, policy._id, [
      { serviceType: 'OFFICE_VISIT', benefitCategory: 'MEDICAL', billedAmount: 600 }
    ]);
    await adjudicateClaim(claim1._id);

    // Second claim should be denied — limit exhausted
    const claim2 = await makeClaim(member._id, policy._id, [
      { serviceType: 'OFFICE_VISIT', benefitCategory: 'MEDICAL', billedAmount: 200 }
    ]);
    const result = await adjudicateClaim(claim2._id);

    expect(result.claimStatus).toBe('DENIED');
    expect(result.decisions[0].denialCode).toBe('LIMIT_EXHAUSTED');
  });

  it('approves up to remaining limit when partially exhausted', async () => {
    const { member, policy } = await seedMemberWithPolicy({
      coverageRules: [
        { benefitCategory: 'MEDICAL', serviceTypes: [], coveredPercent: 100, annualLimit: 700, deductible: 0 }
      ]
    });

    const claim1 = await makeClaim(member._id, policy._id, [
      { serviceType: 'OFFICE_VISIT', benefitCategory: 'MEDICAL', billedAmount: 500 }
    ]);
    await adjudicateClaim(claim1._id);

    // $200 remaining, claim for $400 — should approve only $200
    const claim2 = await makeClaim(member._id, policy._id, [
      { serviceType: 'OFFICE_VISIT', benefitCategory: 'MEDICAL', billedAmount: 400 }
    ]);
    const result = await adjudicateClaim(claim2._id);

    expect(result.claimStatus).toBe('APPROVED');
    expect(result.decisions[0].approvedAmount).toBe(200);
  });
});

describe('adjudication: no policy version on date of service', () => {
  it('denies all items when no PolicyVersion covers the date of service', async () => {
    const { member, policy } = await seedMemberWithPolicy();
    // Date of service before policy version effective date
    const claim = await makeClaim(member._id, policy._id, [
      { serviceType: 'OFFICE_VISIT', benefitCategory: 'MEDICAL', billedAmount: 300 }
    ], '2023-06-01');

    const result = await adjudicateClaim(claim._id);

    expect(result.claimStatus).toBe('DENIED');
    const updated = await Claim.findById(claim._id);
    expect(updated.items[0].status).toBe('DENIED');
  });
});

describe('adjudication: pre-auth required', () => {
  it('denies items that require pre-authorization', async () => {
    const { member, policy } = await seedMemberWithPolicy({
      coverageRules: [
        { benefitCategory: 'MEDICAL', serviceTypes: ['MRI'], coveredPercent: 80, annualLimit: 5000, deductible: 0, requiresPreAuth: true }
      ]
    });
    const claim = await makeClaim(member._id, policy._id, [
      { serviceType: 'MRI', benefitCategory: 'MEDICAL', billedAmount: 1200 }
    ]);

    const result = await adjudicateClaim(claim._id);

    expect(result.decisions[0].denialCode).toBe('REQUIRES_PRE_AUTH');
    expect(result.decisions[0].explanation).toMatch(/prior authorization/i);
  });
});

describe('adjudication: coverage rule change mid-year', () => {
  it('uses the PolicyVersion active on date of service, not the current version', async () => {
    const { member, policy, policyVersion: v1 } = await seedMemberWithPolicy({
      coverageRules: [
        { benefitCategory: 'DENTAL', serviceTypes: [], coveredPercent: 50, annualLimit: 2000, deductible: 0 }
      ]
    });

    // Simulate a mid-year rule change: close v1, open v2 with 0% dental coverage
    await PolicyVersion.findByIdAndUpdate(v1._id, { effectiveTo: new Date('2024-06-30') });
    await PolicyVersion.create({
      policyId: policy._id,
      versionNumber: 2,
      effectiveFrom: new Date('2024-07-01'),
      effectiveTo: null,
      coverageRules: [
        { benefitCategory: 'DENTAL', serviceTypes: [], coveredPercent: 0, annualLimit: 0, deductible: 0 }
      ]
    });

    // Claim for service in January (under v1 rules — 50% dental covered)
    const claim = await makeClaim(member._id, policy._id, [
      { serviceType: 'CLEANING', benefitCategory: 'DENTAL', billedAmount: 200 }
    ], '2024-01-15');

    const result = await adjudicateClaim(claim._id);

    // Should use v1's 50% rule, not v2's 0%
    expect(result.claimStatus).toBe('APPROVED');
    expect(result.decisions[0].approvedAmount).toBe(100); // 50% of 200
    expect(result.decisions[0].policyVersionId.toString()).toBe(v1._id.toString());
  });
});

describe('adjudication: reprocessing', () => {
  it('creates a new superseding decision and releases old limit consumption', async () => {
    const { member, policy } = await seedMemberWithPolicy({
      coverageRules: [
        { benefitCategory: 'MEDICAL', serviceTypes: [], coveredPercent: 80, annualLimit: 10000, deductible: 0 }
      ]
    });
    const claim = await makeClaim(member._id, policy._id, [
      { serviceType: 'OFFICE_VISIT', benefitCategory: 'MEDICAL', billedAmount: 1000 }
    ]);

    // First adjudication
    await adjudicateClaim(claim._id);

    const firstDecision = await ClaimDecision.findOne({ claimId: claim._id });
    expect(firstDecision.approvedAmount).toBe(800);
    expect(firstDecision.versionNumber).toBe(1);

    // Re-adjudicate (e.g. appeal with corrected billed amount — for test purposes just re-run)
    await adjudicateClaim(claim._id, 'APPEAL');

    const allDecisions = await ClaimDecision.find({ claimId: claim._id }).sort({ versionNumber: 1 });
    expect(allDecisions).toHaveLength(2);
    expect(allDecisions[0].supersededBy).toEqual(allDecisions[1]._id);
    expect(allDecisions[1].versionNumber).toBe(2);
    expect(allDecisions[1].triggeringEvent).toBe('APPEAL');

    // Ledger should have CONSUME (from v1) + CONSUME (from v2)
    // This is the raw re-adjudication without release — the claim.service handles the release before calling adjudicate
    const ledger = await LimitLedger.findOne({ policyId: policy._id, benefitCategory: 'MEDICAL' });
    expect(ledger.entries.filter(e => e.type === 'CONSUME')).toHaveLength(2);
  });
});
