const { connectTestDB, clearCollections, seedMemberWithPolicy } = require('../helpers');
const Claim = require('../../src/domain/models/Claim');
const claimService = require('../../src/domain/services/claim.service');
const ClaimDecision = require('../../src/domain/models/ClaimDecision');
const LimitLedger = require('../../src/domain/models/LimitLedger');

beforeAll(connectTestDB);
afterEach(clearCollections);

async function makeClaim(memberId, policyId) {
  return claimService.submitClaim({
    memberId,
    policyId,
    dateOfService: new Date('2024-06-01'),
    providerName: 'Test Clinic',
    items: [{ serviceType: 'OFFICE_VISIT', benefitCategory: 'MEDICAL', billedAmount: 800 }]
  });
}

describe('claim state machine', () => {
  it('starts in SUBMITTED status', async () => {
    const { member, policy } = await seedMemberWithPolicy();
    const claim = await makeClaim(member._id, policy._id);
    expect(claim.status).toBe('SUBMITTED');
  });

  it('rejects invalid transitions', async () => {
    const { member, policy } = await seedMemberWithPolicy();
    const claim = await makeClaim(member._id, policy._id);

    await expect(claimService.payClaim(claim._id)).rejects.toThrow(/Invalid transition/);
    await expect(claimService.reprocessClaim(claim._id)).rejects.toThrow(/Cannot reprocess/);
  });

  it('follows SUBMITTED → UNDER_REVIEW → APPROVED → PAID', async () => {
    const { member, policy } = await seedMemberWithPolicy();
    const claim = await makeClaim(member._id, policy._id);

    const reviewed = await claimService.reviewClaim(claim._id);
    expect(reviewed.claimStatus).toBe('APPROVED');

    const updatedClaim = await Claim.findById(claim._id);
    expect(updatedClaim.status).toBe('APPROVED');

    const paid = await claimService.payClaim(claim._id);
    expect(paid.status).toBe('PAID');
  });

  it('rejects reprocessing a PAID claim', async () => {
    const { member, policy } = await seedMemberWithPolicy();
    const claim = await makeClaim(member._id, policy._id);

    await claimService.reviewClaim(claim._id);
    await claimService.payClaim(claim._id);

    await expect(claimService.reprocessClaim(claim._id)).rejects.toThrow(/paid claim/i);
  });

  it('follows APPROVED → DISPUTED → UNDER_REVIEW (reprocess)', async () => {
    const { member, policy } = await seedMemberWithPolicy();
    const claim = await makeClaim(member._id, policy._id);

    await claimService.reviewClaim(claim._id);

    const disputed = await claimService.disputeClaim(claim._id, 'Incorrect amount applied');
    expect(disputed.status).toBe('DISPUTED');
    expect(disputed.disputeReason).toBe('Incorrect amount applied');

    // Reprocess after dispute
    const reprocessed = await claimService.reprocessClaim(claim._id, 'APPEAL');
    expect(reprocessed.claimStatus).toBe('APPROVED');
  });
});

describe('reprocessing releases and re-consumes limits correctly', () => {
  it('releases old limit consumption before re-adjudicating', async () => {
    const { member, policy } = await seedMemberWithPolicy({
      coverageRules: [
        { benefitCategory: 'MEDICAL', serviceTypes: [], coveredPercent: 100, annualLimit: 1000, annualDeductible: 0 }
      ]
    });

    const claim = await makeClaim(member._id, policy._id);
    await claimService.reviewClaim(claim._id); // consumes $800

    // Dispute and reprocess
    await claimService.disputeClaim(claim._id, 'test');
    await claimService.reprocessClaim(claim._id, 'APPEAL');

    // Ledger: one CONSUME (first adjudication) + one RELEASE (before reprocess) + one CONSUME (re-adjudication)
    const ledger = await LimitLedger.findOne({ policyId: policy._id, benefitCategory: 'MEDICAL' });
    const consumes = ledger.entries.filter(e => e.type === 'CONSUME');
    const releases = ledger.entries.filter(e => e.type === 'RELEASE');

    expect(consumes).toHaveLength(2);
    expect(releases).toHaveLength(1);
    // Net consumed = first consume + second consume - release = 800 + 800 - 800 = 800
    expect(ledger.computeConsumed()).toBe(800);
  });
});
