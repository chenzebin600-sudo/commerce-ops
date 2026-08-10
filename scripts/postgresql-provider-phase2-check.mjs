import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createDatabaseProvider } from "../lib/data/database-provider-factory.mjs";
import { createProviderDomainRepositories } from "../lib/data/provider-domain-repositories.mjs";
import { resolveShadowSqliteSnapshot } from "../lib/postgresql/incremental-sync/shadow-snapshot-resolver.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");

function normalized(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalized(item)]));
  }
  return value;
}

function pick(value, keys) {
  return Object.fromEntries(keys.map((key) => [key, normalized(value?.[key] ?? null)]));
}

function firstMismatch(actual, expected, location = "$") {
  if (Object.is(actual, expected)) return null;
  if (Array.isArray(actual) || Array.isArray(expected)) {
    if (!Array.isArray(actual) || !Array.isArray(expected)) return { location, actual, expected };
    if (actual.length !== expected.length) {
      return { location: `${location}.length`, actual: actual.length, expected: expected.length };
    }
    for (let index = 0; index < actual.length; index += 1) {
      const mismatch = firstMismatch(actual[index], expected[index], `${location}[${index}]`);
      if (mismatch) return mismatch;
    }
    return null;
  }
  if (actual && expected && typeof actual === "object" && typeof expected === "object") {
    const keys = [...new Set([...Object.keys(actual), ...Object.keys(expected)])].sort();
    for (const key of keys) {
      const mismatch = firstMismatch(actual[key], expected[key], `${location}.${key}`);
      if (mismatch) return mismatch;
    }
    return null;
  }
  return { location, actual, expected };
}

function preview(value) {
  const serialized = JSON.stringify(value);
  return String(serialized === undefined ? value : serialized).slice(0, 180);
}

async function loadDomainSnapshot(repositories, domain) {
  if (domain === "product") {
    return normalized((await repositories.products.getIdentitySet()).map((row) => pick(row, [
      "id", "sourceSku", "normalizedSku", "sourceMainSku",
    ])));
  }
  if (domain === "sales") {
    const [summary, identity, sample] = await Promise.all([
      repositories.sales.getSalesSummary(),
      salesIdentityDigest(repositories.raw.salesAssortment.provider),
      repositories.raw.salesAssortment.sourceRows("orders", { page: 1, pageSize: 25 }),
    ]);
    return normalized({
      summary,
      identity,
      total: sample.total,
      sample: sample.rows.map((row) => pick(row, [
        "source_order_id", "paid_at", "source_shop_name", "platform", "order_status",
        "source_sku", "quantity", "product_name", "source_warehouse_name",
      ])),
    });
  }
  if (domain === "inventory") {
    const [summary, rows] = await Promise.all([
      repositories.inventory.getInventorySnapshot(),
      repositories.inventory.getInventoryRows(),
    ]);
    return normalized({
      summary: {
        ...summary,
        batch: summary.batch ? pick(summary.batch, ["id", "source_filename", "row_count"]) : null,
      },
      keys: rows.rows.map((row) => pick(row, [
        "id", "batch_id", "source_row_number", "normalized_source_sku",
        "normalized_warehouse_name", "available_quantity", "in_transit_quantity",
      ])),
    });
  }
  if (domain === "task") {
    return normalized((await repositories.tasks.listTasks({ limit: 500 })).map((row) => pick(row, [
      "id", "domain", "taskKind", "state", "priority", "domainRefType", "domainRefId",
    ])));
  }
  if (domain === "audit") {
    const [identity, sample, summary] = await Promise.all([
      repositories.audit.getIdentitySet(),
      repositories.audit.listEvents({ page: 1, pageSize: 25 }),
      repositories.audit.summary(),
    ]);
    return normalized({
      identity: identity.map((row) => pick(row, ["id", "module", "action", "status", "run_id"])),
      sample: sample.rows.map((row) => pick(row, ["id", "module", "action", "status", "run_id"])),
      summary,
    });
  }
  if (domain === "agent") {
    const [freshness, monitoring] = await Promise.all([
      repositories.context.freshness(),
      repositories.monitoring.summary({}),
    ]);
    return normalized({
      freshness: {
        sourceBatches: freshness.sourceBatches.map((row) => pick(row, ["source_type", "id", "row_count"])),
        publishedAnalysis: freshness.publishedAnalysis
          ? pick(freshness.publishedAnalysis, ["id", "analysis_date", "quality_status", "rule_set_id"])
          : null,
      },
      monitoring,
    });
  }
  throw new TypeError(`Unknown Phase 2 parity domain: ${domain}`);
}

async function pagedIdentityDigest(provider, table, columns, { pageSize = 5_000 } = {}) {
  const hash = createHash("sha256");
  let count = 0;
  let lastId = null;
  while (true) {
    const parameters = [];
    const where = lastId === null
      ? ""
      : `WHERE id>${provider.placeholder(parameters.push(lastId))}`;
    parameters.push(pageSize);
    const result = await provider.query(
      `SELECT ${columns.join(",")} FROM ${table} ${where} ORDER BY id LIMIT ${provider.placeholder(parameters.length)}`,
      parameters,
    );
    for (const row of result.rows) {
      hash.update(JSON.stringify(columns.map((column) => normalized(row[column] ?? null))));
      hash.update("\n");
    }
    count += result.rows.length;
    if (result.rows.length < pageSize) break;
    lastId = result.rows.at(-1).id;
  }
  return { count, sha256: hash.digest("hex") };
}

