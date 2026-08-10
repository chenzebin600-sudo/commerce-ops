import {
  encodePostgresqlMigrationValue,
  normalizeMigrationValue,
  normalizePostgresqlMigrationValue,
  quoteIdentifier,
  readNormalizedTableRows,
  tableDigests,
} from "../sqlite-migration.mjs";
import { DELETE_RECONCILIATION_MODES } from "./delete-policy.mjs";

const DEFAULT_BATCH_ROWS = 250;
const DEFAULT_OVERLAP_MS = 5 * 60 * 1000;
const MAX_BIND_PARAMETERS = 60_000;
const TEMP_SOURCE_KEYS = "migration_source_keys";
const TEMP_SOURCE_KEYS_INDEX = "migration_source_keys_pk";

function qualified(tableName) {
  return `${quoteIdentifier("app")}.${quoteIdentifier(tableName)}`;
}

function projection(table) {
  return table.columns.map((column) => quoteIdentifier(column.name)).join(", ");
}

function countSource(database, tableName) {
  return Number(database.prepare(`SELECT count(*) total FROM ${quoteIdentifier(tableName)}`).get().total);
}

async function countTarget(executor, tableName) {
  return Number((await executor.query(`SELECT count(*) total FROM ${qualified(tableName)}`)).rows[0].total);
}

function normalizePrimaryKey(row, spec) {
  return spec.primaryKey.map((name) => {
    const column = spec.table.columns.find((candidate) => candidate.name === name);
    return normalizeMigrationValue(row[name], column);
  });
}

function comparePrimaryKey(left, right) {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function normalizedWatermark(value, column) {
  if (value === null || value === undefined) return null;
  return normalizeMigrationValue(value, column);
}

function latestWatermark(rows, spec, previous = { value: null, primaryKey: [] }) {
  if (!spec.watermarkColumn) return previous;
  const column = spec.table.columns.find((candidate) => candidate.name === spec.watermarkColumn);
  let latest = previous;
  for (const row of rows) {
    const value = normalizedWatermark(row[spec.watermarkColumn], column);
    if (!value) continue;
    const primaryKey = normalizePrimaryKey(row, spec);
    if (!latest.value || value > latest.value || (value === latest.value && comparePrimaryKey(primaryKey, latest.primaryKey) > 0)) {
      latest = { value, primaryKey };
    }
  }
  return latest;
}

function baselineWatermark(database, spec) {
  if (!spec.watermarkColumn) return { value: null, primaryKey: [] };
  const order = spec.primaryKey.map((name) => `${quoteIdentifier(name)} DESC`).join(", ");
  const row = database.prepare(`
    SELECT ${projection(spec.table)} FROM ${quoteIdentifier(spec.name)}
    WHERE ${quoteIdentifier(spec.watermarkColumn)} IS NOT NULL
    ORDER BY julianday(${quoteIdentifier(spec.watermarkColumn)}) DESC, ${order}
    LIMIT 1
  `).get();
  return row ? latestWatermark([row], spec) : { value: null, primaryKey: [] };
}

function overlapStart(value, overlapMs) {
  if (!value) return null;
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) throw new TypeError(`Invalid migration watermark: ${value}`);
  return new Date(time - overlapMs).toISOString();
}

function* readCandidateBatches(database, spec, tableState, { fullReconcile, overlapMs, batchRows }) {
  const fullScan = fullReconcile || spec.captureMode === "FULL_HASH_SCAN" || !tableState?.last_watermark_value;
  const statement = fullScan
    ? database.prepare(`SELECT ${projection(spec.table)} FROM ${quoteIdentifier(spec.name)}`)
    : database.prepare(`
      SELECT ${projection(spec.table)} FROM ${quoteIdentifier(spec.name)}
      WHERE ${quoteIdentifier(spec.watermarkColumn)} IS NULL
         OR julianday(${quoteIdentifier(spec.watermarkColumn)}) >= julianday(?)
      ORDER BY
        CASE WHEN ${quoteIdentifier(spec.watermarkColumn)} IS NULL THEN 0 ELSE 1 END,
        julianday(${quoteIdentifier(spec.watermarkColumn)}),
        ${spec.primaryKey.map((name) => quoteIdentifier(name)).join(", ")}
    `);
  const rows = fullScan
    ? statement.iterate()
    : statement.iterate(overlapStart(tableState.last_watermark_value, overlapMs));
  let batch = [];
  for (const row of rows) {
    batch.push(row);
    if (batch.length === batchRows) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length) yield batch;
}

