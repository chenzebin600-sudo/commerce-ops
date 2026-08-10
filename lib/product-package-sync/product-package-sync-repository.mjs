import { randomUUID } from "node:crypto";
import { DATABASE_DIALECTS, assertDatabaseProvider } from "../data/database-provider.mjs";
import {
  PRODUCT_PACKAGE_SOURCE_FIELDS,
  PRODUCT_PACKAGE_SOURCE_SYSTEM,
} from "./product-package-source-contract.mjs";
import { sha256, stableJson } from "../product-center/product-package-contract.mjs";

const STAGE_COLUMNS = Object.freeze([
  "source_row_number", "source_row_key", "row_sha256", "product_key",
  "country_code", "stock_sku", "warehouse_id", "warehouse_name", "sales_sku",
  "product_name", "category_l1", "category_l2", "category_l3", "source_period",
  "source_status", "lifecycle_status", "lifecycle_reason_code", "source_updated_at",
  "raw_payload_json", "raw_types_json", "normalized_payload_json",
  "category_l1_id", "category_l2_id", "model_id", "product_id",
]);

const SYNC_STAGE_TABLES = Object.freeze([
  "product_package_sync_stage_lifecycle",
  "product_package_sync_stage_products",
  "product_package_sync_stage_field_events",
  "product_package_sync_stage_changed_rows",
  "product_package_sync_stage_changed_keys",
  "product_package_sync_stage_source",
]);

const LEGACY_RAW_COLUMN_MAP = Object.freeze({
  raw_source_period_json: "period",
  raw_sku_code_json: "stock_sku",
  raw_product_name_json: "sku_name_cn",
  raw_main_sku_code_json: "sales_sku",
  raw_country_raw_json: "country",
  raw_category_l1_json: "parent_category_name",
  raw_category_l2_json: "category_name",
  raw_source_created_date_json: "time_created",
  raw_new_product_month_json: "period_created",
  raw_new_product_age_months_json: "monthNum",
  raw_gift_raw_json: "is_gift",
  raw_source_status_json: "stock_status",
  raw_style_code_json: "style_number",
  raw_style_name_json: "style_name",
  raw_sales_spec_json: "saleSpec",
  raw_item_dimensions_raw_json: "case_size",
  raw_item_net_weight_g_json: "net_weight",
  raw_item_gross_weight_g_json: "weight",
  raw_carton_length_cm_json: "length",
  raw_carton_width_cm_json: "width",
  raw_carton_height_cm_json: "height",
  raw_carton_quantity_json: "carton_size",
  raw_shipping_method_json: "delivery_mode",
  raw_warehouse_raw_json: "warehouse_name",
  raw_warehouse_stock_json: "storage",
  raw_planned_warehouse_raw_json: "isPlan",
  raw_cost_cny_json: "sales_cost",
  raw_exchange_rate_json: "exchange_rate",
  raw_cost_local_json: "sales_cost_ori",
  raw_price_tier_20_json: null,
  raw_price_tier_25_json: null,
  raw_price_tier_35_json: null,
  raw_price_tier_45_json: null,
  raw_attach_rate_json: "jointRate",
  raw_forecast_daily_sales_json: null,
});

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function runRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    triggerType: row.trigger_type,
    status: row.status,
    sourceSystem: row.source_system,
    sourceTable: row.source_table,
    scheduleDate: row.schedule_date || null,
    importBatchId: row.import_batch_id || null,
    sourceSnapshotSha256: row.source_snapshot_sha256 || null,
    sourceRowCount: number(row.source_row_count),
    localRowCountBefore: number(row.local_row_count_before),
    localRowCountAfter: number(row.local_row_count_after),
    newCount: number(row.new_count),
    updatedCount: number(row.updated_count),
    unchangedCount: number(row.unchanged_count),
    removedCount: number(row.removed_count),
    fieldChangeCount: number(row.field_change_count),
    sourceCheckedAt: row.source_checked_at || null,
    sourceTableUpdatedAt: row.source_table_updated_at || null,
    sourceMaxUpdatedAt: row.source_max_updated_at || null,
    startedAt: row.started_at,
    finishedAt: row.finished_at || null,
    errorCode: row.error_code || null,
    errorMessage: row.error_message || null,
    requestedBy: row.requested_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function changeRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    runId: row.sync_run_id,
    importBatchId: row.import_batch_id,
    changeType: row.source_header === "__row__"
      ? (row.old_value_json === null ? "ADDED" : row.new_value_json === null ? "REMOVED" : "UPDATED")
      : "UPDATED",
    countryCode: row.country_raw || null,
    sku: row.sku_code || null,
    warehouse: row.warehouse_raw || null,
    productName: row.chinese_name || null,
    sourceColumn: row.source_header,
    fieldName: row.field_name,
    fieldLabel: row.field_label || row.source_header,
    oldValue: parseJson(row.old_value_json, null),
    newValue: parseJson(row.new_value_json, null),
    oldType: row.old_type || null,
    newType: row.new_type || null,
    hasManualOverride: Boolean(number(row.has_manual_override)),
    changedAt: row.changed_at,
  };
}

function stageValues(row) {
  return [
    row.sourceRowNumber,
    row.sourceRowKey,
    row.rowSha256,
    row.productKey,
    row.countryCode,
    row.stockSku,
    row.warehouseId,
    row.warehouseName,
    row.salesSku,
    row.productName,
    row.categoryL1,
    row.categoryL2,
    row.categoryL3,
    row.sourcePeriod,
    row.sourceStatus,
    row.lifecycleStatus,
    row.lifecycleReasonCode,
    row.sourceUpdatedAt,
    JSON.stringify(row.rawPayload),
    JSON.stringify(row.rawTypes),
    JSON.stringify(row.normalizedPayload),
    row.categoryL1Id,
    row.categoryL2Id,
    row.modelId,
    row.productId,
  ];
}

export class ProductPackageSyncRepository {
  constructor({ provider }) {
    this.provider = assertDatabaseProvider(provider);
    if (this.provider.dialect !== DATABASE_DIALECTS.POSTGRESQL) {
      throw new TypeError("Database product package synchronization requires PostgreSQL");
    }
    this.prefix = "app.";
  }

  table(name) {
    return `${this.prefix}${name}`;
  }

  placeholders(client, count, offset = 0) {
    return Array.from({ length: count }, (_, index) => client.placeholder(offset + index + 1));
  }

  async isReady() {
    const result = await this.provider.query(
      "SELECT to_regclass('app.product_package_sync_runs') relation_name",
    );
    return Boolean(result.rows[0]?.relation_name);
  }

  async createRun({ triggerType, scheduleDate = null, requestedBy = "local_session", now = new Date() }) {
    const timestamp = now.toISOString();
    const id = randomUUID();
    const values = [
      id, triggerType, "RUNNING", scheduleDate, requestedBy,
      timestamp, timestamp, timestamp,
    ];
    const p = this.placeholders(this.provider, values.length);
    try {
      await this.provider.execute(`INSERT INTO ${this.table("product_package_sync_runs")} (
        id,trigger_type,status,schedule_date,requested_by,started_at,created_at,updated_at
      ) VALUES (${p.join(",")})`, values);
    } catch (error) {
      if (triggerType === "scheduled" && scheduleDate) {
        const existing = await this.getScheduledRun(scheduleDate);
        if (existing?.status === "FAILED") {
          await this.provider.execute(
            `UPDATE ${this.table("product_package_sync_runs")} SET status='RUNNING',requested_by=${this.provider.placeholder(1)},
              started_at=${this.provider.placeholder(2)},finished_at=NULL,error_code=NULL,error_message=NULL,
              updated_at=${this.provider.placeholder(2)} WHERE id=${this.provider.placeholder(3)} AND status='FAILED'`,
            [requestedBy, timestamp, existing.id],
          );
          const reset = await this.getRun(existing.id);
          return { run: reset, claimed: reset?.status === "RUNNING" };
        }
        if (existing) return { run: existing, claimed: false };
      }
      throw error;
    }
    return { run: await this.getRun(id), claimed: true };
  }

