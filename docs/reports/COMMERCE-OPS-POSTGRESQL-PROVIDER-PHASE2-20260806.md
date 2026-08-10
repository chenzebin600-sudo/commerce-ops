# Commerce Ops PostgreSQL Provider Abstraction Phase 2 Report

Date: 2026-08-06

## 1. Outcome

Phase 2 establishes a guarded provider-aware application domain for Product, Sales, Inventory,
Task, Audit, AI Context, and Agent Monitoring.

- Production remains `DATABASE_PROVIDER=sqlite`.
- The formal SQLite database remains the only production data source.
- PostgreSQL may be selected only with `DATABASE_PROVIDER=postgres` and
  `POSTGRES_SHADOW_MODE=true`.
- PostgreSQL selection is restricted to database `commerce_ops_shadow`, schema `app`, role
  `commerce_app`, and read-only transactions.
- No production database switch, formal migration, data deletion, business-rule change, image
  migration, MinIO work, or new business Agent was performed.

The legacy full-server composition is intentionally still SQLite-only. Phase 2 does not claim that
the scheduler, file lifecycle, price-control, or fulfillment write paths are PostgreSQL-ready.

## 2. Provider architecture

```text
DATABASE_PROVIDER
        |
        v
Database Provider Factory
        |
        +-- sqlite ------> SqliteProvider
        |
        +-- postgres ----> PostgresqlProvider
                            Shadow guard
                            commerce_ops_shadow only
                            app schema
                            read-only role/session
        |
        v
Provider Domain Data Access
        |
        +-- Product Repository
        +-- Sales Repository
        +-- Inventory Repository
        +-- Task Repository
        +-- Audit Repository
        +-- Context Repository
        +-- Agent Monitoring Repository
```

Business callers receive stable domain methods and do not receive driver connections. Provider SQL
helpers own table qualification, placeholders, metadata-catalog differences, and portable JSON
expressions. The portable executor rewrites SQLite placeholders without altering SQL literals,
comments, quoted identifiers, or PostgreSQL dollar-quoted blocks.

## 3. Modified and added files

### Provider and composition

- `lib/data/database-provider-factory.mjs`
- `lib/data/provider-domain-data-access.mjs`
- `lib/data/provider-domain-repositories.mjs`
- `lib/data/portable-repository-executor.mjs`
- `lib/data/repository-sql.mjs`
- `lib/data/sqlite/sqlite-provider.mjs`
- `lib/data/postgresql/postgresql-provider.mjs`

### Repositories

- `lib/data/repositories/product-catalog-repository.mjs`
- `lib/sales-assortment/sales-assortment-repository.mjs`
- `lib/foundation/foundation-repository.mjs`
- `lib/data/provider-audit-repository.mjs`
- `lib/ai/observability/agent-observability-repository.mjs`

### Verification and tests

- `scripts/postgresql-provider-phase2-check.mjs`
- `scripts/postgresql-provider-phase2-startup-check.mjs`
- `tests/database-provider-factory.test.mjs`
- `tests/repository-sql.test.mjs`
- `tests/portable-repository-executor.test.mjs`
- `tests/provider-domain-data-access.test.mjs`
- `tests/provider-domain-repositories.test.mjs`
- `package.json`

### Design and audit

- `docs/reports/COMMERCE-OPS-POSTGRESQL-PROVIDER-PHASE2-AUDIT-20260805.md`
- `docs/design/COMMERCE-OPS-POSTGRESQL-PROVIDER-PHASE2-PLAN.md`
- `docs/reports/COMMERCE-OPS-POSTGRESQL-PROVIDER-PHASE2-20260806.md`

## 4. Database changes

No database schema or data was changed by Phase 2.

- Formal SQLite latest migration: `024_price_control_automation.sql`.
- Formal SQLite Doctor integrity result: `ok`.
- PostgreSQL Shadow was queried using a read-only application role and a read-only session.
- The SQLite comparison source was the Phase 1 read-only snapshot, not the formal live file.
- No PostgreSQL migration was executed.
- No file assets were moved.

## 5. Dual-database parity

The same repository contracts were executed against the Phase 1 SQLite snapshot and PostgreSQL
Shadow. Results were normalized only for driver representation differences such as timestamp objects
and numeric aggregate strings.

