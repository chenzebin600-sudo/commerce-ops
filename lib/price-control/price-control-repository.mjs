import { randomUUID } from "node:crypto";
import { assertDatabaseProvider } from "../data/database-provider.mjs";
import { createPortableRepositoryExecutor } from "../data/portable-repository-executor.mjs";
import { createRepositorySql } from "../data/repository-sql.mjs";
import { nextAlignedAutomationRunAt } from "./price-control-contracts.mjs";

function json(value, fallback = {}) {
  try { return JSON.stringify(value ?? fallback); } catch { return JSON.stringify(fallback); }
}

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function runRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    foundationSourceRunId: row.foundation_source_run_id || null,
    triggerType: row.trigger_type,
    syncMode: row.sync_mode,
    status: row.status,
    sourceVersion: row.source_version || null,
    sourceCheckedAt: row.source_checked_at || null,
    sourceTableUpdatedAt: row.source_table_updated_at || null,
    sourceBusinessUpdatedAt: row.source_business_updated_at || null,
    fetchedAt: row.fetched_at || null,
    watermarkAt: row.watermark_at || null,
    batchesSeen: number(row.batches_seen),
    batchesApplied: number(row.batches_applied),
    sourceRowsSeen: number(row.source_rows_seen),
    pricePointsSeen: number(row.price_points_seen),
    changeCount: number(row.change_count),
    notificationStatus: row.notification_status || null,
    notifiedAt: row.notified_at || null,
    notificationErrorCode: row.notification_error_code || null,
    inputFingerprint: row.input_fingerprint,
    errorCode: row.error_code || null,
    errorMessage: row.error_message || null,
    startedAt: row.started_at || null,
    finishedAt: row.finished_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function currentPriceRow(row) {
  if (!row) return null;
  return {
    priceKey: row.price_key,
    countryCode: row.country_code,
    categoryName: row.category_name || null,
    sku: row.sku,
    productNameCn: row.product_name_cn || null,
    skuStatus: row.sku_status || null,
    platform: row.platform,
    shopType: row.shop_type,
    priceType: row.price_type,
    priceValue: row.price_value,
    sourceApplyNo: row.source_apply_no,
    sourceSnapshotId: row.source_snapshot_id,
    effectiveAt: row.effective_at,
    revision: number(row.revision, 1),
    updatedAt: row.updated_at || null,
  };
}

function changeRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    syncRunId: row.sync_run_id,
    sourceApplyNo: row.source_apply_no,
    priceKey: row.price_key,
    countryCode: row.country_code,
    categoryName: row.category_name || null,
    sku: row.sku,
    productNameCn: row.product_name_cn || null,
    platform: row.platform,
    shopType: row.shop_type,
    priceType: row.price_type,
    oldPrice: row.old_price,
    newPrice: row.new_price,
    deltaValue: row.delta_value,
    deltaPercent: row.delta_percent === null ? null : number(row.delta_percent),
    direction: row.direction,
    changeText: row.change_text,
    changeFingerprint: row.change_fingerprint,
    foundationTaskId: row.foundation_task_id || null,
    validityStatus: row.validity_status || "VALID",
    invalidReason: row.invalid_reason || null,
    invalidatedAt: row.invalidated_at || null,
    invalidatedBy: row.invalidated_by || null,
    adjustmentStatus: row.adjustment_status || "UNADJUSTED",
    adjustmentRemark: row.adjustment_remark || null,
    adjustmentUpdatedAt: row.adjustment_updated_at || null,
    adjustmentUpdatedBy: row.adjustment_updated_by || null,
    detectedAt: row.detected_at,
    createdAt: row.created_at,
  };
}

function changeRoundRow(row) {
  if (!row) return null;
  return {
    id: row.sync_run_id,
    triggerType: row.trigger_type,
    firstDetectedAt: row.first_detected_at,
    lastDetectedAt: row.last_detected_at,
    sourceBusinessUpdatedAt: row.source_business_updated_at || null,
    sourceTableUpdatedAt: row.source_table_updated_at || null,
    fetchedAt: row.fetched_at || null,
    changeCount: number(row.change_count),
    affectedSkuCount: number(row.affected_sku_count),
    adjustedCount: number(row.adjusted_count),
    unadjustedCount: number(row.unadjusted_count),
  };
}

