import { validateFileId } from "../security/file-policy.mjs";

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

function itemFilters(searchParams) {
  return {
    classification: searchParams.get("classification"),
    sourceType: searchParams.get("source_type"),
    start: searchParams.get("start"),
    end: searchParams.get("end"),
    page: searchParams.get("page"),
    pageSize: searchParams.get("page_size"),
  };
}

export function createFileLifecycleApi({ service }) {
  return async function handleFileLifecycleApi(req, res, url) {
    const pathname = url.pathname;
    if (!pathname.startsWith("/api/files/lifecycle/")) return false;
    try {
      if (pathname === "/api/files/lifecycle/scan" && req.method === "POST") {
        const body = await readJson(req);
        const result = service.startScan(body.scopes ?? "all");
        req.auditContext?.annotate({ metadata: { scanId: result.scan?.id, result: result.reused ? "already_running" : "started" } });
        return sendJson(res, result.reused ? 200 : 202, { ok: true, reused: result.reused, scan: result.scan });
      }
      if (pathname === "/api/files/lifecycle/reports" && req.method === "GET") {
        return sendJson(res, 200, { ok: true, ...service.listReports({ page: url.searchParams.get("page"), pageSize: url.searchParams.get("page_size") }) });
      }
      if (pathname === "/api/files/lifecycle/summary" && req.method === "GET") {
        return sendJson(res, 200, { ok: true, scan: service.summary() });
      }
      const report = pathname.match(/^\/api\/files\/lifecycle\/reports\/([^/]+)$/);
      if (report && req.method === "GET") {
        const scanId = validateFileId(decodeURIComponent(report[1]));
        const result = service.getReport(scanId, itemFilters(url.searchParams));
        return result ? sendJson(res, 200, { ok: true, ...result }) : sendJson(res, 404, { ok: false, error: "Lifecycle report not found" });
      }
      const exportMatch = pathname.match(/^\/api\/files\/lifecycle\/reports\/([^/]+)\/export$/);
      if (exportMatch && req.method === "POST") {
        const scanId = validateFileId(decodeURIComponent(exportMatch[1]));
        const file = await service.exportReport(scanId);
        req.auditContext?.annotate({ fileId: file.id, metadata: { scanId, sourceType: file.sourceType } });
        return sendJson(res, 201, { ok: true, fileId: file.id, downloadUrl: `/api/files/${file.id}/download` });
      }
      return sendJson(res, 405, { ok: false, error: "Method not allowed" });
    } catch (error) {
      req.auditContext?.annotate({ errorCode: error?.code || "LIFECYCLE_REQUEST_FAILED", errorSummary: error });
      return sendJson(res, 400, { ok: false, error: "File lifecycle request failed" });
    }
  };
}
