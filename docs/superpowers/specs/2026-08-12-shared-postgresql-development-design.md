# Shared PostgreSQL Development Design

## Objective

Make the PostgreSQL database on host C (`10.110.80.117:5432`, database `commerce_ops`, schema `app`) the shared development database for every Commerce Ops developer. Schema changes are versioned in Git and applied once; business data is shared immediately through PostgreSQL. Only one designated machine may run schedulers or external side effects.

## Current State

- The main runtime is configured with `DATABASE_PROVIDER=sqlite` and opens `storage/commerce-ops.sqlite`.
- `openCommerceDataAccess` constructs `SqliteProvider` and `SchedulerDatabase` directly, so changing the environment variable alone does not switch the application.
- A PostgreSQL provider and SQLite-to-PostgreSQL conversion tooling exist, but the production repository path is incomplete.
- The repository contains SQLite migrations through the current application schema. The generated PostgreSQL F3 schema is historical and cannot be treated as the complete current migration chain.
- PostgreSQL already has `scheduler_leases`, `foundation_task_leases`, run idempotency constraints, and `schema_migrations`; these are useful multi-instance primitives.

## Selected Approach

Use one shared development PostgreSQL database and one designated side-effect executor.

Rejected alternatives:

- Per-developer schemas isolate work but do not provide live shared data.
- Periodic SQLite file exchange creates divergent histories, unsafe write conflicts, and platform-specific file locking.
- Allowing every application instance to run background work risks duplicate exports, notifications, and third-party API calls even when database uniqueness constraints catch some duplicates.

## Architecture

### Data-access seam

`openCommerceDataAccess(config)` remains the only runtime-facing interface for opening Commerce Ops persistence. It becomes a deep module that selects one of two adapters:

- SQLite adapter for tests, rollback, and explicitly isolated local work.
- PostgreSQL adapter for shared development.

Callers must not know connection-pool details, SQL placeholder syntax, TLS configuration, or schema search paths. Repository interfaces remain domain-oriented. Because PostgreSQL I/O is asynchronous, repository interfaces used by the runtime become asynchronous consistently; callers must await them. A thin provider swap beneath synchronous SQLite repositories is explicitly forbidden.

### Configuration

Shared-development configuration uses:

```text
DATABASE_PROVIDER=postgres
POSTGRES_HOST=10.110.80.117
POSTGRES_PORT=5432
POSTGRES_DATABASE=commerce_ops
POSTGRES_SCHEMA=app
POSTGRES_APP_USER=commerce_app
POSTGRES_SSLMODE=verify-full
POSTGRES_SSLROOTCERT=C:/CommerceOps/certs/commerce-ops-postgresql-ca.crt
POSTGRES_CHANNEL_BINDING=require
EXTERNAL_TASKS_ENABLED=false|true
```

`POSTGRES_APP_PASSWORD` remains in a Git-ignored local environment file or secret manager. It is never logged or committed. Admin and migrator credentials are not required for ordinary application startup.

TLS startup must fail closed if the CA file is missing, `verify-full` is not selected, or channel binding cannot be required by the installed client driver. No fallback to plaintext is permitted.

### Schema ownership and migrations

PostgreSQL-specific, append-only migration files are the authoritative shared schema history. Each migration runs transactionally under `commerce_migrator`, records its version and checksum in `app.schema_migrations`, and acquires a PostgreSQL advisory lock so two developers cannot migrate concurrently.

Ordinary application startup uses `commerce_app` and validates that the database schema is at the expected version. It never performs DDL. Navicat is for inspection and ad-hoc development queries, not manual shared-schema changes.

Existing business tables do not need duplicates solely for collaboration. New concurrency columns are added only where a demonstrated lost-update case requires optimistic concurrency. Current lease and idempotency tables remain the first-line protection for background work.

### Side-effect ownership

Every developer may run the Web/API process. Exactly one designated machine sets `EXTERNAL_TASKS_ENABLED=true`; all other machines set it to `false`.

When false, startup must not create scheduler loops, Mabang exports, DingTalk notifications, automated collection jobs, or other external side effects. Manual pure database CRUD remains available. The designated executor must still acquire existing database leases, so an accidental second executor fails to become active rather than duplicating work.

### Files

PostgreSQL shares metadata, not local files. Paths such as exports, uploads, generated images, and quarantine files are currently local-machine paths or relative keys. Features that require the underlying file must either use a shared file root with identical relative paths or clearly report that the file is unavailable on the current developer machine. This database switch must not pretend that database synchronization also synchronizes files.

## Data Flow

1. A developer starts the application with `DATABASE_PROVIDER=postgres`.
2. Configuration validation loads the CA, constructs a TLS-verifying `pg` pool, and requires channel binding.
3. Startup checks database identity, current user, schema version, and `search_path` before serving requests.
4. Requests call domain repositories through the data-access seam.
5. PostgreSQL repositories use parameterized SQL and transactions; all application instances observe committed data.
6. Only the designated executor starts background loops, and it must hold the relevant database lease before performing side effects.

## Error Handling

- Wrong host, database, user, schema, TLS mode, CA, or schema version is a startup error.
- Authentication errors are redacted and must not include passwords or full connection strings.
- Pool exhaustion and statement timeout errors receive stable internal codes and bounded user-facing messages.
- A disabled side-effect runner reports `disabled_by_configuration`, not a false healthy/running state.
- Migration checksum drift, a dirty migration state, or an unavailable advisory lock blocks migration.
- SQLite remains opt-in; PostgreSQL failure must never silently fall back to SQLite.

## Rollout

1. Preserve a consistent read-only backup of B's SQLite databases and file manifest.
2. Implement and test secure PostgreSQL runtime configuration.
3. Establish current PostgreSQL migration parity with the current SQLite schema.
4. Implement PostgreSQL repositories in vertical slices and run SQLite/PostgreSQL contract tests for each slice.
5. Connect a non-executor B instance with external tasks disabled and perform read-only smoke tests.
6. Perform controlled shared-development CRUD and concurrency tests.
7. Enable external tasks on exactly one designated machine and verify lease ownership.
8. Keep SQLite selectable for isolated tests and rollback; do not dual-write.

## Testing

- Unit tests for provider selection, TLS/CA validation, channel-binding configuration, redaction, and side-effect gating.
- Repository contract tests run against both SQLite and an isolated PostgreSQL test database.
- Migration tests apply every PostgreSQL migration from an empty database and verify checksums, constraints, indexes, and idempotent refusal of drift.
- Integration tests start two application instances against the same test database and verify immediate data visibility.
- Multi-instance tests prove only one executor holds scheduler leases and only one scheduled run exists for a task/time pair.
- Failure tests prove there is no plaintext or SQLite fallback.

## Acceptance Criteria

- B and another developer machine can create, update, and read the same development record without manual synchronization.
- The application connects as `commerce_app` to `commerce_ops.app` using verified TLS and required channel binding.
- Application startup cannot execute DDL with the app role.
- Schema version and migration checksum are consistent across all developers.
- Non-designated machines do not start external side effects.
- Two mistakenly enabled executors cannot perform the same leased task concurrently.
- Existing SQLite tests and rollback mode remain available.
- No credential, private key, or complete connection string enters Git or logs.

## Out of Scope

- Synchronizing local file contents through PostgreSQL.
- Production high availability or public network exposure.
- Automatic conflict-free merging of simultaneous edits to the same field.
- Dual writes between SQLite and PostgreSQL.
