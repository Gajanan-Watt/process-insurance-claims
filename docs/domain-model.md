# Domain Model

## Entities

### Member
The insured individual. Holds a reference to their active Policy.

### Policy
Links a Member to a coverage plan. Contains only durable facts (plan type, effective date, status) — coverage rules live in PolicyVersion.

### PolicyVersion
A temporal snapshot of coverage rules for a Policy. When rules change, the old version is closed (`effectiveTo` is set to the day before the new version takes effect) and a new version is created. Claims link to the `PolicyVersion` active on their `dateOfService` — not the current version — so rule changes never retroactively alter past decisions.

**Coverage Rule (embedded in PolicyVersion)**
```
benefitCategory      — MEDICAL | DENTAL | VISION | MENTAL_HEALTH | PRESCRIPTION
serviceTypes         — CPT/service codes; empty array = applies to all types in category
coveredPercent       — 0–100; applied to eligible amount after deductible
annualLimit          — calendar-year cap on approved payouts for this benefit category
annualDeductible     — member's annual out-of-pocket amount before coverage applies;
                       tracked across all claims via DeductibleLedger (not per-claim)
requiresPreAuth      — if true, claim is denied pending prior authorization
requiresManualReview — if true, item routes to NEEDS_REVIEW for adjuster review
                       instead of being auto-approved or auto-denied
```

### Claim
The intake record — what the member submitted. Immutable after submission. Contains one or more **ClaimItems**.

### ClaimItem (embedded in Claim)
A single line item: a service type, benefit category, and billed amount. Has its own status independent of the Claim's status.

### ClaimDecision
An immutable adjudication record for a single ClaimItem. Each time an item is adjudicated (initial or reprocess), a new ClaimDecision is created. Old decisions are marked `supersededBy` pointing to the new one. This gives a complete audit trail without mutation.

Fields:
- `policyVersionId` — which rules were applied (audit link)
- `approvedAmount` — what will be paid
- `denialCode` / `denialReason` — machine-readable + human-readable denial cause
- `explanation` — member-facing text explaining the decision
- `versionNumber` — monotonically increasing within a ClaimItem
- `supersededBy` — FK to the next ClaimDecision; null means this is the current active decision
- `triggeringEvent` — INITIAL_SUBMISSION | APPEAL | RULE_CORRECTION | ADMIN_OVERRIDE

### LimitLedger
An append-only ledger tracking limit consumption per `(policy, benefitCategory, calendar year)`. Entries are either CONSUME (capacity locked by an approved decision) or RELEASE (reversal of a prior CONSUME during reprocessing).

Available limit = `annualLimit - sum(CONSUME entries) + sum(RELEASE entries)`

All CONSUME writes happen inside a MongoDB transaction. Two concurrent adjudications writing to the same ledger document will produce a write-write conflict; the second transaction retries and sees the first's consumption, preventing double-spending of the limit.

### DeductibleLedger
An append-only ledger tracking annual deductible consumption per `(policy, member, benefitCategory, calendar year)`. Entries are either APPLY (deductible charged against a claim item) or RELEASE (reversal during reprocessing).

Applied deductible = `sum(APPLY entries) - sum(RELEASE entries)`, capped at `annualDeductible`.

The adjudication engine calls this before computing coverage: `eligibleAmount = billedAmount - deductibleApplied`, then `approvedAmount = eligibleAmount × coveredPercent%`. Once a member's deductible is fully met for the year, subsequent claims in the same benefit category are processed at the full coverage percent with no deductible applied.

---

## Relationships

```
Member ──── Policy ──── PolicyVersion[]
              │
              └──── Claim[] ──── ClaimItem[] ──── ClaimDecision[]
              │                        │
              ├──── LimitLedger[]      └── (claimItemId links Decision to Item)
              │
              └──── DeductibleLedger[]   (per member+benefitCategory+year)
```

---

## State Machines

### Claim Status

```
SUBMITTED
    │
    ▼
UNDER_REVIEW ──────────────────────────────┐
    │                                      │
    ├──► APPROVED ──► PAID                 │
    │         └──► DISPUTED ──► UNDER_REVIEW (reprocess)
    │                                      │
    ├──► PARTIALLY_APPROVED ──► PAID       │
    │               └──► DISPUTED ─────────┘
    │
    └──► DENIED
              └──► DISPUTED ──► UNDER_REVIEW (reprocess)
```

- `PAID` is terminal — no further transitions. Reprocessing a paid claim requires a separate financial adjustment flow (out of scope).
- `DISPUTED` is a holding state; it always leads back to `UNDER_REVIEW` via reprocessing.

### ClaimItem Status

```
PENDING → APPROVED | DENIED | NEEDS_REVIEW
```

`NEEDS_REVIEW` is set when the matching coverage rule has `requiresManualReview=true`. The item is held until an adjuster calls `POST /claims/:id/items/:itemId/adjudicate` to manually approve or deny it. The claim stays in `UNDER_REVIEW` until all NEEDS_REVIEW items are resolved.

---

## Key Design Decisions

### Why PolicyVersion (not mutable coverage rules on Policy)?

Coverage rules change mid-year. A claim for a January service submitted in August must be adjudicated under January's rules, not August's. Mutating the Policy would destroy this history. PolicyVersion preserves it.

### Why LimitLedger (not a counter on Policy)?

A counter requires a read-modify-write cycle that's racy under concurrent adjudications. Two threads can both read `limit_used = $8,000` and both approve against a $2,000 remaining balance. The ledger replaces this with append-only writes inside transactions: the second concurrent writer sees the first's entry on retry.

The ledger also makes limit consumption auditable — every CONSUME and RELEASE entry is traceable to a specific claim and item.

### Why immutable ClaimDecision (not a mutable status field)?

Reprocessing is a first-class operation in insurance (appeals, rule corrections, admin overrides). If decisions were mutable, reprocessing would overwrite history. The supersession chain preserves the original decision and the triggering event for every revision — critical for audit, member communication, and dispute resolution.

### Why transactions?

Adjudication has two correlated writes: updating `Claim.status` + `ClaimItem.status`, and appending to `LimitLedger`. Without a transaction, a crash between these writes could leave a claim APPROVED but the limit not consumed (or vice versa). MongoDB multi-document transactions (requiring a replica set) make these atomic.