function automationSettingsRow(row) {
  if (!row) return null;
  return {
    enabled: Boolean(number(row.enabled)),
    intervalMinutes: number(row.interval_minutes, 60),
    dingtalkConfigId: row.dingtalk_config_id || null,
    notifyOnChange: Boolean(number(row.notify_on_change, 1)),
    notifyOnFailure: Boolean(number(row.notify_on_failure, 1)),
    lastRunAt: row.last_run_at || null,
    lastRunStatus: row.last_run_status || null,
    lastNotificationAt: row.last_notification_at || null,
    lastNotificationStatus: row.last_notification_status || null,
    nextRunAt: row.next_run_at || null,
    lastErrorCode: row.last_error_code || null,
    lastErrorMessage: row.last_error_message || null,
    updatedAt: row.updated_at || null,
  };
}

export class PriceControlRepository {
  constructor({ provider }) {
    const resolved = assertDatabaseProvider(provider);
    this.provider = createPortableRepositoryExecutor(resolved);
    this.sql = createRepositorySql(resolved);
  }

  async isReady() {
    return this.sql.relationExists("product_price_change_events");
  }

  async isAutomationReady() {
    return this.sql.relationExists("price_control_automation_settings");
  }

  async isNullSemanticsRepairReady() {
    return this.sql.columnExists("product_price_change_events", "validity_status");
  }

  async isAdjustmentWorkflowReady() {
    return this.sql.columnExists("product_price_change_events", "adjustment_status");
  }

  async createRun(input, now = new Date()) {
    const timestamp = now.toISOString();
    const id = input.id || randomUUID();
    await this.provider.execute(
      `INSERT INTO price_control_sync_runs (
        id,trigger_type,sync_mode,status,input_fingerprint,started_at,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?)`,
      [id, input.triggerType, input.syncMode, input.status || "RUNNING", input.inputFingerprint, timestamp, timestamp, timestamp],
    );
    return this.getRun(id);
  }

  async getActiveRun() {
    const result = await this.provider.query(
      "SELECT * FROM price_control_sync_runs WHERE status='RUNNING' ORDER BY created_at LIMIT 1",
    );
    return runRow(result.rows[0]);
  }

  async touchRun(id, now = new Date()) {
    const result = await this.provider.execute(
      "UPDATE price_control_sync_runs SET updated_at=? WHERE id=? AND status='RUNNING'",
      [now.toISOString(), id],
    );
    return Number(result.rowCount || 0) === 1;
  }

  async recoverStaleRun(id, {
    staleBefore,
    errorCode = "PRICE_CONTROL_STALE_RUN_RECOVERED",
    errorMessage = "控价同步进程已退出，系统自动收尾过期运行记录。",
  } = {}, now = new Date()) {
    if (!staleBefore) throw new TypeError("Stale-run cutoff is required");
    const timestamp = now.toISOString();
    return this.provider.transaction(async (tx) => {
      const updated = await tx.execute(
        `UPDATE price_control_sync_runs SET
          status='FAILED',error_code=?,error_message=?,fetched_at=?,finished_at=?,updated_at=?
         WHERE id=? AND status='RUNNING' AND updated_at<=?`,
        [errorCode, String(errorMessage).slice(0, 500), timestamp, timestamp, timestamp, id, staleBefore],
      );
      if (Number(updated.rowCount || 0) !== 1) return null;
      const result = await tx.query("SELECT * FROM price_control_sync_runs WHERE id=?", [id]);
      const run = runRow(result.rows[0]);
      let foundationRecovered = false;
      if (run?.foundationSourceRunId) {
        const foundation = await tx.execute(
          `UPDATE foundation_source_runs SET status='FAILED',finished_at=?,updated_at=?
           WHERE id=? AND status='RUNNING'`,
          [timestamp, timestamp, run.foundationSourceRunId],
        );
        foundationRecovered = Number(foundation.rowCount || 0) === 1;
      }
      return { run, foundationRecovered };
    });
  }