function encodedRows(rows, table) {
  return rows.map((row) => table.columns.map((column) => encodePostgresqlMigrationValue(row[column.name], column)));
}

export function buildPostgresqlUpsert(table, rows, { parameterOffset = 0 } = {}) {
  if (!rows.length) throw new TypeError("At least one row is required for an UPSERT");
  const columns = table.columns.map((column) => column.name);
  const values = [];
  let index = parameterOffset;
  const tuples = rows.map((row) => `(${row.map((value) => {
    values.push(value);
    index += 1;
    return `$${index}`;
  }).join(",")})`);
  const primaryKey = table.primaryKey.map((column) => quoteIdentifier(column)).join(",");
  const mutable = columns.filter((column) => !table.primaryKey.includes(column));
  const conflict = mutable.length
    ? `DO UPDATE SET ${mutable.map((column) => `${quoteIdentifier(column)}=EXCLUDED.${quoteIdentifier(column)}`).join(",")}`
    : "DO NOTHING";
  return {
    text: `INSERT INTO ${qualified(table.name)} (${columns.map(quoteIdentifier).join(",")}) VALUES ${tuples.join(",")} ON CONFLICT (${primaryKey}) ${conflict} RETURNING (xmax=0) inserted`,
    values,
  };
}

export function buildTargetOnlyReconciliationSql(table, { applyDeletes = false } = {}) {
  if (!table?.primaryKey?.length) throw new TypeError("Target-only reconciliation requires a primary key");
  const keys = table.primaryKey.map(quoteIdentifier).join(",");
  if (!applyDeletes) {
    return `SELECT COUNT(*)::text total FROM (SELECT ${keys} FROM ${qualified(table.name)} EXCEPT SELECT ${keys} FROM ${quoteIdentifier(TEMP_SOURCE_KEYS)}) target_only`;
  }
  const match = table.primaryKey.map((name) => (
    `target.${quoteIdentifier(name)} IS NOT DISTINCT FROM source.${quoteIdentifier(name)}`
  )).join(" AND ");
  const missing = `NOT EXISTS (SELECT 1 FROM ${quoteIdentifier(TEMP_SOURCE_KEYS)} source WHERE ${match})`;
  return `WITH deleted AS (DELETE FROM ${qualified(table.name)} AS target WHERE ${missing} RETURNING 1) SELECT COUNT(*)::text total FROM deleted`;
}

function primaryKeyBatchInsert(spec, rows) {
  const columns = spec.primaryKey.map(quoteIdentifier);
  const values = [];
  let parameter = 0;
  const tuples = rows.map((row) => `(${row.map((value) => {
    values.push(value);
    parameter += 1;
    return `$${parameter}`;
  }).join(",")})`);
  return {
    text: `INSERT INTO ${quoteIdentifier(TEMP_SOURCE_KEYS)} (${columns.join(",")}) VALUES ${tuples.join(",")}`,
    values,
  };
}

function* sourcePrimaryKeyBatches(database, spec, requestedBatchRows) {
  const batchRows = Math.min(requestedBatchRows, Math.max(1, Math.floor(MAX_BIND_PARAMETERS / spec.primaryKey.length)));
  const statement = database.prepare(`
    SELECT ${spec.primaryKey.map(quoteIdentifier).join(",")}
    FROM ${quoteIdentifier(spec.name)}
  `);
  let batch = [];
  for (const row of statement.iterate()) {
    batch.push(spec.primaryKey.map((name) => {
      const column = spec.table.columns.find((candidate) => candidate.name === name);
      return encodePostgresqlMigrationValue(row[name], column);
    }));
    if (batch.length === batchRows) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length) yield batch;
}

