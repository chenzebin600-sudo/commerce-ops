# Commerce Ops PostgreSQL Production Cutover Final Report

Local date: 2026-08-07 (Asia/Shanghai)  
Status: **PASS — PRODUCTION SWITCHED TO POSTGRESQL**  
Production provider: `postgres`  
Production database: `commerce_ops`  
Application role: `commerce_app`  
`is_switch_ready`: **true**

## Final migration result

The explicitly approved maintenance window completed in 542,270 ms. The
SQLite main service and scheduler were already fully stopped at the final
preflight, all known active-work counters were zero, and the workflow accepted
that complete frozen state while continuing to reject any partial writer
state.

The retained SQLite backup and the pinned synchronization snapshot are the
same immutable source:

- File: `storage/backups/commerce-ops-pre-postgresql-cutover-20260806171738.sqlite`
- Bytes: 3,514,544,128
- SHA-256: `df5fe80166e7d150b741e5f5253a1e9d2146cfa7ccf95255bd588f9b70cd979f`
- SQLite integrity: `ok`
- Foreign-key violations: 0

## Complete synchronization

| Evidence | Result |
|---|---:|
| Source tables | 92/92 |
| Views | 15/15 |
| Source rows | 3,875,432 |
| Source columns | 1,616 |
| Inserted | 0 |
| Updated | 1 (`scheduler_leases`) |
| Deleted | 0 |
| Unchanged/skipped | 3,875,431 |
| Table count/full digest failures | 0 |
| Source-only/target-only primary keys | 0 / 0 |
| Validated foreign keys | 156 |
| Matched indexes | 319/319 |
| Business totals | 10/10 |
| Deterministic samples | 42/42 |

No schema drift or unexplained data difference was found. All nine final
candidate gates passed, including application-role boundaries, controlled
Product/Sales/Inventory/Task/Audit/Agent/Tool writes with cleanup, process-
scoped health, and the pinned SQLite rollback startup probe.

## Backups

- Retained final SQLite backup: read-only, hash and integrity verified.
- Final PostgreSQL artifact:
  `commerce-ops-commerce_ops-20260806172534.dump.aes256gcm`
- Encrypted bytes: 320,711,353
- Encrypted SHA-256:
  `2b10f28cd67e4021b2b157077ac171ca991c3bd52a9358a545e3e08bf6f983f0`
- Encryption: AES-256-GCM
- Plaintext retained: no

The earlier isolated automated restore rehearsal remains PASS. Post-cutover
backup and recovery commands now require and recognize the exact guarded
`commerce_ops / FORMAL_CUTOVER` production context.

## Runtime acceptance

- Persistent configuration: `DATABASE_PROVIDER=postgres`.
- Other PostgreSQL modes: Shadow, staging, rehearsal and candidate modes are
  disabled.
- Main service: HTTP `/api/health` = 200 / `{ "ok": true }`.
- Scheduler: running with an active PostgreSQL lease and zero pending runs.
- Provider composition: `name=postgres`, `mode=production`,
  `target=commerce_ops`.
- Application connection: `current_database=commerce_ops`,
  `current_user=commerce_app`, default transaction read-only is off.
- Business counts immediately after cutover: 18,347 products, 80,140 sales
  headers, 81,703 inventory snapshots, 376 Foundation tasks, 3 Agent Runs and
  15 Tool Invocations.
- Agent Observability: ready, schema migration not required, active runs 0.
- Daily Report Agent `sales.daily-report@2.1.0`: historical runs and Tool/Context
  evidence are queryable from PostgreSQL; its latest recorded run succeeded.
- `commerce_app` is correctly denied access to `shadow_meta` with SQLSTATE
  42501.

## Post-cutover monitoring

The first production monitor snapshot passed with no alerts:

- connections: 4/100 (4%);
- blocked sessions: 0;
- long transactions: 0;
- waiting locks: 0;
- deadlocks: 0;
- WAL archive failures: 0;
- TLS, WAL archive, I/O timing, slow-query logging and
  `pg_stat_statements`: enabled;
- final backup age: under one hour;
- disk free: 61,239,738,368 bytes (25.38%).

Disk headroom currently passes the configured gate but is close to 25%, so it
should remain on the operational watch list as PostgreSQL and retained backup
history grow.

## Recovery boundary

PostgreSQL-only audit and scheduler-lease writes began after service startup.
There is no automatic PostgreSQL-to-SQLite reverse synchronization. Do not
silently change `DATABASE_PROVIDER` back to SQLite. For an incident, freeze
PostgreSQL writers and follow a separately approved data-reconciliation or
restore procedure.

Machine-readable evidence:
`COMMERCE-OPS-POSTGRESQL-PRODUCTION-CUTOVER-20260806171738.json`.
