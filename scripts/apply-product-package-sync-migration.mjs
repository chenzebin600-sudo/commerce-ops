import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { loadLocalEnv } from "../lib/env.mjs";
import { PostgresqlProvider } from "../lib/data/postgresql/postgresql-provider.mjs";
import { loadPostgresqlF1Config } from "../lib/postgresql/f1-config.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const migrationVersions = Object.freeze([
  "009_product_package_database_sync.sql",
  "010_product_catalog_reference_indexes.sql",
  "011_product_package_sync_workspace.sql",
  "012_product_center_selectable_columns.sql",
]);
const migrationConfirmation = "PRODUCT_PACKAGE_SYNC";

async function loadMigrations() {
  return Promise.all(migrationVersions.map(async (version) => {
    const migrationPath = path.join(rootDir, "postgresql", "shadow", "migrations", version);
    const sql = await fs.readFile(migrationPath, "utf8");
    return { version, sql, sha256: crypto.createHash("sha256").update(sql).digest("hex") };
  }));
}

async function main() {
  loadLocalEnv(rootDir);
  const config = loadPostgresqlF1Config({ rootDir });
  const apply = process.argv.includes("--apply");
  const databaseConfirmation = process.argv.find((value) => value.startsWith("--confirm-database="))?.split("=")[1];
  const setConfirmation = process.argv.find((value) => value.startsWith("--confirm-migrations="))?.split("=")[1];
  if (!apply) return { status: "PLAN", database: config.database, migrationVersions };
  if (databaseConfirmation !== config.database || setConfirmation !== migrationConfirmation) {
    throw new Error(`Apply requires --confirm-database=${config.database} --confirm-migrations=${migrationConfirmation}`);
  }
  const migrations = await loadMigrations();
  const migrator = new PostgresqlProvider({
    config: Object.freeze({ ...config, statementTimeoutMs: 600_000 }),
    database: config.database,
    user: config.migratorUser,
    password: config.migratorPassword,
  });
  try {
    const identity = (await migrator.query("SELECT current_database() database,current_user username")).rows[0];
    if (identity.database !== config.database || identity.username !== config.migratorUser) {
      throw new Error("Migration identity does not match the approved production database and migrator role");
    }
    const results = [];
    for (const migration of migrations) {
      const existing = (await migrator.query(
        "SELECT sha256,applied_at FROM shadow_meta.schema_migrations WHERE version=$1",
        [migration.version],
      )).rows[0];
      if (existing) {
        if (existing.sha256 !== migration.sha256) throw new Error(`Applied migration checksum changed: ${migration.version}`);
        results.push({ version: migration.version, status: "ALREADY_APPLIED", sha256: migration.sha256, appliedAt: existing.applied_at });
        continue;
      }
      await migrator.transaction(async (tx) => {
        await tx.executeScript(migration.sql);
        await tx.query("INSERT INTO shadow_meta.schema_migrations(version,sha256) VALUES ($1,$2)", [migration.version, migration.sha256]);
      });
      results.push({ version: migration.version, status: "APPLIED", sha256: migration.sha256 });
    }
    return { status: "APPLIED", database: identity.database, migrations: results };
  } finally {
    await migrator.close();
  }
}

main().then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch((error) => {
  process.stderr.write(`Product package migration failed: ${String(error?.message || error).split(/\r?\n/)[0].slice(0, 500)}\n`);
  process.exitCode = 1;
});
