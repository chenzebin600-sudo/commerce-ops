import crypto from "node:crypto";
import { buildPostgresqlSchema, inspectSqliteSchema, quoteIdentifier } from "../sqlite-migration.mjs";

export const SHADOW_DATABASE = "commerce_ops_shadow";
export const SHADOW_APP_SCHEMA = "app";
export const SHADOW_AI_SCHEMA = "ai_shadow";
export const SHADOW_META_SCHEMA = "shadow_meta";
export const SHADOW_CONTRACT_VERSION = "COMMERCE-OPS-PG-SHADOW-1.0.0";

const BIGINT_COLUMN = /(?:^|_)(?:file_)?size(?:_bytes)?$|_bytes$/;
const DATE_COLUMN = /(?:^|_)date$/;
const TIMESTAMP_COLUMN = /_at$|^(?:lease_until)$/;

const CORE_TABLES = new Set([
  "schema_migrations",
  "foundation_source_systems",
  "foundation_integration_accounts",
  "foundation_account_capabilities",
  "foundation_identity_links",
  "foundation_owners",
  "foundation_warehouses",
  "foundation_source_runs",
  "foundation_tasks",
  "foundation_task_events",
  "foundation_task_leases",
  "growth_source_batches",
  "growth_shops",
  "growth_shop_source_mappings",
  "growth_warehouse_country_mappings",
  "growth_order_headers",
  "growth_order_lines",
  "growth_order_inventory_links",
  "growth_inventory_snapshots",
  "growth_sku_warehouse_sales_metrics",
  "scheduled_export_tasks",
  "scheduled_export_runs",
  "scheduled_export_run_events",
  "scheduler_leases",
  "operation_audit_events",
]);

function hash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function declaredLogicalType(table, column) {
  const declared = String(column.type || "").toUpperCase();
  if (table.autoIncrement && column.pk) return "identity";
  if (declared === "INTEGER") return BIGINT_COLUMN.test(column.name) ? "bigint" : "integer";
  if (["REAL", "FLOAT", "DOUBLE"].includes(declared)) return "double";
  if (["NUMERIC", "DECIMAL"].includes(declared)) return "numeric";
  if (declared === "BLOB") return "binary";
  if (column.name.endsWith("_json")) return "json";
  if (DATE_COLUMN.test(column.name)) return "date";
  if (TIMESTAMP_COLUMN.test(column.name)) return "timestamp";
  return "text";
}

function sourceWithExplicitTypes(database) {
  const source = inspectSqliteSchema(database);
  source.tables = source.tables.map((table) => ({
    ...table,
    columns: table.columns.map((column) => ({
      ...column,
      logicalType: declaredLogicalType(table, column),
    })),
  }));
  return source;
}

function expressionIndexSql(schema, table, index) {
  if (index.name !== "uq_price_control_one_running_sync") {
    throw new Error(`Unsupported SQLite expression index in Shadow Phase 1: ${index.name}`);
  }
  return `CREATE UNIQUE INDEX ${quoteIdentifier(index.name)} ON ${quoteIdentifier(schema)}.${quoteIdentifier(table.name)} ((1)) WHERE status='RUNNING';`;
}

function qualifyViewSql(sql, schema, viewName) {
  const prefix = new RegExp(`^CREATE\\s+VIEW\\s+${viewName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+AS`, "i");
  if (!prefix.test(sql)) throw new Error(`Unexpected SQLite view definition: ${viewName}`);
  return `${sql.replace(prefix, `CREATE VIEW ${quoteIdentifier(schema)}.${quoteIdentifier(viewName)} AS`).trim().replace(/;$/, "")};`;
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
    if (!available.length) throw new Error("Shadow view graph contains a cycle");
    for (const view of available) {
      pending.delete(view.name);
      emitted.add(view.name);
      ordered.push(view);
    }
  }
  return ordered;
}

