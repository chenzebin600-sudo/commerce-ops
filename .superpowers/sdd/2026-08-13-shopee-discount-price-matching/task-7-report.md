# Task 7 report — Scheduler, reminders, tasks and DingTalk summaries

## Delivered

- Added a durable Shopee Discount runner whose daily scan is unique by country, exact shop scope, IANA timezone and shop-local logical day. Manual scans use independent UUID-backed due jobs and are never collapsed into the daily job.
- Due work is persisted, claimed with fencing epochs, renewed through a heartbeat, caught up after restart and completed only by the current owner. The root runner starts only after the existing external-task policy is active and revalidates ownership of the shared `mabang_scheduler` lease on every tick.
- Added deterministic renewal scheduling: seamless normal renewal, a fresh full 30-day cycle after EVENT/MEGA, nearest platform-usable start after a missed window, configurable capacity throughput/safety SLO and fail-closed maximum lead validation.
- Added exact IANA wall-clock conversion with explicit invalid-zone, DST-gap and DST-overlap rejection. Renewal reminders are unique at T-24h, T-6h and T-1h and persist UTC instants.
- Renewal generation creates an immutable preview/draft and one authoritative human Foundation confirmation task; neither the scheduler nor notification layer approves a plan. An injected approved-plan executor is called only for an explicitly `APPROVED` due-job payload. Root composition deliberately leaves this injection closed unless a deployment supplies the complete Task 4/6 write-security, lease, drift and readback context.
- Added one-group DingTalk summaries with an exact configured group, fixed internal HTTPS entry host, bounded count-only content and no caller-supplied URLs, secrets, raw platform bodies or SKU/price tables. Delivery is persistently deduplicated and compare-and-set claimed; retries are bounded and notification failure never changes a business result.
- Added forward-only SQLite migration 030 and PostgreSQL migration 038 plus repository parity for durable notification delivery state.
- Root `scheduler.mjs` constructs the read-only draft path fail-closed: the feature is disabled by default, missing warehouse HTTPS configuration blocks warehouse work, missing DingTalk configuration sends nothing, and no live write adapter is constructed.

## TDD evidence

- RED began with missing scheduler/notification modules.
- Subsequent RED slices covered same-minute manual scan collapse, absent durable notification persistence, missing notification claim CAS, missing due-job lease renewal and shared-lease loss.
- GREEN includes daily/manual scheduling, restart catch-up, 30-day calculations, capacity rejection, timezone/DST behavior, Foundation task creation, approval gating, safe DingTalk payloads, bounded retry/idempotency, SQLite restart durability and PostgreSQL parameterized/CAS contracts.

## Verification

- Focused Task 7 plus external-task/PostgreSQL contracts: 36 passed, 0 failed.
- All `tests/shopee-discount*.test.mjs`: 211 passed, 0 failed.
- Affected repository/Foundation/scheduler/data-access tests: 38 passed, 0 failed.
- `node --check` passed for root scheduler and both new modules.
- Scoped `git diff --check`: clean except repository line-ending conversion warnings.
- No live Shopee, warehouse or DingTalk request was made.

## Operational configuration

- `SHOPEE_DISCOUNT_SCHEDULER_ENABLED=true` explicitly enables the runner after the shared lease is held.
- `SHOPEE_DISCOUNT_SCHEDULER_SHOP_IDS`, `SHOPEE_DISCOUNT_COUNTRY`, `SHOPEE_DISCOUNT_CATEGORY` and `SHOPEE_DISCOUNT_DEFAULT_TIER` define the default next-period draft scope.
- `SHOPEE_DISCOUNT_SHOP_TIMEZONES_JSON` must map every configured shop ID to its own IANA timezone; missing, conflicting or invalid zones fail closed.
- Capacity knobs are `SHOPEE_DISCOUNT_CAPACITY_PER_HOUR`, `SHOPEE_DISCOUNT_CAPACITY_SAFETY_FACTOR`, `SHOPEE_DISCOUNT_MIN_DRAFT_LEAD_HOURS` and `SHOPEE_DISCOUNT_MAX_DRAFT_LEAD_DAYS`.
- DingTalk requires exactly one `SHOPEE_DISCOUNT_DINGTALK_CONFIG_ID` and an HTTPS `SHOPEE_DISCOUNT_ENTRY_BASE_URL`.

