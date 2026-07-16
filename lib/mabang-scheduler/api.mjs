import { decryptSecret, encryptSecret } from "./crypto.mjs";
import { ORDER_FIELD_CATALOG, PRIMARY_SCHEDULE_FILTER_IDS, normalizeTaskFilters } from "./fields.mjs";
import { nextRunAt, paymentDateRange, validatePaymentDateConfig, validateScheduleConfig, assertTimeZone } from "./schedule.mjs";
import { sendDingtalkMessage, validateDingtalkWebhook } from "./dingtalk.mjs";
import {
  assertTaskNotDeleted,
  sanitizeDeleteReason,
  TASK_ACCOUNT_UNAVAILABLE_MESSAGE,
  TASK_DELETED_CODE,
  TaskStateError,
} from "./task-state.mjs";
import {
  FilePolicyError,
  safeContentDisposition,
  validateFileId,
} from "../security/file-policy.mjs";
import { createExportFileService } from "../files/export-file-service.mjs";

function sendJson(res, status, data) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
  return true;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error("请求内容过大。");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function cleanText(value, label, { required = false, max = 200 } = {}) {
  const text = String(value || "").trim();
  if (required && !text) throw new Error(`${label}不能为空。`);
  if (text.length > max) throw new Error(`${label}不能超过 ${max} 个字符。`);
  return text;
}

function normalizeMobiles(values) {
  const source = Array.isArray(values) ? values : String(values || "").split(/[\s,，;；]+/);
  return [...new Set(source.map((value) => String(value).trim()).filter(Boolean))].slice(0, 20);
}

function taskInput(body, db, existing = null, now = new Date()) {
  const name = cleanText(body.name, "任务名称", { required: true, max: 80 });
  const taskType = String(body.taskType || existing?.taskType || "order_export");
  if (!["order_export", "inventory_export"].includes(taskType)) throw new Error("请选择订单信息或库存信息导出。");
  const accountProfileId = String(body.accountProfileId || "");
  if (!db.getAccountProfile(accountProfileId)) throw new Error("请选择有效的马帮账号配置。");
  const dingtalkConfigId = body.dingtalkConfigId ? String(body.dingtalkConfigId) : null;
  if (dingtalkConfigId && !db.getDingtalkConfig(dingtalkConfigId)) throw new Error("钉钉机器人配置不存在。");
  const scheduleType = String(body.scheduleType || "");
  const scheduleConfig = validateScheduleConfig(scheduleType, body.scheduleConfig || {});
  const timezone = assertTimeZone(body.timezone || "Asia/Shanghai");
  const paymentDateMode = taskType === "order_export" ? String(body.paymentDateMode || "yesterday") : "snapshot";
  const paymentDateConfig = taskType === "order_export" ? validatePaymentDateConfig(paymentDateMode, body.paymentDateConfig || {}) : {};
  const filters = taskType === "order_export" ? normalizeTaskFilters(body.filters || []) : [];
  const enabled = body.enabled !== false;
  const retention = body.fileRetentionDays === "forever" ? "forever" : Number(body.fileRetentionDays ?? 30);
  if (retention !== "forever" && ![7, 30, 90].includes(retention)) throw new Error("文件保留期限必须是 7、30、90 天或永久。");
  const task = {
    id: existing?.id,
    taskType,
    name,
    description: cleanText(body.description, "任务描述", { max: 500 }),
    accountProfileId,
    dingtalkConfigId,
    scheduleType,
    scheduleConfig,
    timezone,
    paymentDateMode,
    paymentDateConfig,
    filters,
    enabled,
    fileRetentionDays: retention,
    notifyEnabled: body.notifyEnabled !== false,
    catchUpEnabled: body.catchUpEnabled !== false,
  };
  task.nextRunAt = enabled ? nextRunAt(task, now).toISOString() : null;
  return task;
}