export async function reconcileTargetOnlyRows({
  database,
  provider,
  control,
  manifest,
  batchId,
  deletePolicy,
  batchRows = DEFAULT_BATCH_ROWS,
}) {
  if (!deletePolicy?.executesDetection) {
    return { mode: deletePolicy?.mode || DELETE_RECONCILIATION_MODES.BLOCK, tables: [], keysExamined: 0, candidates: 0, deleted: 0 };
  }
  if (!deletePolicy.fullReconcile) throw new Error("Target-only reconciliation requires a full reconcile");
  const tables = [];
  for (const spec of [...manifest].reverse()) {
    try {
      const tableState = await control.tableState(spec.name);
      const result = await provider.transaction(async (transaction) => {
        await transaction.executeScript(`LOCK TABLE ${qualified(spec.name)} IN SHARE ROW EXCLUSIVE MODE`);
        await transaction.executeScript(`
          CREATE TEMP TABLE ${quoteIdentifier(TEMP_SOURCE_KEYS)} ON COMMIT DROP AS
          SELECT ${spec.primaryKey.map(quoteIdentifier).join(",")}
          FROM ${qualified(spec.name)} WITH NO DATA
        `);
        let keysExamined = 0;
        for (const batch of sourcePrimaryKeyBatches(database, spec, batchRows)) {
          const insert = primaryKeyBatchInsert(spec, batch);
          await transaction.query(insert.text, insert.values);
          keysExamined += batch.length;
        }
        await transaction.executeScript(`
          CREATE UNIQUE INDEX ${quoteIdentifier(TEMP_SOURCE_KEYS_INDEX)}
          ON ${quoteIdentifier(TEMP_SOURCE_KEYS)} (${spec.primaryKey.map(quoteIdentifier).join(",")})
        `);
        const candidates = Number((await transaction.query(
          buildTargetOnlyReconciliationSql(spec.table),
        )).rows[0].total);
        let deleted = 0;
        if (deletePolicy.executesDeletes && candidates) {
          deleted = Number((await transaction.query(
            buildTargetOnlyReconciliationSql(spec.table, { applyDeletes: true }),
          )).rows[0].total);
          if (deleted !== candidates) throw new Error(`Shadow DELETE count changed during reconciliation: ${spec.name}`);
        }
        if (deletePolicy.executesDeletes) {
          const targetCount = await countTarget(transaction, spec.name);
          await control.updateTableState({
            executor: transaction,
            spec,
            batchId,
            watermarkValue: tableState?.last_watermark_value || null,
            watermarkPrimaryKey: tableState?.last_watermark_pk_json || [],
            sourceCount: keysExamined,
            targetCount,
          });
        }
        return { table: spec.name, domain: spec.domain, keysExamined, candidates, deleted };
      });
      tables.push(result);
    } catch (error) {
      await control.failTable({ spec, batchId, errorCode: String(error?.code || "DELETE_RECONCILIATION_FAILED").slice(0, 80) });
      throw error;
    }
  }
  return {
    mode: deletePolicy.mode,
    tables,
    keysExamined: tables.reduce((sum, table) => sum + table.keysExamined, 0),
    candidates: tables.reduce((sum, table) => sum + table.candidates, 0),
    deleted: tables.reduce((sum, table) => sum + table.deleted, 0),
  };
}

async function targetNormalizedRows(executor, table) {
  const result = await executor.query(`SELECT ${projection(table)} FROM ${qualified(table.name)}`);
  return result.rows.map((row) => Object.fromEntries(table.columns.map((column) => [
    column.name,
    normalizePostgresqlMigrationValue(row[column.name], column),
  ])));
}

async function fullHashMatches({ database, provider, spec }) {
  const sourceRows = readNormalizedTableRows(database, spec.table);
  const targetRows = await targetNormalizedRows(provider, spec.table);
  if (sourceRows.length !== targetRows.length) return false;
  return tableDigests(sourceRows, spec.table, { valuesAreNormalized: true }).full
    === tableDigests(targetRows, spec.table, { valuesAreNormalized: true }).full;
}

export async function seedSyncStateFromBaseline({ baselineDatabase, provider, control, manifest }) {
  const loadedTables = new Set((await provider.query(
    "SELECT table_name FROM shadow_meta.table_loads WHERE status='SUCCEEDED'",
  )).rows.map((row) => row.table_name));
  const seeded = [];
  for (const spec of manifest) {
    if (await control.tableState(spec.name)) continue;
    const sourceCount = countSource(baselineDatabase, spec.name);
    const targetCount = await countTarget(provider, spec.name);
    if (loadedTables.has(spec.name) && sourceCount !== targetCount) {
      throw new Error(`Shadow baseline count mismatch before incremental sync: ${spec.name} (${sourceCount}/${targetCount})`);
    }
    if (!loadedTables.has(spec.name) && targetCount !== 0) {
      throw new Error(`Untracked Shadow rows exist before incremental sync: ${spec.name} (${targetCount})`);
    }
    const watermark = loadedTables.has(spec.name)
      ? baselineWatermark(baselineDatabase, spec)
      : { value: null, primaryKey: [] };
    await control.seedTableState({
      spec,
      watermarkValue: watermark.value,
      watermarkPrimaryKey: watermark.primaryKey,
      sourceCount: loadedTables.has(spec.name) ? sourceCount : 0,
      targetCount,
    });
    seeded.push({
      table: spec.name,
      baselineLoaded: loadedTables.has(spec.name),
      sourceCount: loadedTables.has(spec.name) ? sourceCount : 0,
      targetCount,
      watermark: watermark.value,
    });
  }
  return seeded;
}

