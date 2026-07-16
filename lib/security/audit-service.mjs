import { randomUUID } from "node:crypto";
import { isIP } from "node:net";

const ACTION_PATTERN = /^[a-z][a-z0-9_.-]{1,119}$/;
const MODULE_PATTERN = /^[a-z][a-z0-9_-]{1,39}$/;
const STATUS_VALUES = new Set(["success", "failed"]);
const MAX_QUERY_RANGE_MS = 366 * 24 * 60 * 60 * 1000;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

export const AUDIT_ACTION_LABELS = Object.freeze({
  "auth.verify.success": "登录验证成功",
  "auth.verify.failed": "登录验证失败",
  "auth.logout": "主动退出",
  "auth.access.denied": "未认证访问被拒绝",
  "auth.token.invalid": "访问密钥失效",
  "competitor.link_analysis.run": "执行链接竞品分析",
  "competitor.keyword_search.run": "执行关键词搜索",
  "competitor.export.download": "导出竞品结果",
  "competitor.keyword_export.download": "导出关键词结果",
  "deepseek.call": "调用 DeepSeek",
  "chrome.navigation.run": "Chrome 导航",
  "chrome.navigation.rejected": "Chrome 导航被拒绝",
  "image.proxy.fetch": "图片代理读取",
  "image.proxy.rejected": "图片代理被拒绝",
  "ads.service.status": "检查广告服务状态",
  "ads.upload": "上传广告 Excel",
  "ads.file.validation.success": "广告文件校验成功",
  "ads.file.validation.failed": "广告文件校验失败",
  "ads.analysis.run": "执行广告分析",
  "ads.result.download": "读取广告结果",
  "ads.internal_auth.failed": "广告内部认证失败",
  "mabang.account.create": "创建马帮账号配置",
  "mabang.account.update": "修改马帮账号配置",
  "mabang.account.delete": "删除马帮账号配置",
  "mabang.login.test": "测试马帮登录",
  "mabang.orders.fetch": "获取马帮订单",
  "mabang.inventory.fetch": "获取马帮库存",
  "mabang.export.create": "创建马帮手动导出",
  "mabang.task.create": "创建定时任务",
  "mabang.task.update": "修改定时任务",
  "mabang.task.enable": "启用定时任务",
  "mabang.task.disable": "停用定时任务",
  "mabang.task.run_now": "立即执行定时任务",
  "mabang.task.delete": "删除定时任务",
  "mabang.task.restore": "恢复定时任务",
  "mabang.task.deleted_execution_rejected": "已删除任务执行被拒绝",
  "mabang.task.deleted_scheduler_skipped": "已删除任务调度已跳过",
  "mabang.task.duplicate": "复制定时任务",
  "mabang.task.execution.success": "定时任务执行成功",
  "mabang.task.execution.failed": "定时任务执行失败",
  "mabang.dingtalk.test": "测试钉钉机器人",
  "mabang.dingtalk.notify.success": "钉钉通知成功",
  "mabang.dingtalk.notify.failed": "钉钉通知失败",
  "file.upload": "上传文件",
  "file.upload.rejected": "文件上传被拒绝",
  "file.download": "下载文件",
  "file.download.rejected": "文件下载被拒绝",
  "file.path.rejected": "文件路径被拒绝",
  "file.temp.cleanup": "清理临时文件",
  "audit.retention.cleanup": "清理过期审计记录",
});

export const AUDIT_METADATA_KEYS = Object.freeze(new Set([
  "reason",
  "kind",
  "platform",
  "country",
  "taskType",
  "triggerType",
  "fileType",
  "validationCode",
  "requestedAction",
  "result",
  "proxied",
  "retentionDays",
  "cleanupDeleted",
  "priority",
  "provider",
]));

function boundedText(value, maxLength = 240) {
  return String(value ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, maxLength);
}

