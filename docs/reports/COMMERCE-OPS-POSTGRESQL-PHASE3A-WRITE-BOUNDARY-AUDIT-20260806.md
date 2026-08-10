# Commerce Ops PostgreSQL Phase 3A Write Boundary Audit

Date: 2026-08-06  
Status: **AUDIT COMPLETE - IMPLEMENTATION NOT YET VERIFIED**  
Production provider: `sqlite`  
PostgreSQL target: `commerce_ops_shadow.app`

## 1. Safety boundary

- Production SQLite remains the only production source of truth.
- This phase must not switch the production provider, delete SQLite, migrate binary assets, enable
  real fulfillment, or enable automatic price execution.
- The Shadow database is a validation target. A separate writable PostgreSQL test database is used
  for write-contract tests.
- Existing business output, scheduling semantics, audit redaction, task idempotency, file paths,
  fulfillment gates, and price-control gates must remain unchanged.

## 2. Executive summary

Phase 2 implemented provider-neutral Product, Sales, Inventory, Foundation Task, Audit-read, and
Agent-read repositories, but the main server still starts through `openCommerceDataAccess`, which
always owns a `SqliteProvider`. The remaining write risk is concentrated in four boundaries:

1. the legacy Mabang scheduler/account/DingTalk/export-run repository;
2. operation audit writes whose public service contract is still synchronous;
3. export/file-lifecycle/file-review metadata repositories;
4. the independent Fulfillment service, which owns `storage/mabang-fulfillment.sqlite` directly.

Price Control is already mostly provider-aware, but still contains SQLite schema introspection and
`INSERT OR IGNORE`. Foundation tasks and Agent observability are already asynchronous; Agent Run and
Tool Invocation persistence depends on the Audit boundary being made reliably asynchronous.

## 3. Boundary inventory

| Module | Current database dependency | Write path | Provider status | Phase 3A action |
| --- | --- | --- | --- | --- |
| Scheduler | `SchedulerDatabase` owns a synchronous SQLite connection and migrations | account, DingTalk config, scheduled task, run, run event, filter cache, lease, export metadata | Not provider-neutral | Add an async provider repository and move scheduler/server callers to awaited methods |
| Legacy task system | Stored with Scheduler in `scheduled_export_tasks`, `scheduled_export_runs`, and events | create/claim/update/retry/recover | Not provider-neutral | Keep existing state machine and idempotency; port SQL and transactions |
| Foundation task system | `FoundationRepository` uses the database provider and portable SQL | task, task event, task lease | Provider-neutral | Re-run writable SQLite/PostgreSQL contract tests; no business change |
| Audit | Runtime composition selects `SqliteAuditRepository`; `OperationAuditService` assumes sync results | operation event, Agent Run, Tool Invocation, Gateway and evaluation traces | Repository exists for both providers, service contract incomplete | Use `ProviderAuditRepository`; make service and callers await writes and reads |
| Export file metadata | `ExportFileRepository` calls `provider.connection.prepare()` | register, status, expiry, integrity | SQLite-bound | Port to async provider SQL; keep relative-path contract |
| File lifecycle | Lifecycle and review repositories call SQLite `prepare()` directly | scans, items, protection, managed files, quarantine records | SQLite-bound | Port metadata repositories and service callers to async provider methods |
| File bytes | Services call the local filesystem directly; Storage Provider contract exists but is not wired | local put/read/stat/move/remove | Local-only behavior | Wire `LocalStorageProvider` at the file boundary; do not configure MinIO |
| Price Control | Repository accepts a provider, but uses `PRAGMA table_info` and `INSERT OR IGNORE` | sync run, batch, snapshot, current price, change event, automation settings | Partially provider-neutral | Replace dialect-specific SQL; await audit and notification reads; preserve execution gates |
| Fulfillment | `FulfillmentRepository` imports `DatabaseSync` and creates a separate SQLite database | preview, batch, batch order, idempotency, recovery, tracking, audit-like events | Independent SQLite boundary | Introduce an async provider repository and provider factory; preserve separate bounded schema and real-submit gate |
| Agent Runtime/Monitoring | Provider-aware Context/Foundation repositories; observability writes are Audit events | Agent Run, Tool Invocation, Gateway, evaluation | Read path neutral; write depends on Audit | Verify complete trace after Audit conversion |