async function syncTable({ database, provider, control, spec, batchId, fullReconcile, overlapMs, batchRows }) {
  const tableState = await control.tableState(spec.name);
  if (!tableState) throw new Error(`Migration table state is missing: ${spec.name}`);
  const sourceCount = countSource(database, spec.name);
  if (spec.captureMode === "FULL_HASH_SCAN" && await fullHashMatches({ database, provider, spec })) {
    const targetCount = await countTarget(provider, spec.name);
    await control.updateTableState({
      spec,
      batchId,
      watermarkValue: tableState.last_watermark_value,
      watermarkPrimaryKey: tableState.last_watermark_pk_json || [],
      sourceCount,
      targetCount,
    });
    return { table: spec.name, domain: spec.domain, examined: sourceCount, inserted: 0, updated: 0, skipped: sourceCount };
  }

  let watermark = {
    value: tableState.last_watermark_value ? new Date(tableState.last_watermark_value).toISOString() : null,
    primaryKey: tableState.last_watermark_pk_json || [],
  };
  const effectiveBatchRows = Math.min(batchRows, Math.max(1, Math.floor(MAX_BIND_PARAMETERS / spec.table.columns.length)));
  let examined = 0;
  let inserted = 0;
  let updated = 0;
  let targetCount = 0;
  await provider.transaction(async (tx) => {
    for (const rows of readCandidateBatches(database, spec, tableState, {
      fullReconcile,
      overlapMs,
      batchRows: effectiveBatchRows,
    })) {
      examined += rows.length;
      watermark = latestWatermark(rows, spec, watermark);
      const statement = buildPostgresqlUpsert(spec.table, encodedRows(rows, spec.table));
      const result = await tx.query(statement.text, statement.values);
      for (const row of result.rows) {
        if (row.inserted) inserted += 1;
        else updated += 1;
      }
    }
    targetCount = await countTarget(tx, spec.name);
    await control.updateTableState({
      executor: tx,
      spec,
      batchId,
      watermarkValue: watermark.value,
      watermarkPrimaryKey: watermark.primaryKey,
      sourceCount,
      targetCount,
    });
  });
  return { table: spec.name, domain: spec.domain, examined, inserted, updated, skipped: 0, sourceCount, targetCount };
}

export async function projectAgentObservability(provider) {
  const agentRuns = await provider.query(`
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
    ON CONFLICT (id) DO UPDATE SET
      request_id=EXCLUDED.request_id,agent_name=EXCLUDED.agent_name,agent_version=EXCLUDED.agent_version,
      context_versions=EXCLUDED.context_versions,status=EXCLUDED.status,finished_at=EXCLUDED.finished_at,
      duration_ms=EXCLUDED.duration_ms,input_tokens=EXCLUDED.input_tokens,output_tokens=EXCLUDED.output_tokens,
      total_tokens=EXCLUDED.total_tokens,error_code=EXCLUDED.error_code,evidence=EXCLUDED.evidence
    RETURNING id
  `);
  const tools = await provider.query(`
    INSERT INTO ai_shadow.tool_invocations(id,agent_run_id,request_id,tool_name,tool_version,status,duration_ms,error_code,evidence,occurred_at)
    SELECT id,run_id,request_id,COALESCE(metadata_json->>'toolName','unknown'),metadata_json->>'toolVersion',
      CASE WHEN status='success' THEN 'SUCCEEDED' ELSE 'FAILED' END,duration_ms,error_code,metadata_json,occurred_at
    FROM app.operation_audit_events WHERE action='agent.tool.invoke'
    ON CONFLICT (id) DO UPDATE SET
      agent_run_id=EXCLUDED.agent_run_id,request_id=EXCLUDED.request_id,tool_name=EXCLUDED.tool_name,
      tool_version=EXCLUDED.tool_version,status=EXCLUDED.status,duration_ms=EXCLUDED.duration_ms,
      error_code=EXCLUDED.error_code,evidence=EXCLUDED.evidence,occurred_at=EXCLUDED.occurred_at
    RETURNING id
  `);
  const gateways = await provider.query(`
    INSERT INTO ai_shadow.gateway_calls(id,agent_run_id,request_id,provider,model,prompt_version,input_tokens,output_tokens,total_tokens,duration_ms,status,evidence,occurred_at)
    SELECT event.id,run.id,event.request_id,event.metadata_json->>'provider',event.metadata_json->>'model',event.metadata_json->>'promptVersion',
      COALESCE((event.metadata_json->>'inputTokens')::bigint,0),COALESCE((event.metadata_json->>'outputTokens')::bigint,0),
      COALESCE((event.metadata_json->>'totalTokens')::bigint,0),event.duration_ms,event.status,event.metadata_json,event.occurred_at
    FROM app.operation_audit_events event
    LEFT JOIN ai_shadow.agent_runs run ON run.request_id=event.request_id
    WHERE event.action='ai.gateway.complete'
    ON CONFLICT (id) DO UPDATE SET
      agent_run_id=EXCLUDED.agent_run_id,request_id=EXCLUDED.request_id,provider=EXCLUDED.provider,
      model=EXCLUDED.model,prompt_version=EXCLUDED.prompt_version,input_tokens=EXCLUDED.input_tokens,
      output_tokens=EXCLUDED.output_tokens,total_tokens=EXCLUDED.total_tokens,duration_ms=EXCLUDED.duration_ms,
      status=EXCLUDED.status,evidence=EXCLUDED.evidence,occurred_at=EXCLUDED.occurred_at
    RETURNING id
  `);
  return { agentRuns: agentRuns.rowCount, toolInvocations: tools.rowCount, gatewayCalls: gateways.rowCount };
}

