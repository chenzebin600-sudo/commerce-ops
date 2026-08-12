import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadLocalEnv } from "../lib/env.mjs";
import { PostgresqlProvider } from "../lib/data/postgresql/postgresql-provider.mjs";
import { loadSharedPostgresqlConfig } from "../lib/data/postgresql/shared-runtime-config.mjs";
import { loadPostgresqlMigrations, runPostgresqlMigrations } from "../lib/data/postgresql/migration-runner.mjs";

function required(env, name) {
  const value = String(env[name] ?? "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export async function migrateSharedPostgresql({
  rootDir,
  env = process.env,
  apply = false,
  adoptExistingDatabase = false,
  PoolClass,
} = {}) {
  const config = loadSharedPostgresqlConfig({ rootDir, env });
  const migrations = await loadPostgresqlMigrations(path.join(rootDir, "migrations", "postgresql"));
  const summary = Object.freeze({
    database: config.database,
    schema: config.schema,
    migrationCount: migrations.length,
    versions: migrations.map(({ version }) => version),
    apply,
  });
  if (!apply) return Object.freeze({ status: "PLAN", ...summary });

  const migratorUser = required(env, "POSTGRES_MIGRATOR_USER");
  const provider = new PostgresqlProvider({
    config,
    database: config.database,
    user: migratorUser,
    password: required(env, "POSTGRES_MIGRATOR_PASSWORD"),
    ...(PoolClass ? { PoolClass } : {}),
  });
  try {
    const result = await runPostgresqlMigrations({
      provider,
      migrations,
      expectedDatabase: config.database,
      expectedUser: migratorUser,
      expectedSchema: config.schema,
      adoptExistingDatabase,
    });
    return Object.freeze({ status: "APPLIED", ...summary, adoptExistingDatabase, ...result });
  } finally {
    await provider.close();
  }
}

async function main() {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  loadLocalEnv(rootDir, { filenames: [".env.postgres.local", ".env.local", ".env"] });
  const result = await migrateSharedPostgresql({
    rootDir,
    apply: process.argv.includes("--apply"),
    adoptExistingDatabase: process.argv.includes("--adopt-existing"),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (entry === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`Shared PostgreSQL migration failed [${String(error?.code || "PG_MIGRATION_FAILED").slice(0, 80)}]\n`);
    process.exitCode = 1;
  });
}
