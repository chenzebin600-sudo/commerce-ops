import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { loadLocalEnv } from "../lib/env.mjs";
import { resolveRuntimeConfig } from "../lib/runtime-config.mjs";
import { PostgresqlProvider } from "../lib/data/postgresql/postgresql-provider.mjs";
import { loadPostgresqlF1Config, publicPostgresqlF1Config } from "../lib/postgresql/f1-config.mjs";
import {
  buildFullSourceSyncManifest,
  PHASE3D_REHEARSAL_CONTRACT,
  PHASE3D_REHEARSAL_DATABASE,
  PHASE3D_REHEARSAL_STATE_ID,
  resolvePhase3dInvocation,
  schemaCoverage,
} from "../lib/postgresql/phase3d-rehearsal.mjs";
import {
  PHASE3D_PRODUCTION_CANDIDATE_CONTRACT,
  PHASE3D_PRODUCTION_CANDIDATE_DATABASE,
  PHASE3D_PRODUCTION_CANDIDATE_PROVIDER,
  PHASE3D_PRODUCTION_CANDIDATE_SCOPE,
  PHASE3D_PRODUCTION_MODE_SCOPE,
  PHASE3D_PRODUCTION_CANDIDATE_STATE_ID,
  productionCandidateApplyCommand,
  resolveProductionCandidateInvocation,
} from "../lib/postgresql/phase3d-production-candidate.mjs";
import { loadPhase3bMigrations } from "../lib/postgresql/phase3b-rehearsal.mjs";
import {
  buildShadowSchema,
  shadowSchemaMigrationsSql,
} from "../lib/postgresql/shadow/shadow-schema.mjs";
import {
  createSqliteMigrationSnapshot,
  createTableDigestAccumulator,
  encodePostgresqlMigrationValue,
  normalizeMigrationValue,
  normalizePostgresqlMigrationValue,
  openReadOnlySqliteSnapshot,
  quoteIdentifier,
} from "../lib/postgresql/sqlite-migration.mjs";
import {
  buildPostgresqlUpsert,
  projectAgentObservability,
  seedSyncStateFromBaseline,
} from "../lib/postgresql/incremental-sync/migration-sync-service.mjs";
import { SyncControlRepository } from "../lib/postgresql/incremental-sync/sync-control-repository.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const MAX_BIND_PARAMETERS = 60_000;
const DATA_BATCH_ROWS = 500;
const KEY_BATCH_ROWS = 5_000;
const TARGET_ONLY_TABLES = Object.freeze([
  "fulfillment_agent_runs",
  "fulfillment_batch_orders",
  "fulfillment_batches",
  "fulfillment_idempotency",
  "fulfillment_manual_recovery_checks",
  "fulfillment_preview_orders",
  "fulfillment_previews",
  "fulfillment_scan_runs",
  "fulfillment_tracking_recoveries",
]);
const CORE_SAMPLE_TABLES = Object.freeze([
  "product_skus",
  "growth_order_headers",
  "growth_order_lines",
  "growth_inventory_snapshots",
  "foundation_tasks",
  "operation_audit_events",
]);

function safeError(error) {
  return {
    code: String(error?.code || "PHASE3D_FAILED").slice(0, 80),
    message: String(error?.message || error).split(/\r?\n/)[0].slice(0, 500),
  };
}

function selectedProvider(base, { database, user, password, readOnly = false, timeoutMs = 600_000 }) {
  return new PostgresqlProvider({
    config: Object.freeze({ ...base, schema: "app", statementTimeoutMs: timeoutMs }),
    database,
    user,
    password,
    readOnly,
  });
}

function qualified(table) {
  return `${quoteIdentifier("app")}.${quoteIdentifier(table)}`;
}

