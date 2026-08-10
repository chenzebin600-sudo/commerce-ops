import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { loadLocalEnv } from "../lib/env.mjs";
import { PostgresqlProvider } from "../lib/data/postgresql/postgresql-provider.mjs";
import { loadPostgresqlF1Config } from "../lib/postgresql/f1-config.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const version = "017_profit_module.sql";
const confirmation = "PROFIT_MODULE_LAZADA_V1";

async function main() {
  loadLocalEnv(rootDir);
  const config = loadPostgresqlF1Config({ rootDir });
  const apply = process.argv.includes("--apply");
  const databaseConfirmation = process.argv.find((value) => value.startsWith("--confirm-database="))?.split("=")[1];
  const migrationConfirmation = process.argv.find((value) => value.startsWith("--confirm-migration="))?.split("=")[1];
  const migrationPath = path.join(rootDir, "postgresql", "shadow", "migrations", version);
  const sql = await fs.readFile(migrationPath, "utf8");
  const sha256 = crypto.createHash("sha256").update(sql).digest("hex");
  if (!apply) {
    return {
      status: "PLAN", database: config.database, version, sha256,
      applyCommand: `node scripts/apply-profit-module-migration.mjs --apply --confirm-database=${config.database} --confirm-migration=${confirmation}`,
    };
  }
  if (databaseConfirmation !== config.database || migrationConfirmation !== confirmation) {
    throw new Error(`Apply requires --confirm-database=${config.database} --confirm-migration=${confirmation}`);
  }
  const migrator = new PostgresqlProvider({
    config: Object.freeze({ ...config, statementTimeoutMs: 600_000 }),
    database: config.database,
    user: config.migratorUser,
    password: config.migratorPassword,
  });
  try {
    const identity = (await migrator.query("SELECT current_database() database,current_user username")).rows[0];
    if (identity.database !== config.database || identity.username !== config.migratorUser) {
      throw new Error("Migration identity does not match the approved database and migrator role");
    }
    const existing = (await migrator.query(
      "SELECT sha256,applied_at FROM shadow_meta.schema_migrations WHERE version=$1", [version],
    )).rows[0];
    if (existing) {
      if (existing.sha256 !== sha256) throw new Error(`Applied migration checksum changed: ${version}`);
      return { status: "ALREADY_APPLIED", database: identity.database, version, sha256, appliedAt: existing.applied_at };
    }
    await migrator.transaction(async (tx) => {
      await tx.executeScript(sql);
      await tx.query("INSERT INTO shadow_meta.schema_migrations(version,sha256) VALUES ($1,$2)", [version, sha256]);
    });
    return { status: "APPLIED", database: identity.database, version, sha256 };
  } finally {
    await migrator.close();
  }
}

main().then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch((error) => {
  process.stderr.write(`Profit module migration failed: ${String(error?.message || error).split(/\r?\n/)[0].slice(0, 500)}\n`);
  process.exitCode = 1;
});
