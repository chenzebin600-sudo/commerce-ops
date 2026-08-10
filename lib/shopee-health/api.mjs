function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": String(body.length), "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(body);
  return true;
}

async function readJson(req, limit = 512 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("请求内容超过限制。"), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Object.assign(new Error("请求 JSON 格式无效。"), { status: 400 }); }
}

function matchId(pathname, prefix, suffix = "") {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return pathname.match(new RegExp(`^${escaped}/([^/]+)${suffix ? `/${suffix}` : ""}$`));
}

export function createShopeeHealthApi({ service, repository }) {
  return async function handleShopeeHealthApi(req, res, url) {
    if (!url.pathname.startsWith("/api/shopee-health")) return false;
    try {
      const pathname = url.pathname;
      if (pathname === "/api/shopee-health/dashboard" && req.method === "GET") {
        return sendJson(res, 200, { ok: true, data: service.dashboard({ days: url.searchParams.get("days") }) });
      }
      if (pathname === "/api/shopee-health/settings") {
        if (req.method === "GET") return sendJson(res, 200, { ok: true, data: repository.getSettings() });
        if (req.method === "PUT") {
          const body = await readJson(req);
          const settings = await service.saveSettings(body, body.actorName || "当前用户");
          req.auditContext?.annotate({ metadata: { tokenRotated: Boolean(body.tokenKey), scheduleTime: settings.scheduleTime } });
          return sendJson(res, 200, { ok: true, data: settings });
        }
        return sendJson(res, 405, { ok: false, error: "Method not allowed" });
      }
      if (pathname === "/api/shopee-health/settings/test-key" && req.method === "POST") {
        return sendJson(res, 200, { ok: true, data: await service.testKey() });
      }
      if (pathname === "/api/shopee-health/thresholds") {
        if (req.method === "GET") return sendJson(res, 200, { ok: true, data: repository.listThresholds() });
        if (req.method === "PUT") {
          const body = await readJson(req);
          if (!Array.isArray(body.items)) throw new Error("阈值配置必须是数组。");
          return sendJson(res, 200, { ok: true, data: repository.saveThresholds(body.items, body.actorName || "当前用户") });
        }
        return sendJson(res, 405, { ok: false, error: "Method not allowed" });
      }
      if (pathname === "/api/shopee-health/collect" && req.method === "POST") {
        const result = service.startCollection("manual");
        req.auditContext?.annotate({ taskId: result.run?.id, metadata: { started: result.started } });
        return sendJson(res, result.started ? 202 : 409, { ok: result.started, data: result, error: result.started ? undefined : "已有店铺健康采集任务正在执行。" });
      }
      if (pathname === "/api/shopee-health/runs" && req.method === "GET") {
        return sendJson(res, 200, { ok: true, data: repository.listRuns(url.searchParams.get("limit")) });
      }
      if (pathname === "/api/shopee-health/issues" && req.method === "GET") {
        return sendJson(res, 200, { ok: true, data: repository.listIssues({
          status: url.searchParams.get("status") || "active", severity: url.searchParams.get("severity") || "",
          country: url.searchParams.get("country") || "", shopId: url.searchParams.get("shop_id") || "",
          limit: url.searchParams.get("limit") || 200,
        }) });
      }
      if (pathname === "/api/shopee-health/appeals") {
        if (req.method === "GET") return sendJson(res, 200, { ok: true, data: repository.listAppeals({ status: url.searchParams.get("status") || "", assigneeUserId: url.searchParams.get("assignee") || "" }) });
        if (req.method === "POST") {
          const body = await readJson(req);
          const appeal = repository.createAppeal({ ...body, createdBy: body.createdBy || "current-user", assigneeName: body.assigneeName || "我", assigneeUserId: body.assigneeUserId || "current-user" });
          req.auditContext?.annotate({ taskId: appeal.id, metadata: { issueId: appeal.issueId } });
          return sendJson(res, 201, { ok: true, data: appeal });
        }
        return sendJson(res, 405, { ok: false, error: "Method not allowed" });
      }
      let match = matchId(pathname, "/api/shopee-health/appeals");
      if (match) {
        const id = decodeURIComponent(match[1]);
        if (req.method === "GET") {
          const appeal = repository.getAppeal(id);
          if (!appeal) return sendJson(res, 404, { ok: false, error: "申诉工单不存在。" });
          return sendJson(res, 200, { ok: true, data: { ...appeal, events: repository.listAppealEvents(id) } });
        }
        if (req.method === "PUT") {
          const body = await readJson(req);
          return sendJson(res, 200, { ok: true, data: repository.updateAppeal(id, body, { userId: body.actorUserId || "current-user", name: body.actorName || "我" }) });
        }
        return sendJson(res, 405, { ok: false, error: "Method not allowed" });
      }
      if (pathname === "/api/shopee-health/notifications" && req.method === "GET") {
        return sendJson(res, 200, { ok: true, data: { items: repository.listNotifications(url.searchParams.get("limit")), unread: repository.unreadNotificationCount() } });
      }
      if (pathname === "/api/shopee-health/notifications/read-all" && req.method === "POST") {
        return sendJson(res, 200, { ok: true, data: { updated: repository.markNotificationsRead() } });
      }
      match = matchId(pathname, "/api/shopee-health/notifications", "read");
      if (match && req.method === "POST") return sendJson(res, 200, { ok: true, data: { updated: repository.markNotificationsRead(decodeURIComponent(match[1])) } });
      return sendJson(res, 404, { ok: false, error: "API route not found" });
    } catch (error) {
      req.auditContext?.annotate({ errorCode: error.code || "SHOPEE_HEALTH_API_FAILED", errorSummary: error });
      return sendJson(res, error.status || (/不存在/.test(error.message) ? 404 : 400), { ok: false, code: error.code, error: error.message || "店铺健康操作失败。" });
    }
  };
}
