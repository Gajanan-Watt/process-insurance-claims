# Self-Review

## What's good

**The limit ledger is correct under concurrency.** Two concurrent adjudications writing a CONSUME entry to the same ledger document will produce a write-write conflict in MongoDB's transaction layer. The second retries, sees the first's entry, and correctly computes reduced available capacity. This is the hardest correctness property in the system and it's handled at the storage layer rather than the application layer.

**Annual deductible accumulation is correct.** `DeductibleLedger` uses the same append-only pattern as `LimitLedger` — APPLY/RELEASE entries keyed on `(policy, member, benefitCategory, year)`. The formula is applied in the right order: deductible is consumed first, the coverage percent is applied to the remainder. Once the annual deductible is met, subsequent claims in the same year pay at full coverage percent. Tests verify both the single-claim case and the cross-claim accumulation case.

**PolicyVersion preserves rule history.** Claims always adjudicate against the rules that were in effect on the date of service, not the current rules. This is the right behavior for insurance (and likely legally required). The `effectiveFrom`/`effectiveTo` boundary on PolicyVersion makes this work correctly across mid-year rule changes. A retroactive version fallback handles claims submitted for dates before the first version was created.

**Decision supersession gives a complete audit trail.** Every reprocess creates a new ClaimDecision that links to the old one. Nothing is overwritten. The `GET /decisions` endpoint returns the full history in chronological order. A reviewer or auditor can reconstruct exactly what happened to any claim.

**NEEDS_REVIEW and dispute resolution are wired end-to-end.** Coverage rules with `requiresManualReview=true` route items to a `NEEDS_REVIEW` decision; adjusters resolve them via `POST /claims/:id/items/:itemId/adjudicate`. Disputes are resolved via `POST /claims/:id/dispute/resolve` — `REVERSED` automatically reprocesses and creates superseding decisions. These were previously modeled in the schema but never executed.

**PHI is filtered by caller role.** `diagnosisCodes` are stripped from responses for non-clinical roles. `MENTAL_HEALTH` benefit decisions are redacted for `MEMBER` callers — they receive a plan-administrator referral instead of denial details. PHI-returning endpoints also have a tighter rate limit (60 req/15 min vs. 200 global).

**Tests encode domain rules, not just HTTP behavior.** The test suite checks deductible math (single claim and accumulation), limit ledger entry types and counts, the correct PolicyVersion used for a given date of service, and supersession chain formation. These tests would catch a coverage rule regression; HTTP-status-only tests would not.

## What's rough

**Reprocess after PAID is blocked with no alternative.** The guard is correct — you shouldn't silently adjust a paid claim — but a financial adjustment flow (credit/debit the difference, issue a corrected payment record) doesn't exist. A reviewer trying to correct a paid claim hits a dead end.

**The service type matching is flat.** CPT codes in real insurance are hierarchical and grouped. The current matching is exact-string equality against a list. This works for the demo but would need a more sophisticated rule DSL for production use.

**No pagination.** `GET /claims/:id/decisions` returns all decisions for a claim. Claims with long dispute histories would return unbounded results. A cursor-based scheme (keying on `_id`) would be the right fix.

## What I'd change with more time

1. Financial adjustment flow for post-payment corrections
2. Pre-authorization obtained workflow (`PreAuthRecord` entity + re-adjudicate route)
3. Pagination on history endpoints
4. Coverage rule DSL or richer service type grouping (hierarchical CPT matching)
5. Out-of-network rule support (in-network vs. out-of-network coverage splits)