function accountInput(body, existing = null) {
  const password = String(body.password || "");
  if (!existing && !password) throw new Error("马帮密码不能为空。");
  return {
    id: existing?.id,
    name: cleanText(body.name, "配置名称", { required: true, max: 80 }),
    username: cleanText(body.username, "马帮账号", { required: true, max: 120 }),
    encryptedPassword: password ? encryptSecret(password) : existing?.encryptedPassword,
    enabled: body.enabled !== false,
  };
}

function robotInput(body, existing = null) {
  const webhook = String(body.webhookUrl || "").trim();
  if (!existing && !webhook) throw new Error("Webhook URL 不能为空。");
  const secretProvided = Object.hasOwn(body, "secret") && String(body.secret || "").trim();
  return {
    id: existing?.id,
    name: cleanText(body.name, "配置名称", { required: true, max: 80 }),
    encryptedWebhookUrl: webhook ? encryptSecret(validateDingtalkWebhook(webhook)) : existing?.encryptedWebhookUrl,
    encryptedSecret: secretProvided ? encryptSecret(String(body.secret).trim()) : existing?.encryptedSecret || "",
    enabled: body.enabled !== false,
    notifyOnSuccess: body.notifyOnSuccess !== false,
    notifyOnFailure: body.notifyOnFailure !== false,
    notifyOnEmpty: body.notifyOnEmpty !== false,
    atAll: Boolean(body.atAll),
    atMobiles: normalizeMobiles(body.atMobiles),
  };
}

function idMatch(pathname, prefix, suffix = "") {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tail = suffix ? `/${suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}` : "";
  return pathname.match(new RegExp(`^${escaped}/([^/]+)${tail}$`));
}

function requireActiveTask(req, task) {
  try {
    return assertTaskNotDeleted(task);
  } catch (error) {
    if (error.code === TASK_DELETED_CODE) {
      req.auditContext?.addRelated("mabang", "mabang.task.deleted_execution_rejected", {
        status: "failed",
        taskId: task?.id,
        errorStage: "task_state",
        errorCode: TASK_DELETED_CODE,
      });
    }
    throw error;
  }
}

