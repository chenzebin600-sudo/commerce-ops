import crypto from "node:crypto";
import {
  normalizeMigrationValue,
  normalizePostgresqlMigrationValue,
  quoteIdentifier,
} from "../sqlite-migration.mjs";
import { DELETE_RECONCILIATION_MODES } from "./delete-policy.mjs";

const CORE_SAMPLE_TABLES = Object.freeze({
  product_skus: Object.freeze(["id", "source_sku", "normalized_sku", "source_main_sku", "updated_at"]),
  growth_order_headers: Object.freeze(["id", "source_order_id", "source_shop_name", "order_status", "effective_status", "updated_at"]),
  growth_order_lines: Object.freeze(["id", "order_header_id", "source_sku", "quantity", "effective_status", "updated_at"]),
  growth_inventory_snapshots: Object.freeze(["id", "batch_id", "source_sku", "warehouse_name", "available_quantity", "created_at"]),
  foundation_tasks: Object.freeze(["id", "domain", "task_kind", "state", "priority", "updated_at"]),
  operation_audit_events: Object.freeze(["id", "request_id", "module", "action", "status", "occurred_at"]),
});

function qualified(tableName) {
  return `${quoteIdentifier("app")}.${quoteIdentifier(tableName)}`;
}

function sourceCount(database, tableName) {
  return Number(database.prepare(`SELECT count(*) total FROM ${quoteIdentifier(tableName)}`).get().total);
}

async function targetCount(provider, tableName) {
  return Number((await provider.query(`SELECT count(*) total FROM ${qualified(tableName)}`)).rows[0].total);
}

function seededOffsets(tableName, count, sampleSize) {
  if (!count) return [];
  const offsets = new Set([0, Math.floor(count / 2), count - 1]);
  let seed = crypto.createHash("sha256").update(`${tableName}:${count}`).digest().readUInt32BE(0);
  while (offsets.size < Math.min(sampleSize, count)) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    offsets.add(seed % count);
  }
  return [...offsets].sort((left, right) => left - right);
}

function normalizeSourceRow(row, table, selectedColumns) {
  return Object.fromEntries(selectedColumns.map((name) => {
    const column = table.columns.find((candidate) => candidate.name === name);
    return [name, normalizeMigrationValue(row[name], column)];
  }));
}

function normalizeTargetRow(row, table, selectedColumns) {
  return Object.fromEntries(selectedColumns.map((name) => {
    const column = table.columns.find((candidate) => candidate.name === name);
    return [name, normalizePostgresqlMigrationValue(row[name], column)];
  }));
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object" && !(value instanceof Date) && !Buffer.isBuffer(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value instanceof Date ? value.toISOString() : value;
}

function equal(left, right) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

async function sampleTable({ sourceDatabase, provider, spec, sampleSize }) {
  const selectedColumns = [...new Set([
    ...spec.primaryKey,
    ...(CORE_SAMPLE_TABLES[spec.name] || spec.table.columns.slice(0, 6).map((column) => column.name)),
  ])];
  const count = sourceCount(sourceDatabase, spec.name);
  const order = spec.primaryKey.map(quoteIdentifier).join(",");
  const samples = [];
  for (const offset of seededOffsets(spec.name, count, sampleSize)) {
    const sourceRow = sourceDatabase.prepare(`
      SELECT ${selectedColumns.map(quoteIdentifier).join(",")}
      FROM ${quoteIdentifier(spec.name)} ORDER BY ${order} LIMIT 1 OFFSET ?
    `).get(offset);
    const primaryKey = Object.fromEntries(spec.primaryKey.map((name) => [name, sourceRow[name]]));
    const values = spec.primaryKey.map((name) => sourceRow[name]);
    const where = spec.primaryKey.map((name, index) => `${quoteIdentifier(name)}=$${index + 1}`).join(" AND ");
    const targetRow = (await provider.query(`
      SELECT ${selectedColumns.map(quoteIdentifier).join(",")}
      FROM ${qualified(spec.name)} WHERE ${where}
    `, values)).rows[0] || null;
    const normalizedSource = normalizeSourceRow(sourceRow, spec.table, selectedColumns);
    const normalizedTarget = targetRow ? normalizeTargetRow(targetRow, spec.table, selectedColumns) : null;
    samples.push({
      offset,
      primaryKey: normalizeSourceRow(primaryKey, spec.table, spec.primaryKey),
      match: Boolean(targetRow) && equal(normalizedSource, normalizedTarget),
      source: normalizedSource,
      target: normalizedTarget,
    });
  }
  return samples;
}