  async updateRun(id, patch, now = new Date()) {
    const columns = {
      foundationSourceRunId: "foundation_source_run_id",
      status: "status",
      sourceVersion: "source_version",
      sourceCheckedAt: "source_checked_at",
      sourceTableUpdatedAt: "source_table_updated_at",
      sourceBusinessUpdatedAt: "source_business_updated_at",
      fetchedAt: "fetched_at",
      watermarkAt: "watermark_at",
      batchesSeen: "batches_seen",
      batchesApplied: "batches_applied",
      sourceRowsSeen: "source_rows_seen",
      pricePointsSeen: "price_points_seen",
      changeCount: "change_count",
      notificationStatus: "notification_status",
      notifiedAt: "notified_at",
      notificationErrorCode: "notification_error_code",
      errorCode: "error_code",
      errorMessage: "error_message",
      finishedAt: "finished_at",
    };
    const assignments = [];
    const parameters = [];
    for (const [key, column] of Object.entries(columns)) {
      if (patch[key] === undefined) continue;
      assignments.push(`${column}=?`);
      parameters.push(patch[key]);
    }
    assignments.push("updated_at=?");
    parameters.push(now.toISOString(), id);
    await this.provider.execute(`UPDATE price_control_sync_runs SET ${assignments.join(",")} WHERE id=?`, parameters);
    return this.getRun(id);
  }

  async getRun(id) {
    const result = await this.provider.query("SELECT * FROM price_control_sync_runs WHERE id=?", [id]);
    return runRow(result.rows[0]);
  }

  async listRuns({ page = 1, pageSize = 20 } = {}) {
    const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
    const safeSize = Math.max(1, Math.min(Number.parseInt(pageSize, 10) || 20, 100));
    const totalResult = await this.provider.query("SELECT COUNT(*) AS total FROM price_control_sync_runs");
    const result = await this.provider.query(
      "SELECT * FROM price_control_sync_runs ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?",
      [safeSize, (safePage - 1) * safeSize],
    );
    const total = number(totalResult.rows[0]?.total);
    return { runs: result.rows.map(runRow), page: safePage, pageSize: safeSize, total, totalPages: Math.max(1, Math.ceil(total / safeSize)) };
  }

  async getBatch(applyNo) {
    const result = await this.provider.query("SELECT * FROM price_control_source_batches WHERE apply_no=?", [applyNo]);
    return result.rows[0] || null;
  }

  async getCurrentPrices(priceKeys) {
    const rows = [];
    for (let offset = 0; offset < priceKeys.length; offset += 500) {
      const chunk = priceKeys.slice(offset, offset + 500);
      if (!chunk.length) continue;
      const result = await this.provider.query(
        `SELECT * FROM product_sku_current_prices WHERE price_key IN (${chunk.map(() => "?").join(",")})`,
        chunk,
      );
      rows.push(...result.rows);
    }
    return new Map(rows.map((row) => [row.price_key, currentPriceRow(row)]));
  }

  async currentPriceCount() {
    const result = await this.provider.query("SELECT COUNT(*) AS total FROM product_sku_current_prices");
    return number(result.rows[0]?.total);
  }

  async getAutomationSettings() {
    if (!await this.isAutomationReady()) return null;
    const result = await this.provider.query("SELECT * FROM price_control_automation_settings WHERE id='default'");
    return automationSettingsRow(result.rows[0]);
  }

  async saveAutomationSettings(input, now = new Date()) {
    const timestamp = now.toISOString();
    const intervalMinutes = Math.max(15, Math.min(Number.parseInt(input.intervalMinutes, 10) || 60, 1440));
    const enabled = Boolean(input.enabled);
    const nextRunAt = enabled
      ? nextAlignedAutomationRunAt(now, intervalMinutes).toISOString()
      : null;
    await this.provider.execute(
      `UPDATE price_control_automation_settings SET
        enabled=?,interval_minutes=?,dingtalk_config_id=?,notify_on_change=?,notify_on_failure=?,
        next_run_at=?,last_error_code=NULL,last_error_message=NULL,updated_at=?
       WHERE id='default'`,
      [Number(enabled), intervalMinutes, input.dingtalkConfigId || null,
        Number(input.notifyOnChange !== false), Number(input.notifyOnFailure !== false), nextRunAt, timestamp],
    );
    return this.getAutomationSettings();
  }

  async claimDueAutomation(now = new Date()) {
    const settings = await this.getAutomationSettings();
    if (!settings?.enabled || !settings.nextRunAt || settings.nextRunAt > now.toISOString()) return null;
    const claimedNextRunAt = nextAlignedAutomationRunAt(now, settings.intervalMinutes).toISOString();
    const result = await this.provider.execute(
      `UPDATE price_control_automation_settings SET next_run_at=?,updated_at=?
       WHERE id='default' AND enabled=1 AND next_run_at IS NOT NULL AND next_run_at<=?`,
      [claimedNextRunAt, now.toISOString(), now.toISOString()],
    );
    return result.rowCount === 1 ? { ...settings, nextRunAt: claimedNextRunAt } : null;
  }