function stableName(value, pattern, fallback) {
  const text = boundedText(value, 120).toLowerCase();
  return pattern.test(text) ? text : fallback;
}

function normalizeDate(value, label) {
  if (value === undefined || value === null || value === "") return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new Error(`${label} must be an ISO date`);
  return date;
}

function normalizeId(value) {
  const text = boundedText(value, 128);
  return /^[A-Za-z0-9_-]{1,128}$/.test(text) ? text : null;
}

export function normalizeSourceIp(value) {
  let text = boundedText(value, 100).replace(/^\[|\]$/g, "");
  if (text.toLowerCase().startsWith("::ffff:")) text = text.slice(7);
  const zoneIndex = text.indexOf("%");
  if (zoneIndex !== -1) text = text.slice(0, zoneIndex);
  return isIP(text) ? text.toLowerCase() : "unknown";
}

export function parseTrustedProxies(value) {
  if (!String(value || "").trim()) return new Set();
  const proxies = String(value).split(",").map(normalizeSourceIp);
  if (proxies.some((item) => item === "unknown")) throw new Error("TRUST_PROXY must contain exact IP addresses");
  return new Set(proxies);
}

function headerValue(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") return headers.get(name) || "";
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] || "" : value || "";
}

export function resolveAuditSourceIp(req, trustedProxies = new Set()) {
  const remote = normalizeSourceIp(req?.socket?.remoteAddress || req?.connection?.remoteAddress || "");
  if (!trustedProxies.has(remote)) return remote;
  const forwarded = String(headerValue(req?.headers, "x-forwarded-for") || "").split(",")[0].trim();
  const candidate = normalizeSourceIp(forwarded);
  return candidate === "unknown" ? remote : candidate;
}

export function maskAuditIdentifier(value) {
  const text = boundedText(value, 120);
  if (!text) return null;
  if (/^\d{7,15}$/.test(text)) return `${text.slice(0, 3)}****${text.slice(-4)}`;
  if (text.includes("@")) {
    const [name, domain] = text.split("@", 2);
    return `${name.slice(0, 2)}***@${domain}`;
  }
  if (text.length <= 4) return `${text.slice(0, 1)}***`;
  return `${text.slice(0, 2)}***${text.slice(-2)}`;
}

export function maskAuditSourceIp(value) {
  const ip = normalizeSourceIp(value);
  if (ip === "unknown") return ip;
  if (isIP(ip) === 4) {
    const parts = ip.split(".");
    return `${parts[0]}.${parts[1]}.*.*`;
  }
  return `${ip.split(":").slice(0, 2).join(":")}:*`;
}

