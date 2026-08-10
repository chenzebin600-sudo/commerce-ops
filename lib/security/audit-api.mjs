import { AUDIT_ACTION_LABELS, redactAuditText } from "./audit-service.mjs";

const CLIENT_ACTIONS = new Map([
  ["competitor.export.download", "competitor"],
  ["competitor.keyword_export.download", "competitor"],
]);

function sendJson(res, status, data) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
  return true;
}

async function readJson(req, maxBytes = 16 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function queryFilters(searchParams) {
  return {
    page: searchParams.get("page"),
    pageSize: searchParams.get("pageSize"),
    start: searchParams.get("start"),
    end: searchParams.get("end"),
    module: searchParams.get("module"),
    action: searchParams.get("action"),
    status: searchParams.get("status"),
    httpStatus: searchParams.get("httpStatus"),
    taskId: searchParams.get("taskId"),
    runId: searchParams.get("runId"),
    fileId: searchParams.get("fileId"),
  };
}

export function createAuditApi({ audit, retentionDays = Number(process.env.AUDIT_RETENTION_DAYS || 180) }) {
  return async function handleAuditApi(req, res, url) {
    const pathname = url.pathname;
    if (!pathname.startsWith("/api/audit/")) return false;
    try {
      if (pathname === "/api/audit/events" && req.method === "GET") {
        return sendJson(res, 200, { ok: true, ...await audit.queryEvents(queryFilters(url.searchParams)), actionLabels: AUDIT_ACTION_LABELS });
      }
      const detail = pathname.match(/^\/api\/audit\/events\/([A-Za-z0-9-]+)$/);
      if (detail && req.method === "GET") {
        const event = await audit.getEvent(detail[1]);
        return event ? sendJson(res, 200, { ok: true, event }) : sendJson(res, 404, { ok: false, error: "Audit event not found" });
      }
      if (pathname === "/api/audit/summary" && req.method === "GET") {
        return sendJson(res, 200, { ok: true, summary: await audit.summary({ start: url.searchParams.get("start"), end: url.searchParams.get("end") }) });
      }
      if (pathname === "/api/audit/client-action" && req.method === "POST") {
        const body = await readJson(req);
        const action = String(body.action || "");
        const module = CLIENT_ACTIONS.get(action);
        if (!module) return sendJson(res, 400, { ok: false, error: "Unsupported client audit action" });
        const context = req.auditContext || {};
        await audit.recordSafely({
          requestId: context.requestId,
          occurredAt: context.startedAt,
          module,
          action,
          httpMethod: req.method,
          requestPath: pathname,
          status: "success",
          httpStatus: 200,
          durationMs: Date.now() - (context.startedAt?.getTime?.() || Date.now()),
          sourceIp: context.sourceIp,
          actorType: context.actorType,
          metadata: { kind: body.kind === "keyword" ? "keyword" : "link", priority: "low" },
        });
        return sendJson(res, 200, { ok: true });
      }
      if (pathname === "/api/audit/cleanup" && req.method === "POST") {
        const deleted = await audit.cleanupExpired({ retentionDays });
        const context = req.auditContext || {};
        await audit.recordSafely({
          requestId: context.requestId,
          occurredAt: context.startedAt,
          module: "audit",
          action: "audit.retention.cleanup",
          httpMethod: req.method,
          requestPath: pathname,
          status: "success",
          httpStatus: 200,
          durationMs: Date.now() - (context.startedAt?.getTime?.() || Date.now()),
          sourceIp: context.sourceIp,
          actorType: context.actorType,
          metadata: { retentionDays, cleanupDeleted: deleted },
        });
        return sendJson(res, 200, { ok: true, deleted, retentionDays });
      }
      return sendJson(res, 405, { ok: false, error: "Method not allowed" });
    } catch (error) {
      return sendJson(res, 400, { ok: false, error: redactAuditText(error).slice(0, 180) });
    }
  };
}