export function buildShadowSchema(database, { schema = SHADOW_APP_SCHEMA } = {}) {
  const source = sourceWithExplicitTypes(database);
  const expressionIndexes = [];
  const portableSource = {
    ...source,
    tables: source.tables.map((table) => ({
      ...table,
      indexes: table.indexes.filter((index) => {
        const expression = index.columns.some((column) => !column.name || column.expression);
        if (expression && index.origin === "c") expressionIndexes.push({ table, index });
        return !expression;
      }),
    })),
  };
  const generated = buildPostgresqlSchema(portableSource, { schema });
  const views = database.prepare("SELECT name,sql FROM sqlite_master WHERE type='view' ORDER BY name").all();
  const viewStatements = orderViews(views).map((view) => qualifyViewSql(view.sql, schema, view.name));
  const deferredIndexStatements = expressionIndexes.map(({ table, index }) => expressionIndexSql(schema, table, index));
  const tableSql = generated.tableStatements.join("\n\n");
  const deferredSql = [
    ...generated.foreignKeyStatements,
    ...generated.indexStatements,
    ...deferredIndexStatements,
    ...viewStatements,
  ].join("\n\n");
  const contract = {
    contractVersion: SHADOW_CONTRACT_VERSION,
    sourceDialect: "sqlite",
    targetDialect: "postgresql",
    schema,
    tables: source.tables.map((table) => ({
      name: table.name,
      rowCount: table.rowCount,
      primaryKey: table.primaryKey,
      columns: table.columns.map((column) => ({
        name: column.name,
        declaredType: column.type,
        logicalType: column.logicalType,
        nullable: !column.notnull && !column.pk,
        primaryKeyPosition: column.pk,
      })),
      foreignKeyCount: new Set(table.foreignKeys.map((foreignKey) => foreignKey.id)).size,
      explicitIndexCount: table.indexes.filter((index) => index.origin === "c").length,
      uniqueConstraintCount: table.indexes.filter((index) => index.origin === "u").length,
      checkCount: table.checks.length,
    })),
    views: views.map((view) => view.name),
    expressionIndexes: expressionIndexes.map(({ index }) => index.name),
  };
  contract.contractSha256 = hash(JSON.stringify(contract));
  return {
    source,
    contract,
    tableSql,
    deferredSql,
    expected: {
      tables: source.tableCount,
      columns: source.columnCount,
      views: views.length,
      foreignKeys: source.tables.reduce((sum, table) => sum + new Set(table.foreignKeys.map((row) => row.id)).size, 0),
      indexes: generated.expectedIndexCount + expressionIndexes.length,
    },
  };
}

export function selectShadowDataTables(source) {
  const byName = new Map(source.tables.map((table) => [table.name, table]));
  const selected = new Set(source.tables.filter((table) => table.name.startsWith("product_")).map((table) => table.name));
  for (const table of CORE_TABLES) if (byName.has(table)) selected.add(table);
  let changed = true;
  while (changed) {
    changed = false;
    for (const tableName of [...selected]) {
      for (const foreignKey of byName.get(tableName).foreignKeys) {
        if (!selected.has(foreignKey.table)) {
          selected.add(foreignKey.table);
          changed = true;
        }
      }
    }
  }
  return [...selected].sort();
}

export function shadowSchemaMigrationsSql() {
  return `CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(SHADOW_META_SCHEMA)};\n\nCREATE TABLE IF NOT EXISTS ${quoteIdentifier(SHADOW_META_SCHEMA)}.schema_migrations (\n  version text PRIMARY KEY,\n  sha256 text NOT NULL,\n  applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP\n);\n\nCREATE TABLE IF NOT EXISTS ${quoteIdentifier(SHADOW_META_SCHEMA)}.table_loads (\n  table_name text PRIMARY KEY,\n  source_row_count bigint NOT NULL,\n  target_row_count bigint NOT NULL,\n  source_snapshot_sha256 text NOT NULL,\n  status text NOT NULL CHECK (status IN ('SUCCEEDED','FAILED')),\n  loaded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP\n);`;
}
