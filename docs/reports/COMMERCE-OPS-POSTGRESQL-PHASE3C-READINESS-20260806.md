# Commerce Ops PostgreSQL Phase 3C Readiness Report

Date: 2026-08-06  
Staging rehearsal: **PASS**  
Production readiness: **NOT READY — 9 production gates remain open**  
Contract: `COMMERCE-OPS-PG-PHASE3C-STAGING-1.0.0`  
Staging database: `commerce_ops_staging`  
Application role: `commerce_staging_app`  
Production provider: `sqlite`  
Production `is_switch_ready`: **false**

## 1. Outcome

Phase 3C completed the requested production-like rehearsal against an independent PostgreSQL
staging database. The application-role permission boundary, seven write domains, delete policies,
final synchronization, process-scoped provider switch, real service startup, health check,
encrypted logical backup, independent restore, monitoring snapshot, and local capacity sample all
passed.

This result does **not** authorize or perform a formal production switch. The current PostgreSQL
server is a loopback development instance, and the formal 21-check production audit still reports
12 PASS / 9 BLOCKED. Local staging evidence is deliberately not promoted to production evidence.

## 2. Safety and isolation

| Boundary | Evidence | Result |
| --- | --- | --- |
| Formal provider | `DATABASE_PROVIDER=sqlite`; existing service on port `3101` returned `{"ok":true}` after the rehearsal | PASS |
| Staging database | `commerce_ops_staging`, OID `374323`, approximately 1.54 GB | PASS |
| Phase 3B template | `commerce_ops_migration_test`, OID `16391` | unchanged |
| Shadow | `commerce_ops_shadow`, OID `294907` | not connected to or modified by the Phase 3C runner |
| PostgreSQL candidate | `commerce_ops`, OID `16390` | not used as the rehearsal write target |
| External systems | AI, delivery, fulfillment, price actions, and external service calls: `0` | PASS |
| Credentials | staging password stored only in ignored `.env.postgres.staging.local`; never printed or written to the report | PASS |

The staging database was cloned from the completed Phase 3B **schema-only migration-test** database,
then all staging application/AI/control rows were cleared before loading a new read-only SQLite
online-backup snapshot. Shadow was not used as a template or data source.

## 3. Independent staging and synchronization

| Check | Evidence | Result |
| --- | --- | --- |
| Schema objects | `app`: 112 tables / 15 views; `ai_shadow`: 5 tables; `shadow_meta`: 6 tables | PASS |
| Versioned migrations | `001` through `006`, all recorded checksums retained | PASS |
| Initial load | 47 dependency-closed tables; 1,325,642 rows inserted; 0 errors | PASS |
| Initial validation | 47 tables, 0 count differences, 42 deterministic samples, 0 failures | PASS |
| Final SQLite snapshot | integrity `ok`; 0 FK violations; SHA-256 `3ee4426519edd934b922be7d4b3e667d77fbdefc42dfcde39a2e87ae4e3becd0` | PASS |
| Final incremental sync | 255,179 examined; 6 inserted; 221,409 overlap UPSERTs; 33,764 digest-skipped | PASS |
| Target-only detection | 1,325,650 source keys examined; 0 candidates; 0 deletes | PASS |
| Final validation | 47 tables, 0 count differences, 42 samples, 0 failures, 0 business-count failures | PASS |
| Migration state | `stage=READY`, `last_validation_status=PASS`, database flag remains `is_switch_ready=false` | PASS |

Final business counts matched exactly:

| Domain relation | SQLite | PostgreSQL staging |
| --- | ---: | ---: |
| Product SKUs | 18,347 | 18,347 |
| Order headers | 80,140 | 80,140 |
| Order lines | 116,293 | 116,293 |
| Inventory snapshots | 81,703 | 81,703 |
| Foundation tasks | 376 | 376 |
| Audit events | 42,258 | 42,258 |

The source remained online during the rehearsal. The difference between the initial 1,325,642 and
final 1,325,650 scoped rows demonstrates that the final incremental pass captured concurrent SQLite
activity without the Phase 3C runner writing to SQLite.

