import crypto from "node:crypto";

export const MIGRATION_STATE_ID = "sqlite-to-postgresql-shadow";
const TARGET_PROVIDERS = new Set([
  "postgresql_shadow",
  "postgresql_staging",
  "postgresql_cutover_rehearsal",
  "postgresql_production_candidate",
]);

function json(value) {
  return JSON.stringify(value ?? {});
}

function executor(value) {
  if (!value || typeof value.query !== "function") throw new TypeError("PostgreSQL executor is required");
  return value;
}

export class SyncControlRepository {
  constructor({ provider, stateId = MIGRATION_STATE_ID, targetProvider = "postgresql_shadow" }) {
    this.provider = executor(provider);
    this.stateId = stateId;
    if (!TARGET_PROVIDERS.has(targetProvider)) throw new TypeError("Unsupported migration target provider");
    this.targetProvider = targetProvider;
  }

  async ensureState({ migrationSnapshotTime, sourceSnapshotSha256 }) {
    await this.provider.query(`
      INSERT INTO shadow_meta.migration_state(
        id,source_provider,target_provider,stage,migration_snapshot_time,source_snapshot_sha256
      ) VALUES ($1,'sqlite',$2,'BASELINE',$3,$4)
      ON CONFLICT (id) DO NOTHING
    `, [this.stateId, this.targetProvider, migrationSnapshotTime, sourceSnapshotSha256]);
    return this.getState();
  }

  async getState() {
    return (await this.provider.query(
      "SELECT * FROM shadow_meta.migration_state WHERE id=$1",
      [this.stateId],
    )).rows[0] || null;
  }

  async assertRunnable() {
    const state = await this.getState();
    if (!state) throw new Error("Incremental migration state has not been initialized");
    if (state.paused) throw new Error(`Incremental migration is paused: ${state.pause_reason || "no reason provided"}`);
    return state;
  }

  async seedTableState({ spec, watermarkValue = null, watermarkPrimaryKey = [], sourceCount = 0, targetCount = 0 }) {
    await this.provider.query(`
      INSERT INTO shadow_meta.migration_sync_table_state(
        migration_state_id,table_name,domain_name,capture_mode,watermark_column,
        last_watermark_value,last_watermark_pk_json,last_source_row_count,last_target_row_count
      ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)
      ON CONFLICT (migration_state_id,table_name) DO NOTHING
    `, [
      this.stateId,
      spec.name,
      spec.domain,
      spec.captureMode,
      spec.watermarkColumn,
      watermarkValue,
      json(watermarkPrimaryKey),
      sourceCount,
      targetCount,
    ]);
  }

  async listTableStates() {
    return (await this.provider.query(`
      SELECT * FROM shadow_meta.migration_sync_table_state
      WHERE migration_state_id=$1 ORDER BY table_name
    `, [this.stateId])).rows;
  }

  async tableState(tableName) {
    return (await this.provider.query(`
      SELECT * FROM shadow_meta.migration_sync_table_state
      WHERE migration_state_id=$1 AND table_name=$2
    `, [this.stateId, tableName])).rows[0] || null;
  }

  async startBatch({ mode, sourceSnapshotTime, sourceSnapshotSha256 }) {
    await this.assertRunnable();
    const id = crypto.randomUUID();
    await this.provider.transaction(async (tx) => {
      await tx.query(`
        INSERT INTO shadow_meta.migration_sync_batches(
          id,migration_state_id,mode,source_snapshot_time,source_snapshot_sha256,status
        ) VALUES ($1,$2,$3,$4,$5,'RUNNING')
      `, [id, this.stateId, mode, sourceSnapshotTime, sourceSnapshotSha256]);
      await tx.query(`
        UPDATE shadow_meta.migration_state SET
          stage='INCREMENTAL',last_sync_started_at=CURRENT_TIMESTAMP,
          is_switch_ready=false,revision=revision+1,updated_at=CURRENT_TIMESTAMP
        WHERE id=$1
      `, [this.stateId]);
    });
    return id;
  }

