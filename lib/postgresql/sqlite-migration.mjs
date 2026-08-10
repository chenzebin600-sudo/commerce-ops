import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { backup, DatabaseSync } from "node:sqlite";

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const BOOLEAN_COLUMNS = new Set([
  "enabled", "notify_on_success", "notify_on_failure", "notify_on_empty", "at_all",
  "notify_enabled", "catch_up_enabled", "notify_on_change", "truncated", "suggest_quarantine", "suggest_cleanup",
]);

export const TEXT_IDENTIFIER_COLUMNS = new Set([
  "request_id",
  "shop_id",
  "platform_category_id",
  "platform_product_id",
  "platform_listing_id",
]);

function identifier(value) {
  const normalized = String(value || "");
  if (!IDENTIFIER_PATTERN.test(normalized)) throw new TypeError("Database schema identifier is invalid");
  return normalized;
}

export function quoteIdentifier(value) {
  return `"${identifier(value)}"`;
}

function qualified(schema, table) {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function fileSha256(filePath) {
  const digest = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    createReadStream(filePath)
      .on("data", (chunk) => digest.update(chunk))
      .on("end", resolve)
      .on("error", reject);
  });
  return digest.digest("hex");
}

function extractCheckExpressions(sql) {
  const expressions = [];
  const source = String(sql || "");
  const pattern = /\bCHECK\s*\(/gi;
  let match;
  while ((match = pattern.exec(source))) {
    const start = pattern.lastIndex;
    let depth = 1;
    let quote = null;
    let index = start;
    for (; index < source.length && depth > 0; index += 1) {
      const character = source[index];
      if (quote) {
        if (character === quote) {
          if (source[index + 1] === quote) index += 1;
          else quote = null;
        }
        continue;
      }
      if (character === "'" || character === '"') quote = character;
      else if (character === "(") depth += 1;
      else if (character === ")") depth -= 1;
    }
    if (depth !== 0) throw new Error("SQLite CHECK constraint is unbalanced");
    expressions.push(source.slice(start, index - 1).trim());
    pattern.lastIndex = index;
  }
  return expressions;
}

function translatedCheck(expression, booleanColumns) {
  let translated = expression;
  for (const column of booleanColumns) {
    const escaped = column.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    translated = translated.replace(new RegExp(`\\b${escaped}\\s+IN\\s*\\(\\s*0\\s*,\\s*1\\s*\\)`, "gi"), `${quoteIdentifier(column)} IN (FALSE, TRUE)`);
  }
  return translated;
}

function indexPredicate(sql) {
  const match = String(sql || "").match(/\bWHERE\b([\s\S]+)$/i);
  return match ? match[1].trim() : null;
}

function groupBy(values, key) {
  const groups = new Map();
  for (const value of values) {
    const groupKey = value[key];
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(value);
  }
  return [...groups.values()];
}

function isUuidColumn(table, column) {
  if (column.type.toUpperCase() !== "TEXT") return false;
  if (table === "schema_migrations" || table === "scheduler_leases") return false;
  if (TEXT_IDENTIFIER_COLUMNS.has(column.name)) return false;
  return column.name === "id" || column.name.endsWith("_id");
}

function isDateColumn(column) {
  return column.name.endsWith("_date");
}

function isTimestampColumn(column) {
  return column.name.endsWith("_at") || column.name === "lease_until";
}

function isBigintColumn(column) {
  return /(?:^|_)(?:file_)?size(?:_bytes)?$/.test(column.name) || column.name.endsWith("_bytes");
}

function constrainedToBoolean(column, checks) {
  if (BOOLEAN_COLUMNS.has(column.name)) return true;
  const escaped = column.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return checks.some((expression) => new RegExp(
    `\\b${escaped}\\b\\s+IN\\s*\\(\\s*0\\s*,\\s*1\\s*\\)`,
    "i",
  ).test(expression));
}

function logicalType(table, column, autoIncrement, checks = []) {
  const declared = column.type.toUpperCase();
  if (autoIncrement && column.pk) return "identity";
  if (declared === "INTEGER" && constrainedToBoolean(column, checks)) return "boolean";
  if (declared === "INTEGER" && isBigintColumn(column)) return "bigint";
  if (declared === "INTEGER") return "integer";
  if (declared === "REAL" || declared === "FLOAT" || declared === "DOUBLE") return "double";
  if (declared === "NUMERIC" || declared === "DECIMAL") return "numeric";
  if (declared === "BLOB") return "binary";
  if (column.name.endsWith("_json")) return "json";
  if (isUuidColumn(table, column)) return "uuid";
  if (isDateColumn(column)) return "date";
  if (isTimestampColumn(column)) return "timestamp";
  return "text";
}

function refineUuidLogicalTypes(database, tables) {
  for (const table of tables) {
    const candidates = table.columns.filter((column) => column.logicalType === "uuid");
    if (!candidates.length || table.rowCount === 0) continue;
    const projection = candidates.map((column) => quoteIdentifier(column.name)).join(", ");
    const invalid = new Set();
    for (const row of database.prepare(`SELECT ${projection} FROM ${quoteIdentifier(table.name)}`).iterate()) {
      for (const column of candidates) {
        const value = row[column.name];
        if (value !== null && value !== undefined && !UUID_PATTERN.test(String(value))) invalid.add(column.name);
      }
      if (invalid.size === candidates.length) break;
    }
    for (const column of candidates) {
      if (invalid.has(column.name)) column.logicalType = "text";
    }
  }

  const byName = new Map(tables.map((table) => [table.name, table]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const table of tables) {
      for (const foreignKey of table.foreignKeys) {
        const referencedTable = byName.get(foreignKey.table);
        const sourceColumn = table.columns.find((column) => column.name === foreignKey.from);
        const referencedColumn = referencedTable?.columns.find((column) => column.name === foreignKey.to);
        if (!sourceColumn || !referencedColumn) continue;
        const bothDeclaredText = String(sourceColumn.type).toUpperCase() === "TEXT"
          && String(referencedColumn.type).toUpperCase() === "TEXT";
        const uuidTextMismatch = new Set([sourceColumn.logicalType, referencedColumn.logicalType]);
        if (bothDeclaredText && uuidTextMismatch.has("uuid") && uuidTextMismatch.has("text")) {
          sourceColumn.logicalType = "text";
          referencedColumn.logicalType = "text";
          changed = true;
        }
      }
    }
  }
}

function postgresqlType(type) {
  switch (type) {
    case "identity": return "bigint GENERATED BY DEFAULT AS IDENTITY";
    case "boolean": return "boolean";
    case "integer": return "integer";
    case "bigint": return "bigint";
    case "double": return "double precision";
    case "numeric": return "numeric";
    case "binary": return "bytea";
    case "json": return "jsonb";
    case "uuid": return "uuid";
    case "date": return "date";
    case "timestamp": return "timestamptz";
    case "text": return "text";
    default: throw new TypeError(`Unsupported logical type: ${type}`);
  }
}

function defaultExpression(column) {
  const value = column.dflt_value;
  if (value === null || value === undefined || column.logicalType === "identity") return null;
  if (column.logicalType === "boolean") {
    if (String(value) === "1") return "TRUE";
    if (String(value) === "0") return "FALSE";
    throw new Error(`Unsupported SQLite boolean default for ${column.name}`);
  }
  if (column.logicalType === "json") return `${value}::jsonb`;
  if (column.logicalType === "timestamp" && /datetime\s*\(\s*'now'\s*\)/i.test(String(value))) return "CURRENT_TIMESTAMP";
  return String(value);
}

export function inspectSqliteSchema(database, { verifyUuidValues = false } = {}) {
  const tableRows = database.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const views = database.prepare("SELECT name,sql FROM sqlite_master WHERE type='view' ORDER BY name").all();
  const tables = tableRows.map(({ name, sql }) => {
    identifier(name);
    const autoIncrement = /\bAUTOINCREMENT\b/i.test(sql || "");
    const checks = extractCheckExpressions(sql);
    const columns = database.prepare(`PRAGMA table_info('${name}')`).all().map((column) => ({
      ...column,
      logicalType: logicalType(name, column, autoIncrement, checks),
    }));
    const indexes = database.prepare(`PRAGMA index_list('${name}')`).all().map((index) => ({
      ...index,
      columns: database.prepare(`PRAGMA index_xinfo('${index.name}')`).all()
        .filter((entry) => Number(entry.key) === 1)
        .map((entry) => ({ name: entry.name, expression: Number(entry.cid) === -2, desc: Boolean(entry.desc) })),
      sql: database.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?").get(index.name)?.sql || null,
    }));
    const foreignKeys = database.prepare(`PRAGMA foreign_key_list('${name}')`).all();
    const primaryKey = columns.filter((column) => column.pk).sort((left, right) => left.pk - right.pk).map((column) => column.name);
    return {
      name,
      sql,
      autoIncrement,
      columns,
      primaryKey,
      checks,
      indexes,
      foreignKeys,
      rowCount: Number(database.prepare(`SELECT count(*) count FROM ${quoteIdentifier(name)}`).get().count),
    };
  });
  const sqliteVersion = database.prepare("SELECT sqlite_version() version").get().version;
  if (verifyUuidValues) refineUuidLogicalTypes(database, tables);
  return {
    sqliteVersion,
    tables,
    tableCount: tables.length,
    columnCount: tables.reduce((sum, table) => sum + table.columns.length, 0),
    rowCount: tables.reduce((sum, table) => sum + table.rowCount, 0),
    indexCount: tables.reduce((sum, table) => sum + table.indexes.length, 0),
    foreignKeyCount: tables.reduce((sum, table) => sum + table.foreignKeys.length, 0),
    views,
    viewCount: views.length,
  };
}

function createTableSql(schema, table) {
  const booleanColumns = table.columns.filter((column) => column.logicalType === "boolean").map((column) => column.name);
  const definitions = table.columns.map((column) => {
    const parts = [quoteIdentifier(column.name), postgresqlType(column.logicalType)];
    if (column.notnull && !column.pk) parts.push("NOT NULL");
    const convertedDefault = defaultExpression(column);
    if (convertedDefault) parts.push(`DEFAULT ${convertedDefault}`);
    return `  ${parts.join(" ")}`;
  });
  if (table.primaryKey.length) definitions.push(`  PRIMARY KEY (${table.primaryKey.map(quoteIdentifier).join(", ")})`);
  for (const index of table.indexes.filter((entry) => entry.origin === "u")) {
    if (index.columns.some((column) => !column.name || column.expression)) throw new Error(`Unsupported unique index on ${table.name}`);
    definitions.push(`  UNIQUE (${index.columns.map((column) => quoteIdentifier(column.name)).join(", ")})`);
  }
  for (const check of table.checks) definitions.push(`  CHECK (${translatedCheck(check, booleanColumns)})`);
  return `CREATE TABLE ${qualified(schema, table.name)} (\n${definitions.join(",\n")}\n);`;
}

function foreignKeySql(schema, table, rows, index) {
  const ordered = [...rows].sort((left, right) => left.seq - right.seq);
  const referencedTable = ordered[0].table;
  const onUpdate = String(ordered[0].on_update || "NO ACTION").toUpperCase();
  const onDelete = String(ordered[0].on_delete || "NO ACTION").toUpperCase();
  const name = `fk_${table.name}_${index + 1}`;
  return `ALTER TABLE ${qualified(schema, table.name)} ADD CONSTRAINT ${quoteIdentifier(name)} FOREIGN KEY (${ordered.map((row) => quoteIdentifier(row.from)).join(", ")}) REFERENCES ${qualified(schema, referencedTable)} (${ordered.map((row) => quoteIdentifier(row.to)).join(", ")}) ON UPDATE ${onUpdate} ON DELETE ${onDelete};`;
}

function createIndexSql(schema, table, index) {
  const unique = index.unique ? "UNIQUE " : "";
  const columns = index.columns.map((column) => {
    if (!column.name || column.expression) {
      if (index.name !== "uq_price_control_one_running_sync" || !/\(\s*\(\s*1\s*\)\s*\)/.test(String(index.sql || ""))) {
        throw new Error(`Expression index is not supported in F3: ${index.name}`);
      }
      return `(1)${column.desc ? " DESC" : ""}`;
    }
    return `${quoteIdentifier(column.name)}${column.desc ? " DESC" : ""}`;
  }).join(", ");
  const predicate = indexPredicate(index.sql);
  return `CREATE ${unique}INDEX ${quoteIdentifier(index.name)} ON ${qualified(schema, table.name)} (${columns})${predicate ? ` WHERE ${predicate}` : ""};`;
}

function qualifyViewSql(sql, schema, viewName) {
  const escaped = viewName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const prefix = new RegExp(`^CREATE\\s+VIEW\\s+${escaped}\\s+AS`, "i");
  if (!prefix.test(String(sql || ""))) throw new Error(`Unexpected SQLite view definition: ${viewName}`);
  return `${sql.replace(prefix, `CREATE VIEW ${qualified(schema, viewName)} AS`).trim().replace(/;$/, "")};`;
}

function orderViews(views) {
  const names = new Set(views.map((view) => view.name));
  const pending = new Map(views.map((view) => [view.name, view]));
  const emitted = new Set();
  const ordered = [];
  while (pending.size) {
    const available = [...pending.values()].filter((view) => {
      const dependencies = [...names].filter((name) => name !== view.name && new RegExp(`\\b${name}\\b`, "i").test(view.sql));
      return dependencies.every((name) => emitted.has(name));
    }).sort((left, right) => left.name.localeCompare(right.name));
    if (!available.length) throw new Error("SQLite view graph contains a cycle");
    for (const view of available) {
      pending.delete(view.name);
      emitted.add(view.name);
      ordered.push(view);
    }
  }
  return ordered;
}

export function buildPostgresqlSchema(source, { schema = "app" } = {}) {
  identifier(schema);
  const tableStatements = source.tables.map((table) => createTableSql(schema, table));
  const foreignKeyStatements = source.tables.flatMap((table) => groupBy(table.foreignKeys, "id")
    .map((rows, index) => foreignKeySql(schema, table, rows, index)));
  const indexStatements = source.tables.flatMap((table) => table.indexes.filter((index) => index.origin === "c")
    .map((index) => createIndexSql(schema, table, index)));
  const viewStatements = orderViews(source.views || []).map((view) => qualifyViewSql(view.sql, schema, view.name));
  const expectedIndexCount = source.tables.reduce((sum, table) => sum
    + (table.primaryKey.length ? 1 : 0)
    + table.indexes.filter((index) => index.origin === "u").length
    + table.indexes.filter((index) => index.origin === "c").length, 0);
  return {
    schema,
    tableStatements,
    foreignKeyStatements,
    indexStatements,
    viewStatements,
    expectedIndexCount,
    expectedViewCount: viewStatements.length,
    sql: [...tableStatements, ...foreignKeyStatements, ...indexStatements, ...viewStatements].join("\n\n"),
  };
}

function normalizeTimestamp(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError("SQLite timestamp cannot be converted");
    return value.toISOString();
  }
  const text = String(value);
  const explicitUtc = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text)
    ? `${text.replace(" ", "T")}Z`
    : text;
  const date = new Date(explicitUtc);
  if (Number.isNaN(date.getTime())) throw new TypeError("SQLite timestamp cannot be converted");
  return date.toISOString();
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === "object" && !(value instanceof Date) && !Buffer.isBuffer(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJson(value[key])]));
  }
  return value;
}

