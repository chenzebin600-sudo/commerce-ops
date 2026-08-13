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

## Review round 1 hardening (2026-08-14)

- Approval hashing is now `SHOPEE_DISCOUNT_APPROVAL_V2`. It binds the current Discount ID or complete renewal identity (name, marker, per-shop tier, window and fingerprint), plus exact nullable warehouse `approvedAt`. Stored shard payloads carry the same immutable target. The checked-in golden vectors changed intentionally; any V1 preview/approval must be previewed and approved again and will fail the executor re-hash. No database migration is needed because this is an approval-protocol version change, not a schema change.
- Renewal creation performs full per-shop authorization, capability, warehouse, listing and overlap validation before marker lookup and again immediately before the create intent/write. Empty, removed, unauthorized or drifted shops cannot create an activity. The shop override tier is used by both approval and renewal identity.
- Execution repairs the domain-EXECUTING/Foundation-APPROVED split by beginning and verifying Foundation execution before writes. Terminal repair handles the corresponding completion split.
- Lease renewal is single-flight, timer rejection is handled, and every immediate pre-dispatch fence awaits the latest actual repository renewal. A deferred renewal that loses its epoch sends no write.
- POST classification is separated from readback classification. Once a write may have been sent, any readback exception or incomplete identity is `UNKNOWN`; definite rejected/not-sent writes use the existing `CONFIRMED_NOT_SENT` intent state with a canonical `REJECTED` or `AUTH_BLOCKED` item and reason evidence. This avoids rewriting applied migration 027 or introducing migration-checksum drift.
- Exact item readback now requires platform object, item, explicit model, membership and exact minor price. Reader failures are isolated by shop. `UNKNOWN` and `AUTH_BLOCKED` keep the durable job/domain/Foundation resumable; later runs only read back existing intents, and reauthorized items revalidate before dispatch.
- Create LINK/recovery verifies marker, name, window and fingerprint, then binds the official platform object to the approved plan activity under fencing. Evidence keeps essential proof/request/operation fields and adds a SHA-256 digest when bounded compaction is required.
- Approval verification streams one persisted shard at a time (hard cap 1,000). Execution items, activities and intents use keyset pages, page checkpoints and database status aggregates; legacy unbounded list methods are not used by the executor. Renewal preflight fails closed above 1,000 variants for one shop.

### Review-round verification

- Executor regression: 47 passed, 0 failed.
- All `tests/shopee-discount*.test.mjs`: 175 passed, 0 failed.
- `git diff --check`: clean (line-ending conversion warnings only).
- No live network or Shopee endpoint was used.

## Review round 2 hardening (2026-08-14)

- Forward-only migrations `029_shopee_discount_intent_attempts.sql` and PostgreSQL `037_shopee_discount_intent_attempts.sql` add the honest terminal `REJECTED` intent state, immutable attempt numbering, unique per-attempt identity and partial uniqueness for active `DISPATCHED`/`UNKNOWN` targets. Applied migrations 027/028/036 remain unchanged.
- A definite business or auth POST rejection now closes the original intent as `REJECTED`. Business rejection is terminal for the item. Auth rejection remains resumable: after reauthorization and full revalidation a later run creates a new intent, operation UUID and attempt number while preserving the rejected attempt.
- Current-correction recovery and manual LINK use the approval-bound target Discount even when the plan activity has not yet been populated, and manual item LINK additionally requires the official platform object to equal that target.
- One shared exact-renewal-proof helper now binds shop, name, marker, window and fingerprint, plus operation UUID/payload hash for dispatched creates. Lookup, automatic recovery, post-create verification and manual LINK use the same proof contract.
- Manual create LINK atomically binds the plan activity and returns eligible `UNKNOWN` shop items to `PENDING`; execution then continues without another create. ABANDONED changes stranded items to the explicit manual-closed `SKIPPED` state instead of leaving the job permanently unresolved.
- Renewal preflight scans bounded 100-item pages. A per-item warehouse/listing/overlap drift closes only that item and allows unchanged items and later shops to continue; reader failure remains isolated to its bounded shop batch. The prior 1,000-item shop-wide throw was removed.
- Approval shards, activities, intents and execution items use paged reads. Durable job cursors include a phase and item sequence; resumable recovery resets the cursor when an earlier item is reopened, preventing a checkpoint from skipping unresolved work.
- Current-correction preview binds every ready item to a non-null fixed Discount target and persists that target as the per-shop plan activity. New eligible variants require an unambiguous activity selection; multiple candidates are blocked.

