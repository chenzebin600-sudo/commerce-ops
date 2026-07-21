# PostgreSQL Migration Test Report (F3)

Date: 2026-07-20
Status: PASS

## Safety boundary

- Source: official SQLite online-backup snapshot, opened read-only.
- Target: `commerce_ops_migration_test.app` only.
- `commerce_ops` was not connected to or modified by the F3 migration runner.
- Production SQLite schema and rows were not modified.
- Files, environment variables, and credentials were not migrated.
- Active production provider remains `sqlite`.

## Source inventory

- SQLite version: 3.51.2
- Source main database size at snapshot start: 260440064 bytes
- Snapshot size: 260440064 bytes
- Snapshot SHA-256: `0243d64b6eed259b8bfae15f8e436b83d8366537c82dabf5973a52ffbe0a4382`
- Snapshot integrity: ok
- Snapshot foreign-key violations: 0
- Tables: 36
- Columns: 579
- Rows: 167307
- Raw SQLite indexes: 108
- Logical foreign keys: 53

## Target inventory

- PostgreSQL endpoint: 127.0.0.1:5432
- Database: `commerce_ops_migration_test`
- Schema: `app`
- Migration role: `commerce_migrator`
- Tables: 36
- Columns: 579
- Indexes: 110 (expected 110)
- Foreign keys: 53
- CHECK constraints: 71
- Insert order: `dingtalk_robot_configs` -> `export_files` -> `file_lifecycle_items` -> `file_lifecycle_protected_files` -> `file_lifecycle_scans` -> `file_quarantine_records` -> `mabang_account_profiles` -> `mabang_filter_option_cache` -> `managed_files` -> `operation_audit_events` -> `product_ai_contents` -> `product_categories` -> `product_cost_snapshots` -> `product_detail_preferences` -> `product_field_override_events` -> `product_field_overrides` -> `product_images` -> `product_import_batches` -> `product_import_field_changes` -> `product_import_files` -> `product_import_issues` -> `product_import_rows` -> `product_inventory_snapshots` -> `product_listing_drafts` -> `product_listing_publish_records` -> `product_models` -> `product_package_rows` -> `product_packaging_profiles` -> `product_sku_lifecycle` -> `product_sku_lifecycle_events` -> `product_skus` -> `scheduled_export_run_events` -> `scheduled_export_runs` -> `scheduled_export_tasks` -> `scheduler_leases` -> `schema_migrations`

## Consistency verification

