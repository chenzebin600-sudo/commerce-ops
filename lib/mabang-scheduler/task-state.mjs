import { redactAuditText } from "../security/audit-service.mjs";

export const TASK_DELETED_CODE = "TASK_DELETED";
export const TASK_DELETED_MESSAGE = "该定时任务已删除，不能继续执行。如需使用，请先恢复任务。";
export const TASK_ACCOUNT_UNAVAILABLE_CODE = "TASK_ACCOUNT_UNAVAILABLE";
export const TASK_ACCOUNT_UNAVAILABLE_MESSAGE = "该任务关联的马帮账号不存在或已停用，暂时不能启用。";

export class TaskStateError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = "TaskStateError";
    this.code = code;
    this.status = status;
  }
}

export function assertTaskNotDeleted(task) {
  if (task?.deletedAt) throw new TaskStateError(TASK_DELETED_CODE, TASK_DELETED_MESSAGE);
  return task;
}

export function assertTaskAccountAvailable(task) {
  if (!task?.accountAvailable || !task?.accountEnabled) {
    throw new TaskStateError(TASK_ACCOUNT_UNAVAILABLE_CODE, TASK_ACCOUNT_UNAVAILABLE_MESSAGE);
  }
  return task;
}

export function sanitizeDeletedBy(value) {
  const actor = String(value || "local_session").trim().toLowerCase();
  return ["authenticated_session", "local_session", "scheduler"].includes(actor) ? actor : "local_session";
}

export function sanitizeDeleteReason(value, env = process.env) {
  const source = String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (!source) return null;
  if (source.length > 240) {
    throw new TaskStateError("DELETE_REASON_TOO_LONG", "删除原因不能超过 240 个字符。", 400);
  }
  return redactAuditText(source, {
    secretValues: [
      env.APP_ACCESS_TOKEN,
      env.AD_SERVICE_INTERNAL_TOKEN,
      env.DEEPSEEK_API_KEY,
      env.APP_ENCRYPTION_KEY,
    ],
  }).slice(0, 240);
}
