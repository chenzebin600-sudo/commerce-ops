# Commerce Ops PostgreSQL Phase 3D Cutover Runbook

Status: **formal cutover completed 2026-08-07**  
Production provider: `postgres`  
Rehearsal target: `commerce_ops_cutover_rehearsal`  
Production database: `commerce_ops`

## Safety contract

1. The final switch was explicitly approved and completed. Any future provider
   reversal or database replacement requires a new explicit approval.
2. Shadow, staging, migration-test, and the Phase 3D rehearsal database are not
   production databases.
3. Rehearsal refreshes require the fixed target and exact confirmation. These
   commands are historical validation paths and are not production writers:

   ```powershell
   npm run postgres:phase3d:plan
   npm run postgres:phase3d:refresh
   ```

4. The final SQLite source was frozen before synchronization. Future schema
   changes are applied to PostgreSQL through versioned production migrations;
   the pre-cutover SQLite synchronization path must not be resumed silently.
5. The formal switch is forbidden if any table, view, row count, primary-key
   `EXCEPT`, multiset digest, foreign key, index, business total, AI projection,
   or deterministic sample has an unexplained difference.
6. PostgreSQL-to-SQLite reverse synchronization does not exist. The validation
   interval before PostgreSQL-only writes must therefore remain read-only, and
   rollback after PostgreSQL-only writes requires a separate decision.

## Development-period refresh

This path may run while SQLite remains writable:

1. Create a pinned SQLite online-backup snapshot.
2. Run full integrity and foreign-key checks on the snapshot.
3. Inventory every SQLite table and view.
4. Apply only pending versioned PostgreSQL migrations to the independent
   rehearsal database.
5. Run full-row digests and bidirectional primary-key `EXCEPT` checks.
6. Upsert and reconcile only changed source tables, child-first for deletes.
7. Rebuild AI Agent observability projections from Audit events.
8. Run the second full validation, application-role checks, write contracts,
   process-scoped PostgreSQL startup, health check, and SQLite rollback probe.

The development-period result is readiness evidence, not a cutover snapshot.

## Formal-candidate preparation

This stage was explicitly approved and completed on 2026-08-06:

1. Reconfirmed that `commerce_ops` is the intended target and remains separate
   from production SQLite.
2. Backed up the empty candidate before initialization.
3. Initialized its eight current versioned PostgreSQL migrations through the migrator
   role.
4. Grant only `CONNECT` and application CRUD/sequence privileges to
   `commerce_app`; keep database/schema `CREATE`, ownership, `ALTER`, and `DROP`
   unavailable to the application role.
5. Loaded a current full SQLite snapshot covering 92 source tables and 15
   views.
6. Completed a full-source refresh with zero count, key, digest, constraint,
   index, view, business-total, or deterministic-sample differences.
7. Verified the current candidate with an encrypted logical backup and a clean
   automated restore rehearsal.
8. Kept the persistent provider on SQLite; candidate control state is
   `READY/PASS` while `is_switch_ready=false` until the final frozen refresh.

## Final cutover window

Before completion, the guarded command defaulted to a read-only plan:

```powershell
npm run postgres:production:cutover:plan
```

The following approved sequence was executed with exact database,
writer-freeze, cutover, and no-reverse-sync confirmation tokens:

1. Announce the window and stop every SQLite writer:
   - main-service mutating endpoints;
   - scheduler and Price Control synchronization;
   - Daily Report or Agent tasks that can persist state;
   - fulfillment and file-lifecycle writers;
   - manual scripts and feature migrations.
2. Confirm there are no remaining SQLite write transactions.
3. Take the final pinned SQLite online-backup snapshot.
4. Require `integrity_check=ok` and zero `foreign_key_check` rows.
5. Re-inventory the complete source. Any schema drift returns to migration
   preparation and blocks the window.
6. Run the full-source reconcile against `commerce_ops`.
7. Require all final gates:
   - every table and view present;
   - equal row counts;
   - zero source-only and target-only primary keys;
   - equal full-row and key digests;
   - all foreign keys validated and index inventory matched;
   - business totals, view results, AI projections, and samples matched;
   - application-role boundary and health checks passed.
8. Mark `is_switch_ready=true` only for the exact latest passing frozen
   snapshot.
9. Atomically persist the guarded `DATABASE_PROVIDER=postgres` production-mode
   configuration, then start the main service and scheduler using
   `commerce_app`.
10. Verify health, Product, Sales, Inventory, Task, Audit, Agent Runtime,
    Tool Invocation, Daily Report, Scheduler, monitoring, and integrations.
11. Re-enable writers in controlled groups and watch error rate, latency, locks,
    WAL, disk, and connection metrics.

## Rollback

Before PostgreSQL-only writes, rollback is a configuration reversal to SQLite
plus the verified SQLite startup path. After PostgreSQL-only writes, do not
silently switch back: freeze both sides and either reconcile PostgreSQL changes
to SQLite through an explicitly approved procedure or remain on PostgreSQL
while the incident is resolved.

The production main service and scheduler have now written PostgreSQL audit and
lease state, so the post-write boundary has been crossed. Automatic reversal to
the retained SQLite snapshot is no longer safe.

## Completed production cutover

- Local completion time: 2026-08-07 (Asia/Shanghai).
- Duration: 542,270 ms.
- Final frozen source: 92 tables, 15 views, 3,875,432 rows, 1,616 columns.
- Final snapshot SHA-256:
  `df5fe80166e7d150b741e5f5253a1e9d2146cfa7ccf95255bd588f9b70cd979f`.
- Final reconcile: 0 inserted, 1 scheduler-lease row updated, 0 deleted,
  3,875,431 skipped.
- Final validation: 92/92 full digests, zero bidirectional primary-key
  differences, 156 validated foreign keys, 319 indexes, 15 views, 10 business
  totals, and 42 deterministic samples.
- Persistent mode: `DATABASE_PROVIDER=postgres`, exact `FORMAL_CUTOVER` guard.
- Runtime: main HTTP 200, scheduler lease active, application role
  `commerce_app`, `is_switch_ready=true`.
- Final evidence:
  `docs/reports/COMMERCE-OPS-POSTGRESQL-PRODUCTION-CUTOVER-FINAL-20260807.md`.

## Measured rehearsal and candidate baseline

- Current source scope at the latest completed candidate refresh: 92 tables,
  15 views, 3,875,429 rows, and 1,616 columns.
- Latest candidate full validation: 92/92 table digests, zero bidirectional
  primary-key differences, 156 validated foreign keys, 319 indexes, 10
  business totals, and 42 deterministic samples.
- Latest candidate end-to-end refresh and validation: 505.5 seconds.
- Reconcile durations: 104 ms, 3,941 ms, and 4,754 ms.
- Small-sample measured p95: 4,754 ms.
- Full snapshot plus integrity/foreign-key checks: 146,581 ms in the final run.
- Full pre-validation plus reconcile: 283,031 ms.
- Final full validation: 286,512 ms.
- Total final rehearsal: 722,143 ms.

The reconcile timing is not the whole maintenance window. Use the full
end-to-end measurements and a safety buffer when scheduling the formal window.
The guarded production cutover retains a final SQLite backup and performs a new
full refresh and validation after the exact writers are stopped, so the actual
window should allow at least 15 minutes plus a safety margin.
