async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw Object.assign(new Error("库存同步请求超过2MB限制。"), { status: 413, code: "INVENTORY_SYNC_REQUEST_TOO_LARGE" });
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function send(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(payload));
  return true;
}

function actor(req) {
  return req.auditContext?.annotations?.actorIdentifier
    || req.auditContext?.actorIdentifier
    || req.auditContext?.actorType
    || "local_session";
}

export function createInventorySyncApi({ service, lazadaRunMonitor = null }) {
  return async function handleInventorySyncApi(req, res, url) {
    if (!url.pathname.startsWith("/api/inventory-sync")) return false;
    try {
      if (url.pathname === "/api/inventory-sync/lazada-run-monitor" && req.method === "GET") {
        return send(res, 200, { ok: true, monitor: lazadaRunMonitor ? await lazadaRunMonitor() : null });
      }
      if (url.pathname === "/api/inventory-sync/status" && req.method === "GET") {
        return send(res, 200, { ok: true, ...(await service.status()) });
      }
      if (url.pathname === "/api/inventory-sync/prepare-progress" && req.method === "GET") {
        return send(res, 200, { ok: true, ...(await service.getPrepareProgress(url.searchParams.get("accountProfileId"))) });
      }
      if (url.pathname === "/api/inventory-sync/preview-progress" && req.method === "GET") {
        return send(res, 200, { ok: true, ...(await service.getPreviewProgress(url.searchParams.get("accountProfileId"))) });
      }
      if (url.pathname === "/api/inventory-sync/prepare" && req.method === "POST") {
        return send(res, 200, { ok: true, ...(await service.prepare(await readJson(req))) });
      }
      if (url.pathname === "/api/inventory-sync/config-import/preview" && req.method === "POST") {
        return send(res, 200, { ok: true, ...(await service.previewConfigImport(await readJson(req))) });
      }
      if (url.pathname === "/api/inventory-sync/warehouse-catalog" && req.method === "POST") {
        return send(res, 200, { ok: true, ...(await service.warehouseCatalog(await readJson(req))) });
      }
      if (url.pathname === "/api/inventory-sync/warehouse-scope-probe" && req.method === "POST") {
        return send(res, 200, { ok: true, ...(await service.warehouseScopeProbe(await readJson(req))) });
      }
      if (url.pathname === "/api/inventory-sync/page-contract-probe" && req.method === "POST") {
        return send(res, 200, { ok: true, ...(await service.inventoryPageContractProbe(await readJson(req))) });
      }
      if (url.pathname === "/api/inventory-sync/html-page-probe" && req.method === "POST") {
        return send(res, 200, { ok: true, ...(await service.inventoryHtmlPageProbe(await readJson(req))) });
      }
      if (url.pathname === "/api/inventory-sync/html-full-probe" && req.method === "POST") {
        return send(res, 200, { ok: true, ...(await service.inventoryHtmlFullProbe(await readJson(req))) });
      }
      if (url.pathname === "/api/inventory-sync/preview" && req.method === "POST") {
        return send(res, 201, { ok: true, ...(await service.preview({ ...(await readJson(req)), actorId: actor(req) })) });
      }
      if (url.pathname === "/api/inventory-sync/rebind/preview" && req.method === "POST") {
        return send(res, 201, { ok: true, ...(await service.previewRebind({ ...(await readJson(req)), actorId: actor(req) })) });
      }
      const rebindProgressMatch = url.pathname.match(/^\/api\/inventory-sync\/rebind\/plans\/([^/]+)\/progress$/);
      if (rebindProgressMatch && req.method === "GET") {
        return send(res, 200, { ok: true, ...(await service.getRebindProgress(decodeURIComponent(rebindProgressMatch[1]))) });
      }
      const rebindStartMatch = url.pathname.match(/^\/api\/inventory-sync\/rebind\/plans\/([^/]+)\/execute-start$/);
      if (rebindStartMatch && req.method === "POST") {
        return send(res, 202, { ok: true, ...(await service.startRebindExecution({ ...(await readJson(req)), planId: decodeURIComponent(rebindStartMatch[1]) })) });
      }
      const rebindActionMatch = url.pathname.match(/^\/api\/inventory-sync\/rebind\/plans\/([^/]+)\/(approve|execute)$/);
      if (rebindActionMatch && req.method === "POST") {
        const body = await readJson(req);
        const plan = rebindActionMatch[2] === "approve"
          ? await service.approveRebind({ ...body, planId: decodeURIComponent(rebindActionMatch[1]), actorId: actor(req) })
          : await service.executeRebind({ ...body, planId: decodeURIComponent(rebindActionMatch[1]) });
        return send(res, 200, { ok: true, plan });
      }
      const planMatch = url.pathname.match(/^\/api\/inventory-sync\/plans\/([^/]+)$/);
      if (planMatch && req.method === "GET") {
        const plan = await service.get(decodeURIComponent(planMatch[1]));
        return send(res, plan ? 200 : 404, plan ? { ok: true, plan } : { ok: false, code: "INVENTORY_SYNC_PLAN_NOT_FOUND", error: "库存同步计划不存在。" });
      }
      const inventoryProgressMatch = url.pathname.match(/^\/api\/inventory-sync\/plans\/([^/]+)\/progress$/);
      if (inventoryProgressMatch && req.method === "GET") {
        return send(res, 200, { ok: true, ...(await service.getInventoryProgress(decodeURIComponent(inventoryProgressMatch[1]))) });
      }
      const continuousProgressMatch = url.pathname.match(/^\/api\/inventory-sync\/continuous\/([^/]+)$/);
      if (continuousProgressMatch && req.method === "GET") {
        return send(res, 200, { ok: true, ...(await service.getContinuousRun(decodeURIComponent(continuousProgressMatch[1]))) });
      }
      const continuousStartMatch = url.pathname.match(/^\/api\/inventory-sync\/plans\/([^/]+)\/continuous-start$/);
      if (continuousStartMatch && req.method === "POST") {
        return send(res, 202, { ok: true, ...(await service.startContinuousExecution({
          ...(await readJson(req)), planId: decodeURIComponent(continuousStartMatch[1]), actorId: actor(req),
        })) });
      }
      const inventoryStartMatch = url.pathname.match(/^\/api\/inventory-sync\/plans\/([^/]+)\/execute-start$/);
      if (inventoryStartMatch && req.method === "POST") {
        return send(res, 202, { ok: true, ...(await service.startInventoryExecution({ ...(await readJson(req)), planId: decodeURIComponent(inventoryStartMatch[1]) })) });
      }
      const actionMatch = url.pathname.match(/^\/api\/inventory-sync\/plans\/([^/]+)\/(approve|execute)$/);
      if (actionMatch && req.method === "POST") {
        const body = await readJson(req);
        const plan = actionMatch[2] === "approve"
          ? await service.approve({ ...body, planId: decodeURIComponent(actionMatch[1]), actorId: actor(req) })
          : await service.execute({ ...body, planId: decodeURIComponent(actionMatch[1]) });
        return send(res, 200, { ok: true, plan });
      }
      return send(res, 404, { ok: false, code: "INVENTORY_SYNC_API_NOT_FOUND", error: "库存同步接口不存在。" });
    } catch (error) {
      req.auditContext?.annotate({ errorStage: "inventory_sync", errorCode: error?.code || "INVENTORY_SYNC_FAILED", errorSummary: error });
      const status = Number(error?.status || 500);
      return send(res, status, {
        ok: false,
        code: error?.code || "INVENTORY_SYNC_FAILED",
        error: status < 500 ? String(error?.message || "库存同步请求失败。").slice(0, 300) : "库存同步处理失败。",
        plan: error?.plan || undefined,
      });
    }
  };
}
