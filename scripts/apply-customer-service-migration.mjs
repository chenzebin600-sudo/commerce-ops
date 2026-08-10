import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadLocalEnv } from "../lib/env.mjs";
import { PostgresqlProvider } from "../lib/data/postgresql/postgresql-provider.mjs";
import { loadPostgresqlF1Config } from "../lib/postgresql/f1-config.mjs";

export const CUSTOMER_SERVICE_MIGRATION_VERSION = "016_customer_service_control_plane.sql";
export const CUSTOMER_SERVICE_MIGRATION_CONFIRMATION = "CUSTOMER_SERVICE_CONTROL_PLANE_016";
export const EMPTY_REHEARSAL_REPLACE_CONFIRMATION = "DROP_EMPTY_CS_TABLES_AND_REAPPLY_016";

export const CUSTOMER_SERVICE_TABLES = Object.freeze([
  "cs_channel_accounts",
  "cs_channel_shop_bindings",
  "cs_worker_nodes",
  "cs_worker_account_leases",
  "cs_ingest_events",
  "cs_conversations",
  "cs_messages",
  "cs_message_observations",
  "cs_panel_snapshots",
  "cs_context_snapshots",
  "cs_suggestions",
  "cs_suggestion_evidence",
  "cs_suggestion_reviews",
  "cs_worker_commands",
  "cs_send_actions",
]);

export const CUSTOMER_SERVICE_INDEXES = Object.freeze([
  "idx_cs_shop_bindings_shop",
  "idx_cs_workers_heartbeat",
  "idx_cs_ingest_account_time",
  "idx_cs_conversations_inbox",
  "idx_cs_messages_conversation_time",
  "idx_cs_suggestions_queue",
  "idx_cs_suggestions_quality_dimensions",
  "idx_cs_suggestions_conversation",
  "idx_cs_commands_worker_queue",
]);

const rootDir = path.resolve(import.meta.dirname, "..");

function option(argv, name) {
  const prefix = `--${name}=`;
  return argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) || null;
}

export function resolveCustomerServiceMigrationInvocation(config, argv = process.argv.slice(2)) {
  const database = option(argv, "database") || config.testDatabase;
  const allowedDatabases = new Set([config.testDatabase, config.database]);
  if (!allowedDatabases.has(database)) {
    throw new Error(`Customer Service migration target is not allowed: ${database}`);
  }
  const apply = argv.includes("--apply");
  const confirmedDatabase = option(argv, "confirm-database");
  const confirmedMigration = option(argv, "confirm-migration");
  const replaceEmptyRehearsal = argv.includes("--replace-empty-rehearsal");
  const confirmedEmptyReplace = option(argv, "confirm-empty-replace");
  if (apply && (confirmedDatabase !== database || confirmedMigration !== CUSTOMER_SERVICE_MIGRATION_CONFIRMATION)) {
    throw new Error(
      `Apply requires --confirm-database=${database} --confirm-migration=${CUSTOMER_SERVICE_MIGRATION_CONFIRMATION}`,
    );
  }
  if (replaceEmptyRehearsal && (
    !apply
    || database !== config.testDatabase
    || confirmedEmptyReplace !== EMPTY_REHEARSAL_REPLACE_CONFIRMATION
  )) {
    throw new Error(
      `Empty rehearsal replacement requires the configured test database and --confirm-empty-replace=${EMPTY_REHEARSAL_REPLACE_CONFIRMATION}`,
    );
  }
  return Object.freeze({
    database,
    apply,
    confirmedDatabase,
    confirmedMigration,
    replaceEmptyRehearsal,
    confirmedEmptyReplace,
  });
}

