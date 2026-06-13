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
- MongoDB 6+ running locally (replica set required for transactions)

### Start a local MongoDB replica set

If you don't already have one:
```bash
mongod --replSet rs0 --dbpath /tmp/mongodb --port 27017 --fork --logpath /tmp/mongod.log
mongosh --eval "rs.initiate()"
```

Or use Docker:
```bash
docker run -d -p 27017:27017 --name mongo-rs mongo:7 --replSet rs0
docker exec mongo-rs mongosh --eval "rs.initiate()"
```

### Install and run

```bash
cd app
cp .env.example .env
npm install
npm start
```

Server starts on `http://localhost:3000`.

### Run tests

```bash
cd app
npm test
```

Tests spin up an in-memory MongoDB replica set automatically — no external database needed.

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

| Method | Path | Description |
|---|---|---|
| `POST` | `/claims` | Submit a claim |
| `GET` | `/claims/:id` | Get claim + current decisions |
| `GET` | `/claims/:id/decisions` | Full decision history (audit trail) |
| `POST` | `/claims/:id/review` | Trigger adjudication |
| `POST` | `/claims/:id/pay` | Mark as paid |
| `POST` | `/claims/:id/dispute` | Member disputes a decision |
| `POST` | `/claims/:id/reprocess` | Re-adjudicate (appeal / rule correction) |

## Walkthrough

### 1. Create a member and policy

```bash
# Create member
curl -X POST http://localhost:3000/members \
  -H "Content-Type: application/json" \
  -d '{"name":"Jane Doe","dateOfBirth":"1985-03-15","memberId":"MBR-001"}'

# Create policy (use memberId from above)
curl -X POST http://localhost:3000/policies \
  -H "Content-Type: application/json" \
  -d '{"memberId":"<memberId>","planType":"STANDARD","effectiveDate":"2024-01-01"}'

# Add coverage rules (use policyId from above)
curl -X POST http://localhost:3000/policies/<policyId>/versions \
  -H "Content-Type: application/json" \
  -d '{
    "effectiveFrom": "2024-01-01",
    "coverageRules": [
      {
        "benefitCategory": "MEDICAL",
        "serviceTypes": [],
        "coveredPercent": 80,
        "annualLimit": 10000,
        "deductible": 500
      },
      {
        "benefitCategory": "DENTAL",
        "serviceTypes": [],
        "coveredPercent": 50,
        "annualLimit": 2000,
        "deductible": 0
      }
    ]
  }'
```

### 2. Submit and adjudicate a claim

```bash
# Submit claim
curl -X POST http://localhost:3000/claims \
  -H "Content-Type: application/json" \
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
  }'

# Adjudicate (use claimId from above)
curl -X POST http://localhost:3000/claims/<claimId>/review

# Read the decision with explanation
curl http://localhost:3000/claims/<claimId>
```

### 3. Dispute and reprocess

```bash
curl -X POST http://localhost:3000/claims/<claimId>/dispute \
  -H "Content-Type: application/json" \
  -d '{"reason":"Deductible was already met — request re-review"}'

curl -X POST http://localhost:3000/claims/<claimId>/reprocess \
  -H "Content-Type: application/json" \
  -d '{"triggeringEvent":"APPEAL"}'

# See the full decision history including superseded decisions
curl http://localhost:3000/claims/<claimId>/decisions
```

### 4. Mid-year rule change

```bash
# Add a new policy version with updated rules (closes the old version automatically)
curl -X POST http://localhost:3000/policies/<policyId>/versions \
  -H "Content-Type: application/json" \
  -d '{
    "effectiveFrom": "2024-07-01",
    "changeReason": "Annual benefit renewal",
    "coverageRules": [
      {"benefitCategory":"MEDICAL","serviceTypes":[],"coveredPercent":90,"annualLimit":15000,"deductible":250}
    ]
  }'

# Claims with dateOfService before July 1 still use the old rules
# Claims with dateOfService from July 1 onward use the new rules
```
