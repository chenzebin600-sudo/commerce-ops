# Commerce Ops PostgreSQL Provider Phase 2 Audit

Date: 2026-08-06

## Scope and safety boundary

- Production remains `DATABASE_PROVIDER=sqlite`.
- The formal SQLite database is read-only for this phase.
- PostgreSQL verification targets only the existing `commerce_ops_shadow` database.
- No production cutover, data deletion, MinIO work, or business-Agent work is included.

## Existing provider foundation

The repository already contains a provider contract and two drivers:

- `lib/data/database-provider.mjs`
- `lib/data/sqlite/sqlite-provider.mjs`
- `lib/data/postgresql/postgresql-provider.mjs`
- `lib/data/compatibility/*`

The F4 compatibility layer has already proved generic CRUD, transactions, constraint normalization,
JSON/boolean normalization, and placeholder selection against isolated SQLite and PostgreSQL test
databases. The production composition root does not use that abstraction yet.

## Direct SQLite construction

Production/runtime coupling:

| Location | Coupling | Phase 2 treatment |
| --- | --- | --- |
| `lib/data/data-access.mjs` | Always creates `SqliteProvider` | Replace selection with a guarded provider factory |
| `lib/data/sqlite/sqlite-scheduler-repository.mjs` | Uses `DatabaseSync.prepare/exec` and synchronous transactions | Keep as explicit legacy SQLite boundary; do not claim PostgreSQL support |
| `lib/data/sqlite/sqlite-audit-repository.mjs` | Synchronous SQLite-only audit CRUD | Add an async provider-backed audit repository for the Phase 2 domains |
| `lib/files/file-repository.mjs` | SQLite connection and prepared statements | Keep on the legacy provider in this phase |
| `lib/files/file-lifecycle-repository.mjs` | SQLite schema introspection and prepared statements | Keep on the legacy provider in this phase |
| `lib/files/file-review-repository.mjs` | SQLite prepared statements | Keep on the legacy provider in this phase |
| `fulfillment-service/repository.mjs` | Creates `node:sqlite` connection and owns schema changes | Out of scope; retain the independent SQLite service boundary |
| `lib/security/audit-service.mjs` | Falls back to `SqliteAuditRepository` and exposes a synchronous service contract | Preserve current production path; use provider audit directly in Shadow verification |

Read-only, migration, doctor, and rehearsal scripts also create SQLite connections intentionally.
They are infrastructure boundaries, not business repositories, and remain explicit.

## Repository coupling matrix

| Domain | Current repository | Status before Phase 2 | Main incompatibilities |
| --- | --- | --- | --- |
| Product | `ProductCatalogRepository` | Mostly provider-aware | Requires parity proof against Shadow data |
| Sales | `SalesAssortmentRepository` | SQLite SQL | `?` placeholders, unqualified tables, pagination placeholders |
| Inventory | `SalesAssortmentRepository` | SQLite SQL | Same repository and dialect issues as Sales |
| Task | `FoundationRepository` | Async but SQLite SQL | `sqlite_master`, `?`, unqualified tables, limit placeholders |
| Audit | `SqliteAuditRepository` / `AgentObservabilityRepository` | SQLite-only | sync prepared statements, `sqlite_master`, `json_extract`, `?` |
| AI Context | `AiContextRepository` | Provider-aware | Requires PostgreSQL function/return-type parity tests |
| Scheduler | `SqliteSchedulerRepository` | SQLite-only and synchronous | 50+ synchronous methods and SQLite migration ownership |
| Files | three file repositories | SQLite-only and synchronous | direct prepared statements and schema introspection |
| Price Control | `PriceControlRepository` | Async but SQLite SQL | hard-coded placeholders; not one of the first five repositories |

## SQL differences that require explicit handling

- Placeholder syntax: SQLite `?`; PostgreSQL `$1`, `$2`, ...
- Schema ownership: SQLite unqualified tables; Shadow PostgreSQL uses `app.<table>`.
- Metadata lookup: `sqlite_master` versus `information_schema.tables/views`.
- JSON filtering: SQLite `json_extract(...)`; PostgreSQL `jsonb ->>` or typed expressions.
- Pagination parameters and dynamic filter numbering.
- Boolean/number normalization and `NULL` handling.
- Date extraction must preserve current string-day semantics across both providers.
- UPSERT remains SQL-standard enough for current keys, but all placeholders and table names must be
  generated per provider.

## Critical architecture constraint

`node:sqlite` is synchronous while `pg` is asynchronous. A synchronous PostgreSQL facade would hide
blocking I/O and is rejected. The scheduler, file lifecycle, and legacy audit service therefore cannot
be declared PostgreSQL-compatible until their public call chains are migrated to async contracts.

Phase 2 uses a transparent transitional composition:

- the selected primary provider backs Product, Sales, Inventory, Task, Audit-read, Context, and Agent
  observability repositories;
- legacy scheduler/file repositories stay behind an explicit SQLite legacy provider;
- PostgreSQL mode is Shadow-only and requires an isolated SQLite legacy database, never the formal
  production file;
- the factory reports repository capability and fails closed when a PostgreSQL-only operation is not
  supported.

This avoids a false full-cutover claim while allowing the requested first repository batches and Agent
read paths to run against Shadow PostgreSQL.

## Required changes

1. Add a guarded `DatabaseProviderFactory` with normalized `sqlite` and `postgres` names.
2. Add shared repository SQL helpers for table qualification and placeholder allocation.
3. Adapt Product, Sales/Inventory, Foundation Task, and Agent Observability repositories.
4. Add a provider-backed async audit repository for parity and Shadow runtime use.
5. Add a Phase 2 repository bundle exposing stable Product/Sales/Inventory/Task/Audit interfaces.
6. Add SQLite/Shadow PostgreSQL read-only parity tests.
7. Add controlled startup probes for SQLite and Shadow PostgreSQL, including Context, Agent Runtime,
   monitoring queries, and Vue artifact availability.
8. Keep `server.mjs` on the existing SQLite composition until the remaining synchronous boundaries
   have their own approved migration phase.

## Production conclusion

Provider abstraction is feasible for the requested first five domains without changing business
semantics. A full `server.mjs` PostgreSQL cutover is not safe in this phase because the scheduler, file
lifecycle, price-control, and fulfillment boundaries are not yet provider-neutral. Production must
remain SQLite.
