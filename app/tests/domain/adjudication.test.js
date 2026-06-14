const { connectTestDB, clearCollections, seedMemberWithPolicy } = require('../helpers');
const Claim = require('../../src/domain/models/Claim');
const ClaimDecision = require('../../src/domain/models/ClaimDecision');
const LimitLedger = require('../../src/domain/models/LimitLedger');
const DeductibleLedger = require('../../src/domain/models/DeductibleLedger');
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

describe('adjudication: covered service with deductible', () => {
  it('applies deductible to billed amount first, then coverage percent to remainder', async () => {
    const { member, policy } = await seedMemberWithPolicy();
    const claim = await makeClaim(member._id, policy._id, [
      { serviceType: 'OFFICE_VISIT', benefitCategory: 'MEDICAL', billedAmount: 1000 }
    ]);

    const result = await adjudicateClaim(claim._id);

    expect(result.claimStatus).toBe('APPROVED');
    const decision = result.decisions[0];
    // Standard formula: (1000 - 500 deductible) = 500 eligible, then 80% of 500 = 400
    expect(decision.approvedAmount).toBe(400);
    expect(decision.deductibleApplied).toBe(500);
    expect(decision.denialCode).toBeNull();
    expect(decision.explanation).toMatch(/80%/);
    expect(decision.explanation).toMatch(/\$500\.00.*deductible/i);

    const ledger = await LimitLedger.findOne({ policyId: policy._id, benefitCategory: 'MEDICAL' });
    expect(ledger.entries[0].type).toBe('CONSUME');
    expect(ledger.entries[0].amount).toBe(400);

    const deductibleLedger = await DeductibleLedger.findOne({ policyId: policy._id, benefitCategory: 'MEDICAL' });
    expect(deductibleLedger.entries[0].type).toBe('APPLY');
    expect(deductibleLedger.entries[0].amount).toBe(500);
  });

  it('deductible accumulates across claims — second claim skips already-met deductible', async () => {
    const { member, policy } = await seedMemberWithPolicy({
      coverageRules: [
        { benefitCategory: 'MEDICAL', serviceTypes: [], coveredPercent: 80, annualLimit: 10000, annualDeductible: 500 }
      ]
    });

    // First claim: billed $600. $500 goes to deductible, $100 eligible, 80% = $80 approved.
    const claim1 = await makeClaim(member._id, policy._id, [
      { serviceType: 'OFFICE_VISIT', benefitCategory: 'MEDICAL', billedAmount: 600 }
    ]);
    const result1 = await adjudicateClaim(claim1._id);
    expect(result1.decisions[0].deductibleApplied).toBe(500);
    expect(result1.decisions[0].approvedAmount).toBe(80);

    // Second claim: deductible already met — full 80% applied to billed amount.
    const claim2 = await makeClaim(member._id, policy._id, [
      { serviceType: 'OFFICE_VISIT', benefitCategory: 'MEDICAL', billedAmount: 400 }
    ]);
    const result2 = await adjudicateClaim(claim2._id);
    expect(result2.decisions[0].deductibleApplied).toBe(0);
    expect(result2.decisions[0].approvedAmount).toBe(320); // 80% of 400
  });
});

describe('adjudication: uncovered service', () => {
  it('denies a service type not in coverage rules', async () => {
    const { member, policy } = await seedMemberWithPolicy({
      coverageRules: [
        { benefitCategory: 'MEDICAL', serviceTypes: ['SURGERY'], coveredPercent: 90, annualLimit: 50000, annualDeductible: 0 }
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
    expect(visionDecision.denialCode).toBe('NOT_COVERED');
    expect(medicalDecision.approvedAmount).toBeGreaterThan(0);
  });
});

describe('adjudication: annual limit exhaustion', () => {
  it('denies items when annual limit is fully consumed', async () => {
    const { member, policy } = await seedMemberWithPolicy({
      coverageRules: [
        { benefitCategory: 'MEDICAL', serviceTypes: [], coveredPercent: 100, annualLimit: 500, annualDeductible: 0 }
      ]
    });

    const claim1 = await makeClaim(member._id, policy._id, [
      { serviceType: 'OFFICE_VISIT', benefitCategory: 'MEDICAL', billedAmount: 600 }
    ]);
    await adjudicateClaim(claim1._id);

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
        { benefitCategory: 'MEDICAL', serviceTypes: [], coveredPercent: 100, annualLimit: 700, annualDeductible: 0 }
      ]
    });

    const claim1 = await makeClaim(member._id, policy._id, [
      { serviceType: 'OFFICE_VISIT', benefitCategory: 'MEDICAL', billedAmount: 500 }
    ]);
    await adjudicateClaim(claim1._id);

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
    const claim = await makeClaim(member._id, policy._id, [
      { serviceType: 'OFFICE_VISIT', benefitCategory: 'MEDICAL', billedAmount: 300 }
    ], '2023-06-01');

    const result = await adjudicateClaim(claim._id);

    expect(result.claimStatus).toBe('DENIED');
    const updated = await Claim.findById(claim._id);
    expect(updated.items[0].status).toBe('DENIED');
  });

  it('uses a retroactive PolicyVersion when no exact date match exists', async () => {
    const { member, policy, policyVersion: v1 } = await seedMemberWithPolicy({
      coverageRules: [
        { benefitCategory: 'DENTAL', serviceTypes: [], coveredPercent: 50, annualLimit: 2000, annualDeductible: 0 }
      ]
    });
    // Mark v1 as retroactive — it should now cover claims before its effectiveFrom.
    await PolicyVersion.findByIdAndUpdate(v1._id, { isRetroactive: true });

    // Claim for service before the version's effectiveFrom.
    const claim = await makeClaim(member._id, policy._id, [
      { serviceType: 'CLEANING', benefitCategory: 'DENTAL', billedAmount: 200 }
    ], '2023-06-01');

    const result = await adjudicateClaim(claim._id);

    expect(result.claimStatus).toBe('APPROVED');
    expect(result.decisions[0].approvedAmount).toBe(100); // 50% of 200
  });
});

