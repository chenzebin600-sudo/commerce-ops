# Commerce Ops PostgreSQL Phase 3C Operations Runbook

Status: prepared; infrastructure changes and restore rehearsal require separate approval  
Production provider during preparation: `sqlite`

## Safety boundary

- Do not change `DATABASE_PROVIDER`, freeze formal SQLite, or load `commerce_ops` during Phase 3C.
- Do not alter PostgreSQL server settings, restart PostgreSQL, create restore databases, or delete
  backup artifacts without explicit operator approval.
- Keep credentials out of command lines, reports, shell history, and Git. Use an approved secret
  manager or protected PostgreSQL password file.
- Every backup must have a digest, encryption evidence, retention class, owner, timestamp, and source
  database identity.
- Every restore must target a dedicated database whose resolved name is checked against production,
  Shadow, the migration test database, `postgres`, and template databases.

## 1. Infrastructure decision

Before configuration, record:

- staging and production host ownership;
- service tier and availability target;
- backup and WAL archive destination;
- encryption-key owner and rotation process;
- recovery point objective and recovery time objective;
- retention periods and deletion owner;
- monitoring/on-call owner;
- capacity approver and cutover/rollback operators.

The current loopback PostgreSQL 18.4 instance is development evidence only.

## 2. Required PostgreSQL posture

The approved environment must provide the equivalent of:

```text
ssl = on
wal_level = replica
archive_mode = on
archive_command = <approved encrypted WAL uploader>
data_checksums = on
shared_preload_libraries = 'pg_stat_statements'
track_io_timing = on
log_min_duration_statement = 500
```

The exact values belong to infrastructure configuration, not this repository. TLS must validate the
server identity; an archive command that discards WAL is not acceptable. After any required restart,
run `npm run postgres:phase3c:readiness` and preserve the JSON output in the change record.

## 3. Backup contract

Use a custom-format logical backup for schema/data portability and a physical base backup plus WAL
archive for point-in-time recovery. A typical logical command shape is:

```powershell
pg_dump --format=custom --compress=zstd:6 --no-owner --no-privileges --file=<encrypted-staging-path> commerce_ops
```

Immediately calculate SHA-256, encrypt or verify storage-side encryption, upload to the approved
restricted destination, and record size, digest, PostgreSQL version, start/end time, retention class,
and operator. Never commit the backup or its credentials to Git.

The backup policy becomes machine-verifiable only when an approved
`config/postgresql-backup-policy.json` records `encryptionEnabled: true` and a positive
`retentionDays` value.

## 4. Restore rehearsal

After separate approval:

1. Resolve a unique database name such as `commerce_ops_restore_rehearsal_YYYYMMDDHHMM`.
2. Fail if that name equals the production, Shadow, migration-test, system, or template database.
3. Create it with the approved restore owner and no application traffic.
4. Restore with `pg_restore --exit-on-error --single-transaction` where the artifact permits.
5. Validate database identity, schema/table/view counts, migration hashes, row counts, foreign keys,
   indexes, JSON/timestamps, repository read contracts, and selected full-row digests.
6. Measure backup, restore, validation, and recovery-point times against the approved RPO/RTO.
7. Write `docs/reports/COMMERCE-OPS-POSTGRESQL-RESTORE-REHEARSAL-<timestamp>.json` with `status:
   "PASS"` only when every gate passes.
8. Retain or remove the restore database according to the explicit approval; cleanup is a separate
   destructive action.

## 5. Monitoring contract

The production environment needs alerts and dashboards for:

- connection and pool saturation;
- long transactions, blocked sessions, deadlocks, and lock wait time;
- replication lag, WAL generation, archive age/failures, and recovery health;
- database/WAL/disk growth and remaining capacity;
- backup age, backup failures, restore-test age, and retention failures;
- slow queries, query latency percentiles, temporary files, and I/O time;
- autovacuum health, table/index bloat, checkpoints, and cache efficiency.

The checker recognizes an approved `config/postgresql-monitoring.json` only when connection pool,
locks, replication, disk, and slow-query coverage are all explicitly enabled. A configuration file
does not replace evidence that alerts reach the responsible operator.

## 6. Capacity baseline

Run the Phase 3B write/read contracts and production-like read workloads against staging with the
application role. Capture p50/p95/p99 latency, throughput, pool utilization, lock waits, WAL volume,
database growth, temporary files, CPU, memory, and disk I/O. Add indexes only when query plans and
measurements prove the need.

Record a passing result as
`docs/reports/COMMERCE-OPS-POSTGRESQL-CAPACITY-BASELINE-<timestamp>.json`. The baseline must include
the tested schema checksum, dataset size, workload version, hardware/service tier, and approval.

## 7. Exit gate

Phase 3C exits only when `npm run postgres:phase3c:readiness` reports 21/21 PASS and the backup,
restore, monitoring, and capacity evidence correspond to the same production candidate. Even then,
`is_switch_ready` remains false until the Phase 3D timed cutover/rollback rehearsal and separate final
approval succeed.
