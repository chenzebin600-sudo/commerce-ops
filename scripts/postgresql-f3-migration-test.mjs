import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadLocalEnv } from "../lib/env.mjs";
import { resolveRuntimeConfig } from "../lib/runtime-config.mjs";
import { createPostgresqlProvider } from "../lib/data/postgresql/postgresql-provider.mjs";
import { loadPostgresqlF1Config, publicPostgresqlF1Config } from "../lib/postgresql/f1-config.mjs";
import {
  assertMigrationTestTarget,
  buildPostgresqlSchema,
  createSqliteMigrationSnapshot,
  encodeNormalizedPostgresqlMigrationValue,
  inspectSqliteSchema,
  normalizeMigrationValue,
  normalizePostgresqlMigrationValue,
  openReadOnlySqliteSnapshot,
  quoteIdentifier,
  readNormalizedTableRows,
  tableDigests,
  tableInsertSql,
  topologicalTableOrder,
} from "../lib/postgresql/sqlite-migration.mjs";

function qualified(schema, table) {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

function logicalForeignKeyCount(source) {
  return source.tables.reduce((sum, table) => sum + new Set(table.foreignKeys.map((row) => row.id)).size, 0);
}

function typeCounts(columns) {
  const counts = {};
  for (const column of columns) counts[column.logicalType] = (counts[column.logicalType] || 0) + 1;
  return Object.entries(counts).sort(([left], [right]) => left.localeCompare(right))
    .map(([type, count]) => `${type}:${count}`).join(", ");
}

async function migrationStage(label, callback) {
  try {
    return await callback();
  } catch (error) {
    const code = String(error?.code || "MIGRATION_STAGE_FAILED").slice(0, 80);
    const safeContext = [error?.name, error?.table, error?.column, error?.constraint, error?.routine]
      .filter(Boolean).map((value) => String(value).slice(0, 100)).join("/");
    const wrapped = new Error(`${label} [${code}]${safeContext ? ` (${safeContext})` : ""}`);
    wrapped.code = code;
    throw wrapped;
  }
}

async function resetAndMigrate({ provider, config, source, generated, rowsByTable }) {
  let order;
  try {
    order = topologicalTableOrder(source);
  } catch (error) {
    if (!/foreign-key graph contains a cycle/i.test(error.message)) throw error;
    order = source.tables.map((table) => table.name);
  }
  await provider.transaction(async (transaction) => {
    const identity = await transaction.query("SELECT current_database() AS database, current_user AS username");
    if (identity.rows[0]?.database !== config.testDatabase || identity.rows[0]?.username !== config.migratorUser) {
      throw new Error("F3 PostgreSQL target identity check failed");
    }
    const schemaAccess = await transaction.query("SELECT has_schema_privilege(current_user, $1, 'USAGE') AS can_use, has_schema_privilege(current_user, $1, 'CREATE') AS can_create", [config.schema]);
    if (!schemaAccess.rows[0]?.can_use || !schemaAccess.rows[0]?.can_create) throw new Error("F3 migrator lacks required app schema privileges");
    const existing = await transaction.query("SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename", [config.schema]);
    const allowedTables = new Set(source.tables.map((table) => table.name));
    const unexpectedTables = existing.rows.map((row) => row.tablename).filter((name) => !allowedTables.has(name));
    if (unexpectedTables.length) throw new Error("F3 migration test schema contains unexpected tables");
    for (const { tablename } of existing.rows) {
      await transaction.executeScript(`DROP TABLE ${qualified(config.schema, tablename)} CASCADE`);
    }
    for (let index = 0; index < generated.tableStatements.length; index += 1) {
      await migrationStage(`F3 create table ${source.tables[index].name}`, () => transaction.executeScript(generated.tableStatements[index]));
    }
    for (const tableName of order) {
      const table = source.tables.find((candidate) => candidate.name === tableName);
      const statement = tableInsertSql(config.schema, table, transaction);
      for (const row of rowsByTable.get(tableName)) {
        await migrationStage(`F3 insert table ${tableName}`, () => transaction.execute(statement, table.columns.map((column) => encodeNormalizedPostgresqlMigrationValue(row[column.name], column))));
      }
      if (table.autoIncrement) {
        const identityColumn = table.columns.find((column) => column.logicalType === "identity");
        const sequence = await transaction.query("SELECT pg_get_serial_sequence($1, $2) AS name", [`${config.schema}.${table.name}`, identityColumn.name]);
        const sequenceName = sequence.rows[0]?.name;
        if (!sequenceName) throw new Error(`F3 identity sequence is missing for ${table.name}`);
        await transaction.query(`SELECT setval($1::regclass, GREATEST(COALESCE(MAX(${quoteIdentifier(identityColumn.name)}), 1), 1), COUNT(*) > 0) FROM ${qualified(config.schema, table.name)}`, [sequenceName]);
      }
    }

    // Foreign keys are created after loading so cyclic relationships can be
    // migrated without disabling or weakening referential validation.
    for (let index = 0; index < generated.foreignKeyStatements.length; index += 1) {
      await migrationStage(`F3 create foreign key ${index + 1}`, () => transaction.executeScript(generated.foreignKeyStatements[index]));
    }

    for (let index = 0; index < generated.indexStatements.length; index += 1) {
      await migrationStage(`F3 create index ${index + 1}`, () => transaction.executeScript(generated.indexStatements[index]));
    }
    await transaction.executeScript(`GRANT USAGE ON SCHEMA ${quoteIdentifier(config.schema)} TO ${quoteIdentifier(config.appUser)}`);
    await transaction.executeScript(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${quoteIdentifier(config.schema)} TO ${quoteIdentifier(config.appUser)}`);
    await transaction.executeScript(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${quoteIdentifier(config.schema)} TO ${quoteIdentifier(config.appUser)}`);
  });
  return order;
}

async function inspectPostgresqlTarget(provider, source, config) {
  const tableRows = await provider.query("SELECT table_name FROM information_schema.tables WHERE table_schema=$1 AND table_type='BASE TABLE' ORDER BY table_name", [config.schema]);
  const names = tableRows.rows.map((row) => row.table_name);
  const columnRows = await provider.query("SELECT table_name, column_name, data_type, udt_name, ordinal_position FROM information_schema.columns WHERE table_schema=$1 ORDER BY table_name, ordinal_position", [config.schema]);
  const indexRows = await provider.query("SELECT tablename, indexname FROM pg_indexes WHERE schemaname=$1 ORDER BY tablename,indexname", [config.schema]);
  const foreignKeyRows = await provider.query("SELECT c.relname AS table_name, con.conname FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND con.contype='f' ORDER BY c.relname,con.conname", [config.schema]);
  const checkRows = await provider.query("SELECT c.relname AS table_name, con.conname FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND con.contype='c' ORDER BY c.relname,con.conname", [config.schema]);
  const tables = [];
  for (const table of source.tables) {
    const projection = table.columns.map((column) => quoteIdentifier(column.name)).join(", ");
    const result = await provider.query(`SELECT ${projection} FROM ${qualified(config.schema, table.name)}`);
    const normalizedRows = result.rows.map((row) => Object.fromEntries(table.columns.map((column) => [column.name, normalizePostgresqlMigrationValue(row[column.name], column)])));
    tables.push({
      name: table.name,
      rows: normalizedRows,
      rowCount: result.rowCount,
      columnCount: columnRows.rows.filter((row) => row.table_name === table.name).length,
      indexCount: indexRows.rows.filter((row) => row.tablename === table.name).length,
      foreignKeyCount: foreignKeyRows.rows.filter((row) => row.table_name === table.name).length,
      checkCount: checkRows.rows.filter((row) => row.table_name === table.name).length,
    });
  }
  return {
    tableNames: names,
    tableCount: names.length,
    columnCount: columnRows.rowCount,
    indexCount: indexRows.rowCount,
    foreignKeyCount: foreignKeyRows.rowCount,
    checkCount: checkRows.rowCount,
    tables,
  };
}

function validateMigration({ source, generated, rowsByTable, target }) {
  const failures = [];
  const expectedNames = source.tables.map((table) => table.name).sort();
  if (JSON.stringify(target.tableNames) !== JSON.stringify(expectedNames)) failures.push("TABLE_NAMES_MISMATCH");
  if (target.tableCount !== source.tableCount) failures.push("TABLE_COUNT_MISMATCH");
  if (target.columnCount !== source.columnCount) failures.push("COLUMN_COUNT_MISMATCH");
  if (target.indexCount !== generated.expectedIndexCount) failures.push("INDEX_COUNT_MISMATCH");
  if (target.foreignKeyCount !== logicalForeignKeyCount(source)) failures.push("FOREIGN_KEY_COUNT_MISMATCH");
  const tables = source.tables.map((table) => {
    const targetTable = target.tables.find((candidate) => candidate.name === table.name);
    const sourceRows = rowsByTable.get(table.name);
    const sourceHashes = tableDigests(sourceRows, table, { valuesAreNormalized: true });
    const targetHashes = tableDigests(targetTable?.rows || [], table, { valuesAreNormalized: true });
    const rowMatch = targetTable?.rowCount === table.rowCount;
    const columnMatch = targetTable?.columnCount === table.columns.length;
    const fullHashMatch = sourceHashes.full === targetHashes.full;
    const keyHashMatch = sourceHashes.keys === targetHashes.keys;
    if (!rowMatch) failures.push(`ROW_COUNT_MISMATCH:${table.name}`);
    if (!columnMatch) failures.push(`COLUMN_COUNT_MISMATCH:${table.name}`);
    if (!fullHashMatch) failures.push(`FULL_HASH_MISMATCH:${table.name}`);
    if (!keyHashMatch) failures.push(`KEY_HASH_MISMATCH:${table.name}`);
    return {
      name: table.name,
      rows: table.rowCount,
      columns: table.columns.length,
      sourceIndexes: table.indexes.length,
      targetIndexes: targetTable?.indexCount || 0,
      foreignKeys: new Set(table.foreignKeys.map((row) => row.id)).size,
      checks: table.checks.length,
      rowMatch,
      columnMatch,
      fullHash: sourceHashes.full,
      keyHash: sourceHashes.keys,
      fullHashMatch,
      keyHashMatch,
      keyColumns: sourceHashes.keyColumns,
    };
  });
  return { ok: failures.length === 0, failures, tables };
}

function schemaConversionReport({ source, generated, snapshot }) {
  const tableRows = source.tables.map((table) => `| \`${table.name}\` | ${table.columns.length} | ${typeCounts(table.columns)} | ${table.indexes.filter((index) => index.origin === "c").length} | ${new Set(table.foreignKeys.map((row) => row.id)).size} | ${table.checks.length} |`).join("\n");
  return `# PostgreSQL Schema Conversion Report (F3)\n\nDate: 2026-07-20\n\n## Source\n\n- SQLite version: ${source.sqliteVersion}\n- Consistent snapshot size: ${snapshot.snapshotBytes} bytes\n- Snapshot integrity: ${snapshot.integrity}\n- Tables: ${source.tableCount}\n- Columns: ${source.columnCount}\n- Rows: ${source.rowCount}\n- Raw SQLite indexes: ${source.indexCount}\n- Foreign keys: ${logicalForeignKeyCount(source)}\n\n## Type conversion rules\n\n| SQLite shape | PostgreSQL type | Rule | Risk |\n|---|---|---|---|\n| \`INTEGER PRIMARY KEY AUTOINCREMENT\` | \`bigint GENERATED BY DEFAULT AS IDENTITY\` | Preserve explicit IDs and reset identity sequence | PostgreSQL creates a physical PK index where SQLite rowid did not |\n| Boolean-like \`INTEGER\` | \`boolean\` | Only 0/1 accepted and converted to false/true | Future non-0/1 values must fail migration |\n| Other \`INTEGER\` | \`integer\` or \`bigint\` | File-size fields use bigint | JavaScript bigint values remain decimal strings |\n| JSON \`TEXT\` | \`jsonb\` | Parse and validate every non-null value | Malformed JSON must block migration |\n| \`*_at\`, \`lease_until\` TEXT | \`timestamptz\` | Normalize SQLite UTC strings to ISO-8601 UTC | Zone-less timestamps are interpreted as UTC |\n| \`*_date\` TEXT | \`date\` | Require YYYY-MM-DD | Time components are intentionally excluded |\n| UUID-like \`id\`/\`*_id\` TEXT | \`uuid\` | Validate RFC-compatible UUID text | Future platform IDs must not be guessed as UUIDs |\n| Other \`TEXT\` | \`text\` | Preserve value | Collation differs from SQLite |\n| \`BLOB\` | \`bytea\` | Byte-preserving conversion | No current production columns use BLOB |\n\n## Constraint and index conversion\n\n- Primary keys and table-level unique constraints become PostgreSQL constraints.\n- SQLite CHECK expressions are preserved; boolean 0/1 checks are translated to false/true.\n- Foreign-key actions (RESTRICT, CASCADE, SET NULL, NO ACTION) are preserved.\n- Explicit and partial indexes are recreated after data loading.\n- Expected PostgreSQL indexes: ${generated.expectedIndexCount}. SQLite reports ${source.indexCount}; the difference is PostgreSQL physical PK indexes for two former rowid identity tables.\n\n## Per-table conversion\n\n| Table | Columns | PostgreSQL logical types | Explicit indexes | Foreign keys | Checks |\n|---|---:|---|---:|---:|---:|\n${tableRows}\n\n## Generated DDL\n\nThe exact generated DDL is stored in \`docs/postgresql-f3-schema.sql\`. It contains schema objects only and no production rows, credentials, paths, or environment values.\n\n## Residual risks\n\n- Repository SQL remains SQLite-specific and is not executed against these tables in F3.\n- PostgreSQL collation and case ordering can differ from SQLite.\n- Future schema changes need explicit type classification rather than name-only inference.\n- Formal migration still requires a write freeze so the final SQLite snapshot cannot drift.\n`;
}

function migrationReport({ source, snapshot, generated, validation, target, config, order }) {
  const rows = validation.tables.map((table) => `| \`${table.name}\` | ${table.rows} | ${table.columns} | ${table.sourceIndexes} | ${table.targetIndexes} | ${table.foreignKeys} | ${table.fullHashMatch ? "PASS" : "FAIL"} | ${table.keyHashMatch ? "PASS" : "FAIL"} |`).join("\n");
  return `# PostgreSQL Migration Test Report (F3)\n\nDate: 2026-07-20\nStatus: ${validation.ok ? "PASS" : "FAIL"}\n\n## Safety boundary\n\n- Source: official SQLite online-backup snapshot, opened read-only.\n- Target: \`${config.testDatabase}.${config.schema}\` only.\n- \`${config.database}\` was not connected to or modified by the F3 migration runner.\n- Production SQLite schema and rows were not modified.\n- Files, environment variables, and credentials were not migrated.\n- Active production provider remains \`sqlite\`.\n\n## Source inventory\n\n- SQLite version: ${source.sqliteVersion}\n- Source main database size at snapshot start: ${snapshot.sourceBytes} bytes\n- Snapshot size: ${snapshot.snapshotBytes} bytes\n- Snapshot SHA-256: \`${snapshot.snapshotHash}\`\n- Snapshot integrity: ${snapshot.integrity}\n- Snapshot foreign-key violations: ${snapshot.foreignKeyViolations}\n- Tables: ${source.tableCount}\n- Columns: ${source.columnCount}\n- Rows: ${source.rowCount}\n- Raw SQLite indexes: ${source.indexCount}\n- Logical foreign keys: ${logicalForeignKeyCount(source)}\n\n## Target inventory\n\n- PostgreSQL endpoint: ${config.host}:${config.port}\n- Database: \`${config.testDatabase}\`\n- Schema: \`${config.schema}\`\n- Migration role: \`${config.migratorUser}\`\n- Tables: ${target.tableCount}\n- Columns: ${target.columnCount}\n- Indexes: ${target.indexCount} (expected ${generated.expectedIndexCount})\n- Foreign keys: ${target.foreignKeyCount}\n- CHECK constraints: ${target.checkCount}\n- Insert order: ${order.map((name) => `\`${name}\``).join(" -> ")}\n\n## Consistency verification\n\n| Table | Rows | Columns | SQLite indexes | PostgreSQL indexes | FKs | Full-row hash | Key-field hash |\n|---|---:|---:|---:|---:|---:|---|---|\n${rows}\n\nAll row hashes are calculated after normalizing booleans, JSON key order, UUID case, UTC timestamps, dates, integers, and bigint strings. Hashes are reported only as match results in this table; no sensitive row values are included.\n\n## Key business table mapping\n\n- Requested \`scheduled_tasks\`: actual table \`scheduled_export_tasks\`.\n- Requested \`execution_records\`: actual tables \`scheduled_export_runs\` and \`scheduled_export_run_events\`.\n- File metadata: \`export_files\`, \`managed_files\`, \`file_lifecycle_scans\`, \`file_lifecycle_items\`, \`file_lifecycle_protected_files\`, \`file_quarantine_records\`.\n- Audit: \`operation_audit_events\`.\n- Mabang: \`mabang_account_profiles\`, \`mabang_filter_option_cache\`, scheduled task/run tables.\n\n## Result\n\n- Successful migrations: ${validation.tables.filter((table) => table.fullHashMatch && table.keyHashMatch).length}/${source.tableCount} tables.\n- Failed migrations: ${validation.failures.length}.\n- Failures: ${validation.failures.length ? validation.failures.map((failure) => `\`${failure}\``).join(", ") : "None"}.\n- Schema conversion: completed.\n- Data conversion: completed.\n- Index and constraint conversion: completed.\n- Full-row and key-field hash parity: ${validation.ok ? "passed" : "failed"}.\n\n## Risks before formal migration\n\n1. F3 proves schema and data portability, not business Repository compatibility; that belongs to F4.\n2. A formal migration requires stopping the web service and scheduler before the final snapshot.\n3. PostgreSQL timestamp and collation behavior must be covered by Repository-level tests.\n4. Identity sequences must be reset after explicit historical IDs are loaded.\n5. Physical files remain outside the database and require a separate file-integrity plan.\n6. PostgreSQL production permissions and backup/restore must be rechecked during the formal cutover.\n`;
}

