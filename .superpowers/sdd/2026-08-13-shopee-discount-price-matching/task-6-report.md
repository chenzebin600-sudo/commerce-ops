# Task 6: Durable execution, fencing and UNKNOWN reconciliation

## Delivered

- `runApprovedPlan(planId, workerContext)` executes only durable, dual-approved plans whose stored shards re-hash to the approved root and whose policy, actor and Foundation bindings still match.
- Durable SQLite and PostgreSQL execution-item checkpoints capture canonical per-item outcomes. Dispatch intent creation and the `DISPATCHED` item checkpoint share one transaction and are fenced by live job owner, epoch and lease.
- Lease renewal runs continuously across network waits and again immediately before dispatch and after readback. A lost owner/epoch stops new writes; late responses are evidence only.
- Existing `DISPATCHED`/`UNKNOWN` intents are recovered with official readback and never replayed. Ambiguous POST outcomes remain `UNKNOWN`; definite business, auth, drift and conflict results are isolated to the affected item or shop.
- Current-correction add/update and next-renewal create/add flows use only injected fixed write methods. Renewal creation is at-most-once and requires a deterministic marker derived from immutable plan/shop/tier/window identity.
- Normal preview construction now persists that renewal identity plus the selected warehouse approval timestamp. A no-network integration test covers preview, approval, queue, activity creation and item addition.
- Terminal completion is repairable after process loss: a repeated run advances a terminal durable job's domain/Foundation saga without dispatching again.
- `reconcileIntent(intentId, resolution, auditContext)` implements exactly `LINK_VERIFIED_OBJECT`, `CONFIRMED_NOT_SENT` and `ABANDONED`, with server-derived actor/request identity, bounded/redacted evidence and no requeue/replacement transition.

## TDD evidence

The implementation was developed in red-green slices. Observed red failures included missing executor/reconciliation modules, missing continuous renewal and pre-dispatch fencing, late-result canonical advancement, replay after an intent-before-send crash, ambiguous POST retries/outcomes, cross-shop auth/conflict propagation, absent PostgreSQL parity/migration, missing reconciliation transition guards, an unusable ordinary renewal plan, unverified renewal marker tampering, missing warehouse approval-time drift, incomplete object identity during manual LINK, and non-repairable completion after a job/domain saga crash. Each slice was made green before proceeding.

No live Shopee or other live network endpoint was used. Executor and service integration tests use temporary real SQLite databases with injected read/write fakes; ambiguous adapter tests use an injected fake transport.

## Verification

- Required Task 6 command: 61 passed, 0 failed.
- All `tests/shopee-discount-*.test.mjs`: 152 passed, 0 failed.
- `git diff --check` on the scoped Task 6 files: clean (line-ending conversion warnings only).

## Operational notes

- The executor is deliberately not registered as an autonomous startup worker in this task. Its public composition seam is ready for a later scheduler integration, and performs no work unless called for an approved durable pending job.
- SQLite remains pilot-only and enforces the repository's configured shop/variant limits. PostgreSQL carries the production-capacity execution schema and interface parity.
- Reconciliation closes the original intent only. Any later replacement remains a separate product workflow requiring conflict readback, new preview/root and new approval; this task intentionally provides no shortcut.