async function replaceEmptyRehearsalSchema(provider, { sql, version, sha256 }) {
  let validation;
  const before = await provider.transaction(async (tx) => {
    const actualTables = (await tx.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='app' AND LEFT(table_name, 3)='cs_'
       ORDER BY table_name`,
    )).rows.map((row) => row.table_name);
    const expectedTables = [...CUSTOMER_SERVICE_TABLES].sort();
    if (JSON.stringify(actualTables) !== JSON.stringify(expectedTables)) {
      throw new Error("Empty rehearsal replacement requires exactly the frozen 15 Customer Service tables");
    }
    const qualifiedTables = CUSTOMER_SERVICE_TABLES.map((name) => `app.${name}`).join(", ");
    await tx.executeScript(`LOCK TABLE ${qualifiedTables} IN ACCESS EXCLUSIVE MODE`);
    const rowCounts = {};
    for (const table of CUSTOMER_SERVICE_TABLES) {
      rowCounts[table] = Number((await tx.query(`SELECT COUNT(*)::integer count FROM app.${table}`)).rows[0].count);
    }
    const nonEmpty = Object.entries(rowCounts).filter(([, count]) => count !== 0).map(([table]) => table);
    if (nonEmpty.length) {
      throw new Error(`Empty rehearsal replacement refused non-empty tables: ${nonEmpty.join(", ")}`);
    }
    await tx.executeScript(`DROP TABLE ${qualifiedTables}`);
    await tx.query("DELETE FROM shadow_meta.schema_migrations WHERE version=$1", [version]);
    await tx.executeScript(sql);
    await tx.query(
      "INSERT INTO shadow_meta.schema_migrations(version,sha256) VALUES ($1,$2)",
      [version, sha256],
    );
    validation = await validateCustomerServiceSchema(tx, { version, sha256 });
    return Object.freeze({ tables: actualTables.length, nonEmptyTables: 0 });
  });
  return Object.freeze({ before, validation });
}

export async function validateCustomerServiceSchema(provider, { version, sha256 }) {
  const tableRows = (await provider.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema='app' AND table_name = ANY($1::text[])
     ORDER BY table_name`,
    [CUSTOMER_SERVICE_TABLES],
  )).rows;
  const indexRows = (await provider.query(
    `SELECT c.relname index_name, i.indisvalid
     FROM pg_class c
     JOIN pg_namespace n ON n.oid=c.relnamespace
     JOIN pg_index i ON i.indexrelid=c.oid
     WHERE n.nspname='app' AND c.relname = ANY($1::text[])
     ORDER BY c.relname`,
    [CUSTOMER_SERVICE_INDEXES],
  )).rows;
  const constraints = (await provider.query(
    `SELECT constraint_type, COUNT(*)::integer count
     FROM information_schema.table_constraints
     WHERE table_schema='app' AND table_name = ANY($1::text[])
     GROUP BY constraint_type ORDER BY constraint_type`,
    [CUSTOMER_SERVICE_TABLES],
  )).rows;
  const ledger = (await provider.query(
    "SELECT sha256,applied_at FROM shadow_meta.schema_migrations WHERE version=$1",
    [version],
  )).rows[0];

  const foundTables = new Set(tableRows.map((row) => row.table_name));
  const missingTables = CUSTOMER_SERVICE_TABLES.filter((name) => !foundTables.has(name));
  const validIndexes = new Set(indexRows.filter((row) => row.indisvalid).map((row) => row.index_name));
  const missingIndexes = CUSTOMER_SERVICE_INDEXES.filter((name) => !validIndexes.has(name));
  const counts = Object.fromEntries(constraints.map((row) => [row.constraint_type, Number(row.count)]));
  if (missingTables.length) throw new Error(`Customer Service migration is missing tables: ${missingTables.join(", ")}`);
  if (missingIndexes.length) throw new Error(`Customer Service migration is missing valid indexes: ${missingIndexes.join(", ")}`);
  if (!ledger || ledger.sha256 !== sha256) throw new Error(`Customer Service migration ledger mismatch: ${version}`);
  if ((counts["FOREIGN KEY"] || 0) < 31 || (counts.CHECK || 0) < 15 || (counts.UNIQUE || 0) < 6) {
    throw new Error(`Customer Service migration constraints are incomplete: ${JSON.stringify(counts)}`);
  }
  return Object.freeze({
    tables: tableRows.length,
    indexes: indexRows.length,
    constraints: counts,
    ledger: { version, sha256, appliedAt: ledger.applied_at },
  });
}

export async function runCustomerServiceMigration({ argv = process.argv.slice(2), projectRoot = rootDir } = {}) {
  loadLocalEnv(projectRoot);
  const config = loadPostgresqlF1Config({ rootDir: projectRoot });
  const invocation = resolveCustomerServiceMigrationInvocation(config, argv);
  const migrationPath = path.join(projectRoot, "postgresql", "shadow", "migrations", CUSTOMER_SERVICE_MIGRATION_VERSION);
  const sql = await fs.readFile(migrationPath, "utf8");
  const sha256 = crypto.createHash("sha256").update(sql).digest("hex");
  const applyCommand = `node scripts/apply-customer-service-migration.mjs --apply --database=${invocation.database} --confirm-database=${invocation.database} --confirm-migration=${CUSTOMER_SERVICE_MIGRATION_CONFIRMATION}`;
  if (!invocation.apply) {
    return Object.freeze({
      status: "PLAN",
      database: invocation.database,
      production: invocation.database === config.database,
      version: CUSTOMER_SERVICE_MIGRATION_VERSION,
      sha256,
      applyCommand,
    });
  }

  const migrator = new PostgresqlProvider({
    config: Object.freeze({ ...config, statementTimeoutMs: 600_000 }),
    database: invocation.database,
    user: config.migratorUser,
    password: config.migratorPassword,
  });
  try {
    const identity = (await migrator.query(
      "SELECT current_database() database,current_user username",
    )).rows[0];
    if (identity.database !== invocation.database || identity.username !== config.migratorUser) {
      throw new Error("Migration identity does not match the approved database and migrator role");
    }
    const ledgerTable = (await migrator.query(
      "SELECT to_regclass('shadow_meta.schema_migrations')::text relation",
    )).rows[0]?.relation;
    if (!ledgerTable) throw new Error("Migration ledger shadow_meta.schema_migrations is missing");
    const existing = (await migrator.query(
      "SELECT sha256,applied_at FROM shadow_meta.schema_migrations WHERE version=$1",
      [CUSTOMER_SERVICE_MIGRATION_VERSION],
    )).rows[0];
    let status = "ALREADY_APPLIED";
    let validation;
    if (existing) {
      if (existing.sha256 !== sha256) {
        if (!invocation.replaceEmptyRehearsal) {
          throw new Error(`Applied migration checksum changed: ${CUSTOMER_SERVICE_MIGRATION_VERSION}`);
        }
        const replaced = await replaceEmptyRehearsalSchema(migrator, {
          sql,
          version: CUSTOMER_SERVICE_MIGRATION_VERSION,
          sha256,
        });
        validation = replaced.validation;
        status = "REHEARSAL_REAPPLIED";
      } else {
        validation = await validateCustomerServiceSchema(migrator, {
          version: CUSTOMER_SERVICE_MIGRATION_VERSION,
          sha256,
        });
      }
    } else {
      await migrator.transaction(async (tx) => {
        await tx.executeScript(sql);
        await tx.query(
          "INSERT INTO shadow_meta.schema_migrations(version,sha256) VALUES ($1,$2)",
          [CUSTOMER_SERVICE_MIGRATION_VERSION, sha256],
        );
        validation = await validateCustomerServiceSchema(tx, {
          version: CUSTOMER_SERVICE_MIGRATION_VERSION,
          sha256,
        });
      });
      status = "APPLIED";
    }
    return Object.freeze({
      status,
      database: identity.database,
      production: identity.database === config.database,
      version: CUSTOMER_SERVICE_MIGRATION_VERSION,
      sha256,
      validation,
    });
  } finally {
    await migrator.close();
  }
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  runCustomerServiceMigration().then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(
      `Customer Service migration failed: ${String(error?.message || error).split(/\r?\n/)[0].slice(0, 500)}\n`,
    );
    process.exitCode = 1;
  });
}
