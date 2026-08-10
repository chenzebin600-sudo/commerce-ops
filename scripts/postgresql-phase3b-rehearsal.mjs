import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { loadPostgresqlF1Config } from "../lib/postgresql/f1-config.mjs";
import { PostgresqlProvider } from "../lib/data/postgresql/postgresql-provider.mjs";
import {
  PHASE3B_REHEARSAL_CONTRACT,
  loadPhase3bMigrations,
  planPhase3bMigrations,
  resolvePhase3bInvocation,
} from "../lib/postgresql/phase3b-rehearsal.mjs";
import { quoteIdentifier } from "../lib/postgresql/sqlite-migration.mjs";
import {
  SHADOW_AI_SCHEMA,
  SHADOW_APP_SCHEMA,
  SHADOW_META_SCHEMA,
  shadowSchemaMigrationsSql,
} from "../lib/postgresql/shadow/shadow-schema.mjs";

const executeFile = promisify(execFile);
const rootDir = path.resolve(import.meta.dirname, "..");
const CONTRACT_TABLE = "phase3b_contract_records";

function activeProvider() {
  const provider = String(process.env.DATABASE_PROVIDER || "sqlite").trim().toLowerCase();
  if (provider !== "sqlite") {
    throw new Error("Phase 3B requires the active production DATABASE_PROVIDER to remain sqlite");
  }
  return provider;
}

function createProvider(config, { readOnly }) {
  return new PostgresqlProvider({
    config: Object.freeze({ ...config, schema: SHADOW_APP_SCHEMA }),
    database: config.testDatabase,
    user: config.migratorUser,
    password: config.migratorPassword,
    readOnly,
  });
}

function createAdminProvider(config) {
  return new PostgresqlProvider({
    config: Object.freeze({ ...config, schema: SHADOW_APP_SCHEMA }),
    database: config.testDatabase,
    user: config.adminUser,
    password: config.adminPassword,
    readOnly: false,
  });
}

async function grantTemporaryDatabaseCreate(provider, config) {
  const identity = (await provider.query(
    "SELECT current_database() database,current_user username",
  )).rows[0];
  assert.equal(identity.database, config.testDatabase);
  assert.equal(identity.username, config.adminUser);
  const before = Boolean((await provider.query(
    "SELECT has_database_privilege($1,$2,'CREATE') can_create",
    [config.migratorUser, config.testDatabase],
  )).rows[0].can_create);
  if (!before) {
    await provider.execute(
      `GRANT CREATE ON DATABASE ${quoteIdentifier(config.testDatabase)} TO ${quoteIdentifier(config.migratorUser)}`,
    );
  }
  const during = Boolean((await provider.query(
    "SELECT has_database_privilege($1,$2,'CREATE') can_create",
    [config.migratorUser, config.testDatabase],
  )).rows[0].can_create);
  assert.equal(during, true);
  return { before, temporarilyGranted: !before, during };
}

async function restoreDatabaseCreatePrivilege(provider, config, privilege) {
  if (privilege.temporarilyGranted) {
    await provider.execute(
      `REVOKE CREATE ON DATABASE ${quoteIdentifier(config.testDatabase)} FROM ${quoteIdentifier(config.migratorUser)}`,
    );
  }
  const after = Boolean((await provider.query(
    "SELECT has_database_privilege($1,$2,'CREATE') can_create",
    [config.migratorUser, config.testDatabase],
  )).rows[0].can_create);
  assert.equal(after, privilege.before);
  return { ...privilege, restored: true, after };
}

