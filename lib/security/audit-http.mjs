import { createIdentifier } from "../contracts/identifiers.mjs";
import { resolveAuditSourceIp } from "./audit-service.mjs";

function descriptor(module, action, extra = {}) {
  return { module, action, ...extra };
}

function schedulerDescriptor(method, pathname) {
  let match = pathname.match(/^\/api\/mabang\/account-profiles(?:\/([^/]+))?(?:\/(test))?$/);
  if (match) {
    if (match[2] === "test") return descriptor("mabang", "mabang.login.test", { actorIdentifier: null });
    if (method === "POST") return descriptor("mabang", "mabang.account.create");
    if (method === "PUT") return descriptor("mabang", "mabang.account.update");
    if (method === "DELETE") return descriptor("mabang", "mabang.account.delete");
  }
  match = pathname.match(/^\/api\/notifications\/dingtalk\/configs\/([^/]+)\/test$/);
  if (match && method === "POST") return descriptor("mabang", "mabang.dingtalk.test");
  match = pathname.match(/^\/api\/mabang\/scheduled-tasks(?:\/([^/]+))?(?:\/(enable|disable|run-now|duplicate|restore))?$/);
  if (match) {
    const [, taskId, suffix] = match;
    if (!taskId && method === "POST") return descriptor("mabang", "mabang.task.create");
    if (suffix === "enable") return descriptor("mabang", "mabang.task.enable", { taskId });
    if (suffix === "disable") return descriptor("mabang", "mabang.task.disable", { taskId });
    if (suffix === "run-now") return descriptor("mabang", "mabang.task.run_now", { taskId });
    if (suffix === "duplicate") return descriptor("mabang", "mabang.task.duplicate", { taskId });
    if (suffix === "restore") return descriptor("mabang", "mabang.task.restore", { taskId });
    if (method === "PUT") return descriptor("mabang", "mabang.task.update", { taskId });
    if (method === "DELETE") return descriptor("mabang", "mabang.task.delete", { taskId });
  }
  match = pathname.match(/^\/api\/mabang\/scheduled-runs\/([^/]+)\/retry$/);
  if (match && method === "POST") return descriptor("mabang", "mabang.task.run_now", { runId: match[1], metadata: { triggerType: "retry" } });
  match = pathname.match(/^\/api\/mabang\/export-files\/([^/]+)\/download$/);
  if (match && method === "GET") return descriptor("file", "file.download", { fileId: match[1], metadata: { kind: "mabang_history" } });
  return null;
}

export function describeAuditRequest(method, pathname) {
  if (pathname.startsWith("/api/audit/")) return null;
  if (pathname === "/api/auth/verify" && method === "POST") return descriptor("auth", "auth.verify");
  if (pathname === "/api/auth/logout" && method === "POST") return descriptor("auth", "auth.logout");
  if (pathname === "/api/product-center/imports" && method === "POST") return descriptor("product", "product.import.created");
  if (/^\/api\/product-center\/imports\/[^/]+\/apply$/.test(pathname) && method === "POST") return descriptor("product", "product.import.completed");
  if ((pathname === "/api/chrome/navigate" || pathname === "/api/chrome/open") && method === "POST") return descriptor("security", "chrome.navigation.run");
  if (pathname === "/api/image" && method === "GET") return descriptor("security", "image.proxy.fetch");
  if (pathname === "/api/ad-analyzer/status") return descriptor("ads", "ads.service.status");
  if (pathname === "/api/ads/analyze" && method === "POST") {
    return descriptor("ads", "ads.analysis.run", { related: [descriptor("ads", "ads.upload"), descriptor("file", "file.upload")] });
  }
  if (pathname === "/api/ads/chat" && method === "POST") return descriptor("ads", "deepseek.call", { metadata: { provider: "ads" } });
  if (pathname.startsWith("/api/ads/result/") && method === "GET") return descriptor("ads", "ads.result.download", { fileId: pathname.split("/").pop() });
  if (pathname === "/api/extract" || pathname === "/api/extract-and-analyze") {
    const related = pathname.endsWith("and-analyze") ? [descriptor("ai", "deepseek.call", { metadata: { provider: "competitor" } })] : [];
    return descriptor("competitor", "competitor.link_analysis.run", { related });
  }
  if (pathname === "/api/discover-top5-and-analyze") {
    return descriptor("competitor", "competitor.keyword_search.run", { related: [descriptor("ai", "deepseek.call", { metadata: { provider: "keyword" } })] });
  }
  if (pathname === "/api/analyze" || pathname === "/api/analyze-main-images") return descriptor("ai", "deepseek.call", { metadata: { provider: "competitor" } });
  if (pathname === "/api/mabang-data/login-test" && method === "POST") return descriptor("mabang", "mabang.login.test");
  if (pathname === "/api/mabang-data/export" && method === "POST") return descriptor("mabang", "mabang.export.create");
  const manualDownload = pathname.match(/^\/api\/mabang-data\/export-files\/([^/]+)\/download$/);
  if (manualDownload && method === "GET") return descriptor("file", "file.download", { fileId: manualDownload[1], metadata: { kind: "mabang_manual" } });
  const unifiedDownload = pathname.match(/^\/api\/files\/([^/]+)\/download$/);
  if (unifiedDownload && method === "GET") return descriptor("file", "file.download", { fileId: unifiedDownload[1] });
  if (pathname === "/api/files/lifecycle/scan" && method === "POST") return descriptor("file", "file.lifecycle.scan.requested");
  if (/^\/api\/files\/lifecycle\/reports\/[^/]+\/export$/.test(pathname) && method === "POST") {
    return descriptor("file", "file.lifecycle.report.exported");
  }
  return schedulerDescriptor(method, pathname);
}

