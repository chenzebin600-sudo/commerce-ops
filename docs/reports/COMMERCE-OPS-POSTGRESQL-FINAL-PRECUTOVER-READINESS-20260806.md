# Commerce Ops PostgreSQL Final Pre-Cutover Readiness

Date: 2026-08-06  
Status: **READY FOR FINAL CONFIRMATION**  
Production provider: `sqlite`  
Formal candidate: `commerce_ops`  
Candidate control state: `READY/PASS`, `is_switch_ready=false`

## Outcome

All preparation that can safely be completed while SQLite remains production
has passed. The only remaining action is the explicitly approved maintenance
window: stop the exact SQLite writers, retain the final SQLite backup, perform
the final full-source refresh and zero-difference validation, create the final
encrypted PostgreSQL backup, mark the exact validated snapshot switch-ready,
persist the PostgreSQL provider configuration, and restart/validate the main
service and scheduler.

No persistent provider setting has been changed. The current SQLite main
service, scheduler, Daily Report Agent, and Agent Runtime remain on their
existing production path.

## Nine final gates

| # | Gate | Status | Evidence |
|---:|---|---|---|
| 1 | Production safety boundary | PASS | Persistent provider remains SQLite; no source mutation or external action was made by preparation. |
| 2 | Infrastructure hardening | PASS | Phase 3C passes 21/21 with TLS 1.3, encrypted WAL, slow-query evidence, I/O timing, `pg_stat_statements`, monitoring, capacity, backup and recovery. |
| 3 | Formal candidate identity | PASS | Exact PostgreSQL 18.4 database `commerce_ops`; no Shadow/staging reuse. |
| 4 | Complete source scope | PASS | Latest refresh covers 92/92 source tables, 15 views, 3,875,429 rows and 1,616 columns. |
| 5 | Row, key and digest parity | PASS | Every table count/full digest matches; source-only and target-only primary-key differences are zero. |
| 6 | Schema and relational integrity | PASS | 156 foreign keys validated, 319 indexes matched, 15 views matched, eight PostgreSQL migrations recorded. |
| 7 | Business and Agent validation | PASS | 10 business totals and 42 deterministic samples match; Product, Sales, Inventory, Task, Audit, Agent Run and Tool Invocation writes passed and cleaned up. |
| 8 | Runtime and role boundary | PASS | Production-mode main service health passed on `commerce_app`; application DML is allowed while CREATE/ALTER/DROP and ownership are denied. |
| 9 | Backup, restore and cutover orchestration | PASS | AES-256-GCM candidate backup and automated restore passed; guarded final-cutover plan identifies only the exact main/scheduler writers and has sufficient disk capacity. |

## Latest evidence

- Candidate refresh report:
  `COMMERCE-OPS-POSTGRESQL-PRODUCTION-CANDIDATE-20260806151113.json`
- Candidate encrypted backup:
  `commerce-ops-commerce_ops-20260806151154.dump.aes256gcm`
- Restore rehearsal:
  `COMMERCE-OPS-POSTGRESQL-RESTORE-REHEARSAL-20260806151326.json`
- Hardening verification:
  `COMMERCE-OPS-POSTGRESQL-HARDENING-VERIFICATION-20260806153758.json`
- Full regression: 1017/1017 tests passed.
- Production build: PASS.
- Doctor: SQLite integrity is `ok`; occupied main/advertising ports are expected
  because the production services remain online.

## Final preflight observed

- Exact project main writer: one process.
- Exact project scheduler writer: one process.
- Scheduled pending/running work: zero.
- Price Control, repricing, Foundation source, Growth analysis, image,
  lifecycle and known Agent-related active work: zero.
- Candidate running sync batches: zero.
- Candidate unsuccessful table states: zero.
- Free disk: 65,077,096,448 bytes.
- Required final-snapshot safety capacity: 9,182,636,704 bytes.

## Remaining blockers

There are no technical readiness blockers. Two intentional governance gates
remain:

1. The user must explicitly authorize the final writer freeze and provider
   switch. Until then `is_switch_ready` remains false.
2. PostgreSQL-to-SQLite reverse synchronization is not implemented. The
   retained SQLite backup is the pre-cutover recovery point; after new
   PostgreSQL-only business writes, a silent switch back to SQLite is unsafe.

## Guarded execution

Plan only:

```powershell
npm run postgres:production:cutover:plan
```

The apply command is intentionally protected by exact confirmation tokens and
must be executed only after the user gives the final confirmation. Any schema
drift, source-file change during freeze, row/key/digest difference, failed gate,
backup failure, or service-health failure stops the workflow and writes a
failure report.