function stamp() {
  return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === "object" && !Buffer.isBuffer(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function equal(left, right) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

function firstLine(value) {
  return String(value || "").split(/\r?\n/)[0].slice(0, 500);
}

async function databaseEvidence(provider, names) {
  return (await provider.query(`
    SELECT datname,oid::text oid,pg_database_size(oid)::text bytes
    FROM pg_database WHERE datname=ANY($1::text[]) ORDER BY datname
  `, [names])).rows;
}

async function rebuildDatabase(base, targetDatabase) {
  const admin = selectedProvider(base, {
    database: "postgres",
    user: base.adminUser,
    password: base.adminPassword,
  });
  const protectedNames = [base.database, base.testDatabase, "commerce_ops_shadow", "commerce_ops_staging"];
  try {
    const identity = (await admin.query("SELECT current_database() database,current_user username")).rows[0];
    assert.deepEqual(identity, { database: "postgres", username: base.adminUser });
    const before = await databaseEvidence(admin, [...protectedNames, targetDatabase]);
    if (before.some((row) => row.datname === targetDatabase)) {
      await admin.executeScript(`DROP DATABASE ${quoteIdentifier(targetDatabase)} WITH (FORCE)`);
    }
    await admin.executeScript(`CREATE DATABASE ${quoteIdentifier(targetDatabase)} WITH ENCODING 'UTF8' TEMPLATE template0 OWNER ${quoteIdentifier(base.migratorUser)}`);
    await admin.executeScript(`REVOKE ALL PRIVILEGES ON DATABASE ${quoteIdentifier(targetDatabase)} FROM PUBLIC`);
    await admin.executeScript(`GRANT CONNECT ON DATABASE ${quoteIdentifier(targetDatabase)} TO ${quoteIdentifier(base.migratorUser)},${quoteIdentifier(base.appUser)}`);
    const after = await databaseEvidence(admin, [...protectedNames, targetDatabase]);
    for (const name of protectedNames) {
      assert.equal(after.find((row) => row.datname === name)?.oid, before.find((row) => row.datname === name)?.oid, `Protected database identity changed: ${name}`);
    }
    const target = after.find((row) => row.datname === targetDatabase);
    if (!target) throw new Error("Phase 3D rehearsal database was not created");
    return {
      target,
      rebuilt: true,
      protectedDatabases: protectedNames.map((name) => ({ database: name, oid: after.find((row) => row.datname === name)?.oid || null })),
    };
  } finally {
    await admin.close();
  }
}

async function ensureDatabaseExists(base, targetDatabase) {
  const admin = selectedProvider(base, {
    database: "postgres",
    user: base.adminUser,
    password: base.adminPassword,
    readOnly: true,
  });
  try {
    const evidence = await databaseEvidence(admin, [targetDatabase]);
    if (!evidence.length) throw new Error("Phase 3D refresh requires an existing rehearsal database; run --rebuild first");
    return evidence[0];
  } finally {
    await admin.close();
  }
}

async function resetProductionCandidateSchemas(base, targetDatabase) {
  if (targetDatabase !== PHASE3D_PRODUCTION_CANDIDATE_DATABASE || targetDatabase !== base.database) {
    throw Object.assign(new Error("Production candidate schema reset rejected an unexpected target"), { code: "PRODUCTION_CANDIDATE_TARGET_REJECTED" });
  }
  const provider = selectedProvider(base, {
    database: targetDatabase,
    user: base.migratorUser,
    password: base.migratorPassword,
  });
  try {
    const identity = (await provider.query("SELECT current_database() database,current_user username")).rows[0];
    assert.deepEqual(identity, { database: targetDatabase, username: base.migratorUser });
    const before = (await provider.query(`
      SELECT
        (SELECT count(*)::integer FROM information_schema.tables WHERE table_schema='app') app_relations,
        (SELECT count(*)::integer FROM information_schema.tables WHERE table_schema='ai_shadow') ai_relations,
        (SELECT count(*)::integer FROM information_schema.tables WHERE table_schema='shadow_meta') meta_relations,
        EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_stat_statements' AND extnamespace='public'::regnamespace) stat_statements
    `)).rows[0];
    if (!before.stat_statements) throw new Error("Production candidate pg_stat_statements extension is missing before schema reset");
    await provider.transaction(async (tx) => {
      await tx.executeScript("SET LOCAL lock_timeout='10s'");
      await tx.executeScript("DROP SCHEMA IF EXISTS app CASCADE; DROP SCHEMA IF EXISTS ai_shadow CASCADE; DROP SCHEMA IF EXISTS shadow_meta CASCADE;");
    });
    const after = (await provider.query(`
      SELECT
        to_regnamespace('app')::text app_schema,
        to_regnamespace('ai_shadow')::text ai_schema,
        to_regnamespace('shadow_meta')::text meta_schema,
        EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_stat_statements' AND extnamespace='public'::regnamespace) stat_statements
    `)).rows[0];
    assert.deepEqual(after, { app_schema: null, ai_schema: null, meta_schema: null, stat_statements: true });
    return { status: "PASS", before, publicExtensionPreserved: true, databaseRecreated: false };
  } finally {
    await provider.close();
  }
}

async function grantTemporaryCandidateDatabaseCreate(base, targetDatabase) {
  if (targetDatabase !== base.database || targetDatabase !== PHASE3D_PRODUCTION_CANDIDATE_DATABASE) {
    throw new Error("Temporary candidate CREATE grant rejected an unexpected target");
  }
  const admin = selectedProvider(base, { database: "postgres", user: base.adminUser, password: base.adminPassword });
  try {
    const before = Boolean((await admin.query("SELECT has_database_privilege($1,$2,'CREATE') allowed", [base.migratorUser, targetDatabase])).rows[0].allowed);
    if (!before) await admin.executeScript(`GRANT CREATE ON DATABASE ${quoteIdentifier(targetDatabase)} TO ${quoteIdentifier(base.migratorUser)}`);
    const during = Boolean((await admin.query("SELECT has_database_privilege($1,$2,'CREATE') allowed", [base.migratorUser, targetDatabase])).rows[0].allowed);
    if (!during) throw new Error("Temporary candidate database CREATE grant did not take effect");
    return { before, temporarilyGranted: !before, during };
  } finally {
    await admin.close();
  }
}

async function restoreCandidateDatabaseCreate(base, targetDatabase, privilege) {
  const admin = selectedProvider(base, { database: "postgres", user: base.adminUser, password: base.adminPassword });
  try {
    if (privilege.temporarilyGranted) {
      await admin.executeScript(`REVOKE CREATE ON DATABASE ${quoteIdentifier(targetDatabase)} FROM ${quoteIdentifier(base.migratorUser)}`);
    }
    const after = Boolean((await admin.query("SELECT has_database_privilege($1,$2,'CREATE') allowed", [base.migratorUser, targetDatabase])).rows[0].allowed);
    if (after !== privilege.before) throw new Error("Production candidate migrator CREATE privilege was not restored");
    return { ...privilege, restored: true, after };
  } finally {
    await admin.close();
  }
}

async function grantTemporaryCandidateDatabaseTemp(base, targetDatabase) {
  if (targetDatabase !== base.database || targetDatabase !== PHASE3D_PRODUCTION_CANDIDATE_DATABASE) {
    throw new Error("Temporary candidate TEMP grant rejected an unexpected target");
  }
  const admin = selectedProvider(base, { database: "postgres", user: base.adminUser, password: base.adminPassword });
  try {
    const before = Boolean((await admin.query("SELECT has_database_privilege($1,$2,'TEMP') allowed", [base.migratorUser, targetDatabase])).rows[0].allowed);
    if (!before) await admin.executeScript(`GRANT TEMPORARY ON DATABASE ${quoteIdentifier(targetDatabase)} TO ${quoteIdentifier(base.migratorUser)}`);
    const during = Boolean((await admin.query("SELECT has_database_privilege($1,$2,'TEMP') allowed", [base.migratorUser, targetDatabase])).rows[0].allowed);
    if (!during) throw new Error("Temporary candidate database TEMP grant did not take effect");
    return { before, temporarilyGranted: !before, during };
  } finally {
    await admin.close();
  }
}

async function restoreCandidateDatabaseTemp(base, targetDatabase, privilege) {
  const admin = selectedProvider(base, { database: "postgres", user: base.adminUser, password: base.adminPassword });
  try {
    if (privilege.temporarilyGranted) {
      await admin.executeScript(`REVOKE TEMPORARY ON DATABASE ${quoteIdentifier(targetDatabase)} FROM ${quoteIdentifier(base.migratorUser)}`);
    }
    const after = Boolean((await admin.query("SELECT has_database_privilege($1,$2,'TEMP') allowed", [base.migratorUser, targetDatabase])).rows[0].allowed);
    if (after !== privilege.before) throw new Error("Production candidate migrator TEMP privilege was not restored");
    return { ...privilege, restored: true, after };
  } finally {
    await admin.close();
  }
}

async function applyMigration(provider, migration) {
  const digest = crypto.createHash("sha256").update(migration.sql).digest("hex");
  if (digest !== migration.sha256) throw new Error(`Phase 3D migration checksum mismatch: ${migration.version}`);
  await provider.transaction(async (tx) => {
    await tx.executeScript("SET LOCAL lock_timeout='10s'");
    await tx.executeScript(migration.sql);
    await tx.query("INSERT INTO shadow_meta.schema_migrations(version,sha256) VALUES ($1,$2)", [migration.version, digest]);
  });
  return { version: migration.version, sha256: digest, status: "APPLIED" };
}

async function initializeSchema(base, targetDatabase, migrations) {
  const provider = selectedProvider(base, {
    database: targetDatabase,
    user: base.migratorUser,
    password: base.migratorPassword,
  });
  const byVersion = new Map(migrations.map((migration) => [migration.version, migration]));
  const beforeLoad = migrations.map((migration) => migration.version)
    .filter((version) => version !== "003_legacy_constraints_indexes_views.sql");
  try {
    const identity = (await provider.query("SELECT current_database() database,current_user username")).rows[0];
    assert.deepEqual(identity, { database: targetDatabase, username: base.migratorUser });
    await provider.transaction(async (tx) => {
      await tx.executeScript(`
        CREATE SCHEMA app AUTHORIZATION ${quoteIdentifier(base.migratorUser)};
        REVOKE ALL ON SCHEMA app FROM PUBLIC;
        ${shadowSchemaMigrationsSql()}
        REVOKE ALL ON SCHEMA shadow_meta FROM PUBLIC;
      `);
    });
    const applied = [];
    for (const version of beforeLoad) {
      const migration = byVersion.get(version);
      if (!migration) throw new Error(`Required Phase 3D migration is missing: ${version}`);
      applied.push(await applyMigration(provider, migration));
    }
    const constraint = (await provider.query(`
      SELECT conname FROM pg_constraint
      WHERE conrelid='shadow_meta.migration_state'::regclass AND contype='c'
        AND pg_get_constraintdef(oid) ILIKE '%target_provider%'
    `)).rows[0];
    if (!constraint) throw new Error("Phase 3D migration target-provider constraint is missing");
    await provider.executeScript(`
      ALTER TABLE shadow_meta.migration_state DROP CONSTRAINT ${quoteIdentifier(constraint.conname)};
      ALTER TABLE shadow_meta.migration_state ADD CONSTRAINT migration_state_target_provider_check
        CHECK (target_provider IN ('postgresql_shadow','postgresql_staging','postgresql_cutover_rehearsal','postgresql_production_candidate'));
    `);
    return applied;
  } finally {
    await provider.close();
  }
}

async function applyPendingSchemaMigrations(base, targetDatabase, migrations) {
  const provider = selectedProvider(base, {
    database: targetDatabase,
    user: base.migratorUser,
    password: base.migratorPassword,
  });
  try {
    const appliedRows = (await provider.query("SELECT version,sha256 FROM shadow_meta.schema_migrations ORDER BY version")).rows;
    const applied = new Map(appliedRows.map((row) => [row.version, row.sha256]));
    const results = [];
    for (const migration of migrations) {
      const existing = applied.get(migration.version);
      if (existing) {
        if (existing !== migration.sha256) throw new Error(`Applied Phase 3D migration checksum changed: ${migration.version}`);
        results.push({ version: migration.version, sha256: existing, status: "ALREADY_APPLIED" });
        continue;
      }
      results.push(await applyMigration(provider, migration));
    }
    const app = quoteIdentifier(base.appUser);
    await provider.executeScript(`
      REVOKE ALL ON SCHEMA app,ai_shadow,shadow_meta FROM ${app};
      GRANT USAGE ON SCHEMA app,ai_shadow TO ${app};
      GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA app,ai_shadow TO ${app};
      GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA app,ai_shadow TO ${app};
    `);
    return results;
  } finally {
    await provider.close();
  }
}

async function completeSchema(base, targetDatabase, migrations) {
  const provider = selectedProvider(base, {
    database: targetDatabase,
    user: base.migratorUser,
    password: base.migratorPassword,
  });
  try {
    const migration = migrations.find((item) => item.version === "003_legacy_constraints_indexes_views.sql");
    if (!migration) throw new Error("Deferred Phase 3D constraints/indexes/views migration is missing");
    const applied = await applyMigration(provider, migration);
    const app = quoteIdentifier(base.appUser);
    const migrator = quoteIdentifier(base.migratorUser);
    await provider.executeScript(`
      REVOKE ALL ON SCHEMA app,ai_shadow,shadow_meta FROM PUBLIC;
      REVOKE ALL ON SCHEMA app,ai_shadow,shadow_meta FROM ${app};
      REVOKE CREATE ON SCHEMA public FROM PUBLIC,${app};
      GRANT USAGE ON SCHEMA app,ai_shadow TO ${app};
      GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA app,ai_shadow TO ${app};
      GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA app,ai_shadow TO ${app};
      ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA app
        GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO ${app};
      ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA ai_shadow
        GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO ${app};
      ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA app
        GRANT USAGE,SELECT ON SEQUENCES TO ${app};
      ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA ai_shadow
        GRANT USAGE,SELECT ON SEQUENCES TO ${app};
    `);
    return applied;
  } finally {
    await provider.close();
  }
}

async function inspectTargetSchema(provider) {
  const columns = (await provider.query(`
    SELECT table_name,column_name,ordinal_position
    FROM information_schema.columns WHERE table_schema='app'
    ORDER BY table_name,ordinal_position
  `)).rows;
  const tableNames = (await provider.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema='app' AND table_type='BASE TABLE' ORDER BY table_name
  `)).rows.map((row) => row.table_name);
  const views = (await provider.query(`
    SELECT table_name FROM information_schema.views WHERE table_schema='app' ORDER BY table_name
  `)).rows.map((row) => row.table_name);
  return {
    tables: tableNames.map((name) => ({
      name,
      columns: columns.filter((column) => column.table_name === name).map((column) => ({ name: column.column_name })),
    })),
    views,
  };
}

function dataBatchRows(table) {
  return Math.min(DATA_BATCH_ROWS, Math.max(1, Math.floor(MAX_BIND_PARAMETERS / table.columns.length)));
}

function insertStatement(table, rows) {
  const columns = table.columns.map((column) => quoteIdentifier(column.name));
  const values = [];
  let index = 0;
  const tuples = rows.map((row) => `(${table.columns.map((column) => {
    values.push(encodePostgresqlMigrationValue(row[column.name], column));
    index += 1;
    return `$${index}`;
  }).join(",")})`);
  return { text: `INSERT INTO ${qualified(table.name)} (${columns.join(",")}) VALUES ${tuples.join(",")}`, values };
}

async function loadTable({ sourceDatabase, provider, table, snapshot }) {
  const current = Number((await provider.query(`SELECT count(*) total FROM ${qualified(table.name)}`)).rows[0].total);
  if (current !== 0) throw new Error(`Phase 3D full load found pre-existing rows: ${table.name}`);
  const projection = table.columns.map((column) => quoteIdentifier(column.name)).join(",");
  const batchRows = dataBatchRows(table);
  const statement = sourceDatabase.prepare(`SELECT ${projection} FROM ${quoteIdentifier(table.name)}`);
  let batch = [];
  let rows = 0;
  await provider.transaction(async (tx) => {
    await tx.executeScript("SET LOCAL synchronous_commit=off");
    for (const row of statement.iterate()) {
      batch.push(row);
      if (batch.length >= batchRows) {
        const insert = insertStatement(table, batch);
        await tx.query(insert.text, insert.values);
        rows += batch.length;
        batch = [];
      }
    }
    if (batch.length) {
      const insert = insertStatement(table, batch);
      await tx.query(insert.text, insert.values);
      rows += batch.length;
    }
    if (rows !== table.rowCount) throw new Error(`Phase 3D source row count changed during load: ${table.name}`);
    if (table.autoIncrement) {
      const identity = table.columns.find((column) => column.logicalType === "identity");
      if (identity) {
        await tx.query(`SELECT setval(pg_get_serial_sequence($1,$2),GREATEST(COALESCE(MAX(${quoteIdentifier(identity.name)}),1),1),COUNT(*)>0) FROM ${qualified(table.name)}`, [`app.${table.name}`, identity.name]);
      }
    }
    await tx.query(`
      INSERT INTO shadow_meta.table_loads(table_name,source_row_count,target_row_count,source_snapshot_sha256,status)
      VALUES ($1,$2,$2,$3,'SUCCEEDED')
    `, [table.name, rows, snapshot.sha256]);
  });
  return { table: table.name, rows, batches: Math.ceil(rows / batchRows), batchRows };
}

async function fullLoad({ base, targetDatabase, sourceDatabase, source, manifest, snapshot }) {
  const provider = selectedProvider(base, {
    database: targetDatabase,
    user: base.migratorUser,
    password: base.migratorPassword,
  });
  try {
    const target = await inspectTargetSchema(provider);
    const tableCoverage = schemaCoverage({ ...source, views: [] }, { ...target, views: [] });
    if (!tableCoverage.ok) throw new Error(`Phase 3D schema drift blocks full load: ${JSON.stringify(tableCoverage)}`);
    const loads = [];
    for (const spec of manifest) {
      const loaded = await loadTable({ sourceDatabase, provider, table: spec.table, snapshot });
      loads.push(loaded);
      process.stdout.write(`Phase 3D full load ${loaded.table}: ${loaded.rows}\n`);
    }
    return loads;
  } finally {
    await provider.close();
  }
}

async function sourceDigest(sourceDatabase, table) {
  const digest = createTableDigestAccumulator(table);
  const projection = table.columns.map((column) => quoteIdentifier(column.name)).join(",");
  for (const row of sourceDatabase.prepare(`SELECT ${projection} FROM ${quoteIdentifier(table.name)}`).iterate()) digest.add(row);
  return digest.finish();
}

async function targetDigest(provider, table) {
  const digest = createTableDigestAccumulator(table, { valuesAreNormalized: true });
  const projection = table.columns.map((column) => quoteIdentifier(column.name)).join(",");
  const batchRows = dataBatchRows(table);
  let rowCount = 0;
  await provider.transaction(async (tx) => {
    await tx.executeScript(`DECLARE phase3d_validation_cursor NO SCROLL CURSOR FOR SELECT ${projection} FROM ${qualified(table.name)}`);
    while (true) {
      const result = await tx.query(`FETCH FORWARD ${batchRows} FROM phase3d_validation_cursor`);
      if (!result.rows.length) break;
      for (const row of result.rows) {
        digest.add(Object.fromEntries(table.columns.map((column) => [
          column.name,
          normalizePostgresqlMigrationValue(row[column.name], column),
        ])));
      }
      rowCount += result.rows.length;
    }
  });
  return { ...digest.finish(), rowCount };
}

function sourceKeyBatches(sourceDatabase, table) {
  const keyColumns = table.primaryKey.map((name) => table.columns.find((column) => column.name === name));
  const batchRows = Math.min(KEY_BATCH_ROWS, Math.max(1, Math.floor(MAX_BIND_PARAMETERS / keyColumns.length)));
  const statement = sourceDatabase.prepare(`SELECT ${table.primaryKey.map(quoteIdentifier).join(",")} FROM ${quoteIdentifier(table.name)}`);
  return { keyColumns, batchRows, rows: statement.iterate() };
}

async function primaryKeyReconcile({ sourceDatabase, provider, table, applyDeletes = false }) {
  const keys = table.primaryKey.map(quoteIdentifier);
  const keyNames = keys.join(",");
  return provider.transaction(async (tx) => {
    await tx.executeScript(`CREATE TEMP TABLE phase3d_source_keys ON COMMIT DROP AS SELECT ${keyNames} FROM ${qualified(table.name)} WITH NO DATA`);
    const source = sourceKeyBatches(sourceDatabase, table);
    let batch = [];
    let sourceRows = 0;
    const flush = async () => {
      if (!batch.length) return;
      const values = [];
      let parameter = 0;
      const tuples = batch.map((row) => `(${source.keyColumns.map((column) => {
        values.push(encodePostgresqlMigrationValue(row[column.name], column));
        parameter += 1;
        return `$${parameter}`;
      }).join(",")})`);
      await tx.query(`INSERT INTO phase3d_source_keys(${keyNames}) VALUES ${tuples.join(",")}`, values);
      sourceRows += batch.length;
      batch = [];
    };
    for (const row of source.rows) {
      batch.push(row);
      if (batch.length >= source.batchRows) await flush();
    }
    await flush();
    await tx.executeScript(`CREATE UNIQUE INDEX phase3d_source_keys_pk ON phase3d_source_keys(${keyNames})`);
    const sourceOnly = Number((await tx.query(`SELECT count(*) total FROM (SELECT ${keyNames} FROM phase3d_source_keys EXCEPT SELECT ${keyNames} FROM ${qualified(table.name)}) diff`)).rows[0].total);
    const targetOnly = Number((await tx.query(`SELECT count(*) total FROM (SELECT ${keyNames} FROM ${qualified(table.name)} EXCEPT SELECT ${keyNames} FROM phase3d_source_keys) diff`)).rows[0].total);
    let deleted = 0;
    if (applyDeletes && targetOnly) {
      const match = table.primaryKey.map((name) => `target.${quoteIdentifier(name)} IS NOT DISTINCT FROM source.${quoteIdentifier(name)}`).join(" AND ");
      deleted = Number((await tx.query(`WITH deleted AS (DELETE FROM ${qualified(table.name)} target WHERE NOT EXISTS (SELECT 1 FROM phase3d_source_keys source WHERE ${match}) RETURNING 1) SELECT count(*) total FROM deleted`)).rows[0].total);
      if (deleted !== targetOnly) throw new Error(`Phase 3D target-only delete count changed: ${table.name}`);
    }
    return { sourceRows, sourceOnly, targetOnly, deleted };
  });
}

function sampleOffsets(tableName, count, size = 7) {
  if (!count) return [];
  const offsets = new Set([0, Math.floor(count / 2), count - 1]);
  let seed = crypto.createHash("sha256").update(`${tableName}:${count}`).digest().readUInt32BE(0);
  while (offsets.size < Math.min(size, count)) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    offsets.add(seed % count);
  }
  return [...offsets].sort((left, right) => left - right);
}

export async function validateSamples(sourceDatabase, provider, manifest) {
  const results = [];
  for (const name of CORE_SAMPLE_TABLES) {
    const spec = manifest.find((item) => item.name === name);
    if (!spec) throw new Error(`Phase 3D sample table is missing: ${name}`);
    const columns = spec.table.columns;
    const projection = columns.map((column) => quoteIdentifier(column.name)).join(",");
    const order = spec.primaryKey.map(quoteIdentifier).join(",");
    const count = Number(sourceDatabase.prepare(`SELECT count(*) total FROM ${quoteIdentifier(name)}`).get().total);
    for (const offset of sampleOffsets(name, count)) {
      const sourceRow = sourceDatabase.prepare(`SELECT ${projection} FROM ${quoteIdentifier(name)} ORDER BY ${order} LIMIT 1 OFFSET ?`).get(offset);
      const where = spec.primaryKey.map((key, index) => `${quoteIdentifier(key)}=$${index + 1}`).join(" AND ");
      const values = spec.primaryKey.map((key) => encodePostgresqlMigrationValue(sourceRow[key], columns.find((column) => column.name === key)));
      const targetRow = (await provider.query(`SELECT ${projection} FROM ${qualified(name)} WHERE ${where}`, values)).rows[0] || null;
      const normalizedSource = Object.fromEntries(columns.map((column) => [column.name, normalizeMigrationValue(sourceRow[column.name], column)]));
      const normalizedTarget = targetRow && Object.fromEntries(columns.map((column) => [column.name, normalizePostgresqlMigrationValue(targetRow[column.name], column)]));
      const primaryKeyHash = crypto.createHash("sha256").update(JSON.stringify(spec.primaryKey.map((key) => normalizedSource[key]))).digest("hex");
      results.push({ table: name, offset, primaryKeyHash, match: Boolean(targetRow) && equal(normalizedSource, normalizedTarget) });
    }
  }
  return { count: results.length, failures: results.filter((sample) => !sample.match).length, samples: results };
}

async function businessTotals(sourceDatabase, provider) {
  const metrics = Object.freeze({
    productSkus: "SELECT count(*) value FROM product_skus",
    orderHeaders: "SELECT count(*) value FROM growth_order_headers",
    orderLines: "SELECT count(*) value FROM growth_order_lines",
    orderedQuantity: "SELECT COALESCE(sum(quantity),0) value FROM growth_order_lines",
    inventorySnapshots: "SELECT count(*) value FROM growth_inventory_snapshots",
    availableInventory: "SELECT COALESCE(sum(available_quantity),0) value FROM growth_inventory_snapshots",
    foundationTasks: "SELECT count(*) value FROM foundation_tasks",
    auditEvents: "SELECT count(*) value FROM operation_audit_events",
    validPriceChanges: "SELECT count(*) value FROM product_price_change_events WHERE validity_status='VALID'",
    currentPricePoints: "SELECT count(*) value FROM product_sku_current_prices",
  });
  const result = {};
  for (const [name, sql] of Object.entries(metrics)) {
    const source = String(sourceDatabase.prepare(sql).get().value ?? "0");
    const target = String((await provider.query(sql)).rows[0].value ?? "0");
    result[name] = { source, target, match: source === target };
  }
  return result;
}

async function viewCounts(sourceDatabase, provider, views) {
  const result = [];
  for (const view of views) {
    const source = Number(sourceDatabase.prepare(`SELECT count(*) total FROM ${quoteIdentifier(view.name)}`).get().total);
    const target = Number((await provider.query(`SELECT count(*) total FROM ${qualified(view.name)}`)).rows[0].total);
    result.push({ view: view.name, source, target, match: source === target });
  }
  return result;
}

async function aiProjectionEvidence(sourceDatabase, provider) {
  const source = sourceDatabase.prepare(`
    SELECT
      (SELECT count(DISTINCT run_id) FROM operation_audit_events WHERE action='agent.run.started' AND run_id IS NOT NULL) agent_runs,
      (SELECT count(*) FROM operation_audit_events WHERE action='agent.tool.invoke') tool_invocations,
      (SELECT count(*) FROM operation_audit_events WHERE action='ai.gateway.complete') gateway_calls
  `).get();
  const target = (await provider.query(`
    SELECT
      (SELECT count(*) FROM ai_shadow.agent_runs) agent_runs,
      (SELECT count(*) FROM ai_shadow.tool_invocations) tool_invocations,
      (SELECT count(*) FROM ai_shadow.gateway_calls) gateway_calls,
      (SELECT count(*) FROM ai_shadow.tool_invocations tool LEFT JOIN ai_shadow.agent_runs run ON run.id=tool.agent_run_id WHERE tool.agent_run_id IS NOT NULL AND run.id IS NULL) orphan_tools
  `)).rows[0];
  const normalizedSource = Object.fromEntries(Object.entries(source).map(([key, value]) => [key, Number(value)]));
  const normalizedTarget = Object.fromEntries(Object.entries(target).map(([key, value]) => [key, Number(value)]));
  return {
    source: normalizedSource,
    target: normalizedTarget,
    match: ["agent_runs", "tool_invocations", "gateway_calls"].every((key) => normalizedSource[key] === normalizedTarget[key]) && normalizedTarget.orphan_tools === 0,
  };
}

async function validateFull({ base, targetDatabase, sourceDatabase, source, manifest }) {
  const provider = selectedProvider(base, {
    database: targetDatabase,
    user: base.migratorUser,
    password: base.migratorPassword,
    readOnly: false,
  });
  try {
    const targetSchema = await inspectTargetSchema(provider);
    const coverage = schemaCoverage(source, targetSchema);
    const sourceNames = source.tables.map((table) => table.name);
    const [indexEvidence, foreignKeys, targetOnly] = await Promise.all([
      provider.query("SELECT count(*)::integer count FROM pg_indexes WHERE schemaname='app' AND tablename=ANY($1::text[])", [sourceNames]),
      provider.query(`SELECT count(*)::integer count,COALESCE(bool_and(convalidated),true) validated FROM pg_constraint con JOIN pg_class rel ON rel.oid=con.conrelid JOIN pg_namespace ns ON ns.oid=rel.relnamespace WHERE ns.nspname='app' AND rel.relname=ANY($1::text[]) AND con.contype='f'`, [sourceNames]),
      Promise.all(TARGET_ONLY_TABLES.map(async (table) => ({ table, rows: Number((await provider.query(`SELECT count(*) total FROM ${qualified(table)}`)).rows[0].total) }))),
    ]);
    const tables = [];
    for (const spec of manifest) {
      const [sourceHash, targetHash, primaryKeys] = await Promise.all([
        sourceDigest(sourceDatabase, spec.table),
        targetDigest(provider, spec.table),
        primaryKeyReconcile({ sourceDatabase, provider, table: spec.table }),
      ]);
      const result = {
        table: spec.name,
        rows: spec.table.rowCount,
        countMatch: sourceHash.rowCount === targetHash.rowCount,
        fullDigestMatch: sourceHash.full === targetHash.full,
        keyDigestMatch: sourceHash.keys === targetHash.keys,
        primaryKeySourceOnly: primaryKeys.sourceOnly,
        primaryKeyTargetOnly: primaryKeys.targetOnly,
      };
      tables.push(result);
      process.stdout.write(`Phase 3D validate ${spec.name}: ${result.fullDigestMatch && !result.primaryKeySourceOnly && !result.primaryKeyTargetOnly ? "PASS" : "FAIL"}\n`);
    }
    const [samples, totals, views, ai] = await Promise.all([
      validateSamples(sourceDatabase, provider, manifest),
      businessTotals(sourceDatabase, provider),
      viewCounts(sourceDatabase, provider, source.views || []),
      aiProjectionEvidence(sourceDatabase, provider),
    ]);
    const failures = [];
    if (!coverage.ok) failures.push("SCHEMA_COVERAGE");
    if (Number(indexEvidence.rows[0].count) !== buildShadowSchema(sourceDatabase).expected.indexes) failures.push("INDEX_COUNT");
    if (!foreignKeys.rows[0].validated) failures.push("FOREIGN_KEYS_NOT_VALIDATED");
    if (targetOnly.some((table) => table.rows !== 0)) failures.push("TARGET_ONLY_BASELINE_ROWS");
    if (tables.some((table) => !table.countMatch || !table.fullDigestMatch || !table.keyDigestMatch || table.primaryKeySourceOnly || table.primaryKeyTargetOnly)) failures.push("TABLE_DATA_PARITY");
    if (samples.failures) failures.push("DETERMINISTIC_SAMPLES");
    if (Object.values(totals).some((metric) => !metric.match)) failures.push("BUSINESS_TOTALS");
    if (views.some((view) => !view.match)) failures.push("VIEW_RESULTS");
    if (!ai.match) failures.push("AI_PROJECTIONS");
    return {
      status: failures.length ? "FAIL" : "PASS",
      failures,
      coverage,
      indexes: { sourceExpected: buildShadowSchema(sourceDatabase).expected.indexes, target: Number(indexEvidence.rows[0].count), match: !failures.includes("INDEX_COUNT") },
      foreignKeys: { count: Number(foreignKeys.rows[0].count), validated: Boolean(foreignKeys.rows[0].validated) },
      targetOnly,
      tables,
      samples,
      businessTotals: totals,
      views,
      ai,
    };
  } finally {
    await provider.close();
  }
}

async function reconcileChangedTables({
  base,
  targetDatabase,
  sourceDatabase,
  manifest,
  preValidation,
  snapshot,
  stateId = PHASE3D_REHEARSAL_STATE_ID,
  targetProvider = "postgresql_cutover_rehearsal",
}) {
  const reconcileStarted = performance.now();
  const provider = selectedProvider(base, {
    database: targetDatabase,
    user: base.migratorUser,
    password: base.migratorPassword,
  });
  const control = new SyncControlRepository({
    provider,
    stateId,
    targetProvider,
  });
  for (const spec of manifest) {
    await control.seedTableState({
      spec,
      watermarkValue: null,
      watermarkPrimaryKey: [],
      sourceCount: 0,
      targetCount: Number((await provider.query(`SELECT count(*) total FROM ${qualified(spec.name)}`)).rows[0].total),
    });
  }
  const batchId = await control.startBatch({ mode: "FULL_RECONCILE", sourceSnapshotTime: snapshot.time, sourceSnapshotSha256: snapshot.sha256 });
  const changedNames = new Set(preValidation.tables.filter((table) => !table.fullDigestMatch || table.primaryKeySourceOnly || table.primaryKeyTargetOnly).map((table) => table.table));
  const tables = [];
  try {
    for (const spec of manifest) {
      if (!changedNames.has(spec.name)) {
        tables.push({ table: spec.name, examined: spec.table.rowCount, inserted: 0, updated: 0, deleted: 0, skipped: spec.table.rowCount });
        continue;
      }
      const projection = spec.table.columns.map((column) => quoteIdentifier(column.name)).join(",");
      const statement = sourceDatabase.prepare(`SELECT ${projection} FROM ${quoteIdentifier(spec.name)}`);
      const batchRows = dataBatchRows(spec.table);
      let batch = [];
      let examined = 0;
      let inserted = 0;
      let updated = 0;
      await provider.transaction(async (tx) => {
        await tx.executeScript("SET LOCAL synchronous_commit=off");
        const flush = async () => {
          if (!batch.length) return;
          const encoded = batch.map((row) => spec.table.columns.map((column) => encodePostgresqlMigrationValue(row[column.name], column)));
          const upsert = buildPostgresqlUpsert(spec.table, encoded);
          const result = await tx.query(upsert.text, upsert.values);
          for (const row of result.rows) row.inserted ? inserted += 1 : updated += 1;
          examined += batch.length;
          batch = [];
        };
        for (const row of statement.iterate()) {
          batch.push(row);
          if (batch.length >= batchRows) await flush();
        }
        await flush();
      });
      tables.push({ table: spec.name, examined, inserted, updated, deleted: 0, skipped: 0 });
    }
    for (const spec of [...manifest].reverse()) {
      if (!changedNames.has(spec.name)) continue;
      const keys = await primaryKeyReconcile({ sourceDatabase, provider, table: spec.table, applyDeletes: true });
      const table = tables.find((item) => item.table === spec.name);
      table.deleted = keys.deleted;
    }
    const aiTables = (await provider.query("SELECT table_name FROM information_schema.tables WHERE table_schema='ai_shadow' AND table_type='BASE TABLE' ORDER BY table_name")).rows.map((row) => `ai_shadow.${quoteIdentifier(row.table_name)}`);
    if (aiTables.length) await provider.executeScript(`TRUNCATE TABLE ${aiTables.join(",")} CASCADE`);
    const observability = await projectAgentObservability(provider);
    for (const spec of manifest) {
      const table = tables.find((item) => item.table === spec.name);
      await provider.query(`
        INSERT INTO shadow_meta.table_loads(table_name,source_row_count,target_row_count,source_snapshot_sha256,status,loaded_at)
        VALUES ($1,$2,$2,$3,'SUCCEEDED',CURRENT_TIMESTAMP)
        ON CONFLICT (table_name) DO UPDATE SET source_row_count=EXCLUDED.source_row_count,target_row_count=EXCLUDED.target_row_count,source_snapshot_sha256=EXCLUDED.source_snapshot_sha256,status='SUCCEEDED',loaded_at=CURRENT_TIMESTAMP
      `, [spec.name, spec.table.rowCount, snapshot.sha256]);
      await control.updateTableState({ spec, batchId, watermarkValue: null, watermarkPrimaryKey: [], sourceCount: spec.table.rowCount, targetCount: spec.table.rowCount });
      table.status = "SUCCEEDED";
    }
    const summary = {
      batchId,
      mode: "FULL_RECONCILE",
      tables,
      rowsExamined: tables.reduce((sum, table) => sum + table.examined, 0),
      rowsInserted: tables.reduce((sum, table) => sum + table.inserted, 0),
      rowsUpdated: tables.reduce((sum, table) => sum + table.updated, 0),
      rowsDeleted: tables.reduce((sum, table) => sum + table.deleted, 0),
      rowsSkipped: tables.reduce((sum, table) => sum + table.skipped, 0),
      observability,
      reconcileDurationMs: Math.round(performance.now() - reconcileStarted),
    };
    await control.completeBatch({ batchId, summary });
    return summary;
  } catch (error) {
    await control.failBatch({ batchId, errorCode: String(error?.code || "PHASE3D_RECONCILE_FAILED"), errorSummary: firstLine(error?.message || error) });
    throw error;
  } finally {
    await provider.close();
  }
}

async function synchronizationTimingHistory(base, targetDatabase, stateId = PHASE3D_REHEARSAL_STATE_ID) {
  const provider = selectedProvider(base, {
    database: targetDatabase,
    user: base.migratorUser,
    password: base.migratorPassword,
    readOnly: true,
  });
  try {
    const rows = (await provider.query(`
      SELECT id,started_at,completed_at,
        round(EXTRACT(EPOCH FROM (completed_at-started_at))*1000)::bigint duration_ms,
        table_count,rows_examined,rows_inserted,rows_updated,rows_skipped
      FROM shadow_meta.migration_sync_batches
      WHERE migration_state_id=$1 AND status='SUCCEEDED'
      ORDER BY started_at
    `, [stateId])).rows.map((row) => ({ ...row, duration_ms: Number(row.duration_ms) }));
    const durations = rows.map((row) => row.duration_ms).sort((left, right) => left - right);
    const p95Ms = durations.length ? durations[Math.max(0, Math.ceil(durations.length * 0.95) - 1)] : null;
    return { successfulRuns: rows.length, durationsMs: durations, p95Ms, batches: rows };
  } finally {
    await provider.close();
  }
}

async function initializeControl({
  base,
  targetDatabase,
  sourceDatabase,
  manifest,
  snapshot,
  stateId = PHASE3D_REHEARSAL_STATE_ID,
  targetProvider = "postgresql_cutover_rehearsal",
}) {
  const provider = selectedProvider(base, {
    database: targetDatabase,
    user: base.migratorUser,
    password: base.migratorPassword,
  });
  try {
    const control = new SyncControlRepository({ provider, stateId, targetProvider });
    await control.ensureState({ migrationSnapshotTime: snapshot.time, sourceSnapshotSha256: snapshot.sha256 });
    const seeded = await seedSyncStateFromBaseline({ baselineDatabase: sourceDatabase, provider, control, manifest });
    return { state: await control.getState(), seededTables: seeded.length };
  } finally {
    await provider.close();
  }
}

async function recordValidation({
  base,
  targetDatabase,
  validation,
  snapshot,
  batchId = null,
  stateId = PHASE3D_REHEARSAL_STATE_ID,
  targetProvider = "postgresql_cutover_rehearsal",
}) {
  const provider = selectedProvider(base, {
    database: targetDatabase,
    user: base.migratorUser,
    password: base.migratorPassword,
  });
  try {
    const control = new SyncControlRepository({ provider, stateId, targetProvider });
    const compact = {
      status: validation.status,
      sourceSnapshotTime: snapshot.time,
      sourceSnapshotSha256: snapshot.sha256,
      tables: validation.tables.map((table) => ({ table: table.table, countMatch: table.countMatch && !table.primaryKeySourceOnly && !table.primaryKeyTargetOnly })),
      sampleCount: validation.samples.count,
      sampleFailures: validation.samples.failures,
      failures: validation.failures,
    };
    const id = await control.recordValidation({ syncBatchId: batchId, validation: compact });
    return { id, state: await control.getState() };
  } finally {
    await provider.close();
  }
}

export async function verifyApplicationRole(base, targetDatabase) {
  const migrator = selectedProvider(base, { database: targetDatabase, user: base.migratorUser, password: base.migratorPassword });
  const app = selectedProvider(base, { database: targetDatabase, user: base.appUser, password: base.appPassword });
  const forbiddenTable = "phase3d_forbidden_ddl";
  let createDenied = false;
  try {
    const identity = (await app.query("SELECT current_database() database,current_user username,current_schema() schema,current_setting('default_transaction_read_only') read_only")).rows[0];
    assert.deepEqual(identity, { database: targetDatabase, username: base.appUser, schema: "app", read_only: "off" });
    const privileges = (await app.query(`
      SELECT role.rolsuper,role.rolcreatedb,role.rolcreaterole,role.rolreplication,role.rolbypassrls,
        has_database_privilege(current_user,current_database(),'CREATE') database_create,
        has_database_privilege(current_user,current_database(),'TEMP') database_temp,
        has_schema_privilege(current_user,'app','CREATE') app_schema_create,
        has_schema_privilege(current_user,'public','CREATE') public_schema_create,
        (SELECT count(*)::integer FROM pg_class rel JOIN pg_namespace ns ON ns.oid=rel.relnamespace WHERE ns.nspname IN ('app','ai_shadow') AND rel.relowner=role.oid) owned_relations
      FROM pg_roles role WHERE role.rolname=current_user
    `)).rows[0];
    try {
      await app.executeScript(`CREATE TABLE app.${quoteIdentifier(forbiddenTable)}(id integer)`);
    } catch (error) {
      createDenied = String(error?.code || "") === "42501" || /permission denied|must be owner/i.test(String(error?.message || error));
    }
    if (!createDenied) throw new Error("Phase 3D application role unexpectedly executed CREATE TABLE");
    const flagsDenied = !privileges.rolsuper && !privileges.rolcreatedb && !privileges.rolcreaterole && !privileges.rolreplication && !privileges.rolbypassrls
      && !privileges.database_create && !privileges.database_temp && !privileges.app_schema_create && !privileges.public_schema_create && Number(privileges.owned_relations) === 0;
    if (!flagsDenied) throw new Error("Phase 3D application role retains forbidden DDL or role privileges");
    await app.query("SELECT count(*) FROM product_skus");
    return { status: "PASS", identity, privileges, createDenied, crudGranted: true };
  } finally {
    try { await migrator.executeScript(`DROP TABLE IF EXISTS app.${quoteIdentifier(forbiddenTable)}`); } catch {}
    await app.close();
    await migrator.close();
  }
}

export async function runCoreWriteContract(base, targetDatabase) {
  const provider = selectedProvider(base, { database: targetDatabase, user: base.appUser, password: base.appPassword });
  const prefix = `phase3d-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const ids = {
    preference: `${prefix}-preference`, salesBatch: `${prefix}-sales-batch`, inventoryBatch: `${prefix}-inventory-batch`,
    order: `${prefix}-order`, inventory: `${prefix}-inventory`, task: `${prefix}-task`, audit: `${prefix}-audit`,
    agentRun: `${prefix}-agent-run`, agentStart: `${prefix}-agent-start`, agentTool: `${prefix}-agent-tool`, agentEnd: `${prefix}-agent-end`,
  };
  async function cleanup() {
    await provider.execute("DELETE FROM ai_shadow.agent_runs WHERE id=$1", [ids.agentRun]);
    await provider.execute("DELETE FROM operation_audit_events WHERE id=ANY($1::text[])", [[ids.audit, ids.agentStart, ids.agentTool, ids.agentEnd]]);
    await provider.execute("DELETE FROM foundation_tasks WHERE id=$1", [ids.task]);
    await provider.execute("DELETE FROM growth_inventory_snapshots WHERE id=$1", [ids.inventory]);
    await provider.execute("DELETE FROM growth_order_headers WHERE id=$1", [ids.order]);
    await provider.execute("DELETE FROM growth_source_batches WHERE id=ANY($1::text[])", [[ids.salesBatch, ids.inventoryBatch]]);
    await provider.execute("DELETE FROM product_detail_preferences WHERE scope_key=$1", [ids.preference]);
  }
  try {
    await cleanup();
    await provider.execute("INSERT INTO product_detail_preferences(scope_key,visible_fields_json,operator_label,request_id,created_at,updated_at) VALUES ($1,$2::jsonb,'phase3d',$3,$4,$4)", [ids.preference, JSON.stringify(["sourceSku"]), prefix, now]);
    for (const [id, sourceType] of [[ids.salesBatch, "mabang_order"], [ids.inventoryBatch, "mabang_inventory"]]) {
      await provider.execute("INSERT INTO growth_source_batches(id,source_type,source_module,source_sha256,idempotency_key,row_count,status,created_by,created_at,updated_at) VALUES ($1,$2,'phase3d',$3,$1,1,'applied','phase3d',$4,$4)", [id, sourceType, crypto.createHash("sha256").update(id).digest("hex"), now]);
    }
    await provider.execute(`INSERT INTO growth_order_headers(id,business_key,business_key_version,platform,source_shop_name,normalized_source_shop_name,source_order_id,order_status,effective_status,first_source_batch_id,source_batch_id,source_quality_status,first_seen_at,last_seen_at,created_at,updated_at) VALUES ($1,$1,'phase3d-v1','TEST','Phase3D Shop','phase3d shop',$1,'paid','valid',$2,$2,'confirmed',$3,$3,$3,$3)`, [ids.order, ids.salesBatch, now]);
    await provider.execute(`INSERT INTO growth_inventory_snapshots(id,batch_id,source_row_number,source_sku,normalized_source_sku,warehouse_name,available_quantity,snapshot_at,mapping_status,quality_status,created_at,normalized_warehouse_name) VALUES ($1,$2,2,$1,$1,'Phase3D Warehouse',1,$3,'unmatched','confirmed',$3,'phase3d warehouse')`, [ids.inventory, ids.inventoryBatch, now]);
    await provider.execute(`INSERT INTO foundation_tasks(id,domain,task_kind,execution_mode,domain_ref_type,domain_ref_id,state,priority,idempotency_key,input_json,evidence_json,result_json,created_by,created_at,updated_at) VALUES ($1,'growth','phase3d_contract','system','rehearsal',$1,'PENDING','P3',$1,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'phase3d',$2,$2)`, [ids.task, now]);
    const events = [
      [ids.audit, "phase3d.write", null, {}],
      [ids.agentStart, "agent.run.started", ids.agentRun, { agentName: "phase3d.readiness", agentVersion: "1.0.0", contextVersions: "rehearsal@1" }],
      [ids.agentTool, "agent.tool.invoke", ids.agentRun, { toolName: "phase3d.health", toolVersion: "1.0.0" }],
      [ids.agentEnd, "agent.run.completed", ids.agentRun, { agentName: "phase3d.readiness", agentVersion: "1.0.0", totalTokens: 0 }],
    ];
    for (const [id, action, runId, metadata] of events) {
      await provider.execute(`INSERT INTO operation_audit_events(id,request_id,occurred_at,module,action,status,duration_ms,actor_type,actor_identifier,run_id,metadata_json,created_at) VALUES ($1,$2,$3,'phase3d',$4,'success',0,'system','phase3d',$5,$6::jsonb,$3)`, [id, prefix, now, action, runId, JSON.stringify(metadata)]);
    }
    await projectAgentObservability(provider);
    const counts = (await provider.query(`SELECT
      (SELECT count(*)::integer FROM product_detail_preferences WHERE scope_key=$1) product,
      (SELECT count(*)::integer FROM growth_order_headers WHERE id=$2) sales,
      (SELECT count(*)::integer FROM growth_inventory_snapshots WHERE id=$3) inventory,
      (SELECT count(*)::integer FROM foundation_tasks WHERE id=$4) task,
      (SELECT count(*)::integer FROM operation_audit_events WHERE id=$5) audit,
      (SELECT count(*)::integer FROM ai_shadow.agent_runs WHERE id=$6) agent_run,
      (SELECT count(*)::integer FROM ai_shadow.tool_invocations WHERE agent_run_id=$6) tool_invocation`, [ids.preference, ids.order, ids.inventory, ids.task, ids.audit, ids.agentRun])).rows[0];
    assert.deepEqual(counts, { product: 1, sales: 1, inventory: 1, task: 1, audit: 1, agent_run: 1, tool_invocation: 1 });
    return { status: "PASS", domains: ["Product", "Sales", "Inventory", "Task", "Audit", "Agent Run", "Tool Invocation"], counts, externalCalls: 0 };
  } finally {
    await cleanup();
    const residue = (await provider.query(`SELECT
      (SELECT count(*)::integer FROM product_detail_preferences WHERE scope_key=$1)
      +(SELECT count(*)::integer FROM growth_source_batches WHERE id=ANY($2::text[]))
      +(SELECT count(*)::integer FROM foundation_tasks WHERE id=$3)
      +(SELECT count(*)::integer FROM operation_audit_events WHERE request_id=$4)
      +(SELECT count(*)::integer FROM ai_shadow.agent_runs WHERE id=$5) total`, [ids.preference, [ids.salesBatch, ids.inventoryBatch], ids.task, prefix, ids.agentRun])).rows[0];
    assert.equal(residue.total, 0);
    await provider.close();
  }
}

function runNodeJson(relativeScript, args = [], env = process.env, timeoutMs = 300_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(rootDir, relativeScript), ...args], {
      cwd: rootDir,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`${relativeScript} failed: ${firstLine(stderr || stdout)}`));
      try { resolve(JSON.parse(stdout.trim())); } catch { reject(new Error(`${relativeScript} returned invalid JSON`)); }
    });
    child.once("error", reject);
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function healthRequest(port) {
  return new Promise((resolve, reject) => {
    const request = http.get(`http://127.0.0.1:${port}/api/health`, { timeout: 2_000 }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        try { resolve({ statusCode: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); }
        catch (error) { reject(error); }
      });
    });
    request.on("timeout", () => request.destroy(new Error("Health request timed out")));
    request.on("error", reject);
  });
}

