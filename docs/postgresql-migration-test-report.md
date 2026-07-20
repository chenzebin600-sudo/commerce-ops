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
- Source main database size at snapshot start: 520192 bytes
- Snapshot size: 520192 bytes
- Snapshot SHA-256: `22e298e37ebc5a622abb26b83e0686d8f05f64472d57cdde9d55195d0e787b12`
- Snapshot integrity: ok
- Snapshot foreign-key violations: 0
- Tables: 15
- Columns: 222
- Rows: 636
- Raw SQLite indexes: 45
- Logical foreign keys: 14

## Target inventory

- PostgreSQL endpoint: 127.0.0.1:5432
- Database: `commerce_ops_migration_test`
- Schema: `app`
- Migration role: `commerce_migrator`
- Tables: 15
- Columns: 222
- Indexes: 47 (expected 47)
- Foreign keys: 14
- CHECK constraints: 23
- Insert order: `dingtalk_robot_configs` -> `mabang_account_profiles` -> `operation_audit_events` -> `scheduler_leases` -> `schema_migrations` -> `mabang_filter_option_cache` -> `scheduled_export_tasks` -> `scheduled_export_runs` -> `export_files` -> `scheduled_export_run_events` -> `file_lifecycle_protected_files` -> `file_lifecycle_scans` -> `file_lifecycle_items` -> `managed_files` -> `file_quarantine_records`

## Consistency verification

| Table | Rows | Columns | SQLite indexes | PostgreSQL indexes | FKs | Full-row hash | Key-field hash |
|---|---:|---:|---:|---:|---:|---|---|
| `dingtalk_robot_configs` | 1 | 12 | 1 | 1 | 0 | PASS | PASS |
| `export_files` | 2 | 18 | 10 | 10 | 2 | PASS | PASS |
| `file_lifecycle_items` | 14 | 39 | 5 | 5 | 1 | PASS | PASS |
| `file_lifecycle_protected_files` | 2 | 3 | 1 | 1 | 1 | PASS | PASS |
| `file_lifecycle_scans` | 1 | 14 | 3 | 3 | 1 | PASS | PASS |
| `file_quarantine_records` | 0 | 16 | 3 | 3 | 2 | PASS | PASS |
| `mabang_account_profiles` | 2 | 10 | 1 | 1 | 0 | PASS | PASS |
| `mabang_filter_option_cache` | 381 | 11 | 1 | 2 | 1 | PASS | PASS |
| `managed_files` | 7 | 16 | 5 | 5 | 2 | PASS | PASS |
| `operation_audit_events` | 182 | 21 | 5 | 5 | 0 | PASS | PASS |
| `scheduled_export_run_events` | 34 | 11 | 1 | 2 | 1 | PASS | PASS |
| `scheduled_export_runs` | 2 | 21 | 4 | 4 | 1 | PASS | PASS |
| `scheduled_export_tasks` | 1 | 24 | 3 | 3 | 2 | PASS | PASS |
| `scheduler_leases` | 1 | 4 | 1 | 1 | 0 | PASS | PASS |
| `schema_migrations` | 6 | 2 | 1 | 1 | 0 | PASS | PASS |

All row hashes are calculated after normalizing booleans, JSON key order, UUID case, UTC timestamps, dates, integers, and bigint strings. Hashes are reported only as match results in this table; no sensitive row values are included.

## Key business table mapping

- Requested `scheduled_tasks`: actual table `scheduled_export_tasks`.
- Requested `execution_records`: actual tables `scheduled_export_runs` and `scheduled_export_run_events`.
- File metadata: `export_files`, `managed_files`, `file_lifecycle_scans`, `file_lifecycle_items`, `file_lifecycle_protected_files`, `file_quarantine_records`.
- Audit: `operation_audit_events`.
- Mabang: `mabang_account_profiles`, `mabang_filter_option_cache`, scheduled task/run tables.

## Result

- Successful migrations: 15/15 tables.
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
