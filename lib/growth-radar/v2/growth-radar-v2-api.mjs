import { GrowthRadarV2Error } from "./growth-radar-v2-service.mjs";

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
  return true;
}

function pageFilters(url) {
  return {
    page: url.searchParams.get("page"),
    pageSize: url.searchParams.get("page_size"),
  };
}

function actor(req) {
  return req.auditContext?.annotations?.actorIdentifier
    || req.auditContext?.actorIdentifier
    || req.auditContext?.actorType
    || "local_session";
}

function booleanFilter(value, fallback = true) {
  if (value === null || value === undefined || value === "") return fallback;
  return !["0", "false", "no"].includes(String(value).trim().toLowerCase());
}

async function readJsonBody(req, maxBytes = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new GrowthRadarV2Error(
        "GROWTH_RADAR_V2_REQUEST_TOO_LARGE",
        413,
        "配置内容超过允许大小。",
      );
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new GrowthRadarV2Error(
      "GROWTH_RADAR_V2_INVALID_JSON",
      400,
      "配置内容不是有效的 JSON。",
    );
  }
}

export function createGrowthRadarV2Api({ service, accessPolicy }) {
  return async function handleGrowthRadarV2Api(req, res, url) {
    if (!url.pathname.startsWith("/api/growth-radar/v2/")) return false;
    try {
      if (url.pathname === "/api/growth-radar/v2/status" && req.method === "GET") {
        accessPolicy.assert("growth_radar.data.view");
        return sendJson(res, 200, { ok: true, status: await service.status() });
      }
      if (url.pathname === "/api/growth-radar/v2/analysis-runs" && req.method === "POST") {
        accessPolicy.assert("growth_radar.data.apply");
        const result = await service.analyze({ actorLabel: actor(req) });
        req.auditContext?.annotate({
          metadata: {
            analysisRunId: result.run.id,
            result: result.reused ? "reused" : "published",
            ruleVersion: result.run.qualitySummary?.metricsVersion || "GRV2-METRICS-1.2.0",
          },
        });
        return sendJson(res, result.reused ? 200 : 201, { ok: true, ...result });
      }
      if (url.pathname === "/api/growth-radar/v2/configuration" && req.method === "GET") {
        accessPolicy.assert("growth_radar.data.view");
        return sendJson(res, 200, { ok: true, configuration: await service.configuration() });
      }
      if (url.pathname === "/api/growth-radar/v2/configuration/country-mappings" && req.method === "PUT") {
        accessPolicy.assert("growth_radar.data.apply");
        const result = await service.saveCountryMappings(await readJsonBody(req), {
          actorLabel: actor(req),
        });
        req.auditContext?.annotate({
          metadata: {
            version: result.set.version,
            rowCount: result.mappings.length,
            result: result.reused ? "reused" : "activated",
          },
        });
        return sendJson(res, result.reused ? 200 : 201, { ok: true, ...result });
      }
      if (url.pathname === "/api/growth-radar/v2/configuration/rules" && req.method === "PUT") {
        accessPolicy.assert("growth_radar.data.apply");
        const result = await service.saveRuleSet(await readJsonBody(req), {
          actorLabel: actor(req),
        });
        req.auditContext?.annotate({
          metadata: {
            version: result.ruleSet.version,
            result: result.reused ? "reused" : "activated",
          },
        });
        return sendJson(res, result.reused ? 200 : 201, { ok: true, ...result });
      }
      if (url.pathname === "/api/growth-radar/v2/overview" && req.method === "GET") {
        accessPolicy.assert("growth_radar.data.view");
        return sendJson(res, 200, { ok: true, ...(await service.overview()) });
      }
      if (url.pathname === "/api/growth-radar/v2/assistant/workspace" && req.method === "GET") {
        accessPolicy.assert("growth_radar.data.view");
        return sendJson(res, 200, {
          ok: true,
          ...(await service.assistantWorkspace({
            managerId: url.searchParams.get("owner_user_id"),
            maxTasks: url.searchParams.get("max_tasks"),
          })),
        });
      }
      if (url.pathname === "/api/growth-radar/v2/assistant/configuration" && req.method === "GET") {
        accessPolicy.assert("growth_radar.data.view");
        return sendJson(res, 200, {
          ok: true,
          ...(await service.assistantConfiguration()),
        });
      }
      if (url.pathname === "/api/growth-radar/v2/tasks" && req.method === "GET") {
        accessPolicy.assert("growth_radar.data.view");
        return sendJson(res, 200, {
          ok: true,
          ...(await service.listTasks({
            ...pageFilters(url),
            ownerUserId: url.searchParams.get("owner_user_id"),
            shopId: url.searchParams.get("shop_id"),
            taskType: url.searchParams.get("task_type"),
            priority: url.searchParams.get("priority"),
            status: url.searchParams.get("status"),
            activeOnly: booleanFilter(url.searchParams.get("active_only")),
          })),
        });
      }
      const taskMatch = url.pathname.match(
        /^\/api\/growth-radar\/v2\/tasks\/([^/]+)(?:\/(status|assignment|schedule))?$/i,
      );
      if (taskMatch && req.method === "GET" && !taskMatch[2]) {
        accessPolicy.assert("growth_radar.data.view");
        return sendJson(res, 200, {
          ok: true,
          ...(await service.taskDetail(decodeURIComponent(taskMatch[1]))),
        });
      }
      if (taskMatch && req.method === "PATCH" && taskMatch[2]) {
        accessPolicy.assert("growth_radar.data.apply");
        const taskId = decodeURIComponent(taskMatch[1]);
        const body = await readJsonBody(req);
        const context = { actorLabel: actor(req) };
        const result = taskMatch[2] === "status"
          ? await service.transitionTask(taskId, body, context)
          : taskMatch[2] === "assignment"
            ? await service.assignTask(taskId, body, context)
            : await service.scheduleTask(taskId, body, context);
        req.auditContext?.annotate({
          metadata: {
            taskId,
            taskStatus: result.item?.status || null,
            taskRevision: result.item?.revision || null,
            result: result.replayed ? "idempotent_replay" : taskMatch[2],
          },
        });
        return sendJson(res, 200, { ok: true, ...result });
      }
      if (url.pathname === "/api/growth-radar/v2/directions" && req.method === "GET") {
        accessPolicy.assert("growth_radar.data.view");
        return sendJson(res, 200, { ok: true, ...(await service.directions()) });
      }
      if (url.pathname === "/api/growth-radar/v2/assortment" && req.method === "GET") {
        accessPolicy.assert("growth_radar.data.view");
        return sendJson(res, 200, {
          ok: true,
          ...(await service.listAssortment({
            ...pageFilters(url),
            categoryL1: url.searchParams.get("category_l1"),
            categoryL2: url.searchParams.get("category_l2"),
            countryCode: url.searchParams.get("country_code"),
            productStatus: url.searchParams.get("product_status"),
            qualityStatus: url.searchParams.get("quality_status"),
            ruleCode: url.searchParams.get("rule_code"),
            search: url.searchParams.get("q"),
          })),
        });
      }
      if (url.pathname === "/api/growth-radar/v2/signals" && req.method === "GET") {
        accessPolicy.assert("growth_radar.data.view");
        return sendJson(res, 200, {
          ok: true,
          ...(await service.listSignals({
            ...pageFilters(url),
            signalType: url.searchParams.get("signal_type"),
            ruleCode: url.searchParams.get("rule_code"),
            severity: url.searchParams.get("severity"),
            shopId: url.searchParams.get("shop_id"),
            sku: url.searchParams.get("sku"),
            countryCode: url.searchParams.get("country_code"),
          })),
        });
      }
      if (url.pathname === "/api/growth-radar/v2/stores" && req.method === "GET") {
        accessPolicy.assert("growth_radar.data.view");
        return sendJson(res, 200, {
          ok: true,
          ...(await service.listStores({
            ...pageFilters(url),
            platform: url.searchParams.get("platform"),
            countryCode: url.searchParams.get("country_code"),
            ownerUserId: url.searchParams.get("owner_user_id"),
          })),
        });
      }
      const storeMatch = url.pathname.match(/^\/api\/growth-radar\/v2\/stores\/([0-9a-z-]+)$/i);
      if (storeMatch && req.method === "GET") {
        accessPolicy.assert("growth_radar.data.view", storeMatch[1]);
        return sendJson(res, 200, {
          ok: true,
          ...(await service.storeDetail(storeMatch[1], pageFilters(url))),
        });
      }
      const skuMatch = url.pathname.match(/^\/api\/growth-radar\/v2\/skus\/([^/]+)$/i);
      if (skuMatch && req.method === "GET") {
        accessPolicy.assert("growth_radar.data.view");
        return sendJson(res, 200, {
          ok: true,
          ...(await service.skuDetail(decodeURIComponent(skuMatch[1]))),
        });
      }
      return sendJson(res, 404, {
        ok: false,
        code: "GROWTH_RADAR_V2_API_NOT_FOUND",
        error: "Growth Radar V2 接口不存在。",
      });
    } catch (error) {
      req.auditContext?.annotate({
        errorStage: "growth_radar_v2",
        errorCode: error?.code || "GROWTH_RADAR_V2_FAILED",
        errorSummary: error,
      });
      const isPublic = error instanceof GrowthRadarV2Error
        || String(error?.code || "").startsWith("GROWTH_RADAR_");
      const status = isPublic ? Number(error.status || 400) : 500;
      const code = isPublic ? String(error.code) : "GROWTH_RADAR_V2_FAILED";
      const message = isPublic
        ? String(error.message).split(/\r?\n/, 1)[0].slice(0, 240)
        : "Growth Radar V2 数据操作失败。";
      return sendJson(res, status, {
        ok: false,
        code,
        issue_code: code,
        error: message,
        ...(error?.currentItem ? { currentItem: error.currentItem } : {}),
      });
    }
  };
}