## Breaker review fix round 1

- Renewal replay now derives its request identity only from the durable `dueJobId`. Root composition no longer uses wall-clock time. Replayed Foundation tasks validate that their persisted `input.planId` exactly matches the deterministic draft plan.
- Capacity lead now reads the positive per-shop item count from the durable source activity plan through `countPlanItemsByShop`; absent/zero/mismatched counts fail with `SHOPEE_DISCOUNT_CAPACITY_COUNT_UNAVAILABLE` instead of silently selecting the 24-hour minimum.
- Forward migrations SQLite 031/PostgreSQL 039 add a delivery lease and explicit `coordination_state='UNKNOWN'`. A process loss after DingTalk claim is never blindly resent: after lease expiry it becomes terminal manual coordination with bounded evidence and the recovered due job fails visibly.
- Daily scheduling now creates one durable child job per shop and local logical day. Changing scope from A to A+B reuses A and adds only B. Each child persists its own configured IANA timezone; manual renewal scans resolve the same per-shop map and fail closed if absent.
- Fix-round focused scheduler/notification/PostgreSQL suite: 38 passed, 0 failed. Affected Foundation/repository/scheduler/data-access suite: 38 passed, 0 failed. All `tests/shopee-discount*.test.mjs`: 218 passed, 0 failed. No live network request was made.

## Breaker review fix round 2

- A due job reclaimed slightly before the notification delivery lease expires now performs an owner/epoch-fenced durable deferral of that same unique job to `deliveryLeaseUntil`. It remains `PENDING`; it is not terminally failed or duplicated. At expiry the next claim atomically converts the uncertain send to `FAILED` plus `coordination_state='UNKNOWN'`, and the due job records the manual-coordination outcome.
- Legacy rows that were already `SENDING` before delivery leases existed are converted by the later forward-only migrations 032/040 described below; the already-published 031/039 migrations remain byte-for-byte unchanged.
- Round 2 focused scheduler/notification/PostgreSQL and upgrade suite: 41 passed, 0 failed. Affected Foundation/repository/scheduler/data-access suite: 38 passed, 0 failed. All `tests/shopee-discount*.test.mjs`: 221 passed, 0 failed. No live network request was made.

## Breaker review fix round 3

- Restored the published SQLite 031 and PostgreSQL 039 migration files byte-for-byte to commit `c16e5a8`; their SHA-256 values remain `45264a65ffa79c8da989637a188079f3446595b8fef574cf1ece9faba73e7f53` and `2b2333509e4a6c7363426147bbeb331826d0b0f61d0adb9fc53b93eedfdd2ff4` respectively.
- Added forward-only SQLite 032 and PostgreSQL 040 migrations. They turn legacy `SENDING` notifications with a NULL delivery lease into honest `FAILED/UNKNOWN` manual-coordination records with deterministic migration evidence.
- Upgrade coverage starts from a database whose migration ledger already records the original 031, verifies that only 032 runs, verifies the legacy row repair, and verifies a second migration run is a no-op. PostgreSQL contract coverage pins the published 039 checksum and verifies 040 ordering and application without re-executing 039. Fresh-database coverage remains in the full migration suite.
- Round 3 focused scheduler/notification/PostgreSQL and upgrade suite: 41 passed, 0 failed. Affected Foundation/repository/scheduler/data-access suite: 38 passed, 0 failed. All `tests/shopee-discount*.test.mjs`: 221 passed, 0 failed. No live network request was made.
