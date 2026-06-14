# Insurance Claims Processing System

A REST API for adjudicating health insurance claims against coverage rules.

## Stack

- **Node.js + Express** — API server
- **MongoDB + Mongoose** — persistence (transactions for limit atomicity)
- **Zod** — request validation
- **Jest + mongodb-memory-server** — test suite (runs against an in-memory replica set)

## Setup

### Prerequisites

- Node.js 18+
- Docker (for the local MongoDB replica set) or a MongoDB 6+ replica set already running

### 1. Start a local MongoDB replica set

Transactions require a replica set. The quickest way is Docker:

```bash
docker run -d --name mongo-rs -p 27017:27017 mongo:7 mongod --replSet rs0 --bind_ip_all
sleep 3   # wait for mongod to be ready before initiating
docker exec mongo-rs mongosh --quiet --eval \
  "rs.initiate({_id:'rs0', members:[{_id:0, host:'localhost:27017'}]})"
```

You should see `{ ok: 1 }`. If you get a connection error, wait another second and retry the `rs.initiate` step.

### 2. Install dependencies and start the server

```bash
cd app
npm install
npm start
```

The `.env` file is included — no extra config needed. Server starts on `http://localhost:3000`.

### 3. Run the test suite

The tests use an in-memory MongoDB replica set — no running database needed:

```bash
cd app
npm test
```

All 38 tests should pass.

### 4. Generate a token for manual API testing

All endpoints require a `Bearer` JWT. Run this from the `app/` directory to mint an admin token and export it for use in the curl examples:

```bash
export TOKEN=$(node -e "
  const jwt = require('jsonwebtoken');
  require('dotenv').config();
  console.log(jwt.sign({ sub: 'local-admin', role: 'ADMIN' }, process.env.JWT_SECRET, { expiresIn: '1d' }));
")
```

`ADMIN` can call every endpoint in the walkthrough below. `TOKEN` is session-scoped — if you open a new terminal window, re-run this export.

---

## API Reference

### Members

| Method | Path | Description |
|---|---|---|
| `POST` | `/members` | Create a member |
| `GET` | `/members/:id` | Get a member |

### Policies

| Method | Path | Description |
|---|---|---|
| `POST` | `/policies` | Create a policy |
| `GET` | `/policies/:id` | Get policy + all versions |
| `POST` | `/policies/:id/versions` | Add a new coverage version |

### Claims

| Method | Path | Roles | Description |
|---|---|---|---|
| `GET` | `/claims` | any | List claims (MEMBERs see own; filter by `?memberId=&status=`) |
| `POST` | `/claims` | MEMBER, ADJUSTER, ADMIN | Submit a claim |
| `GET` | `/claims/:id` | any | Get claim + current decisions (PHI filtered by role) |
| `GET` | `/claims/:id/decisions` | ADJUSTER, ADMIN, AUDITOR | Full decision history (audit trail) |
| `POST` | `/claims/:id/review` | ADJUSTER, ADMIN | Trigger adjudication |
| `POST` | `/claims/:id/pay` | ADMIN | Mark as paid |
| `POST` | `/claims/:id/dispute` | MEMBER, ADMIN | Member disputes a decision |
| `POST` | `/claims/:id/dispute/resolve` | ADJUSTER, ADMIN | Resolve dispute (UPHELD / REVERSED / WITHDRAWN) |
| `POST` | `/claims/:id/items/:itemId/adjudicate` | ADJUSTER, ADMIN | Manually adjudicate a NEEDS_REVIEW item |
| `POST` | `/claims/:id/reprocess` | ADJUSTER, ADMIN | Re-adjudicate (appeal / rule correction) |

---

## Walkthrough

Each step uses `$TOKEN` exported above. Replace `<memberId>`, `<policyId>`, and `<claimId>` with the `_id` values returned in each response.

### 1. Create a member and policy

```bash
# Create member — note the _id in the response
curl -s -X POST http://localhost:3000/members \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"Jane Doe","dateOfBirth":"1985-03-15","memberId":"MBR-001"}' | jq .

# Create policy — note the _id in the response
curl -s -X POST http://localhost:3000/policies \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"memberId":"<memberId>","planType":"STANDARD","effectiveDate":"2024-01-01"}' | jq .

# Add coverage rules to the policy
curl -s -X POST http://localhost:3000/policies/<policyId>/versions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "effectiveFrom": "2024-01-01",
    "coverageRules": [
      {
        "benefitCategory": "MEDICAL",
        "serviceTypes": [],
        "coveredPercent": 80,
        "annualLimit": 10000,
        "annualDeductible": 500
      },
      {
        "benefitCategory": "DENTAL",
        "serviceTypes": [],
        "coveredPercent": 50,
        "annualLimit": 2000,
        "annualDeductible": 0
      }
    ]
  }' | jq .
```

### 2. Submit and adjudicate a claim

```bash
# Submit claim — note the _id in the response
curl -s -X POST http://localhost:3000/claims \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "memberId": "<memberId>",
    "policyId": "<policyId>",
    "dateOfService": "2024-06-15",
    "providerName": "City Medical Center",
    "diagnosisCodes": ["Z00.00"],
    "items": [
      {"serviceType":"OFFICE_VISIT","benefitCategory":"MEDICAL","billedAmount":1200,"description":"Annual checkup"},
      {"serviceType":"CLEANING","benefitCategory":"DENTAL","billedAmount":300,"description":"Dental cleaning"}
    ]
  }' | jq .

# Adjudicate — runs the rules engine against the claim
curl -s -X POST http://localhost:3000/claims/<claimId>/review \
  -H "Authorization: Bearer $TOKEN" | jq .

# Read the adjudicated claim and its decisions (with member-facing explanations)
curl -s http://localhost:3000/claims/<claimId> \
  -H "Authorization: Bearer $TOKEN" | jq .
```

### 3. Dispute and resolve

```bash
# File a dispute
curl -s -X POST http://localhost:3000/claims/<claimId>/dispute \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"reason":"Deductible was already met — request re-review"}' | jq .

# Resolve the dispute — REVERSED auto-reprocesses and creates superseding decisions
curl -s -X POST http://localhost:3000/claims/<claimId>/dispute/resolve \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"decision":"REVERSED","resolution":"Error in deductible application identified."}' | jq .

# See the full decision history including the superseded original
curl -s http://localhost:3000/claims/<claimId>/decisions \
  -H "Authorization: Bearer $TOKEN" | jq .
```

### 4. Mid-year rule change

```bash
# Add a new policy version — automatically closes the previous version
curl -s -X POST http://localhost:3000/policies/<policyId>/versions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "effectiveFrom": "2024-07-01",
    "changeReason": "Annual benefit renewal",
    "coverageRules": [
      {"benefitCategory":"MEDICAL","serviceTypes":[],"coveredPercent":90,"annualLimit":15000,"annualDeductible":250}
    ]
  }' | jq .

# Claims with dateOfService before July 1 still adjudicate under the old rules.
# Claims with dateOfService from July 1 onward use the new rules.
```
