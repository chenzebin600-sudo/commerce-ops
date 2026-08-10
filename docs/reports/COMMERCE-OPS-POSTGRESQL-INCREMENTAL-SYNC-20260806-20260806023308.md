# Commerce Ops PostgreSQL Incremental Sync Report

Status: **PASS**  
Direction: `SQLite -> PostgreSQL Shadow`  
Production provider: `sqlite`

## Safety

- Formal SQLite was opened read-only and copied with the SQLite online backup API.
- The only write target was `commerce_ops_shadow` through the migrator role.
- No reverse synchronization, production provider switch, DELETE propagation, business-Agent development, or file migration occurred.
- `is_switch_ready` remains false even when validation passes.

## Baseline

- Phase 1 snapshot: `<workspace>\tmp\postgresql-shadow-phase1\commerce-ops-shadow-source.sqlite`
- Phase 1 snapshot time: `2026-08-05T12:20:45.780Z`
- Phase 1 SHA-256: `46704f2d4f2c6792cedb870658a8fdb020bb4a2b3edba33a0e12e0424f8c11db`
- Control migration: `004_incremental_sync_control.sql` (ALREADY_APPLIED)

## Current snapshot

- Path: `<workspace>\tmp\postgresql-incremental-sync\commerce-ops-incremental-20260806022032-07b95bd3.sqlite`
- Snapshot time: `2026-08-06T02:20:47.373Z`
- SHA-256: `8e36b5438ce1c10ff3fed00957ba4e9156643ff7986faf150a04dcc0e2456a8d`
- Integrity: `ok`
- Foreign-key violations: 0

## Synchronization

- Batch: `none`
- Tables: 0
- Rows examined: 0
- INSERT: 0
- UPDATE: 0
- Skipped by full-table digest: 0

| Table | Domain | Examined | Inserted | Updated | Skipped |
|---|---|---:|---:|---:|---:|
| - | - | - | - | - | - |

## Validation

- Result: **PASS**
- Tables checked: 47
- Count differences: 0
- Deterministic random samples: 42
- Sample failures: 0
- Business counts: {"productSkus":{"source":18347,"target":18347,"match":true},"orderHeaders":{"source":80140,"target":80140,"match":true},"orderLines":{"source":116293,"target":116293,"match":true},"inventorySnapshots":{"source":81703,"target":81703,"match":true},"tasks":{"source":376,"target":376,"match":true},"auditEvents":{"source":42197,"target":42197,"match":true}}
- Differences: none

DELETE synchronization remains intentionally unsupported. Any target-only row is reported and blocks switch readiness rather than being removed.
