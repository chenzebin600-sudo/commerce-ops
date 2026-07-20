import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadLocalEnv } from "../lib/env.mjs";
import { SqliteProvider } from "../lib/data/sqlite/sqlite-provider.mjs";
import { createPostgresqlProvider } from "../lib/data/postgresql/postgresql-provider.mjs";
import { PROVIDER_CONTRACT_TABLES, runProviderContract } from "../lib/data/provider-contract.mjs";
import { loadPostgresqlF1Config, publicPostgresqlF1Config } from "../lib/postgresql/f1-config.mjs";

async function countProductionTables(provider, schema) {
  const result = await provider.query("SELECT count(*)::integer AS count FROM pg_tables WHERE schemaname = $1", [schema]);
  return Number(result.rows[0]?.count || 0);
}

export async function checkPostgresqlF2({ rootDir = process.cwd() } = {}) {
  loadLocalEnv(rootDir);
  const activeProvider = String(process.env.DATABASE_PROVIDER || "sqlite").trim().toLowerCase();
  if (activeProvider !== "sqlite") throw new Error("F2 requires DATABASE_PROVIDER=sqlite");

  const config = loadPostgresqlF1Config({ rootDir });
  if (config.database === config.testDatabase) throw new Error("F2 production and test databases must differ");
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "commerce-ops-f2-"));
  const sqlite = new SqliteProvider({ databasePath: path.join(temporaryRoot, "provider-contract.sqlite") });
  const postgresTest = createPostgresqlProvider(config, { database: "test", role: "migrator" });
  const postgresProduction = createPostgresqlProvider(config, { database: "production", role: "migrator" });
  try {
    if (postgresTest.database !== config.testDatabase || postgresTest.database === config.database) {
      throw new Error("F2 PostgreSQL provider is not connected to the migration test database");
    }
    const identity = await postgresTest.query("SELECT current_database() AS database, current_user AS username");
    if (identity.rows[0]?.database !== config.testDatabase || identity.rows[0]?.username !== config.migratorUser) {
      throw new Error("F2 PostgreSQL test database identity check failed");
    }

    const productionTablesBefore = await countProductionTables(postgresProduction, config.schema);
    const sqliteContract = await runProviderContract(sqlite);
    const postgresContract = await runProviderContract(postgresTest);
    const cleanup = await postgresTest.query("SELECT to_regclass($1) IS NULL AND to_regclass($2) IS NULL AS removed", PROVIDER_CONTRACT_TABLES.map((table) => `${config.schema}.${table}`));
    if (cleanup.rows[0]?.removed !== true) throw new Error("F2 PostgreSQL contract table was not removed");
    const productionTablesAfter = await countProductionTables(postgresProduction, config.schema);
    if (productionTablesBefore !== productionTablesAfter) throw new Error("F2 production PostgreSQL schema changed");

    return Object.freeze({
      status: "COMPATIBLE",
      activeProvider,
      config: publicPostgresqlF1Config(config),
      target: Object.freeze({ database: config.testDatabase, schema: config.schema, role: config.migratorUser }),
      sqlite: sqliteContract,
      postgresql: postgresContract,
      cleanup: Object.freeze({ testTableRemoved: true }),
      productionGuard: Object.freeze({ database: config.database, tableCountUnchanged: true, tableCount: productionTablesAfter }),
    });
  } finally {
    sqlite.close();
    await Promise.allSettled([postgresTest.close(), postgresProduction.close()]);
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function main() {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const result = await checkPostgresqlF2({ rootDir });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (entry === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`PostgreSQL F2 provider check failed: ${String(error?.message || error).split(/\r?\n/)[0].slice(0, 400)}\n`);
    process.exitCode = 1;
  });
}