  async updateTableState({ executor: selectedExecutor = this.provider, spec, batchId, watermarkValue, watermarkPrimaryKey, sourceCount, targetCount }) {
    const target = executor(selectedExecutor);
    await target.query(`
      UPDATE shadow_meta.migration_sync_table_state SET
        last_watermark_value=$3,last_watermark_pk_json=$4::jsonb,
        last_source_row_count=$5,last_target_row_count=$6,last_batch_id=$7,
        last_synced_at=CURRENT_TIMESTAMP,last_status='SUCCEEDED',last_error_code=NULL,
        revision=revision+1
      WHERE migration_state_id=$1 AND table_name=$2
    `, [
      this.stateId,
      spec.name,
      watermarkValue,
      json(watermarkPrimaryKey),
      sourceCount,
      targetCount,
      batchId,
    ]);
  }

  async failTable({ spec, batchId, errorCode }) {
    await this.provider.query(`
      UPDATE shadow_meta.migration_sync_table_state SET
        last_batch_id=$3,last_status='FAILED',last_error_code=$4,
        revision=revision+1
      WHERE migration_state_id=$1 AND table_name=$2
    `, [this.stateId, spec.name, batchId, errorCode]);
  }

  async completeBatch({ batchId, summary }) {
    await this.provider.transaction(async (tx) => {
      await tx.query(`
        UPDATE shadow_meta.migration_sync_batches SET
          status='SUCCEEDED',table_count=$2,rows_examined=$3,rows_inserted=$4,
          rows_updated=$5,rows_skipped=$6,summary_json=$7::jsonb,
          completed_at=CURRENT_TIMESTAMP
        WHERE id=$1
      `, [
        batchId,
        summary.tables.length,
        summary.rowsExamined,
        summary.rowsInserted,
        summary.rowsUpdated,
        summary.rowsSkipped,
        json(summary),
      ]);
      await tx.query(`
        UPDATE shadow_meta.migration_state SET
          stage='INCREMENTAL',last_sync_completed_at=CURRENT_TIMESTAMP,
          last_successful_batch_id=$2,revision=revision+1,updated_at=CURRENT_TIMESTAMP
        WHERE id=$1
      `, [this.stateId, batchId]);
    });
  }

  async failBatch({ batchId, errorCode, errorSummary }) {
    await this.provider.transaction(async (tx) => {
      await tx.query(`
        UPDATE shadow_meta.migration_sync_batches SET
          status='FAILED',error_count=error_count+1,error_code=$2,error_summary=$3,
          completed_at=CURRENT_TIMESTAMP
        WHERE id=$1
      `, [batchId, errorCode, errorSummary]);
      await tx.query(`
        UPDATE shadow_meta.migration_state SET
          stage='FAILED',sync_failure_count=sync_failure_count+1,
          is_switch_ready=false,revision=revision+1,updated_at=CURRENT_TIMESTAMP
        WHERE id=$1
      `, [this.stateId]);
    });
  }

  async recordValidation({ syncBatchId = null, validation }) {
    const id = crypto.randomUUID();
    await this.provider.transaction(async (tx) => {
      await tx.query(`
        INSERT INTO shadow_meta.migration_validation_runs(
          id,migration_state_id,sync_batch_id,status,source_snapshot_time,
          source_snapshot_sha256,tables_checked,tables_with_differences,
          sample_count,sample_failures,difference_json
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
      `, [
        id,
        this.stateId,
        syncBatchId,
        validation.status,
        validation.sourceSnapshotTime,
        validation.sourceSnapshotSha256,
        validation.tables.length,
        validation.tables.filter((table) => !table.countMatch).length,
        validation.sampleCount,
        validation.sampleFailures,
        json(validation),
      ]);
      await tx.query(`
        UPDATE shadow_meta.migration_state SET
          stage=$2,last_validation_at=CURRENT_TIMESTAMP,last_validation_status=$3,
          is_switch_ready=false,revision=revision+1,updated_at=CURRENT_TIMESTAMP
        WHERE id=$1
      `, [this.stateId, validation.status === "PASS" ? "READY" : "FAILED", validation.status]);
    });
    return id;
  }

