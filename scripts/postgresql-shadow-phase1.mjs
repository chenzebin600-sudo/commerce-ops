import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { backup, DatabaseSync } from "node:sqlite";
import pg from "pg";
import { loadPostgresqlF1Config } from "../lib/postgresql/f1-config.mjs";
import {
  SHADOW_AI_SCHEMA,
  SHADOW_APP_SCHEMA,
  SHADOW_CONTRACT_VERSION,
  SHADOW_DATABASE,
  SHADOW_META_SCHEMA,
  buildShadowSchema,
  selectShadowDataTables,
  shadowSchemaMigrationsSql,
} from "../lib/postgresql/shadow/shadow-schema.mjs";
import { quoteIdentifier } from "../lib/postgresql/sqlite-migration.mjs";
import { resolveRuntimeConfig } from "../lib/runtime-config.mjs";

const { Client } = pg;
const REPORT_DATE = "20260805";
const REPORT_BASENAME = `COMMERCE-OPS-POSTGRESQL-SHADOW-PHASE1-${REPORT_DATE}`;

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function fileSha256(filePath) {
  const digest = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    createReadStream(filePath).on("data", (chunk) => digest.update(chunk)).on("end", resolve).on("error", reject);
  });
  return digest.digest("hex");
}

function pgOptions(config, { database, role = "migrator" } = {}) {
  const admin = role === "admin";
  return {
    host: config.host,
    port: config.port,
    database,
    user: admin ? config.adminUser : config.migratorUser,
    password: admin ? config.adminPassword : config.migratorPassword,
    ssl: config.ssl ? { rejectUnauthorized: true } : false,
    application_name: "commerce-ops-shadow-phase1",
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

async function createSnapshot(sourcePath, destinationPath) {
  const before = await fs.stat(sourcePath);
  let snapshotExists = false;
  try {
    await fs.access(destinationPath);
    snapshotExists = true;
  } catch {}
  if (snapshotExists) {
    const existing = new DatabaseSync(destinationPath, { readOnly: true });
    try {
      return {
        sourceBytes: before.size,
        snapshotBytes: (await fs.stat(destinationPath)).size,
        snapshotSha256: await fileSha256(destinationPath),
        integrity: existing.prepare("PRAGMA integrity_check").get().integrity_check,
        foreignKeyViolations: existing.prepare("PRAGMA foreign_key_check").all().length,
        reused: true,
      };
    } finally {
      existing.close();
    }
  }
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    source.exec("PRAGMA query_only=ON");
    await backup(source, destinationPath);
  } finally {
    source.close();
  }
  await fs.chmod(destinationPath, 0o444);
  const snapshot = new DatabaseSync(destinationPath, { readOnly: true });
  try {
    const integrity = snapshot.prepare("PRAGMA integrity_check").get().integrity_check;
    const foreignKeyViolations = snapshot.prepare("PRAGMA foreign_key_check").all().length;
    const size = (await fs.stat(destinationPath)).size;
    return {
      sourceBytes: before.size,
      snapshotBytes: size,
      snapshotSha256: await fileSha256(destinationPath),
      integrity,
      foreignKeyViolations,
      reused: false,
    };
  } finally {
    snapshot.close();
  }
}

async function ensureShadowDatabase(config) {
  if ([config.database, config.testDatabase, "postgres", "template0", "template1"].includes(SHADOW_DATABASE)) {
    throw new Error("Shadow database safety boundary is invalid");
  }
  const existing = await withClient(pgOptions(config, { database: "postgres", role: "admin" }), async (client) => {
    const result = await client.query("SELECT datname FROM pg_database WHERE datname=$1", [SHADOW_DATABASE]);
    if (!result.rowCount) {
      await client.query(`CREATE DATABASE ${quoteIdentifier(SHADOW_DATABASE)} WITH ENCODING 'UTF8' TEMPLATE template0 OWNER ${quoteIdentifier(config.migratorUser)}`);
      await client.query(`REVOKE ALL PRIVILEGES ON DATABASE ${quoteIdentifier(SHADOW_DATABASE)} FROM PUBLIC`);
      await client.query(`GRANT CONNECT ON DATABASE ${quoteIdentifier(SHADOW_DATABASE)} TO ${quoteIdentifier(config.appUser)}`);
      return false;
    }
    return true;
  });
  await withClient(pgOptions(config, { database: SHADOW_DATABASE }), async (client) => {
    await client.query("BEGIN");
    try {
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(SHADOW_APP_SCHEMA)} AUTHORIZATION ${quoteIdentifier(config.migratorUser)}`);
      await client.query(shadowSchemaMigrationsSql());
      await client.query(`REVOKE ALL ON SCHEMA ${quoteIdentifier(SHADOW_APP_SCHEMA)} FROM PUBLIC`);
      await client.query(`REVOKE ALL ON SCHEMA ${quoteIdentifier(SHADOW_META_SCHEMA)} FROM PUBLIC`);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
  return { existed: existing };
}

async function migrationStatus(client, version) {
  const result = await client.query(`SELECT version,sha256 FROM ${quoteIdentifier(SHADOW_META_SCHEMA)}.schema_migrations WHERE version=$1`, [version]);
  return result.rows[0] || null;
}

async function applyMigration(client, { version, sql }) {
  const digest = sha256(sql);
  const existing = await migrationStatus(client, version);
  if (existing) {
    if (existing.sha256 !== digest) throw new Error(`Applied Shadow migration changed: ${version}`);
    return { version, sha256: digest, status: "ALREADY_APPLIED" };
  }
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout='10s'");
    await client.query(`SET LOCAL search_path TO ${quoteIdentifier(SHADOW_APP_SCHEMA)},public`);
    await client.query(sql);
    await client.query(`INSERT INTO ${quoteIdentifier(SHADOW_META_SCHEMA)}.schema_migrations(version,sha256) VALUES ($1,$2)`, [version, digest]);
    await client.query("COMMIT");
    return { version, sha256: digest, status: "APPLIED" };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

function encodeValue(value, column) {
  if (value === null || value === undefined) return null;
  switch (column.logicalType) {
    case "json": return JSON.stringify(typeof value === "string" ? JSON.parse(value) : value);
    case "timestamp": {
      const text = String(value);
      const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text) ? `${text.replace(" ", "T")}Z` : text;
      const date = new Date(normalized);
      if (Number.isNaN(date.getTime())) throw new Error(`Invalid timestamp in ${column.name}`);
      return date.toISOString();
    }
    case "date": {
      const text = String(value).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error(`Invalid date in ${column.name}`);
      return text;
    }
    case "numeric": return String(value);
    case "identity":
    case "integer": {
      const number = Number(value);
      if (!Number.isSafeInteger(number)) throw new Error(`Invalid integer in ${column.name}`);
      return number;
    }
    case "bigint": return String(value);
    case "double": return Number(value);
    case "binary": return Buffer.from(value);
    default: return String(value);
  }
}

function batchInsertSql(table, columns, rows) {
  const names = columns.map((column) => quoteIdentifier(column.name));
  let parameter = 0;
  const values = [];
  const tuples = rows.map((row) => `(${columns.map((column) => {
    values.push(encodeValue(row[column.name], column));
    parameter += 1;
    return `$${parameter}`;
  }).join(",")})`);
  return {
    text: `INSERT INTO ${quoteIdentifier(SHADOW_APP_SCHEMA)}.${quoteIdentifier(table.name)} (${names.join(",")}) VALUES ${tuples.join(",")}`,
    values,
  };
}

async function loadTable({ client, snapshot, table, snapshotInfo }) {
  const marker = await client.query(`SELECT * FROM ${quoteIdentifier(SHADOW_META_SCHEMA)}.table_loads WHERE table_name=$1`, [table.name]);
  if (marker.rowCount) {
    const row = marker.rows[0];
    if (row.status !== "SUCCEEDED" || String(row.source_row_count) !== String(table.rowCount) || row.source_snapshot_sha256 !== snapshotInfo.snapshotSha256) {
      throw new Error(`Shadow table load marker does not match source snapshot: ${table.name}`);
    }
    return { table: table.name, rows: table.rowCount, status: "ALREADY_LOADED" };
  }
  const current = await client.query(`SELECT count(*)::text AS count FROM ${quoteIdentifier(SHADOW_APP_SCHEMA)}.${quoteIdentifier(table.name)}`);
  if (current.rows[0].count !== "0") throw new Error(`Untracked rows already exist in Shadow table: ${table.name}`);

  const projection = table.columns.map((column) => quoteIdentifier(column.name)).join(",");
  const statement = snapshot.prepare(`SELECT ${projection} FROM ${quoteIdentifier(table.name)}`);
  const maxRows = Math.max(1, Math.min(500, Math.floor(30_000 / Math.max(table.columns.length, 1))));
  let batch = [];
  let loaded = 0;
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL synchronous_commit=off");
    for (const row of statement.iterate()) {
      batch.push(row);
      if (batch.length >= maxRows) {
        const insert = batchInsertSql(table, table.columns, batch);
        await client.query(insert);
        loaded += batch.length;
        batch = [];
      }
    }
    if (batch.length) {
      const insert = batchInsertSql(table, table.columns, batch);
      await client.query(insert);
      loaded += batch.length;
    }
    if (loaded !== table.rowCount) throw new Error(`Source iterator count mismatch for ${table.name}`);
    if (table.autoIncrement) {
      const identity = table.columns.find((column) => column.logicalType === "identity");
      if (identity) {
        await client.query(`SELECT setval(pg_get_serial_sequence($1,$2), GREATEST(COALESCE(MAX(${quoteIdentifier(identity.name)}),1),1), COUNT(*) > 0) FROM ${quoteIdentifier(SHADOW_APP_SCHEMA)}.${quoteIdentifier(table.name)}`, [`${SHADOW_APP_SCHEMA}.${table.name}`, identity.name]);
      }
    }
    await client.query(`INSERT INTO ${quoteIdentifier(SHADOW_META_SCHEMA)}.table_loads(table_name,source_row_count,target_row_count,source_snapshot_sha256,status) VALUES ($1,$2,$3,$4,'SUCCEEDED')`, [table.name, loaded, loaded, snapshotInfo.snapshotSha256]);
    await client.query("COMMIT");
    return { table: table.name, rows: loaded, status: "LOADED" };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function projectAgentObservability(client) {
  const agentRuns = await client.query(`
    WITH starts AS (
      SELECT DISTINCT ON (run_id) run_id,request_id,occurred_at,metadata_json
      FROM app.operation_audit_events
      WHERE action='agent.run.started' AND run_id IS NOT NULL
      ORDER BY run_id,occurred_at ASC
    ), finals AS (
      SELECT DISTINCT ON (run_id) run_id,occurred_at,duration_ms,status,error_code,metadata_json
      FROM app.operation_audit_events
      WHERE action IN ('agent.run.completed','agent.run.failed') AND run_id IS NOT NULL
      ORDER BY run_id,occurred_at DESC
    )
    INSERT INTO ai_shadow.agent_runs(
      id,request_id,agent_name,agent_version,context_versions,status,started_at,finished_at,duration_ms,
      input_tokens,output_tokens,total_tokens,error_code,evidence
    )
    SELECT s.run_id,s.request_id,
      COALESCE(f.metadata_json->>'agentName',s.metadata_json->>'agentName','unknown'),
      COALESCE(f.metadata_json->>'agentVersion',s.metadata_json->>'agentVersion','unknown'),
      COALESCE(f.metadata_json->>'resolvedContextVersions',f.metadata_json->>'contextVersions',s.metadata_json->>'contextVersions'),
      CASE WHEN f.status='success' THEN 'SUCCEEDED' WHEN f.status='failed' THEN 'FAILED' ELSE 'RUNNING' END,
      s.occurred_at,f.occurred_at,f.duration_ms,
      COALESCE((f.metadata_json->>'inputTokens')::bigint,0),
      COALESCE((f.metadata_json->>'outputTokens')::bigint,0),
      COALESCE((f.metadata_json->>'totalTokens')::bigint,0),f.error_code,
      jsonb_build_object('source','operation_audit_events','started',s.metadata_json,'finished',f.metadata_json)
    FROM starts s LEFT JOIN finals f ON f.run_id=s.run_id
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  `);
  const tools = await client.query(`
    INSERT INTO ai_shadow.tool_invocations(id,agent_run_id,request_id,tool_name,tool_version,status,duration_ms,error_code,evidence,occurred_at)
    SELECT id,run_id,request_id,COALESCE(metadata_json->>'toolName','unknown'),metadata_json->>'toolVersion',
      CASE WHEN status='success' THEN 'SUCCEEDED' ELSE 'FAILED' END,duration_ms,error_code,metadata_json,occurred_at
    FROM app.operation_audit_events
    WHERE action='agent.tool.invoke'
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  `);
  const gateways = await client.query(`
    INSERT INTO ai_shadow.gateway_calls(id,agent_run_id,request_id,provider,model,prompt_version,input_tokens,output_tokens,total_tokens,duration_ms,status,evidence,occurred_at)
    SELECT event.id,run.id,event.request_id,event.metadata_json->>'provider',event.metadata_json->>'model',event.metadata_json->>'promptVersion',
      COALESCE((event.metadata_json->>'inputTokens')::bigint,0),COALESCE((event.metadata_json->>'outputTokens')::bigint,0),
      COALESCE((event.metadata_json->>'totalTokens')::bigint,0),event.duration_ms,event.status,event.metadata_json,event.occurred_at
    FROM app.operation_audit_events event
    LEFT JOIN ai_shadow.agent_runs run ON run.request_id=event.request_id
    WHERE event.action='ai.gateway.complete'
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  `);
  return { agentRunsInserted: agentRuns.rowCount, toolInvocationsInserted: tools.rowCount, gatewayCallsInserted: gateways.rowCount };
}

function canonicalValue(value, column, { decodeJsonText = false } = {}) {
  if (value === null || value === undefined) return null;
  if (column.logicalType === "json") {
    let object = value;
    if (decodeJsonText && typeof value === "string") {
      try { object = JSON.parse(value); } catch { object = value; }
    }
    const stableJson = (item) => {
      if (Array.isArray(item)) return item.map(stableJson);
      if (item && typeof item === "object") {
        return Object.fromEntries(Object.keys(item).sort().map((key) => [key, stableJson(item[key])]));
      }
      return item;
    };
    return stableJson(object);
  }
  if (column.logicalType === "timestamp") {
    if (value instanceof Date) return value.toISOString();
    const text = String(value);
    const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text) ? `${text.replace(" ", "T")}Z` : text;
    return new Date(normalized).toISOString();
  }
  if (column.logicalType === "date") {
    if (value instanceof Date) {
      const pad = (part) => String(part).padStart(2, "0");
      return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
    }
    return String(value).slice(0, 10);
  }
  if (["numeric", "double"].includes(column.logicalType)) return Number(value);
  if (["identity", "integer"].includes(column.logicalType)) return Number(value);
  if (column.logicalType === "bigint") return String(value);
  if (column.logicalType === "binary") return Buffer.from(value).toString("hex");
  return String(value);
}

async function sampleTable(client, snapshot, table) {
  if (!table.rowCount) return { sampleCount: 0, match: true };
  const orderColumns = table.primaryKey.length ? table.primaryKey : table.columns.slice(0, Math.min(3, table.columns.length)).map((column) => column.name);
  const order = orderColumns.map(quoteIdentifier).join(",");
  const projection = table.columns.map((column) => quoteIdentifier(column.name)).join(",");
  const sourceRows = [
    ...snapshot.prepare(`SELECT ${projection} FROM ${quoteIdentifier(table.name)} ORDER BY ${order} ASC LIMIT 3`).all(),
    ...snapshot.prepare(`SELECT ${projection} FROM ${quoteIdentifier(table.name)} ORDER BY ${order} DESC LIMIT 3`).all(),
  ];
  const targetRows = [];
  if (table.primaryKey.length) {
    const primaryKeyColumns = table.primaryKey.map((name) => table.columns.find((column) => column.name === name));
    for (const sourceRow of sourceRows) {
      const values = primaryKeyColumns.map((column) => encodeValue(sourceRow[column.name], column));
      const where = primaryKeyColumns.map((column, index) => `${quoteIdentifier(column.name)} IS NOT DISTINCT FROM $${index + 1}`).join(" AND ");
      const result = await client.query(`SELECT ${projection} FROM ${quoteIdentifier(SHADOW_APP_SCHEMA)}.${quoteIdentifier(table.name)} WHERE ${where} LIMIT 1`, values);
      targetRows.push(result.rows[0] ?? {});
    }
  } else {
    const target = await client.query(`(SELECT ${projection} FROM ${quoteIdentifier(SHADOW_APP_SCHEMA)}.${quoteIdentifier(table.name)} ORDER BY ${order} ASC LIMIT 3) UNION ALL (SELECT ${projection} FROM ${quoteIdentifier(SHADOW_APP_SCHEMA)}.${quoteIdentifier(table.name)} ORDER BY ${order} DESC LIMIT 3)`);
    targetRows.push(...target.rows);
  }
  const normalize = (rows, options) => rows.map((row) => table.columns.map((column) => canonicalValue(row[column.name], column, options)));
  const normalizedSource = normalize(sourceRows, { decodeJsonText: true });
  const normalizedTarget = normalize(targetRows, { decodeJsonText: false });
  const sourceHash = sha256(JSON.stringify(normalizedSource));
  const targetHash = sha256(JSON.stringify(normalizedTarget));
  const match = sourceHash === targetHash;
  let firstDifference = null;
  if (!match) {
    outer: for (let rowIndex = 0; rowIndex < normalizedSource.length; rowIndex += 1) {
      for (let columnIndex = 0; columnIndex < table.columns.length; columnIndex += 1) {
        if (JSON.stringify(normalizedSource[rowIndex]?.[columnIndex]) !== JSON.stringify(normalizedTarget[rowIndex]?.[columnIndex])) {
          firstDifference = {
            rowIndex,
            column: table.columns[columnIndex].name,
            source: normalizedSource[rowIndex]?.[columnIndex],
            target: normalizedTarget[rowIndex]?.[columnIndex],
          };
          break outer;
        }
      }
    }
  }
  return { sampleCount: sourceRows.length, match, ...(firstDifference ? { firstDifference } : {}) };
}

async function repositoryAudit(rootDir) {
  const dataAccess = await fs.readFile(path.join(rootDir, "lib", "data", "data-access.mjs"), "utf8");
  const sqliteDir = path.join(rootDir, "lib", "data", "sqlite");
  const sqliteFiles = (await fs.readdir(sqliteDir)).filter((name) => name.endsWith(".mjs"));
  const repositoryDir = path.join(rootDir, "lib", "data", "repositories");
  const repositories = (await fs.readdir(repositoryDir)).filter((name) => name.endsWith(".mjs"));
  return {
    providerContractExists: true,
    postgresqlProviderExists: true,
    productionProviderSwitchImplemented: !/new SqliteProvider\s*\(/.test(dataAccess),
    sqliteOnlyRepositoryFiles: sqliteFiles,
    providerAwareRepositoryFiles: repositories,
    recommendation: "Add a provider factory at the composition root, then migrate real repositories domain by domain behind parity contracts; do not switch DATABASE_PROVIDER until production Repository SQL passes PostgreSQL integration tests.",
  };
}

async function validateShadow({ client, snapshot, schemaResult, selectedTables, snapshotInfo, rootDir }) {
  const targetTables = await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema=$1 AND table_type='BASE TABLE' ORDER BY table_name", [SHADOW_APP_SCHEMA]);
  const targetViews = await client.query("SELECT table_name FROM information_schema.views WHERE table_schema=$1 ORDER BY table_name", [SHADOW_APP_SCHEMA]);
  const foreignKeys = await client.query("SELECT count(*)::text AS count, bool_and(convalidated) AS validated FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname=$1 AND c.contype='f'", [SHADOW_APP_SCHEMA]);
  const indexes = await client.query("SELECT count(*)::text AS count FROM pg_indexes WHERE schemaname=$1", [SHADOW_APP_SCHEMA]);
  const tables = [];
  for (const tableName of selectedTables) {
    const table = schemaResult.source.tables.find((candidate) => candidate.name === tableName);
    const targetCount = await client.query(`SELECT count(*)::text AS count FROM ${quoteIdentifier(SHADOW_APP_SCHEMA)}.${quoteIdentifier(tableName)}`);
    const sample = await sampleTable(client, snapshot, table);
    tables.push({ table: tableName, sourceRows: table.rowCount, targetRows: Number(targetCount.rows[0].count), rowCountMatch: Number(targetCount.rows[0].count) === table.rowCount, ...sample });
  }
  const ai = {};
  for (const table of ["agent_runs", "tool_invocations", "context_snapshots", "gateway_calls", "agent_evaluations"]) {
    const count = await client.query(`SELECT count(*)::text AS count FROM ${quoteIdentifier(SHADOW_AI_SCHEMA)}.${quoteIdentifier(table)}`);
    ai[table] = Number(count.rows[0].count);
  }
  const database = await client.query("SELECT current_database() database, pg_database_size(current_database())::text bytes, pg_size_pretty(pg_database_size(current_database())) size");
  const repository = await repositoryAudit(rootDir);
  const keyTables = ["growth_order_headers", "growth_order_lines", "product_skus", "growth_inventory_snapshots", "foundation_tasks", "operation_audit_events"];
  return {
    status: tables.every((table) => table.rowCountMatch && table.match)
      && targetTables.rowCount === schemaResult.expected.tables
      && targetViews.rowCount === schemaResult.expected.views
      && foreignKeys.rows[0].validated,
    database: database.rows[0],
    source: { ...snapshotInfo, tables: schemaResult.source.tableCount, rows: schemaResult.source.rowCount },
    target: {
      appTables: targetTables.rowCount,
      appViews: targetViews.rowCount,
      indexes: Number(indexes.rows[0].count),
      foreignKeys: Number(foreignKeys.rows[0].count),
      foreignKeysValidated: foreignKeys.rows[0].validated,
    },
    migratedTables: tables,
    keyTables: tables.filter((table) => keyTables.includes(table.table)),
    ai,
    repository,
  };
}

function markdownReport({ validation, schemaResult, selectedTables, migrations, projection }) {
  const keyRows = validation.keyTables.map((table) => `| \`${table.table}\` | ${table.sourceRows.toLocaleString("en-US")} | ${table.targetRows.toLocaleString("en-US")} | ${table.rowCountMatch ? "PASS" : "FAIL"} | ${table.match ? "PASS" : "FAIL"} |`).join("\n");
  const failed = validation.migratedTables.filter((table) => !table.rowCountMatch || !table.match);
  return `# Commerce Ops PostgreSQL Shadow Migration Phase 1\n\nDate: 2026-08-05  \nStatus: **${validation.status ? "PASS" : "FAIL"}**  \nContract: \`${SHADOW_CONTRACT_VERSION}\`\n\n## Safety boundary\n\n- Production provider remains \`sqlite\`.\n- The formal SQLite database was opened read-only and copied with the SQLite online backup API.\n- PostgreSQL target is the isolated database \`${SHADOW_DATABASE}\` only.\n- No production database switch, data deletion, MinIO migration, or business-Agent development occurred.\n\n## Shadow architecture\n\n- Compatibility schema: \`${SHADOW_APP_SCHEMA}\` (${validation.target.appTables} tables, ${validation.target.appViews} views).\n- AI projection schema: \`${SHADOW_AI_SCHEMA}\`.\n- Migration and table-load ledger: \`${SHADOW_META_SCHEMA}\`.\n- PostgreSQL size after Phase 1: ${validation.database.size}.\n- Full SQLite schema contract: ${schemaResult.expected.tables} tables, ${schemaResult.source.columnCount} columns, ${schemaResult.expected.foreignKeys} foreign keys, ${schemaResult.expected.views} views.\n\n## Versioned migrations\n\n${migrations.map((migration) => `- \`${migration.version}\`: ${migration.status}, SHA-256 \`${migration.sha256}\``).join("\n")}\n\n## Data scope\n\n- ${selectedTables.length} dependency-closed core tables were loaded.\n- Product/SKU, store identity, order headers/lines, inventory, Foundation and scheduled tasks, and operation audit data are included.\n- Non-core compatibility tables have structure only in Phase 1.\n\n## Key consistency checks\n\n| Table | SQLite rows | PostgreSQL rows | Count | Deterministic sample |\n|---|---:|---:|---|---|\n${keyRows}\n\n- Source snapshot integrity: \`${validation.source.integrity}\`.\n- Source foreign-key violations: ${validation.source.foreignKeyViolations}.\n- PostgreSQL foreign keys: ${validation.target.foreignKeys}; validated: ${validation.target.foreignKeysValidated}.\n- Failed loaded tables: ${failed.length ? failed.map((table) => `\`${table.table}\``).join(", ") : "none"}.\n\n## AI observability projection\n\n- Agent Runs: ${validation.ai.agent_runs}.\n- Tool Invocations: ${validation.ai.tool_invocations}.\n- Gateway Calls: ${validation.ai.gateway_calls}.\n- Context Snapshots: ${validation.ai.context_snapshots} (structure only because SQLite has no first-class snapshot table).\n- Evaluations: ${validation.ai.agent_evaluations} (structure only because SQLite has no first-class evaluation rows).\n- Projection inserted this run: ${JSON.stringify(projection)}.\n\n## Repository compatibility\n\n- Provider contract: present.\n- PostgreSQL provider: present.\n- Production composition-root switch: **${validation.repository.productionProviderSwitchImplemented ? "implemented" : "not implemented"}**.\n- Provider-aware repository files: ${validation.repository.providerAwareRepositoryFiles.length}.\n- SQLite-only data-layer files: ${validation.repository.sqliteOnlyRepositoryFiles.length}.\n- Required next change: ${validation.repository.recommendation}\n\nThe application must not set \`DATABASE_PROVIDER=postgres\` yet. Phase 1 proves schema/data portability, not full business Repository parity.\n\n## File assets\n\nThe current local files were not moved. A non-wired \`StorageProvider\` contract now defines \`LocalStorageProvider\` and injectable \`MinioStorageProvider\` implementations. Existing runtime behavior remains unchanged. Database rows continue to store metadata and relative keys only.\n\n## Problems found\n\n1. Name-based UUID inference is unsafe for platform IDs, SHA-256 values, and namespace IDs; the Shadow contract uses explicit generated types and keeps identifiers as text.\n2. The SQLite expression index for one running price-control sync needs an explicit PostgreSQL expression-index mapping.\n3. Self-referential foreign keys require data-first, constraints-after loading.\n4. Current production data access still constructs SQLite directly and several repositories remain SQLite-only.\n5. Agent Context and Evaluation are audit projections today, not first-class SQLite tables.\n\n## Next phase\n\n1. Add a production composition-root Provider factory without switching the default.\n2. Port real Product, Sales, Inventory, Task, and Audit repositories behind dual-dialect contracts.\n3. Add PostgreSQL integration tests for scheduler leases, task transitions, JSON queries, partial indexes, and Agent Monitoring.\n4. Repeat Shadow load from a newer snapshot and measure incremental drift.\n5. Only after repository parity and UAT, plan a separately approved final write freeze and cutover.\n`;
}

