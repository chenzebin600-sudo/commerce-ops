const RUN_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/;
const AGENT_NAME = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const VERSION = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
const STATUSES = new Set(["running", "succeeded", "failed"]);

function sendJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
  return true;
}

function optional(searchParams, name, pattern = null) {
  const value = String(searchParams.get(name) || "").trim();
  if (!value) return null;
  if (pattern && !pattern.test(value)) {
    throw Object.assign(new TypeError(`${name} is invalid`), { code: "AGENT_OBSERVABILITY_QUERY_INVALID" });
  }
  return value;
}

function optionalDate(searchParams, name) {
  const value = optional(searchParams, name);
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw Object.assign(new TypeError(`${name} is invalid`), { code: "AGENT_OBSERVABILITY_QUERY_INVALID" });
  }
  return date.toISOString();
}

function queryFilters(searchParams) {
  const status = optional(searchParams, "status");
  if (status && !STATUSES.has(status)) {
    throw Object.assign(new TypeError("status is invalid"), { code: "AGENT_OBSERVABILITY_QUERY_INVALID" });
  }
  return {
    agent: optional(searchParams, "agent", AGENT_NAME),
    version: optional(searchParams, "version", VERSION),
    requestId: optional(searchParams, "requestId", RUN_ID),
    status,
    start: optionalDate(searchParams, "start"),
    end: optionalDate(searchParams, "end"),
    page: searchParams.get("page"),
    pageSize: searchParams.get("pageSize"),
  };
}

export function createAgentObservabilityApi({ service } = {}) {
  if (!service || typeof service.status !== "function" || typeof service.listRuns !== "function"
    || typeof service.getRun !== "function" || typeof service.summary !== "function") {
    throw new TypeError("Agent observability service is required");
  }
  return async function handleAgentObservabilityApi(req, res, url) {
    if (!url.pathname.startsWith("/api/ai/observability")) return false;
    if (req.method !== "GET") return sendJson(res, 405, { ok: false, error: "Method not allowed" });
    try {
      if (url.pathname === "/api/ai/observability/status") {
        req.auditContext?.setOperation("ai", "agent.observability.read");
        return sendJson(res, 200, { ok: true, ...(await service.status()) });
      }
      if (url.pathname === "/api/ai/observability/summary") {
        req.auditContext?.setOperation("ai", "agent.observability.read");
        return sendJson(res, 200, { ok: true, summary: await service.summary(queryFilters(url.searchParams)) });
      }
      if (url.pathname === "/api/ai/observability/runs") {
        req.auditContext?.setOperation("ai", "agent.observability.read");
        return sendJson(res, 200, { ok: true, ...(await service.listRuns(queryFilters(url.searchParams))) });
      }
      const detail = url.pathname.match(/^\/api\/ai\/observability\/runs\/([^/]+)$/);
      if (detail) {
        const runId = decodeURIComponent(detail[1]);
        if (!RUN_ID.test(runId)) return sendJson(res, 400, { ok: false, error: "runId is invalid" });
        const run = await service.getRun(runId);
        req.auditContext?.setOperation("ai", "agent.observability.read");
        req.auditContext?.annotate({ runId });
        return run
          ? sendJson(res, 200, { ok: true, run })
          : sendJson(res, 404, { ok: false, error: "Agent run not found" });
      }
      return sendJson(res, 404, { ok: false, error: "Agent observability API not found" });
    } catch (error) {
      if (error?.code === "AGENT_OBSERVABILITY_QUERY_INVALID" || error instanceof URIError) {
        return sendJson(res, 400, { ok: false, code: error.code, error: error.message });
      }
      throw error;
    }
  };
}