export async function runF3Migration({ rootDir = process.cwd(), writeReports = false } = {}) {
  loadLocalEnv(rootDir);
  const activeProvider = String(process.env.DATABASE_PROVIDER || "sqlite").trim().toLowerCase();
  if (activeProvider !== "sqlite") throw new Error("F3 requires DATABASE_PROVIDER=sqlite");
  const runtime = resolveRuntimeConfig({ bootstrapRoot: rootDir, env: process.env });
  const config = loadPostgresqlF1Config({ rootDir });
  const provider = createPostgresqlProvider(config, { database: "test", role: "migrator" });
  assertMigrationTestTarget(config, provider);
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "commerce-ops-f3-"));
  const snapshotPath = path.join(temporaryRoot, "migration-source.sqlite");
  let snapshotDatabase;
  try {
    const snapshot = await createSqliteMigrationSnapshot({ sourcePath: runtime.databasePath, destinationPath: snapshotPath });
    if (snapshot.integrity !== "ok" || snapshot.foreignKeyViolations !== 0) throw new Error("F3 SQLite snapshot integrity check failed");
    snapshotDatabase = openReadOnlySqliteSnapshot(snapshotPath);
    const source = inspectSqliteSchema(snapshotDatabase);
    const generated = buildPostgresqlSchema(source, { schema: config.schema });
    const rowsByTable = new Map(source.tables.map((table) => [table.name, readNormalizedTableRows(snapshotDatabase, table)]));
    const order = await resetAndMigrate({ provider, config, source, generated, rowsByTable });
    const target = await inspectPostgresqlTarget(provider, source, config);
    const validation = validateMigration({ source, generated, rowsByTable, target });
    if (!validation.ok) throw new Error(`F3 migration consistency failed: ${validation.failures.join(",")}`);
    const result = {
      status: "PASS",
      activeProvider,
      config: publicPostgresqlF1Config(config),
      source: {
        sqliteVersion: source.sqliteVersion,
        tableCount: source.tableCount,
        columnCount: source.columnCount,
        rowCount: source.rowCount,
        indexCount: source.indexCount,
        foreignKeyCount: logicalForeignKeyCount(source),
        snapshot,
      },
      target: {
        database: config.testDatabase,
        schema: config.schema,
        tableCount: target.tableCount,
        columnCount: target.columnCount,
        indexCount: target.indexCount,
        foreignKeyCount: target.foreignKeyCount,
        checkCount: target.checkCount,
      },
      validation: {
        ok: validation.ok,
        failures: validation.failures,
        tables: validation.tables.map(({ fullHash, keyHash, ...table }) => table),
      },
    };
    if (writeReports) {
      await fs.writeFile(path.join(rootDir, "docs", "postgresql-f3-schema.sql"), `${generated.sql}\n`, "utf8");
      await fs.writeFile(path.join(rootDir, "docs", "postgresql-schema-conversion-report.md"), schemaConversionReport({ source, generated, snapshot }), "utf8");
      await fs.writeFile(path.join(rootDir, "docs", "postgresql-migration-test-report.md"), migrationReport({ source, snapshot, generated, validation, target, config, order }), "utf8");
    }
    return result;
  } finally {
    snapshotDatabase?.close();
    await provider.close();
    try { await fs.chmod(snapshotPath, 0o600); } catch {}
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function main() {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const result = await runF3Migration({ rootDir, writeReports: true });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (entry === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`PostgreSQL F3 migration test failed: ${String(error?.message || error).split(/\r?\n/)[0].slice(0, 400)}\n`);
    process.exitCode = 1;
  });
}