export class MigrationSyncService {
  constructor({
    sourceDatabase,
    provider,
    control,
    manifest,
    overlapMs = DEFAULT_OVERLAP_MS,
    batchRows = DEFAULT_BATCH_ROWS,
    deletePolicy = Object.freeze({ mode: DELETE_RECONCILIATION_MODES.BLOCK, executesDetection: false, executesDeletes: false }),
  }) {
    if (!sourceDatabase || !provider || !control || !manifest?.length) throw new TypeError("Migration sync service configuration is incomplete");
    if (!Number.isInteger(batchRows) || batchRows < 1 || batchRows > 5_000) {
      throw new TypeError("Migration sync batchRows must be an integer between 1 and 5000");
    }
    this.sourceDatabase = sourceDatabase;
    this.provider = provider;
    this.control = control;
    this.manifest = manifest;
    this.overlapMs = overlapMs;
    this.batchRows = batchRows;
    this.deletePolicy = deletePolicy;
  }

  async run({ sourceSnapshotTime, sourceSnapshotSha256, fullReconcile = false }) {
    const mode = fullReconcile ? "FULL_RECONCILE" : "INCREMENTAL";
    const batchId = await this.control.startBatch({ mode, sourceSnapshotTime, sourceSnapshotSha256 });
    const tables = [];
    try {
      for (const spec of this.manifest) {
        try {
          tables.push(await syncTable({
            database: this.sourceDatabase,
            provider: this.provider,
            control: this.control,
            spec,
            batchId,
            fullReconcile,
            overlapMs: this.overlapMs,
            batchRows: this.batchRows,
          }));
        } catch (error) {
          await this.control.failTable({ spec, batchId, errorCode: String(error?.code || "SYNC_TABLE_FAILED").slice(0, 80) });
          throw error;
        }
      }
      const deletion = await reconcileTargetOnlyRows({
        database: this.sourceDatabase,
        provider: this.provider,
        control: this.control,
        manifest: this.manifest,
        batchId,
        deletePolicy: this.deletePolicy,
        batchRows: this.batchRows,
      });
      const observability = await projectAgentObservability(this.provider);
      const summary = {
        batchId,
        mode,
        tables,
        rowsExamined: tables.reduce((sum, table) => sum + table.examined, 0),
        rowsInserted: tables.reduce((sum, table) => sum + table.inserted, 0),
        rowsUpdated: tables.reduce((sum, table) => sum + table.updated, 0),
        rowsSkipped: tables.reduce((sum, table) => sum + table.skipped, 0),
        rowsDeleted: deletion.deleted,
        deleteCandidates: deletion.candidates,
        deleteKeysExamined: deletion.keysExamined,
        deletion,
        observability,
      };
      await this.control.completeBatch({ batchId, summary });
      return summary;
    } catch (error) {
      await this.control.failBatch({
        batchId,
        errorCode: String(error?.code || "INCREMENTAL_SYNC_FAILED").slice(0, 80),
        errorSummary: String(error?.message || error).split(/\r?\n/)[0].slice(0, 500),
      });
      throw error;
    }
  }
}