  async getRun(id) {
    const result = await this.provider.query(
      `SELECT * FROM ${this.table("product_package_sync_runs")} WHERE id=${this.provider.placeholder(1)}`,
      [id],
    );
    return runRow(result.rows[0]);
  }

  async getScheduledRun(scheduleDate) {
    const result = await this.provider.query(
      `SELECT * FROM ${this.table("product_package_sync_runs")}
       WHERE trigger_type='scheduled' AND schedule_date=${this.provider.placeholder(1)}
       ORDER BY created_at DESC LIMIT 1`,
      [scheduleDate],
    );
    return runRow(result.rows[0]);
  }

  async getActiveRun() {
    const result = await this.provider.query(
      `SELECT * FROM ${this.table("product_package_sync_runs")}
       WHERE status='RUNNING' ORDER BY created_at LIMIT 1`,
    );
    return runRow(result.rows[0]);
  }

  async updateRun(id, patch, now = new Date()) {
    const columns = {
      status: "status",
      importBatchId: "import_batch_id",
      sourceSnapshotSha256: "source_snapshot_sha256",
      sourceRowCount: "source_row_count",
      localRowCountBefore: "local_row_count_before",
      localRowCountAfter: "local_row_count_after",
      newCount: "new_count",
      updatedCount: "updated_count",
      unchangedCount: "unchanged_count",
      removedCount: "removed_count",
      fieldChangeCount: "field_change_count",
      sourceCheckedAt: "source_checked_at",
      sourceTableUpdatedAt: "source_table_updated_at",
      sourceMaxUpdatedAt: "source_max_updated_at",
      finishedAt: "finished_at",
      errorCode: "error_code",
      errorMessage: "error_message",
    };
    const values = [];
    const assignments = [];
    for (const [key, column] of Object.entries(columns)) {
      if (patch[key] === undefined) continue;
      values.push(key === "errorMessage" && patch[key] ? String(patch[key]).slice(0, 500) : patch[key]);
      assignments.push(`${column}=${this.provider.placeholder(values.length)}`);
    }
    values.push(now.toISOString());
    assignments.push(`updated_at=${this.provider.placeholder(values.length)}`);
    values.push(id);
    await this.provider.execute(
      `UPDATE ${this.table("product_package_sync_runs")} SET ${assignments.join(",")}
       WHERE id=${this.provider.placeholder(values.length)}`,
      values,
    );
    return this.getRun(id);
  }

  async listRuns({ page = 1, pageSize = 20 } = {}) {
    const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
    const safePageSize = Math.max(1, Math.min(Number.parseInt(pageSize, 10) || 20, 100));
    const total = number((await this.provider.query(
      `SELECT COUNT(*) AS total FROM ${this.table("product_package_sync_runs")}`,
    )).rows[0]?.total);
    const p = this.placeholders(this.provider, 2);
    const result = await this.provider.query(
      `SELECT * FROM ${this.table("product_package_sync_runs")}
       ORDER BY created_at DESC,id DESC LIMIT ${p[0]} OFFSET ${p[1]}`,
      [safePageSize, (safePage - 1) * safePageSize],
    );
    return {
      runs: result.rows.map(runRow),
      total,
      page: safePage,
      pageSize: safePageSize,
      totalPages: Math.max(1, Math.ceil(total / safePageSize)),
    };
  }

  async latestRun() {
    const result = await this.provider.query(
      `SELECT * FROM ${this.table("product_package_sync_runs")} ORDER BY created_at DESC,id DESC LIMIT 1`,
    );
    return runRow(result.rows[0]);
  }

  async currentRowCount() {
    const result = await this.provider.query(
      `SELECT COUNT(*) AS total FROM ${this.table("product_package_rows")}
       WHERE source_system=${this.provider.placeholder(1)}`,
      [PRODUCT_PACKAGE_SOURCE_SYSTEM],
    );
    return number(result.rows[0]?.total);
  }

  async listChanges({ runId = null, page = 1, pageSize = 50, country = null, sku = null, field = null, changeType = null } = {}) {
    const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
    const safePageSize = Math.max(1, Math.min(Number.parseInt(pageSize, 10) || 50, 200));
    const values = [];
    const clauses = ["r.import_batch_id=c.import_batch_id"];
    const add = (sql, value) => {
      values.push(value);
      clauses.push(sql.replace("$P", this.provider.placeholder(values.length)));
    };
    if (runId) add("r.id=$P", String(runId));
    if (country) add("c.country_raw=$P", String(country));
    if (sku) {
      values.push(`%${String(sku).trim().toUpperCase()}%`);
      clauses.push(`UPPER(COALESCE(c.sku_code,'')) LIKE ${this.provider.placeholder(values.length)}`);
    }
    if (field) add("c.field_name=$P", String(field));
    if (changeType === "ADDED") clauses.push("c.source_header='__row__' AND c.old_value_json IS NULL");
    if (changeType === "REMOVED") clauses.push("c.source_header='__row__' AND c.new_value_json IS NULL");
    if (changeType === "UPDATED") clauses.push("c.source_header<>'__row__'");
    const where = clauses.join(" AND ");
    const from = `${this.table("product_import_field_changes")} c
      JOIN ${this.table("product_package_sync_runs")} r ON ${where}`;
    const total = number((await this.provider.query(`SELECT COUNT(*) AS total FROM ${from}`, values)).rows[0]?.total);
    const paging = this.placeholders(this.provider, 2, values.length);
    const labels = new Map(PRODUCT_PACKAGE_SOURCE_FIELDS.map((item) => [item.column, item.label]));
    const result = await this.provider.query(
      `SELECT c.*,r.id sync_run_id FROM ${from}
       ORDER BY c.changed_at DESC,c.source_row_number,c.field_name,c.id
       LIMIT ${paging[0]} OFFSET ${paging[1]}`,
      [...values, safePageSize, (safePage - 1) * safePageSize],
    );
    return {
      changes: result.rows.map((row) => changeRow({ ...row, field_label: labels.get(row.source_header) || (row.source_header === "__row__" ? "整行" : row.source_header) })),
      total,
      page: safePage,
      pageSize: safePageSize,
      totalPages: Math.max(1, Math.ceil(total / safePageSize)),
    };
  }

  async clearStage(tx, runId) {
    for (const table of SYNC_STAGE_TABLES) {
      await tx.execute(
        `DELETE FROM ${this.table(table)} WHERE run_id=${tx.placeholder(1)}`,
        [runId],
      );
    }
  }

