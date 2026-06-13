# Self-Review

## What's good

**The limit ledger is correct under concurrency.** Two concurrent adjudications writing a CONSUME entry to the same ledger document will produce a write-write conflict in MongoDB's transaction layer. The second retries, sees the first's entry, and correctly computes reduced available capacity. This is the hardest correctness property in the system and it's handled at the storage layer rather than the application layer.

**PolicyVersion preserves rule history.** Claims always adjudicate against the rules that were in effect on the date of service, not the current rules. This is the right behavior for insurance (and likely legally required). The `effectiveFrom`/`effectiveTo` boundary on PolicyVersion makes this work correctly across mid-year rule changes.

**Decision supersession gives a complete audit trail.** Every reprocess creates a new ClaimDecision that links to the old one. Nothing is overwritten. The GET /decisions endpoint returns the full history in chronological order. A reviewer or auditor can reconstruct exactly what happened to any claim.

**Tests encode domain rules, not just HTTP behavior.** The test suite checks that the deductible math is correct, that the limit ledger has CONSUME entries, that the right PolicyVersion is used for a given date of service, and that supersession chains are correctly formed. These tests would catch a coverage rule regression; HTTP-status-only tests would not.

## What's rough

**Deductible is per-claim, not per-year.** This is the biggest domain modeling gap. In real insurance, once a member meets their annual deductible, subsequent claims are processed at the full coverage percent. This system applies the deductible to every claim independently, which means a member who's paid $500 in deductibles across 10 claims will have paid $5,000 in deductibles that should have capped at $500. Fixing this requires a `DeductibleLedger` — the same pattern as `LimitLedger` but tracking deductible consumption instead of limit consumption.

**No NEEDS_REVIEW path.** ClaimItem has a NEEDS_REVIEW status in the schema but adjudication never puts items into it. Complex cases (out-of-network, duplicate submissions, high-value claims) typically get flagged for human review in real systems. This would need a separate queue and a manual adjudication endpoint.

**Reprocess after PAID is blocked with no alternative.** The guard is correct — you shouldn't silently adjust a paid claim — but the error message just says "file a financial adjustment" without any such flow existing. A reviewer trying to reprocess a paid claim hits a dead end.

**The service type matching is flat.** CPT codes in real insurance are hierarchical and grouped. The current matching is exact-string equality against a list. This works for the demo but would need a more sophisticated rule DSL for production use.

**No pagination.** `GET /claims/:id/decisions` returns all decisions for a claim. Claims with long dispute histories would return unbounded results.

**Error messages from Mongoose sometimes leak through.** The error handler catches `ValidationError` and `11000`, but other Mongoose errors (bad ObjectId format, cast errors) return raw error text. A more defensive error handler would sanitize these.

## What I'd change with more time

1. Add `DeductibleLedger` with the same pattern as `LimitLedger`
2. Add a `NEEDS_REVIEW` workflow for manual adjudication with a queue-like endpoint
3. Add financial adjustment flow for post-payment corrections
4. Parameterize deductible application order (gross-then-deductible vs deductible-then-gross)
5. Add a coverage rule DSL or at least richer service type grouping
6. Pagination on list endpoints
7. Tighten error handling to never expose Mongoose internals