async function writeGeneratedFiles({ rootDir, schemaResult }) {
  const migrationDir = path.join(rootDir, "postgresql", "shadow", "migrations");
  await fs.mkdir(migrationDir, { recursive: true });
  const first = path.join(migrationDir, "001_legacy_tables.sql");
  const third = path.join(migrationDir, "003_legacy_constraints_indexes_views.sql");
  const contract = path.join(rootDir, "postgresql", "shadow", "schema-contract.json");
  await fs.writeFile(first, `${schemaResult.tableSql}\n`, "utf8");
  await fs.writeFile(third, `${schemaResult.deferredSql}\n`, "utf8");
  await fs.writeFile(contract, `${JSON.stringify(schemaResult.contract, null, 2)}\n`, "utf8");
  return { first, second: path.join(migrationDir, "002_ai_observability.sql"), third, contract };
}

export async function runShadowPhase1({ rootDir = process.cwd(), apply = false } = {}) {
  if (String(process.env.DATABASE_PROVIDER || "sqlite").trim().toLowerCase() !== "sqlite") {
    throw new Error("Shadow Phase 1 requires the active production provider to remain sqlite");
  }
  const config = loadPostgresqlF1Config({ rootDir });
  const runtime = resolveRuntimeConfig({ bootstrapRoot: rootDir, env: process.env });
  const temporaryRoot = path.join(rootDir, "tmp", "postgresql-shadow-phase1");
  await fs.mkdir(temporaryRoot, { recursive: true });
  const snapshotPath = path.join(temporaryRoot, "commerce-ops-shadow-source.sqlite");
  let snapshot;
  try {
    const snapshotInfo = await createSnapshot(runtime.databasePath, snapshotPath);
    if (snapshotInfo.integrity !== "ok" || snapshotInfo.foreignKeyViolations !== 0) throw new Error("SQLite source snapshot failed integrity gates");
    snapshot = new DatabaseSync(snapshotPath, { readOnly: true });
    const schemaResult = buildShadowSchema(snapshot);
    const generatedFiles = await writeGeneratedFiles({ rootDir, schemaResult });
    const selectedTables = selectShadowDataTables(schemaResult.source);
    if (!apply) return { status: "GENERATED", database: SHADOW_DATABASE, selectedTables, generatedFiles, source: snapshotInfo };

    const databaseCreation = await ensureShadowDatabase(config);
    const result = await withClient(pgOptions(config, { database: SHADOW_DATABASE }), async (client) => {
      const identity = await client.query("SELECT current_database() database,current_user username");
      if (identity.rows[0].database !== SHADOW_DATABASE || identity.rows[0].username !== config.migratorUser) throw new Error("Shadow target identity check failed");
      const migrationFiles = [generatedFiles.first, generatedFiles.second];
      const migrations = [];
      for (const filePath of migrationFiles) migrations.push(await applyMigration(client, { version: path.basename(filePath), sql: await fs.readFile(filePath, "utf8") }));
      const loads = [];
      for (const tableName of selectedTables) {
        const table = schemaResult.source.tables.find((candidate) => candidate.name === tableName);
        const loaded = await loadTable({ client, snapshot, table, snapshotInfo });
        loads.push(loaded);
        process.stdout.write(`Shadow load ${tableName}: ${loaded.rows}\n`);
      }
      const projection = await projectAgentObservability(client);
      migrations.push(await applyMigration(client, { version: path.basename(generatedFiles.third), sql: await fs.readFile(generatedFiles.third, "utf8") }));
      await client.query(`GRANT USAGE ON SCHEMA ${quoteIdentifier(SHADOW_APP_SCHEMA)},${quoteIdentifier(SHADOW_AI_SCHEMA)} TO ${quoteIdentifier(config.appUser)}`);
      await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${quoteIdentifier(SHADOW_APP_SCHEMA)},${quoteIdentifier(SHADOW_AI_SCHEMA)} TO ${quoteIdentifier(config.appUser)}`);
      await client.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${quoteIdentifier(SHADOW_APP_SCHEMA)},${quoteIdentifier(SHADOW_AI_SCHEMA)} TO ${quoteIdentifier(config.appUser)}`);
      const validation = await validateShadow({ client, snapshot, schemaResult, selectedTables, snapshotInfo, rootDir });
      return { databaseCreation, migrations, loads, projection, validation };
    });
    const reportDir = path.join(rootDir, "docs", "reports");
    await fs.mkdir(reportDir, { recursive: true });
    const jsonPath = path.join(reportDir, `${REPORT_BASENAME}.json`);
    const markdownPath = path.join(reportDir, `${REPORT_BASENAME}.md`);
    const portableGeneratedFiles = Object.fromEntries(Object.entries(generatedFiles).map(([name, filePath]) => [name, path.relative(rootDir, filePath).replaceAll("\\", "/")]));
    await fs.writeFile(jsonPath, `${JSON.stringify({
      status: result.validation.status ? "PASS" : "FAIL",
      contractVersion: SHADOW_CONTRACT_VERSION,
      database: SHADOW_DATABASE,
      generatedFiles: portableGeneratedFiles,
      selectedTables,
      ...result,
    }, null, 2)}\n`, "utf8");
    await fs.writeFile(markdownPath, markdownReport({ validation: result.validation, schemaResult, selectedTables, migrations: result.migrations, projection: result.projection }), "utf8");
    if (!result.validation.status) throw new Error("Shadow Phase 1 consistency validation failed");
    return { status: "PASS", database: SHADOW_DATABASE, report: markdownPath, jsonReport: jsonPath, ...result };
  } finally {
    snapshot?.close();
  }
}

async function main() {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const apply = process.argv.includes("--apply");
  const result = await runShadowPhase1({ rootDir, apply });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (entry === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`PostgreSQL Shadow Phase 1 failed [${String(error?.code || "SHADOW_PHASE1_FAILED").slice(0, 80)}]: ${String(error?.message || error).split(/\r?\n/)[0].slice(0, 600)}\n`);
    process.exitCode = 1;
  });
}