  async reconcile({
    runId,
    requestedBy,
    loadRows,
    mapping = PRODUCT_PACKAGE_SOURCE_FIELDS,
    maxRemovalRatio = 0.2,
    allowLargeRemoval = false,
  }) {
    if (typeof loadRows !== "function") throw new TypeError("Product package row loader is required");
    const now = new Date();
    const timestamp = now.toISOString();
    return this.provider.transaction(async (tx) => {
      await tx.executeScript("SET LOCAL statement_timeout = '10min'");
      await tx.executeScript("SET LOCAL work_mem = '256MB'");
      await tx.executeScript("SET LOCAL enable_nestloop = off");
      const lock = await tx.query("SELECT pg_try_advisory_xact_lock(1557337991) AS acquired");
      if (!lock.rows[0]?.acquired) {
        const error = new Error("已有产品包同步正在执行，请稍后重试。");
        error.code = "PRODUCT_PACKAGE_SYNC_BUSY";
        error.status = 409;
        throw error;
      }
      await tx.query("SELECT set_config('commerce_ops.product_package_sync_run_id',$1,true)", [runId]);
      await this.clearStage(tx, runId);

      const stage = async (rows) => {
        for (let offset = 0; offset < rows.length; offset += 250) {
          const chunk = rows.slice(offset, offset + 250);
          const values = [];
          const groups = chunk.map((row) => {
            const p = this.placeholders(tx, STAGE_COLUMNS.length + 1, values.length);
            values.push(runId, ...stageValues(row));
            return `(${p.join(",")})`;
          });
          await tx.execute(
            `INSERT INTO ${this.table("product_package_sync_stage_source")} (run_id,${STAGE_COLUMNS.join(",")}) VALUES ${groups.join(",")}`,
            values,
          );
        }
      };
      const loaded = await loadRows(stage);
      const sourceCount = number((await tx.query("SELECT COUNT(*) AS total FROM tmp_product_package_source")).rows[0]?.total);
      if (!loaded?.snapshot?.sha256 || sourceCount !== number(loaded?.snapshot?.rowCount)) {
        const error = new Error("产品包暂存结果与源快照不一致。");
        error.code = "PRODUCT_PACKAGE_STAGE_VALIDATION_FAILED";
        throw error;
      }
      const localBefore = number((await tx.query(
        `SELECT COUNT(*) AS total FROM ${this.table("product_package_rows")} WHERE source_system=${tx.placeholder(1)}`,
        [PRODUCT_PACKAGE_SOURCE_SYSTEM],
      )).rows[0]?.total);
      if (localBefore === 0) {
        await tx.executeScript("SET LOCAL statement_timeout = '30min'");
      }
      let counts;
      if (localBefore === 0) {
        counts = { newCount: sourceCount, updatedCount: 0, unchangedCount: 0, removedCount: 0 };
      } else {
        const countResult = await tx.query(
          `SELECT
            COUNT(*) FILTER (WHERE old.id IS NULL) AS new_count,
            COUNT(*) FILTER (WHERE old.id IS NOT NULL AND old.source_row_sha256<>fresh.row_sha256) AS updated_count,
            COUNT(*) FILTER (WHERE old.id IS NOT NULL AND old.source_row_sha256=fresh.row_sha256) AS unchanged_count,
            (SELECT COUNT(*) FROM ${this.table("product_package_rows")} missing
              WHERE missing.source_system=${tx.placeholder(1)}
                AND NOT EXISTS (SELECT 1 FROM tmp_product_package_source source WHERE source.source_row_key=missing.source_row_key)) AS removed_count
           FROM tmp_product_package_source fresh
           LEFT JOIN ${this.table("product_package_rows")} old
             ON old.source_system=${tx.placeholder(2)} AND old.source_row_key=fresh.source_row_key`,
          [PRODUCT_PACKAGE_SOURCE_SYSTEM, PRODUCT_PACKAGE_SOURCE_SYSTEM],
        );
        counts = {
          newCount: number(countResult.rows[0]?.new_count),
          updatedCount: number(countResult.rows[0]?.updated_count),
          unchangedCount: number(countResult.rows[0]?.unchanged_count),
          removedCount: number(countResult.rows[0]?.removed_count),
        };
      }
      const removalRatio = localBefore > 0 ? counts.removedCount / localBefore : 0;
      if (!allowLargeRemoval && localBefore > 0 && removalRatio > Math.max(0, Math.min(Number(maxRemovalRatio) || 0.2, 1))) {
        const error = new Error(`源产品包将移除 ${(removalRatio * 100).toFixed(1)}% 的本地行，超过安全阈值，已停止同步。`);
        error.code = "PRODUCT_PACKAGE_REMOVAL_SAFETY_LIMIT";
        error.status = 409;
        throw error;
      }
      if (counts.newCount + counts.updatedCount + counts.removedCount === 0) {
        await this.clearStage(tx, runId);
        return {
          changed: false,
          importBatchId: null,
          sourceCount,
          localBefore,
          localAfter: localBefore,
          fieldChangeCount: 0,
          counts,
          metadata: loaded.metadata,
          snapshot: loaded.snapshot,
        };
      }

      const batchId = runId;
      const mappingJson = mapping.map((item) => ({
        sourceHeader: item.column,
        systemField: item.normalizedField || item.column,
        type: item.type,
        status: "mapped",
      }));
      const summary = {
        source: "AI_Project_A.product_package",
        sourceRowCount: sourceCount,
        fieldCount: PRODUCT_PACKAGE_SOURCE_FIELDS.length,
        sourceCheckedAt: loaded.metadata?.sourceCheckedAt || null,
        sourceTableUpdatedAt: loaded.metadata?.tableUpdatedAt || null,
        sourceMaxUpdatedAt: loaded.metadata?.maxUpdatedAt || null,
        sourceSnapshotSha256: loaded.snapshot.sha256,
        removedCount: counts.removedCount,
        losslessSourceRows: true,
      };
      const batchValues = [
        batchId,
        PRODUCT_PACKAGE_SOURCE_SYSTEM,
        loaded.metadata?.maxUpdatedAt?.slice(0, 7)?.replace("-", "") || null,
        null,
        loaded.snapshot.sha256,
        sha256(stableJson(mappingJson)),
        "applying",
        sourceCount,
        counts.newCount,
        counts.updatedCount,
        counts.unchangedCount,
        0,
        0,
        0,
        counts.newCount + counts.updatedCount,
        0,
        0,
        0,
        JSON.stringify(mappingJson),
        JSON.stringify([]),
        JSON.stringify(summary),
        requestedBy,
        runId,
        1,
        timestamp,
        timestamp,
        counts.removedCount,
      ];
      const batchColumns = [
        "id", "source_system", "source_period", "source_country_raw", "file_sha256", "header_fingerprint",
        "status", "row_count", "new_count", "updated_count", "unchanged_count", "conflict_count",
        "exception_count", "unmatched_count", "will_write_count", "blocker_count", "reminder_count",
        "information_count", "mapping_json", "unknown_fields_json", "validation_summary_json",
        "operator_label", "request_id", "revision", "created_at", "updated_at", "removed_count",
      ];
      const batchPlaceholders = this.placeholders(tx, batchValues.length);
      await tx.execute(
        `INSERT INTO ${this.table("product_import_batches")} (${batchColumns.join(",")})
         VALUES (${batchPlaceholders.join(",")})`,
        batchValues,
      );

      if (localBefore === 0) {
        await tx.executeScript(`INSERT INTO ${this.table("product_package_sync_stage_changed_keys")} (run_id,source_row_key,change_type)
          SELECT '${runId}',source_row_key,'ADDED' FROM tmp_product_package_source`);
        await tx.execute(
          `INSERT INTO ${this.table("product_package_sync_stage_changed_rows")} (
             run_id,source_row_key,change_type,source_row_number,new_row_sha256,old_row_sha256,
             new_product_key,old_product_key,country_code,stock_sku,warehouse_id,warehouse_name,product_name,
             new_raw_payload_json,old_raw_payload_json,new_raw_types_json,old_raw_types_json,
             new_normalized_payload_json,old_normalized_payload_json,old_package_row_id
           ) SELECT ${tx.placeholder(1)},source_row_key,'ADDED',source_row_number,row_sha256,NULL,
             product_key,NULL,country_code,stock_sku,warehouse_id,warehouse_name,product_name,
             NULL,NULL,NULL,NULL,NULL,NULL,NULL
           FROM tmp_product_package_source`,
          [runId],
        );
      } else {
        await tx.executeScript(`INSERT INTO ${this.table("product_package_sync_stage_changed_keys")} (run_id,source_row_key,change_type)
          SELECT '${runId}',fresh.source_row_key,
            CASE WHEN old.id IS NULL THEN 'ADDED' ELSE 'UPDATED' END AS change_type
          FROM tmp_product_package_source fresh
          LEFT JOIN ${this.table("product_package_rows")} old
            ON old.source_system='${PRODUCT_PACKAGE_SOURCE_SYSTEM}' AND old.source_row_key=fresh.source_row_key
          WHERE old.id IS NULL OR old.source_row_sha256<>fresh.row_sha256
          UNION ALL
          SELECT '${runId}',old.source_row_key,'REMOVED'
          FROM ${this.table("product_package_rows")} old
          WHERE old.source_system='${PRODUCT_PACKAGE_SOURCE_SYSTEM}'
            AND NOT EXISTS (SELECT 1 FROM tmp_product_package_source fresh WHERE fresh.source_row_key=old.source_row_key)`);

        await tx.execute(
          `INSERT INTO ${this.table("product_package_sync_stage_changed_rows")} (
             run_id,source_row_key,change_type,source_row_number,new_row_sha256,old_row_sha256,
             new_product_key,old_product_key,country_code,stock_sku,warehouse_id,warehouse_name,product_name,
             new_raw_payload_json,old_raw_payload_json,new_raw_types_json,old_raw_types_json,
             new_normalized_payload_json,old_normalized_payload_json,old_package_row_id
           ) SELECT ${tx.placeholder(1)},keys.source_row_key,keys.change_type,fresh.source_row_number,
             fresh.row_sha256 new_row_sha256,old.source_row_sha256 old_row_sha256,
             fresh.product_key new_product_key,old.product_key old_product_key,
             fresh.country_code,fresh.stock_sku,fresh.warehouse_id,fresh.warehouse_name,fresh.product_name,
             NULL new_raw_payload_json,old.raw_payload_json old_raw_payload_json,
             NULL new_raw_types_json,old.raw_types_json old_raw_types_json,
             NULL new_normalized_payload_json,old.normalized_payload_json old_normalized_payload_json,
             old.id old_package_row_id
           FROM tmp_product_package_changed_keys keys
           LEFT JOIN tmp_product_package_source fresh ON fresh.source_row_key=keys.source_row_key
           LEFT JOIN ${this.table("product_package_rows")} old
             ON old.source_system=${tx.placeholder(3)} AND old.source_row_key=keys.source_row_key
           WHERE keys.change_type<>'REMOVED'
           UNION ALL
           SELECT ${tx.placeholder(1)},keys.source_row_key,keys.change_type,
             ${tx.placeholder(2)} + ROW_NUMBER() OVER (ORDER BY keys.source_row_key),
             NULL,old.source_row_sha256,NULL,old.product_key,NULL,NULL,NULL,NULL,NULL,
             NULL,old.raw_payload_json,NULL,old.raw_types_json,NULL,old.normalized_payload_json,old.id
           FROM tmp_product_package_changed_keys keys
           JOIN ${this.table("product_package_rows")} old
             ON old.source_system=${tx.placeholder(3)} AND old.source_row_key=keys.source_row_key
           WHERE keys.change_type='REMOVED'`,
          [runId, sourceCount + 2, PRODUCT_PACKAGE_SOURCE_SYSTEM],
        );
      }

      const importValues = [batchId, timestamp];
      if (localBefore === 0) {
        await tx.execute(
          `INSERT INTO ${this.table("product_import_rows")} (
            id,batch_id,source_row_number,source_sku,source_country_raw,source_warehouse_raw,
            product_key,source_row_key,row_occurrence,row_sha256,product_sha256,raw_payload_json,
            raw_types_json,normalized_payload_json,validation_codes_json,outcome,target_sku_id,
            package_row_id,applied_at,created_at
           ) SELECT
            md5(${tx.placeholder(1)} || ':' || fresh.source_row_key),${tx.placeholder(1)},fresh.source_row_number,
            fresh.stock_sku,fresh.country_code,fresh.warehouse_name,fresh.product_key,fresh.source_row_key,1,
            fresh.row_sha256,fresh.row_sha256,jsonb_build_object(
              'source_row_key',fresh.source_row_key,'country',fresh.country_code,
              'stock_sku',fresh.stock_sku,'warehouse_id',fresh.warehouse_id,
              'warehouse_name',fresh.warehouse_name,'sales_sku',fresh.sales_sku
            ),'{}'::jsonb,jsonb_build_object(
              'country_raw',fresh.country_code,'sku_code',fresh.stock_sku,
              'warehouse_raw',fresh.warehouse_name,'product_name',fresh.product_name,
              'main_sku_code',fresh.sales_sku,'source_status',fresh.source_status,
              'lifecycle_status',fresh.lifecycle_status
            ),'[]'::jsonb,'new',NULL,NULL,${tx.placeholder(2)},${tx.placeholder(2)}
           FROM tmp_product_package_source fresh`,
          importValues,
        );
      } else {
        await tx.execute(
          `INSERT INTO ${this.table("product_import_rows")} (
          id,batch_id,source_row_number,source_sku,source_country_raw,source_warehouse_raw,
          product_key,source_row_key,row_occurrence,row_sha256,product_sha256,raw_payload_json,
          raw_types_json,normalized_payload_json,validation_codes_json,outcome,target_sku_id,
          package_row_id,applied_at,created_at
         ) SELECT
          md5(${tx.placeholder(1)} || ':' || changed.source_row_key),${tx.placeholder(1)},changed.source_row_number,
          COALESCE(changed.stock_sku,changed.old_normalized_payload_json::jsonb->>'sku_code'),
          COALESCE(changed.country_code,changed.old_normalized_payload_json::jsonb->>'country_raw'),
          COALESCE(changed.warehouse_name,changed.old_normalized_payload_json::jsonb->>'warehouse_raw'),
          COALESCE(changed.new_product_key,changed.old_product_key),changed.source_row_key,1,
          COALESCE(changed.new_row_sha256,changed.old_row_sha256),COALESCE(changed.new_row_sha256,changed.old_row_sha256),
           CASE WHEN fresh.source_row_key IS NOT NULL THEN jsonb_build_object(
             'source_row_key',fresh.source_row_key,'country',fresh.country_code,
             'stock_sku',fresh.stock_sku,'warehouse_id',fresh.warehouse_id,
             'warehouse_name',fresh.warehouse_name,'sales_sku',fresh.sales_sku
           ) ELSE changed.old_raw_payload_json::jsonb END,
           CASE WHEN fresh.source_row_key IS NOT NULL THEN '{}'::jsonb ELSE changed.old_raw_types_json::jsonb END,
           CASE WHEN fresh.source_row_key IS NOT NULL THEN jsonb_build_object(
             'country_raw',fresh.country_code,'sku_code',fresh.stock_sku,
             'warehouse_raw',fresh.warehouse_name,'product_name',fresh.product_name,
             'main_sku_code',fresh.sales_sku,'source_status',fresh.source_status,
             'lifecycle_status',fresh.lifecycle_status
           ) ELSE changed.old_normalized_payload_json::jsonb END,'[]'::jsonb,
          CASE WHEN changed.change_type='ADDED' THEN 'new' ELSE 'updated' END,NULL,
          changed.old_package_row_id,${tx.placeholder(2)},${tx.placeholder(2)}
         FROM tmp_product_package_changed_rows changed
         LEFT JOIN tmp_product_package_source fresh ON fresh.source_row_key=changed.source_row_key`,
          importValues,
        );
      }

      if (localBefore === 0) {
        await tx.executeScript(`INSERT INTO ${this.table("product_package_sync_stage_field_events")} (
          run_id,source_row_key,change_type,field_name,old_value_json,new_value_json,old_type,new_type
        ) SELECT '${runId}',source_row_key,'ADDED','__row__',NULL,NULL,NULL,'object'
          FROM tmp_product_package_source`);
      } else {
        await tx.executeScript(`INSERT INTO ${this.table("product_package_sync_stage_field_events")} (
          run_id,source_row_key,change_type,field_name,old_value_json,new_value_json,old_type,new_type
        ) SELECT '${runId}',changed.source_row_key,changed.change_type,'__row__' field_name,
          CASE WHEN changed.change_type='REMOVED' THEN changed.old_raw_payload_json ELSE NULL END old_value_json,
          NULL new_value_json,
          CASE WHEN changed.change_type='REMOVED' THEN 'object' ELSE NULL END old_type,
          CASE WHEN changed.change_type='ADDED' THEN 'object' ELSE NULL END new_type
        FROM tmp_product_package_changed_rows changed
        LEFT JOIN tmp_product_package_source fresh ON fresh.source_row_key=changed.source_row_key
        WHERE changed.change_type IN ('ADDED','REMOVED')
        UNION ALL
        SELECT '${runId}',changed.source_row_key,changed.change_type,diff.field_name,
          CASE WHEN diff.old_value IS NULL THEN NULL ELSE diff.old_value::text END,
          CASE WHEN diff.new_value IS NULL THEN NULL ELSE diff.new_value::text END,
          jsonb_typeof(diff.old_value),jsonb_typeof(diff.new_value)
        FROM tmp_product_package_changed_rows changed
        JOIN tmp_product_package_source fresh ON fresh.source_row_key=changed.source_row_key
        CROSS JOIN LATERAL (
          SELECT COALESCE(previous.key,current.key) field_name,previous.value old_value,current.value new_value
          FROM jsonb_each(changed.old_raw_payload_json::jsonb) previous
          FULL OUTER JOIN jsonb_each(fresh.raw_payload_json::jsonb) current USING (key)
          WHERE previous.value IS DISTINCT FROM current.value
        ) diff
        WHERE changed.change_type='UPDATED'`);
      }

      const legacyColumns = Object.keys(LEGACY_RAW_COLUMN_MAP);
      const legacyExpressions = legacyColumns.map(() => `'null'::jsonb`);
      const packageColumns = [
        "id", "source_system", "source_row_key", "product_key", "country_normalized", "sku_normalized",
        "warehouse_normalized", "row_occurrence", "source_row_sha256", "semantic_row_sha256",
        "raw_payload_json", "raw_types_json", "normalized_payload_json", ...legacyColumns,
        "import_batch_id", "source_row_number", "first_seen_batch_id", "latest_batch_id",
        "latest_import_row_id", "latest_source_row_number", "revision", "created_at", "updated_at",
      ];
      const mutablePackageColumns = packageColumns.slice(3).filter((column) => !new Set([
        "first_seen_batch_id", "revision", "created_at",
      ]).has(column));
      const packageValues = [PRODUCT_PACKAGE_SOURCE_SYSTEM, batchId, timestamp];
      await tx.execute(
        `INSERT INTO ${this.table("product_package_rows")} AS target (${packageColumns.join(",")})
          SELECT md5('package:' || fresh.source_row_key),${tx.placeholder(1)},fresh.source_row_key,
           fresh.product_key,fresh.country_code,fresh.stock_sku,UPPER(fresh.warehouse_name),1,
           fresh.row_sha256,fresh.row_sha256,fresh.raw_payload_json::jsonb,fresh.raw_types_json::jsonb,
           fresh.normalized_payload_json::jsonb,${legacyExpressions.join(",")},
           ${tx.placeholder(2)},fresh.source_row_number,${tx.placeholder(2)},${tx.placeholder(2)},
            md5(${tx.placeholder(2)} || ':' || fresh.source_row_key),fresh.source_row_number,1,
            ${tx.placeholder(3)},${tx.placeholder(3)}
          FROM tmp_product_package_source fresh
          ${localBefore === 0 ? "" : `JOIN tmp_product_package_changed_keys changed ON changed.source_row_key=fresh.source_row_key
          WHERE changed.change_type IN ('ADDED','UPDATED')`}
          ON CONFLICT (source_system,source_row_key) DO UPDATE SET
           ${mutablePackageColumns.map((column) => `${column}=EXCLUDED.${column}`).join(",")},
           revision=target.revision+1`,
        packageValues,
      );

      if (counts.removedCount > 0) {
        await tx.execute(
          `UPDATE ${this.table("product_import_field_changes")} SET product_package_row_id=NULL
           WHERE product_package_row_id IN (
             SELECT old_package_row_id FROM tmp_product_package_changed_rows WHERE change_type='REMOVED'
           )`,
        );
        await tx.execute(
          `DELETE FROM ${this.table("product_package_rows")}
           WHERE id IN (SELECT old_package_row_id FROM tmp_product_package_changed_rows WHERE change_type='REMOVED')`,
        );
      }
      await tx.execute(
        `UPDATE ${this.table("product_import_rows")} import_row SET package_row_id=package.id
         FROM ${this.table("product_package_rows")} package
         WHERE import_row.batch_id=${tx.placeholder(1)} AND import_row.source_row_key=package.source_row_key`,
        [batchId],
      );

      await tx.executeScript(`INSERT INTO ${this.table("product_package_sync_stage_products")}
        SELECT '${runId}',representative.*,aggregated.product_hash,
          ${localBefore === 0
    ? `md5('${batchId}:' || representative.source_row_key),'${batchId}'`
    : `package.latest_import_row_id,
          CASE WHEN changed.product_key IS NOT NULL THEN '${batchId}' ELSE package.latest_batch_id END`} effective_batch_id
        FROM (
          SELECT DISTINCT ON (source.product_key) source.*
          FROM tmp_product_package_source source
          ORDER BY source.product_key,source.source_updated_at DESC NULLS LAST,source.source_row_key
        ) representative
        JOIN (
          SELECT product_key,md5(string_agg(row_sha256,',' ORDER BY source_row_key)) product_hash
          FROM tmp_product_package_source GROUP BY product_key
        ) aggregated ON aggregated.product_key=representative.product_key
        ${localBefore === 0 ? "" : `JOIN ${this.table("product_package_rows")} package
          ON package.source_system='${PRODUCT_PACKAGE_SOURCE_SYSTEM}' AND package.source_row_key=representative.source_row_key
        LEFT JOIN (
          SELECT DISTINCT COALESCE(new_product_key,old_product_key) product_key
          FROM tmp_product_package_changed_rows
        ) changed ON changed.product_key=representative.product_key`}`);

      await this.projectCatalog(tx, { batchId, timestamp, initial: localBefore === 0 });

      const fieldCodeCase = PRODUCT_PACKAGE_SOURCE_FIELDS
        .filter((item) => item.normalizedField)
        .map((item) => `WHEN '${item.column.replaceAll("'", "''")}' THEN '${item.normalizedField.replaceAll("'", "''")}'`)
        .join(" ");
      if (localBefore === 0) {
        await tx.execute(
          `INSERT INTO ${this.table("product_import_field_changes")} (
            id,import_batch_id,import_row_id,product_package_row_id,source_row_number,country_raw,
            sku_code,warehouse_raw,chinese_name,source_header,field_name,old_value_json,new_value_json,
            old_type,new_type,has_manual_override,changed_at,created_at,updated_at
           ) SELECT md5(${tx.placeholder(1)} || ':' || fresh.source_row_key || ':__row__'),${tx.placeholder(1)},
            md5(${tx.placeholder(1)} || ':' || fresh.source_row_key),md5('package:' || fresh.source_row_key),
            fresh.source_row_number,fresh.country_code,fresh.stock_sku,fresh.warehouse_name,fresh.product_name,
            '__row__','__row__',NULL,jsonb_build_object(
              'country',fresh.country_code,'stock_sku',fresh.stock_sku,
              'warehouse_id',fresh.warehouse_id,'sales_sku',fresh.sales_sku
            ),NULL,'object',0,${tx.placeholder(2)},${tx.placeholder(2)},${tx.placeholder(2)}
           FROM tmp_product_package_source fresh`,
          [batchId, timestamp],
        );
      } else {
        await tx.execute(
          `INSERT INTO ${this.table("product_import_field_changes")} (
          id,import_batch_id,import_row_id,product_package_row_id,source_row_number,country_raw,
          sku_code,warehouse_raw,chinese_name,source_header,field_name,old_value_json,new_value_json,
          old_type,new_type,has_manual_override,changed_at,created_at,updated_at
         ) SELECT
          md5(${tx.placeholder(1)} || ':' || event.source_row_key || ':' || event.field_name),${tx.placeholder(1)},
          import_row.id,package.id,import_row.source_row_number,
          COALESCE(fresh.country_code,changed.old_normalized_payload_json::jsonb->>'country_raw'),
          COALESCE(fresh.stock_sku,changed.old_normalized_payload_json::jsonb->>'sku_code'),
          COALESCE(fresh.warehouse_name,changed.old_normalized_payload_json::jsonb->>'warehouse_raw'),
          COALESCE(fresh.product_name,changed.old_normalized_payload_json::jsonb->>'product_name'),
          event.field_name,event.field_name,event.old_value_json::jsonb,
          CASE WHEN event.field_name='__row__' AND changed.change_type='ADDED' THEN jsonb_build_object(
            'country',fresh.country_code,'stock_sku',fresh.stock_sku,
            'warehouse_id',fresh.warehouse_id,'sales_sku',fresh.sales_sku
          ) ELSE event.new_value_json::jsonb END,event.old_type,event.new_type,
          CASE WHEN EXISTS (
            SELECT 1 FROM ${this.table("product_skus")} sku
            JOIN ${this.table("product_field_overrides")} override_row
              ON override_row.sku_id=sku.id AND override_row.deleted_at IS NULL
            WHERE sku.source_system='${PRODUCT_PACKAGE_SOURCE_SYSTEM}'
              AND sku.normalized_sku=COALESCE(fresh.product_key,changed.old_product_key)
              AND override_row.field_code=(CASE event.field_name ${fieldCodeCase} ELSE event.field_name END)
          ) THEN 1 ELSE 0 END,
          ${tx.placeholder(2)},${tx.placeholder(2)},${tx.placeholder(2)}
         FROM tmp_product_package_field_events event
         JOIN tmp_product_package_changed_rows changed ON changed.source_row_key=event.source_row_key
         JOIN ${this.table("product_import_rows")} import_row
           ON import_row.batch_id=${tx.placeholder(1)} AND import_row.source_row_key=event.source_row_key
         LEFT JOIN tmp_product_package_source fresh ON fresh.source_row_key=event.source_row_key
          LEFT JOIN ${this.table("product_package_rows")} package
            ON package.source_system='${PRODUCT_PACKAGE_SOURCE_SYSTEM}' AND package.source_row_key=event.source_row_key`,
          [batchId, timestamp],
        );
      }

      const fieldChangeCount = number((await tx.query(
        `SELECT COUNT(*) AS total FROM ${this.table("product_import_field_changes")}
         WHERE import_batch_id=${tx.placeholder(1)}`,
        [batchId],
      )).rows[0]?.total);
      await tx.execute(
        `UPDATE ${this.table("product_import_batches")} SET status='applied',applied_at=${tx.placeholder(1)},
          updated_at=${tx.placeholder(1)},information_count=${tx.placeholder(2)},revision=revision+1
         WHERE id=${tx.placeholder(3)}`,
        [timestamp, fieldChangeCount, batchId],
      );
      const localAfter = number((await tx.query(
        `SELECT COUNT(*) AS total FROM ${this.table("product_package_rows")}
         WHERE source_system=${tx.placeholder(1)}`,
        [PRODUCT_PACKAGE_SOURCE_SYSTEM],
      )).rows[0]?.total);
      if (localAfter !== sourceCount) {
        const error = new Error(`产品包写入行数不一致：源端 ${sourceCount}，本地 ${localAfter}`);
        error.code = "PRODUCT_PACKAGE_TARGET_ROW_COUNT_MISMATCH";
        throw error;
      }
      await this.clearStage(tx, runId);
      return {
        changed: true,
        importBatchId: batchId,
        sourceCount,
        localBefore,
        localAfter,
        fieldChangeCount,
        counts,
        metadata: loaded.metadata,
        snapshot: loaded.snapshot,
      };
    });
  }