export async function serviceSwitchDryRun(base, targetDatabase, { mode = "rehearsal" } = {}) {
  const rehearsalMode = mode === "rehearsal";
  const productionCandidate = mode === "production-candidate";
  const productionMode = mode === "production";
  if (!new Set(["rehearsal", "production-candidate", "production"]).has(mode)) throw new TypeError("Unknown Phase 3D service validation mode");
  if ((productionCandidate || productionMode) && (targetDatabase !== base.database || targetDatabase !== PHASE3D_PRODUCTION_CANDIDATE_DATABASE)) {
    throw new Error("Production service validation rejected an unexpected target");
  }
  const port = await freePort();
  const startedAt = new Date().toISOString();
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(rootDir, "server.mjs")], {
    cwd: rootDir,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      DATABASE_PROVIDER: "postgres",
      POSTGRES_SHADOW_MODE: "false",
      POSTGRES_STAGING_MODE: "false",
      POSTGRES_CUTOVER_REHEARSAL_MODE: rehearsalMode ? "true" : "false",
      POSTGRES_CUTOVER_REHEARSAL_CONFIRM_DATABASE: rehearsalMode ? targetDatabase : "",
      POSTGRES_PRODUCTION_CANDIDATE_MODE: productionCandidate ? "true" : "false",
      POSTGRES_PRODUCTION_CANDIDATE_CONFIRM_DATABASE: productionCandidate ? targetDatabase : "",
      POSTGRES_PRODUCTION_CANDIDATE_CONFIRM_SCOPE: productionCandidate ? PHASE3D_PRODUCTION_CANDIDATE_SCOPE : "",
      POSTGRES_PRODUCTION_MODE: productionMode ? "true" : "false",
      POSTGRES_PRODUCTION_CONFIRM_DATABASE: productionMode ? targetDatabase : "",
      POSTGRES_PRODUCTION_CONFIRM_SCOPE: productionMode ? PHASE3D_PRODUCTION_MODE_SCOPE : "",
      APP_PORT: String(port), PORT: String(port), HOST: "127.0.0.1",
      AD_SERVICE_MODE: "external",
      PRICE_CONTROL_SYNC_ENABLED: "false",
      PRICE_CONTROL_MANUAL_SYNC_ENABLED: "false",
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  let health;
  try {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Phase 3D service exited before health check: ${firstLine(stderr)}`);
      try {
        health = await healthRequest(port);
        if (health.statusCode === 200) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!health || health.statusCode !== 200) throw new Error("Phase 3D PostgreSQL service health check did not pass");
    return {
      status: "PASS",
      processScopedProvider: "postgres",
      mode,
      target: targetDatabase,
      applicationRole: base.appUser,
      healthStatus: health.statusCode,
      healthProvider: health.body?.databaseProvider || health.body?.provider || null,
      externalCalls: 0,
      productionConfigChanged: false,
      startupLogObserved: Boolean(stdout.trim()),
    };
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 5_000))]);
    if (child.exitCode === null) child.kill("SIGKILL");
    const cleanup = selectedProvider(base, { database: targetDatabase, user: base.appUser, password: base.appPassword });
    try {
      await cleanup.execute("DELETE FROM operation_audit_events WHERE module='file' AND action='file.temp.cleanup' AND created_at >= $1", [startedAt]);
    } catch {} finally { await cleanup.close(); }
  }
}

async function createSnapshot(runtime, label) {
  const directory = path.join(rootDir, "tmp", "postgresql-phase3d");
  await fs.mkdir(directory, { recursive: true });
  const snapshotPath = path.join(directory, `${label}-${stamp()}-${crypto.randomUUID().slice(0, 8)}.sqlite`);
  const started = performance.now();
  const info = await createSqliteMigrationSnapshot({
    sourcePath: runtime.databasePath,
    destinationPath: snapshotPath,
    backupRatePages: 4096,
    pinReadSnapshot: true,
  });
  if (info.integrity !== "ok" || info.foreignKeyViolations !== 0) throw new Error("Phase 3D SQLite snapshot failed integrity gates");
  return {
    path: snapshotPath,
    relativePath: path.relative(rootDir, snapshotPath).split(path.sep).join("/"),
    time: (await fs.stat(snapshotPath)).mtime.toISOString(),
    sha256: info.snapshotHash,
    sourceBytes: info.sourceBytes,
    snapshotBytes: info.snapshotBytes,
    integrity: info.integrity,
    foreignKeyViolations: info.foreignKeyViolations,
    durationMs: Math.round(performance.now() - started),
  };
}

function reportMarkdown(result) {
  const gates = result.gates.map((gate) => `| ${gate.name} | ${gate.status} | ${gate.evidence} |`).join("\n");
  return [
    "# Commerce Ops PostgreSQL Phase 3D Cutover/Rollback Rehearsal",
    "",
    `Status: **${result.status}**  `,
    "Production provider: `sqlite`  ",
    `Rehearsal target: \`${result.target}\`  `,
    "`is_switch_ready`: **false**",
    "",
    "## Safety boundary",
    "",
    "- Formal SQLite remained the production provider and was accessed through a pinned online-backup snapshot for transfer and validation.",
    "- Formal `commerce_ops`, Shadow, migration-test, and staging databases were not rebuilt or used as the rehearsal target.",
    "- Provider switching was process-scoped; no persistent `DATABASE_PROVIDER` change occurred.",
    "- No external action or business Agent was developed or invoked.",
    "",
    "## Source snapshot",
    "",
    `- Tables: ${result.source.tables}`,
    `- Views: ${result.source.views}`,
    `- Rows: ${result.source.rows}`,
    `- Snapshot SHA-256: \`${result.snapshot.sha256}\``,
    `- Snapshot integrity: \`${result.snapshot.integrity}\``,
    `- Snapshot creation: ${result.snapshot.durationMs} ms`,
    "",
    "## Gates",
    "",
    "| Gate | Status | Evidence |",
    "|---|---|---|",
    gates,
    "",
    "## Synchronization timing",
    "",
    `- Operation: ${result.operation}`,
    `- Total rehearsal: ${result.timing.totalMs} ms`,
    `- Full pre-validation and reconcile: ${result.timing.syncMs} ms`,
    `- Final full validation: ${result.timing.validationMs} ms`,
    `- Rows inserted: ${result.synchronization.rowsInserted}`,
    `- Rows updated: ${result.synchronization.rowsUpdated}`,
    `- Rows deleted: ${result.synchronization.rowsDeleted}`,
    `- Rows skipped: ${result.synchronization.rowsSkipped}`,
    `- Successful reconcile runs: ${result.synchronizationTiming.successfulRuns}`,
    `- Reconcile durations: ${result.synchronizationTiming.durationsMs.join(", ")} ms`,
    `- Measured reconcile p95: ${result.synchronizationTiming.p95Ms} ms`,
    "",
    "## Remaining blockers",
    "",
    ...result.blockers.map((item) => `- ${item}`),
    "",
    "## Cutover position",
    "",
    "This run proves the independent rehearsal path against a consistent current snapshot. It does not authorize production cutover. Because SQLite feature development remains active, the final gate is a separately approved write freeze, final pinned snapshot, full-source reconcile, zero-difference validation, and provider switch.",
    "",
  ].join("\n");
}

