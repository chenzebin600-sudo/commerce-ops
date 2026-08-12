import { validateFileId } from "../security/file-policy.mjs";

function sendJson(res, status, data) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
  return true;
}

async function readJson(req, maxBytes = 8 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error("Request body is too large"), { code: "REQUEST_TOO_LARGE" });
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function reason(body, fallback) {
  return String(body?.reason || fallback).replace(/[\r\n\t]+/g, " ").trim().slice(0, 240) || fallback;
}

function errorStatus(error) {
  if (error?.code === "LIFECYCLE_ITEM_NOT_FOUND") return 404;
  if (/CONFLICT|NOT_APPROVED|NOT_ELIGIBLE|STATE_INVALID|CHANGED|INVALID/.test(String(error?.code || ""))) return 409;
  return 400;
}

export function createFileReviewApi({ service }) {
  return async function handleFileReviewApi(req, res, url) {
    const pathname = url.pathname;
    if (!pathname.startsWith("/api/files/lifecycle/")) return false;
    try {
      const classify = pathname.match(/^\/api\/files\/lifecycle\/reports\/([^/]+)\/classify$/);
      if (classify && req.method === "POST") {
        const scanId = validateFileId(decodeURIComponent(classify[1]));
        const result = await service.classifyScan(scanId);
        req.auditContext?.annotate({ metadata: { scanId, result: "classified", fileCount: result.matchedCount } });
        return sendJson(res, 200, { ok: true, matchedCount: result.matchedCount, unmatchedItemCount: result.unmatchedItemCount, summary: result.summary });
      }
      if (pathname === "/api/files/lifecycle/quarantine-records" && req.method === "GET") {
        return sendJson(res, 200, { ok: true, ...await service.listQuarantineRecords({ page: url.searchParams.get("page"), pageSize: url.searchParams.get("page_size") }) });
      }
      const match = pathname.match(/^\/api\/files\/lifecycle\/items\/([^/]+)\/(register|protect|reject|approve-quarantine|quarantine|restore|delete)$/);
      if (!match || req.method !== "POST") return false;
      const itemId = validateFileId(decodeURIComponent(match[1]));
      const action = match[2];
      const body = await readJson(req);
      const context = { actor: "local_operator", reason: reason(body, `manual_${action}`) };
      if (action === "register") {
        const file = await service.registerItem(itemId, context);
        req.auditContext?.annotate({ fileId: file.id, metadata: { sourceType: file.sourceType, result: "registered" } });
        return sendJson(res, 200, { ok: true, file: { id: file.id, sourceType: file.sourceType, status: file.status, registeredAt: file.registeredAt } });
      }
      if (action === "protect") {
        const item = await service.protectItem(itemId, context);
        return sendJson(res, 200, { ok: true, item: { id: item.id, reviewStatus: item.reviewStatus, reviewedAt: item.reviewedAt } });
      }
      if (action === "reject") {
        const item = await service.rejectItem(itemId, context);
        return sendJson(res, 200, { ok: true, item: { id: item.id, reviewStatus: item.reviewStatus, reviewedAt: item.reviewedAt } });
      }
      if (action === "approve-quarantine") {
        const item = await service.approveQuarantine(itemId, context);
        return sendJson(res, 200, { ok: true, item: { id: item.id, reviewStatus: item.reviewStatus, reviewedAt: item.reviewedAt } });
      }
      if (action === "quarantine") {
        const record = await service.quarantineItem(itemId, context);
        return sendJson(res, 200, { ok: true, record });
      }
      if (action === "restore") {
        const record = await service.restoreItem(itemId, context);
        return sendJson(res, 200, { ok: true, record });
      }
      await service.rejectPermanentDeletion(itemId);
      return true;
    } catch (error) {
      const code = String(error?.code || "FILE_REVIEW_REQUEST_FAILED").slice(0, 80);
      req.auditContext?.annotate({ errorCode: code, errorSummary: "Managed file request failed" });
      return sendJson(res, errorStatus(error), { ok: false, error: "File review request failed", code });
    }
  };
}