## 4. Application role

The dedicated `commerce_staging_app` role connected successfully with writable transactions and
the `app` search path. It has no superuser, database-create, role-create, replication, bypass-RLS,
database CREATE/TEMPORARY, schema CREATE, relation ownership, or inherited role membership.

| Forbidden operation | SQLSTATE | Result |
| --- | --- | --- |
| `CREATE TABLE` in `app` | `42501` | DENIED |
| `ALTER TABLE` in `app` | `42501` | DENIED |
| `DROP TABLE` in `app` | `42501` | DENIED |

The role retains only the required `USAGE`, DML, and sequence permissions in `app` and `ai_shadow`.
It has no access to the migration-control schema.

## 5. Full-chain write validation

All writes were executed through `commerce_staging_app`, read back from PostgreSQL, and cleaned up
after validation.

| Domain | PostgreSQL evidence | Result |
| --- | --- | --- |
| Product | `app.product_detail_preferences` | PASS |
| Sales | `app.growth_order_headers` | PASS |
| Inventory | `app.growth_inventory_snapshots` | PASS |
| Task | `app.foundation_tasks` plus task event | PASS |
| Audit | `app.operation_audit_events` | PASS |
| Agent Run | audit lifecycle plus `ai_shadow.agent_runs` projection | PASS |
| Tool Invocation | audit event plus `ai_shadow.tool_invocations` projection | PASS |

No external AI, marketplace, delivery, fulfillment, or price-change action was invoked.

## 6. DELETE and soft-delete policy

| Domain | Confirmed behavior | Result |
| --- | --- | --- |
| Product | soft-delete metadata, row retained, restore, exact source-field restoration | PASS |
| Scheduled task configuration | soft-delete disables/hides the row, then restore | PASS |
| Foundation task fixture | child events removed before controlled fixture cleanup | PASS |
| Sales | immutable imported fixture uses controlled hard delete | PASS |
| Inventory | immutable imported fixture uses controlled hard delete | PASS |
| Audit | retention-controlled hard delete | PASS |
| Agent Run / Tool Invocation | hard delete of run cascades to tool invocation | PASS |
| Final reconciliation | DETECT only, child-first, 0 target-only candidates, no bulk delete applied | PASS |

Two staging-only `file.temp.cleanup` audit rows created by failed service-start attempts were
inspected and removed by exact ID before the successful final synchronization. They were rehearsal
artifacts, not SQLite or Shadow records.

## 7. Production-switch dry run

The dry run followed the requested order:

1. A new SQLite online-backup snapshot was taken and final incremental sync completed.
2. Only a child process received `DATABASE_PROVIDER=postgres`, the exact staging database
   confirmation, and staging application credentials.
3. `server.mjs` started using `commerce_staging_app` on a dynamically allocated loopback port.
4. `GET /api/health` returned HTTP 200 with `{"ok":true}`.
5. The child process was stopped. Persistent environment configuration was never changed.
6. The existing formal SQLite service on port `3101` remained healthy.

The first startup attempt also proved the port-safety boundary: `.env` supplied `APP_PORT=3101`,
which was already occupied by the formal service. The runner was corrected to override both
`APP_PORT` and `PORT` inside the staging child process; it never stopped the existing listener.

## 8. Backup, restore, monitoring, and capacity rehearsal

| Evidence | Result | Production limitation |
| --- | --- | --- |
| `pg_dump` custom backup, AES-256-GCM encrypted, 131,163,867 bytes, plaintext removed | SIMULATION PASS | local key and encrypted artifact are co-located; no KMS or object lock |
| Independent restore to `commerce_ops_staging_restore_20260806` | SIMULATION PASS | loopback instance, not the production backup destination |
| Restore validation: 112/5/6 tables, six migration checksums, business counts | PASS | production restore RTO/RPO is not approved |
| Monitoring snapshot: database stats, activity, locks, disk, settings | SIMULATION PASS | no production dashboards, alert routing, or SLO ownership |
| Capacity: staging database ~1.54 GB; 30 simple queries and 20 product-count queries | SIMULATION PASS | single-client loopback test, not production concurrency/load |

