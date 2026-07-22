# Mainline SQLite Drift Audit Before G1B Merge

## Decision

- Audit status: **COMPLETE**
- Database at rest: **PASS**
- Unknown writes: **none found**
- A2 static review: **PASS**
- A2 merge gate: **BLOCKED pending business-baseline confirmation**
- Production enablement: **BLOCKED**

The database became fully static after the main service, scheduler, advertising service, and A2 development service were stopped. A 643-second observation window showed no changes to the SQLite main file, WAL, or any of the 54 table hashes. The SHM modification time changed only when read-only inspection connections were opened; its size remained 32,768 bytes.

One business-fact change exists relative to the pre-013/014 backup: one `product_skus` row was soft-deleted through a successful loopback `local_session` HTTP request at 2026-07-22 18:07:22 CST. The source is traceable and is not a scheduler or A2 write, but a product fact change is a class-C merge blocker under this audit policy. The row was not restored or otherwise modified by this audit.

## Scope And Protection

- Main branch at start: `master`
- Main HEAD at start: `e2fef3c46d286a87a422ca733737dae28d15a835`
- Highest migration: `014_deterministic_growth_radar_scope_and_linkage.sql`
- Formal SQLite: `storage/commerce-ops.sqlite`
- A2 branch: `feature/deterministic-growth-radar-g1b`
- A2 commit: `3ef9dd7379a525148205ec22253188a7f84caff9`
- Branch B: inspected only; no files changed
- No merge, checkpoint, `VACUUM`, WAL/SHM deletion, migration 015, or migration 016 was performed.

The following existing untracked references were preserved and excluded from this audit commit:

- `docs/product-query-center-DESIGN.md`
- `docs/product-query-center-production-analysis.md`

## Process Inventory And Shutdown

| Role | Port | PID at start | Command role | Database boundary | Result |
|---|---:|---:|---|---|---|
| Main Commerce Ops server | 3101 | 31300 | `server.mjs` under `scripts/start-all.mjs` | Formal SQLite | Graceful `SIGTERM`, stopped |
| Formal scheduler | none | 21512 | `scheduler.mjs` under `scripts/start-all.mjs` | Formal SQLite | Graceful `SIGTERM`, stopped |
| Managed advertising service | 4173 | 24564 | advertising `server.mjs`, child of main server | No direct formal SQLite ownership | Stopped with main server |
| A2 development server | 3193 | 9028 | `server.mjs` under `scripts/start-growth-radar-g1b.mjs` | Isolated development SQLite | Graceful `SIGTERM`, stopped |
| Controlled Chrome | 9222 | none | No listener found | Not applicable | No action |

The main orchestration PID was 31052. The A2 orchestration PID was 31036. The A2 runtime resolved to `storage/development/growth-radar-g1b.sqlite` inside its own worktree, with port 3193 and external advertising mode; it did not resolve to the formal database.

After shutdown:

- Ports 3101, 3193, and 4173 had no listeners.
- No project `server.mjs`, `scheduler.mjs`, `start-all.mjs`, or G1B start process remained.
- Generic Codex MCP Node processes were left untouched because they were not Commerce Ops runtime processes.

## Static Observation

Observation window: 2026-07-22 18:12:46 CST to 18:23:29 CST, 643 seconds.

| Artifact | T0 | T1 | Result |
|---|---|---|---|
| Main SQLite | 260,849,664 bytes; SHA-256 `b606814fff95362d8acaacf7779b54048402b452feff54e066f3b960c693c09e` | Same size, time, and hash | Stable |
| WAL | 4,120,032 bytes; SHA-256 `c914ff5c6fb3c851c3b5c202afa7d80e6415ebdd1bbf2f9052b9545dc9621621` | Same size, time, and hash | Stable |
| SHM | 32,768 bytes | Same size; modification time changed during read-only inspection | Read-only connection effect |
| Tables | 54 table counts and logical hashes | No differences | Stable |
| Integrity | `ok` | `ok` | Pass |
| Foreign keys | 0 violations | 0 violations | Pass |

The post-test snapshot also matched T1 for the main file, WAL, and all 54 table hashes.

## Current Database State

- Migration records: 14
- Highest migration: 014
- `product_skus`: 18,347
- `product_models`: 6,500
- `product_package_rows`: 21,714
- `product_inventory_snapshots`: 21,978
- `product_images`: 1
- `product_field_overrides`: 81
- `product_listing_drafts`: 0
- `product_ai_contents`: 0
- `product_image_generation_tasks`: 0
- `operation_audit_events`: 271
- `scheduled_export_tasks`: 1
- `scheduled_export_runs`: 2
- `scheduler_leases`: 1
- `export_files`: 9
- `managed_files`: 7
- `mabang_account_profiles`: 2
- `dingtalk_robot_configs`: 1
- `product_identity_mappings`: 0

All 15 `growth_*` tables contain 0 rows:

- `growth_data_quality_issues`
- `growth_inventory_raw_rows`
- `growth_inventory_snapshots`
- `growth_mapping_events`
- `growth_mapping_issues`
- `growth_order_headers`
- `growth_order_inventory_links`
- `growth_order_lines`
- `growth_order_raw_rows`
- `growth_shop_sku_coverage_snapshots`
- `growth_shop_sku_observations`
- `growth_shop_source_mappings`
- `growth_shops`
- `growth_sku_warehouse_sales_metrics`
- `growth_source_batches`