async function inspectTarget(provider, config, migrations) {
  const identity = (await provider.query(
    "SELECT current_database() database,current_user username,current_schema() schema,current_setting('default_transaction_read_only') read_only",
  )).rows[0];
  assert.equal(identity.database, config.testDatabase);
  assert.equal(identity.username, config.migratorUser);

  const objects = (await provider.query(`
    SELECT
      COUNT(*) FILTER (WHERE table_schema=$1)::integer app_tables,
      COUNT(*) FILTER (WHERE table_schema=$2)::integer ai_tables,
      COUNT(*) FILTER (WHERE table_schema=$3)::integer meta_tables
    FROM information_schema.tables
    WHERE table_schema IN ($1,$2,$3)
  `, [SHADOW_APP_SCHEMA, SHADOW_AI_SCHEMA, SHADOW_META_SCHEMA])).rows[0];
  const views = (await provider.query(`
    SELECT COUNT(*)::integer count
    FROM information_schema.views
    WHERE table_schema=$1
  `, [SHADOW_APP_SCHEMA])).rows[0].count;
  const ledger = (await provider.query(
    "SELECT to_regclass($1)::text ledger",
    [`${SHADOW_META_SCHEMA}.schema_migrations`],
  )).rows[0]?.ledger;
  const appliedRows = ledger
    ? (await provider.query(
      `SELECT version,sha256 FROM ${quoteIdentifier(SHADOW_META_SCHEMA)}.schema_migrations ORDER BY version`,
    )).rows
    : [];
  const migrationPlan = planPhase3bMigrations(migrations, appliedRows);
  const applicationCanConnect = (await provider.query(
    "SELECT has_database_privilege($1,$2,'CONNECT') can_connect",
    [config.appUser, config.testDatabase],
  )).rows[0].can_connect;
  const migratorCanCreateDatabaseObjects = (await provider.query(
    "SELECT has_database_privilege($1,$2,'CREATE') can_create",
    [config.migratorUser, config.testDatabase],
  )).rows[0].can_create;
  return Object.freeze({
    identity,
    schemas: {
      appTables: Number(objects.app_tables),
      appViews: Number(views),
      aiTables: Number(objects.ai_tables),
      metaTables: Number(objects.meta_tables),
    },
    migrationPlan,
    applicationRoleCanConnect: Boolean(applicationCanConnect),
    migratorCanCreateDatabaseObjects: Boolean(migratorCanCreateDatabaseObjects),
    rebuildRequired: migrationPlan.some((item) => item.status !== "ALREADY_APPLIED"),
  });
}

async function resetTestSchemas(provider, config, migrations) {
  const schema = quoteIdentifier(SHADOW_APP_SCHEMA);
  const aiSchema = quoteIdentifier(SHADOW_AI_SCHEMA);
  const metaSchema = quoteIdentifier(SHADOW_META_SCHEMA);
  const migrator = quoteIdentifier(config.migratorUser);
  const application = quoteIdentifier(config.appUser);

  await provider.transaction(async (transaction) => {
    const identity = (await transaction.query(
      "SELECT current_database() database,current_user username",
    )).rows[0];
    assert.equal(identity.database, config.testDatabase);
    assert.equal(identity.username, config.migratorUser);
    await transaction.query("SELECT pg_advisory_xact_lock(hashtext($1))", [PHASE3B_REHEARSAL_CONTRACT]);
    await transaction.executeScript(`
      SET LOCAL lock_timeout='10s';
      DROP SCHEMA IF EXISTS ${schema} CASCADE;
      DROP SCHEMA IF EXISTS ${aiSchema} CASCADE;
      DROP SCHEMA IF EXISTS ${metaSchema} CASCADE;
      CREATE SCHEMA ${schema} AUTHORIZATION ${migrator};
      REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC;
      GRANT USAGE,CREATE ON SCHEMA ${schema} TO ${migrator};
      ${shadowSchemaMigrationsSql()}
    `);
    for (const migration of migrations) {
      await transaction.executeScript(migration.sql);
      await transaction.query(
        `INSERT INTO ${metaSchema}.schema_migrations(version,sha256) VALUES ($1,$2)`,
        [migration.version, migration.sha256],
      );
    }
    await transaction.executeScript(`
      REVOKE ALL ON SCHEMA ${schema},${aiSchema},${metaSchema} FROM PUBLIC;
      REVOKE ALL ON SCHEMA ${metaSchema} FROM ${application};
      GRANT USAGE ON SCHEMA ${schema},${aiSchema} TO ${application};
      GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${application};
      GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${aiSchema} TO ${application};
      GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${application};
      GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${aiSchema} TO ${application};
      ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA ${schema}
        GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO ${application};
      ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA ${aiSchema}
        GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO ${application};
      ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA ${schema}
        GRANT USAGE,SELECT ON SEQUENCES TO ${application};
      ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA ${aiSchema}
        GRANT USAGE,SELECT ON SEQUENCES TO ${application};
    `);
  });
}

function parseJsonOutput(stdout, context) {
  try {
    return JSON.parse(String(stdout || "").trim());
  } catch {
    throw new Error(`${context} returned invalid JSON`);
  }
}

