import {
  FILE_ERROR_CODES,
  FilePolicyError,
  publicFileError,
  safeContentDisposition,
  validateFileId,
} from "../security/file-policy.mjs";
import { toPublicExportFile } from "./export-file-service.mjs";

function sendJson(res, status, data) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
  return true;
}

function optionalDate(value, name) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new FilePolicyError(FILE_ERROR_CODES.FILE_PATH_INVALID);
  if (name === "createdTo" && /^\d{4}-\d{2}-\d{2}$/.test(value)) date.setUTCHours(23, 59, 59, 999);
  return date.toISOString();
}

function fileMatch(pathname) {
  const match = pathname.match(/^\/api\/files\/([^/]+)(?:\/(download))?$/);
  return match ? { id: decodeURIComponent(match[1]), download: match[2] === "download" } : null;
}

export function createFileApi({ fileService }) {
  return async function handleFileApi(req, res, url) {
    if (url.pathname === "/api/files") {
      if (req.method !== "GET") return sendJson(res, 405, { ok: false, error: "Method not allowed" });
      try {
        const result = await fileService.listFiles({
          sourceType: url.searchParams.get("source_type"),
          scope: url.searchParams.get("scope"),
          taskId: url.searchParams.get("task_id"),
          runId: url.searchParams.get("run_id"),
          status: url.searchParams.get("status"),
          createdFrom: optionalDate(url.searchParams.get("created_from"), "createdFrom"),
          createdTo: optionalDate(url.searchParams.get("created_to"), "createdTo"),
          page: url.searchParams.get("page"),
          pageSize: url.searchParams.get("page_size"),
        });
        return sendJson(res, 200, { ...result, ok: true, files: result.files.map(toPublicExportFile) });
      } catch (error) {
        req.auditContext?.annotate({ errorCode: error?.code || "FILE_QUERY_FAILED", errorSummary: error });
        const safe = publicFileError(error);
        return sendJson(res, safe.status || 400, { ok: false, code: safe.code, error: safe.message });
      }
    }

    const match = fileMatch(url.pathname);
    if (!match) return false;
    if (req.method !== "GET") return sendJson(res, 405, { ok: false, error: "Method not allowed" });
    try {
      const fileId = validateFileId(match.id);
      if (!match.download) {
        const file = fileService.getFile(fileId);
        if (!file) throw new FilePolicyError(FILE_ERROR_CODES.FILE_NOT_FOUND);
        return sendJson(res, 200, { ok: true, file: toPublicExportFile(file) });
      }
      const { file, content } = await fileService.download(fileId);
      req.auditContext?.annotate({
        fileId,
        taskId: file.taskId,
        runId: file.runId,
        metadata: { sourceType: file.sourceType, generatedBy: file.metadata?.generatedBy },
      });
      res.writeHead(200, {
        "content-type": file.mimeType,
        "content-disposition": safeContentDisposition(file.originalFilename),
        "content-length": content.length,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      });
      res.end(content);
      return true;
    } catch (error) {
      req.auditContext?.annotate({ errorCode: error?.code || FILE_ERROR_CODES.FILE_ACCESS_DENIED, errorSummary: error });
      const safe = publicFileError(error);
      return sendJson(res, safe.status || 400, { ok: false, code: safe.code, error: safe.message });
    }
  };
}
