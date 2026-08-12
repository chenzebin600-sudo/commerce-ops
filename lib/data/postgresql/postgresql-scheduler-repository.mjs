import { randomUUID as createRandomUUID } from "node:crypto";
import { maskUsername } from "../../mabang-scheduler/crypto.mjs";
import {
  assertTaskAccountAvailable,
  assertTaskNotDeleted,
  sanitizeDeletedBy,
} from "../../mabang-scheduler/task-state.mjs";

const TABLES = new Set([
  "dingtalk_robot_configs",
  "mabang_filter_option_cache",
  "mabang_account_profiles",
  "scheduled_export_run_events",
  "scheduled_export_runs",
  "scheduled_export_tasks",
  "scheduler_leases",
]);

function iso(value) {
  if (value === null || value === undefined || value === "") return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function accountRow(row, { includeSecret = false } = {}) {
  if (!row) return null;
  const result = {
    id: row.id,
    name: row.name,
    username: row.username,
    usernameMasked: maskUsername(row.username),
    passwordConfigured: Boolean(row.encrypted_password),
    enabled: Boolean(row.enabled),
    lastVerifiedAt: iso(row.last_verified_at),
    lastVerifyStatus: row.last_verify_status || null,
    lastVerifyMessage: row.last_verify_message || null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
  if (includeSecret) result.encryptedPassword = row.encrypted_password;
  return result;
}

function json(value, fallback) {
  if (value && typeof value === "object") return value;
  try { return JSON.parse(value || ""); } catch { return fallback; }
}

function dingtalkRow(row, { includeSecret = false } = {}) {
  if (!row) return null;
  const result = {
    id: row.id,
    name: row.name,
    webhookConfigured: Boolean(row.encrypted_webhook_url),
    secretConfigured: Boolean(row.encrypted_secret),
    enabled: Boolean(row.enabled),
    notifyOnSuccess: Boolean(row.notify_on_success),
    notifyOnFailure: Boolean(row.notify_on_failure),
    notifyOnEmpty: Boolean(row.notify_on_empty),
    atAll: Boolean(row.at_all),
    atMobiles: json(row.at_mobiles_json, []),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
  if (includeSecret) {
    result.encryptedWebhookUrl = row.encrypted_webhook_url;
    result.encryptedSecret = row.encrypted_secret || "";
  }
  return result;
}

function taskRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    taskType: row.task_type || "order_export",
    name: row.name,
    description: row.description || "",
    accountProfileId: row.account_profile_id,
    accountName: row.account_name || "",
    accountUsernameMasked: row.account_username ? maskUsername(row.account_username) : "",
    accountAvailable: Boolean(row.account_profile_found),
    accountEnabled: Boolean(row.account_enabled),
    dingtalkConfigId: row.dingtalk_config_id || null,
    dingtalkName: row.dingtalk_name || "",
    scheduleType: row.schedule_type,
    scheduleConfig: json(row.schedule_config_json, {}),
    timezone: row.timezone,
    paymentDateMode: row.payment_date_mode,
    paymentDateConfig: json(row.payment_date_config_json, {}),
    filters: json(row.filters_json, []),
    enabled: Boolean(row.enabled),
    fileRetentionDays: row.file_retention_days === null ? "forever" : Number(row.file_retention_days),
    notifyEnabled: Boolean(row.notify_enabled),
    catchUpEnabled: Boolean(row.catch_up_enabled),
    lastRunAt: iso(row.last_run_at),
    lastRunStatus: row.last_run_status || null,
    nextRunAt: iso(row.next_run_at),
    deletedAt: iso(row.deleted_at),
    deletedBy: row.deleted_by || null,
    deleteReason: row.delete_reason || null,
    deleted: Boolean(row.deleted_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function runRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    taskId: row.task_id,
    taskName: row.task_name || "",
    taskType: row.task_type || "order_export",
    taskDeleted: Boolean(row.task_deleted_at),
    triggerType: row.trigger_type,
    scheduledRunAt: iso(row.scheduled_run_at),
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    status: row.status,
    paymentStartDate: row.payment_start_date || null,
    paymentEndDate: row.payment_end_date || null,
    rawOrderCount: Number(row.raw_order_count || 0),
    filteredOrderCount: Number(row.filtered_order_count || 0),
    detailRowCount: Number(row.detail_row_count || 0),
    exportFileId: row.export_file_id || null,
    fileStatus: row.file_status || null,
    filename: row.original_filename || null,
    notificationStatus: row.notification_status || null,
    retryCount: Number(row.retry_count || 0),
    errorStage: row.error_stage || null,
    errorCode: row.error_code || null,
    errorMessage: row.error_message || null,
    logSummary: json(row.log_summary_json, {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export class PostgresqlSchedulerRepository {
  constructor({ provider, randomUUID = createRandomUUID, now = () => new Date() }) {
    if (!provider?.query || !provider?.execute) throw new TypeError("PostgreSQL scheduler provider is required");
    this.provider = provider;
    this.randomUUID = randomUUID;
    this.now = now;
    this.schema = provider.config?.schema || "app";
  }

  table(name) {
    if (!TABLES.has(name)) throw new TypeError("PostgreSQL scheduler table is not allowlisted");
    return `"${this.schema}"."${name}"`;
  }

  async listAccountProfiles() {
    const result = await this.provider.query(`SELECT * FROM ${this.table("mabang_account_profiles")} ORDER BY created_at DESC`);
    return result.rows.map((row) => accountRow(row));
  }

  async getAccountProfile(id, { includeSecret = false } = {}) {
    const result = await this.provider.query(`SELECT * FROM ${this.table("mabang_account_profiles")} WHERE id=$1`, [id]);
    return accountRow(result.rows[0], { includeSecret });
  }

  async findAccountProfileByUsername(username) {
    const result = await this.provider.query(`SELECT * FROM ${this.table("mabang_account_profiles")}
      WHERE username=$1 ORDER BY updated_at DESC LIMIT 1`, [String(username || "").trim()]);
    return accountRow(result.rows[0]);
  }

  async saveAccountProfile(input) {
    const id = input.id || this.randomUUID();
    const now = this.now().toISOString();
    const existing = input.id
      ? await this.provider.query(`SELECT id FROM ${this.table("mabang_account_profiles")} WHERE id=$1`, [id])
      : { rows: [] };
    if (existing.rows[0]) {
      if (input.encryptedPassword) {
        await this.provider.execute(`UPDATE ${this.table("mabang_account_profiles")}
          SET name=$1,username=$2,enabled=$3,updated_at=$4,encrypted_password=$5 WHERE id=$6`,
        [input.name, input.username, input.enabled !== false, now, input.encryptedPassword, id]);
      } else {
        await this.provider.execute(`UPDATE ${this.table("mabang_account_profiles")}
          SET name=$1,username=$2,enabled=$3,updated_at=$4 WHERE id=$5`,
        [input.name, input.username, input.enabled !== false, now, id]);
      }
    } else {
      await this.provider.execute(`INSERT INTO ${this.table("mabang_account_profiles")}
        (id,name,username,encrypted_password,enabled,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$6)`,
      [id, input.name, input.username, input.encryptedPassword, input.enabled !== false, now]);
    }
    return this.getAccountProfile(id);
  }

  async updateAccountVerification(id, status, message) {
    const now = this.now().toISOString();
    await this.provider.execute(`UPDATE ${this.table("mabang_account_profiles")}
      SET last_verified_at=$1,last_verify_status=$2,last_verify_message=$3,updated_at=$1 WHERE id=$4`,
    [now, status, String(message || "").slice(0, 500), id]);
  }

  async deleteAccountProfile(id) {
    const result = await this.provider.execute(`DELETE FROM ${this.table("mabang_account_profiles")} WHERE id=$1`, [id]);
    return result.rowCount;
  }

  async listDingtalkConfigs() {
    const result = await this.provider.query(`SELECT * FROM ${this.table("dingtalk_robot_configs")} ORDER BY created_at DESC`);
    return result.rows.map((row) => dingtalkRow(row));
  }

  async getDingtalkConfig(id, { includeSecret = false } = {}) {
    const result = await this.provider.query(`SELECT * FROM ${this.table("dingtalk_robot_configs")} WHERE id=$1`, [id]);
    return dingtalkRow(result.rows[0], { includeSecret });
  }

  async saveDingtalkConfig(input) {
    const id = input.id || this.randomUUID();
    const now = this.now().toISOString();
    const existing = input.id
      ? await this.provider.query(`SELECT id FROM ${this.table("dingtalk_robot_configs")} WHERE id=$1`, [id])
      : { rows: [] };
    const values = [
      input.name,
      input.enabled !== false,
      input.notifyOnSuccess !== false,
      input.notifyOnFailure !== false,
      input.notifyOnEmpty !== false,
      Boolean(input.atAll),
      JSON.stringify(input.atMobiles || []),
      now,
    ];
    if (existing.rows[0]) {
      if (input.encryptedWebhookUrl) {
        await this.provider.execute(`UPDATE ${this.table("dingtalk_robot_configs")} SET
          name=$1,enabled=$2,notify_on_success=$3,notify_on_failure=$4,notify_on_empty=$5,
          at_all=$6,at_mobiles_json=$7::jsonb,updated_at=$8,encrypted_webhook_url=$9,encrypted_secret=$10 WHERE id=$11`,
        [...values, input.encryptedWebhookUrl, input.encryptedSecret || "", id]);
      } else {
        await this.provider.execute(`UPDATE ${this.table("dingtalk_robot_configs")} SET
          name=$1,enabled=$2,notify_on_success=$3,notify_on_failure=$4,notify_on_empty=$5,
          at_all=$6,at_mobiles_json=$7::jsonb,updated_at=$8 WHERE id=$9`, [...values, id]);
      }
    } else {
      await this.provider.execute(`INSERT INTO ${this.table("dingtalk_robot_configs")}
        (id,name,encrypted_webhook_url,encrypted_secret,enabled,notify_on_success,notify_on_failure,notify_on_empty,at_all,at_mobiles_json,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$11)`, [
        id, input.name, input.encryptedWebhookUrl, input.encryptedSecret || "",
        ...values.slice(1, 7), now,
      ]);
    }
    return this.getDingtalkConfig(id);
  }

  async deleteDingtalkConfig(id) {
    const result = await this.provider.execute(`DELETE FROM ${this.table("dingtalk_robot_configs")} WHERE id=$1`, [id]);
    return result.rowCount;
  }

  taskProjection() {
    return `SELECT t.*,a.name account_name,a.username account_username,d.name dingtalk_name,
      a.id account_profile_found,a.enabled account_enabled
      FROM ${this.table("scheduled_export_tasks")} t
      LEFT JOIN ${this.table("mabang_account_profiles")} a ON a.id=t.account_profile_id
      LEFT JOIN ${this.table("dingtalk_robot_configs")} d ON d.id=t.dingtalk_config_id`;
  }

  async listTasks({ includeDeleted = false } = {}) {
    const result = await this.provider.query(`${this.taskProjection()}
      ${includeDeleted ? "" : "WHERE t.deleted_at IS NULL"} ORDER BY t.created_at DESC`);
    return result.rows.map(taskRow);
  }

  async getTask(id, client = this.provider) {
    const result = await client.query(`${this.taskProjection()} WHERE t.id=$1`, [id]);
    return taskRow(result.rows[0]);
  }

  async saveTask(input) {
    const id = input.id || this.randomUUID();
    const now = this.now().toISOString();
    const existing = input.id
      ? await this.provider.query(`SELECT id,deleted_at FROM ${this.table("scheduled_export_tasks")} WHERE id=$1`, [id])
      : { rows: [] };
    const values = [
      input.taskType || "order_export", input.name, input.description || "", input.accountProfileId,
      input.dingtalkConfigId || null, input.scheduleType, JSON.stringify(input.scheduleConfig || {}), input.timezone,
      input.paymentDateMode, JSON.stringify(input.paymentDateConfig || {}), JSON.stringify(input.filters || []),
      input.enabled !== false, input.fileRetentionDays === "forever" ? null : Number(input.fileRetentionDays || 30),
      input.notifyEnabled !== false, input.catchUpEnabled !== false, input.nextRunAt || null, now,
    ];
    if (existing.rows[0]) {
      assertTaskNotDeleted({ deletedAt: existing.rows[0].deleted_at });
      await this.provider.execute(`UPDATE ${this.table("scheduled_export_tasks")} SET
        task_type=$1,name=$2,description=$3,account_profile_id=$4,dingtalk_config_id=$5,schedule_type=$6,
        schedule_config_json=$7::jsonb,timezone=$8,payment_date_mode=$9,payment_date_config_json=$10::jsonb,
        filters_json=$11::jsonb,enabled=$12,file_retention_days=$13,notify_enabled=$14,catch_up_enabled=$15,
        next_run_at=$16,updated_at=$17 WHERE id=$18`, [...values, id]);
    } else {
      await this.provider.execute(`INSERT INTO ${this.table("scheduled_export_tasks")}
        (id,task_type,name,description,account_profile_id,dingtalk_config_id,schedule_type,schedule_config_json,timezone,
        payment_date_mode,payment_date_config_json,filters_json,enabled,file_retention_days,notify_enabled,catch_up_enabled,
        next_run_at,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11::jsonb,$12::jsonb,$13,$14,$15,$16,$17,$18,$18)`, [id, ...values]);
    }
    return this.getTask(id);
  }

  async setTaskEnabled(id, enabled, nextRunAt = null) {
    const task = assertTaskNotDeleted(await this.getTask(id));
    if (enabled) assertTaskAccountAvailable(task);
    await this.provider.execute(`UPDATE ${this.table("scheduled_export_tasks")}
      SET enabled=$1,next_run_at=$2,updated_at=clock_timestamp() WHERE id=$3 AND deleted_at IS NULL`,
    [Boolean(enabled), nextRunAt, id]);
    return this.getTask(id);
  }

  async updateTaskScheduleState(id, { nextRunAt, lastRunAt, lastRunStatus }) {
    return this.provider.execute(`UPDATE ${this.table("scheduled_export_tasks")} SET
      next_run_at=COALESCE($1,next_run_at),last_run_at=COALESCE($2,last_run_at),
      last_run_status=COALESCE($3,last_run_status),updated_at=clock_timestamp()
      WHERE id=$4 AND deleted_at IS NULL`, [nextRunAt ?? null, lastRunAt ?? null, lastRunStatus ?? null, id]);
  }

  async softDeleteTask(id, { deletedBy = "local_session", deleteReason = null, now = new Date() } = {}) {
    return this.provider.transaction(async (transaction) => {
      const existing = await transaction.query(`SELECT deleted_at FROM ${this.table("scheduled_export_tasks")} WHERE id=$1 FOR UPDATE`, [id]);
      if (!existing.rows[0]) return null;
      if (existing.rows[0].deleted_at) return { task: await this.getTask(id, transaction), alreadyDeleted: true };
      const deletedAt = iso(now);
      await transaction.execute(`UPDATE ${this.table("scheduled_export_tasks")} SET
        enabled=false,next_run_at=NULL,deleted_at=$1,deleted_by=$2,delete_reason=$3,updated_at=$1 WHERE id=$4`,
      [deletedAt, sanitizeDeletedBy(deletedBy), deleteReason || null, id]);
      return { task: await this.getTask(id, transaction), alreadyDeleted: false };
    });
  }

  async restoreTask(id, { now = new Date() } = {}) {
    return this.provider.transaction(async (transaction) => {
      const existing = await transaction.query(`SELECT deleted_at FROM ${this.table("scheduled_export_tasks")} WHERE id=$1 FOR UPDATE`, [id]);
      if (!existing.rows[0]) return null;
      if (!existing.rows[0].deleted_at) return { task: await this.getTask(id, transaction), alreadyRestored: true };
      await transaction.execute(`UPDATE ${this.table("scheduled_export_tasks")} SET
        enabled=false,next_run_at=NULL,deleted_at=NULL,deleted_by=NULL,delete_reason=NULL,updated_at=$1 WHERE id=$2`, [iso(now), id]);
      return { task: await this.getTask(id, transaction), alreadyRestored: false };
    });
  }

  runProjection() {
    return `SELECT r.*,t.name task_name,t.task_type,t.deleted_at task_deleted_at,f.status file_status,f.original_filename
      FROM ${this.table("scheduled_export_runs")} r
      JOIN ${this.table("scheduled_export_tasks")} t ON t.id=r.task_id
      LEFT JOIN "${this.schema}"."export_files" f ON f.id=r.export_file_id`;
  }

  async createRun({ taskId, triggerType, scheduledRunAt, status = "pending", errorMessage = null, executionOptions = null }) {
    assertTaskNotDeleted(await this.getTask(taskId));
    const id = this.randomUUID();
    const now = this.now().toISOString();
    await this.provider.execute(`INSERT INTO ${this.table("scheduled_export_runs")}
      (id,task_id,trigger_type,scheduled_run_at,status,error_message,log_summary_json,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$8)`,
    [id, taskId, triggerType, iso(scheduledRunAt), status, errorMessage, JSON.stringify(executionOptions ? { executionOptions } : {}), now]);
    return this.getRun(id);
  }

  async createRunIfAbsent(input) {
    try { return await this.createRun(input); } catch (error) {
      if (error?.code === "23505") return null;
      throw error;
    }
  }

  async listRuns({ taskId = null, status = null, limit = 100 } = {}) {
    const clauses = [];
    const values = [];
    if (taskId) { values.push(taskId); clauses.push(`r.task_id=$${values.length}`); }
    if (status) { values.push(status); clauses.push(`r.status=$${values.length}`); }
    values.push(Math.max(1, Math.min(Number(limit) || 100, 500)));
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const result = await this.provider.query(`${this.runProjection()} ${where}
      ORDER BY r.created_at DESC LIMIT $${values.length}`, values);
    return result.rows.map(runRow);
  }

  async getRun(id, client = this.provider) {
    const result = await client.query(`${this.runProjection()} WHERE r.id=$1`, [id]);
    return runRow(result.rows[0]);
  }

  async getRunDetails(id) {
    const run = await this.getRun(id);
    if (!run) return null;
    const events = await this.provider.query(`SELECT * FROM ${this.table("scheduled_export_run_events")}
      WHERE run_id=$1 ORDER BY id`, [id]);
    run.events = events.rows.map((row) => ({
      id: Number(row.id), stage: row.stage, status: row.status, attempt: Number(row.attempt),
      startedAt: iso(row.started_at), finishedAt: iso(row.finished_at), durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
      message: row.message || "", errorCode: row.error_code || null,
    }));
    run.task = await this.getTask(run.taskId);
    return run;
  }

  async claimRun(runId) {
    return this.provider.transaction(async (transaction) => {
      const candidate = await transaction.query(`SELECT id,task_id,status FROM ${this.table("scheduled_export_runs")} WHERE id=$1 FOR UPDATE`, [runId]);
      const run = candidate.rows[0];
      if (!run || run.status !== "pending") return { claimed: false, reason: "not_pending" };
      const taskResult = await transaction.query(`SELECT deleted_at FROM ${this.table("scheduled_export_tasks")} WHERE id=$1`, [run.task_id]);
      if (taskResult.rows[0]?.deleted_at) {
        await transaction.execute(`UPDATE ${this.table("scheduled_export_runs")} SET
          status='skipped',finished_at=clock_timestamp(),error_stage='task_state',error_code='TASK_DELETED',
          error_message=$1,updated_at=clock_timestamp() WHERE id=$2`,
        ["该定时任务已删除，不能继续执行。如需使用，请先恢复任务。", runId]);
        await this.addRunEvent({ runId, stage: "task_state", status: "skipped", startedAt: this.now(), finishedAt: this.now(), durationMs: 0, message: "任务在开始执行前已删除，本次运行已跳过。", errorCode: "TASK_DELETED" }, transaction);
        return { claimed: false, reason: "task_deleted", run: await this.getRun(runId, transaction) };
      }
      const active = await transaction.query(`SELECT id FROM ${this.table("scheduled_export_runs")}
        WHERE task_id=$1 AND status='running' AND id<>$2 LIMIT 1`, [run.task_id, runId]);
      if (active.rows[0]) {
        await transaction.execute(`UPDATE ${this.table("scheduled_export_runs")} SET
          status='skipped',finished_at=clock_timestamp(),error_stage='lock',error_code='TASK_ALREADY_RUNNING',
          error_message=$1,updated_at=clock_timestamp() WHERE id=$2`, ["同一任务已有运行中的执行记录，本次已跳过。", runId]);
        return { claimed: false, reason: "already_running" };
      }
      await transaction.execute(`UPDATE ${this.table("scheduled_export_runs")} SET
        status='running',started_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1`, [runId]);
      return { claimed: true, run: await this.getRun(runId, transaction) };
    });
  }

  async updateRun(id, fields) {
    const mapping = {
      status: "status", paymentStartDate: "payment_start_date", paymentEndDate: "payment_end_date",
      rawOrderCount: "raw_order_count", filteredOrderCount: "filtered_order_count", detailRowCount: "detail_row_count",
      exportFileId: "export_file_id", notificationStatus: "notification_status", retryCount: "retry_count",
      errorStage: "error_stage", errorCode: "error_code", errorMessage: "error_message",
      startedAt: "started_at", finishedAt: "finished_at",
    };
    const entries = Object.entries(fields).filter(([key]) => mapping[key]);
    const values = [];
    const assignments = entries.map(([key, value]) => {
      values.push(value);
      return `${mapping[key]}=$${values.length}`;
    });
    if (Object.hasOwn(fields, "logSummary")) {
      values.push(JSON.stringify(fields.logSummary || {}));
      assignments.push(`log_summary_json=log_summary_json || $${values.length}::jsonb`);
    }
    if (!assignments.length) return this.getRun(id);
    values.push(id);
    await this.provider.execute(`UPDATE ${this.table("scheduled_export_runs")} SET
      ${assignments.join(",")},updated_at=clock_timestamp() WHERE id=$${values.length}`, values);
    return this.getRun(id);
  }

  async pendingRuns(limit = 10) {
    return (await this.listRuns({ status: "pending", limit })).reverse();
  }

  async addRunEvent({ runId, stage, status, attempt = 1, startedAt, finishedAt = null, durationMs = null, message = "", errorCode = null }, client = this.provider) {
    const result = await client.query(`INSERT INTO ${this.table("scheduled_export_run_events")}
      (run_id,stage,status,attempt,started_at,finished_at,duration_ms,message,error_code,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp()) RETURNING id`, [
      runId, stage, status, attempt, iso(startedAt), iso(finishedAt), durationMs, String(message || "").slice(0, 1000), errorCode,
    ]);
    return Number(result.rows[0]?.id);
  }

  async dueTasks(now = new Date()) {
    const result = await this.provider.query(`${this.taskProjection()}
      WHERE t.deleted_at IS NULL AND t.enabled=true AND t.next_run_at IS NOT NULL AND t.next_run_at<=$1
      ORDER BY t.next_run_at`, [iso(now)]);
    return result.rows.map(taskRow);
  }

  async recoverStaleRuns(now = new Date(), staleMs = 30 * 60 * 1000) {
    const cutoff = new Date(now.getTime() - staleMs).toISOString();
    const result = await this.provider.execute(`UPDATE ${this.table("scheduled_export_runs")} SET
      status='failed',finished_at=$1,error_stage='scheduler',error_code='PROCESS_RESTART',
      error_message='服务重启时检测到未完成任务。',updated_at=$1 WHERE status='running' AND started_at<$2`, [iso(now), cutoff]);
    return result.rowCount;
  }

  async cacheFilterOptions(accountProfileId, records) {
    if (!accountProfileId || !Array.isArray(records) || !records.length) return;
    await this.provider.transaction(async (transaction) => {
      for (const record of records.slice(0, 10_000)) {
        await transaction.execute(`INSERT INTO ${this.table("mabang_filter_option_cache")}
          (account_profile_id,manager,shop_name,platform,region,warehouse,order_status,sku,logistics_channel,updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp()) ON CONFLICT DO NOTHING`, [
          accountProfileId, record["店长"] || "", record["店铺名"] || "", record["平台"] || "",
          record["所属地区（省/州）"] || "", record["仓库"] || "", record["订单状态"] || "",
          record.SKU || "", record["物流渠道"] || "",
        ]);
      }
    });
  }

  async filterOptions(accountProfileId) {
    const result = await this.provider.query(`SELECT * FROM ${this.table("mabang_filter_option_cache")}
      WHERE account_profile_id=$1 ORDER BY manager,shop_name LIMIT 10000`, [accountProfileId]);
    const rows = result.rows;
    const unique = (key) => [...new Set(rows.map((row) => row[key]).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN"));
    return {
      managers: unique("manager"), shops: unique("shop_name"), platforms: unique("platform"), regions: unique("region"),
      warehouses: unique("warehouse"), orderStatuses: unique("order_status"), skus: unique("sku"), logisticsChannels: unique("logistics_channel"),
      managerShops: rows.reduce((grouped, row) => {
        if (!row.manager || !row.shop_name) return grouped;
        if (!grouped[row.manager]) grouped[row.manager] = [];
        if (!grouped[row.manager].includes(row.shop_name)) grouped[row.manager].push(row.shop_name);
        return grouped;
      }, {}),
    };
  }

  async acquireLease(name, ownerId, _now = new Date(), leaseMs = 30_000) {
    const result = await this.provider.query(`INSERT INTO ${this.table("scheduler_leases")}
      (name,owner_id,lease_until,updated_at)
      VALUES ($1,$2,clock_timestamp()+($3::bigint * interval '1 millisecond'),clock_timestamp())
      ON CONFLICT ("name") DO UPDATE
      SET owner_id=EXCLUDED.owner_id,lease_until=EXCLUDED.lease_until,updated_at=clock_timestamp()
      WHERE ${this.table("scheduler_leases")}.owner_id=EXCLUDED.owner_id
         OR ${this.table("scheduler_leases")}.lease_until<=clock_timestamp()
      RETURNING "name"`, [name, ownerId, leaseMs]);
    return result.rowCount === 1;
  }

  async releaseLease(name, ownerId) {
    await this.provider.execute(`DELETE FROM ${this.table("scheduler_leases")} WHERE name=$1 AND owner_id=$2`, [name, ownerId]);
  }

  async schedulerStatus() {
    const result = await this.provider.query(`SELECT lease_until>clock_timestamp() AS online,lease_until,updated_at
      FROM ${this.table("scheduler_leases")} WHERE name='mabang_scheduler'`);
    const lease = result.rows[0];
    return {
      online: Boolean(lease?.online),
      leaseUntil: iso(lease?.lease_until),
      updatedAt: iso(lease?.updated_at),
    };
  }
}
