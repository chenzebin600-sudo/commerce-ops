# Task 5 report: preview, immutable approval and API module

## Status

Implemented Task 5 with local fixtures and a real temporary SQLite repository/Foundation service. No live Shopee or warehouse request, platform write, configured credential use, or external database write was performed.

## Delivered

- `ShopeeDiscountService` exposes the requested small operations for status, shops, preview creation/detail/item paging, immutable approval, execution enqueueing, runs, activities, issues and manual scans.
- Preview input is exact-schema validated. Country/shop authorization, explicit default scope, tier/workflow values, nested override schemas, duplicate/conflicting overrides and override scope are fail-closed.
- The preview pipeline pages active listings, keeps zero-stock variants, filters inactive item/model states, shares warehouse results by normalized SKU, validates warehouse snapshots through Task 3 and prices through Task 1.
- Per-variant fallback uses each variant's original price. Abnormal targets, duplicate normalized SKUs, external activities without a declared tier, overlapping Discounts and near-end newly active items are isolated without blocking unrelated variants.
- Overlap issues persist bounded safe evidence containing the original Discount identity and time. Preview summaries contain counts/codes only; item payloads are returned solely through bounded cursor paging.
- Ready items are sorted deterministically, appended in immutable shards using Task 2, sealed with the Task 1 approval root, and bound to a Foundation plan carrying the same Merkle root. A Foundation bind failure leaves a non-approvable `BLOCKED` domain plan.
- SQLite enforces the one-shop/ten-variant pilot limit before persistence; PostgreSQL uses the repository's production-scale mode and provider-neutral bounded read queries.
- Approval requires the exact root, confirmation text, `PREVIEWED` state, current policy and unexpired TTL. Identical repeats are idempotent; changes to root, text, operator label or trusted actor identity fail.
- Separate-identity mode requires a privileged identity supplied by trusted server context and a final approval object binding plan/root/policy/expiry. Ordinary body/header values cannot create that trusted identity.
- Execution revalidates approval, root, TTL, policy, write security, whitelist and per-shop batch limits, then creates one deterministic durable `PENDING` job. Concurrent/repeated requests reuse the same job and invoke zero Shopee writes.
- `createShopeeDiscountApi` owns only fixed `/api/shopee-discount/*` routes, bounded JSON/query parsing, method/body/schema rejection, safe stable error mapping and safe audit annotations.
- `server.mjs` registers one module handler using the existing data access, Foundation, Shopee token, injected read adapter and fail-closed warehouse/write-security configuration. No network operation occurs during composition/startup.

## TDD evidence

Service RED began with `ERR_MODULE_NOT_FOUND` for `lib/shopee-discount/service.mjs`. Each subsequent regression was observed failing before its implementation, including near-end age isolation, trusted actor binding, exact-expiry rejection, concurrent execution deduplication, override scope, Foundation failure blocking and persisted overlap evidence.

API RED began with `ERR_MODULE_NOT_FOUND` for `lib/shopee-discount/api.mjs`. Fixed routes, method/body/query bounds, route/body plan binding, trusted-context derivation and safe error/audit behavior were then implemented to GREEN.

Fresh required verification:

```powershell
node --check lib/shopee-discount/service.mjs
node --check lib/shopee-discount/api.mjs
node --check server.mjs
node --test tests/shopee-discount-service.test.mjs tests/shopee-discount-api.test.mjs tests/app-access.test.mjs
```

Result: 30 passed, 0 failed.

Fresh complete Shopee Discount verification:

```powershell
$taskTests = Get-ChildItem -Path tests -Filter 'shopee-discount-*.test.mjs' | Sort-Object Name | Select-Object -ExpandProperty FullName
node --test $taskTests
```

Result: 101 passed, 0 failed.

## Concerns and deployment prerequisites

