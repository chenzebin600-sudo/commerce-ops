# Commerce Ops PostgreSQL Shadow Migration Phase 1

Date: 2026-08-05  
Status: **PASS**  
Contract: `COMMERCE-OPS-PG-SHADOW-1.0.0`

## Safety boundary

- Production provider remains `sqlite`.
- The formal SQLite database was opened read-only and copied with the SQLite online backup API.
- PostgreSQL target is the isolated database `commerce_ops_shadow` only.
- No production database switch, data deletion, MinIO migration, or business-Agent development occurred.

## Shadow architecture

- Compatibility schema: `app` (88 tables, 15 views).
- AI projection schema: `ai_shadow`.
- Migration and table-load ledger: `shadow_meta`.
- PostgreSQL size after Phase 1: 1544 MB.
- Full SQLite schema contract: 88 tables, 1527 columns, 148 foreign keys, 15 views.

## Versioned migrations

- `001_legacy_tables.sql`: ALREADY_APPLIED, SHA-256 `bacd7014e3d6a43d22c201cf62324a19803992b6f3e61954bae0553b78bd0947`
- `002_ai_observability.sql`: ALREADY_APPLIED, SHA-256 `240c73c166e7f6c5a61ae4ea97598bc6580274434839640c3903975e65582105`
- `003_legacy_constraints_indexes_views.sql`: ALREADY_APPLIED, SHA-256 `eb1db9cefb0d211d6bedc4fa107772f0ba01bc944d22ac6c01bb435ff56f723f`

## Data scope

- 60 dependency-closed core tables were loaded.
- The loaded scope contains 2,227,016 rows from the fixed SQLite snapshot.
- Product/SKU, store identity, order headers/lines, inventory, Foundation and scheduled tasks, and operation audit data are included.
- Non-core compatibility tables have structure only in Phase 1.

## Key consistency checks

| Table | SQLite rows | PostgreSQL rows | Count | Deterministic sample |
|---|---:|---:|---|---|
| `foundation_tasks` | 252 | 252 | PASS | PASS |
| `growth_inventory_snapshots` | 61,548 | 61,548 | PASS | PASS |
| `growth_order_headers` | 79,768 | 79,768 | PASS | PASS |
| `growth_order_lines` | 115,868 | 115,868 | PASS | PASS |
| `operation_audit_events` | 42,031 | 42,031 | PASS | PASS |
| `product_skus` | 18,347 | 18,347 | PASS | PASS |

- Source snapshot integrity: `ok`.
- Source foreign-key violations: 0.
- PostgreSQL foreign keys: 148; validated: true.
- Failed loaded tables: none.

## AI observability projection

- Agent Runs: 2.
- Tool Invocations: 8.
- Gateway Calls: 4.
- Context Snapshots: 0 (structure only because SQLite has no first-class snapshot table).
- Evaluations: 0 (structure only because SQLite has no first-class evaluation rows).
- Projection inserted this run: {"agentRunsInserted":0,"toolInvocationsInserted":0,"gatewayCallsInserted":0}.

## Repository compatibility

- Provider contract: present.
- PostgreSQL provider: present.
- Production composition-root switch: **not implemented**.
- Provider-aware repository files: 10.
- SQLite-only data-layer files: 3.
- Required next change: Add a provider factory at the composition root, then migrate real repositories domain by domain behind parity contracts; do not switch DATABASE_PROVIDER until production Repository SQL passes PostgreSQL integration tests.

The application must not set `DATABASE_PROVIDER=postgres` yet. Phase 1 proves schema/data portability, not full business Repository parity.

## File assets

The current local files were not moved. A non-wired `StorageProvider` contract now defines `LocalStorageProvider` and injectable `MinioStorageProvider` implementations. Existing runtime behavior remains unchanged. Database rows continue to store metadata and relative keys only.

## Problems found

1. Name-based UUID inference is unsafe for platform IDs, SHA-256 values, and namespace IDs; the Shadow contract uses explicit generated types and keeps identifiers as text.
2. The SQLite expression index for one running price-control sync needs an explicit PostgreSQL expression-index mapping.
3. Self-referential foreign keys require data-first, constraints-after loading.
4. Current production data access still constructs SQLite directly and several repositories remain SQLite-only.
5. Agent Context and Evaluation are audit projections today, not first-class SQLite tables.
6. Interrupted rehearsal databases `commerce_ops_shadow_attempt_20260805_2017` and `commerce_ops_shadow_attempt_20260805_2020` were retained for forensic review; neither is an application target.

## Next phase

1. Add a production composition-root Provider factory without switching the default.
2. Port real Product, Sales, Inventory, Task, and Audit repositories behind dual-dialect contracts.
3. Add PostgreSQL integration tests for scheduler leases, task transitions, JSON queries, partial indexes, and Agent Monitoring.
4. Repeat Shadow load from a newer snapshot and measure incremental drift.
5. Only after repository parity and UAT, plan a separately approved final write freeze and cutover.