async function writeReport(result) {
  const directory = path.join(rootDir, "docs", "reports");
  await fs.mkdir(directory, { recursive: true });
  const basename = `COMMERCE-OPS-POSTGRESQL-PHASE3D-REHEARSAL-${stamp()}`;
  const jsonPath = path.join(directory, `${basename}.json`);
  const markdownPath = path.join(directory, `${basename}.md`);
  const portable = { ...result, snapshot: { ...result.snapshot, path: undefined } };
  await fs.writeFile(jsonPath, `${JSON.stringify(portable, null, 2)}\n`, "utf8");
  await fs.writeFile(markdownPath, reportMarkdown(portable), "utf8");
  return { jsonPath, markdownPath };
}

function candidateReportMarkdown(result) {
  const gates = result.gates.map((gate) => `| ${gate.name} | ${gate.status} | ${gate.evidence} |`).join("\n");
  return [
    "# Commerce Ops PostgreSQL Production Candidate Sync",
    "",
    `Status: **${result.status}**  `,
    "Active production provider: `sqlite`  ",
    `Candidate target: \`${result.target}\`  `,
    "`is_switch_ready`: **false**",
    "",
    "## Safety boundary",
    "",
    "- The formal PostgreSQL candidate was initialized or refreshed under exact production-mutation confirmation.",
    "- SQLite remained the active production provider and was read through a pinned online-backup snapshot.",
    "- No persistent `DATABASE_PROVIDER` change, external call, Daily Report delivery, or Agent business action occurred.",
    "- This is a warm candidate synchronization. It is not the final frozen-source synchronization and does not authorize cutover.",
    "",
    "## Source snapshot",
    "",
    `- Tables: ${result.source.tables}`,
    `- Views: ${result.source.views}`,
    `- Rows: ${result.source.rows}`,
    `- Snapshot SHA-256: \`${result.snapshot.sha256}\``,
    `- Integrity: \`${result.snapshot.integrity}\`; foreign-key violations: ${result.snapshot.foreignKeyViolations}`,
    "",
    "## Gates",
    "",
    "| Gate | Status | Evidence |",
    "|---|---|---|",
    gates,
    "",
    "## Remaining blockers",
    "",
    ...result.blockers.map((item) => `- ${item}`),
    "",
    "## Decision",
    "",
    "The candidate is warm and fully validated against this pinned snapshot. Stop here until the user explicitly approves the final writer freeze, final pinned snapshot/full-source refresh, and provider switch.",
    "",
  ].join("\n");
}

