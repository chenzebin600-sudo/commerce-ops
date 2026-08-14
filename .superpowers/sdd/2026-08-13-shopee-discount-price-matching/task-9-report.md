# Task 9 implementation report

## Scope delivered

- Added real-SQLite integration coverage for preview, exact human approval, execution request, warehouse drift isolation, one successful write/readback, ambiguous write `UNKNOWN`, process restart, lease takeover and readback-only recovery without POST replay.
- Added a bounded capacity dry-run for the locked scale: 1,000 shops/country, 1,000 links/shop and 10,000 variants/shop. Pages are capped at 10,000 records; default is 1,000. The report records logical totals, page counts, maximum resident page, heap growth and elapsed time.
- Added a single fail-closed scheduler startup resolver and wired the root scheduler to it. Scheduler activation now requires explicit shops, valid per-shop IANA timezones, HTTPS warehouse URL, one DingTalk config and an HTTP(S) entry URL. The root still injects no autonomous executor.
- Added SQLite fresh/upgrade/reopen-idempotency coverage through migration 032.
- Updated PostgreSQL migration contract inventory through migration 040 and removed the stale global latest-migration assertion from Growth Radar.
- Updated PostgreSQL readiness without claiming live PostgreSQL DDL, and added the Shopee Discount operator runbook.
- Added `npm run shopee-discount:capacity-check`.

## TDD evidence

- Capacity test first failed with `ERR_MODULE_NOT_FOUND` for `scripts/shopee-discount-capacity-check.mjs`, then passed after the bounded implementation.
- Startup test first failed because `resolveShopeeDiscountSchedulerStartup` was not exported, then passed after the resolver and root wiring.
- PostgreSQL migration tests first failed because their exact inventory stopped at 035 and assumed the foundation link was the last migration; they now cover 036–040 explicitly.
- Full-suite run exposed one stale Growth Radar assertion expecting migration 026 to remain globally last; the test now verifies that the migrated database reaches the actual disk ledger head.

## Verification

- `node --disable-warning=ExperimentalWarning --test tests/shopee-discount*.test.mjs tests/postgresql-migration*.test.mjs tests/postgresql-readiness.test.mjs`: 260 passed, 0 failed.
- `npm run shopee-discount:capacity-check`: 1,000 shops, 1,000,000 links, 10,000,000 variants; 11,001 pages; maximum resident page 1,000; heap growth 8,361,352 bytes; 632.7382 ms; `livePostgresqlDdlExecuted=false`.
- `npm --prefix frontend/commerce-ops-vue run check`: exit 0.
- `npm --prefix frontend/commerce-ops-vue run build`: exit 0; existing chunk-size warning only.
- `npm test`: 1,385 passed, 0 failed, 2 skipped.
- `git diff --check` for Task 9 files: exit 0.

## Safety

- No live Shopee call, DingTalk send, PostgreSQL connection or PostgreSQL DDL was executed.
- Capacity CLI defaults to synthetic paged dry-run. PostgreSQL mode refuses to run without explicit URL and an injected paged source.
- Generated frontend build artifacts and unrelated dirty files are intentionally excluded from the scoped commit.