export function redactAuditText(value, { secretValues = [] } = {}) {
  let text = String(value?.message || value || "").split(/\r?\n/)[0].trim();
  for (const secret of secretValues) {
    const raw = String(secret || "");
    if (raw) text = text.split(raw).join("[REDACTED]");
  }
  text = text
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/((?:password|token|api[_-]?key|secret|cookie|authorization|webhook)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/https?:\/\/[^\s]*(?:webhook|robot\/send)[^\s]*/gi, "[WEBHOOK]")
    .replace(/([?&](?:access_token|token|sign|secret)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/((?:buyer|recipient|customer|address|phone|mobile|姓名|地址|电话)\s*[:=]\s*)[^,;]+/gi, "$1[REDACTED]")
    .replace(/[A-Za-z]:\\[^\s]+/g, "[PATH]")
    .replace(/\b(\d{3})\d{4}(\d{4})\b/g, "$1****$2");
  return boundedText(text || "Operation failed", 300);
}

export function sanitizeAuditMetadata(metadata = {}, options = {}) {
  const result = {};
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return result;
  for (const [key, value] of Object.entries(metadata)) {
    if (!AUDIT_METADATA_KEYS.has(key)) continue;
    if (!["string", "number", "boolean"].includes(typeof value) || !Number.isFinite(value) && typeof value === "number") continue;
    result[key] = typeof value === "string" ? redactAuditText(value, options).slice(0, 160) : value;
  }
  return result;
}

function serializeRow(row) {
  if (!row) return null;
  let metadata = {};
  try { metadata = JSON.parse(row.metadata_json || "{}"); } catch { metadata = {}; }
  return {
    id: row.id,
    requestId: row.request_id,
    occurredAt: row.occurred_at,
    module: row.module,
    action: row.action,
    actionLabel: AUDIT_ACTION_LABELS[row.action] || row.action,
    httpMethod: row.http_method || null,
    requestPath: row.request_path || null,
    status: row.status,
    httpStatus: row.http_status === null ? null : Number(row.http_status),
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    source: maskAuditSourceIp(row.source_ip),
    actorType: row.actor_type || null,
    actorIdentifier: row.actor_identifier || null,
    taskId: row.task_id || null,
    runId: row.run_id || null,
    fileId: row.file_id || null,
    errorStage: row.error_stage || null,
    errorCode: row.error_code || null,
    errorSummary: row.error_summary || null,
    metadata,
  };
}

export class OperationAuditService {
  constructor({ database, logger = console, now = () => new Date(), secretValues = [] }) {
    this.database = database;
    this.logger = logger;
    this.now = now;
    this.secretValues = secretValues.filter(Boolean).map(String);
  }

  recordAuditEvent(input = {}) {
    const occurredAt = normalizeDate(input.occurredAt, "occurredAt") || this.now();
    const module = stableName(input.module, MODULE_PATTERN, "system");
    const action = stableName(input.action, ACTION_PATTERN, "system.unknown");
    const status = STATUS_VALUES.has(input.status) ? input.status : "failed";
    const id = randomUUID();
    const requestId = normalizeId(input.requestId) || randomUUID();
    const options = { secretValues: this.secretValues };
    const requestPath = boundedText(String(input.requestPath || "").split("?")[0], 240) || null;
    this.database.prepare(`INSERT INTO operation_audit_events
      (id,request_id,occurred_at,module,action,http_method,request_path,status,http_status,duration_ms,source_ip,actor_type,actor_identifier,task_id,run_id,file_id,error_stage,error_code,error_summary,metadata_json,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id,
      requestId,
      occurredAt.toISOString(),
      module,
      action,
      boundedText(input.httpMethod, 12).toUpperCase() || null,
      requestPath,
      status,
      Number.isInteger(Number(input.httpStatus)) ? Number(input.httpStatus) : null,
      Number.isFinite(Number(input.durationMs)) ? Math.max(0, Math.round(Number(input.durationMs))) : null,
      normalizeSourceIp(input.sourceIp),
      boundedText(input.actorType, 40) || null,
      maskAuditIdentifier(input.actorIdentifier),
      normalizeId(input.taskId),
      normalizeId(input.runId),
      normalizeId(input.fileId),
      boundedText(input.errorStage, 80) || null,
      boundedText(input.errorCode, 80) || null,
      input.errorSummary ? redactAuditText(input.errorSummary, options) : null,
      JSON.stringify(sanitizeAuditMetadata(input.metadata, options)),
      this.now().toISOString(),
    );
    return this.getEvent(id);
  }

  recordSafely(input = {}) {
    try {
      return this.recordAuditEvent(input);
    } catch (error) {
      const code = boundedText(error?.code || error?.name || "AUDIT_WRITE_FAILED", 80);
      this.logger.error?.(`Audit write failed: ${code}`);
      return null;
    }
  }

  getEvent(id) {
    return serializeRow(this.database.prepare("SELECT * FROM operation_audit_events WHERE id=?").get(String(id || "")));
  }

  queryEvents(filters = {}) {
    const page = Math.max(1, Number.parseInt(filters.page, 10) || 1);
    const pageSize = Math.max(1, Math.min(Number.parseInt(filters.pageSize, 10) || DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE));
    const start = normalizeDate(filters.start, "start");
    const end = normalizeDate(filters.end, "end");
    if (start && end && (end < start || end - start > MAX_QUERY_RANGE_MS)) throw new Error("Audit date range is invalid or exceeds 366 days");
    const clauses = [];
    const values = [];
    const equal = (column, value, pattern = null) => {
      if (value === undefined || value === null || value === "") return;
      const text = boundedText(value, 128);
      if (pattern && !pattern.test(text)) throw new Error(`Invalid audit filter: ${column}`);
      clauses.push(`${column}=?`);
      values.push(text);
    };
    if (start) { clauses.push("occurred_at>=?"); values.push(start.toISOString()); }
    if (end) { clauses.push("occurred_at<=?"); values.push(end.toISOString()); }
    equal("module", filters.module, MODULE_PATTERN);
    equal("action", filters.action, ACTION_PATTERN);
    equal("status", filters.status, /^(success|failed)$/);
    if (filters.httpStatus !== undefined && filters.httpStatus !== null && filters.httpStatus !== "") {
      const code = Number(filters.httpStatus);
      if (!Number.isInteger(code) || code < 100 || code > 599) throw new Error("Invalid HTTP status filter");
      clauses.push("http_status=?"); values.push(code);
    }
    equal("task_id", filters.taskId, /^[A-Za-z0-9_-]{1,128}$/);
    equal("run_id", filters.runId, /^[A-Za-z0-9_-]{1,128}$/);
    equal("file_id", filters.fileId, /^[A-Za-z0-9_-]{1,128}$/);
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const total = Number(this.database.prepare(`SELECT COUNT(*) AS total FROM operation_audit_events ${where}`).get(...values).total || 0);
    const rows = this.database.prepare(`SELECT * FROM operation_audit_events ${where} ORDER BY occurred_at DESC,id DESC LIMIT ? OFFSET ?`)
      .all(...values, pageSize, (page - 1) * pageSize);
    return { events: rows.map(serializeRow), page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
  }

  summary({ start, end } = {}) {
    const range = this.queryEvents({ start, end, page: 1, pageSize: 1 });
    const startDate = normalizeDate(start, "start");
    const endDate = normalizeDate(end, "end");
    const clauses = [];
    const values = [];
    if (startDate) { clauses.push("occurred_at>=?"); values.push(startDate.toISOString()); }
    if (endDate) { clauses.push("occurred_at<=?"); values.push(endDate.toISOString()); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const byStatus = this.database.prepare(`SELECT status,COUNT(*) count FROM operation_audit_events ${where} GROUP BY status`).all(...values);
    const byModule = this.database.prepare(`SELECT module,COUNT(*) count FROM operation_audit_events ${where} GROUP BY module ORDER BY count DESC`).all(...values);
    return {
      total: range.total,
      byStatus: Object.fromEntries(byStatus.map((row) => [row.status, Number(row.count)])),
      byModule: byModule.map((row) => ({ module: row.module, count: Number(row.count) })),
    };
  }

  cleanupExpired({ retentionDays = 180, now = this.now() } = {}) {
    const days = Number(retentionDays);
    if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error("AUDIT_RETENTION_DAYS must be between 1 and 3650");
    const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
    return Number(this.database.prepare("DELETE FROM operation_audit_events WHERE occurred_at<?").run(cutoff).changes || 0);
  }
}

export function createOperationAuditService({ db, env = process.env, logger = console, now } = {}) {
  const database = db?.db || db;
  if (!database?.prepare) throw new TypeError("A SQLite database is required for operation audit");
  const secretValues = [
    env.APP_ACCESS_TOKEN,
    env.AD_SERVICE_INTERNAL_TOKEN,
    env.DEEPSEEK_API_KEY,
    env.APP_ENCRYPTION_KEY,
  ];
  return new OperationAuditService({ database, logger, now, secretValues });
}