async function writeCandidateReport(result) {
  const directory = path.join(rootDir, "docs", "reports");
  await fs.mkdir(directory, { recursive: true });
  const basename = `COMMERCE-OPS-POSTGRESQL-PRODUCTION-CANDIDATE-${stamp()}`;
  const jsonPath = path.join(directory, `${basename}.json`);
  const markdownPath = path.join(directory, `${basename}.md`);
  const portable = { ...result, snapshot: { ...result.snapshot, path: undefined } };
  await fs.writeFile(jsonPath, `${JSON.stringify(portable, null, 2)}\n`, "utf8");
  await fs.writeFile(markdownPath, candidateReportMarkdown(portable), "utf8");
  return { jsonPath, markdownPath };
}

export async function runProductionCandidateSync(argv = process.argv.slice(2)) {
  loadLocalEnv(rootDir);
  const productionProvider = String(process.env.DATABASE_PROVIDER || "sqlite").trim().toLowerCase();
  if (productionProvider !== "sqlite") throw new Error("Production candidate synchronization requires active production DATABASE_PROVIDER=sqlite");
  const base = loadPostgresqlF1Config({ rootDir });
  const runtime = resolveRuntimeConfig({ bootstrapRoot: rootDir, env: process.env });
  const invocation = resolveProductionCandidateInvocation(argv, base);
  if (!invocation.apply) {
    return {
      status: "PLAN",
      contract: PHASE3D_PRODUCTION_CANDIDATE_CONTRACT,
      target: invocation.targetDatabase,
      productionProvider,
      sourceDatabaseFile: path.basename(runtime.databasePath),
      operations: ["INITIALIZE", "REFRESH"],
      applyCommands: {
        initialize: productionCandidateApplyCommand("initialize"),
        refresh: productionCandidateApplyCommand("refresh"),
      },
      persistentProviderChange: false,
      requiresFinalFreezeApproval: true,
      isSwitchReady: false,
    };
  }

  const totalStarted = performance.now();
  await ensureDatabaseExists(base, invocation.targetDatabase);
  const snapshot = await createSnapshot(runtime, `candidate-${invocation.operation.toLowerCase()}`);
  const sourceDatabase = openReadOnlySqliteSnapshot(snapshot.path);
  sourceDatabase.exec("PRAGMA query_only=ON");
  let databaseTempPrivilege = null;
  try {
    const schemaResult = buildShadowSchema(sourceDatabase);
    const source = schemaResult.source;
    const manifest = buildFullSourceSyncManifest(source);
    const migrations = await loadPhase3bMigrations(rootDir);
    databaseTempPrivilege = await grantTemporaryCandidateDatabaseTemp(base, invocation.targetDatabase);
    let schema;
    let synchronization;
    const syncStarted = performance.now();
    if (invocation.operation === "INITIALIZE") {
      const reset = await resetProductionCandidateSchemas(base, invocation.targetDatabase);
      let databaseCreatePrivilege = await grantTemporaryCandidateDatabaseCreate(base, invocation.targetDatabase);
      let before;
      try {
        before = await initializeSchema(base, invocation.targetDatabase, migrations);
      } finally {
        databaseCreatePrivilege = await restoreCandidateDatabaseCreate(base, invocation.targetDatabase, databaseCreatePrivilege);
      }
      const loads = await fullLoad({ base, targetDatabase: invocation.targetDatabase, sourceDatabase, source, manifest, snapshot });
      const deferred = await completeSchema(base, invocation.targetDatabase, migrations);
      const projectionProvider = selectedProvider(base, { database: invocation.targetDatabase, user: base.migratorUser, password: base.migratorPassword });
      const projection = await projectAgentObservability(projectionProvider);
      await projectionProvider.close();
      const control = await initializeControl({
        base,
        targetDatabase: invocation.targetDatabase,
        sourceDatabase,
        manifest,
        snapshot,
        stateId: PHASE3D_PRODUCTION_CANDIDATE_STATE_ID,
        targetProvider: PHASE3D_PRODUCTION_CANDIDATE_PROVIDER,
      });
      schema = { reset, databaseCreatePrivilege, beforeLoadMigrations: before, deferredMigration: deferred, control };
      synchronization = {
        mode: "FULL_INITIALIZE",
        tables: loads.length,
        rowsExamined: source.rowCount,
        rowsInserted: loads.reduce((sum, table) => sum + table.rows, 0),
        rowsUpdated: 0,
        rowsDeleted: 0,
        rowsSkipped: 0,
        projection,
      };
    } else {
      schema = { migrations: await applyPendingSchemaMigrations(base, invocation.targetDatabase, migrations) };
      const preProvider = selectedProvider(base, { database: invocation.targetDatabase, user: base.migratorUser, password: base.migratorPassword });
      const coverage = schemaCoverage(source, await inspectTargetSchema(preProvider));
      await preProvider.close();
      if (!coverage.ok) throw Object.assign(new Error(`Production candidate source schema changed and requires a new PostgreSQL migration: ${JSON.stringify(coverage)}`), { code: "PRODUCTION_CANDIDATE_SCHEMA_DRIFT" });
      const preValidation = await validateFull({ base, targetDatabase: invocation.targetDatabase, sourceDatabase, source, manifest });
      synchronization = await reconcileChangedTables({
        base,
        targetDatabase: invocation.targetDatabase,
        sourceDatabase,
        manifest,
        preValidation,
        snapshot,
        stateId: PHASE3D_PRODUCTION_CANDIDATE_STATE_ID,
        targetProvider: PHASE3D_PRODUCTION_CANDIDATE_PROVIDER,
      });
    }
    const syncMs = Math.round(performance.now() - syncStarted);

    const role = await verifyApplicationRole(base, invocation.targetDatabase);
    const writes = await runCoreWriteContract(base, invocation.targetDatabase);
    const repositoryWrites = await runNodeJson("scripts/postgresql-phase3a-write-contract-check.mjs", [
      "--target=candidate",
      `--confirm-database=${PHASE3D_PRODUCTION_CANDIDATE_DATABASE}`,
      "--confirm-production-mutation=WRITE_CONTRACT_CLEANUP_ONLY",
    ]);
    const service = await serviceSwitchDryRun(base, invocation.targetDatabase, { mode: "production-candidate" });
    const rollback = await runNodeJson(
      "scripts/postgresql-provider-phase2-startup-check.mjs",
      ["--provider=sqlite"],
      { ...process.env, POSTGRES_SHADOW_SQLITE_SNAPSHOT: snapshot.path },
    );

    const validationStarted = performance.now();
    const validation = await validateFull({ base, targetDatabase: invocation.targetDatabase, sourceDatabase, source, manifest });
    if (validation.status !== "PASS") throw new Error(`Production candidate full validation failed: ${validation.failures.join(",")}`);
    const recorded = await recordValidation({
      base,
      targetDatabase: invocation.targetDatabase,
      validation,
      snapshot,
      batchId: synchronization.batchId || null,
      stateId: PHASE3D_PRODUCTION_CANDIDATE_STATE_ID,
      targetProvider: PHASE3D_PRODUCTION_CANDIDATE_PROVIDER,
    });
    const synchronizationTiming = await synchronizationTimingHistory(base, invocation.targetDatabase, PHASE3D_PRODUCTION_CANDIDATE_STATE_ID);
    const validationMs = Math.round(performance.now() - validationStarted);
    databaseTempPrivilege = await restoreCandidateDatabaseTemp(base, invocation.targetDatabase, databaseTempPrivilege);
    schema = { ...schema, databaseTempPrivilege };
    const gates = [
      { name: "Formal candidate identity", status: "PASS", evidence: `${invocation.targetDatabase}; persistent provider sqlite` },
      { name: "Complete source scope", status: source.tableCount === manifest.length ? "PASS" : "FAIL", evidence: `${manifest.length}/${source.tableCount} tables, ${source.viewCount} views` },
      { name: "Row and digest parity", status: validation.tables.every((table) => table.countMatch && table.fullDigestMatch) ? "PASS" : "FAIL", evidence: `${validation.tables.length}/${source.tableCount} tables` },
      { name: "Bidirectional primary-key EXCEPT", status: validation.tables.every((table) => !table.primaryKeySourceOnly && !table.primaryKeyTargetOnly) ? "PASS" : "FAIL", evidence: "zero source-only and target-only keys" },
      { name: "Foreign keys, indexes, and views", status: validation.coverage.ok && validation.indexes.match && validation.foreignKeys.validated && validation.views.every((view) => view.match) ? "PASS" : "FAIL", evidence: `${validation.foreignKeys.count} validated FKs, ${validation.indexes.target} indexes, ${validation.views.length} views` },
      { name: "Business totals and deterministic samples", status: Object.values(validation.businessTotals).every((metric) => metric.match) && validation.samples.failures === 0 ? "PASS" : "FAIL", evidence: `${Object.keys(validation.businessTotals).length} totals, ${validation.samples.count} samples` },
      { name: "Application role boundary", status: role.status, evidence: "CRUD allowed; CREATE/ownership/system role flags denied" },
      { name: "Full write path", status: writes.status === "PASS" && repositoryWrites.status === "PASS" ? "PASS" : "FAIL", evidence: `${writes.domains.length} core domains plus provider repositories` },
      { name: "Process-scoped health and SQLite rollback", status: service.status === "PASS" && rollback.status === "PASS" ? "PASS" : "FAIL", evidence: "candidate child health passed; pinned SQLite startup passed" },
    ];
    const result = {
      status: gates.every((gate) => gate.status === "PASS") ? "PASS" : "FAIL",
      contract: PHASE3D_PRODUCTION_CANDIDATE_CONTRACT,
      operation: invocation.operation,
      productionProvider,
      target: invocation.targetDatabase,
      config: { ...publicPostgresqlF1Config(base), sslCaFile: base.sslCaFile ? path.basename(base.sslCaFile) : null },
      source: { tables: source.tableCount, views: source.viewCount, rows: source.rowCount, columns: source.columnCount },
      snapshot,
      schema,
      synchronization,
      synchronizationTiming,
      role,
      writes,
      repositoryWrites,
      service,
      rollback: { status: rollback.status, provider: rollback.provider || "sqlite", productionWrites: rollback.productionWrites ?? 0 },
      validation,
      recorded,
      gates,
      timing: { syncMs, validationMs, totalMs: Math.round(performance.now() - totalStarted) },
      sqliteProductionTouched: false,
      formalCandidateTouched: true,
      persistentProviderChanged: false,
      externalCalls: 0,
      isSwitchReady: false,
      blockers: [
        "SQLite writers have not been frozen; this online snapshot is a warm candidate baseline, not the final source state.",
        "The final frozen SQLite snapshot, full-source refresh, and zero-difference validation require explicit final migration approval.",
        "The persistent DATABASE_PROVIDER switch requires a separate explicit approval after the final frozen synchronization passes.",
        "PostgreSQL-to-SQLite reverse synchronization is not implemented; rollback after PostgreSQL-only writes remains unsafe.",
      ],
    };
    const report = await writeCandidateReport(result);
    return { ...result, report };
  } finally {
    if (databaseTempPrivilege && !databaseTempPrivilege.restored) {
      await restoreCandidateDatabaseTemp(base, invocation.targetDatabase, databaseTempPrivilege).catch(() => {});
    }
    sourceDatabase.close();
    try { await fs.chmod(snapshot.path, 0o600); } catch {}
    await fs.rm(snapshot.path, { force: true });
  }
}

