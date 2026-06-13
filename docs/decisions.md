# Decisions & Trade-offs

## What I built

**Core adjudication engine** — given a Claim and a date of service, the engine finds the PolicyVersion active on that date, applies each coverage rule to each ClaimItem, consumes limit ledger entries inside a transaction, and creates immutable ClaimDecision records with member-facing explanations.

**State machine** — explicit valid-transition map for Claim status. Invalid moves return 422 with a clear message.

**Limit ledger** — append-only CONSUME/RELEASE entries keyed by (policy, benefit category, calendar year). Replaces a mutable counter with a transaction-safe audit trail.

**Policy versioning** — `PolicyVersion` with `effectiveFrom`/`effectiveTo`. Creating a new version automatically closes the old one. Claims adjudicated after a rule change still use the rules in effect on the date of service.

**Decision supersession** — each reprocess creates a new ClaimDecision linked to the old one via `supersededBy`. Full history is available at `GET /claims/:id/decisions`.

**Dispute → reprocess flow** — members can dispute, which moves to `DISPUTED`, and a subsequent `/reprocess` releases old limit consumption, resets item statuses, and re-adjudicates.

---

## What I did not build

**Deductible accumulator** — the `deductible` field on coverage rules is applied per-claim, not tracked as a running annual accumulator. Real insurance applies the deductible once per year, then covers 100% (or the coverage percent) after. This simplification means the system overapplies deductibles for members who've already met their annual deductible through other claims. Fixing this would require a `DeductibleLedger` analogous to `LimitLedger`.

**Pre-authorization tracking** — claims for services requiring pre-auth are denied with a `REQUIRES_PRE_AUTH` code. There's no workflow to record that pre-auth was obtained and re-adjudicate. That would need a `PreAuthRecord` entity and an additional claim state.

**Out-of-network rules** — coverage rules don't distinguish in-network vs. out-of-network. Most real plans have different percentages for each.

**Coordination of benefits** — no handling for members with secondary insurance.

**Financial reversal after PAID** — once a claim is paid, reprocessing is blocked. A real system would need a financial adjustment flow that credits/debits the difference and creates a corrected payment record.

**Pagination** — no pagination on list endpoints.

**Auth** — out of scope per the assignment.

---

## Assumptions

1. **Calendar year limits** — annual limits reset on January 1. The ledger period is always a calendar year, not a rolling 365 days.

2. **Date of service determines rule version** — coverage rules active on `dateOfService` apply, regardless of when the claim was submitted or adjudicated.

3. **Deductible applies before coverage percent** — the calculation is `billedAmount × coveredPercent% - deductible`. Some plans apply the deductible first then apply the coverage percent; this implementation does it the other way. The code is easy to change but the choice needs domain input.

4. **Service type matching** — an empty `serviceTypes` array on a coverage rule means it applies to all service types in that benefit category. Specific service type codes take precedence only if listed.

5. **One active policy version at a time** — enforced by a unique partial index on `(policyId, effectiveTo=null)`. A policy can't have two simultaneously active versions.

6. **MongoDB replica set required** — transactions require a replica set. This is noted in the README setup steps.

---

## Stack choices

**MongoDB** — chosen because coverage rules are naturally document-shaped (nested arrays of rules with optional service type lists). Schema flexibility lets new rule types be added without migrations. The trade-off is that MongoDB transactions require a replica set, adding operational complexity.

**Zod** — validates request bodies at the API boundary with precise error messages. Keeps validation out of domain models.

**No ORM beyond Mongoose** — Mongoose gives enough structure (schema, indices, methods) without adding another abstraction layer.
