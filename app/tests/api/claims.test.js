const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../../src/app');
const { connectTestDB, clearCollections, seedMemberWithPolicy } = require('../helpers');

beforeAll(connectTestDB);
afterEach(clearCollections);

describe('POST /claims', () => {
  it('returns 400 for missing required fields', async () => {
    const res = await request(app).post('/claims').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid request body');
  });

  it('creates a claim in SUBMITTED status', async () => {
    const { member, policy } = await seedMemberWithPolicy();
    const res = await request(app).post('/claims').send({
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
    const res = await request(app).post('/claims').send({
      memberId: member._id.toString(),
      policyId: policy._id.toString(),
      dateOfService: '2024-06-01',
      items: []
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /claims/:id/review', () => {
  it('adjudicates the claim and returns claimStatus', async () => {
    const { member, policy } = await seedMemberWithPolicy();
    const createRes = await request(app).post('/claims').send({
      memberId: member._id.toString(),
      policyId: policy._id.toString(),
      dateOfService: '2024-06-01',
      items: [{ serviceType: 'OFFICE_VISIT', benefitCategory: 'MEDICAL', billedAmount: 1000 }]
    });

    const reviewRes = await request(app).post(`/claims/${createRes.body._id}/review`);
    expect(reviewRes.status).toBe(200);
    expect(reviewRes.body.claimStatus).toBe('APPROVED');
  });

  it('returns 422 when called on already-reviewed claim', async () => {
    const { member, policy } = await seedMemberWithPolicy();
    const createRes = await request(app).post('/claims').send({
      memberId: member._id.toString(),
      policyId: policy._id.toString(),
      dateOfService: '2024-06-01',
      items: [{ serviceType: 'OFFICE_VISIT', benefitCategory: 'MEDICAL', billedAmount: 300 }]
    });
    const id = createRes.body._id;
    await request(app).post(`/claims/${id}/review`);

    const secondReview = await request(app).post(`/claims/${id}/review`);
    expect(secondReview.status).toBe(422);
  });
});

describe('GET /claims/:id', () => {
  it('returns claim with current decisions', async () => {
    const { member, policy } = await seedMemberWithPolicy();
    const createRes = await request(app).post('/claims').send({
      memberId: member._id.toString(),
      policyId: policy._id.toString(),
      dateOfService: '2024-06-01',
      items: [{ serviceType: 'OFFICE_VISIT', benefitCategory: 'MEDICAL', billedAmount: 800 }]
    });
    const id = createRes.body._id;
    await request(app).post(`/claims/${id}/review`);

    const getRes = await request(app).get(`/claims/${id}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.claim).toBeDefined();
    expect(getRes.body.decisions).toHaveLength(1);
    expect(getRes.body.decisions[0].explanation).toBeDefined();
    expect(getRes.body.decisions[0].supersededBy).toBeNull();
  });

  it('returns 404 for unknown claim', async () => {
    const fakeId = new mongoose.Types.ObjectId();
    const res = await request(app).get(`/claims/${fakeId}`);
    expect(res.status).toBe(404);
  });
});

describe('POST /claims/:id/dispute → /reprocess', () => {
  it('dispute then reprocess creates superseding decisions', async () => {
    const { member, policy } = await seedMemberWithPolicy();
    const createRes = await request(app).post('/claims').send({
      memberId: member._id.toString(),
      policyId: policy._id.toString(),
      dateOfService: '2024-06-01',
      items: [{ serviceType: 'OFFICE_VISIT', benefitCategory: 'MEDICAL', billedAmount: 800 }]
    });
    const id = createRes.body._id;

    await request(app).post(`/claims/${id}/review`);
    await request(app).post(`/claims/${id}/dispute`).send({ reason: 'Amount incorrect' });
    await request(app).post(`/claims/${id}/reprocess`).send({ triggeringEvent: 'APPEAL' });

    const historyRes = await request(app).get(`/claims/${id}/decisions`);
    expect(historyRes.body).toHaveLength(2);

    const [latest, original] = historyRes.body;
    expect(latest.versionNumber).toBe(2);
    expect(latest.triggeringEvent).toBe('APPEAL');
    // supersededBy is populated as an object by the GET decisions route
    const supersededById = typeof original.supersededBy === 'object'
      ? original.supersededBy._id
      : original.supersededBy;
    expect(supersededById).toBe(latest._id);
  });
});

describe('POST /claims/:id/pay', () => {
  it('marks an approved claim as PAID', async () => {
    const { member, policy } = await seedMemberWithPolicy();
    const createRes = await request(app).post('/claims').send({
      memberId: member._id.toString(),
      policyId: policy._id.toString(),
      dateOfService: '2024-06-01',
      items: [{ serviceType: 'OFFICE_VISIT', benefitCategory: 'MEDICAL', billedAmount: 500 }]
    });
    const id = createRes.body._id;
    await request(app).post(`/claims/${id}/review`);

    const payRes = await request(app).post(`/claims/${id}/pay`);
    expect(payRes.status).toBe(200);
    expect(payRes.body.status).toBe('PAID');
  });

  it('returns 422 when trying to pay a SUBMITTED claim', async () => {
    const { member, policy } = await seedMemberWithPolicy();
    const createRes = await request(app).post('/claims').send({
      memberId: member._id.toString(),
      policyId: policy._id.toString(),
      dateOfService: '2024-06-01',
      items: [{ serviceType: 'OFFICE_VISIT', benefitCategory: 'MEDICAL', billedAmount: 200 }]
    });
    const payRes = await request(app).post(`/claims/${createRes.body._id}/pay`);
    expect(payRes.status).toBe(422);
  });
});