- Production warehouse preview remains fail-closed unless `SHOPEE_DISCOUNT_WAREHOUSE_BASE_URL` is HTTPS and an encrypted warehouse key is configured. Vault-reference resolution is not invented in this task.
- Real writes remain disabled unless Task 4's complete deployment security contract passes. In separate-identity mode, trusted middleware still must supply the privileged server context; client headers and bodies are intentionally ignored.
- Scale behavior is provider-neutral, but Task 5's real-repository behavioral suite is SQLite as required. PostgreSQL adapter/provider contracts remain covered by the complete Shopee Discount suite without contacting a live database.
- The pre-existing unrelated `server.mjs` startup-policy edit and all other dirty workspace files were preserved outside this task's staged patch.

## Review round 1 hardening

Addressed all eight findings from `task-5-review.md` with public service/repository regressions:

- Warehouse fallback now requires an explicit validated requested-SKU row. Successful scoped baselines are persisted and supplied to later validation; omitted requested SKUs fail with `WAREHOUSE_SKU_COVERAGE_INCOMPLETE`.
- Execution authorization runs at plan scope before item-count handling. Empty approved plans fail with `SHOPEE_DISCOUNT_NO_EXECUTABLE_ITEMS` and cannot create a job.
- Preview and approval use deterministic saga identities across the domain and Foundation stores. Preview shards resume by identity, post-create failures compensate both plans to `BLOCKED`, Foundation-create audit failures are recovered through the deterministic ID, concurrent identical approval is idempotent, and preview issue-event failure is best-effort after sealing.
- Current system activities resolve only through persisted platform activity identity and stored tier metadata; activity names grant no ownership. External activity tier selection remains explicit. The 24-hour rule uses actual membership activation evidence and persists `NEXT_PLAN_REQUIRED` evidence.
- Plan/items/runs/activities/issues and manual scans enforce trusted shop scope. Scans additionally validate duplicate IDs, health and country before durable deduped enqueueing.
- Pricing capabilities are selected by exact country. Unsupported countries are rejected, and the server's THB default is available only for the TH site.
- Production ingestion has finite item/Discount page and row caps, bounded model concurrency, batched base reads, bounded warehouse SKU chunks, and one pinned watermark across chunks. Pagination that still reports more at the configured cap fails closed. Discount details retain only identity, timing and membership rows needed by assembly.
- Listings and models require an explicit recognized active status; missing/unknown statuses are excluded and counted as issues.
- Raw read-model SQL was moved behind matching SQLite/PostgreSQL repository methods, and API/service request-field schemas now share one immutable definition.

Fresh review verification:

```powershell
node --test tests/shopee-discount-service.test.mjs
node --test tests/shopee-discount-postgresql-contract.test.mjs tests/foundation-v1.test.mjs tests/shopee-discount-api.test.mjs
node --test tests/shopee-discount-*.test.mjs tests/app-access.test.mjs
```

Results: service 17 passed; integration contracts 26 passed; complete Shopee Discount plus app-access suite 127 passed; 0 failed in every run.

## Review round 2 lifecycle reconciliation

- Approval now persists explicit `DOMAIN_APPROVED`, `BOTH_APPROVED`, and `COMPENSATION_FAILED` saga phases. A retry after process loss between domain and Foundation approval completes the Foundation binding; execution requires the durable `BOTH_APPROVED` phase plus matching domain/Foundation state, hashes and actor.
- Failed compensation is auditable and cannot execute because the domain plan is durably blocked. Concurrent identical approvals continue to converge on one exact binding.
- `BLOCKED` plans no longer reserve the active target window, so a new request can replace a failed preview while the old plan remains queryable for audit.
- One warehouse watermark is pinned across every tier and chunk in a preview, not merely within a tier.
- Foundation supplied-ID idempotency validates task/type, all content hashes, approval mode/text, creator, summary, plan hash and bounded TTL semantics before returning an existing plan.
- Repeated Foundation approval validates actor type and ID, exact text hash, plan hash and approval mode against its persisted approval event. The unused `block(IN_FLIGHT)` claim was removed.
- Execution has a distinct plan-level authorization action for switch/mode/identity/approval checks, followed by per-shop country/whitelist/batch checks. A two-shop 5+5 plan therefore passes a cap of five while zero-target plans still fail before queueing.