  async completeAutomationRun(input, now = new Date()) {
    await this.provider.execute(
      `UPDATE price_control_automation_settings SET
        last_run_at=?,last_run_status=?,last_notification_at=?,last_notification_status=?,
        last_error_code=?,last_error_message=?,updated_at=?
       WHERE id='default'`,
      [now.toISOString(), input.status, input.notificationAt || null, input.notificationStatus || null,
        input.errorCode || null, input.errorMessage ? String(input.errorMessage).slice(0, 500) : null, now.toISOString()],
    );
    return this.getAutomationSettings();
  }

  async updateRunNotification(runId, input, now = new Date()) {
    return this.updateRun(runId, {
      notificationStatus: input.status,
      notifiedAt: input.notifiedAt || null,
      notificationErrorCode: input.errorCode || null,
    }, now);
  }

  async applyBatch({ runId, batch, snapshots, currentUpdates, currentRemovals, changes }, now = new Date()) {
    const timestamp = now.toISOString();
    return this.provider.transaction(async (tx) => {
      const persistedChangeIds = [];
      await tx.execute(
        `INSERT INTO price_control_source_batches (
          apply_no,country_code,approval_status,source_row_count,batch_fingerprint,
          apply_created_at,submitted_at,approved_at,effective_at,first_seen_at,last_seen_at,last_sync_run_id
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(apply_no) DO UPDATE SET
          country_code=excluded.country_code,approval_status=excluded.approval_status,
          source_row_count=excluded.source_row_count,batch_fingerprint=excluded.batch_fingerprint,
          apply_created_at=excluded.apply_created_at,submitted_at=excluded.submitted_at,
          approved_at=excluded.approved_at,effective_at=excluded.effective_at,
          last_seen_at=excluded.last_seen_at,last_sync_run_id=excluded.last_sync_run_id`,
        [batch.applyNo, batch.countryCode, batch.approvalStatus, batch.sourceRowCount, batch.batchFingerprint,
          batch.applyCreatedAt ?? null, batch.submittedAt ?? null, batch.approvedAt ?? null, batch.effectiveAt,
          timestamp, timestamp, runId],
      );

      for (const snapshot of snapshots) {
        await tx.execute(
          `INSERT INTO price_control_price_snapshots (
            id,sync_run_id,apply_no,source_row_key,price_key,country_code,category_name,sku,
            product_name_cn,sku_status,platform,shop_type,price_type,price_value,effective_at,
            row_fingerprint,created_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(apply_no,price_key) DO UPDATE SET
            sync_run_id=excluded.sync_run_id,source_row_key=excluded.source_row_key,
            category_name=excluded.category_name,product_name_cn=excluded.product_name_cn,
            sku_status=excluded.sku_status,price_value=excluded.price_value,
            effective_at=excluded.effective_at,row_fingerprint=excluded.row_fingerprint`,
          [snapshot.id, runId, batch.applyNo, snapshot.sourceRowKey, snapshot.priceKey,
            snapshot.countryCode, snapshot.categoryName, snapshot.sku, snapshot.productNameCn,
            snapshot.skuStatus, snapshot.platform, snapshot.shopType, snapshot.priceType,
            snapshot.priceValue, batch.effectiveAt, snapshot.rowFingerprint, timestamp],
        );
      }

      for (const update of currentUpdates) {
        await tx.execute(
          `INSERT INTO product_sku_current_prices (
            price_key,country_code,category_name,sku,product_name_cn,sku_status,platform,
            shop_type,price_type,price_value,source_apply_no,source_snapshot_id,effective_at,
            revision,created_at,updated_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)
          ON CONFLICT(price_key) DO UPDATE SET
            country_code=excluded.country_code,category_name=excluded.category_name,
            sku=excluded.sku,product_name_cn=excluded.product_name_cn,sku_status=excluded.sku_status,
            platform=excluded.platform,shop_type=excluded.shop_type,price_type=excluded.price_type,
            price_value=excluded.price_value,source_apply_no=excluded.source_apply_no,
            source_snapshot_id=excluded.source_snapshot_id,effective_at=excluded.effective_at,
            revision=product_sku_current_prices.revision+1,updated_at=excluded.updated_at`,
          [update.priceKey, update.countryCode, update.categoryName, update.sku, update.productNameCn,
            update.skuStatus, update.platform, update.shopType, update.priceType, update.priceValue,
            batch.applyNo, update.snapshotId, batch.effectiveAt, timestamp, timestamp],
        );
      }
      for (const priceKey of currentRemovals) {
        await tx.execute("DELETE FROM product_sku_current_prices WHERE price_key=?", [priceKey]);
      }
      for (const change of changes) {
        const inserted = await tx.execute(
          `INSERT INTO product_price_change_events (
            id,sync_run_id,source_apply_no,price_key,country_code,category_name,sku,
            product_name_cn,platform,shop_type,price_type,old_price,new_price,delta_value,
            delta_percent,direction,change_text,change_fingerprint,foundation_task_id,detected_at,created_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(change_fingerprint) DO NOTHING`,
          [change.id, runId, batch.applyNo, change.priceKey, change.countryCode, change.categoryName,
            change.sku, change.productNameCn, change.platform, change.shopType, change.priceType,
            change.oldPrice, change.newPrice, change.deltaValue, change.deltaPercent,
            change.direction, change.changeText, change.changeFingerprint, change.foundationTaskId || null,
            timestamp, timestamp],
        );
        if (inserted.rowCount === 1) persistedChangeIds.push(change.id);
      }
      return { snapshots: snapshots.length, changes: persistedChangeIds.length, persistedChangeIds };
    });
  }

