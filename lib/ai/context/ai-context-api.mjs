import { assertAiContextType } from "./ai-context-contracts.mjs";

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
  return true;
}

export function createAiContextApi({ service }) {
  if (!service || typeof service.get !== "function") throw new TypeError("AI context service is required");
  return async function handleAiContextApi(req, res, url) {
    const match = url.pathname.match(/^\/api\/ai\/context\/(shop|product|sku)\/([^/]+)$/i);
    if (!match) return false;
    if (req.method !== "GET") return sendJson(res, 405, { ok: false, error: "Method not allowed" });
    try {
      const type = assertAiContextType(match[1]);
      const id = decodeURIComponent(match[2]);
      const context = await service.get(type, id);
      req.auditContext?.setOperation("ai", "ai.context.read");
      req.auditContext?.annotate({ metadata: { contextType: type, subjectId: id, contextVersion: context.contextVersion } });
      return sendJson(res, 200, { ok: true, context });
    } catch (error) {
      if (error?.code === "AI_CONTEXT_SUBJECT_NOT_FOUND") {
        return sendJson(res, 404, { ok: false, error: error.message, code: error.code });
      }
      if (error?.code === "AI_CONTEXT_TYPE_INVALID" || error?.code === "AI_CONTEXT_SUBJECT_INVALID" || error instanceof URIError) {
        return sendJson(res, 400, { ok: false, error: error.message, code: error.code || "AI_CONTEXT_SUBJECT_INVALID" });
      }
      throw error;
    }
  };
}