### Round 2 verification

- All `tests/shopee-discount*.test.mjs`: 179 passed, 0 failed.
- Includes SQLite and PostgreSQL migration/adapter contracts, honest rejected attempt/re-auth retry, manual create continuation, exact renewal proof and bounded paging coverage.
- No live network or Shopee endpoint was used.

## Review round 3 hardening (2026-08-14)

- Renewal preflight scans every bounded page and every item in that page. It returns only fully checked ready items and partitions every warehouse, listing or overlap drift to `REQUIRES_REAPPROVAL`; one drift no longer ends validation early or counts unchecked siblings as ready. Activity creation requires a non-empty checked-ready partition.
- Current correction accepts an activity selection only when the selected ID exists in the fetched ongoing Discount set and its exact start/end window contains the preview time. Stored system activity identity must match the fetched ID and window before its tier can be reused. New eligible items bind only to this verified target.
- Definite `REJECTED` intent outcomes now set `completed_at` in both SQLite and PostgreSQL. Adapter tests cover PostgreSQL timestamp binding and executor tests cover persisted SQLite completion.
- Approval verification pages shard metadata and feeds each verified shard hash to a constant-memory streaming SHA-256 accumulator. The accumulator preserves the exact V2 golden algorithm; a 10,000-shard test verifies equivalence, and the executor test forbids the legacy unbounded shard read.
- Manual create LINK now uses the indexed `getPlanActivity(planId, shopId)` repository method shared by SQLite and PostgreSQL; reconciliation tests make the unbounded activity-list method throw.
- PostgreSQL readiness documentation remains deferred to Task 9 as directed.

### Round 3 verification

- All `tests/shopee-discount*.test.mjs`: 183 passed, 0 failed.
- No live network or Shopee endpoint was used.

## Review round 4 hardening (2026-08-14)

- Renewal validation retains ready work across every bounded shop page. A final drift-only page now marks only its drifted items and cannot suppress earlier validated items. Immediately before activity creation, the executor reloads a bounded batch of the shop's still-`PENDING` execution items from the durable checkpoint and fully revalidates that actual batch.
- Current-correction preview can derive an unambiguous target from one persisted system-managed activity without an explicit `activitySelection`, but only when the fetched ongoing Discount has the same ID and exact window and the stored activity supplies a valid tier. External Discounts still require explicit selection; missing, stale and ambiguous stored identities fail closed.
- Any renewal-preflight `SHOPEE_AUTH_ERROR`, including a per-item reader error, blocks the whole affected shop, emits exactly one high-priority safe execution issue for that shop/run, and permits later shops to continue.

### Round 4 verification

- Focused executor/service suite: 77 passed, 0 failed.
- All `tests/shopee-discount*.test.mjs`: 186 passed, 0 failed.
- `git diff --check` on scoped files: clean (line-ending conversion warnings only).
- No live network or Shopee endpoint was used.

## Review round 5 hardening (2026-08-14)

- All execution authorization reporting now passes through `reportShopAuthIssueOnce`, keyed by durable job, shop and run request. It emits at most one `HIGH` execution issue per affected shop/run with only the shop and bounded request identifier as evidence.
- Pre-send authorization failures, including renewal marker lookup and item/read prerequisite failures, remain resumable `AUTH_BLOCKED` outcomes and stop only that shop. Later shops continue.
- An authorization failure after a write may have been sent never claims non-delivery: create/item post-write readback and restart recovery retain `UNKNOWN` intent/item state while still raising the high-priority issue. Definite pre-send POST rejection retains its existing `REJECTED` intent plus `AUTH_BLOCKED` item semantics.
- Activity creation and item dispatch/recovery share the same reporting and state rules. Regression coverage includes marker lookup, post-create readback, post-item readback with same-shop deduplication, and activity/item restart recovery.

### Round 5 verification

- Executor suite: 56 passed, 0 failed.
- All `tests/shopee-discount*.test.mjs`: 191 passed, 0 failed.
- No live network or Shopee endpoint was used.
