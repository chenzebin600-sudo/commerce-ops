import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openCompatibilityDataAccess } from "../lib/data/compatibility/compatibility-data-access.mjs";
import { resolveCompatibilityProviderName } from "../lib/data/compatibility/provider-record-repository.mjs";
import { runRepositoryCompatibilityContract } from "../lib/data/compatibility/repository-compatibility-contract.mjs";
import { createPostgresqlProvider } from "../lib/data/postgresql/postgresql-provider.mjs";
import { SqliteProvider } from "../lib/data/sqlite/sqlite-provider.mjs";
import { SchedulerDatabase } from "../lib/mabang-scheduler/db.mjs";
import { loadPostgresqlF1Config, publicPostgresqlF1Config } from "../lib/postgresql/f1-config.mjs";
import {
  assertMigrationTestTarget,
  inspectSqliteSchema,
  quoteIdentifier,
} from "../lib/postgresql/sqlite-migration.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const migrationsDir = path.join(rootDir, "migrations");

async function createSqliteContext() {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "commerce-f4-sqlite-"));
  const databasePath = path.join(temporaryRoot, "compatibility.sqlite");
  const provider = new SqliteProvider({ databasePath });
  const scheduler = new SchedulerDatabase({ databasePath, migrationsDir, provider });
  scheduler.migrate();
  const schema = inspectSqliteSchema(provider.connection);
  return {
    provider,
    schema,
    async close() {
      provider.close();
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    },
  };
}

async function exactPostgresqlCounts(provider, schemaName, schema) {
  const counts = {};
  for (const table of schema.tables) {
    const result = await provider.query(
      `SELECT count(*)::text AS count FROM ${quoteIdentifier(schemaName)}.${quoteIdentifier(table.name)}`,
    );
    counts[table.name] = String(result.rows[0].count);
  }
  return counts;
}

async function runSqliteContract() {
  const context = await createSqliteContext();
  try {
    const dataAccess = openCompatibilityDataAccess({ provider: context.provider, schema: context.schema });
    return await runRepositoryCompatibilityContract(dataAccess);
  } finally {
    await context.close();
  }
}

async function runPostgresqlContract() {
  const config = loadPostgresqlF1Config({ rootDir });
  const schemaContext = await createSqliteContext();
  const provider = createPostgresqlProvider(config, { database: "test", role: "migrator" });
  assertMigrationTestTarget(config, provider);
  try {
    const identity = await provider.query("SELECT current_database() AS database, current_user AS username");
    assert.equal(identity.rows[0]?.database, config.testDatabase);
    assert.equal(identity.rows[0]?.username, config.migratorUser);
    const before = await exactPostgresqlCounts(provider, config.schema, schemaContext.schema);
    const dataAccess = openCompatibilityDataAccess({ provider, schema: schemaContext.schema });
    const contract = await runRepositoryCompatibilityContract(dataAccess);
    const after = await exactPostgresqlCounts(provider, config.schema, schemaContext.schema);
    assert.deepEqual(after, before, "F4 PostgreSQL fixtures were not fully cleaned up");
    return {
      contract,
      target: publicPostgresqlF1Config(config),
      rowCountsPreserved: true,
      totalRows: Object.values(after).reduce((sum, value) => sum + Number(value), 0),
    };
  } finally {
    await provider.close();
    await schemaContext.close();
  }
}

async function main() {
  const activeProvider = resolveCompatibilityProviderName({ DATABASE_PROVIDER: process.env.DATABASE_PROVIDER || "sqlite" });
  if (activeProvider !== "sqlite") throw new Error("F4 requires the active production provider to remain sqlite");

  const sqliteConfig = resolveCompatibilityProviderName({ DATABASE_PROVIDER: "sqlite" });
  const postgresqlConfig = resolveCompatibilityProviderName({ DATABASE_PROVIDER: "postgres" });
  const sqlite = await runSqliteContract();
  const postgresql = await runPostgresqlContract();

  assert.deepEqual(postgresql.contract.operations, sqlite.operations);
  assert.deepEqual(postgresql.contract.values, sqlite.values);
  assert.deepEqual(postgresql.contract.types, sqlite.types);
  assert.deepEqual(postgresql.contract.modules, sqlite.modules);

  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    activeProvider,
    testConfigurations: [sqliteConfig, postgresqlConfig],
    repositoryModules: sqlite.modules,
    operations: sqlite.operations,
    valueParity: true,
    typeParity: true,
    postgresql: {
      database: postgresql.target.testDatabase,
      schema: postgresql.target.schema,
      role: postgresql.target.migratorUser,
      rowCountsPreserved: postgresql.rowCountsPreserved,
      totalRows: postgresql.totalRows,
    },
  }, null, 2)}\n`);
}

main().catch((error) => {
  const code = String(error?.code || "F4_COMPATIBILITY_FAILED").slice(0, 80);
  const message = String(error?.message || error).split(/\r?\n/)[0].slice(0, 300);
  process.stderr.write(`PostgreSQL F4 compatibility check failed [${code}]: ${message}\n`);
  process.exitCode = 1;
});
