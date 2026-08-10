# Commerce Ops PostgreSQL Production Readiness Checklist

Date: 2026-08-06  
Scope: Production Infrastructure Hardening, pre-Phase 3D  
Production database provider: `sqlite` (unchanged)  
PostgreSQL target: PostgreSQL 18.4 candidate and independent `commerce_ops_staging`  
Status: **21/21 PASS; blocked=0; `is_switch_ready=false`**

## Safety outcome

- SQLite production was not modified and `DATABASE_PROVIDER` was not switched.
- The running Daily Report Agent and Agent Runtime were not reconfigured.
- No business Agent was added or changed.
- Formal SQLite HTTP health remains `{"ok":true}` and SQLite integrity is `ok`.
- The PostgreSQL hardening scripts require exact target confirmations and retain recoverable
  configuration snapshots.

## Nine-item checklist

| # | Gate | Current status | Configuration | Verification | BLOCKED cleared? |
|---|---|---|---|---|---|
| 1 | PostgreSQL TLS | `PASS` | RSA-3072 private CA and server certificate covering `localhost`, host name, `127.0.0.1`, and `::1`; TLS minimum 1.2; loopback HBA requires `hostssl`; Node `pg` validates the CA with `rejectUnauthorized=true`. | A verified application connection negotiated TLS 1.3 using `TLS_AES_256_GCM_SHA384` at 256 bits. `pg_stat_ssl` and all four loopback `pg_hba_file_rules` passed. | **Yes** |
| 2 | WAL archive | `PASS` | `wal_level=replica`, `archive_mode=on`, and an AES-256-GCM `archive_command` write to an ACL-protected archive directory. The encryption key is stored separately and a matching restore command is provided. | `pg_switch_wal()` archived segment `00000001000000050000004C`; `pg_stat_archiver` recorded one success and zero failures. The artifact header, GCM decryption, and SHA-256 comparison with the live segment passed. | **Yes** |
| 3 | Slow-query log | `PASS` | Logging collector, daily rotation, bounded line prefix, and `log_min_duration_statement=500`. | A marked 550 ms statement was found with its duration in `postgresql-2026-08-06.log`. | **Yes** |
| 4 | `track_io_timing` | `PASS` | `track_io_timing=on`. | `pg_settings` passed; monitoring returned nonzero `blk_read_time` after restart. | **Yes** |
| 5 | `pg_stat_statements` | `PASS` | Extension installed in `public` for `commerce_ops` and `commerce_ops_staging`; `shared_preload_libraries=pg_stat_statements`, `compute_query_id=on`, `max=10000`, and `track=all`. | No pending restart remained, both extension locations passed, six candidate statements were tracked, and the production monitor returned query statistics. | **Yes** |
| 6 | Encrypted backup | `PASS` | Custom-format `pg_dump` with zstd level 6, AES-256-GCM envelope encryption, SHA-256, separate ACL-protected key storage, no retained plaintext, and 30-day exact-prefix retention. Infrastructure extensions are excluded from the business dump. | A 104,975,086-byte staging backup passed encryption and digest verification. Policy is machine-verifiable in `config/postgresql-backup-policy.json`. | **Yes** |
| 7 | Automatic recovery verification | `PASS` | The verifier selects the latest eligible encrypted manifest, validates the digest, decrypts to a transient file, restores into an exact-prefix isolated database, validates it, writes a JSON report, and always removes the temporary database and plaintext. Weekly production schedule and RPO/RTO are defined in policy. | Restore passed in 111.092 seconds against a 3,600-second RTO: 112/5/6 relations, six migration hashes, seven business counts, zero invalid foreign keys, and zero invalid indexes. | **Yes** |
| 8 | PostgreSQL monitoring | `PASS` | A least-privilege `commerce_monitor` login inherits `pg_monitor`. The collector covers connections, pool saturation, blocked/long transactions, locks, archiver, database/WAL/disk growth, backup/restore age, slow queries, I/O timing, temp files, deadlocks, and checkpointer statistics. | Post-restart monitor status is `PASS` with no alerts, 3% connection use, zero blocked sessions/lock waits/archive failures, and 41.887% free disk. | **Yes** |
| 9 | Capacity baseline | `PASS` | An isolated staging table is created by the migrator, DML is executed only by `commerce_staging_app`, and the table is dropped by the migrator. Thresholds cover throughput, p95, errors, locks, disk, and connections. | 8 clients for 20.023 seconds: 195,964 operations, 9,787.127 ops/s, p50 2.253 ms, p95 6.488 ms, p99 10.731 ms, zero errors, zero lock waits, 3% connection use, and 41.887% free disk. | **Yes** |

## Blockers

There are no remaining Phase 3C infrastructure blocker IDs:

```text
passed=21
blocked=0
blockerIds=[]
```

The first Administrator PowerShell attempt exposed a Windows-specific validation issue:
PostgreSQL rejects direct `postgres.exe -C` execution by an elevated account. The script now
validates the staged configuration through the running server's read-only `pg_file_settings` view.
The temporary HBA state from the failed attempt was restored before retry, and the successful retry
completed the Windows service restart without changing SQLite or the production provider.

## Verification evidence

- Hardening verification:
  `COMMERCE-OPS-POSTGRESQL-HARDENING-VERIFICATION-20260806111356.json`
- Restore verification:
  `COMMERCE-OPS-POSTGRESQL-RESTORE-REHEARSAL-20260806091933.json`
- Capacity baseline:
  `COMMERCE-OPS-POSTGRESQL-CAPACITY-BASELINE-20260806092800.json`
- Formal readiness: `21/21 PASS`, `blocked=0`, `isSwitchReady=false`.
- PostgreSQL-focused regression: 16/16 PASS.
- Full repository regression before the restart-only change: 954/954 PASS.
- Build: PASS.
- Doctor: PASS; only expected occupied-port warnings.
- SQLite integrity: `ok`.
- Formal SQLite HTTP health: `{"ok":true}`.

## Phase 3D assessment

**The infrastructure prerequisites to enter Phase 3D are satisfied.** This does not authorize a
production switch. `is_switch_ready` intentionally remains false until a timed Phase 3D cutover and
rollback rehearsal succeeds and a separate explicit final approval is recorded. Continue serving
production from SQLite until those two conditions are met.

