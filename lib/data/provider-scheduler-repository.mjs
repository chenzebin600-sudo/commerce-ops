import { randomUUID } from "node:crypto";
import { assertDatabaseProvider, DATABASE_DIALECTS } from "./database-provider.mjs";
import { createPortableRepositoryExecutor } from "./portable-repository-executor.mjs";
import { createRepositorySql } from "./repository-sql.mjs";
import { ProviderExportFileRepository } from "../files/provider-export-file-repository.mjs";
import { maskUsername } from "../mabang-scheduler/crypto.mjs";
import {
  assertTaskAccountAvailable,
  assertTaskNotDeleted,
  sanitizeDeletedBy,
} from "../mabang-scheduler/task-state.mjs";

function iso(value = new Date()) {
  return value instanceof Date ? value.toISOString() : String(value);
}

function parseJson(value, fallback) {
  if (value && typeof value === "object") return value;
  try { return JSON.parse(value || ""); } catch { return fallback; }
}

function bool(value) {
  if (typeof value === "boolean") return value;
  return Boolean(Number(value));
}

function serializeTask(row) {
  if (!row) return null;
  return {
    id: row.id, taskType: row.task_type, name: row.name, description: row.description || "",
    accountProfileId: row.account_profile_id, accountName: row.account_name || "",
    accountUsernameMasked: row.account_username ? maskUsername(row.account_username) : "",
    accountAvailable: Boolean(row.account_profile_found), accountEnabled: bool(row.account_enabled),
    dingtalkConfigId: row.dingtalk_config_id || null, dingtalkName: row.dingtalk_name || "",
    scheduleType: row.schedule_type, scheduleConfig: parseJson(row.schedule_config_json, {}),
    timezone: row.timezone, paymentDateMode: row.payment_date_mode,
    paymentDateConfig: parseJson(row.payment_date_config_json, {}), filters: parseJson(row.filters_json, []),
    enabled: bool(row.enabled), fileRetentionDays: row.file_retention_days === null ? "forever" : Number(row.file_retention_days),
    notifyEnabled: bool(row.notify_enabled), catchUpEnabled: bool(row.catch_up_enabled),
    lastRunAt: row.last_run_at || null, lastRunStatus: row.last_run_status || null,
    nextRunAt: row.next_run_at || null, deletedAt: row.deleted_at || null, deletedBy: row.deleted_by || null,
    deleteReason: row.delete_reason || null, deleted: Boolean(row.deleted_at),
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function serializeRun(row) {
  if (!row) return null;
  return {
    id: row.id, taskId: row.task_id, taskName: row.task_name || "", taskType: row.task_type || "order_export",
    taskDeleted: Boolean(row.task_deleted_at), triggerType: row.trigger_type,
    scheduledRunAt: row.scheduled_run_at, startedAt: row.started_at || null, finishedAt: row.finished_at || null,
    status: row.status, paymentStartDate: row.payment_start_date || null, paymentEndDate: row.payment_end_date || null,
    rawOrderCount: Number(row.raw_order_count || 0), filteredOrderCount: Number(row.filtered_order_count || 0),
    detailRowCount: Number(row.detail_row_count || 0), exportFileId: row.export_file_id || null,
    fileStatus: row.file_status || null, filename: row.original_filename || null,
    notificationStatus: row.notification_status || null, retryCount: Number(row.retry_count || 0),
    errorStage: row.error_stage || null, errorCode: row.error_code || null, errorMessage: row.error_message || null,
    logSummary: parseJson(row.log_summary_json, {}), createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function uniqueViolation(error) {
  return String(error?.code || "") === "23505" || /UNIQUE constraint failed/i.test(String(error?.message || error));
}

export class ProviderSchedulerRepository {
  constructor({ provider, exportFiles = null }) {
    const resolved = assertDatabaseProvider(provider);
    this.databaseProvider = resolved;
    this.provider = createPortableRepositoryExecutor(resolved);
    this.sql = createRepositorySql(resolved);
    this.exportFiles = exportFiles || new ProviderExportFileRepository({ provider: resolved });
  }

  table(name) { return this.sql.table(name); }
  flag(value) { return Number(Boolean(value)); }
  migrate() { return []; }
  close() {}

  async listAccountProfiles() {
    const result = await this.provider.query(`SELECT * FROM ${this.table("mabang_account_profiles")} ORDER BY created_at DESC`);
    return result.rows.map((row) => ({
      id: row.id, name: row.name, username: row.username, usernameMasked: maskUsername(row.username),
      passwordConfigured: Boolean(row.encrypted_password), enabled: bool(row.enabled),
      lastVerifiedAt: row.last_verified_at || null, lastVerifyStatus: row.last_verify_status || null,
      lastVerifyMessage: row.last_verify_message || null, createdAt: row.created_at, updatedAt: row.updated_at,
    }));
  }

  async getAccountProfile(id, { includeSecret = false } = {}) {
    const result = await this.provider.query(`SELECT * FROM ${this.table("mabang_account_profiles")} WHERE id=?`, [id]);
    const row = result.rows[0];
    if (!row) return null;
    const profile = {
      id: row.id, name: row.name, username: row.username, usernameMasked: maskUsername(row.username),
      passwordConfigured: Boolean(row.encrypted_password), enabled: bool(row.enabled),
      lastVerifiedAt: row.last_verified_at || null, lastVerifyStatus: row.last_verify_status || null,
      lastVerifyMessage: row.last_verify_message || null, createdAt: row.created_at, updatedAt: row.updated_at,
    };
    if (includeSecret) profile.encryptedPassword = row.encrypted_password;
    return profile;
  }

  async findAccountProfileByUsername(username) {
    const result = await this.provider.query(
      `SELECT id FROM ${this.table("mabang_account_profiles")} WHERE username=? ORDER BY updated_at DESC LIMIT 1`,
      [String(username || "").trim()],
    );
    return result.rows[0] ? this.getAccountProfile(result.rows[0].id) : null;
  }

  async saveAccountProfile(input) {
    const now = iso();
    const id = input.id || randomUUID();
    const current = input.id ? await this.getAccountProfile(id, { includeSecret: true }) : null;
    if (current) {
      const values = [input.name, input.username, this.flag(input.enabled !== false), now];
      if (input.encryptedPassword) {
        await this.provider.execute(
          `UPDATE ${this.table("mabang_account_profiles")} SET name=?,username=?,enabled=?,updated_at=?,encrypted_password=? WHERE id=?`,
          [...values, input.encryptedPassword, id],
        );
      } else {
        await this.provider.execute(
          `UPDATE ${this.table("mabang_account_profiles")} SET name=?,username=?,enabled=?,updated_at=? WHERE id=?`,
          [...values, id],
        );
      }
    } else {
      await this.provider.execute(`INSERT INTO ${this.table("mabang_account_profiles")}
        (id,name,username,encrypted_password,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`,
      [id, input.name, input.username, input.encryptedPassword, this.flag(input.enabled !== false), now, now]);
    }
    return this.getAccountProfile(id);
  }

  async updateAccountVerification(id, status, message) {
    const now = iso();
    const result = await this.provider.execute(`UPDATE ${this.table("mabang_account_profiles")}
      SET last_verified_at=?,last_verify_status=?,last_verify_message=?,updated_at=? WHERE id=?`,
    [now, status, String(message || "").slice(0, 500), now, id]);
    return Number(result.rowCount || 0);
  }

  async deleteAccountProfile(id) {
    const result = await this.provider.execute(`DELETE FROM ${this.table("mabang_account_profiles")} WHERE id=?`, [id]);
    return Number(result.rowCount || 0);
  }

  async listDingtalkConfigs() {
    const result = await this.provider.query(`SELECT * FROM ${this.table("dingtalk_robot_configs")} ORDER BY created_at DESC`);
    return result.rows.map((row) => ({
      id: row.id, name: row.name, webhookConfigured: Boolean(row.encrypted_webhook_url),
      secretConfigured: Boolean(row.encrypted_secret), enabled: bool(row.enabled),
      notifyOnSuccess: bool(row.notify_on_success), notifyOnFailure: bool(row.notify_on_failure),
      notifyOnEmpty: bool(row.notify_on_empty), atAll: bool(row.at_all),
      atMobiles: parseJson(row.at_mobiles_json, []), createdAt: row.created_at, updatedAt: row.updated_at,
    }));
  }

  async getDingtalkConfig(id, { includeSecret = false } = {}) {
    const result = await this.provider.query(`SELECT * FROM ${this.table("dingtalk_robot_configs")} WHERE id=?`, [id]);
    const row = result.rows[0];
    if (!row) return null;
    const config = {
      id: row.id, name: row.name, webhookConfigured: Boolean(row.encrypted_webhook_url),
      secretConfigured: Boolean(row.encrypted_secret), enabled: bool(row.enabled),
      notifyOnSuccess: bool(row.notify_on_success), notifyOnFailure: bool(row.notify_on_failure),
      notifyOnEmpty: bool(row.notify_on_empty), atAll: bool(row.at_all),
      atMobiles: parseJson(row.at_mobiles_json, []), createdAt: row.created_at, updatedAt: row.updated_at,
    };
    if (includeSecret) {
      config.encryptedWebhookUrl = row.encrypted_webhook_url;
      config.encryptedSecret = row.encrypted_secret || "";
    }
    return config;
  }

  async saveDingtalkConfig(input) {
    const now = iso();
    const id = input.id || randomUUID();
    const current = input.id ? await this.getDingtalkConfig(id, { includeSecret: true }) : null;
    const values = [
      input.name, this.flag(input.enabled !== false), this.flag(input.notifyOnSuccess !== false),
      this.flag(input.notifyOnFailure !== false), this.flag(input.notifyOnEmpty !== false),
      this.flag(Boolean(input.atAll)), JSON.stringify(input.atMobiles || []), now,
    ];
    if (current) {
      if (input.encryptedWebhookUrl) {
        await this.provider.execute(`UPDATE ${this.table("dingtalk_robot_configs")} SET
          name=?,enabled=?,notify_on_success=?,notify_on_failure=?,notify_on_empty=?,at_all=?,at_mobiles_json=?,updated_at=?,
          encrypted_webhook_url=?,encrypted_secret=? WHERE id=?`,
        [...values, input.encryptedWebhookUrl, input.encryptedSecret || "", id]);
      } else {
        await this.provider.execute(`UPDATE ${this.table("dingtalk_robot_configs")} SET
          name=?,enabled=?,notify_on_success=?,notify_on_failure=?,notify_on_empty=?,at_all=?,at_mobiles_json=?,updated_at=? WHERE id=?`,
        [...values, id]);
      }
    } else {
      await this.provider.execute(`INSERT INTO ${this.table("dingtalk_robot_configs")}
        (id,name,encrypted_webhook_url,encrypted_secret,enabled,notify_on_success,notify_on_failure,notify_on_empty,at_all,at_mobiles_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [
        id, input.name, input.encryptedWebhookUrl, input.encryptedSecret || "", ...values.slice(1, 7), now, now,
      ]);
    }
    return this.getDingtalkConfig(id);
  }

  async deleteDingtalkConfig(id) {
    const result = await this.provider.execute(`DELETE FROM ${this.table("dingtalk_robot_configs")} WHERE id=?`, [id]);
    return Number(result.rowCount || 0);
  }

  taskSelect(where = "") {
    return `SELECT t.*,a.name account_name,a.username account_username,d.name dingtalk_name,
      a.id account_profile_found,a.enabled account_enabled
      FROM ${this.table("scheduled_export_tasks")} t
      LEFT JOIN ${this.table("mabang_account_profiles")} a ON a.id=t.account_profile_id
      LEFT JOIN ${this.table("dingtalk_robot_configs")} d ON d.id=t.dingtalk_config_id ${where}`;
  }

  async listTasks({ includeDeleted = false } = {}) {
    const where = includeDeleted ? "" : "WHERE t.deleted_at IS NULL";
    const result = await this.provider.query(`${this.taskSelect(where)} ORDER BY t.created_at DESC`);
    return result.rows.map(serializeTask);
  }

  async getTask(id) {
    const result = await this.provider.query(this.taskSelect("WHERE t.id=?"), [id]);
    return serializeTask(result.rows[0]);
  }

  async saveTask(input) {
    const now = iso();
    const id = input.id || randomUUID();
    const current = input.id ? await this.getTask(id) : null;
    const values = [
      input.taskType || "order_export", input.name, input.description || "", input.accountProfileId,
      input.dingtalkConfigId || null, input.scheduleType, JSON.stringify(input.scheduleConfig), input.timezone,
      input.paymentDateMode, JSON.stringify(input.paymentDateConfig || {}), JSON.stringify(input.filters || []),
      this.flag(input.enabled !== false), input.fileRetentionDays === "forever" ? null : Number(input.fileRetentionDays || 30),
      this.flag(input.notifyEnabled !== false), this.flag(input.catchUpEnabled !== false), input.nextRunAt || null, now,
    ];
    if (current) {
      assertTaskNotDeleted(current);
      await this.provider.execute(`UPDATE ${this.table("scheduled_export_tasks")} SET
        task_type=?,name=?,description=?,account_profile_id=?,dingtalk_config_id=?,schedule_type=?,schedule_config_json=?,timezone=?,
        payment_date_mode=?,payment_date_config_json=?,filters_json=?,enabled=?,file_retention_days=?,notify_enabled=?,catch_up_enabled=?,next_run_at=?,updated_at=? WHERE id=?`,
      [...values, id]);
    } else {
      await this.provider.execute(`INSERT INTO ${this.table("scheduled_export_tasks")}
        (id,task_type,name,description,account_profile_id,dingtalk_config_id,schedule_type,schedule_config_json,timezone,payment_date_mode,
         payment_date_config_json,filters_json,enabled,file_retention_days,notify_enabled,catch_up_enabled,next_run_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, ...values.slice(0, -1), now, now]);
    }
    return this.getTask(id);
  }

  async setTaskEnabled(id, enabled, nextRunAt = null) {
    const task = assertTaskNotDeleted(await this.getTask(id));
    if (enabled) assertTaskAccountAvailable(task);
    await this.provider.execute(`UPDATE ${this.table("scheduled_export_tasks")}
      SET enabled=?,next_run_at=?,updated_at=? WHERE id=? AND deleted_at IS NULL`,
    [this.flag(enabled), nextRunAt, iso(), id]);
    return this.getTask(id);
  }

  async updateTaskScheduleState(id, { nextRunAt, lastRunAt, lastRunStatus }) {
    const result = await this.provider.execute(`UPDATE ${this.table("scheduled_export_tasks")} SET
      next_run_at=COALESCE(?,next_run_at),last_run_at=COALESCE(?,last_run_at),
      last_run_status=COALESCE(?,last_run_status),updated_at=? WHERE id=? AND deleted_at IS NULL`,
    [nextRunAt ?? null, lastRunAt ?? null, lastRunStatus ?? null, iso(), id]);
    return Number(result.rowCount || 0);
  }

  async softDeleteTask(id, { deletedBy = "local_session", deleteReason = null, now = new Date() } = {}) {
    const outcome = await this.provider.transaction(async (tx) => {
      const found = await tx.query(`SELECT deleted_at FROM ${this.table("scheduled_export_tasks")} WHERE id=?`, [id]);
      const current = found.rows[0];
      if (!current) return null;
      if (current.deleted_at) return { alreadyDeleted: true };
      const deletedAt = iso(now);
      await tx.execute(`UPDATE ${this.table("scheduled_export_tasks")} SET
        enabled=?,next_run_at=NULL,deleted_at=?,deleted_by=?,delete_reason=?,updated_at=?
        WHERE id=? AND deleted_at IS NULL`,
      [this.flag(false), deletedAt, sanitizeDeletedBy(deletedBy), deleteReason || null, deletedAt, id]);
      return { alreadyDeleted: false };
    });
    return outcome ? { ...outcome, task: await this.getTask(id) } : null;
  }

  async restoreTask(id, { now = new Date() } = {}) {
    const outcome = await this.provider.transaction(async (tx) => {
      const found = await tx.query(`SELECT deleted_at FROM ${this.table("scheduled_export_tasks")} WHERE id=?`, [id]);
      const current = found.rows[0];
      if (!current) return null;
      if (!current.deleted_at) return { alreadyRestored: true };
      await tx.execute(`UPDATE ${this.table("scheduled_export_tasks")} SET
        enabled=?,next_run_at=NULL,deleted_at=NULL,deleted_by=NULL,delete_reason=NULL,updated_at=? WHERE id=?`,
      [this.flag(false), iso(now), id]);
      return { alreadyRestored: false };
    });
    return outcome ? { ...outcome, task: await this.getTask(id) } : null;
  }

  runSelect(where = "") {
    return `SELECT r.*,t.name task_name,t.task_type task_type,t.deleted_at task_deleted_at,
      f.status file_status,f.original_filename
      FROM ${this.table("scheduled_export_runs")} r
      JOIN ${this.table("scheduled_export_tasks")} t ON t.id=r.task_id
      LEFT JOIN ${this.table("export_files")} f ON f.id=r.export_file_id ${where}`;
  }

  async createRun({ taskId, triggerType, scheduledRunAt, status = "pending", errorMessage = null, executionOptions = null }) {
    assertTaskNotDeleted(await this.getTask(taskId));
    const id = randomUUID();
    const now = iso();
    await this.provider.execute(`INSERT INTO ${this.table("scheduled_export_runs")}
      (id,task_id,trigger_type,scheduled_run_at,status,error_message,log_summary_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`,
    [id, taskId, triggerType, iso(scheduledRunAt), status, errorMessage, JSON.stringify(executionOptions ? { executionOptions } : {}), now, now]);
    return this.getRun(id);
  }

  async createRunIfAbsent(input) {
    try { return await this.createRun(input); } catch (error) { if (!uniqueViolation(error)) throw error; return null; }
  }

  async listRuns({ taskId = null, status = null, limit = 100 } = {}) {
    const clauses = [];
    const values = [];
    if (taskId) { clauses.push("r.task_id=?"); values.push(taskId); }
    if (status) { clauses.push("r.status=?"); values.push(status); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
    const result = await this.provider.query(`${this.runSelect(where)} ORDER BY r.created_at DESC LIMIT ?`, [...values, safeLimit]);
    return result.rows.map(serializeRun);
  }

  async getRun(id) {
    const result = await this.provider.query(this.runSelect("WHERE r.id=?"), [id]);
    return serializeRun(result.rows[0]);
  }

  async getActiveRunForTask(taskId) {
    const result = await this.provider.query(this.runSelect(
      "WHERE r.task_id=? AND r.status IN ('pending','running') ORDER BY r.created_at LIMIT 1",
    ), [taskId]);
    return serializeRun(result.rows[0]);
  }

  async getRunDetails(id) {
    const run = await this.getRun(id);
    if (!run) return null;
    const events = await this.provider.query(
      `SELECT * FROM ${this.table("scheduled_export_run_events")} WHERE run_id=? ORDER BY id`, [id],
    );
    run.events = events.rows.map((row) => ({
      id: Number(row.id), stage: row.stage, status: row.status, attempt: Number(row.attempt),
      startedAt: row.started_at, finishedAt: row.finished_at || null,
      durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
      message: row.message || "", errorCode: row.error_code || null,
    }));
    run.task = await this.getTask(run.taskId);
    return run;
  }

  async claimRun(runId) {
    const outcome = await this.provider.transaction(async (tx) => {
      const found = await tx.query(`SELECT * FROM ${this.table("scheduled_export_runs")} WHERE id=?`, [runId]);
      const run = found.rows[0];
      if (!run || run.status !== "pending") return { claimed: false, reason: "not_pending" };
      const taskResult = await tx.query(`SELECT deleted_at FROM ${this.table("scheduled_export_tasks")} WHERE id=?`, [run.task_id]);
      const now = iso();
      if (taskResult.rows[0]?.deleted_at) {
        await tx.execute(`UPDATE ${this.table("scheduled_export_runs")} SET
          status='skipped',finished_at=?,error_stage='task_state',error_code='TASK_DELETED',error_message=?,updated_at=? WHERE id=?`,
        [now, "The scheduled task was deleted before execution.", now, runId]);
        await tx.execute(`INSERT INTO ${this.table("scheduled_export_run_events")}
          (run_id,stage,status,attempt,started_at,finished_at,duration_ms,message,error_code,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [runId, "task_state", "skipped", 1, now, now, 0, "Task deleted before execution.", "TASK_DELETED", now]);
        return { claimed: false, reason: "task_deleted", includeRun: true };
      }
      const active = await tx.query(`SELECT id FROM ${this.table("scheduled_export_runs")}
        WHERE task_id=? AND status='running' AND id<>? LIMIT 1`, [run.task_id, runId]);
      if (active.rows[0]) {
        await tx.execute(`UPDATE ${this.table("scheduled_export_runs")} SET
          status='skipped',finished_at=?,error_stage='lock',error_code='TASK_ALREADY_RUNNING',error_message=?,updated_at=? WHERE id=?`,
        [now, "Another run for this task is already active.", now, runId]);
        return { claimed: false, reason: "already_running" };
      }
      const changed = await tx.execute(`UPDATE ${this.table("scheduled_export_runs")}
        SET status='running',started_at=?,updated_at=? WHERE id=? AND status='pending'`, [now, now, runId]);
      if (Number(changed.rowCount || 0) !== 1) return { claimed: false, reason: "not_pending" };
      return { claimed: true, includeRun: true };
    });
    if (!outcome?.includeRun) return outcome;
    const { includeRun: _includeRun, ...result } = outcome;
    return { ...result, run: await this.getRun(runId) };
  }

  async updateRun(id, fields) {
    const mapping = {
      status: "status", paymentStartDate: "payment_start_date", paymentEndDate: "payment_end_date",
      rawOrderCount: "raw_order_count", filteredOrderCount: "filtered_order_count", detailRowCount: "detail_row_count",
      exportFileId: "export_file_id", notificationStatus: "notification_status", retryCount: "retry_count",
      errorStage: "error_stage", errorCode: "error_code", errorMessage: "error_message",
      logSummary: "log_summary_json", startedAt: "started_at", finishedAt: "finished_at",
    };
    const entries = Object.entries(fields).filter(([key]) => mapping[key]);
    if (!entries.length) return this.getRun(id);
    let currentLog = {};
    if (entries.some(([key]) => key === "logSummary")) {
      const found = await this.provider.query(`SELECT log_summary_json FROM ${this.table("scheduled_export_runs")} WHERE id=?`, [id]);
      currentLog = parseJson(found.rows[0]?.log_summary_json, {});
    }
    const values = entries.map(([key, value]) => key === "logSummary" ? JSON.stringify({ ...currentLog, ...(value || {}) }) : value);
    await this.provider.execute(`UPDATE ${this.table("scheduled_export_runs")} SET
      ${entries.map(([key]) => `${mapping[key]}=?`).join(",")},updated_at=? WHERE id=?`, [...values, iso(), id]);
    return this.getRun(id);
  }

  async touchRun(id, at = new Date()) {
    const result = await this.provider.execute(`UPDATE ${this.table("scheduled_export_runs")}
      SET updated_at=? WHERE id=? AND status='running'`, [iso(at), id]);
    return Number(result.rowCount || 0);
  }

  async pendingRuns(limit = 10) {
    return (await this.listRuns({ status: "pending", limit })).reverse();
  }

  async addRunEvent({ runId, stage, status, attempt = 1, startedAt, finishedAt = null, durationMs = null, message = "", errorCode = null }) {
    const values = [runId, stage, status, attempt, iso(startedAt), finishedAt ? iso(finishedAt) : null,
      durationMs, String(message || "").slice(0, 1000), errorCode, iso()];
    if (this.databaseProvider.dialect === DATABASE_DIALECTS.POSTGRESQL) {
      const result = await this.provider.query(`INSERT INTO ${this.table("scheduled_export_run_events")}
        (run_id,stage,status,attempt,started_at,finished_at,duration_ms,message,error_code,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id`, values);
      return Number(result.rows[0]?.id || 0);
    }
    const result = await this.provider.execute(`INSERT INTO ${this.table("scheduled_export_run_events")}
      (run_id,stage,status,attempt,started_at,finished_at,duration_ms,message,error_code,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`, values);
    return Number(result.lastInsertRowid || 0);
  }

  async createExportFile(input) {
    const task = input.taskId ? await this.getTask(input.taskId) : null;
    return this.exportFiles.create({
      ...input,
      sourceType: input.sourceType || (task?.taskType === "inventory_export" ? "mabang_scheduled_inventory" : "mabang_scheduled_order"),
    });
  }
  getExportFile(id) { return this.exportFiles.get(id); }
  getExportFileByRequestKey(key) { return this.exportFiles.getByRequestKey(key); }
  listExportFiles(filters = {}) { return this.exportFiles.list(filters); }
  updateExportFileStatus(id, status, options = {}) { return this.exportFiles.updateStatus(id, status, options); }
  expiredFiles(now = new Date()) { return this.exportFiles.listExpired(now); }
  markFileExpired(id) { return this.exportFiles.updateStatus(id, "expired"); }

  async cacheFilterOptions(accountProfileId, records) {
    if (!accountProfileId || !Array.isArray(records) || !records.length) return;
    await this.provider.transaction(async (tx) => {
      for (const record of records.slice(0, 10000)) {
        await tx.execute(`INSERT INTO ${this.table("mabang_filter_option_cache")}
          (account_profile_id,manager,shop_name,platform,region,warehouse,order_status,sku,logistics_channel,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT
          (account_profile_id,manager,shop_name,platform,region,warehouse,order_status,sku,logistics_channel) DO NOTHING`, [
          accountProfileId, record["店长"] || "", record["店铺名"] || "", record["平台"] || "",
          record["所属地区（省/州）"] || "", record["仓库"] || "", record["订单状态"] || "",
          record.SKU || "", record["物流渠道"] || "", iso(),
        ]);
      }
    });
  }

  async filterOptions(accountProfileId) {
    const result = await this.provider.query(`SELECT * FROM ${this.table("mabang_filter_option_cache")}
      WHERE account_profile_id=? ORDER BY manager,shop_name LIMIT 10000`, [accountProfileId]);
    const rows = result.rows;
    const unique = (key) => [...new Set(rows.map((row) => row[key]).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN"));
    return {
      managers: unique("manager"), shops: unique("shop_name"), platforms: unique("platform"),
      regions: unique("region"), warehouses: unique("warehouse"), orderStatuses: unique("order_status"),
      skus: unique("sku"), logisticsChannels: unique("logistics_channel"),
      managerShops: rows.reduce((output, row) => {
        if (!row.manager || !row.shop_name) return output;
        if (!output[row.manager]) output[row.manager] = [];
        if (!output[row.manager].includes(row.shop_name)) output[row.manager].push(row.shop_name);
        return output;
      }, {}),
    };
  }

  async acquireLease(name, ownerId, now = new Date(), leaseMs = 30000) {
    return this.provider.transaction(async (tx) => {
      const result = await tx.query(`SELECT * FROM ${this.table("scheduler_leases")} WHERE name=?`, [name]);
      const current = result.rows[0];
      if (current && current.owner_id !== ownerId && new Date(current.lease_until).getTime() > now.getTime()) return false;
      const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
      await tx.execute(`INSERT INTO ${this.table("scheduler_leases")}(name,owner_id,lease_until,updated_at)
        VALUES (?,?,?,?) ON CONFLICT(name) DO UPDATE SET
        owner_id=excluded.owner_id,lease_until=excluded.lease_until,updated_at=excluded.updated_at`,
      [name, ownerId, leaseUntil, iso(now)]);
      return true;
    });
  }

  async releaseLease(name, ownerId) {
    await this.provider.execute(`DELETE FROM ${this.table("scheduler_leases")} WHERE name=? AND owner_id=?`, [name, ownerId]);
  }

  async schedulerStatus(now = new Date()) {
    const result = await this.provider.query(`SELECT owner_id,lease_until,updated_at FROM ${this.table("scheduler_leases")}
      WHERE name='mabang_scheduler'`);
    const lease = result.rows[0];
    return {
      online: Boolean(lease && new Date(lease.lease_until).getTime() > now.getTime()),
      leaseUntil: lease?.lease_until || null, updatedAt: lease?.updated_at || null,
    };
  }

  async dueTasks(now = new Date()) {
    const result = await this.provider.query(`SELECT id FROM ${this.table("scheduled_export_tasks")}
      WHERE deleted_at IS NULL AND enabled=? AND next_run_at IS NOT NULL AND next_run_at<=? ORDER BY next_run_at`,
    [this.flag(true), iso(now)]);
    return Promise.all(result.rows.map((row) => this.getTask(row.id)));
  }

  async recoverStaleRuns(now = new Date(), staleMs = 30 * 60 * 1000) {
    const cutoff = new Date(now.getTime() - staleMs).toISOString();
    const result = await this.provider.execute(`UPDATE ${this.table("scheduled_export_runs")} SET
      status='failed',finished_at=?,error_stage='scheduler',error_code='PROCESS_RESTART',
      error_message='An unfinished run was detected after process restart.',updated_at=?
      WHERE status='running' AND updated_at<?`, [iso(now), iso(now), cutoff]);
    return Number(result.rowCount || 0);
  }
}
