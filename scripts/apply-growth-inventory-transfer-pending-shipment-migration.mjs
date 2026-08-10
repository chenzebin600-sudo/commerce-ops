import fs from "node:fs/promises";
import path from "node:path";
import { PostgresqlProvider } from "../lib/data/postgresql/postgresql-provider.mjs";
import { loadPostgresqlF1Config } from "../lib/postgresql/f1-config.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const version = "032_growth_inventory_transfer_pending_shipment.sql";
const confirmation = "GROWTH_INVENTORY_TRANSFER_PENDING_SHIPMENT";

function provider(config, role) {
  const migrator = role === "migrator";
  return new PostgresqlProvider({
    config: Object.freeze({ ...config, statementTimeoutMs: 600_000 }),
    database: config.database,
    user: migrator ? config.migratorUser : config.appUser,
    password: migrator ? config.migratorPassword : config.appPassword,
  });
}

async function inspect(migrator) {
  const column = (await migrator.query(`
    SELECT data_type,is_nullable
    FROM information_schema.columns
    WHERE table_schema=$1 AND table_name='growth_inventory_snapshots'
      AND column_name='transfer_pending_shipment_quantity'
  `, [migrator.config.schema])).rows[0] || null;
  const migration = (await migrator.query(
    "SELECT version,applied_at FROM schema_migrations WHERE version=$1",
    [version],
  )).rows[0] || null;
  return { column, migration };
}

async function main() {
  const config = loadPostgresqlF1Config({ rootDir });
  const migrationPath = path.join(rootDir, "migrations", version);
  const sql = await fs.readFile(migrationPath, "utf8");
  const apply = process.argv.includes("--apply");
  const databaseConfirmation = process.argv.find((value) => value.startsWith("--confirm-database="))?.split("=")[1];
  const migrationConfirmation = process.argv.find((value) => value.startsWith("--confirm-migration="))?.split("=")[1];
  const migrator = provider(config, "migrator");
  let application = null;
  try {
    const identity = (await migrator.query(
      "SELECT current_database() database,current_user username,current_schema() schema",
    )).rows[0];
    if (identity.database !== config.database || identity.username !== config.migratorUser || identity.schema !== config.schema) {
      throw new Error("Migration identity does not match the approved production database, migrator role, and schema");
    }
    const before = await inspect(migrator);
    if (!apply) {
      return {
        status: "PLAN",
        database: identity.database,
        schema: identity.schema,
        version,
        before,
        applyCommand: `node scripts/apply-growth-inventory-transfer-pending-shipment-migration.mjs --apply --confirm-database=${config.database} --confirm-migration=${confirmation}`,
      };
    }
    if (databaseConfirmation !== config.database || migrationConfirmation !== confirmation) {
      throw new Error(`Apply requires --confirm-database=${config.database} --confirm-migration=${confirmation}`);
    }
    if (before.migration && !before.column) {
      throw new Error("Migration registry says 032 is applied but the required inventory column is missing");
    }
    let status = "ALREADY_APPLIED";
    if (!before.column || !before.migration) {
      await migrator.transaction(async (tx) => {
        if (!before.column) await tx.executeScript(sql);
        if (!before.migration) {
          await tx.query(
            "INSERT INTO schema_migrations(version,applied_at) VALUES ($1,$2) ON CONFLICT(version) DO NOTHING",
            [version, new Date().toISOString()],
          );
        }
      });
      status = before.column ? "RECORDED_EXISTING_COLUMN" : "APPLIED";
    }
    const after = await inspect(migrator);
    if (!after.column || !after.migration || after.column.data_type !== "numeric") {
      throw new Error("Migration verification failed");
    }
    application = provider(config, "app");
    await application.query("SELECT transfer_pending_shipment_quantity FROM growth_inventory_snapshots LIMIT 0");
    return {
      status,
      database: identity.database,
      schema: identity.schema,
      version,
      before,
      after,
      applicationRoleReadVerified: true,
    };
  } finally {
    await application?.close();
    await migrator.close();
  }
}

main().then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch((error) => {
  process.stderr.write(`Inventory field migration failed: ${String(error?.message || error).split(/\r?\n/)[0].slice(0, 500)}\n`);
  process.exitCode = 1;
});