| Domain | Compared result | Result |
| --- | ---: | --- |
| Product | 18,347 identities and core fields | PASS |
| Sales aggregates | 66,294 valid orders; 90,240 current lines | PASS |
| Sales primary keys | 79,768 order headers; 115,868 order lines | PASS |
| Inventory | 20,049 latest snapshot rows and primary keys | PASS |
| Task | 252 complete task identities and states | PASS |
| Audit | 42,031 complete audit identities; summaries and sample fields | PASS |
| Agent/Context | 2 Agent runs and 2 latest source batches | PASS |

Stable tie-breaking was added where SQLite and PostgreSQL legitimately order equal timestamps or
equal counts differently. Business values were not changed.

## 6. Startup verification

Two controlled, read-only startup probes passed:

| Check | SQLite snapshot | PostgreSQL Shadow |
| --- | --- | --- |
| Provider selection | PASS | PASS |
| Product/Sales/Inventory/Task/Audit repositories | PASS | PASS |
| Foundation readiness | PASS | PASS |
| Context Registry | 6 contexts | 6 contexts |
| Daily Report Agent registration | `sales.daily-report@2.1.0` | `sales.daily-report@2.1.0` |
| Agent Monitoring read | PASS | PASS |
| External AI/DingTalk calls | 0 | 0 |
| Database writes | 0 | 0 |

The probe verifies provider-aware application composition and Agent/Foundation read paths. It does
not start the mutating scheduler or send a real Daily Report because PostgreSQL remains Shadow-only.

## 7. Test and build results

- Full test suite: `905/905` passed, 0 failed, 0 skipped.
- Provider, repository, Sales/Inventory, Foundation, Daily Report, Runtime, Tool, and Monitoring
  targeted suites: passed.
- Full six-domain SQLite/PostgreSQL parity: passed.
- Vue TypeScript check and production build: passed.
- Frontend policy: Vue remains the only active frontend; three legacy workspaces remain frozen.
- Build verification: 16 active Vue entry assets; legacy fallback integrity checks passed.
- Doctor: all checks `OK`; only warnings were that the already-running main and advertising ports
  were occupied.

The first Vue build attempt encountered a transient Windows file lock while normalizing the generated
`index.html`. The deterministic post-processing step and the complete build both passed on retry; no
source change was needed.

## 8. Current support matrix

| Capability | SQLite | PostgreSQL Shadow | Production PostgreSQL |
| --- | --- | --- | --- |
| Product read repository | Supported | Supported | Not enabled |
| Sales read repository | Supported | Supported | Not enabled |
| Inventory read repository | Supported | Supported | Not enabled |
| Task read repository | Supported | Supported | Not enabled |
| Audit read repository | Supported | Supported | Not enabled |
| AI Context read | Supported | Supported | Not enabled |
| Agent Monitoring read | Supported | Supported | Not enabled |
| Scheduler mutation path | Supported | Deferred | Not enabled |
| File lifecycle path | Supported | Deferred | Not enabled |
| Synchronous audit service writes | Supported | Deferred | Not enabled |
| Price Control mutation path | Supported | Deferred | Not enabled |
| Fulfillment service | Independent SQLite | Deferred | Not enabled |

## 9. Remaining migration risks

1. `node:sqlite` repositories are synchronous while PostgreSQL is asynchronous. Scheduler, files,
   and the current audit-service public contracts must become async before full composition can
   select PostgreSQL.
2. The legacy `openCommerceDataAccess` composition owns migrations and several synchronous
   repositories. It remains the production SQLite boundary.
3. Price Control and fulfillment still contain provider-specific SQL or independent SQLite
   ownership.
4. PostgreSQL write behavior for these domains is intentionally unproven because the Shadow app role
   is read-only.
5. A production cutover needs an approved write rehearsal, rollback procedure, connection-pool
   sizing, backup/restore drill, and controlled maintenance window.
6. The repository worktree already contained many unrelated in-progress changes. Phase 2 was not
   committed independently because doing so would create commits that depend on uncommitted Phase 1
   and Foundation files.

## 10. Recommended next phase

Proceed with a separately approved Phase 3 for the remaining runtime boundaries:

1. Convert `OperationAuditService` and its callers to an awaited async contract.
2. Replace the synchronous scheduler repository with a provider-neutral async repository.
3. Move file metadata/lifecycle/review repositories behind the provider interface while leaving
   binary assets in local storage.
4. Port Price Control SQL and isolate the fulfillment service provider decision.
5. Add an isolated writable PostgreSQL rehearsal and rollback verification.
6. Only after those gates pass, add a provider-aware full-server composition. Production must remain
   SQLite until a separate cutover approval.