export function normalizeMigrationValue(value, column) {
  if (value === null || value === undefined) return null;
  switch (column.logicalType) {
    case "boolean": {
      if (value === true || value === 1 || value === "1") return true;
      if (value === false || value === 0 || value === "0") return false;
      throw new TypeError(`Invalid boolean in ${column.name}`);
    }
    case "json": {
      const parsed = typeof value === "string" ? JSON.parse(value) : value;
      return stableJson(parsed);
    }
    case "uuid": {
      const normalized = String(value).toLowerCase();
      if (!UUID_PATTERN.test(normalized)) throw new TypeError(`Invalid UUID in ${column.name}`);
      return normalized;
    }
    case "timestamp": return normalizeTimestamp(value);
    case "date": {
      const normalized = value instanceof Date
        ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`
        : String(value).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) throw new TypeError(`Invalid date in ${column.name}`);
      return normalized;
    }
    case "identity":
    case "integer": {
      const number = Number(value);
      if (!Number.isSafeInteger(number)) throw new TypeError(`Invalid integer in ${column.name}`);
      return number;
    }
    case "bigint": return String(value);
    case "double":
    case "numeric": return Number(value);
    case "binary": return Buffer.from(value);
    case "text": return String(value);
    default: throw new TypeError(`Unsupported migration type: ${column.logicalType}`);
  }
}

export function normalizePostgresqlMigrationValue(value, column) {
  if (value === null || value === undefined) return null;
  return column.logicalType === "json" ? stableJson(value) : normalizeMigrationValue(value, column);
}

export function encodePostgresqlMigrationValue(value, column) {
  if (value === null || value === undefined) return null;
  const normalized = normalizeMigrationValue(value, column);
  return encodeNormalizedPostgresqlMigrationValue(normalized, column);
}

export function encodeNormalizedPostgresqlMigrationValue(value, column) {
  if (value === null || value === undefined) return null;
  return column.logicalType === "json" ? JSON.stringify(value) : value;
}

export function readNormalizedTableRows(database, table) {
  const projection = table.columns.map((column) => quoteIdentifier(column.name)).join(", ");
  const rows = database.prepare(`SELECT ${projection} FROM ${quoteIdentifier(table.name)}`).all();
  return rows.map((row) => Object.fromEntries(table.columns.map((column) => [column.name, normalizeMigrationValue(row[column.name], column)])));
}

export function* readNormalizedTableBatches(database, table, { batchSize = 250 } = {}) {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new TypeError("SQLite migration batch size must be a positive integer");
  }
  const projection = table.columns.map((column) => quoteIdentifier(column.name)).join(", ");
  const rows = database.prepare(`SELECT ${projection} FROM ${quoteIdentifier(table.name)}`).iterate();
  let batch = [];
  for (const row of rows) {
    const normalized = {};
    for (const column of table.columns) {
      try {
        normalized[column.name] = normalizeMigrationValue(row[column.name], column);
      } catch (error) {
        error.table ||= table.name;
        error.column ||= column.name;
        throw error;
      }
    }
    batch.push(normalized);
    if (batch.length === batchSize) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length) yield batch;
}

function digestKeyColumns(table) {
  const columns = table.columns.filter((column) => column.pk || column.name.endsWith("_id")
    || column.name.endsWith("_at") || column.name.endsWith("_date")
    || column.name === "status" || column.name === "version");
  return columns.length ? columns : table.columns.slice(0, 1);
}

const DIGEST_MODULUS = 1n << 256n;

function createMultisetDigestState() {
  return { count: 0, xor: Buffer.alloc(32), sum: 0n };
}

function addMultisetDigestValue(state, value) {
  const digest = crypto.createHash("sha256").update(JSON.stringify(value)).digest();
  state.count += 1;
  state.sum = (state.sum + BigInt(`0x${digest.toString("hex")}`)) % DIGEST_MODULUS;
  for (let index = 0; index < digest.length; index += 1) state.xor[index] ^= digest[index];
}

function finishMultisetDigest(state) {
  return sha256(JSON.stringify({
    version: "sha256-multiset-v1",
    count: state.count,
    xor: state.xor.toString("hex"),
    sum: state.sum.toString(16).padStart(64, "0"),
  }));
}

export function createTableDigestAccumulator(table, { valuesAreNormalized = false } = {}) {
  const keyColumns = digestKeyColumns(table);
  const fullState = createMultisetDigestState();
  const keyState = createMultisetDigestState();
  return Object.freeze({
    add(row) {
      const normalized = table.columns.map((column) => (
        valuesAreNormalized ? row[column.name] : normalizeMigrationValue(row[column.name], column)
      ));
      const byName = new Map(table.columns.map((column, index) => [column.name, normalized[index]]));
      addMultisetDigestValue(fullState, normalized);
      addMultisetDigestValue(keyState, keyColumns.map((column) => byName.get(column.name)));
    },
    addMany(rows) {
      for (const row of rows) this.add(row);
    },
    finish() {
      return Object.freeze({
        version: "sha256-multiset-v1",
        rowCount: fullState.count,
        full: finishMultisetDigest(fullState),
        keys: finishMultisetDigest(keyState),
        keyColumns: keyColumns.map((column) => column.name),
      });
    },
  });
}

function canonicalRows(rows, table, selectedColumns = table.columns, valuesAreNormalized = false) {
  const normalized = rows.map((row) => selectedColumns.map((column) => (
    valuesAreNormalized ? row[column.name] : normalizeMigrationValue(row[column.name], column)
  )));
  normalized.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return normalized;
}

export function tableDigests(rows, table, { valuesAreNormalized = false } = {}) {
  const selected = digestKeyColumns(table);
  return {
    full: sha256(JSON.stringify(canonicalRows(rows, table, table.columns, valuesAreNormalized))),
    keys: sha256(JSON.stringify(canonicalRows(rows, table, selected, valuesAreNormalized))),
    keyColumns: selected.map((column) => column.name),
  };
}

export function tableInsertSql(schema, table, provider) {
  const columns = table.columns.map((column) => quoteIdentifier(column.name));
  const placeholders = columns.map((_, index) => provider.placeholder(index + 1));
  return `INSERT INTO ${qualified(schema, table.name)} (${columns.join(", ")}) VALUES (${placeholders.join(", ")})`;
}

export function tableBatchInsertSql(schema, table, provider, rowCount) {
  if (!Number.isInteger(rowCount) || rowCount < 1) {
    throw new TypeError("PostgreSQL migration insert batch must contain at least one row");
  }
  const columns = table.columns.map((column) => quoteIdentifier(column.name));
  let parameter = 1;
  const rows = Array.from({ length: rowCount }, () => {
    const placeholders = columns.map(() => provider.placeholder(parameter++));
    return `(${placeholders.join(", ")})`;
  });
  return `INSERT INTO ${qualified(schema, table.name)} (${columns.join(", ")}) VALUES ${rows.join(", ")}`;
}

export function topologicalTableOrder(source) {
  const tables = new Map(source.tables.map((table) => [table.name, table]));
  const pending = new Set(tables.keys());
  const resolved = new Set();
  const order = [];
  while (pending.size) {
    const available = [...pending].filter((name) => tables.get(name).foreignKeys.every((foreignKey) => resolved.has(foreignKey.table)));
    if (!available.length) throw new Error("SQLite foreign-key graph contains a cycle");
    available.sort();
    for (const name of available) {
      pending.delete(name);
      resolved.add(name);
      order.push(name);
    }
  }
  return order;
}

export function assertMigrationTestTarget(config, provider) {
  if (config.database === config.testDatabase || provider.database !== config.testDatabase || provider.database === config.database) {
    throw new Error("F3 may only write to the PostgreSQL migration test database");
  }
}

export async function createSqliteMigrationSnapshot({
  sourcePath,
  destinationPath,
  backupRatePages = 100,
  pinReadSnapshot = false,
}) {
  if (!Number.isInteger(backupRatePages) || backupRatePages < 1) {
    throw new TypeError("SQLite backup rate must be a positive integer");
  }
  const before = await fs.stat(sourcePath);
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    source.exec("PRAGMA query_only=ON");
    if (pinReadSnapshot) {
      source.exec("BEGIN");
      source.prepare("SELECT count(*) total FROM sqlite_schema").get();
    }
    await backup(source, destinationPath, { rate: backupRatePages });
  } finally {
    if (pinReadSnapshot) {
      try { source.exec("ROLLBACK"); } catch {}
    }
    source.close();
  }
  await fs.chmod(destinationPath, 0o444);
  const snapshot = new DatabaseSync(destinationPath, { readOnly: true });
  try {
    const integrity = snapshot.prepare("PRAGMA integrity_check").get().integrity_check;
    const foreignKeyViolations = snapshot.prepare("PRAGMA foreign_key_check").all().length;
    const after = await fs.stat(destinationPath);
    return {
      sourceBytes: before.size,
      snapshotBytes: after.size,
      snapshotHash: await fileSha256(destinationPath),
      integrity,
      foreignKeyViolations,
      readOnly: true,
    };
  } finally {
    snapshot.close();
  }
}

export function openReadOnlySqliteSnapshot(snapshotPath) {
  return new DatabaseSync(snapshotPath, { readOnly: true });
}