Latency snapshot:

| Query | Samples | Median | p95 | Maximum |
| --- | ---: | ---: | ---: | ---: |
| `SELECT 1` | 30 | 0.060 ms | 0.190 ms | 508.553 ms cold/outlier |
| Product count | 20 | 0.811 ms | 1.292 ms | 110.280 ms cold/outlier |

The encrypted artifact and key are under ignored
`tmp/postgresql-phase3c/operations/backup/`. They are staging evidence only and must not be used as
a production backup design.

## 9. Nine production-gate statuses

The formal checker still reports all nine as production blockers. Four now have local staging
evidence, but local simulation is intentionally insufficient to mark a production gate PASS.

| Gate | Staging evidence | Production status | Required closure |
| --- | --- | --- | --- |
| TLS | server `ssl=off`; client SSL false | **BLOCKED** | approved server certificate/CA, encrypted connections, verified client trust |
| WAL archiving | `archive_mode=off`; no archive command | **BLOCKED** | encrypted durable WAL archive, retention, failure alerting, recovery proof |
| Slow-query logging | `log_min_duration_statement=-1` | **BLOCKED** | approved bounded threshold, initially 500–1000 ms |
| I/O timing | `track_io_timing=off` | **BLOCKED** | enable timing or approved managed-service equivalent |
| Query statistics | `pg_stat_statements` not installed/preloaded | **BLOCKED** | preload, restart, create extension, verify collection |
| Encrypted backup | local AES-256-GCM backup restored successfully | **SIMULATION PASS / PRODUCTION BLOCKED** | off-host encrypted storage, KMS separation, retention and immutability |
| Restore rehearsal | independent local restore and count/schema parity | **SIMULATION PASS / PRODUCTION BLOCKED** | production-like destination, measured RTO/RPO, accountable sign-off |
| Monitoring | live stats/locks/activity snapshot captured | **SIMULATION PASS / PRODUCTION BLOCKED** | dashboards, thresholds, alert routing, runbook owner and test alert |
| Capacity baseline | loopback latency/storage sample captured | **SIMULATION PASS / PRODUCTION BLOCKED** | production-shape concurrency/load test and headroom approval |

Formal checker result: **12/21 PASS, 9/21 BLOCKED**.

## 10. Blocking items and `is_switch_ready`

`is_switch_ready` remains **false** in both the formal assessment and the staging migration-control
record. The blockers are the nine gates above plus the absence of a separately approved timed
production cutover/rollback exercise.

The staging rehearsal itself is complete. No evidence supports switching the formal provider yet.

## 11. Formal cutover recommendation

**Recommendation: do not switch production.**

Before requesting formal cutover approval:

1. Provision the actual production PostgreSQL environment and close TLS, WAL archive, slow-query,
   I/O timing, and `pg_stat_statements` gates there.
2. Move backup encryption keys out of the backup location, use durable off-host/object-locked
   storage, and approve retention ownership.
3. Repeat restore, monitoring alert, and capacity/load rehearsals on production-shaped
   infrastructure with measured RTO/RPO and headroom.
4. Rerun `npm run postgres:phase3c:readiness` until all 21 formal checks pass.
5. Schedule Phase 3D as a timed write-freeze/final-sync/provider-switch/rollback rehearsal with a
   separate explicit approval. Only after that review should `is_switch_ready=true` be considered.

## 12. Reproduction and evidence

```powershell
npm run postgres:phase3c:plan
npm run postgres:phase3c:rehearse -- --apply --confirm-database=commerce_ops_staging
npm run postgres:phase3c:operations -- --apply --confirm-database=commerce_ops_staging
npm run postgres:phase3c:readiness
```

Local machine-readable evidence:

- `tmp/postgresql-phase3c/staging-rehearsal-result.json`
- `tmp/postgresql-phase3c/operations/operations-rehearsal-result.json`
- encrypted backup and key under `tmp/postgresql-phase3c/operations/backup/`

The machine-readable evidence and secrets are ignored local artifacts. This Markdown report stores
no password, private key, row payload, PII, or external credential.