export function createMabangSchedulerApi({ db, runWorker, exportRoot, fileService = null, notify = sendDingtalkMessage, now = () => new Date() }) {
  let exportFiles = fileService;
  const fileManager = () => {
    if (!exportFiles) exportFiles = createExportFileService({ db, exportRoot, tempRoot: `${exportRoot}/.temp` });
    return exportFiles;
  };
  return async function handleMabangSchedulerApi(req, res, url) {
    const pathname = url.pathname;
    const isSchedulerRoute = pathname.startsWith("/api/mabang/scheduled-")
      || pathname.startsWith("/api/mabang/account-profiles")
      || pathname.startsWith("/api/mabang/export-files")
      || pathname.startsWith("/api/mabang/scheduler")
      || pathname.startsWith("/api/notifications/dingtalk");
    if (!isSchedulerRoute) return false;
    try {
      if (pathname === "/api/mabang/scheduler-meta" && req.method === "GET") {
        return sendJson(res, 200, {
          ok: true,
          scheduler: db.schedulerStatus(now()),
          encryptionConfigured: Boolean(process.env.APP_ENCRYPTION_KEY),
          fields: ORDER_FIELD_CATALOG,
          primaryFilterIds: PRIMARY_SCHEDULE_FILTER_IDS,
          taskTypes: ["order_export", "inventory_export"],
          paymentDateModes: ["today", "yesterday", "last_7_days", "last_14_days", "last_30_days", "this_week", "previous_week", "this_month", "previous_month", "relative", "fixed"],
        });
      }

      if (pathname === "/api/mabang/account-profiles") {
        if (req.method === "GET") return sendJson(res, 200, { ok: true, profiles: db.listAccountProfiles() });
        if (req.method === "POST") {
          const profile = db.saveAccountProfile(accountInput(await readJson(req)));
          req.auditContext?.annotate({ actorIdentifier: profile.username });
          return sendJson(res, 201, { ok: true, profile });
        }
        return sendJson(res, 405, { ok: false, error: "Method not allowed" });
      }
      let match = idMatch(pathname, "/api/mabang/account-profiles");
      if (match) {
        const id = decodeURIComponent(match[1]);
        const existing = db.getAccountProfile(id, { includeSecret: true });
        if (!existing) return sendJson(res, 404, { ok: false, error: "马帮账号配置不存在。" });
        req.auditContext?.annotate({ actorIdentifier: existing.username });
        if (req.method === "PUT") return sendJson(res, 200, { ok: true, profile: db.saveAccountProfile(accountInput(await readJson(req), existing)) });
        if (req.method === "DELETE") return sendJson(res, 200, { ok: true, deleted: Boolean(db.deleteAccountProfile(id)) });
        return sendJson(res, 405, { ok: false, error: "Method not allowed" });
      }
      match = idMatch(pathname, "/api/mabang/account-profiles", "test");
      if (match && req.method === "POST") {
        const id = decodeURIComponent(match[1]);
        const profile = db.getAccountProfile(id, { includeSecret: true });
        if (!profile) return sendJson(res, 404, { ok: false, error: "马帮账号配置不存在。" });
        req.auditContext?.annotate({ actorIdentifier: profile.username });
        try {
          const result = await runWorker({ action: "test-login", username: profile.username, password: decryptSecret(profile.encryptedPassword) }, 90000);
          db.updateAccountVerification(id, "success", result.message || "登录成功");
          return sendJson(res, 200, { ok: true, message: result.message || "登录成功。" });
        } catch (error) {
          req.auditContext?.annotate({ errorStage: "mabang_login", errorCode: error.code || "AUTH_FAILED", errorSummary: error });
          db.updateAccountVerification(id, "failed", error.message);
          return sendJson(res, 400, { ok: false, error: error.message });
        }
      }

      if (pathname === "/api/notifications/dingtalk/configs") {
        if (req.method === "GET") return sendJson(res, 200, { ok: true, configs: db.listDingtalkConfigs() });
        if (req.method === "POST") return sendJson(res, 201, { ok: true, config: db.saveDingtalkConfig(robotInput(await readJson(req))) });
        return sendJson(res, 405, { ok: false, error: "Method not allowed" });
      }
      match = idMatch(pathname, "/api/notifications/dingtalk/configs");
      if (match) {
        const id = decodeURIComponent(match[1]);
        const existing = db.getDingtalkConfig(id, { includeSecret: true });
        if (!existing) return sendJson(res, 404, { ok: false, error: "钉钉机器人配置不存在。" });
        if (req.method === "PUT") return sendJson(res, 200, { ok: true, config: db.saveDingtalkConfig(robotInput(await readJson(req), existing)) });
        if (req.method === "DELETE") return sendJson(res, 200, { ok: true, deleted: Boolean(db.deleteDingtalkConfig(id)) });
        return sendJson(res, 405, { ok: false, error: "Method not allowed" });
      }
      match = idMatch(pathname, "/api/notifications/dingtalk/configs", "test");
      if (match && req.method === "POST") {
        const config = db.getDingtalkConfig(decodeURIComponent(match[1]), { includeSecret: true });
        if (!config) return sendJson(res, 404, { ok: false, error: "钉钉机器人配置不存在。" });
        const result = await notify({
          webhookUrl: decryptSecret(config.encryptedWebhookUrl), secret: config.encryptedSecret ? decryptSecret(config.encryptedSecret) : "",
          title: "Commerce Ops 机器人测试", markdown: `### Commerce Ops 机器人测试\n\n- 时间：${now().toLocaleString("zh-CN", { hour12: false })}\n- 状态：连接成功`,
          atAll: config.atAll, atMobiles: config.atMobiles,
        });
        return sendJson(res, 200, { ok: true, message: "钉钉测试消息发送成功。", result: { status: result.status, code: result.code } });
      }

      if (pathname === "/api/mabang/scheduled-tasks") {
        if (req.method === "GET") {
          const includeDeleted = url.searchParams.get("include_deleted") === "true";
          return sendJson(res, 200, { ok: true, tasks: db.listTasks({ includeDeleted }) });
        }
        if (req.method === "POST") {
          const task = db.saveTask(taskInput(await readJson(req), db, null, now()));
          req.auditContext?.annotate({ taskId: task.id, actorIdentifier: task.accountUsernameMasked, metadata: { taskType: task.taskType } });
          return sendJson(res, 201, { ok: true, task });
        }
        return sendJson(res, 405, { ok: false, error: "Method not allowed" });
      }
      match = idMatch(pathname, "/api/mabang/scheduled-tasks");
      if (match) {
        const id = decodeURIComponent(match[1]);
        const existing = db.getTask(id);
        if (!existing) return sendJson(res, 404, { ok: false, error: "定时任务不存在。" });
        req.auditContext?.annotate({ taskId: id, actorIdentifier: existing.accountUsernameMasked, metadata: { taskType: existing.taskType } });
        if (req.method === "GET") return sendJson(res, 200, { ok: true, task: existing });
        if (req.method === "PUT") {
          requireActiveTask(req, existing);
          return sendJson(res, 200, { ok: true, task: db.saveTask(taskInput(await readJson(req), db, existing, now())) });
        }
        if (req.method === "DELETE") {
          const body = await readJson(req);
          const deleteReason = sanitizeDeleteReason(body.reason);
          const result = db.softDeleteTask(id, {
            deletedBy: req.auditContext?.actorType,
            deleteReason,
            now: now(),
          });
          req.auditContext?.annotate({
            metadata: { taskType: existing.taskType, reason: deleteReason || "not_provided" },
          });
          return sendJson(res, 200, {
            ok: true,
            deleted: true,
            alreadyDeleted: result.alreadyDeleted,
            task: result.task,
          });
        }
        return sendJson(res, 405, { ok: false, error: "Method not allowed" });
      }
      match = idMatch(pathname, "/api/mabang/scheduled-tasks", "restore");
      if (match && req.method === "POST") {
        const id = decodeURIComponent(match[1]);
        const existing = db.getTask(id);
        if (!existing) return sendJson(res, 404, { ok: false, error: "定时任务不存在。" });
        req.auditContext?.annotate({ taskId: id, actorIdentifier: existing.accountUsernameMasked, metadata: { taskType: existing.taskType } });
        const result = db.restoreTask(id, { now: now() });
        const canEnable = Boolean(result.task.accountAvailable && result.task.accountEnabled);
        return sendJson(res, 200, {
          ok: true,
          restored: true,
          alreadyRestored: result.alreadyRestored,
          canEnable,
          warning: canEnable ? null : TASK_ACCOUNT_UNAVAILABLE_MESSAGE,
          task: result.task,
        });
      }
      for (const action of ["enable", "disable", "run-now", "duplicate", "preview"]) {
        match = idMatch(pathname, "/api/mabang/scheduled-tasks", action);
        if (!match || req.method !== "POST") continue;
        const id = decodeURIComponent(match[1]);
        const task = db.getTask(id);
        if (!task) return sendJson(res, 404, { ok: false, error: "定时任务不存在。" });
        req.auditContext?.annotate({ taskId: id, actorIdentifier: task.accountUsernameMasked, metadata: { taskType: task.taskType } });
        requireActiveTask(req, task);
        if (action === "enable") return sendJson(res, 200, { ok: true, task: db.setTaskEnabled(id, true, nextRunAt(task, now()).toISOString()) });
        if (action === "disable") return sendJson(res, 200, { ok: true, task: db.setTaskEnabled(id, false, null) });
        if (action === "preview") {
          const previewAt = now();
          return sendJson(res, 200, {
            ok: true,
            taskType: task.taskType,
            snapshotAt: task.taskType === "inventory_export" ? previewAt.toISOString() : null,
            paymentDateRange: task.taskType === "order_export" ? paymentDateRange(task.paymentDateMode, task.paymentDateConfig, previewAt, task.timezone) : null,
          });
        }
        if (action === "run-now") {
          const scheduled = now();
          const run = db.createRun({ taskId: id, triggerType: "manual", scheduledRunAt: scheduled });
          req.auditContext?.annotate({ runId: run.id });
          return sendJson(res, 202, {
            ok: true,
            runId: run.id,
            run_id: run.id,
            status: run.status,
            taskType: task.taskType,
            snapshotAt: task.taskType === "inventory_export" ? scheduled.toISOString() : null,
            paymentDateRange: task.taskType === "order_export" ? paymentDateRange(task.paymentDateMode, task.paymentDateConfig, scheduled, task.timezone) : null,
          });
        }
        const copy = db.saveTask({ ...task, id: undefined, name: `${task.name} - 副本`, enabled: false, nextRunAt: null });
        return sendJson(res, 201, { ok: true, task: copy });
      }

      if (pathname === "/api/mabang/scheduled-runs" && req.method === "GET") {
        return sendJson(res, 200, { ok: true, runs: db.listRuns({ taskId: url.searchParams.get("taskId"), status: url.searchParams.get("status"), limit: url.searchParams.get("limit") }) });
      }
      match = idMatch(pathname, "/api/mabang/scheduled-runs");
      if (match && req.method === "GET") {
        const run = db.getRunDetails(decodeURIComponent(match[1]));
        return run ? sendJson(res, 200, { ok: true, run }) : sendJson(res, 404, { ok: false, error: "执行记录不存在。" });
      }
      match = idMatch(pathname, "/api/mabang/scheduled-runs", "retry");
      if (match && req.method === "POST") {
        const source = db.getRun(decodeURIComponent(match[1]));
        if (!source) return sendJson(res, 404, { ok: false, error: "执行记录不存在。" });
        requireActiveTask(req, db.getTask(source.taskId));
        const run = db.createRun({ taskId: source.taskId, triggerType: "retry", scheduledRunAt: now() });
        req.auditContext?.annotate({ taskId: source.taskId, runId: run.id, metadata: { triggerType: "retry" } });
        return sendJson(res, 202, { ok: true, runId: run.id, run_id: run.id, status: run.status });
      }

      if (pathname === "/api/mabang/scheduler-filter-options" && req.method === "GET") {
        const accountProfileId = String(url.searchParams.get("accountProfileId") || "");
        return sendJson(res, 200, { ok: true, options: accountProfileId ? db.filterOptions(accountProfileId) : {} });
      }

      match = idMatch(pathname, "/api/mabang/export-files", "download");
      if (match && req.method === "GET") {
        const fileId = validateFileId(decodeURIComponent(match[1]));
        const { file, content } = await fileManager().download(fileId);
        req.auditContext?.annotate({ fileId, taskId: file.taskId, runId: file.runId });
        res.writeHead(200, {
          "content-type": file.mimeType,
          "content-disposition": safeContentDisposition(file.originalFilename),
          "content-length": content.length,
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
        });
        res.end(content);
        return true;
      }

      return sendJson(res, 404, { ok: false, error: "API route not found" });
    } catch (error) {
      req.auditContext?.annotate({ errorCode: error.code || "MABANG_API_FAILED", errorSummary: error });
      if (error instanceof FilePolicyError) {
        return sendJson(res, error.status || 400, { ok: false, code: error.code, error: error.message });
      }
      if (error instanceof TaskStateError) {
        return sendJson(res, error.status || 409, { ok: false, code: error.code, error: error.message });
      }
      const status = /不存在/.test(error.message) ? 404 : /FOREIGN KEY/.test(error.message) ? 409 : 400;
      const message = /FOREIGN KEY/.test(error.message) ? "该配置正在被定时任务使用，暂时不能删除。" : error.message;
      return sendJson(res, status, { ok: false, error: message });
    }
  };
}