| Table | Rows | Columns | SQLite indexes | PostgreSQL indexes | FKs | Full-row hash | Key-field hash |
|---|---:|---:|---:|---:|---:|---|---|
| `dingtalk_robot_configs` | 1 | 12 | 1 | 1 | 0 | PASS | PASS |
| `export_files` | 6 | 18 | 10 | 10 | 2 | PASS | PASS |
| `file_lifecycle_items` | 14 | 39 | 5 | 5 | 1 | PASS | PASS |
| `file_lifecycle_protected_files` | 2 | 3 | 1 | 1 | 1 | PASS | PASS |
| `file_lifecycle_scans` | 1 | 14 | 3 | 3 | 1 | PASS | PASS |
| `file_quarantine_records` | 0 | 16 | 3 | 3 | 2 | PASS | PASS |
| `mabang_account_profiles` | 2 | 10 | 1 | 1 | 0 | PASS | PASS |
| `mabang_filter_option_cache` | 381 | 11 | 1 | 2 | 1 | PASS | PASS |
| `managed_files` | 7 | 16 | 5 | 5 | 2 | PASS | PASS |
| `operation_audit_events` | 222 | 21 | 5 | 5 | 0 | PASS | PASS |
| `product_ai_contents` | 0 | 19 | 4 | 4 | 1 | PASS | PASS |
| `product_categories` | 78 | 13 | 3 | 3 | 3 | PASS | PASS |
| `product_cost_snapshots` | 18601 | 14 | 3 | 3 | 2 | PASS | PASS |
| `product_detail_preferences` | 1 | 7 | 1 | 1 | 0 | PASS | PASS |
| `product_field_override_events` | 100 | 8 | 2 | 2 | 1 | PASS | PASS |
| `product_field_overrides` | 80 | 9 | 2 | 2 | 1 | PASS | PASS |
| `product_images` | 0 | 16 | 3 | 3 | 1 | PASS | PASS |
| `product_import_batches` | 4 | 30 | 3 | 3 | 0 | PASS | PASS |
| `product_import_field_changes` | 2 | 19 | 3 | 3 | 3 | PASS | PASS |
| `product_import_files` | 4 | 5 | 3 | 3 | 2 | PASS | PASS |
| `product_import_issues` | 2149 | 14 | 2 | 2 | 2 | PASS | PASS |
| `product_import_rows` | 21979 | 20 | 6 | 6 | 1 | PASS | PASS |
| `product_inventory_snapshots` | 21976 | 7 | 3 | 3 | 2 | PASS | PASS |
| `product_listing_drafts` | 0 | 36 | 4 | 4 | 1 | PASS | PASS |
| `product_listing_publish_records` | 0 | 13 | 2 | 2 | 1 | PASS | PASS |
| `product_models` | 6500 | 12 | 2 | 2 | 3 | PASS | PASS |
| `product_package_rows` | 21714 | 57 | 4 | 4 | 4 | PASS | PASS |
| `product_packaging_profiles` | 18347 | 11 | 1 | 1 | 2 | PASS | PASS |
| `product_sku_lifecycle` | 18347 | 11 | 2 | 2 | 2 | PASS | PASS |
| `product_sku_lifecycle_events` | 18393 | 10 | 2 | 2 | 2 | PASS | PASS |
| `product_skus` | 18347 | 26 | 8 | 8 | 5 | PASS | PASS |
| `scheduled_export_run_events` | 34 | 11 | 1 | 2 | 1 | PASS | PASS |
| `scheduled_export_runs` | 2 | 21 | 4 | 4 | 1 | PASS | PASS |
| `scheduled_export_tasks` | 1 | 24 | 3 | 3 | 2 | PASS | PASS |
| `scheduler_leases` | 1 | 4 | 1 | 1 | 0 | PASS | PASS |
| `schema_migrations` | 11 | 2 | 1 | 1 | 0 | PASS | PASS |

All row hashes are calculated after normalizing booleans, JSON key order, UUID case, UTC timestamps, dates, integers, and bigint strings. Hashes are reported only as match results in this table; no sensitive row values are included.

## Key business table mapping

- Requested `scheduled_tasks`: actual table `scheduled_export_tasks`.
- Requested `execution_records`: actual tables `scheduled_export_runs` and `scheduled_export_run_events`.
- File metadata: `export_files`, `managed_files`, `file_lifecycle_scans`, `file_lifecycle_items`, `file_lifecycle_protected_files`, `file_quarantine_records`.
- Audit: `operation_audit_events`.
- Mabang: `mabang_account_profiles`, `mabang_filter_option_cache`, scheduled task/run tables.

## Result

- Successful migrations: 36/36 tables.
- Failed migrations: 0.
- Failures: None.
- Schema conversion: completed.
- Data conversion: completed.
- Index and constraint conversion: completed.
- Full-row and key-field hash parity: passed.

## Risks before formal migration

1. F3 proves schema and data portability, not business Repository compatibility; that belongs to F4.
2. A formal migration requires stopping the web service and scheduler before the final snapshot.
3. PostgreSQL timestamp and collation behavior must be covered by Repository-level tests.
4. Identity sequences must be reset after explicit historical IDs are loaded.
5. Physical files remain outside the database and require a separate file-integrity plan.
6. PostgreSQL production permissions and backup/restore must be rechecked during the formal cutover.