  async markSwitchReady({ expectedSourceSnapshotSha256 }) {
    if (!/^[a-f0-9]{64}$/i.test(String(expectedSourceSnapshotSha256 || ""))) {
      throw new TypeError("A validated final source snapshot SHA-256 is required");
    }
    return this.provider.transaction(async (tx) => {
      const state = (await tx.query(
        "SELECT * FROM shadow_meta.migration_state WHERE id=$1 FOR UPDATE",
        [this.stateId],
      )).rows[0];
      if (!state) throw new Error("Incremental migration state has not been initialized");
      if (state.stage !== "READY" || state.last_validation_status !== "PASS" || state.paused) {
        throw new Error("Migration state is not eligible for production switching");
      }
      const runningBatches = Number((await tx.query(`
        SELECT COUNT(*)::integer count FROM shadow_meta.migration_sync_batches
        WHERE migration_state_id=$1 AND status='RUNNING'
      `, [this.stateId])).rows[0].count);
      if (runningBatches !== 0) throw new Error("Migration synchronization still has a running batch");
      const failedTables = Number((await tx.query(`
        SELECT COUNT(*)::integer count FROM shadow_meta.migration_sync_table_state
        WHERE migration_state_id=$1 AND last_status<>'SUCCEEDED'
      `, [this.stateId])).rows[0].count);
      if (failedTables !== 0) throw new Error("Migration synchronization has table states that are not successful");
      const validation = (await tx.query(`
        SELECT status,source_snapshot_time,source_snapshot_sha256,tables_with_differences,sample_failures
        FROM shadow_meta.migration_validation_runs
        WHERE migration_state_id=$1 ORDER BY created_at DESC LIMIT 1
      `, [this.stateId])).rows[0];
      if (!validation
        || validation.status !== "PASS"
        || validation.source_snapshot_sha256 !== expectedSourceSnapshotSha256
        || Number(validation.tables_with_differences) !== 0
        || Number(validation.sample_failures) !== 0) {
        throw new Error("Latest migration validation does not match the final source snapshot");
      }
      await tx.query(`
        UPDATE shadow_meta.migration_state SET
          stage='READY',migration_snapshot_time=$2,source_snapshot_sha256=$3,
          is_switch_ready=true,revision=revision+1,updated_at=CURRENT_TIMESTAMP
        WHERE id=$1
      `, [this.stateId, validation.source_snapshot_time, validation.source_snapshot_sha256]);
      return (await tx.query("SELECT * FROM shadow_meta.migration_state WHERE id=$1", [this.stateId])).rows[0];
    });
  }

  async markSwitchNotReady() {
    await this.provider.query(`
      UPDATE shadow_meta.migration_state SET
        is_switch_ready=false,revision=revision+1,updated_at=CURRENT_TIMESTAMP
      WHERE id=$1
    `, [this.stateId]);
    return this.getState();
  }

  async pause(reason = "paused by operator") {
    await this.provider.query(`
      UPDATE shadow_meta.migration_state SET
        stage='PAUSED',paused=true,pause_reason=$2,is_switch_ready=false,
        revision=revision+1,updated_at=CURRENT_TIMESTAMP
      WHERE id=$1
    `, [this.stateId, reason]);
    return this.getState();
  }

  async resume() {
    await this.provider.query(`
      UPDATE shadow_meta.migration_state SET
        stage='INCREMENTAL',paused=false,pause_reason=NULL,is_switch_ready=false,
        revision=revision+1,updated_at=CURRENT_TIMESTAMP
      WHERE id=$1
    `, [this.stateId]);
    return this.getState();
  }

  async status() {
    const [state, tableStates, batches, validations] = await Promise.all([
      this.getState(),
      this.listTableStates(),
      this.provider.query(`
        SELECT * FROM shadow_meta.migration_sync_batches
        WHERE migration_state_id=$1 ORDER BY started_at DESC LIMIT 10
      `, [this.stateId]),
      this.provider.query(`
        SELECT id,status,tables_checked,tables_with_differences,sample_count,
          sample_failures,created_at
        FROM shadow_meta.migration_validation_runs
        WHERE migration_state_id=$1 ORDER BY created_at DESC LIMIT 10
      `, [this.stateId]),
    ]);
    return { state, tableStates, batches: batches.rows, validations: validations.rows };
  }
}