async function businessCounts(sourceDatabase, provider) {
  const metrics = [
    ["productSkus", "product_skus"],
    ["orderHeaders", "growth_order_headers"],
    ["orderLines", "growth_order_lines"],
    ["inventorySnapshots", "growth_inventory_snapshots"],
    ["tasks", "foundation_tasks"],
    ["auditEvents", "operation_audit_events"],
  ];
  const result = {};
  for (const [metric, table] of metrics) {
    const source = sourceCount(sourceDatabase, table);
    const target = await targetCount(provider, table);
    result[metric] = { source, target, match: source === target };
  }
  return result;
}

export class MigrationSyncValidator {
  constructor({
    sourceDatabase,
    provider,
    manifest,
    sampleSize = 7,
    deletePolicy = Object.freeze({ mode: DELETE_RECONCILIATION_MODES.BLOCK, executesDeletes: false }),
  }) {
    if (!sourceDatabase || !provider || !manifest?.length) throw new TypeError("Migration validator configuration is incomplete");
    this.sourceDatabase = sourceDatabase;
    this.provider = provider;
    this.manifest = manifest;
    this.sampleSize = sampleSize;
    this.deletePolicy = deletePolicy;
  }

  async validate({ sourceSnapshotTime, sourceSnapshotSha256 }) {
    const tables = [];
    for (const spec of this.manifest) {
      const source = sourceCount(this.sourceDatabase, spec.name);
      const target = await targetCount(this.provider, spec.name);
      tables.push({
        table: spec.name,
        domain: spec.domain,
        source,
        target,
        countMatch: source === target,
        targetExcess: Math.max(0, target - source),
        sourceMissing: Math.max(0, source - target),
        deleteSyncSupported: true,
        deleteMode: this.deletePolicy.mode,
      });
    }

    const samples = {};
    for (const tableName of Object.keys(CORE_SAMPLE_TABLES)) {
      const spec = this.manifest.find((candidate) => candidate.name === tableName);
      if (spec) samples[tableName] = await sampleTable({
        sourceDatabase: this.sourceDatabase,
        provider: this.provider,
        spec,
        sampleSize: this.sampleSize,
      });
    }
    const allSamples = Object.values(samples).flat();
    const business = await businessCounts(this.sourceDatabase, this.provider);
    const countFailures = tables.filter((table) => !table.countMatch).length;
    const sampleFailures = allSamples.filter((sample) => !sample.match).length;
    const businessFailures = Object.values(business).filter((metric) => !metric.match).length;
    return {
      status: countFailures === 0 && sampleFailures === 0 && businessFailures === 0 ? "PASS" : "FAIL",
      sourceSnapshotTime,
      sourceSnapshotSha256,
      direction: "sqlite-to-postgresql-shadow",
      readOnlyValidation: true,
      deleteSyncSupported: true,
      deleteMode: this.deletePolicy.mode,
      tables,
      business,
      samples,
      sampleCount: allSamples.length,
      sampleFailures,
      countFailures,
      businessFailures,
      switchReady: false,
      switchBlockedBy: [
        "remaining SQLite-only runtime boundaries",
        "production cutover has not been approved",
        ...(this.deletePolicy.executesDeletes ? [] : ["hard-delete reconciliation was not explicitly applied"]),
      ],
    };
  }
}