## 4. Direct SQLite ownership found

Production runtime driver ownership is limited to:

- `lib/data/sqlite/sqlite-provider.mjs`, the approved SQLite provider implementation;
- `lib/data/sqlite/sqlite-scheduler-repository.mjs`, the legacy scheduler boundary;
- `fulfillment-service/repository.mjs`, the independent Fulfillment boundary;
- `integrations/mabang-getdata/mabang_publisher.py`, a bounded Python publishing integration.

Read-only migration, readiness, Doctor, and test utilities also open SQLite intentionally. They are
not application write paths and are not removed in Phase 3A. The Python publisher remains an
explicit external integration dependency and must be included in final cutover readiness even
though it is outside the six requested business boundaries.

## 5. Existing reusable foundation

- `DatabaseProvider`, `SqliteProvider`, and `PostgresqlProvider` expose async query, execute, and
  transaction contracts.
- `PortableRepositoryExecutor` rewrites question-mark placeholders safely for PostgreSQL.
- `RepositorySql` qualifies PostgreSQL relations under `app` and provides dialect-aware helpers.
- `ProviderRecordRepository` and the compatibility table map already cover Scheduler, export,
  lifecycle, review, audit, filter-cache, and lease tables.
- `LocalStorageProvider` and `MinioStorageProvider` exist. Only Local is allowed in this phase.
- The Shadow schema already contains the main Commerce Ops tables. Fulfillment uses a separate
  database today and therefore requires an explicitly bounded schema/provider decision.

## 6. Implementation plan

### 6.1 Scheduler and legacy tasks

Create one async Scheduler repository over `DatabaseProvider`. Preserve the current method names and
serialized DTOs. Update the scheduler service, executor, HTTP API, account/image callbacks, and
Price Control notification lookup to await it. SQLite migration ownership remains in the SQLite
startup path; PostgreSQL startup only checks the already-versioned schema.

### 6.2 Audit and Agent observability

Use `ProviderAuditRepository` for both dialects. Convert `OperationAuditService` to a fully async
contract and await audit calls at business boundaries. A failed audit write remains non-fatal, but
must be logged and must never create an unhandled rejection.

### 6.3 Files and storage

Port metadata repositories to async provider SQL and transactions. Route file-byte operations
through `LocalStorageProvider` or a local storage facade while preserving current roots, hashes,
atomic moves, quarantine layout, and API responses. MinIO remains design-only.

### 6.4 Price Control

Replace `PRAGMA` with provider schema metadata and `INSERT OR IGNORE` with standard conflict SQL.
Keep manual sync, baseline, notification, and automatic execution gates exactly as configured.

### 6.5 Fulfillment

Keep Fulfillment bounded from the core Commerce Ops schema. Introduce an async provider factory and
portable repository contract for its tables, then convert service/server/scheduler calls to await
repository operations. PostgreSQL writes are rehearsed only in an isolated test schema/database.
`FULFILLMENT_REAL_SUBMIT_ENABLED` remains unchanged and false in validation.

## 7. Verification gates

The phase is not complete until all of the following pass:

- SQLite runtime startup and scheduler smoke;
- PostgreSQL Shadow read startup plus isolated PostgreSQL write contracts;
- Scheduler task/create/claim/recovery/idempotency tests;
- Audit, Agent Runtime, Agent Monitoring, and Daily Report tests;
- file metadata/lifecycle/review and LocalStorage tests;
- Fulfillment preview/recovery tests with real submit disabled;
- Price Control tests with automatic execution disabled;
- full test suite, Vue build, and Doctor.

## 8. Initial readiness decision

`is_switch_ready` remains **false** at audit completion. The reasons are executable code boundaries,
not missing business data: legacy Scheduler, file metadata/lifecycle, synchronous Audit semantics,
and the independent Fulfillment SQLite database must first pass dual-provider write contracts.

