# Commerce Ops PostgreSQL Phase 3D Readiness Report

Date: 2026-08-06  
Status: **REHEARSAL PASS / FORMAL SWITCH BLOCKED**  
Production provider: `sqlite`  
Rehearsal database: `commerce_ops_cutover_rehearsal`  
`is_switch_ready=false`

## Outcome

The independent Phase 3D cutover and rollback rehearsal passed without changing
formal SQLite, the persistent provider setting, Shadow, staging, migration-test,
or the formal PostgreSQL candidate. The rehearsal dynamically detected the
concurrent SQLite migration `027_commerce_shop_registry.sql`; PostgreSQL
migration `007_commerce_shop_registry.sql` was added before the two new tables
were admitted to synchronization.

After this successful snapshot, development migration
`028_price_control_repricing_workflow.sql` was added to the repository but was
not applied to formal SQLite: the live source remains at migration 027 with 90
tables and 15 views. PostgreSQL migration
`008_price_control_repricing_workflow.sql` was prepared in advance and passed a
complete isolated Phase 3B rebuild with all eight checksums, compatibility,
write, transaction, and constraint contracts. It must be admitted by the next
Phase 3D refresh after migration 028 is formally applied to SQLite.

The successful pinned snapshot contained:

- 90 SQLite tables;
- 15 SQLite views;
- 1,564 columns;
- 3,875,411 rows;
- SHA-256 `82573a77a5443ff877dbb8b7123729cea5d73386d89852e4e7cf2256586638d8`;
- `integrity_check=ok` and zero foreign-key violations.

## Nine gates

| Gate | Status | Evidence |
|---|---|---|
| Independent rehearsal database | PASS | Dedicated `commerce_ops_cutover_rehearsal`; protected database identities unchanged |
| Complete source scope | PASS | 90/90 source tables and 15/15 views |
| Row and digest parity | PASS | 90/90 full-row and key digests matched |
| Bidirectional primary-key difference | PASS | Zero source-only and target-only keys across all 90 tables |
| Foreign keys, indexes, and views | PASS | 151 validated foreign keys, 312 source-table indexes, 15 matched view results |
| Business totals and samples | PASS | 10/10 business totals and 42/42 deterministic samples |
| Application role | PASS | `commerce_app`; CRUD allowed, CREATE/TEMP/ownership/system role flags denied |
| Full write path | PASS | Product, Sales, Inventory, Task, Audit, Agent Run, Tool Invocation and eight provider repository contracts |
| Switch, health, and rollback dry run | PASS | Process-scoped PostgreSQL health 200 and current pinned-SQLite read-only startup rollback passed |

AI projection parity also passed: 3 Agent Runs, 15 Tool Invocations, six Gateway
Calls, and zero orphaned Tool Invocations.

## Business totals

| Metric | SQLite | PostgreSQL | Status |
|---|---:|---:|---|
| Product SKUs | 18,347 | 18,347 | PASS |
| Order headers | 80,140 | 80,140 | PASS |
| Order lines | 116,293 | 116,293 | PASS |
| Ordered quantity | 131,564 | 131,564 | PASS |
| Inventory snapshots | 81,703 | 81,703 | PASS |
| Available inventory | 36,637,606 | 36,637,606 | PASS |
| Foundation tasks | 376 | 376 | PASS |
| Audit events | 42,263 | 42,263 | PASS |
| Valid price changes | 280,941 | 280,941 | PASS |
| Current price points | 617,667 | 617,667 | PASS |

## Synchronization and timing

Three successful full-source reconcile batches are recorded:

| Tables | Examined | Inserted | Updated | Skipped | Duration |
|---:|---:|---:|---:|---:|---:|
| 88 | 3,875,128 | 0 | 1 | 3,875,127 | 104 ms |
| 88 | 3,875,131 | 3 | 42,320 | 3,832,808 | 3,941 ms |
| 90 | 3,875,411 | 280 | 42,288 | 3,832,843 | 4,754 ms |

Measured reconcile p95 for this three-run sample is 4,754 ms. The final full
run took 146,581 ms for snapshot/integrity checks, 283,031 ms for pre-validation
plus reconcile, 286,512 ms for final validation, and 722,143 ms end to end.

## Current blockers

1. SQLite feature development is still active, so the passing snapshot is not
   the final frozen production source.
2. The formal PostgreSQL candidate `commerce_ops` is still empty: zero app
   tables and zero app views.
3. Initializing and loading `commerce_ops` is a formal production-database
   mutation and requires explicit approval.
4. Final writer freeze, final snapshot, final full-source reconcile, and final
   switch approval have not occurred.
5. PostgreSQL-to-SQLite reverse synchronization is not implemented; rollback
   after PostgreSQL-only writes remains unsafe.

## Decision

Phase 3D rehearsal readiness is achieved. Production switch readiness remains
false. The next authorized step is to initialize and warm the formal candidate
without changing `DATABASE_PROVIDER`; after continued SQLite development ends,
perform the final frozen synchronization and request the separate switch
approval.

Detailed machine evidence:
`docs/reports/COMMERCE-OPS-POSTGRESQL-PHASE3D-REHEARSAL-20260806122902.json`.

Final repository verification passed 976/976 tests, the production build, and
Doctor (`SQLite integrity=ok`; occupied service ports were expected). The
infrastructure hardening recheck also passed TLS 1.3, encrypted WAL archive,
500 ms slow-query evidence, `track_io_timing`, and `pg_stat_statements`; see
`docs/reports/COMMERCE-OPS-POSTGRESQL-HARDENING-VERIFICATION-20260806124005.json`.