  async linkChangesToTask(changeIds, taskId) {
    for (let offset = 0; offset < changeIds.length; offset += 500) {
      const chunk = changeIds.slice(offset, offset + 500);
      if (!chunk.length) continue;
      await this.provider.execute(
        `UPDATE product_price_change_events SET foundation_task_id=? WHERE id IN (${chunk.map(() => "?").join(",")})`,
        [taskId, ...chunk],
      );
    }
  }

  async repairNullSemantics({ requestedBy = "commerce-ops" } = {}, now = new Date()) {
    if (!await this.isNullSemanticsRepairReady()) {
      throw Object.assign(new Error("Price-control NULL semantics migration is required."), {
        code: "PRICE_CONTROL_NULL_SEMANTICS_MIGRATION_REQUIRED",
      });
    }
    const timestamp = now.toISOString();
    return this.provider.transaction(async (tx) => {
      const before = await tx.query(
        `SELECT COUNT(*) AS total,
          SUM(CASE WHEN validity_status='INVALID' THEN 1 ELSE 0 END) AS invalid_count
         FROM product_price_change_events`,
      );
      const removed = await tx.execute(
        `UPDATE product_price_change_events SET
          validity_status='INVALID',invalid_reason='SOURCE_NULL_NOT_MAINTAINED',
          invalidated_at=?,invalidated_by=?
         WHERE direction='REMOVED' AND validity_status='VALID'`,
        [timestamp, requestedBy],
      );
      const falseNew = await tx.execute(
        `UPDATE product_price_change_events AS event SET
          validity_status='INVALID',invalid_reason='REAPPEARED_AFTER_NULL_MISINTERPRETATION',
          invalidated_at=?,invalidated_by=?
         WHERE event.direction='NEW' AND event.validity_status='VALID'
           AND EXISTS (
             SELECT 1
             FROM price_control_price_snapshots AS prior
             JOIN price_control_source_batches AS event_batch
               ON event_batch.apply_no=event.source_apply_no
             WHERE prior.price_key=event.price_key
               AND prior.apply_no<>event.source_apply_no
               AND (
                 prior.effective_at<event_batch.effective_at OR
                 (prior.effective_at=event_batch.effective_at AND prior.created_at<event.detected_at)
               )
           )`,
        [timestamp, requestedBy],
      );

      await tx.execute("DELETE FROM product_sku_current_prices");
      await tx.execute(
        `INSERT INTO product_sku_current_prices (
          price_key,country_code,category_name,sku,product_name_cn,sku_status,platform,
          shop_type,price_type,price_value,source_apply_no,source_snapshot_id,effective_at,
          revision,created_at,updated_at
        )
        SELECT price_key,country_code,category_name,sku,product_name_cn,sku_status,platform,
          shop_type,price_type,price_value,apply_no,id,effective_at,1,created_at,?
        FROM (
          SELECT snapshot.*,
            ROW_NUMBER() OVER (
              PARTITION BY price_key
              ORDER BY effective_at DESC,created_at DESC,id DESC
            ) AS row_number
          FROM price_control_price_snapshots AS snapshot
        ) AS latest
        WHERE row_number=1`,
        [timestamp],
      );
      const after = await tx.query(
        `SELECT COUNT(*) AS total,
          SUM(CASE WHEN validity_status='VALID' THEN 1 ELSE 0 END) AS valid_count,
          SUM(CASE WHEN validity_status='INVALID' THEN 1 ELSE 0 END) AS invalid_count,
          SUM(CASE WHEN invalid_reason='SOURCE_NULL_NOT_MAINTAINED' THEN 1 ELSE 0 END) AS invalid_removed_count,
          SUM(CASE WHEN invalid_reason='REAPPEARED_AFTER_NULL_MISINTERPRETATION' THEN 1 ELSE 0 END) AS invalid_false_new_count
         FROM product_price_change_events`,
      );
      const current = await tx.query("SELECT COUNT(*) AS total FROM product_sku_current_prices");
      return {
        totalEvents: number(after.rows[0]?.total),
        validEvents: number(after.rows[0]?.valid_count),
        invalidEventsBefore: number(before.rows[0]?.invalid_count),
        invalidEvents: number(after.rows[0]?.invalid_count),
        invalidRemoved: number(after.rows[0]?.invalid_removed_count),
        invalidFalseNew: number(after.rows[0]?.invalid_false_new_count),
        newlyInvalidRemoved: number(removed.rowCount),
        newlyInvalidFalseNew: number(falseNew.rowCount),
        currentPriceCount: number(current.rows[0]?.total),
        invalidatedAt: timestamp,
        invalidatedBy: requestedBy,
      };
    });
  }