## Drift Analysis

The comparison source was the consistent pre-013/014 backup created on 2026-07-22. Every common table received a full logical hash comparison.

### Authorized Schema Changes

- `schema_migrations`: 12 to 14.
- Fifteen empty `growth_*` tables were added by migrations 013 and 014.
- Empty `product_identity_mappings` was added by the same approved migration set.

### Class A: Allowed Runtime Changes

- `scheduler_leases`: one existing `mabang_scheduler` lease was refreshed while the scheduler was running. The final update was 2026-07-22 18:10:57 CST, before T0.
- `operation_audit_events`: nine rows were added. Their action-only summary includes temporary-file cleanup, AI history view, a bounded missing-file download, a failed AI provider call, advertising status checks, an import request audit, and the product deletion audit. No secrets, request bodies, customer PII, or full identifiers are included here.

### Class B: Attention Without Independent Blocking

- SHM modification time changed when read-only inspection connections were opened. Main and WAL hashes, table hashes, and row counts did not change.
- Runtime logs show expected service and scheduler starts. No log evidence indicated an unexplained writer.

### Class C: Merge Blocker

- `product_skus`: one existing row, represented in audit evidence as identifier hash `88ad1f300ff5`, changed only in `revision`, `updated_at`, `deleted_at`, and `deleted_by`.
- The matching audit event was `product.deleted`, HTTP 200, actor type `local_session`, source class `loopback`, at 2026-07-22 18:07:22 CST.
- Row count remained 18,347. `product_package_rows`, product images, field overrides, listing data, orders, inventories, and all Growth Radar tables retained identical logical hashes.

This is an attributable local product soft deletion, not an unknown background write. It still requires an explicit decision that the deletion is an accepted business baseline before A2 is merged.

## Log Correlation

- Main service logs show the Commerce Ops server, scheduler, and managed advertising child starting together.
- The scheduler lease advanced every poll cycle and stopped advancing after graceful shutdown.
- The product deletion timestamp matches its successful HTTP audit event to the millisecond range.
- No A2 process had the formal SQLite path; A2 used its isolated development database.
- No continued WAL change occurred after the formal runtime processes were stopped.

## Consistent Backup

The project online-backup implementation, `createSqliteMigrationSnapshot`, was used. It opened the source read-only and used the SQLite Online Backup API. No file-only copy, checkpoint, or `VACUUM` was used.

- Backup: `storage/backups/pre-g1b-merge-audit-20260722T102353Z/commerce-ops-before-g1b.sqlite`
- Manifest: `storage/backups/pre-g1b-merge-audit-20260722T102353Z/backup-manifest.json`
- SHA-256: `be3d47a7c97eb2a4d8a3f9e995ddce1f22677920097bf3ffa613d829484aad72`
- Size: 260,849,664 bytes
- Integrity: `ok`
- Foreign-key violations: 0
- Highest migration: 014
- Core counts: exact match
- All 54 table logical hashes: exact match

The backup represents the current logical database, including the product soft deletion. It is not a pre-deletion restore point.

## A2 Static Review

- A2 is a direct descendant of `e2fef3c46d286a87a422ca733737dae28d15a835`.
- A2 contains four commits and ends at `3ef9dd7379a525148205ec22253188a7f84caff9`.
- No migration files changed; highest migration remains 014.
- No SQLite, WAL, SHM, storage, log, backup, Excel, CSV, local environment, key, or cookie file is committed.
- Secret scanning found no API key, DingTalk credential, private key, Bearer credential, or cookie value in the A2 additions.
- Text additions contain no phone number, email address, or public IP fixture.
- Twenty committed screenshots use synthetic workbooks, sample shops, masked order identifiers, and no visible customer PII.
- Three safety stashes remain separate Git objects and are not ancestors of the A2 commit.
- Repository write targets are limited to Growth Radar tables and `product_identity_mappings`; A2 does not write `product_package_rows`.
- `current_online` remains `null/unavailable` without an authoritative snapshot.
- `company_sales` remains `null/unavailable` and is not derived from source-visible sales.
- No G2 scoring, recommendations, or opportunity-ranking workflow is included.

A2 passes the static code boundary. It must not be merged until the class-C product soft deletion is either accepted as the current business baseline or handled through a separately approved business-data procedure.

## Quality Gates

- Main test suite: 506 passed, 0 failed.
- Build: passed.
- Portable-path check: passed.
- Frontend static check: 422 unique element IDs and 185 bindings passed.
- Doctor: all checks `OK`; services remained stopped and ports were available.
- Main tracked-file secret scan: only existing synthetic test fixtures matched credential-shaped patterns.
- Git database/runtime-file scan: no tracked database, WAL, SHM, storage, backup, Excel, CSV, log, or local environment files.
- Final SQLite integrity: `ok`.
- Final foreign-key violations: 0.

## Merge And Production Restrictions

1. Do not merge A2 until the product soft deletion is explicitly accepted as the intended baseline or a separately approved restore procedure is completed.
2. Do not use the audit backup to claim a pre-deletion state; it intentionally preserves the current state.
3. Do not enable G1B production workflows merely because the static review passed. Growth Radar source tables are empty and `current_online`/`company_sales` remain unavailable.
4. A later merge must still run the combined test suite, build, Doctor, database integrity checks, and post-merge service smoke checks.
5. This audit did not merge A2 or Branch B and did not create migrations 015 or 016.
