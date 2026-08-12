# Shared PostgreSQL Development Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect every Commerce Ops developer instance to the shared PostgreSQL development database on host C while keeping schema changes versioned and allowing external side effects on exactly one designated machine.

**Architecture:** `openCommerceDataAccess` is the data-access seam and selects SQLite or PostgreSQL adapters from validated runtime configuration. PostgreSQL uses fail-closed CA verification and a strict SCRAM-SHA-256-PLUS client, versioned transactional migrations, async domain repositories, and database leases. SQLite remains available for tests and rollback; there is no dual write or silent fallback.

**Tech Stack:** Node.js ESM, `pg` 8.22, `node:sqlite`, Node test runner, PostgreSQL 18, TLS/X.509.

## Global Constraints

- Shared endpoint is `10.110.80.117:5432`, database `commerce_ops`, schema `app`, app role `commerce_app`.
- Ordinary runtime must use `commerce_app`; DDL uses `commerce_migrator` only through an explicit migration command.
- TLS mode is `verify-full` with `C:/CommerceOps/certs/commerce-ops-postgresql-ca.crt` and required channel binding.
- Passwords, private keys, and complete connection strings never enter Git, logs, reports, or test snapshots.
- `DATABASE_PROVIDER=postgres` never falls back to SQLite.
- Exactly one designated machine sets `EXTERNAL_TASKS_ENABLED=true`.
- Existing unrelated dirty-worktree changes must remain untouched.
- Each production change follows red-green-refactor.

---

### Task 1: Secure PostgreSQL runtime configuration

**Files:**
- Create: `lib/data/postgresql/shared-runtime-config.mjs`
- Modify: `lib/data/postgresql/postgresql-provider.mjs`
- Modify: `.env.example`
- Test: `tests/postgresql-shared-runtime-config.test.mjs`
- Test: `tests/postgresql-provider.test.mjs`

**Interfaces:**
- Produces: `loadSharedPostgresqlConfig({ rootDir, env }) -> Readonly<SharedPostgresqlConfig>`.
- Produces: `buildPostgresqlPoolOptions(config, credentials) -> pg.PoolConfig`.
- Produces: `StrictChannelBindingClient extends pg.Client` that rejects authentication unless the server offers `SCRAM-SHA-256-PLUS`.

- [ ] **Step 1: Write failing configuration tests**

```js
test("shared PostgreSQL requires verify-full, CA, and channel binding", () => {
  assert.throws(() => loadSharedPostgresqlConfig({ rootDir, env: baseEnv({ POSTGRES_SSLMODE: "require" }) }), /verify-full/);
  assert.throws(() => loadSharedPostgresqlConfig({ rootDir, env: baseEnv({ POSTGRES_CHANNEL_BINDING: "prefer" }) }), /require/);
});

test("shared PostgreSQL loads the public CA without exposing the password", () => {
  const config = loadSharedPostgresqlConfig({ rootDir, env: baseEnv() });
  assert.match(config.ssl.ca, /BEGIN CERTIFICATE/);
  assert.equal(Object.hasOwn(config, "appPassword"), false);
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `node --test tests/postgresql-shared-runtime-config.test.mjs`

Expected: fail because `shared-runtime-config.mjs` does not exist.

- [ ] **Step 3: Implement strict configuration parsing**

```js
export function loadSharedPostgresqlConfig({ rootDir = process.cwd(), env = process.env } = {}) {
  const sslmode = required(env, "POSTGRES_SSLMODE").toLowerCase();
  const channelBinding = required(env, "POSTGRES_CHANNEL_BINDING").toLowerCase();
  if (sslmode !== "verify-full") throw new Error("POSTGRES_SSLMODE must be verify-full");
  if (channelBinding !== "require") throw new Error("POSTGRES_CHANNEL_BINDING must be require");
  const rootCertPath = path.resolve(rootDir, required(env, "POSTGRES_SSLROOTCERT"));
  const ca = fs.readFileSync(rootCertPath, "utf8");
  return Object.freeze({ host, port, database, schema, ssl: Object.freeze({ ca, rejectUnauthorized: true }), rootCertPath });
}
```

- [ ] **Step 4: Implement strict channel-binding selection and pool options**

```js
export class StrictChannelBindingClient extends pg.Client {
  _handleAuthSASL(message) {
    if (!message.mechanisms?.includes("SCRAM-SHA-256-PLUS")) {
      this.connection.emit("error", Object.assign(new Error("Required channel binding is unavailable"), { code: "PG_CHANNEL_BINDING_REQUIRED" }));
      return;
    }
    return super._handleAuthSASL(message);
  }
}
```

Pass `Client: StrictChannelBindingClient`, `enableChannelBinding: true`, and `ssl: config.ssl` to `Pool`. Add a source comment that the override is pinned by tests because `_handleAuthSASL` is an internal `pg` seam.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `node --test tests/postgresql-shared-runtime-config.test.mjs tests/postgresql-provider.test.mjs`

- [ ] **Step 6: Commit**

```powershell
git add .env.example lib/data/postgresql/shared-runtime-config.mjs lib/data/postgresql/postgresql-provider.mjs tests/postgresql-shared-runtime-config.test.mjs tests/postgresql-provider.test.mjs
git commit -m "feat: require verified PostgreSQL channel binding"
```

### Task 2: Provider selection and startup identity guard

**Files:**
- Create: `lib/data/open-provider.mjs`
- Modify: `lib/runtime-config.mjs`
- Modify: `lib/data/data-access.mjs`
- Modify: `server.mjs`
- Modify: `scheduler.mjs`
- Test: `tests/data-access-boundary.test.mjs`
- Test: `tests/runtime-portability.test.mjs`

**Interfaces:**
- Produces: `openProvider({ providerName, databasePath, postgresqlConfig, credentials, PoolClass })`.
- Produces: `provider.verifyIdentity({ database, user, schema }) -> Promise<void>`.
- Changes: `openCommerceDataAccess(options)` becomes async and all entry points await it before listening.

- [ ] **Step 1: Write failing provider-selection tests**

```js
test("postgres selection never constructs SQLite", async () => {
  const provider = await openProvider({ providerName: "postgres", postgresqlConfig, credentials, PoolClass: FakePool });
  assert.equal(provider.dialect, "postgresql");
});

