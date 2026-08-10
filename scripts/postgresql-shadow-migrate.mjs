import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadPostgresqlF1Config } from "../lib/postgresql/f1-config.mjs";
import { quoteIdentifier } from "../lib/postgresql/sqlite-migration.mjs";
import { SHADOW_APP_SCHEMA, SHADOW_DATABASE, SHADOW_META_SCHEMA } from "../lib/postgresql/shadow/shadow-schema.mjs";

const { Client } = pg;

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function clientOptions(config, { role = "migrator" } = {}) {
  const app = role === "app";
  return {
    host: config.host,
    port: config.port,
    database: SHADOW_DATABASE,
    user: app ? config.appUser : config.migratorUser,
    password: app ? config.appPassword : config.migratorPassword,
    ssl: config.ssl ? { rejectUnauthorized: true } : false,
    application_name: "commerce-ops-shadow-migrate",
    connectionTimeoutMillis: config.connectionTimeoutMs,
  };
}

async function withClient(options, callback) {
  const client = new Client(options);
  await client.connect();
  try {
    return await callback(client);
  } finally {
    await client.end();
  }
}

export function planShadowMigrations(files, appliedRows) {
  const applied = new Map(appliedRows.map((row) => [row.version, row.sha256]));
  return files.map((file) => {
    const digest = sha256(file.sql);
    const recorded = applied.get(file.version);
    if (recorded && recorded !== digest) {
      throw Object.assign(new Error(`Applied Shadow migration changed: ${file.version}`), { code: "SHADOW_MIGRATION_CHECKSUM_MISMATCH" });
    }
    return Object.freeze({ ...file, sha256: digest, status: recorded ? "ALREADY_APPLIED" : "PENDING" });
  });
}

async function loadMigrationFiles(rootDir) {
  const migrationDir = path.join(rootDir, "postgresql", "shadow", "migrations");
  const names = (await fs.readdir(migrationDir))
    .filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name))
    .sort((left, right) => left.localeCompare(right));
  return Promise.all(names.map(async (version) => ({ version, sql: await fs.readFile(path.join(migrationDir, version), "utf8") })));
}

async function applyPending(client, migration) {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout='10s'");
    await client.query(`SET LOCAL search_path TO ${quoteIdentifier(SHADOW_APP_SCHEMA)},public`);
    await client.query(migration.sql);
    await client.query(
      `INSERT INTO ${quoteIdentifier(SHADOW_META_SCHEMA)}.schema_migrations(version,sha256) VALUES ($1,$2)`,
      [migration.version, migration.sha256],
    );
    await client.query("COMMIT");
    return { version: migration.version, sha256: migration.sha256, status: "APPLIED" };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function runShadowMigrations({ rootDir = process.cwd(), apply = false } = {}) {
  if (String(process.env.DATABASE_PROVIDER || "sqlite").trim().toLowerCase() !== "sqlite") {
    throw new Error("Shadow migrations require production DATABASE_PROVIDER=sqlite");
  }
  const config = loadPostgresqlF1Config({ rootDir });
  if ([config.database, config.testDatabase, "postgres", "template0", "template1"].includes(SHADOW_DATABASE)) {
    throw new Error("Shadow migration target is not isolated");
  }
  const files = await loadMigrationFiles(rootDir);
  const result = await withClient(clientOptions(config), async (client) => {
    const identity = (await client.query("SELECT current_database() database,current_user username")).rows[0];
    if (identity.database !== SHADOW_DATABASE || identity.username !== config.migratorUser) {
      throw new Error("Shadow migrator identity check failed");
    }
    const appliedRows = (await client.query(
      `SELECT version,sha256 FROM ${quoteIdentifier(SHADOW_META_SCHEMA)}.schema_migrations ORDER BY version`,
    )).rows;
    const plan = planShadowMigrations(files, appliedRows);
    const migrations = [];
    for (const migration of plan) {
      if (migration.status === "PENDING" && apply) migrations.push(await applyPending(client, migration));
      else migrations.push({ version: migration.version, sha256: migration.sha256, status: migration.status });
    }
    if (apply) {
      await client.query(`GRANT USAGE ON SCHEMA ${quoteIdentifier(SHADOW_APP_SCHEMA)} TO ${quoteIdentifier(config.appUser)}`);
      await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${quoteIdentifier(SHADOW_APP_SCHEMA)} TO ${quoteIdentifier(config.appUser)}`);
      await client.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${quoteIdentifier(SHADOW_APP_SCHEMA)} TO ${quoteIdentifier(config.appUser)}`);
    }
    return { identity, migrations };
  });
  const appValidation = await withClient(clientOptions(config, { role: "app" }), async (client) => {
    const identity = (await client.query("SELECT current_database() database,current_user username")).rows[0];
    const tables = Number((await client.query(
      "SELECT COUNT(*)::int count FROM information_schema.tables WHERE table_schema=$1 AND table_name LIKE 'fulfillment_%'",
      [SHADOW_APP_SCHEMA],
    )).rows[0].count);
    return { identity, fulfillmentTables: tables };
  });
  return Object.freeze({
    status: result.migrations.some((item) => item.status === "PENDING") ? "PENDING" : "PASS",
    target: SHADOW_DATABASE,
    apply,
    migrations: result.migrations,
    appValidation,
  });
}

async function main() {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const result = await runShadowMigrations({ rootDir, apply: process.argv.includes("--apply") });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status === "PENDING") process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`PostgreSQL Shadow migration failed [${error?.code || "SHADOW_MIGRATION_FAILED"}]: ${String(error?.message || error).split(/\r?\n/)[0]}\n`);
    process.exitCode = 1;
  });
}
