import { PriceControlError } from "./price-control-service.mjs";

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
  return true;
}

async function readJson(req, maxBytes = 16 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new PriceControlError("PRICE_CONTROL_REQUEST_TOO_LARGE", 413, "请求内容过大。");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {
    throw new PriceControlError("PRICE_CONTROL_INVALID_JSON", 400, "请求内容不是有效的 JSON。");
  }
}

function actor(req) {
  return req.auditContext?.annotations?.actorIdentifier
    || req.auditContext?.actorIdentifier
    || req.auditContext?.actorType
    || "local_session";
}

export function createPriceControlApi({ service, repricingService = null, accessPolicy }) {
  return async function handlePriceControlApi(req, res, url) {
    if (!url.pathname.startsWith("/api/price-control")) return false;
    try {
      if (url.pathname === "/api/price-control/status" && req.method === "GET") {
        accessPolicy.assert("product.view");
        const status = await service.status({ probe: url.searchParams.get("probe") === "1" });
        return sendJson(res, 200, {
          ok: true,
          status: {
            ...status,
            repricing: repricingService ? await repricingService.status() : {
              workflowReady: false, executionProviders: [], limits: { maxSourceChanges: 0, maxShopAssignments: 0 },
            },
          },
        });
      }
      if (url.pathname === "/api/price-control/overview" && req.method === "GET") {
        accessPolicy.assert("product.view");
        return sendJson(res, 200, { ok: true, overview: await service.overview() });
      }
      if (url.pathname === "/api/price-control/automation" && req.method === "GET") {
        accessPolicy.assert("product.view");
        return sendJson(res, 200, { ok: true, automation: await service.automation() });
      }
      if (url.pathname === "/api/price-control/automation" && req.method === "PUT") {
        accessPolicy.assert("product.edit");
        const settings = await service.saveAutomation(await readJson(req), { requestedBy: actor(req) });
        req.auditContext?.annotate({
          metadata: {
            enabled: settings.enabled,
            intervalMinutes: settings.intervalMinutes,
            robotConfigured: Boolean(settings.dingtalkConfigId),
          },
        });
        return sendJson(res, 200, { ok: true, settings });
      }
      if (url.pathname === "/api/price-control/changes" && req.method === "GET") {
        accessPolicy.assert("product.view");
        return sendJson(res, 200, {
          ok: true,
          ...(await service.listChanges({
            page: url.searchParams.get("page"),
            pageSize: url.searchParams.get("page_size"),
            countryCode: url.searchParams.get("country"),
            categoryName: url.searchParams.get("category"),
            sku: url.searchParams.get("sku"),
            platform: url.searchParams.get("platform"),
            shopType: url.searchParams.get("shop_type"),
            priceType: url.searchParams.get("price_type"),
            direction: url.searchParams.get("direction"),
            sourceApplyNo: url.searchParams.get("apply_no"),
            validityStatus: url.searchParams.get("validity"),
            syncRunId: url.searchParams.get("sync_run_id"),
            adjustmentStatus: url.searchParams.get("adjustment_status"),
          })),
        });
      }
      if (url.pathname === "/api/price-control/rounds" && req.method === "GET") {
        accessPolicy.assert("product.view");
        return sendJson(res, 200, {
          ok: true,
          ...(await service.listChangeRounds({ limit: url.searchParams.get("limit") })),
        });
      }
      if (url.pathname === "/api/price-control/shops" && req.method === "GET") {
        accessPolicy.assert("product.view");
        if (!repricingService) throw new PriceControlError("PRICE_CONTROL_REPRICING_UNAVAILABLE", 503, "调价预览服务尚未启用。");
        return sendJson(res, 200, {
          ok: true,
          shops: await repricingService.listShops({
            platform: url.searchParams.get("platform"),
            countryCode: url.searchParams.get("country"),
            controlShopType: url.searchParams.get("shop_type"),
          }),
        });
      }
      if (url.pathname === "/api/price-control/repricing/plans" && req.method === "GET") {
        accessPolicy.assert("product.view");
        if (!repricingService) throw new PriceControlError("PRICE_CONTROL_REPRICING_UNAVAILABLE", 503, "调价预览服务尚未启用。");
        return sendJson(res, 200, {
          ok: true,
          ...(await repricingService.listPlans({
            sourceRoundId: url.searchParams.get("round_id"),
            limit: url.searchParams.get("limit"),
          })),
        });
      }
      if (url.pathname === "/api/price-control/repricing/previews" && req.method === "POST") {
        accessPolicy.assert("product.edit");
        if (!repricingService) throw new PriceControlError("PRICE_CONTROL_REPRICING_UNAVAILABLE", 503, "调价预览服务尚未启用。");
        const plan = await repricingService.createPreview(await readJson(req, 128 * 1024), { requestedBy: actor(req) });
        req.auditContext?.annotate({
          runId: plan.sourceRoundId,
          metadata: { provider: plan.executionProvider, changeCount: plan.listingChangeCount, rowCount: plan.targetShopCount },
        });
        return sendJson(res, 201, { ok: true, plan });
      }
      const repricingPlanMatch = url.pathname.match(/^\/api\/price-control\/repricing\/plans\/([^/]+)$/);
      if (repricingPlanMatch && req.method === "GET") {
        accessPolicy.assert("product.view");
        if (!repricingService) throw new PriceControlError("PRICE_CONTROL_REPRICING_UNAVAILABLE", 503, "调价预览服务尚未启用。");
        return sendJson(res, 200, { ok: true, plan: await repricingService.getPlan(decodeURIComponent(repricingPlanMatch[1])) });
      }
      const repricingConfirmMatch = url.pathname.match(/^\/api\/price-control\/repricing\/plans\/([^/]+)\/confirm$/);
      if (repricingConfirmMatch && req.method === "POST") {
        accessPolicy.assert("product.edit");
        if (!repricingService) throw new PriceControlError("PRICE_CONTROL_REPRICING_UNAVAILABLE", 503, "调价预览服务尚未启用。");
        const plan = await repricingService.confirm(
          decodeURIComponent(repricingConfirmMatch[1]),
          await readJson(req, 64 * 1024),
          { requestedBy: actor(req) },
        );
        req.auditContext?.annotate({ runId: plan.sourceRoundId, metadata: { result: plan.status, changeCount: plan.selectedItemIds.length } });
        return sendJson(res, 202, { ok: true, plan });
      }
      const repricingRefreshMatch = url.pathname.match(/^\/api\/price-control\/repricing\/plans\/([^/]+)\/refresh$/);
      if (repricingRefreshMatch && req.method === "POST") {
        accessPolicy.assert("product.edit");
        if (!repricingService) throw new PriceControlError("PRICE_CONTROL_REPRICING_UNAVAILABLE", 503, "调价预览服务尚未启用。");
        const plan = await repricingService.refresh(
          decodeURIComponent(repricingRefreshMatch[1]),
          { requestedBy: actor(req) },
        );
        req.auditContext?.annotate({ runId: plan.sourceRoundId, metadata: { result: plan.status } });
        return sendJson(res, 200, { ok: true, plan });
      }
      const roundCopyMatch = url.pathname.match(/^\/api\/price-control\/rounds\/([^/]+)\/copy$/);
      if (roundCopyMatch && req.method === "GET") {
        accessPolicy.assert("product.view");
        const result = await service.copyChangeRound(decodeURIComponent(roundCopyMatch[1]), { requestedBy: actor(req) });
        req.auditContext?.annotate({
          runId: result.round.id,
          metadata: { changeCount: result.count, affectedSkuCount: result.round.affectedSkuCount },
        });
        return sendJson(res, 200, { ok: true, ...result });
      }
      if (url.pathname === "/api/price-control/current-prices" && req.method === "GET") {
        accessPolicy.assert("product.view");
        return sendJson(res, 200, {
          ok: true,
          ...(await service.listCurrentPrices({
            page: url.searchParams.get("page"),
            pageSize: url.searchParams.get("page_size"),
            countryCode: url.searchParams.get("country"),
            categoryName: url.searchParams.get("category"),
            sku: url.searchParams.get("sku"),
            platform: url.searchParams.get("platform"),
            shopType: url.searchParams.get("shop_type"),
            priceType: url.searchParams.get("price_type"),
            sourceApplyNo: url.searchParams.get("apply_no"),
          })),
        });
      }
      const changeMatch = url.pathname.match(/^\/api\/price-control\/changes\/([^/]+)$/);
      if (changeMatch && req.method === "GET") {
        accessPolicy.assert("product.view");
        return sendJson(res, 200, { ok: true, change: await service.getChange(decodeURIComponent(changeMatch[1])) });
      }
      const adjustmentMatch = url.pathname.match(/^\/api\/price-control\/changes\/([^/]+)\/adjustment$/);
      if (adjustmentMatch && req.method === "PATCH") {
        accessPolicy.assert("product.edit");
        const change = await service.updateAdjustment(
          decodeURIComponent(adjustmentMatch[1]),
          await readJson(req),
          { requestedBy: actor(req) },
        );
        req.auditContext?.annotate({
          taskId: change.foundationTaskId,
          runId: change.syncRunId,
          metadata: { changeId: change.id, adjustmentStatus: change.adjustmentStatus },
        });
        return sendJson(res, 200, { ok: true, change });
      }
      if (url.pathname === "/api/price-control/runs" && req.method === "GET") {
        accessPolicy.assert("product.view");
        return sendJson(res, 200, {
          ok: true,
          ...(await service.listRuns({
            page: url.searchParams.get("page"),
            pageSize: url.searchParams.get("page_size"),
          })),
        });
      }
      if (url.pathname === "/api/price-control/sync" && req.method === "POST") {
        accessPolicy.assert("product.edit");
        const body = await readJson(req);
        const result = await service.sync({
          mode: body.mode,
          triggerType: "manual",
          requestedBy: actor(req),
        });
        req.auditContext?.annotate({
          runId: result.run.id,
          metadata: {
            mode: result.run.syncMode,
            rowCount: result.run.sourceRowsSeen,
            changeCount: result.run.changeCount,
            result: "succeeded",
          },
        });
        return sendJson(res, 201, { ok: true, ...result });
      }
      return sendJson(res, 404, { ok: false, code: "PRICE_CONTROL_API_NOT_FOUND", error: "控价变更接口不存在。" });
    } catch (error) {
      req.auditContext?.annotate({
        errorStage: "price_control",
        errorCode: error?.code || "PRICE_CONTROL_API_FAILED",
        errorSummary: error,
      });
      const errorCode = String(error?.code || "");
      const isPublic = error instanceof PriceControlError
        || errorCode.startsWith("PRODUCT_")
        || errorCode.startsWith("PRICE_CONTROL_")
        || errorCode.startsWith("MABANG_");
      return sendJson(res, isPublic ? Number(error.status || 400) : 500, {
        ok: false,
        code: isPublic ? error.code : "PRICE_CONTROL_API_FAILED",
        error: isPublic ? String(error.message).slice(0, 240) : "控价变更操作失败。",
      });
    }
  };
}