test("unknown provider fails instead of falling back", async () => {
  await assert.rejects(() => openProvider({ providerName: "typo" }), /DATABASE_PROVIDER/);
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test tests/data-access-boundary.test.mjs tests/runtime-portability.test.mjs`

- [ ] **Step 3: Implement the provider factory and identity check**

```js
const EXPECTED = Object.freeze({ database: "commerce_ops", user: "commerce_app", schema: "app" });
const result = await provider.query("SELECT current_database() database,current_user username,current_schema() schema");
if (!sameIdentity(result.rows[0], EXPECTED)) throw codedError("PG_IDENTITY_MISMATCH");
```

- [ ] **Step 4: Make entry-point initialization asynchronous**

Move network listen and `scheduler.start()` after awaited data-access initialization. Redact database errors to stable codes before logging.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `node --test tests/data-access-boundary.test.mjs tests/runtime-portability.test.mjs tests/postgresql-provider.test.mjs`

- [ ] **Step 6: Commit**

```powershell
git add lib/data/open-provider.mjs lib/runtime-config.mjs lib/data/data-access.mjs server.mjs scheduler.mjs tests/data-access-boundary.test.mjs tests/runtime-portability.test.mjs
git commit -m "feat: select the configured database provider"
```

### Task 3: PostgreSQL migration ledger and lock

**Files:**
- Create: `lib/data/postgresql/migration-runner.mjs`
- Create: `scripts/postgresql-migrate.mjs`
- Create: `migrations/postgresql/001_shared_baseline.sql`
- Modify: `package.json`
- Test: `tests/postgresql-migration-runner.test.mjs`

**Interfaces:**
- Produces: `loadPostgresqlMigrations(directory) -> Migration[]` with `{ version, checksum, sql }`.
- Produces: `runPostgresqlMigrations({ provider, migrations, expectedDatabase, expectedSchema })`.
- Produces command: `npm run postgres:migrate -- --apply`; without `--apply`, print a redacted plan only.

- [ ] **Step 1: Write failing checksum, advisory-lock, and app-role rejection tests**

```js
test("migration runner rejects checksum drift", async () => {
  await assert.rejects(() => runPostgresqlMigrations({ provider: driftProvider, migrations }), { code: "PG_MIGRATION_DRIFT" });
});

test("migration runner serializes with an advisory lock", async () => {
  await runPostgresqlMigrations({ provider, migrations });
  assert.equal(provider.queries[0].text, "SELECT pg_advisory_xact_lock($1)");
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test tests/postgresql-migration-runner.test.mjs`

- [ ] **Step 3: Implement append-only migration loading and transactional application**

Create `app.schema_migrations(version text primary key, checksum text not null, applied_at timestamptz not null default now())`; compare every applied checksum before executing unapplied migrations.

- [ ] **Step 4: Generate and manually inspect the current baseline**

Generate PostgreSQL DDL from a consistent SQLite snapshot using the existing logical type mapper, then store the reviewed result as `001_shared_baseline.sql`. It must include every current migration through the latest numbered SQLite migration, not the historical 15-table F3 subset.

- [ ] **Step 5: Run migration tests and empty-database rehearsal**

Run: `node --test tests/postgresql-migration-runner.test.mjs tests/postgresql-migration.test.mjs`

Run against the isolated test database only: `npm run postgres:migrate -- --database commerce_ops_test --apply`

- [ ] **Step 6: Commit**

```powershell
git add package.json lib/data/postgresql/migration-runner.mjs scripts/postgresql-migrate.mjs migrations/postgresql/001_shared_baseline.sql tests/postgresql-migration-runner.test.mjs
git commit -m "feat: add locked PostgreSQL schema migrations"
```

### Task 4: Convert the scheduler, accounts, audit, and file metadata slice

**Files:**
- Create: `lib/data/postgresql/postgresql-scheduler-repository.mjs`
- Create: `lib/data/postgresql/postgresql-audit-repository.mjs`
- Create: `lib/data/postgresql/postgresql-file-repositories.mjs`
- Modify: `lib/data/data-access.mjs`
- Modify: `lib/data/repositories/account-repository.mjs`
- Modify: `lib/data/repositories/scheduled-task-repository.mjs`
- Modify: `lib/data/repositories/scheduled-run-repository.mjs`
- Test: `tests/postgresql-core-repository-contract.test.mjs`
- Test: `tests/scheduler-integration.test.mjs`
- Test: `tests/audit-service.test.mjs`
- Test: `tests/export-file-persistence.test.mjs`

**Interfaces:**
- PostgreSQL adapters satisfy the existing domain repository method names but every I/O method returns a Promise.
- Scheduler lease acquisition uses one transaction and server time (`clock_timestamp()`), never workstation time.

- [ ] **Step 1: Write contract tests for task CRUD, lease contention, audit append, and file metadata**

```js
for (const adapter of adapters()) {
  test(`${adapter.name} allows only one owner for a live scheduler lease`, async () => {
    assert.equal(await adapter.a.acquireLease("scheduler", "A", 60_000), true);
    assert.equal(await adapter.b.acquireLease("scheduler", "B", 60_000), false);
  });
}
```

- [ ] **Step 2: Run contracts and verify PostgreSQL RED while SQLite remains GREEN**

Run: `node --test tests/postgresql-core-repository-contract.test.mjs`

- [ ] **Step 3: Implement parameterized PostgreSQL adapters**

Use `INSERT ... ON CONFLICT`, `UPDATE ... RETURNING`, `FOR UPDATE`, and `$n` placeholders. Do not translate SQLite SQL text at runtime.

- [ ] **Step 4: Await repository calls at the scheduler and HTTP call sites**

Update direct callers so rejected database promises propagate to existing error middleware rather than becoming unhandled rejections.

- [ ] **Step 5: Run slice tests and verify GREEN**

Run: `node --test tests/postgresql-core-repository-contract.test.mjs tests/scheduler-integration.test.mjs tests/audit-service.test.mjs tests/export-file-persistence.test.mjs tests/file-lifecycle-service.test.mjs tests/file-review-and-quarantine.test.mjs`

- [ ] **Step 6: Commit**

```powershell
git add lib/data/postgresql lib/data/data-access.mjs lib/data/repositories tests/postgresql-core-repository-contract.test.mjs tests/scheduler-integration.test.mjs tests/audit-service.test.mjs tests/export-file-persistence.test.mjs
git commit -m "feat: add PostgreSQL core repositories"
```

### Task 5: Convert provider-oriented product, foundation, and growth slices

**Files:**
- Modify: `lib/data/repositories/product-import-repository.mjs`
- Modify: `lib/data/repositories/product-catalog-repository.mjs`
- Modify: `lib/data/repositories/product-ai-content-repository.mjs`
- Modify: `lib/data/repositories/product-listing-repository.mjs`
- Modify: `lib/data/repositories/product-image-generation-repository.mjs`
- Modify: `lib/foundation/foundation-repository.mjs`
- Modify: `lib/growth-radar/v2/growth-radar-v2-repository.mjs`
- Modify: `lib/sales-assortment/sales-assortment-repository.mjs`
- Test: `tests/database-provider-compatibility.test.mjs`
- Test: `tests/postgresql-domain-repository-contract.test.mjs`

**Interfaces:**
- Keeps current domain repository interfaces.
- Internal SQL is selected by provider dialect only when syntax truly differs; table names remain allowlisted and values remain parameterized.

- [ ] **Step 1: Add dual-adapter contract cases for each public repository method group**

Cover create/read/update/list, transaction rollback, booleans, JSONB, timestamps, UUIDs, pagination counts, and partial unique constraints.

- [ ] **Step 2: Run and verify PostgreSQL RED**

Run: `node --test tests/postgresql-domain-repository-contract.test.mjs`

- [ ] **Step 3: Replace SQLite-only SQL constructs**

Replace `INSERT OR IGNORE`, `datetime()`, `json_extract`, integer booleans, and implicit rowid assumptions with explicit dialect SQL. Keep dialect branches inside repository implementation helpers, not callers.

- [ ] **Step 4: Run domain tests and verify GREEN**

Run: `node --test tests/database-provider-compatibility.test.mjs tests/postgresql-domain-repository-contract.test.mjs tests/foundation-v1.test.mjs tests/growth-radar-v2.test.mjs tests/product-package-import.test.mjs tests/product-listing-workbench.test.mjs`

- [ ] **Step 5: Commit**

```powershell
git add lib/data/repositories lib/foundation/foundation-repository.mjs lib/growth-radar/v2/growth-radar-v2-repository.mjs lib/sales-assortment/sales-assortment-repository.mjs tests/database-provider-compatibility.test.mjs tests/postgresql-domain-repository-contract.test.mjs
git commit -m "feat: support PostgreSQL domain repositories"
```

### Task 6: Convert remaining SQLite-specific health, advertising, and media slices

**Files:**
- Create: `lib/shopee-health/postgresql-repository.mjs`
- Create: `lib/advertising/postgresql-shopee-advertising-repository.mjs`
- Create: `lib/mabang-images/postgresql-repository.mjs`
- Modify: `lib/data/data-access.mjs`
- Test: `tests/postgresql-integration-repository-contract.test.mjs`
- Test: `tests/shopee-health.test.mjs`
- Test: `tests/shopee-advertising-readonly.test.mjs`
- Test: `tests/mabang-sku-image-collector.test.mjs`

**Interfaces:**
- Adapter selection stays inside `openCommerceDataAccess`; services receive the same repository interfaces for both dialects.

- [ ] **Step 1: Write dual-adapter contracts for settings, snapshots, advertising batches, and image metadata**

- [ ] **Step 2: Run and verify PostgreSQL RED**

Run: `node --test tests/postgresql-integration-repository-contract.test.mjs`

- [ ] **Step 3: Implement PostgreSQL adapters with server-side transactions**

Preserve encrypted credential payloads byte-for-byte; never log decrypted material. Preserve file relative keys without claiming local files exist.

- [ ] **Step 4: Run slice tests and verify GREEN**

Run: `node --test tests/postgresql-integration-repository-contract.test.mjs tests/shopee-health.test.mjs tests/shopee-advertising-readonly.test.mjs tests/mabang-sku-image-collector.test.mjs`

- [ ] **Step 5: Commit**

```powershell
git add lib/shopee-health/postgresql-repository.mjs lib/advertising/postgresql-shopee-advertising-repository.mjs lib/mabang-images/postgresql-repository.mjs lib/data/data-access.mjs tests/postgresql-integration-repository-contract.test.mjs
git commit -m "feat: support PostgreSQL integration repositories"
```

### Task 7: Enforce the single external-task executor

**Files:**
- Create: `lib/runtime/external-task-policy.mjs`
- Modify: `lib/runtime-config.mjs`
- Modify: `server.mjs`
- Modify: `scheduler.mjs`
- Modify: `.env.example`
- Test: `tests/external-task-policy.test.mjs`
- Test: `tests/scheduler-integration.test.mjs`

**Interfaces:**
- Produces: `externalTaskPolicy({ enabled, instanceId })` with `assertAllowed(operation)` and `status()`.
- Startup status distinguishes `disabled_by_configuration`, `waiting_for_lease`, and `active`.

- [ ] **Step 1: Write failing tests proving disabled instances cannot start side effects**

```js
test("non-executor skips every registered external runner", async () => {
  const result = await startExternalRunners({ policy: externalTaskPolicy({ enabled: false }), runners });
  assert.deepEqual(result, { status: "disabled_by_configuration", started: [] });
  assert.equal(runners.some((runner) => runner.start.called), false);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test tests/external-task-policy.test.mjs tests/scheduler-integration.test.mjs`

- [ ] **Step 3: Gate scheduler and external launch paths**

Default `EXTERNAL_TASKS_ENABLED` to false for PostgreSQL shared development. Require a non-empty `INSTANCE_ID` when enabled. The enabled executor must acquire `scheduler_leases` before starting loops.

- [ ] **Step 4: Run and verify GREEN**

Run: `node --test tests/external-task-policy.test.mjs tests/scheduler-integration.test.mjs tests/runtime-portability.test.mjs`

- [ ] **Step 5: Commit**

```powershell
git add .env.example lib/runtime/external-task-policy.mjs lib/runtime-config.mjs server.mjs scheduler.mjs tests/external-task-policy.test.mjs tests/scheduler-integration.test.mjs
git commit -m "feat: enforce one external task executor"
```

### Task 8: Shared-database concurrency and no-fallback integration tests

**Files:**
- Create: `tests/postgresql-shared-development.integration.test.mjs`
- Create: `scripts/postgresql-shared-smoke.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces command: `npm run postgres:shared-smoke` using the Git-ignored local environment.

- [ ] **Step 1: Write a two-instance visibility test**

Instance A inserts a uniquely named disposable development record inside the test database; instance B reads and updates it; instance A observes the committed update; cleanup runs in `finally`.

- [ ] **Step 2: Write no-fallback failure tests**

Use a bad CA and unavailable PostgreSQL port, then assert startup rejects and no SQLite file is created.

- [ ] **Step 3: Write lease contention tests**

Start two data-access instances with external tasks enabled in the isolated test database and assert only one becomes `active`.

- [ ] **Step 4: Run integration tests**

Run: `node --test tests/postgresql-shared-development.integration.test.mjs`

- [ ] **Step 5: Commit**

```powershell
git add package.json scripts/postgresql-shared-smoke.mjs tests/postgresql-shared-development.integration.test.mjs
git commit -m "test: verify shared PostgreSQL development"
```

### Task 9: Safe B cutover and developer runbook

**Files:**
- Create: `docs/shared-postgresql-development.md`
- Modify: `.env.example`
- Modify: `scripts/doctor.mjs`
- Test: `tests/doctor.test.mjs`

**Interfaces:**
- Doctor reports only host, port, database, schema, TLS mode, CA fingerprint, provider, schema version, and external-task status; it redacts credentials.

- [ ] **Step 1: Add failing Doctor redaction and readiness tests**

- [ ] **Step 2: Implement PostgreSQL-aware Doctor checks**

Check TCP, CA readability, TLS identity, database/user/schema identity, migration version, app-role DDL denial, and external-task policy without printing secrets.

- [ ] **Step 3: Write the developer runbook**

Document local secret setup, designated executor setup, migration workflow, Navicat inspection rules, file-metadata limitation, startup, smoke tests, and rollback to the preserved SQLite snapshot.

- [ ] **Step 4: Preserve B's SQLite snapshot before changing `.env`**

Use SQLite backup/checkpoint tooling, record integrity and SHA-256, and do not copy a live WAL database with a raw filesystem copy.

- [ ] **Step 5: Configure B without committing secrets**

Set the local ignored environment to `DATABASE_PROVIDER=postgres`, the shared endpoint, CA path, required TLS/channel binding, and `EXTERNAL_TASKS_ENABLED=false`.

- [ ] **Step 6: Run full verification**

Run: `npm test`

Run: `npm run build`

Run: `npm run doctor`

Run: `npm run postgres:shared-smoke`

- [ ] **Step 7: Commit code and runbook only**

```powershell
git add .env.example docs/shared-postgresql-development.md scripts/doctor.mjs tests/doctor.test.mjs
git commit -m "docs: add shared PostgreSQL development runbook"
```

Do not stage the local environment, CA certificate, database snapshots, logs, or generated smoke-test data.
