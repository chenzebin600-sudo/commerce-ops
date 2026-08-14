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
- Capacity knobs are `SHOPEE_DISCOUNT_CAPACITY_PER_HOUR`, `SHOPEE_DISCOUNT_CAPACITY_SAFETY_FACTOR`, `SHOPEE_DISCOUNT_MIN_DRAFT_LEAD_HOURS` and `SHOPEE_DISCOUNT_MAX_DRAFT_LEAD_DAYS`.
- DingTalk requires exactly one `SHOPEE_DISCOUNT_DINGTALK_CONFIG_ID` and an HTTPS `SHOPEE_DISCOUNT_ENTRY_BASE_URL`.
