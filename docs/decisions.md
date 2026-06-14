# Decisions & Trade-offs

## What I built

**Core adjudication engine** — given a Claim and a date of service, the engine finds the PolicyVersion active on that date, applies each coverage rule to each ClaimItem, consumes limit ledger entries inside a transaction, and creates immutable ClaimDecision records with member-facing explanations.

**State machine** — explicit valid-transition map for Claim status. Invalid moves return 422 with a clear message.

**Limit ledger** — append-only CONSUME/RELEASE entries keyed by (policy, benefit category, calendar year). Replaces a mutable counter with a transaction-safe audit trail.

**Policy versioning** — `PolicyVersion` with `effectiveFrom`/`effectiveTo`. Creating a new version automatically closes the old one. Claims adjudicated after a rule change still use the rules in effect on the date of service.

**Decision supersession** — each reprocess creates a new ClaimDecision linked to the old one via `supersededBy`. Full history is available at `GET /claims/:id/decisions`.

**Dispute → reprocess flow** — members can dispute, which moves to `DISPUTED`, and a subsequent `/reprocess` releases old limit consumption, resets item statuses, and re-adjudicates.

**Dispute resolution** — adjusters can resolve disputes via `POST /claims/:id/dispute/resolve` with `UPHELD`, `REVERSED`, or `WITHDRAWN`. `REVERSED` automatically triggers reprocessing, creating a new superseding decision chain. This replaces the manual two-step dispute-then-reprocess flow.

**Annual deductible accumulator** — `DeductibleLedger` tracks deductible consumption per `(policy, member, benefitCategory, calendar year)` using the same append-only APPLY/RELEASE pattern as `LimitLedger`. The correct formula is applied: deductible is consumed first, coverage percent applied to the remainder. Once met, subsequent claims in the same year skip the deductible entirely.

**NEEDS_REVIEW routing** — coverage rules with `requiresManualReview=true` route items to a `NEEDS_REVIEW` decision instead of auto-approving or auto-denying. Adjusters manually resolve these via `POST /claims/:id/items/:itemId/adjudicate`. The claim holds in `UNDER_REVIEW` until all such items are resolved.

**JWT authentication** — all endpoints require a `Bearer` token. Role-based access control gates write operations by role (`MEMBER`, `ADJUSTER`, `ADMIN`, `AUDITOR`). PHI is filtered per caller role: `diagnosisCodes` are stripped for non-clinical roles, and `MENTAL_HEALTH` decision details are redacted for members.

---

## What I did not build

**Pre-authorization tracking** — claims for services requiring pre-auth are denied with a `REQUIRES_PRE_AUTH` code. There's no workflow to record that pre-auth was obtained and re-adjudicate. That would need a `PreAuthRecord` entity and an additional claim state.

**Out-of-network rules** — coverage rules don't distinguish in-network vs. out-of-network. Most real plans have different percentages for each.

**Coordination of benefits** — no handling for members with secondary insurance.

**Financial reversal after PAID** — once a claim is paid, reprocessing is blocked. A real system would need a financial adjustment flow that credits/debits the difference and creates a corrected payment record.

**Pagination** — list and history endpoints return all results. A cursor-based pagination scheme (keying on `_id`) would be the right approach for `GET /claims/:id/decisions` on long-lived claims.

---

## Assumptions

1. **Calendar year limits** — annual limits reset on January 1. The ledger period is always a calendar year, not a rolling 365 days.

2. **Date of service determines rule version** — coverage rules active on `dateOfService` apply, regardless of when the claim was submitted or adjudicated.

3. **Deductible applies before coverage percent** — the correct insurance formula is applied: `eligibleAmount = billedAmount - deductibleApplied`, then `approvedAmount = eligibleAmount × coveredPercent%`. This matches standard plan documents where the member absorbs the deductible first, then shares the remaining cost at the coverage split.

4. **Service type matching** — an empty `serviceTypes` array on a coverage rule means it applies to all service types in that benefit category. Specific service type codes take precedence only if listed.

5. **One active policy version at a time** — enforced by a unique partial index on `(policyId, effectiveTo=null)`. A policy can't have two simultaneously active versions.

6. **MongoDB replica set required** — transactions require a replica set. This is noted in the README setup steps.

---

## Stack choices

**MongoDB** — chosen because coverage rules are naturally document-shaped (nested arrays of rules with optional service type lists). Schema flexibility lets new rule types be added without migrations. The trade-off is that MongoDB transactions require a replica set, adding operational complexity.

**Zod** — validates request bodies at the API boundary with precise error messages. Keeps validation out of domain models.

**No ORM beyond Mongoose** — Mongoose gives enough structure (schema, indices, methods) without adding another abstraction layer.