export async function runPhase3dRehearsal() {
  loadLocalEnv(rootDir);
  const productionProvider = String(process.env.DATABASE_PROVIDER || "sqlite").trim().toLowerCase();
  if (productionProvider !== "sqlite") throw new Error("Phase 3D rehearsal requires production DATABASE_PROVIDER=sqlite");
  const base = loadPostgresqlF1Config({ rootDir });
  const runtime = resolveRuntimeConfig({ bootstrapRoot: rootDir, env: process.env });
  const invocation = resolvePhase3dInvocation(process.argv.slice(2), base);
  if (!invocation.apply) {
    return {
      status: "PLAN",
      contract: PHASE3D_REHEARSAL_CONTRACT,
      target: invocation.targetDatabase,
      productionProvider,
      sourceDatabaseFile: path.basename(runtime.databasePath),
      operations: ["REBUILD", "REFRESH"],
      applyCommands: {
        rebuild: `node scripts/postgresql-phase3d-cutover-rehearsal.mjs --apply --rebuild --confirm-database=${invocation.targetDatabase}`,
        refresh: `node scripts/postgresql-phase3d-cutover-rehearsal.mjs --apply --refresh --confirm-database=${invocation.targetDatabase}`,
      },
      productionTouched: false,
      isSwitchReady: false,
    };
  }

  const totalStarted = performance.now();
  if (invocation.operation === "REBUILD") await rebuildDatabase(base, invocation.targetDatabase);
  else await ensureDatabaseExists(base, invocation.targetDatabase);
  const snapshot = await createSnapshot(runtime, invocation.operation.toLowerCase());
  const sourceDatabase = openReadOnlySqliteSnapshot(snapshot.path);
  sourceDatabase.exec("PRAGMA query_only=ON");
  try {
    const schemaResult = buildShadowSchema(sourceDatabase);
    const source = schemaResult.source;
    const manifest = buildFullSourceSyncManifest(source);
    const migrations = await loadPhase3bMigrations(rootDir);
    let schema = null;
    let synchronization;
    const syncStarted = performance.now();
    if (invocation.operation === "REBUILD") {
      const before = await initializeSchema(base, invocation.targetDatabase, migrations);
      const loads = await fullLoad({ base, targetDatabase: invocation.targetDatabase, sourceDatabase, source, manifest, snapshot });
      const deferred = await completeSchema(base, invocation.targetDatabase, migrations);
      const projectionProvider = selectedProvider(base, { database: invocation.targetDatabase, user: base.migratorUser, password: base.migratorPassword });
      const projection = await projectAgentObservability(projectionProvider);
      await projectionProvider.close();
      const control = await initializeControl({ base, targetDatabase: invocation.targetDatabase, sourceDatabase, manifest, snapshot });
      schema = { beforeLoadMigrations: before, deferredMigration: deferred, control };
      synchronization = {
        mode: "FULL_REBUILD",
        tables: loads.length,
        rowsExamined: source.rowCount,
        rowsInserted: loads.reduce((sum, table) => sum + table.rows, 0),
        rowsUpdated: 0,
        rowsDeleted: 0,
        rowsSkipped: 0,
        projection,
      };
    } else {
      schema = { migrations: await applyPendingSchemaMigrations(base, invocation.targetDatabase, migrations) };
      const preProvider = selectedProvider(base, { database: invocation.targetDatabase, user: base.migratorUser, password: base.migratorPassword });
      const coverage = schemaCoverage(source, await inspectTargetSchema(preProvider));
      await preProvider.close();
      if (!coverage.ok) throw Object.assign(new Error(`Phase 3D source schema changed and requires a new PostgreSQL migration: ${JSON.stringify(coverage)}`), { code: "PHASE3D_SCHEMA_DRIFT" });
      const preValidation = await validateFull({ base, targetDatabase: invocation.targetDatabase, sourceDatabase, source, manifest });
      synchronization = await reconcileChangedTables({ base, targetDatabase: invocation.targetDatabase, sourceDatabase, manifest, preValidation, snapshot });
    }
    const syncMs = Math.round(performance.now() - syncStarted);

    const role = await verifyApplicationRole(base, invocation.targetDatabase);
    const writes = await runCoreWriteContract(base, invocation.targetDatabase);
    const repositoryWrites = await runNodeJson("scripts/postgresql-phase3a-write-contract-check.mjs", ["--target=cutover"]);
    const service = await serviceSwitchDryRun(base, invocation.targetDatabase);
    const rollback = await runNodeJson(
      "scripts/postgresql-provider-phase2-startup-check.mjs",
      ["--provider=sqlite"],
      { ...process.env, POSTGRES_SHADOW_SQLITE_SNAPSHOT: snapshot.path },
    );

    const validationStarted = performance.now();
    const validation = await validateFull({ base, targetDatabase: invocation.targetDatabase, sourceDatabase, source, manifest });
    if (validation.status !== "PASS") throw new Error(`Phase 3D full validation failed: ${validation.failures.join(",")}`);
    const recorded = await recordValidation({ base, targetDatabase: invocation.targetDatabase, validation, snapshot, batchId: synchronization.batchId || null });
    const synchronizationTiming = await synchronizationTimingHistory(base, invocation.targetDatabase);
    const validationMs = Math.round(performance.now() - validationStarted);
    const gates = [
      { name: "Independent rehearsal database", status: "PASS", evidence: invocation.targetDatabase },
      { name: "Complete source scope", status: source.tableCount === manifest.length ? "PASS" : "FAIL", evidence: `${manifest.length}/${source.tableCount} tables, ${source.viewCount} views` },
      { name: "Row and digest parity", status: validation.tables.every((table) => table.countMatch && table.fullDigestMatch) ? "PASS" : "FAIL", evidence: `${validation.tables.length}/${source.tableCount} tables` },
      { name: "Bidirectional primary-key EXCEPT", status: validation.tables.every((table) => !table.primaryKeySourceOnly && !table.primaryKeyTargetOnly) ? "PASS" : "FAIL", evidence: "zero source-only and target-only keys" },
      { name: "Foreign keys, indexes, and views", status: validation.coverage.ok && validation.indexes.match && validation.foreignKeys.validated && validation.views.every((view) => view.match) ? "PASS" : "FAIL", evidence: `${validation.foreignKeys.count} validated FKs, ${validation.indexes.target} indexes, ${validation.views.length} views` },
      { name: "Business totals and deterministic samples", status: Object.values(validation.businessTotals).every((metric) => metric.match) && validation.samples.failures === 0 ? "PASS" : "FAIL", evidence: `${Object.keys(validation.businessTotals).length} totals, ${validation.samples.count} samples` },
      { name: "Application role boundary", status: role.status, evidence: "CRUD allowed; CREATE/ownership/system role flags denied" },
      { name: "Full write path", status: writes.status === "PASS" && repositoryWrites.status === "PASS" ? "PASS" : "FAIL", evidence: `${writes.domains.length} core domains plus provider repositories` },
      { name: "Process-scoped switch, health, and SQLite rollback", status: service.status === "PASS" && rollback.status === "PASS" ? "PASS" : "FAIL", evidence: "PostgreSQL child health passed; SQLite read-only startup probe passed" },
    ];
    const result = {
      status: gates.every((gate) => gate.status === "PASS") ? "PASS" : "FAIL",
      contract: PHASE3D_REHEARSAL_CONTRACT,
      operation: invocation.operation,
      productionProvider,
      target: invocation.targetDatabase,
      config: {
        ...publicPostgresqlF1Config(base),
        sslCaFile: base.sslCaFile ? path.basename(base.sslCaFile) : null,
      },
      source: { tables: source.tableCount, views: source.viewCount, rows: source.rowCount, columns: source.columnCount },
      snapshot,
      schema,
      synchronization,
      synchronizationTiming,
      role,
      writes,
      repositoryWrites,
      service,
      rollback: { status: rollback.status, provider: rollback.provider || "sqlite", productionWrites: rollback.productionWrites ?? 0 },
      validation,
      recorded,
      gates,
      timing: { syncMs, validationMs, totalMs: Math.round(performance.now() - totalStarted) },
      productionTouched: false,
      shadowTouched: false,
      stagingTouched: false,
      formalCandidateTouched: false,
      externalCalls: 0,
      isSwitchReady: false,
      blockers: [
        "SQLite feature development is still active; the rehearsal snapshot is not the final frozen source snapshot.",
        "The formal PostgreSQL candidate commerce_ops remains uninitialized and requires separate production-mutation approval.",
        "A final writer freeze, pinned snapshot, full-source reconcile, zero-difference validation, and explicit provider-switch approval have not occurred.",
        "PostgreSQL-to-SQLite reverse synchronization is not implemented; rollback after PostgreSQL-only writes remains unsafe.",
      ],
    };
    const report = await writeReport(result);
    return { ...result, report };
  } finally {
    sourceDatabase.close();
    try { await fs.chmod(snapshot.path, 0o600); } catch {}
    await fs.rm(snapshot.path, { force: true });
  }
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (entry === import.meta.url) {
  runPhase3dRehearsal().then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    const safe = safeError(error);
    process.stderr.write(`PostgreSQL Phase 3D rehearsal failed [${safe.code}]: ${safe.message}\n`);
    process.exitCode = 1;
  });
}