async function runNodeJson(relativeScript, args = []) {
  const started = performance.now();
  const { stdout } = await executeFile(process.execPath, [
    "--disable-warning=ExperimentalWarning",
    path.join(rootDir, relativeScript),
    ...args,
  ], {
    cwd: rootDir,
    env: { ...process.env, DATABASE_PROVIDER: "sqlite" },
    windowsHide: true,
    timeout: 180_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    result: parseJsonOutput(stdout, relativeScript),
    durationMs: Math.round(performance.now() - started),
  };
}

async function runRuntimeSafetyTests() {
  const started = performance.now();
  await executeFile(process.execPath, [
    "--disable-warning=ExperimentalWarning",
    "--test",
    path.join(rootDir, "tests", "daily-report-agent-v2.test.mjs"),
    path.join(rootDir, "tests", "agent-runtime-architecture.test.mjs"),
  ], {
    cwd: rootDir,
    env: { ...process.env, DATABASE_PROVIDER: "sqlite" },
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    status: "PASS",
    scope: "in-memory runtime safety; no PostgreSQL application-role connection",
    externalCalls: 0,
    deliveryCalls: 0,
    durationMs: Math.round(performance.now() - started),
  };
}

async function runAdvancedWriteContract(provider) {
  const table = `${quoteIdentifier(SHADOW_APP_SCHEMA)}.${quoteIdentifier(CONTRACT_TABLE)}`;
  const rowCount = 105;
  const pageSize = 20;
  const started = performance.now();
  await provider.execute(`DROP TABLE IF EXISTS ${table}`);
  try {
    await provider.executeScript(`
      CREATE TABLE ${table} (
        id text PRIMARY KEY,
        ordinal integer NOT NULL UNIQUE,
        payload jsonb NOT NULL,
        observed_at timestamptz NOT NULL
      );
      CREATE INDEX ${quoteIdentifier(`idx_${CONTRACT_TABLE}_observed`)}
        ON ${table}(observed_at DESC,id);
    `);
    await provider.transaction(async (transaction) => {
      for (let ordinal = 0; ordinal < rowCount; ordinal += 1) {
        await transaction.query(
          `INSERT INTO ${table}(id,ordinal,payload,observed_at) VALUES ($1,$2,$3::jsonb,$4::timestamptz)`,
          [
            `phase3b-row-${String(ordinal).padStart(3, "0")}`,
            ordinal,
            JSON.stringify({ ordinal, parity: ordinal % 2 === 0 ? "even" : "odd" }),
            new Date(Date.UTC(2026, 7, 6, 0, ordinal % 60, 0)).toISOString(),
          ],
        );
      }
    });

    const pagedOrdinals = [];
    for (let offset = 0; offset < rowCount; offset += pageSize) {
      const page = await provider.query(
        `SELECT ordinal FROM ${table} ORDER BY ordinal,id LIMIT $1 OFFSET $2`,
        [pageSize, offset],
      );
      pagedOrdinals.push(...page.rows.map((row) => row.ordinal));
    }
    assert.deepEqual(pagedOrdinals, Array.from({ length: rowCount }, (_, index) => index));

    const upserted = (await provider.query(`
      INSERT INTO ${table}(id,ordinal,payload,observed_at)
      VALUES ($1,$2,$3::jsonb,$4::timestamptz)
      ON CONFLICT (id) DO UPDATE SET payload=EXCLUDED.payload,observed_at=EXCLUDED.observed_at
      RETURNING payload,observed_at
    `, [
      "phase3b-row-050",
      50,
      JSON.stringify({ ordinal: 50, upserted: true }),
      "2026-08-06T12:34:56.789Z",
    ])).rows[0];
    assert.deepEqual(upserted.payload, { ordinal: 50, upserted: true });
    assert.equal(upserted.observed_at.toISOString(), "2026-08-06T12:34:56.789Z");

    let uniqueRejected = false;
    try {
      await provider.execute(
        `INSERT INTO ${table}(id,ordinal,payload,observed_at) VALUES ($1,$2,$3::jsonb,$4::timestamptz)`,
        ["phase3b-duplicate", 50, "{}", "2026-08-06T00:00:00.000Z"],
      );
    } catch (error) {
      uniqueRejected = error?.code === "23505";
    }
    assert.equal(uniqueRejected, true);

    const rollbackId = "phase3b-rollback";
    await assert.rejects(
      provider.transaction(async (transaction) => {
        await transaction.query(
          `INSERT INTO ${table}(id,ordinal,payload,observed_at) VALUES ($1,$2,$3::jsonb,$4::timestamptz)`,
          [rollbackId, rowCount + 1, "{}", "2026-08-06T00:00:00.000Z"],
        );
        throw Object.assign(new Error("intentional Phase 3B rollback"), { code: "PHASE3B_ROLLBACK_SENTINEL" });
      }),
      { code: "PHASE3B_ROLLBACK_SENTINEL" },
    );
    assert.equal(Number((await provider.query(`SELECT COUNT(*) count FROM ${table} WHERE id=$1`, [rollbackId])).rows[0].count), 0);

    const countStarted = performance.now();
    const finalCount = Number((await provider.query(`SELECT COUNT(*) count FROM ${table}`)).rows[0].count);
    const countQueryMs = Number((performance.now() - countStarted).toFixed(3));
    assert.equal(finalCount, rowCount);
    return {
      status: "PASS",
      rows: rowCount,
      pageSize,
      stablePagination: true,
      upsert: true,
      uniqueConstraint: true,
      transactionRollback: true,
      jsonb: true,
      timestamptz: true,
      countQueryMs,
      durationMs: Math.round(performance.now() - started),
    };
  } finally {
    await provider.execute(`DROP TABLE IF EXISTS ${table}`);
    const cleanup = (await provider.query("SELECT to_regclass($1)::text table_name", [
      `${SHADOW_APP_SCHEMA}.${CONTRACT_TABLE}`,
    ])).rows[0].table_name;
    assert.equal(cleanup, null);
  }
}

async function run() {
  const productionProvider = activeProvider();
  const config = loadPostgresqlF1Config({ rootDir });
  const invocation = resolvePhase3bInvocation(process.argv.slice(2), config);
  const migrations = await loadPhase3bMigrations(rootDir);
  let provider = createProvider(config, { readOnly: !invocation.apply });
  let adminProvider = null;
  try {
    const before = await inspectTarget(provider, config, migrations);
    assert.equal(before.applicationRoleCanConnect, false, "Application role must remain isolated from the migration test database");
    if (!invocation.apply) {
      return {
        status: "PLAN",
        contract: PHASE3B_REHEARSAL_CONTRACT,
        mode: invocation.mode,
        target: `${invocation.targetDatabase}.${SHADOW_APP_SCHEMA}`,
        role: config.migratorUser,
        productionProvider,
        productionTouched: false,
        shadowTouched: false,
        current: before,
        proposedOperation: "atomically drop and recreate app, ai_shadow, and shadow_meta in the migration test database",
        applyCommand: `npm run postgres:phase3b:rehearse -- --apply --confirm-database=${invocation.targetDatabase}`,
        requiresExplicitConfirmation: true,
        runtimeRoleParity: "PENDING_DEDICATED_STAGING_DATABASE",
      };
    }

    adminProvider = createAdminProvider(config);
    let databaseCreatePrivilege = await grantTemporaryDatabaseCreate(adminProvider, config);
    try {
      await resetTestSchemas(provider, config, migrations);
    } finally {
      databaseCreatePrivilege = await restoreDatabaseCreatePrivilege(
        adminProvider,
        config,
        databaseCreatePrivilege,
      );
      await adminProvider.close();
      adminProvider = null;
    }
    await provider.close();
    provider = createProvider(config, { readOnly: false });
    const after = await inspectTarget(provider, config, migrations);
    assert.equal(after.rebuildRequired, false);
    assert.equal(after.applicationRoleCanConnect, false);
    assert.equal(after.migratorCanCreateDatabaseObjects, databaseCreatePrivilege.before);

    const compatibility = await runNodeJson("scripts/postgresql-f4-compatibility-check.mjs");
    assert.equal(compatibility.result.status, "PASS");
    const domainWrites = await runNodeJson("scripts/postgresql-phase3a-write-contract-check.mjs", ["--target=test"]);
    assert.equal(domainWrites.result.status, "PASS");
    assert.equal(domainWrites.result.targetMode, "test");
    const advancedWrites = await runAdvancedWriteContract(provider);
    const runtimeSafety = await runRuntimeSafetyTests();

    return {
      status: "PASS",
      contract: PHASE3B_REHEARSAL_CONTRACT,
      mode: invocation.mode,
      target: `${invocation.targetDatabase}.${SHADOW_APP_SCHEMA}`,
      role: config.migratorUser,
      productionProvider,
      productionTouched: false,
      shadowTouched: false,
      schemasRebuilt: [SHADOW_APP_SCHEMA, SHADOW_AI_SCHEMA, SHADOW_META_SCHEMA],
      migrations: after.migrationPlan,
      schemas: after.schemas,
      databaseCreatePrivilege,
      compatibility,
      domainWrites,
      advancedWrites,
      runtimeSafety,
      runtimeRoleParity: "PENDING_DEDICATED_STAGING_DATABASE",
      externalCalls: 0,
      deliveryCalls: 0,
      realFulfillmentActions: 0,
      priceActions: 0,
    };
  } finally {
    if (adminProvider) await adminProvider.close();
    await provider.close();
  }
}

run().then((result) => {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}).catch((error) => {
  const code = String(error?.code || "PHASE3B_REHEARSAL_FAILED").slice(0, 80);
  const message = String(error?.message || error).split(/\r?\n/)[0].slice(0, 400);
  process.stderr.write(`PostgreSQL Phase 3B rehearsal failed [${code}]: ${message}\n`);
  process.exitCode = 1;
});