async function salesIdentityDigest(provider) {
  const headers = await pagedIdentityDigest(
    provider,
    "growth_order_headers",
    ["id", "source_order_id"],
  );
  const lines = await pagedIdentityDigest(
    provider,
    "growth_order_lines",
    ["id", "order_header_id", "source_line_key"],
  );
  return { headers, lines };
}

function domainSummary(domain, snapshot) {
  if (domain === "product") return { records: snapshot.length };
  if (domain === "sales") return {
    orders: snapshot.summary.orderCount,
    lines: snapshot.summary.lineCount,
    headerPrimaryKeys: snapshot.identity.headers.count,
    linePrimaryKeys: snapshot.identity.lines.count,
    sampleRows: snapshot.sample.length,
  };
  if (domain === "inventory") return { rows: snapshot.summary.rowCount, keys: snapshot.keys.length };
  if (domain === "task") return { records: snapshot.length };
  if (domain === "audit") return { records: snapshot.identity.length, sampleRows: snapshot.sample.length };
  return { agentRuns: snapshot.monitoring.totalRuns, sourceBatches: snapshot.freshness.sourceBatches.length };
}

async function main() {
  const requested = process.argv.find((argument) => argument.startsWith("--domain="))?.split("=")[1] || "all";
  const domains = requested === "all"
    ? ["product", "sales", "inventory", "task", "audit", "agent"]
    : [requested];
  const activeProvider = String(process.env.DATABASE_PROVIDER || "sqlite").trim().toLowerCase();
  if (!new Set(["", "sqlite"]).has(activeProvider)) {
    throw new Error("Production DATABASE_PROVIDER must remain sqlite while running Phase 2 parity");
  }

  const snapshotPath = resolveShadowSqliteSnapshot({ rootDir });
  if (!fs.existsSync(snapshotPath)) throw new Error(`PostgreSQL Shadow SQLite snapshot is missing: ${snapshotPath}`);

  const sqliteSelection = createDatabaseProvider({
    rootDir,
    databasePath: snapshotPath,
    env: { DATABASE_PROVIDER: "sqlite" },
    sqliteReadOnly: true,
  });
  const postgresqlSelection = createDatabaseProvider({
    rootDir,
    env: { ...process.env, DATABASE_PROVIDER: "postgres", POSTGRES_SHADOW_MODE: "true" },
  });

  try {
    const postgresqlIdentity = await postgresqlSelection.provider.query(
      "SELECT current_database() database,current_user username,current_schema() schema,current_setting('default_transaction_read_only') read_only",
    );
    assert.equal(postgresqlIdentity.rows[0]?.database, "commerce_ops_shadow");
    assert.equal(postgresqlIdentity.rows[0]?.schema, "app");
    assert.equal(postgresqlIdentity.rows[0]?.read_only, "on");

    const sqliteRepositories = createProviderDomainRepositories({ provider: sqliteSelection.provider });
    const postgresqlRepositories = createProviderDomainRepositories({ provider: postgresqlSelection.provider });
    const parity = {};
    for (const domain of domains) {
      const [sqlite, postgresql] = await Promise.all([
        loadDomainSnapshot(sqliteRepositories, domain),
        loadDomainSnapshot(postgresqlRepositories, domain),
      ]);
      const mismatch = firstMismatch(postgresql, sqlite);
      if (mismatch) {
        const error = new Error(
          `Parity mismatch in ${domain} at ${mismatch.location}: PostgreSQL=${preview(mismatch.actual)} SQLite=${preview(mismatch.expected)}`,
        );
        error.code = "POSTGRESQL_PROVIDER_PARITY_MISMATCH";
        throw error;
      }
      parity[domain] = { ...domainSummary(domain, sqlite), valueParity: true };
    }

    process.stdout.write(`${JSON.stringify({
      status: "PASS",
      contractVersion: "COMMERCE-OPS-PG-PROVIDER-2.0.0",
      productionProvider: "sqlite",
      sqlite: { snapshotPath, readOnly: true },
      postgresql: {
        database: postgresqlSelection.target,
        schema: "app",
        role: postgresqlIdentity.rows[0]?.username,
        readOnly: true,
      },
      domains,
      parity,
    }, null, 2)}\n`);
  } finally {
    sqliteSelection.provider.close();
    await postgresqlSelection.provider.close();
  }
}

main().catch((error) => {
  const code = String(error?.code || "POSTGRESQL_PROVIDER_PHASE2_FAILED").slice(0, 80);
  const message = String(error?.message || error).split(/\r?\n/)[0].slice(0, 500);
  process.stderr.write(`PostgreSQL Provider Phase 2 check failed [${code}]: ${message}\n`);
  process.exitCode = 1;
});