Fresh round 2 verification: required Task 5 and app-access suite 43 passed; Foundation operation-plan/v1 suite 15 passed; all Shopee Discount tests 115 passed; 0 failed.

## Review round 3 atomic Foundation approval

- Foundation approval now uses one provider-neutral repository transaction for the optimistic `PREVIEWED` → `APPROVED` update and its exact `APPROVED` event/evidence insert. An event conflict or write failure rolls the state update back in both SQLite and PostgreSQL provider paths.
- SQLite approval transactions are serialized at the repository boundary so concurrent identical approvals cannot attempt nested transactions; the loser reloads and validates the committed exact approval event binding.
- An injected approval-event failure regression proves the plan remains `PREVIEWED`, no approval event is retained, a retry succeeds, concurrent retry produces one event, and repeated approval reads that event binding.
- Other Foundation state transitions retain their existing transition/event path.

Fresh round 3 verification: Foundation operation-plan/v1 suite 16 passed; required Task 5/app-access suite 43 passed; all Shopee Discount tests 115 passed; 0 failed.

## Review round 4 shared SQLite transaction boundary

- Async SQLite transactions are now serialized by a connection-scoped queue shared by every `SqliteProvider` wrapping that connection, rather than by a Foundation repository instance.
- Provider `query`, `execute`, and `executeScript` calls from other logical operations wait for the open transaction; calls through its supplied executor retain ownership. This prevents unrelated repository writes from becoming part of another operation's commit or rollback.
- Nested async transactions on the same logical operation fail immediately with `SQLITE_TRANSACTION_REENTRANT`; synchronous transaction-manager use while async work is active or queued fails with `SQLITE_TRANSACTION_BUSY`, avoiding deadlock and nested `BEGIN`.
- Two provider instances and two Foundation repositories are exercised concurrently: approval remains atomic while block and update wait, each operation keeps its own state/event outcome, and an injected approval-event failure rolls back only that approval attempt.
- The Foundation-specific approval tail was removed; PostgreSQL continues using its existing connection transaction manager.

Fresh round 4 verification: data-access/provider compatibility 13 passed; Foundation operation-plan/v1 17 passed; required Task 5/app-access 43 passed; all Shopee Discount tests 115 passed; 0 failed.

## Review round 5 guarded raw SQLite access

- `SqliteProvider.connection` now returns a connection-scoped guarded facade. Repositories that cache `DatabaseSync`-style statements remain compatible, but raw statement mutations and `exec` cannot bypass an active or queued foreign async transaction; they fail deterministically with `SQLITE_RAW_WRITE_BLOCKED`.
- Prepared statements are guarded at invocation time, including statements cached before a transaction begins. Mutation-capable `run`, `get`, `all`, and `iterate` paths are covered. The transaction owner may use its supplied executor; unrelated cached repository writers cannot inherit its commit or rollback.
- Raw reads remain synchronous by explicit compatibility policy and may observe the shared connection's current transaction. New or migrated write paths should use provider executors/transactions.
- Existing Shopee Discount and audit raw-caching repositories are exercised during a paused Foundation approval. Both foreign writes are rejected and absent after the approval commits, while the Foundation state/event pair remains atomic.
- Async-local reentrancy now requires the inherited token to equal the connection's currently active owner token. Live nesting still fails, but a detached callback created inside a completed transaction can start a new queued transaction without stale-context rejection.

Fresh round 5 verification: data-access/audit/provider suite 34 passed; Foundation plus Shopee Discount repository suite 29 passed; required Task 5/app-access suite 43 passed; all Shopee Discount tests 115 passed; 0 failed.
