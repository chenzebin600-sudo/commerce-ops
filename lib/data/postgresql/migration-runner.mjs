import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const MIGRATION_FILENAME = /^(\d{3}_[a-z0-9][a-z0-9_-]*)\.sql$/;
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const ADVISORY_LOCK_KEY = 1_129_270_867;

function quoteIdentifier(value) {
  if (!IDENTIFIER.test(String(value || ""))) throw new Error("PostgreSQL migration schema is invalid");
  return `"${value}"`;
}

function migrationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export async function loadPostgresqlMigrations(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const migrations = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = entry.name.match(MIGRATION_FILENAME);
    if (!match) continue;
    const sql = await fs.readFile(path.join(directory, entry.name), "utf8");
    if (!sql.trim()) throw new Error(`PostgreSQL migration ${entry.name} is empty`);
    migrations.push(Object.freeze({
      version: match[1],
      checksum: crypto.createHash("sha256").update(sql).digest("hex"),
      sql,
    }));
  }
  migrations.sort((left, right) => left.version.localeCompare(right.version));
  if (new Set(migrations.map(({ version }) => version)).size !== migrations.length) {
    throw new Error("PostgreSQL migration versions must be unique");
  }
  return Object.freeze(migrations);
}

export async function runPostgresqlMigrations({
  provider,
  migrations,
  expectedDatabase,
  expectedUser,
  expectedSchema,
  adoptExistingDatabase = false,
}) {
  if (!provider?.transaction || !Array.isArray(migrations)) {
    throw new TypeError("PostgreSQL migration provider and migrations are required");
  }
  const schema = quoteIdentifier(expectedSchema);
  return provider.transaction(async (transaction) => {
    await transaction.query("SELECT pg_advisory_xact_lock($1) AS locked", [ADVISORY_LOCK_KEY]);
    const identityResult = await transaction.query(`SELECT current_database() AS database,
      current_user AS username,
      current_schema() AS schema`);
    const identity = identityResult.rows[0] || {};
    if (identity.database !== expectedDatabase || identity.username !== expectedUser || identity.schema !== expectedSchema) {
      throw migrationError("PG_MIGRATION_TARGET_MISMATCH", "PostgreSQL migration target identity does not match the approved target");
    }

    await transaction.executeScript(`CREATE TABLE IF NOT EXISTS ${schema}."schema_migrations" (
  version text PRIMARY KEY,
  checksum text NOT NULL CHECK (length(checksum) = 64),
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
)`);
    if (adoptExistingDatabase) {
      await transaction.executeScript(`ALTER TABLE ${schema}."schema_migrations"
  ADD COLUMN IF NOT EXISTS checksum text;
UPDATE ${schema}."schema_migrations" SET checksum = repeat('0', 64) WHERE checksum IS NULL;
ALTER TABLE ${schema}."schema_migrations" ALTER COLUMN checksum SET NOT NULL`);
    }
    const ledger = await transaction.query(`SELECT version, checksum FROM ${schema}."schema_migrations" ORDER BY version`);
    const known = new Map(migrations.map((migration) => [migration.version, migration]));
    const applied = new Map(ledger.rows.map((row) => [row.version, row.checksum]));

    if (adoptExistingDatabase && applied.size === 0) {
      throw migrationError("PG_MIGRATION_ADOPTION_EMPTY", "Existing database adoption requires a non-empty migration history");
    }

    const legacyHistoryAdopted = applied.has("001_shared_baseline");
    for (const [version, checksum] of applied) {
      const migration = known.get(version);
      if ((!migration && !adoptExistingDatabase && !legacyHistoryAdopted) || (migration && migration.checksum !== checksum)) {
        throw migrationError("PG_MIGRATION_DRIFT", "PostgreSQL migration history checksum drift detected");
      }
    }

    const newlyApplied = [];
    const adopted = [];
    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      if (adoptExistingDatabase && migration.version === "001_shared_baseline") {
        await transaction.execute(
          `INSERT INTO ${schema}."schema_migrations" (version, checksum, applied_at) VALUES ($1, $2, clock_timestamp())`,
          [migration.version, migration.checksum],
        );
        adopted.push(migration.version);
        continue;
      }
      await transaction.executeScript(migration.sql);
      await transaction.execute(
        `INSERT INTO ${schema}."schema_migrations" (version, checksum, applied_at) VALUES ($1, $2, clock_timestamp())`,
        [migration.version, migration.checksum],
      );
      newlyApplied.push(migration.version);
    }
    const result = { applied: newlyApplied, existing: [...applied.keys()] };
    if (adoptExistingDatabase) result.adopted = adopted;
    return Object.freeze(result);
  });
}