  async listInvalidOnlyTaskIds() {
    const result = await this.provider.query(
      `SELECT foundation_task_id
       FROM product_price_change_events
       WHERE foundation_task_id IS NOT NULL
       GROUP BY foundation_task_id
       HAVING SUM(CASE WHEN validity_status='VALID' THEN 1 ELSE 0 END)=0`,
    );
    return result.rows.map((row) => row.foundation_task_id);
  }

  async listChanges(filters = {}) {
    const page = Math.max(1, Number.parseInt(filters.page, 10) || 1);
    const pageSize = Math.max(1, Math.min(Number.parseInt(filters.pageSize, 10) || 50, 100));
    const where = [];
    const parameters = [];
    const validityStatus = String(filters.validityStatus || "VALID").toUpperCase();
    if (validityStatus !== "ALL") {
      where.push("validity_status=?");
      parameters.push(validityStatus === "INVALID" ? "INVALID" : "VALID");
    }
    const exact = {
      countryCode: "country_code", categoryName: "category_name", platform: "platform",
      shopType: "shop_type", priceType: "price_type", direction: "direction", sourceApplyNo: "source_apply_no",
      syncRunId: "sync_run_id", adjustmentStatus: "adjustment_status",
    };
    for (const [key, column] of Object.entries(exact)) {
      if (!filters[key]) continue;
      where.push(`${column}=?`);
      parameters.push(String(filters[key]));
    }
    if (filters.sku) {
      where.push("sku LIKE ? ESCAPE '\\'");
      parameters.push(`%${String(filters.sku).replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const totalResult = await this.provider.query(`SELECT COUNT(*) AS total FROM product_price_change_events ${clause}`, parameters);
    const result = await this.provider.query(
      `SELECT * FROM product_price_change_events ${clause}
       ORDER BY detected_at DESC,id DESC LIMIT ? OFFSET ?`,
      [...parameters, pageSize, (page - 1) * pageSize],
    );
    const total = number(totalResult.rows[0]?.total);
    return { changes: result.rows.map(changeRow), page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
  }

  async getChange(id) {
    const result = await this.provider.query("SELECT * FROM product_price_change_events WHERE id=?", [id]);
    return changeRow(result.rows[0]);
  }

  async getChangesByIds(ids) {
    const unique = [...new Set((ids || []).map((id) => String(id || "").trim()).filter(Boolean))];
    const rows = [];
    for (let offset = 0; offset < unique.length; offset += 500) {
      const chunk = unique.slice(offset, offset + 500);
      const result = await this.provider.query(
        `SELECT * FROM product_price_change_events WHERE id IN (${chunk.map(() => "?").join(",")})`,
        chunk,
      );
      rows.push(...result.rows);
    }
    const mapped = new Map(rows.map((row) => [row.id, changeRow(row)]));
    return unique.map((id) => mapped.get(id)).filter(Boolean);
  }

  async getExistingChangeFingerprints(fingerprints) {
    const unique = [...new Set((fingerprints || []).map((value) => String(value || "").trim()).filter(Boolean))];
    const existing = new Set();
    for (let offset = 0; offset < unique.length; offset += 500) {
      const chunk = unique.slice(offset, offset + 500);
      const result = await this.provider.query(
        `SELECT change_fingerprint FROM product_price_change_events
         WHERE change_fingerprint IN (${chunk.map(() => "?").join(",")})`,
        chunk,
      );
      for (const row of result.rows) existing.add(row.change_fingerprint);
    }
    return existing;
  }

  async getLatestChangeRound() {
    const rounds = await this.listChangeRounds({ limit: 1 });
    return rounds[0] || null;
  }

  async listChangeRounds({ limit = 50 } = {}) {
    const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 50, 100));
    const result = await this.provider.query(
      `SELECT event.sync_run_id,run.trigger_type,
        MIN(event.detected_at) AS first_detected_at,
        MAX(event.detected_at) AS last_detected_at,
        run.source_business_updated_at,run.source_table_updated_at,run.fetched_at,
        COUNT(*) AS change_count,
        COUNT(DISTINCT event.country_code || '|' || event.sku) AS affected_sku_count,
        SUM(CASE WHEN event.adjustment_status='ADJUSTED' THEN 1 ELSE 0 END) AS adjusted_count,
        SUM(CASE WHEN event.adjustment_status='UNADJUSTED' THEN 1 ELSE 0 END) AS unadjusted_count
       FROM product_price_change_events AS event
       JOIN price_control_sync_runs AS run ON run.id=event.sync_run_id
       WHERE event.validity_status='VALID'
       GROUP BY event.sync_run_id,run.trigger_type,run.source_business_updated_at,
         run.source_table_updated_at,run.fetched_at
       ORDER BY last_detected_at DESC,event.sync_run_id DESC
       LIMIT ?`,
      [safeLimit],
    );
    return result.rows.map(changeRoundRow);
  }

  async getChangeRound(syncRunId) {
    const rounds = await this.provider.query(
      `SELECT event.sync_run_id,run.trigger_type,
        MIN(event.detected_at) AS first_detected_at,
        MAX(event.detected_at) AS last_detected_at,
        run.source_business_updated_at,run.source_table_updated_at,run.fetched_at,
        COUNT(*) AS change_count,
        COUNT(DISTINCT event.country_code || '|' || event.sku) AS affected_sku_count,
        SUM(CASE WHEN event.adjustment_status='ADJUSTED' THEN 1 ELSE 0 END) AS adjusted_count,
        SUM(CASE WHEN event.adjustment_status='UNADJUSTED' THEN 1 ELSE 0 END) AS unadjusted_count
       FROM product_price_change_events AS event
       JOIN price_control_sync_runs AS run ON run.id=event.sync_run_id
       WHERE event.validity_status='VALID' AND event.sync_run_id=?
       GROUP BY event.sync_run_id,run.trigger_type,run.source_business_updated_at,
         run.source_table_updated_at,run.fetched_at`,
      [syncRunId],
    );
    return changeRoundRow(rounds.rows[0]);
  }

  async listChangeRoundCopyItems(syncRunId, { maxItems = 250_000 } = {}) {
    const safeMax = Math.max(1, Math.min(Number.parseInt(maxItems, 10) || 250_000, 250_000));
    const count = await this.provider.query(
      "SELECT COUNT(*) AS total FROM product_price_change_events WHERE validity_status='VALID' AND sync_run_id=?",
      [syncRunId],
    );
    const total = number(count.rows[0]?.total);
    if (total > safeMax) {
      throw Object.assign(new Error(`Change round exceeds the copy limit of ${safeMax}.`), {
        code: "PRICE_CONTROL_ROUND_COPY_TOO_LARGE",
        total,
        limit: safeMax,
      });
    }
    const result = await this.provider.query(
      `SELECT * FROM product_price_change_events
       WHERE validity_status='VALID' AND sync_run_id=?
       ORDER BY country_code,category_name,sku,platform,shop_type,price_type,id`,
      [syncRunId],
    );
    return result.rows.map(changeRow);
  }

  async updateAdjustment(id, input, now = new Date()) {
    const timestamp = now.toISOString();
    await this.provider.execute(
      `UPDATE product_price_change_events SET
        adjustment_status=?,adjustment_remark=?,adjustment_updated_at=?,adjustment_updated_by=?
       WHERE id=? AND validity_status='VALID'`,
      [input.status, input.remark || null, timestamp, input.updatedBy, id],
    );
    return this.getChange(id);
  }

  async getTaskAdjustmentSummary(taskId) {
    const result = await this.provider.query(
      `SELECT COUNT(*) AS total,
        SUM(CASE WHEN adjustment_status='ADJUSTED' THEN 1 ELSE 0 END) AS adjusted_count,
        SUM(CASE WHEN adjustment_status='UNADJUSTED' THEN 1 ELSE 0 END) AS unadjusted_count
       FROM product_price_change_events
       WHERE validity_status='VALID' AND foundation_task_id=?`,
      [taskId],
    );
    return {
      total: number(result.rows[0]?.total),
      adjustedCount: number(result.rows[0]?.adjusted_count),
      unadjustedCount: number(result.rows[0]?.unadjusted_count),
    };
  }

  async listCurrentPrices(filters = {}) {
    const page = Math.max(1, Number.parseInt(filters.page, 10) || 1);
    const pageSize = Math.max(1, Math.min(Number.parseInt(filters.pageSize, 10) || 50, 100));
    const where = [];
    const parameters = [];
    const exact = {
      countryCode: "country_code", categoryName: "category_name", platform: "platform",
      shopType: "shop_type", priceType: "price_type", sourceApplyNo: "source_apply_no",
    };
    for (const [key, column] of Object.entries(exact)) {
      if (!filters[key]) continue;
      where.push(`${column}=?`);
      parameters.push(String(filters[key]));
    }
    if (filters.sku) {
      where.push("sku LIKE ? ESCAPE '\\'");
      parameters.push(`%${String(filters.sku).replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const count = await this.provider.query(`SELECT COUNT(*) AS total FROM product_sku_current_prices ${clause}`, parameters);
    const result = await this.provider.query(
      `SELECT * FROM product_sku_current_prices ${clause}
       ORDER BY effective_at DESC,country_code,sku,platform,shop_type,price_type
       LIMIT ? OFFSET ?`,
      [...parameters, pageSize, (page - 1) * pageSize],
    );
    const total = number(count.rows[0]?.total);
    return {
      prices: result.rows.map(currentPriceRow),
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  async overview() {
    const [counts, current, latest, countries, categories, batches] = await Promise.all([
      this.provider.query(
        `SELECT COUNT(*) AS total,
          SUM(CASE WHEN direction='UP' THEN 1 ELSE 0 END) AS up_count,
          SUM(CASE WHEN direction='DOWN' THEN 1 ELSE 0 END) AS down_count,
          COUNT(DISTINCT sku) AS sku_count
         FROM product_price_change_events
         WHERE validity_status='VALID'`,
      ),
      this.provider.query(
        `SELECT COUNT(*) AS price_count,COUNT(DISTINCT country_code || '|' || sku) AS sku_count,
          MAX(effective_at) AS latest_effective_at
         FROM product_sku_current_prices`,
      ),
      this.provider.query("SELECT MAX(detected_at) AS latest_detected_at FROM product_price_change_events WHERE validity_status='VALID'"),
      this.provider.query("SELECT DISTINCT country_code FROM product_sku_current_prices ORDER BY country_code"),
      this.provider.query("SELECT DISTINCT category_name FROM product_sku_current_prices WHERE category_name IS NOT NULL ORDER BY category_name"),
      this.provider.query("SELECT apply_no,country_code,effective_at FROM price_control_source_batches ORDER BY effective_at DESC,apply_no DESC LIMIT 50"),
    ]);
    const row = counts.rows[0] || {};
    const currentRow = current.rows[0] || {};
    return {
      totalChanges: number(row.total),
      upCount: number(row.up_count),
      downCount: number(row.down_count),
      affectedSkuCount: number(row.sku_count),
      latestDetectedAt: latest.rows[0]?.latest_detected_at || null,
      currentPriceCount: number(currentRow.price_count),
      currentSkuCount: number(currentRow.sku_count),
      latestEffectiveAt: currentRow.latest_effective_at || null,
      filters: {
        countries: countries.rows.map((item) => item.country_code),
        categories: categories.rows.map((item) => item.category_name),
        batches: batches.rows.map((item) => ({ applyNo: item.apply_no, countryCode: item.country_code, effectiveAt: item.effective_at })),
      },
    };
  }
}