describe('adjudication: pre-auth required', () => {
  it('denies items that require pre-authorization', async () => {
    const { member, policy } = await seedMemberWithPolicy({
      coverageRules: [
        { benefitCategory: 'MEDICAL', serviceTypes: ['MRI'], coveredPercent: 80, annualLimit: 5000, annualDeductible: 0, requiresPreAuth: true }
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

describe('adjudication: NEEDS_REVIEW', () => {
  it('routes items with requiresManualReview to NEEDS_REVIEW and holds claim in UNDER_REVIEW', async () => {
    const { member, policy } = await seedMemberWithPolicy({
      coverageRules: [
        { benefitCategory: 'MEDICAL', serviceTypes: [], coveredPercent: 80, annualLimit: 10000, annualDeductible: 0, requiresManualReview: true }
      ]
    });
    const claim = await makeClaim(member._id, policy._id, [
      { serviceType: 'SURGERY', benefitCategory: 'MEDICAL', billedAmount: 5000 }
    ]);

    const result = await adjudicateClaim(claim._id);

    expect(result.claimStatus).toBe('UNDER_REVIEW');
    expect(result.decisions[0].decisionType).toBe('NEEDS_REVIEW');
    expect(result.decisions[0].approvedAmount).toBe(0);

    // No limit consumption for NEEDS_REVIEW items.
    const ledger = await LimitLedger.findOne({ policyId: policy._id, benefitCategory: 'MEDICAL' });
    expect(ledger).toBeNull();
  });
});

describe('adjudication: coverage rule change mid-year', () => {
  it('uses the PolicyVersion active on date of service, not the current version', async () => {
    const { member, policy, policyVersion: v1 } = await seedMemberWithPolicy({
      coverageRules: [
        { benefitCategory: 'DENTAL', serviceTypes: [], coveredPercent: 50, annualLimit: 2000, annualDeductible: 0 }
      ]
    });

    await PolicyVersion.findByIdAndUpdate(v1._id, { effectiveTo: new Date('2024-06-30') });
    await PolicyVersion.create({
      policyId: policy._id,
      versionNumber: 2,
      effectiveFrom: new Date('2024-07-01'),
      effectiveTo: null,
      coverageRules: [
        { benefitCategory: 'DENTAL', serviceTypes: [], coveredPercent: 0, annualLimit: 0, annualDeductible: 0 }
      ]
    });

    const claim = await makeClaim(member._id, policy._id, [
      { serviceType: 'CLEANING', benefitCategory: 'DENTAL', billedAmount: 200 }
    ], '2024-01-15');

    const result = await adjudicateClaim(claim._id);

    // Should use v1's 50% rule, not v2's 0%
    expect(result.claimStatus).toBe('APPROVED');
    expect(result.decisions[0].approvedAmount).toBe(100); // 50% of 200, no deductible
    expect(result.decisions[0].policyVersionId.toString()).toBe(v1._id.toString());
  });
});

describe('adjudication: reprocessing', () => {
  it('creates a new superseding decision and tracks limit re-consumption', async () => {
    const { member, policy } = await seedMemberWithPolicy({
      coverageRules: [
        { benefitCategory: 'MEDICAL', serviceTypes: [], coveredPercent: 80, annualLimit: 10000, annualDeductible: 0 }
      ]
    });
    const claim = await makeClaim(member._id, policy._id, [
      { serviceType: 'OFFICE_VISIT', benefitCategory: 'MEDICAL', billedAmount: 1000 }
    ]);

    await adjudicateClaim(claim._id);

    const firstDecision = await ClaimDecision.findOne({ claimId: claim._id });
    expect(firstDecision.approvedAmount).toBe(800);
    expect(firstDecision.versionNumber).toBe(1);

    // Direct re-adjudication (no release) — used to test supersession chain only.
    // The full reprocess flow (with release) is tested in claim-states.test.js.
    await adjudicateClaim(claim._id, 'APPEAL');

    const allDecisions = await ClaimDecision.find({ claimId: claim._id }).sort({ versionNumber: 1 });
    expect(allDecisions).toHaveLength(2);
    expect(allDecisions[0].supersededBy).toEqual(allDecisions[1]._id);
    expect(allDecisions[1].versionNumber).toBe(2);
    expect(allDecisions[1].triggeringEvent).toBe('APPEAL');
  });
});
