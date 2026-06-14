const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../../src/app');
const { connectTestDB, clearCollections, seedMemberWithPolicy, authHeader } = require('../helpers');

beforeAll(connectTestDB);
afterEach(clearCollections);

// Default admin token — used when the specific role doesn't matter for the test.
const adminId = 'admin-actor-id';
const adminAuth = authHeader(adminId, 'ADMIN');

describe('GET /claims', () => {
  it('returns empty array when member has no claims', async () => {
    const { member } = await seedMemberWithPolicy();
    const res = await request(app)
      .get('/claims')
      .set('Authorization', authHeader(member._id, 'MEMBER'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('member sees only their own claims', async () => {
    const { member, policy } = await seedMemberWithPolicy();
    const { member: other, policy: otherPolicy } = await seedMemberWithPolicy();

    await request(app).post('/claims').set('Authorization', adminAuth)
      .send({ memberId: member._id.toString(), policyId: policy._id.toString(), dateOfService: '2024-06-01', providerName: 'City Clinic', items: [{ serviceType: 'OFFICE_VISIT', benefitCategory: 'MEDICAL', billedAmount: 200 }] });
    await request(app).post('/claims').set('Authorization', adminAuth)
      .send({ memberId: other._id.toString(), policyId: otherPolicy._id.toString(), dateOfService: '2024-06-01', providerName: 'City Clinic', items: [{ serviceType: 'OFFICE_VISIT', benefitCategory: 'MEDICAL', billedAmount: 300 }] });

    const res = await request(app)
      .get('/claims')
      .set('Authorization', authHeader(member._id, 'MEMBER'));
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].memberId).toBe(member._id.toString());
  });

  it('admin can filter by status', async () => {
    const { member, policy } = await seedMemberWithPolicy();
    const createRes = await request(app).post('/claims').set('Authorization', adminAuth)
      .send({ memberId: member._id.toString(), policyId: policy._id.toString(), dateOfService: '2024-06-01', providerName: 'City Clinic', items: [{ serviceType: 'OFFICE_VISIT', benefitCategory: 'MEDICAL', billedAmount: 200 }] });
    await request(app).post(`/claims/${createRes.body._id}/review`).set('Authorization', adminAuth);

    const submitted = await request(app).get('/claims?status=SUBMITTED').set('Authorization', adminAuth);
    const approved = await request(app).get('/claims?status=APPROVED').set('Authorization', adminAuth);
    expect(submitted.body).toHaveLength(0);
    expect(approved.body).toHaveLength(1);
  });
});

describe('POST /claims', () => {
  it('returns 400 for missing required fields', async () => {
    const res = await request(app)
      .post('/claims')
      .set('Authorization', adminAuth)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid request body');
  });

  it('returns 401 with no token', async () => {
    const res = await request(app).post('/claims').send({});
    expect(res.status).toBe(401);
  });

  it('creates a claim in SUBMITTED status', async () => {
    const { member, policy } = await seedMemberWithPolicy();
    const res = await request(app)
      .post('/claims')
      .set('Authorization', authHeader(member._id, 'MEMBER'))
      .send({
        memberId: member._id.toString(),
        policyId: policy._id.toString(),
        dateOfService: '2024-06-01',
        providerName: 'City Clinic',
        items: [
          { serviceType: 'OFFICE_VISIT', benefitCategory: 'MEDICAL', billedAmount: 500 }
        ]
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('SUBMITTED');
    expect(res.body.items).toHaveLength(1);
  });

  it('returns 400 when items array is empty', async () => {
    const { member, policy } = await seedMemberWithPolicy();
    const res = await request(app)
      .post('/claims')
      .set('Authorization', adminAuth)
      .send({
        memberId: member._id.toString(),
        policyId: policy._id.toString(),
        dateOfService: '2024-06-01',
        providerName: 'City Clinic',
        items: []
      });
    expect(res.status).toBe(400);
  });

  it('returns 403 when policy does not belong to the member', async () => {
    const { member, policy } = await seedMemberWithPolicy();
    const { member: otherMember } = await seedMemberWithPolicy();
    const res = await request(app)
      .post('/claims')
      .set('Authorization', authHeader(otherMember._id, 'MEMBER'))
      .send({
        memberId: otherMember._id.toString(),
        policyId: policy._id.toString(),  // belongs to `member`, not `otherMember`
        dateOfService: '2024-06-01',
        providerName: 'City Clinic',
        items: [{ serviceType: 'OFFICE_VISIT', benefitCategory: 'MEDICAL', billedAmount: 500 }]
      });
    expect(res.status).toBe(403);
  });
});

describe('POST /claims/:id/review', () => {
  it('adjudicates the claim and returns claimStatus', async () => {
    const { member, policy } = await seedMemberWithPolicy();
    const createRes = await request(app)
      .post('/claims')
      .set('Authorization', adminAuth)
      .send({
        memberId: member._id.toString(),
        policyId: policy._id.toString(),
        dateOfService: '2024-06-01',
        providerName: 'City Clinic',
        items: [{ serviceType: 'OFFICE_VISIT', benefitCategory: 'MEDICAL', billedAmount: 1000 }]
      });

    const reviewRes = await request(app)
      .post(`/claims/${createRes.body._id}/review`)
      .set('Authorization', adminAuth);
    expect(reviewRes.status).toBe(200);
    expect(reviewRes.body.claimStatus).toBe('APPROVED');
  });

  it('returns 422 when called on already-reviewed claim', async () => {
    const { member, policy } = await seedMemberWithPolicy();
    const createRes = await request(app)
      .post('/claims')
      .set('Authorization', adminAuth)
      .send({
        memberId: member._id.toString(),
        policyId: policy._id.toString(),
        dateOfService: '2024-06-01',
        providerName: 'City Clinic',
        items: [{ serviceType: 'OFFICE_VISIT', benefitCategory: 'MEDICAL', billedAmount: 300 }]
      });
    const id = createRes.body._id;
    await request(app).post(`/claims/${id}/review`).set('Authorization', adminAuth);

    const secondReview = await request(app)
      .post(`/claims/${id}/review`)
      .set('Authorization', adminAuth);
    expect(secondReview.status).toBe(422);
  });
});

describe('GET /claims/:id', () => {
  it('returns claim with current decisions', async () => {
    const { member, policy } = await seedMemberWithPolicy();
    const createRes = await request(app)
      .post('/claims')
      .set('Authorization', adminAuth)
      .send({
        memberId: member._id.toString(),
        policyId: policy._id.toString(),
        dateOfService: '2024-06-01',
        providerName: 'City Clinic',
        items: [{ serviceType: 'OFFICE_VISIT', benefitCategory: 'MEDICAL', billedAmount: 800 }]
      });
    const id = createRes.body._id;
    await request(app).post(`/claims/${id}/review`).set('Authorization', adminAuth);

    const getRes = await request(app)
      .get(`/claims/${id}`)
      .set('Authorization', adminAuth);
    expect(getRes.status).toBe(200);
    expect(getRes.body.claim).toBeDefined();
    expect(getRes.body.decisions).toHaveLength(1);
    expect(getRes.body.decisions[0].explanation).toBeDefined();
    expect(getRes.body.decisions[0].supersededBy).toBeNull();
  });

  it('returns 404 for unknown claim', async () => {
    const fakeId = new mongoose.Types.ObjectId();
    const res = await request(app)
      .get(`/claims/${fakeId}`)
      .set('Authorization', adminAuth);
    expect(res.status).toBe(404);
  });

  it('returns 403 when a MEMBER accesses another member\'s claim', async () => {
    const { member, policy } = await seedMemberWithPolicy();
    const { member: other } = await seedMemberWithPolicy();

    const createRes = await request(app)
      .post('/claims')
      .set('Authorization', adminAuth)
      .send({
        memberId: member._id.toString(),
        policyId: policy._id.toString(),
        dateOfService: '2024-06-01',
        providerName: 'City Clinic',
        items: [{ serviceType: 'OFFICE_VISIT', benefitCategory: 'MEDICAL', billedAmount: 300 }]
      });

    const getRes = await request(app)
      .get(`/claims/${createRes.body._id}`)
      .set('Authorization', authHeader(other._id, 'MEMBER'));
    expect(getRes.status).toBe(403);
  });
});

describe('POST /claims/:id/dispute → resolve', () => {
  it('UPHELD resolution closes the dispute without reprocessing', async () => {
    const { member, policy } = await seedMemberWithPolicy();
    const createRes = await request(app)
      .post('/claims')
      .set('Authorization', adminAuth)
      .send({
        memberId: member._id.toString(),
        policyId: policy._id.toString(),
        dateOfService: '2024-06-01',
        providerName: 'City Clinic',
        items: [{ serviceType: 'OFFICE_VISIT', benefitCategory: 'MEDICAL', billedAmount: 800 }]
      });
    const id = createRes.body._id;

    await request(app).post(`/claims/${id}/review`).set('Authorization', adminAuth);
    await request(app)
      .post(`/claims/${id}/dispute`)
      .set('Authorization', authHeader(member._id, 'MEMBER'))
      .send({ reason: 'I disagree with the denial' });

    const resolveRes = await request(app)
      .post(`/claims/${id}/dispute/resolve`)
      .set('Authorization', adminAuth)
      .send({ decision: 'UPHELD', resolution: 'Decision stands per plan documents.' });

    expect(resolveRes.status).toBe(200);
    expect(resolveRes.body.dispute.status).toBe('UPHELD');
    expect(resolveRes.body.dispute.resolvedBy).toBe(adminId);
  });

  it('REVERSED resolution reprocesses and creates superseding decisions', async () => {
    const { member, policy } = await seedMemberWithPolicy();
    const createRes = await request(app)
      .post('/claims')
      .set('Authorization', adminAuth)
      .send({
        memberId: member._id.toString(),
        policyId: policy._id.toString(),
        dateOfService: '2024-06-01',
        providerName: 'City Clinic',
        items: [{ serviceType: 'OFFICE_VISIT', benefitCategory: 'MEDICAL', billedAmount: 800 }]
      });
    const id = createRes.body._id;

    await request(app).post(`/claims/${id}/review`).set('Authorization', adminAuth);
    await request(app)
      .post(`/claims/${id}/dispute`)
      .set('Authorization', authHeader(member._id, 'MEMBER'))
      .send({ reason: 'Amount incorrect' });

    const resolveRes = await request(app)
      .post(`/claims/${id}/dispute/resolve`)
      .set('Authorization', adminAuth)
      .send({ decision: 'REVERSED', resolution: 'Error in billed amount identified.' });

    expect(resolveRes.status).toBe(200);
    expect(resolveRes.body.dispute.status).toBe('REVERSED');

    const historyRes = await request(app)
      .get(`/claims/${id}/decisions`)
      .set('Authorization', adminAuth);
    expect(historyRes.body).toHaveLength(2);
  });
});

describe('POST /claims/:id/dispute → /reprocess (legacy flow)', () => {
  it('dispute then reprocess creates superseding decisions', async () => {
    const { member, policy } = await seedMemberWithPolicy();
    const createRes = await request(app)
      .post('/claims')
      .set('Authorization', adminAuth)
      .send({
        memberId: member._id.toString(),
        policyId: policy._id.toString(),
        dateOfService: '2024-06-01',
        providerName: 'City Clinic',
        items: [{ serviceType: 'OFFICE_VISIT', benefitCategory: 'MEDICAL', billedAmount: 800 }]
      });
    const id = createRes.body._id;

    await request(app).post(`/claims/${id}/review`).set('Authorization', adminAuth);
    await request(app)
      .post(`/claims/${id}/dispute`)
      .set('Authorization', authHeader(member._id, 'MEMBER'))
      .send({ reason: 'Amount incorrect' });
    await request(app)
      .post(`/claims/${id}/reprocess`)
      .set('Authorization', adminAuth)
      .send({ triggeringEvent: 'APPEAL' });

    const historyRes = await request(app)
      .get(`/claims/${id}/decisions`)
      .set('Authorization', adminAuth);
    expect(historyRes.body).toHaveLength(2);

    const [latest, original] = historyRes.body;
    expect(latest.versionNumber).toBe(2);
    expect(latest.triggeringEvent).toBe('APPEAL');
    const supersededById = typeof original.supersededBy === 'object'
      ? original.supersededBy._id
      : original.supersededBy;
    expect(supersededById).toBe(latest._id);
  });
});

describe('POST /claims/:id/pay', () => {
  it('marks an approved claim as PAID', async () => {
    const { member, policy } = await seedMemberWithPolicy();
    const createRes = await request(app)
      .post('/claims')
      .set('Authorization', adminAuth)
      .send({
        memberId: member._id.toString(),
        policyId: policy._id.toString(),
        dateOfService: '2024-06-01',
        providerName: 'City Clinic',
        items: [{ serviceType: 'OFFICE_VISIT', benefitCategory: 'MEDICAL', billedAmount: 500 }]
      });
    const id = createRes.body._id;
    await request(app).post(`/claims/${id}/review`).set('Authorization', adminAuth);

    const payRes = await request(app)
      .post(`/claims/${id}/pay`)
      .set('Authorization', adminAuth);
    expect(payRes.status).toBe(200);
    expect(payRes.body.status).toBe('PAID');
  });

  it('returns 422 when trying to pay a SUBMITTED claim', async () => {
    const { member, policy } = await seedMemberWithPolicy();
    const createRes = await request(app)
      .post('/claims')
      .set('Authorization', adminAuth)
      .send({
        memberId: member._id.toString(),
        policyId: policy._id.toString(),
        dateOfService: '2024-06-01',
        providerName: 'City Clinic',
        items: [{ serviceType: 'OFFICE_VISIT', benefitCategory: 'MEDICAL', billedAmount: 200 }]
      });
    const payRes = await request(app)
      .post(`/claims/${createRes.body._id}/pay`)
      .set('Authorization', adminAuth);
    expect(payRes.status).toBe(422);
  });
});

describe('POST /claims/:id/items/:itemId/adjudicate', () => {
  it('manually approves a NEEDS_REVIEW item and updates claim status', async () => {
    const { member, policy } = await seedMemberWithPolicy({
      coverageRules: [
        { benefitCategory: 'MEDICAL', serviceTypes: [], coveredPercent: 80, annualLimit: 10000, annualDeductible: 0, requiresManualReview: true }
      ]
    });
    const createRes = await request(app)
      .post('/claims')
      .set('Authorization', adminAuth)
      .send({
        memberId: member._id.toString(),
        policyId: policy._id.toString(),
        dateOfService: '2024-06-01',
        providerName: 'City Clinic',
        items: [{ serviceType: 'SURGERY', benefitCategory: 'MEDICAL', billedAmount: 5000 }]
      });
    const id = createRes.body._id;
    await request(app).post(`/claims/${id}/review`).set('Authorization', adminAuth);

    const claim = await request(app).get(`/claims/${id}`).set('Authorization', adminAuth);
    const itemId = claim.body.claim.items[0]._id;

    const adjRes = await request(app)
      .post(`/claims/${id}/items/${itemId}/adjudicate`)
      .set('Authorization', adminAuth)
      .send({ decision: 'APPROVED', approvedAmount: 4000 });

    expect(adjRes.status).toBe(200);
    expect(adjRes.body.decision.decisionType).toBe('APPROVED');
    expect(adjRes.body.claimStatus).toBe('APPROVED');
  });
});