function finalDescriptor(context, httpStatus) {
  const current = context.operation;
  if (httpStatus === 401 && context.pathname !== "/api/auth/verify") {
    return descriptor("auth", context.hadAuthorization ? "auth.token.invalid" : "auth.access.denied", {
      metadata: { requestedAction: current?.action || "protected_api" },
    });
  }
  if (!current) return null;
  if (context.pathname === "/api/auth/verify") {
    return descriptor("auth", httpStatus < 400 ? "auth.verify.success" : "auth.verify.failed");
  }
  if (current.action === "chrome.navigation.run" && httpStatus >= 400) return { ...current, action: "chrome.navigation.rejected" };
  if (current.action === "image.proxy.fetch" && httpStatus >= 400) return { ...current, action: "image.proxy.rejected" };
  if (current.action.startsWith("product.import.") && httpStatus >= 400) return { ...current, action: "product.import.failed" };
  if (current.action === "file.download" && context.annotations.metadata?.sourceType === "system_file_lifecycle_report" && httpStatus < 400) {
    return { ...current, action: "file.lifecycle.report.downloaded" };
  }
  if (current.action === "file.download" && httpStatus >= 400 && /(?:PATH|ACCESS_DENIED|INVALID_FILE_ID|SYMLINK)/i.test(String(context.annotations.errorCode || ""))) {
    return { ...current, action: "file.path.rejected" };
  }
  if (current.action === "file.download" && httpStatus >= 400 && /(?:MISSING|INTEGRITY|NOT_AVAILABLE|NOT_FOUND)/i.test(String(context.annotations.errorCode || ""))) {
    return { ...current, action: "file.download.failed" };
  }
  if (current.action === "file.download" && httpStatus >= 400) return { ...current, action: "file.download.rejected" };
  return current;
}

export function createHttpAuditContext(req, url, { trustedProxies = new Set(), now = () => new Date() } = {}) {
  const startedAt = now();
  const context = {
    requestId: createIdentifier(),
    startedAt,
    pathname: url.pathname,
    httpMethod: String(req.method || "GET").toUpperCase(),
    sourceIp: resolveAuditSourceIp(req, trustedProxies),
    actorType: req.headers?.authorization ? "authenticated_session" : "local_session",
    hadAuthorization: Boolean(req.headers?.authorization),
    operation: describeAuditRequest(String(req.method || "GET").toUpperCase(), url.pathname),
    annotations: {},
    related: [],
    setOperation(module, action, extra = {}) {
      this.operation = descriptor(module, action, extra);
    },
    annotate(values = {}) {
      Object.assign(this.annotations, values);
    },
    addRelated(module, action, extra = {}) {
      this.related.push(descriptor(module, action, extra));
    },
  };
  req.auditContext = context;
  return context;
}

export function completeHttpAudit(audit, context, { httpStatus = 200, error = null, now = () => new Date() } = {}) {
  const primary = finalDescriptor(context, httpStatus);
  if (!primary) return [];
  const finishedAt = now();
  const status = httpStatus >= 400 ? "failed" : "success";
  const base = {
    requestId: context.requestId,
    occurredAt: context.startedAt,
    httpMethod: context.httpMethod,
    requestPath: context.pathname,
    status,
    httpStatus,
    durationMs: Math.max(0, finishedAt - context.startedAt),
    sourceIp: context.sourceIp,
    actorType: context.actorType,
    errorStage: context.annotations.errorStage,
    errorCode: context.annotations.errorCode,
    errorSummary: context.annotations.errorSummary || error,
  };
  const entries = [primary, ...(primary.related || []), ...context.related];
  return entries.map((item) => audit.recordSafely({
    ...base,
    status: item.status || base.status,
    httpStatus: item.httpStatus ?? base.httpStatus,
    module: item.module,
    action: item.action,
    actorIdentifier: context.annotations.actorIdentifier || item.actorIdentifier,
    taskId: context.annotations.taskId || item.taskId,
    runId: context.annotations.runId || item.runId,
    fileId: context.annotations.fileId || item.fileId,
    errorStage: item.errorStage || base.errorStage,
    errorCode: item.errorCode || base.errorCode,
    errorSummary: item.errorSummary || base.errorSummary,
    metadata: { ...(item.metadata || {}), ...(context.annotations.metadata || {}) },
  })).filter(Boolean);
}
