import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { ExportFileRepository } from "../files/file-repository.mjs";
import { maskUsername } from "./crypto.mjs";
import {
  assertTaskAccountAvailable,
  assertTaskNotDeleted,
  sanitizeDeletedBy,
} from "./task-state.mjs";

function iso(value = new Date()) {
  return value instanceof Date ? value.toISOString() : String(value);
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value || "");
  } catch {
    return fallback;
  }
}

function bool(value) {
  return Boolean(Number(value));
}

function serializeTask(row) {
  if (!row) return null;
  return {
    id: row.id,
    taskType: row.task_type,
    name: row.name,
    description: row.description || "",
    accountProfileId: row.account_profile_id,
    accountName: row.account_name || "",
    accountUsernameMasked: row.account_username ? maskUsername(row.account_username) : "",
    accountAvailable: Boolean(row.account_profile_found),
    accountEnabled: bool(row.account_enabled),
    dingtalkConfigId: row.dingtalk_config_id || null,
    dingtalkName: row.dingtalk_name || "",
    scheduleType: row.schedule_type,
    scheduleConfig: parseJson(row.schedule_config_json, {}),
    timezone: row.timezone,
    paymentDateMode: row.payment_date_mode,
    paymentDateConfig: parseJson(row.payment_date_config_json, {}),
    filters: parseJson(row.filters_json, []),
    enabled: bool(row.enabled),
    fileRetentionDays: row.file_retention_days === null ? "forever" : Number(row.file_retention_days),
    notifyEnabled: bool(row.notify_enabled),
    catchUpEnabled: bool(row.catch_up_enabled),
    lastRunAt: row.last_run_at || null,
    lastRunStatus: row.last_run_status || null,
    nextRunAt: row.next_run_at || null,
    deletedAt: row.deleted_at || null,
    deletedBy: row.deleted_by || null,
    deleteReason: row.delete_reason || null,
    deleted: Boolean(row.deleted_at),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    taskId: row.task_id,
    taskName: row.task_name || "",
    taskType: row.task_type || "order_export",
    taskDeleted: Boolean(row.task_deleted_at),
    triggerType: row.trigger_type,
    scheduledRunAt: row.scheduled_run_at,
    startedAt: row.started_at || null,
    finishedAt: row.finished_at || null,
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
    logSummary: parseJson(row.log_summary_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function transaction(db, callback) {
  withSqliteBusyRetry(() => db.exec("BEGIN IMMEDIATE"));
  try {
    const result = callback();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

const SQLITE_BUSY_PATTERN = /database is (?:locked|busy)|SQLITE_BUSY/i;
const SQLITE_RETRY_BUFFER = new Int32Array(new SharedArrayBuffer(4));

function withSqliteBusyRetry(callback, { attempts = 20, delayMs = 100 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return callback();
    } catch (error) {
      lastError = error;
      if (!SQLITE_BUSY_PATTERN.test(String(error?.message || error)) || attempt === attempts) throw error;
      Atomics.wait(SQLITE_RETRY_BUFFER, 0, 0, delayMs);
    }
  }
  throw lastError;
}

export class SchedulerDatabase {
  constructor({ databasePath, migrationsDir }) {
    mkdirSync(path.dirname(databasePath), { recursive: true });
    this.databasePath = databasePath;
    this.migrationsDir = migrationsDir;
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA foreign_keys = ON");
    withSqliteBusyRetry(() => this.db.exec("PRAGMA journal_mode = WAL"));
    this.exportFiles = new ExportFileRepository({ db: this.db });
  }

  close() {
    this.db.close();
  }

  migrate() {
    withSqliteBusyRetry(() => this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)"));
    if (!existsSync(this.migrationsDir)) return [];
    const files = readdirSync(this.migrationsDir).filter((name) => name.endsWith(".sql")).sort();
    const completed = [];
    for (const filename of files) {
      const sql = readFileSync(path.join(this.migrationsDir, filename), "utf8");
      const appliedNow = transaction(this.db, () => {
        const existing = this.db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(filename);
        if (existing) return false;
        this.db.exec(sql);
        this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(filename, iso());
        return true;
      });
      if (appliedNow) completed.push(filename);
    }
    return completed;
  }

  listAccountProfiles() {
    return this.db.prepare("SELECT * FROM mabang_account_profiles ORDER BY created_at DESC").all().map((row) => ({
      id: row.id,
      name: row.name,
      username: row.username,
      usernameMasked: maskUsername(row.username),
      passwordConfigured: Boolean(row.encrypted_password),
      enabled: bool(row.enabled),
      lastVerifiedAt: row.last_verified_at || null,
      lastVerifyStatus: row.last_verify_status || null,
      lastVerifyMessage: row.last_verify_message || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  getAccountProfile(id, { includeSecret = false } = {}) {
    const row = this.db.prepare("SELECT * FROM mabang_account_profiles WHERE id = ?").get(id);
    if (!row) return null;
    const result = this.listAccountProfiles().find((item) => item.id === id);
    if (includeSecret) result.encryptedPassword = row.encrypted_password;
    return result;
  }

  findAccountProfileByUsername(username) {
    const row = this.db.prepare("SELECT id FROM mabang_account_profiles WHERE username=? ORDER BY updated_at DESC LIMIT 1").get(String(username || "").trim());
    return row ? this.getAccountProfile(row.id) : null;
  }

  saveAccountProfile(input) {
    const now = iso();
    const id = input.id || randomUUID();
    const existing = input.id ? this.db.prepare("SELECT id FROM mabang_account_profiles WHERE id = ?").get(id) : null;
    if (existing) {
      const fields = [input.name, input.username, Number(input.enabled !== false), now, id];
      if (input.encryptedPassword) {
        this.db.prepare("UPDATE mabang_account_profiles SET name=?, username=?, enabled=?, updated_at=?, encrypted_password=? WHERE id=?")
          .run(input.name, input.username, Number(input.enabled !== false), now, input.encryptedPassword, id);
      } else {
        this.db.prepare("UPDATE mabang_account_profiles SET name=?, username=?, enabled=?, updated_at=? WHERE id=?").run(...fields);
      }
    } else {
      this.db.prepare(`INSERT INTO mabang_account_profiles
        (id,name,username,encrypted_password,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
        .run(id, input.name, input.username, input.encryptedPassword, Number(input.enabled !== false), now, now);
    }
    return this.getAccountProfile(id);
  }

  updateAccountVerification(id, status, message) {
    this.db.prepare("UPDATE mabang_account_profiles SET last_verified_at=?, last_verify_status=?, last_verify_message=?, updated_at=? WHERE id=?")
      .run(iso(), status, String(message || "").slice(0, 500), iso(), id);
  }

  deleteAccountProfile(id) {
    return this.db.prepare("DELETE FROM mabang_account_profiles WHERE id=?").run(id).changes;
  }

  listDingtalkConfigs() {
    return this.db.prepare("SELECT * FROM dingtalk_robot_configs ORDER BY created_at DESC").all().map((row) => ({
      id: row.id,
      name: row.name,
      webhookConfigured: Boolean(row.encrypted_webhook_url),
      secretConfigured: Boolean(row.encrypted_secret),
      enabled: bool(row.enabled),
      notifyOnSuccess: bool(row.notify_on_success),
      notifyOnFailure: bool(row.notify_on_failure),
      notifyOnEmpty: bool(row.notify_on_empty),
      atAll: bool(row.at_all),
      atMobiles: parseJson(row.at_mobiles_json, []),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  getDingtalkConfig(id, { includeSecret = false } = {}) {
    const row = this.db.prepare("SELECT * FROM dingtalk_robot_configs WHERE id=?").get(id);
    if (!row) return null;
    const result = this.listDingtalkConfigs().find((item) => item.id === id);
    if (includeSecret) {
      result.encryptedWebhookUrl = row.encrypted_webhook_url;
      result.encryptedSecret = row.encrypted_secret || "";
    }
    return result;
  }

  saveDingtalkConfig(input) {
    const now = iso();
    const id = input.id || randomUUID();
    const existing = input.id ? this.db.prepare("SELECT id FROM dingtalk_robot_configs WHERE id=?").get(id) : null;
    const values = [
      input.name,
      Number(input.enabled !== false),
      Number(input.notifyOnSuccess !== false),
      Number(input.notifyOnFailure !== false),
      Number(input.notifyOnEmpty !== false),
      Number(Boolean(input.atAll)),
      JSON.stringify(input.atMobiles || []),
      now,
    ];
    if (existing) {
      if (input.encryptedWebhookUrl) {
        this.db.prepare(`UPDATE dingtalk_robot_configs SET name=?,enabled=?,notify_on_success=?,notify_on_failure=?,notify_on_empty=?,at_all=?,at_mobiles_json=?,updated_at=?,encrypted_webhook_url=?,encrypted_secret=? WHERE id=?`)
          .run(...values, input.encryptedWebhookUrl, input.encryptedSecret || "", id);
      } else {
        this.db.prepare(`UPDATE dingtalk_robot_configs SET name=?,enabled=?,notify_on_success=?,notify_on_failure=?,notify_on_empty=?,at_all=?,at_mobiles_json=?,updated_at=? WHERE id=?`)
          .run(...values, id);
      }
    } else {
      this.db.prepare(`INSERT INTO dingtalk_robot_configs
        (id,name,encrypted_webhook_url,encrypted_secret,enabled,notify_on_success,notify_on_failure,notify_on_empty,at_all,at_mobiles_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, input.name, input.encryptedWebhookUrl, input.encryptedSecret || "", ...values.slice(1, 7), now, now);
    }
    return this.getDingtalkConfig(id);
  }

  deleteDingtalkConfig(id) {
    return this.db.prepare("DELETE FROM dingtalk_robot_configs WHERE id=?").run(id).changes;
  }

  listTasks({ includeDeleted = false } = {}) {
    const deletedClause = includeDeleted ? "" : "WHERE t.deleted_at IS NULL";
    const rows = this.db.prepare(`SELECT t.*, a.name account_name, a.username account_username, d.name dingtalk_name
      ,a.id account_profile_found,a.enabled account_enabled
      FROM scheduled_export_tasks t
      LEFT JOIN mabang_account_profiles a ON a.id=t.account_profile_id
      LEFT JOIN dingtalk_robot_configs d ON d.id=t.dingtalk_config_id
      ${deletedClause}
      ORDER BY t.created_at DESC`).all();
    return rows.map(serializeTask);
  }

  getTask(id) {
    const row = this.db.prepare(`SELECT t.*, a.name account_name, a.username account_username, d.name dingtalk_name
      ,a.id account_profile_found,a.enabled account_enabled
      FROM scheduled_export_tasks t
      LEFT JOIN mabang_account_profiles a ON a.id=t.account_profile_id
      LEFT JOIN dingtalk_robot_configs d ON d.id=t.dingtalk_config_id
      WHERE t.id=?`).get(id);
    return serializeTask(row);
  }

  saveTask(input) {
    const now = iso();
    const id = input.id || randomUUID();
    const values = [
      input.taskType || "order_export", input.name, input.description || "", input.accountProfileId,
      input.dingtalkConfigId || null, input.scheduleType, JSON.stringify(input.scheduleConfig), input.timezone,
      input.paymentDateMode, JSON.stringify(input.paymentDateConfig || {}), JSON.stringify(input.filters || []),
      Number(input.enabled !== false), input.fileRetentionDays === "forever" ? null : Number(input.fileRetentionDays || 30),
      Number(input.notifyEnabled !== false), Number(input.catchUpEnabled !== false), input.nextRunAt || null, now,
    ];
    const existing = input.id ? this.db.prepare("SELECT id,deleted_at FROM scheduled_export_tasks WHERE id=?").get(id) : null;
    if (existing) {
      assertTaskNotDeleted({ deletedAt: existing.deleted_at });
      this.db.prepare(`UPDATE scheduled_export_tasks SET
        task_type=?,name=?,description=?,account_profile_id=?,dingtalk_config_id=?,schedule_type=?,schedule_config_json=?,timezone=?,
        payment_date_mode=?,payment_date_config_json=?,filters_json=?,enabled=?,file_retention_days=?,notify_enabled=?,catch_up_enabled=?,next_run_at=?,updated_at=? WHERE id=?`)
        .run(...values, id);
    } else {
      this.db.prepare(`INSERT INTO scheduled_export_tasks
        (id,task_type,name,description,account_profile_id,dingtalk_config_id,schedule_type,schedule_config_json,timezone,payment_date_mode,payment_date_config_json,filters_json,enabled,file_retention_days,notify_enabled,catch_up_enabled,next_run_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, ...values.slice(0, -1), now, now);
    }
    return this.getTask(id);
  }

  setTaskEnabled(id, enabled, nextRunAt = null) {
    const task = assertTaskNotDeleted(this.getTask(id));
    if (enabled) assertTaskAccountAvailable(task);
    this.db.prepare("UPDATE scheduled_export_tasks SET enabled=?, next_run_at=?, updated_at=? WHERE id=? AND deleted_at IS NULL")
      .run(Number(Boolean(enabled)), nextRunAt, iso(), id);
    return this.getTask(id);
  }

  updateTaskScheduleState(id, { nextRunAt, lastRunAt, lastRunStatus }) {
    return this.db.prepare(`UPDATE scheduled_export_tasks SET next_run_at=COALESCE(?,next_run_at),last_run_at=COALESCE(?,last_run_at),last_run_status=COALESCE(?,last_run_status),updated_at=? WHERE id=? AND deleted_at IS NULL`)
      .run(nextRunAt ?? null, lastRunAt ?? null, lastRunStatus ?? null, iso(), id);
  }

  softDeleteTask(id, { deletedBy = "local_session", deleteReason = null, now = new Date() } = {}) {
    return transaction(this.db, () => {
      const existing = this.db.prepare("SELECT deleted_at FROM scheduled_export_tasks WHERE id=?").get(id);
      if (!existing) return null;
      if (existing.deleted_at) return { task: this.getTask(id), alreadyDeleted: true };
      const deletedAt = iso(now);
      this.db.prepare(`UPDATE scheduled_export_tasks
        SET enabled=0,next_run_at=NULL,deleted_at=?,deleted_by=?,delete_reason=?,updated_at=?
        WHERE id=? AND deleted_at IS NULL`)
        .run(deletedAt, sanitizeDeletedBy(deletedBy), deleteReason || null, deletedAt, id);
      return { task: this.getTask(id), alreadyDeleted: false };
    });
  }

  restoreTask(id, { now = new Date() } = {}) {
    return transaction(this.db, () => {
      const existing = this.db.prepare("SELECT deleted_at FROM scheduled_export_tasks WHERE id=?").get(id);
      if (!existing) return null;
      if (!existing.deleted_at) return { task: this.getTask(id), alreadyRestored: true };
      const restoredAt = iso(now);
      this.db.prepare(`UPDATE scheduled_export_tasks
        SET enabled=0,next_run_at=NULL,deleted_at=NULL,deleted_by=NULL,delete_reason=NULL,updated_at=?
        WHERE id=?`).run(restoredAt, id);
      return { task: this.getTask(id), alreadyRestored: false };
    });
  }

  createRun({ taskId, triggerType, scheduledRunAt, status = "pending", errorMessage = null }) {
    assertTaskNotDeleted(this.getTask(taskId));
    const id = randomUUID();
    const now = iso();
    this.db.prepare(`INSERT INTO scheduled_export_runs
      (id,task_id,trigger_type,scheduled_run_at,status,error_message,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(id, taskId, triggerType, iso(scheduledRunAt), status, errorMessage, now, now);
    return this.getRun(id);
  }

  createRunIfAbsent(input) {
    try {
      return this.createRun(input);
    } catch (error) {
      if (!String(error.message).includes("UNIQUE")) throw error;
      return null;
    }
  }

  listRuns({ taskId = null, status = null, limit = 100 } = {}) {
    const clauses = [];
    const params = [];
    if (taskId) { clauses.push("r.task_id=?"); params.push(taskId); }
    if (status) { clauses.push("r.status=?"); params.push(status); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT r.*,t.name task_name,t.task_type task_type,t.deleted_at task_deleted_at,f.status file_status,f.original_filename
      FROM scheduled_export_runs r JOIN scheduled_export_tasks t ON t.id=r.task_id
      LEFT JOIN export_files f ON f.id=r.export_file_id
      ${where} ORDER BY r.created_at DESC LIMIT ?`).all(...params, Math.max(1, Math.min(Number(limit) || 100, 500)));
    return rows.map(serializeRun);
  }

  getRun(id) {
    const row = this.db.prepare(`SELECT r.*,t.name task_name,t.task_type task_type,t.deleted_at task_deleted_at,f.status file_status,f.original_filename
      FROM scheduled_export_runs r JOIN scheduled_export_tasks t ON t.id=r.task_id
      LEFT JOIN export_files f ON f.id=r.export_file_id WHERE r.id=?`).get(id);
    return serializeRun(row);
  }

  getRunDetails(id) {
    const run = this.getRun(id);
    if (!run) return null;
    run.events = this.db.prepare("SELECT * FROM scheduled_export_run_events WHERE run_id=? ORDER BY id").all(id).map((row) => ({
      id: row.id, stage: row.stage, status: row.status, attempt: row.attempt,
      startedAt: row.started_at, finishedAt: row.finished_at || null, durationMs: row.duration_ms,
      message: row.message || "", errorCode: row.error_code || null,
    }));
    run.task = this.getTask(run.taskId);
    return run;
  }

  claimRun(runId) {
    return transaction(this.db, () => {
      const run = this.db.prepare("SELECT * FROM scheduled_export_runs WHERE id=?").get(runId);
      if (!run || run.status !== "pending") return { claimed: false, reason: "not_pending" };
      const task = this.db.prepare("SELECT deleted_at FROM scheduled_export_tasks WHERE id=?").get(run.task_id);
      if (task?.deleted_at) {
        const now = iso();
        this.db.prepare("UPDATE scheduled_export_runs SET status='skipped',finished_at=?,error_stage='task_state',error_code='TASK_DELETED',error_message=?,updated_at=? WHERE id=?")
          .run(now, "该定时任务已删除，不能继续执行。如需使用，请先恢复任务。", now, runId);
        this.db.prepare(`INSERT INTO scheduled_export_run_events
          (run_id,stage,status,attempt,started_at,finished_at,duration_ms,message,error_code,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`)
          .run(runId, "task_state", "skipped", 1, now, now, 0, "任务在开始执行前已删除，本次运行已跳过。", "TASK_DELETED", now);
        return { claimed: false, reason: "task_deleted", run: this.getRun(runId) };
      }
      const active = this.db.prepare("SELECT id FROM scheduled_export_runs WHERE task_id=? AND status='running' AND id<>? LIMIT 1").get(run.task_id, runId);
      const now = iso();
      if (active) {
        this.db.prepare("UPDATE scheduled_export_runs SET status='skipped',finished_at=?,error_stage='lock',error_code='TASK_ALREADY_RUNNING',error_message=?,updated_at=? WHERE id=?")
          .run(now, "同一任务已有运行中的执行记录，本次已跳过。", now, runId);
        return { claimed: false, reason: "already_running" };
      }
      this.db.prepare("UPDATE scheduled_export_runs SET status='running',started_at=?,updated_at=? WHERE id=?").run(now, now, runId);
      return { claimed: true, run: this.getRun(runId) };
    });
  }

  updateRun(id, fields) {
    const mapping = {
      status: "status", paymentStartDate: "payment_start_date", paymentEndDate: "payment_end_date",
      rawOrderCount: "raw_order_count", filteredOrderCount: "filtered_order_count", detailRowCount: "detail_row_count",
      exportFileId: "export_file_id", notificationStatus: "notification_status", retryCount: "retry_count",
      errorStage: "error_stage", errorCode: "error_code", errorMessage: "error_message",
      logSummary: "log_summary_json", startedAt: "started_at", finishedAt: "finished_at",
    };
    const entries = Object.entries(fields).filter(([key]) => mapping[key]);
    if (!entries.length) return this.getRun(id);
    const values = entries.map(([key, value]) => key === "logSummary" ? JSON.stringify(value || {}) : value);
    const assignments = entries.map(([key]) => `${mapping[key]}=?`);
    this.db.prepare(`UPDATE scheduled_export_runs SET ${assignments.join(",")},updated_at=? WHERE id=?`).run(...values, iso(), id);
    return this.getRun(id);
  }

  pendingRuns(limit = 10) {
    return this.listRuns({ status: "pending", limit }).reverse();
  }

  addRunEvent({ runId, stage, status, attempt = 1, startedAt, finishedAt = null, durationMs = null, message = "", errorCode = null }) {
    const info = this.db.prepare(`INSERT INTO scheduled_export_run_events
      (run_id,stage,status,attempt,started_at,finished_at,duration_ms,message,error_code,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(runId, stage, status, attempt, iso(startedAt), finishedAt ? iso(finishedAt) : null, durationMs, String(message || "").slice(0, 1000), errorCode, iso());
    return Number(info.lastInsertRowid);
  }

  createExportFile(input) {
    const task = input.taskId ? this.getTask(input.taskId, { includeDeleted: true }) : null;
    return this.exportFiles.create({
      ...input,
      sourceType: input.sourceType || (task?.taskType === "inventory_export" ? "mabang_scheduled_inventory" : "mabang_scheduled_order"),
    });
  }

  getExportFile(id) {
    return this.exportFiles.get(id);
  }

  getExportFileByRequestKey(requestKey) {
    return this.exportFiles.getByRequestKey(requestKey);
  }

  listExportFiles(filters = {}) {
    return this.exportFiles.list(filters);
  }

  updateExportFileStatus(id, status, options = {}) {
    return this.exportFiles.updateStatus(id, status, options);
  }

  expiredFiles(now = new Date()) {
    return this.exportFiles.listExpired(now);
  }

  markFileExpired(id) {
    return this.exportFiles.updateStatus(id, "expired");
  }

  cacheFilterOptions(accountProfileId, records) {
    if (!accountProfileId || !Array.isArray(records) || !records.length) return;
    const statement = this.db.prepare(`INSERT OR IGNORE INTO mabang_filter_option_cache
      (account_profile_id,manager,shop_name,platform,region,warehouse,order_status,sku,logistics_channel,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    transaction(this.db, () => {
      for (const record of records.slice(0, 10000)) {
        statement.run(accountProfileId, record["店长"] || "", record["店铺名"] || "", record["平台"] || "",
          record["所属地区（省/州）"] || "", record["仓库"] || "", record["订单状态"] || "", record.SKU || "",
          record["物流渠道"] || "", iso());
      }
    });
  }

  filterOptions(accountProfileId) {
    const rows = this.db.prepare("SELECT * FROM mabang_filter_option_cache WHERE account_profile_id=? ORDER BY manager,shop_name LIMIT 10000").all(accountProfileId);
    const unique = (key) => [...new Set(rows.map((row) => row[key]).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN"));
    return {
      managers: unique("manager"), shops: unique("shop_name"), platforms: unique("platform"), regions: unique("region"),
      warehouses: unique("warehouse"), orderStatuses: unique("order_status"), skus: unique("sku"), logisticsChannels: unique("logistics_channel"),
      managerShops: rows.reduce((result, row) => {
        if (!row.manager || !row.shop_name) return result;
        if (!result[row.manager]) result[row.manager] = [];
        if (!result[row.manager].includes(row.shop_name)) result[row.manager].push(row.shop_name);
        return result;
      }, {}),
    };
  }

  acquireLease(name, ownerId, now = new Date(), leaseMs = 30000) {
    return transaction(this.db, () => {
      const current = this.db.prepare("SELECT * FROM scheduler_leases WHERE name=?").get(name);
      if (current && current.owner_id !== ownerId && new Date(current.lease_until).getTime() > now.getTime()) return false;
      const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
      this.db.prepare(`INSERT INTO scheduler_leases(name,owner_id,lease_until,updated_at) VALUES (?,?,?,?)
        ON CONFLICT(name) DO UPDATE SET owner_id=excluded.owner_id,lease_until=excluded.lease_until,updated_at=excluded.updated_at`)
        .run(name, ownerId, leaseUntil, iso(now));
      return true;
    });
  }

  releaseLease(name, ownerId) {
    this.db.prepare("DELETE FROM scheduler_leases WHERE name=? AND owner_id=?").run(name, ownerId);
  }

  schedulerStatus(now = new Date()) {
    const lease = this.db.prepare("SELECT owner_id,lease_until,updated_at FROM scheduler_leases WHERE name='mabang_scheduler'").get();
    return {
      online: Boolean(lease && new Date(lease.lease_until).getTime() > now.getTime()),
      leaseUntil: lease?.lease_until || null,
      updatedAt: lease?.updated_at || null,
    };
  }

  dueTasks(now = new Date()) {
    return this.db.prepare("SELECT id FROM scheduled_export_tasks WHERE deleted_at IS NULL AND enabled=1 AND next_run_at IS NOT NULL AND next_run_at<=? ORDER BY next_run_at").all(iso(now))
      .map((row) => this.getTask(row.id));
  }

  recoverStaleRuns(now = new Date(), staleMs = 30 * 60 * 1000) {
    const cutoff = new Date(now.getTime() - staleMs).toISOString();
    return this.db.prepare(`UPDATE scheduled_export_runs SET status='failed',finished_at=?,error_stage='scheduler',error_code='PROCESS_RESTART',error_message='服务重启时检测到未完成任务。',updated_at=?
      WHERE status='running' AND started_at<?`).run(iso(now), iso(now), cutoff).changes;
  }
}

export function openSchedulerDatabase({ rootDir, databasePath = process.env.SCHEDULER_DB_PATH } = {}) {
  const resolvedRoot = rootDir || process.cwd();
  const target = databasePath ? path.resolve(resolvedRoot, databasePath) : path.join(resolvedRoot, "storage", "commerce-ops.sqlite");
  const database = new SchedulerDatabase({ databasePath: target, migrationsDir: path.join(resolvedRoot, "migrations") });
  database.migrate();
  return database;
}