  async projectCatalog(tx, { batchId, timestamp, initial = false }) {
    const changedProductsJoin = initial ? "" : `JOIN (SELECT DISTINCT COALESCE(new_product_key,old_product_key) product_key
        FROM tmp_product_package_changed_rows) changed ON changed.product_key=product.product_key`;
    const changedSourceJoin = initial ? "" : `JOIN (SELECT DISTINCT COALESCE(new_product_key,old_product_key) product_key
        FROM tmp_product_package_changed_rows) changed ON changed.product_key=source.product_key`;
    await tx.executeScript(`INSERT INTO ${this.table("product_categories")} (
      id,parent_id,parent_key,level,source_system,source_name,normalized_name,status,
      first_seen_batch_id,last_seen_batch_id,created_at,updated_at
    ) SELECT DISTINCT category_l1_id,NULL,'ROOT',1,'${PRODUCT_PACKAGE_SOURCE_SYSTEM}',category_l1,
      LOWER(category_l1),'active','${batchId}','${batchId}',TIMESTAMPTZ '${timestamp}',TIMESTAMPTZ '${timestamp}'
      FROM tmp_product_package_products
    ON CONFLICT (source_system,level,parent_key,normalized_name) DO NOTHING`);

    await tx.executeScript(`INSERT INTO ${this.table("product_categories")} (
      id,parent_id,parent_key,level,source_system,source_name,normalized_name,status,
      first_seen_batch_id,last_seen_batch_id,created_at,updated_at
    ) SELECT DISTINCT category_l2_id,category_l1_id,category_l1_id,2,'${PRODUCT_PACKAGE_SOURCE_SYSTEM}',category_l2,
      LOWER(category_l2),'active','${batchId}','${batchId}',TIMESTAMPTZ '${timestamp}',TIMESTAMPTZ '${timestamp}'
      FROM tmp_product_package_products
    ON CONFLICT (source_system,level,parent_key,normalized_name) DO NOTHING`);

    await tx.executeScript(`INSERT INTO ${this.table("product_models")} AS target (
      id,source_system,source_main_sku,category_id,canonical_name,identity_status,
      first_seen_batch_id,last_seen_batch_id,revision,created_at,updated_at
    ) SELECT DISTINCT ON (model_id) model_id,'${PRODUCT_PACKAGE_SOURCE_SYSTEM}',sales_sku,category_l2_id,
      COALESCE(normalized_payload_json::jsonb->>'style_name',product_name),'confirmed',
      '${batchId}',effective_batch_id,1,TIMESTAMPTZ '${timestamp}',TIMESTAMPTZ '${timestamp}'
      FROM tmp_product_package_products WHERE model_id IS NOT NULL AND COALESCE(sales_sku,'')<>''
      ORDER BY model_id,source_updated_at DESC NULLS LAST,product_key
    ON CONFLICT (source_system,source_main_sku) DO UPDATE SET
      category_id=EXCLUDED.category_id,canonical_name=EXCLUDED.canonical_name,
      last_seen_batch_id=EXCLUDED.last_seen_batch_id,updated_at=EXCLUDED.updated_at,
      revision=target.revision+1
    WHERE (target.category_id,target.canonical_name)
      IS DISTINCT FROM (EXCLUDED.category_id,EXCLUDED.canonical_name)`);

    await tx.executeScript(`INSERT INTO ${this.table("product_skus")} AS target (
      id,source_system,source_sku,normalized_sku,country_raw,sku_code_normalized,category_id,model_id,
      source_product_name,source_main_sku,source_style_code,source_style_name,source_sales_spec,
      source_status_raw,current_source_row_id,first_seen_batch_id,last_seen_batch_id,revision,
      created_at,updated_at,archived_at,deleted_at,deleted_by,delete_reason,restored_at,restored_by
    ) SELECT product_id,'${PRODUCT_PACKAGE_SOURCE_SYSTEM}',stock_sku,product_key,country_code,stock_sku,
      category_l2_id,model_id,product_name,sales_sku,
      normalized_payload_json::jsonb->>'style_code',normalized_payload_json::jsonb->>'style_name',
      normalized_payload_json::jsonb->>'sales_spec',source_status,latest_import_row_id,
      effective_batch_id,effective_batch_id,1,TIMESTAMPTZ '${timestamp}',TIMESTAMPTZ '${timestamp}',NULL,NULL,NULL,NULL,NULL,NULL
      FROM tmp_product_package_products
    ON CONFLICT (source_system,normalized_sku) DO UPDATE SET
      source_sku=EXCLUDED.source_sku,country_raw=EXCLUDED.country_raw,
      sku_code_normalized=EXCLUDED.sku_code_normalized,category_id=EXCLUDED.category_id,
      model_id=EXCLUDED.model_id,source_product_name=EXCLUDED.source_product_name,
      source_main_sku=EXCLUDED.source_main_sku,source_style_code=EXCLUDED.source_style_code,
      source_style_name=EXCLUDED.source_style_name,source_sales_spec=EXCLUDED.source_sales_spec,
      source_status_raw=EXCLUDED.source_status_raw,current_source_row_id=EXCLUDED.current_source_row_id,
      last_seen_batch_id=EXCLUDED.last_seen_batch_id,updated_at=EXCLUDED.updated_at,
      deleted_at=CASE WHEN target.deleted_by='product-package-sync' THEN NULL ELSE target.deleted_at END,
      deleted_by=CASE WHEN target.deleted_by='product-package-sync' THEN NULL ELSE target.deleted_by END,
      delete_reason=CASE WHEN target.deleted_by='product-package-sync' THEN NULL ELSE target.delete_reason END,
      restored_at=CASE WHEN target.deleted_by='product-package-sync' THEN EXCLUDED.updated_at ELSE target.restored_at END,
      restored_by=CASE WHEN target.deleted_by='product-package-sync' THEN 'product-package-sync' ELSE target.restored_by END,
      revision=target.revision+1
    WHERE (target.country_raw,target.sku_code_normalized,target.category_id,target.model_id,
      target.source_product_name,target.source_main_sku,target.source_style_code,target.source_style_name,
      target.source_sales_spec,target.source_status_raw,target.current_source_row_id,target.last_seen_batch_id)
      IS DISTINCT FROM (EXCLUDED.country_raw,EXCLUDED.sku_code_normalized,EXCLUDED.category_id,
        EXCLUDED.model_id,EXCLUDED.source_product_name,EXCLUDED.source_main_sku,EXCLUDED.source_style_code,
        EXCLUDED.source_style_name,EXCLUDED.source_sales_spec,EXCLUDED.source_status_raw,
        EXCLUDED.current_source_row_id,EXCLUDED.last_seen_batch_id)
      OR target.deleted_by='product-package-sync'`);

    await tx.executeScript(`UPDATE ${this.table("product_skus")} sku SET
      deleted_at=TIMESTAMPTZ '${timestamp}',deleted_by='product-package-sync',delete_reason='SOURCE_ROW_REMOVED',
      updated_at=TIMESTAMPTZ '${timestamp}',revision=revision+1
    WHERE sku.source_system='${PRODUCT_PACKAGE_SOURCE_SYSTEM}' AND sku.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM tmp_product_package_products current WHERE current.product_key=sku.normalized_sku)`);

    await tx.executeScript(`INSERT INTO ${this.table("product_package_sync_stage_lifecycle")}
      SELECT '${batchId}',sku.id sku_id,lifecycle.status_code previous_status,product.lifecycle_status next_status,
        product.lifecycle_reason_code reason_code,product.source_status,product.effective_batch_id
      FROM tmp_product_package_products product
      JOIN ${this.table("product_skus")} sku
        ON sku.source_system='${PRODUCT_PACKAGE_SOURCE_SYSTEM}' AND sku.normalized_sku=product.product_key
      LEFT JOIN ${this.table("product_sku_lifecycle")} lifecycle ON lifecycle.sku_id=sku.id
      WHERE lifecycle.status_code IS DISTINCT FROM product.lifecycle_status`);

    await tx.executeScript(`INSERT INTO ${this.table("product_sku_lifecycle_events")} (
      id,sku_id,from_status_code,to_status_code,decision_source,source_batch_id,reason_code,
      operator_label,request_id,occurred_at
    ) SELECT md5('${batchId}:' || sku_id || ':lifecycle'),sku_id,previous_status,next_status,'central',
      effective_batch_id,reason_code,'product-package-sync','${batchId}',TIMESTAMPTZ '${timestamp}'
      FROM tmp_product_package_lifecycle_changes`);

    await tx.executeScript(`INSERT INTO ${this.table("product_sku_lifecycle")} AS target (
      sku_id,status_code,revision,decision_source,source_status_raw,source_batch_id,reason_code,
      operator_label,request_id,effective_at,updated_at
    ) SELECT sku.id,product.lifecycle_status,1,'central',product.source_status,product.effective_batch_id,
      product.lifecycle_reason_code,'product-package-sync','${batchId}',TIMESTAMPTZ '${timestamp}',TIMESTAMPTZ '${timestamp}'
      FROM tmp_product_package_products product
      JOIN ${this.table("product_skus")} sku
        ON sku.source_system='${PRODUCT_PACKAGE_SOURCE_SYSTEM}' AND sku.normalized_sku=product.product_key
    ON CONFLICT (sku_id) DO UPDATE SET
      status_code=EXCLUDED.status_code,decision_source='central',source_status_raw=EXCLUDED.source_status_raw,
      source_batch_id=EXCLUDED.source_batch_id,reason_code=EXCLUDED.reason_code,
      operator_label=EXCLUDED.operator_label,request_id=EXCLUDED.request_id,
      effective_at=EXCLUDED.effective_at,updated_at=EXCLUDED.updated_at,
      revision=target.revision+1
    WHERE (target.status_code,target.source_status_raw)
      IS DISTINCT FROM (EXCLUDED.status_code,EXCLUDED.source_status_raw)`);

    await tx.executeScript(`INSERT INTO ${this.table("product_packaging_profiles")} (
      sku_id,source_row_id,item_dimensions_raw,item_net_weight_g,item_gross_weight_g,
      carton_length_cm,carton_width_cm,carton_height_cm,carton_quantity,shipping_method,updated_at
    ) SELECT sku.id,product.latest_import_row_id,product.normalized_payload_json::jsonb->>'item_dimensions_raw',
      NULLIF(product.normalized_payload_json::jsonb->>'item_net_weight_g','')::numeric,
      NULLIF(product.normalized_payload_json::jsonb->>'item_gross_weight_g','')::numeric,
      NULLIF(product.normalized_payload_json::jsonb->>'carton_length_cm','')::numeric,
      NULLIF(product.normalized_payload_json::jsonb->>'carton_width_cm','')::numeric,
      NULLIF(product.normalized_payload_json::jsonb->>'carton_height_cm','')::numeric,
      NULLIF(product.normalized_payload_json::jsonb->>'carton_quantity','')::integer,
      product.normalized_payload_json::jsonb->>'shipping_method',TIMESTAMPTZ '${timestamp}'
      FROM tmp_product_package_products product
      JOIN ${this.table("product_skus")} sku
        ON sku.source_system='${PRODUCT_PACKAGE_SOURCE_SYSTEM}' AND sku.normalized_sku=product.product_key
      ${changedProductsJoin}
    ON CONFLICT (sku_id) DO UPDATE SET source_row_id=EXCLUDED.source_row_id,
      item_dimensions_raw=EXCLUDED.item_dimensions_raw,item_net_weight_g=EXCLUDED.item_net_weight_g,
      item_gross_weight_g=EXCLUDED.item_gross_weight_g,carton_length_cm=EXCLUDED.carton_length_cm,
      carton_width_cm=EXCLUDED.carton_width_cm,carton_height_cm=EXCLUDED.carton_height_cm,
      carton_quantity=EXCLUDED.carton_quantity,shipping_method=EXCLUDED.shipping_method,updated_at=EXCLUDED.updated_at`);

    await tx.executeScript(`INSERT INTO ${this.table("product_cost_snapshots")} (
      id,sku_id,batch_id,country_raw,cost_cny,exchange_rate,exchange_direction,cost_local,
      price_tier_20,price_tier_25,price_tier_35,price_tier_45,attach_rate,created_at
    ) SELECT md5('${batchId}:' || sku.id || ':cost'),sku.id,'${batchId}',product.country_code,
      NULLIF(product.normalized_payload_json::jsonb->>'cost_cny','')::numeric,
      NULLIF(product.normalized_payload_json::jsonb->>'exchange_rate','')::numeric,
      product.normalized_payload_json::jsonb->>'exchange_direction',
      NULLIF(product.normalized_payload_json::jsonb->>'cost_local','')::numeric,
      NULL,NULL,NULL,NULL,NULLIF(product.normalized_payload_json::jsonb->>'attach_rate','')::numeric,TIMESTAMPTZ '${timestamp}'
      FROM tmp_product_package_products product
      JOIN ${this.table("product_skus")} sku
        ON sku.source_system='${PRODUCT_PACKAGE_SOURCE_SYSTEM}' AND sku.normalized_sku=product.product_key
      ${changedProductsJoin}
      WHERE product.normalized_payload_json::jsonb->>'cost_cny' IS NOT NULL
        AND product.normalized_payload_json::jsonb->>'exchange_rate' IS NOT NULL
        AND product.normalized_payload_json::jsonb->>'cost_local' IS NOT NULL
        AND product.normalized_payload_json::jsonb->>'exchange_direction' IS NOT NULL
    ON CONFLICT (sku_id,batch_id) DO UPDATE SET country_raw=EXCLUDED.country_raw,
      cost_cny=EXCLUDED.cost_cny,exchange_rate=EXCLUDED.exchange_rate,
      exchange_direction=EXCLUDED.exchange_direction,cost_local=EXCLUDED.cost_local,
      attach_rate=EXCLUDED.attach_rate,created_at=EXCLUDED.created_at`);

    await tx.executeScript(`INSERT INTO ${this.table("product_inventory_snapshots")} (
      id,sku_id,batch_id,warehouse_raw,warehouse_stock,planned_warehouse_raw,captured_at
    ) SELECT md5('${batchId}:' || sku.id || ':inventory:' || source.warehouse_name),sku.id,'${batchId}',
      source.warehouse_name,SUM(COALESCE(NULLIF(source.normalized_payload_json::jsonb->>'warehouse_stock','')::numeric,0)),
      NULL,TIMESTAMPTZ '${timestamp}'
      FROM tmp_product_package_source source
      ${changedSourceJoin}
      JOIN ${this.table("product_skus")} sku
        ON sku.source_system='${PRODUCT_PACKAGE_SOURCE_SYSTEM}' AND sku.normalized_sku=source.product_key
      GROUP BY sku.id,source.warehouse_name
    ON CONFLICT (sku_id,batch_id,warehouse_raw) DO UPDATE SET
      warehouse_stock=EXCLUDED.warehouse_stock,planned_warehouse_raw=NULL,captured_at=EXCLUDED.captured_at`);

    await tx.executeScript(`UPDATE ${this.table("product_import_rows")} import_row SET target_sku_id=sku.id
      FROM ${this.table("product_skus")} sku
      WHERE import_row.batch_id='${batchId}' AND sku.source_system='${PRODUCT_PACKAGE_SOURCE_SYSTEM}'
        AND sku.normalized_sku=import_row.product_key`);
  }
}
