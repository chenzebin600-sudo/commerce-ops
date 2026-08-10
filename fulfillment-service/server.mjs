import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "../lib/env.mjs";
import { resolveFulfillmentConfig } from "./config.mjs";
import { createFulfillmentRepository } from "./repository-factory.mjs";
import { FulfillmentError, FulfillmentService } from "./service.mjs";
import { createDisabledFulfillmentExecutor, createMabangFulfillmentExecutor, createMabangFulfillmentPreflight, createMabangFulfillmentScanSource, createMabangFulfillmentSource, createMabangTrackingRecoveryAdapter } from "./mabang-source.mjs";
import { createApiDocsHtml, createOpenApiDocument } from "./api-docs.mjs";
import { FulfillmentPreviewScheduler } from "./scheduler.mjs";
import { createWindowsNotifier } from "./notifier.mjs";
import { AiGateway } from "../lib/ai/ai-gateway.mjs";
import { DeepSeekProvider, resolveDeepSeekEndpoint } from "../lib/ai/providers/deepseek-provider.mjs";
import { FulfillmentAgent } from "./agent.mjs";
import { FulfillmentAgentTools } from "./agent-tools.mjs";
import { SkuReplacementService } from "./sku-replacement.mjs";
import { SkuReplacementBatchService } from "./sku-replacement-batch.mjs";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
loadLocalEnv(rootDir);
const config = resolveFulfillmentConfig({ rootDir });
const repository = await createFulfillmentRepository({ rootDir, databasePath: config.databasePath });
const recoveredBatches = repository.readOnly ? [] : await repository.recoverInterruptedBatches(new Date().toISOString());
if (recoveredBatches.length) console.warn(`Recovered ${recoveredBatches.length} interrupted fulfillment batch(es) as needs_attention.`);
const quarantinedInventoryOrders = repository.readOnly ? 0
  : await repository.quarantineFailedOrders("INVENTORY_UNKNOWN_BEFORE_SUBMIT", new Date().toISOString());
if (quarantinedInventoryOrders) console.warn(`Moved ${quarantinedInventoryOrders} inventory-unknown order(s) to needs_attention.`);
const migratedTrackingRecoveries = repository.readOnly ? 0
  : await repository.migratePendingTrackingRecoveries({ nowIso: new Date().toISOString(),
    checkSeconds: config.trackingRecoveryCheckSeconds, deadlineHours: config.trackingRecoveryDeadlineHours });
if (migratedTrackingRecoveries) console.warn(`Migrated ${migratedTrackingRecoveries} pending tracking order(s) to recovery queue.`);
const notifier = createWindowsNotifier({ enabled: config.windowsNotificationsEnabled });
const shopConfigs = config.shops.map((shop) => Object.freeze({ ...config, ...shop }));
const preflightsByShopId = new Map(shopConfigs.map((shopConfig) => [shopConfig.shopId,
  createMabangFulfillmentPreflight({ config: shopConfig, rootDir })]));
const services = shopConfigs.map((shopConfig) => new FulfillmentService({ config: shopConfig, repository,
  source: createMabangFulfillmentSource({ config: shopConfig, rootDir }),
  executor: shopConfig.realSubmitEnabled ? createMabangFulfillmentExecutor({ config: shopConfig, rootDir }) : createDisabledFulfillmentExecutor(),
  preflight: preflightsByShopId.get(shopConfig.shopId),
  trackingRecovery: createMabangTrackingRecoveryAdapter({ config: shopConfig, rootDir }), notifier }));
const servicesByShopId = new Map(services.map((shopService) => [shopService.config.shopId, shopService]));
const service = servicesByShopId.get(config.shopId) || services[0];
const scanSource = createMabangFulfillmentScanSource({ config, shops: config.shops, rootDir });
const scheduler = new FulfillmentPreviewScheduler({ config, service, services, scanSource, notifier });
if (!repository.readOnly) scheduler.start();

function serviceForShop(shopId) {
  const selected = servicesByShopId.get(String(shopId || config.shopId));
  if (!selected) throw new FulfillmentError("SHOP_NOT_CONFIGURED", "店铺未配置或不属于当前印尼店铺范围", 400);
  return selected;
}
async function serviceForPreview(previewId) {
  const preview = await repository.getPreview(previewId);
  if (!preview) throw new FulfillmentError("PREVIEW_NOT_FOUND", "预览不存在", 404);
  return serviceForShop(preview.shopId);
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}
function sendHtml(res, status, html) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(html);
}
async function body(req) {
  let text = ""; for await (const chunk of req) { text += chunk; if (text.length > 1024 * 1024) throw new FulfillmentError("BODY_TOO_LARGE", "请求体过大", 413); }
  return text ? JSON.parse(text) : {};
}
function authorized(req) {
  if (!config.apiToken) return config.host === "127.0.0.1" || config.host === "localhost";
  return req.headers.authorization === `Bearer ${config.apiToken}`;
}

function dashboardWindows(now = new Date(), days = 7) {
  const boundedDays = Math.min(30, Math.max(1, Number(days) || 7));
  const offsetMs = 8 * 60 * 60 * 1000;
  const dayMs = 24 * 60 * 60 * 1000;
  const nowMs = now.getTime();
  const todayStartMs = Math.floor((nowMs + offsetMs) / dayMs) * dayMs - offsetMs;
  const dayWindows = Array.from({ length: boundedDays }, (_, index) => {
    const fromMs = todayStartMs - (boundedDays - 1 - index) * dayMs;
    return {
      date: new Date(fromMs + offsetMs).toISOString().slice(0, 10),
      fromIso: new Date(fromMs).toISOString(),
      toIso: new Date(fromMs + dayMs).toISOString(),
    };
  });
  return {
    todayStartIso: new Date(todayStartMs).toISOString(),
    trendStartIso: dayWindows[0].fromIso,
    endIso: now.toISOString(), dayWindows,
  };
}

const fulfillmentAgentTools = new FulfillmentAgentTools({ repository, scheduler, serviceForShop, serviceForPreview, dashboardWindows });
const fulfillmentAgentApiKey = String(process.env.DEEPSEEK_API_KEY || "").trim();
const fulfillmentAgent = new FulfillmentAgent({
  enabled: config.fulfillmentAgentEnabled,
  model: config.fulfillmentAgentModel,
  maxSteps: config.fulfillmentAgentMaxSteps,
  repository,
  tools: fulfillmentAgentTools,
  gateway: fulfillmentAgentApiKey ? new AiGateway({
    provider: new DeepSeekProvider({ apiKey: fulfillmentAgentApiKey,
      endpoint: resolveDeepSeekEndpoint(process.env.DEEPSEEK_BASE_URL) }),
  }) : null,
});

const skuReplacementService = new SkuReplacementService({
  rootDir,
  credentials:() => config.mabangUsername && config.mabangPassword
    ? { ok:true,username:config.mabangUsername,password:config.mabangPassword }
    : { ok:false,code:"MABANG_ACCOUNT_NOT_CONNECTED",message:"请配置履约服务马帮账号" },
  hasShopAccess:(shopId) => servicesByShopId.has(String(shopId || "")),
});
const skuReplacementBatchService = new SkuReplacementBatchService({ rootDir,skuReplacementService });
const recoveredSkuReplacementTasks = skuReplacementBatchService.reconcileInterruptedExecutions();
if (recoveredSkuReplacementTasks.length) {
  console.warn(`Recovered ${recoveredSkuReplacementTasks.length} interrupted SKU replacement task(s) for manual review.`);
}

function skuReplacementFailure(error, fallbackCode, fallbackMessage, fallbackStatus = 409) {
  const code = String(error?.code || fallbackCode);
  const status = code.endsWith("_NOT_FOUND") ? 404
    : code.endsWith("_INVALID") ? 400 : fallbackStatus;
  return new FulfillmentError(code,error?.message || fallbackMessage,status);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { success: true, realSubmitEnabled: config.realSubmitEnabled,
      database: { provider: repository.databaseProviderName, mode: repository.databaseMode,
        target: repository.databaseTarget, readOnly: repository.readOnly },
      schedulerEnabled: config.schedulerEnabled, schedulerIntervalSeconds: config.schedulerIntervalSeconds,
      autoFulfillEnabled: config.autoFulfillEnabled,
      autoFulfillShops: config.shops.filter((shop) => shop.autoFulfillEnabled)
        .map((shop) => ({ id: shop.shopId, name: shop.shopName })),
      orderConcurrency: config.orderConcurrency,
      fulfillmentAgent: fulfillmentAgent.status(),
      windowsNotificationsEnabled: config.windowsNotificationsEnabled, supervised: process.env.FULFILLMENT_SUPERVISED === "1",
      shopCount: config.shops.length, shops: config.shops.map((shop) => ({ id: shop.shopId, name: shop.shopName,
        platform: shop.platform, platformId: shop.platformId, countryCode: shop.countryCode,
        channelProfileId: shop.channelProfileId, channelId: shop.channelId, channelName: shop.channelName,
        allowedWarehouses: shop.allowedWarehouses, configuredAutoFulfillEnabled: shop.configuredAutoFulfillEnabled,
        autoFulfillEnabled: shop.autoFulfillEnabled })) });
    if (req.method === "GET" && (url.pathname === "/docs" || url.pathname === "/docs/")) return sendHtml(res, 200, createApiDocsHtml(config));
    if (req.method === "GET" && url.pathname === "/openapi.json") return send(res, 200, createOpenApiDocument(config));
    if (!authorized(req)) return send(res, 401, { success: false, error: { code: "UNAUTHORIZED", message: "未授权访问" } });
    if (repository.readOnly && req.method !== "GET") {
      throw new FulfillmentError("POSTGRES_SHADOW_READ_ONLY",
        "PostgreSQL Shadow validation mode is read-only; fulfillment writes remain disabled.", 409);
    }
    if (req.method === "POST" && url.pathname === "/api/fulfillment/sku-replacements/batch-preview") {
      try { return send(res,201,{ success:true,data:await skuReplacementService.previewBatch(await body(req)) }); }
      catch (error) { throw skuReplacementFailure(error,"SKU_REPLACEMENT_PREVIEW_FAILED","替换 SKU 建议生成失败"); }
    }
    if (req.method === "POST" && url.pathname === "/api/fulfillment/sku-replacements/batch-recover") {
      try { return send(res,200,{ success:true,data:skuReplacementService.recoverBatch(await body(req)) }); }
      catch (error) { throw skuReplacementFailure(error,"SKU_REPLACEMENT_RECOVERY_FAILED","SKU 替换预览恢复失败",404); }
    }
    if (req.method === "POST" && url.pathname === "/api/fulfillment/sku-replacements/plan") {
      try { return send(res,201,{ success:true,data:await skuReplacementService.createPlan(await body(req)) }); }
      catch (error) { throw skuReplacementFailure(error,"SKU_REPLACEMENT_PLAN_FAILED","替换 SKU 计划生成失败"); }
    }
    if (req.method === "POST" && url.pathname === "/api/fulfillment/sku-replacements/execute") {
      try { return send(res,200,{ success:true,data:await skuReplacementService.execute(await body(req)) }); }
      catch (error) { throw skuReplacementFailure(error,"SKU_REPLACEMENT_EXECUTE_FAILED","替换 SKU 执行失败"); }
    }
    if (req.method === "POST" && url.pathname === "/api/fulfillment/sku-replacements/batch-plan") {
      try { return send(res,201,{ success:true,data:await skuReplacementBatchService.createPlan(await body(req)) }); }
      catch (error) { throw skuReplacementFailure(error,"SKU_REPLACEMENT_BATCH_PLAN_FAILED","批量替换 SKU 计划生成失败"); }
    }
    if (req.method === "POST" && url.pathname === "/api/fulfillment/sku-replacements/batch-execute") {
      let task;
      try { task = skuReplacementBatchService.createExecution(await body(req)); }
      catch (error) { throw skuReplacementFailure(error,"SKU_REPLACEMENT_BATCH_EXECUTE_FAILED","批量替换 SKU 执行失败"); }
      void skuReplacementBatchService.runExecution(task.taskId)
        .catch((error) => console.error(`SKU replacement task ${task.taskId} stopped with ${String(error?.code || "INTERNAL_ERROR").slice(0,80)}.`));
      return send(res,202,{ success:true,data:task });
    }
    const skuBatchTaskMatch = url.pathname.match(/^\/api\/fulfillment\/sku-replacements\/batch-executions\/([a-zA-Z0-9-]{1,80})$/);
    if (req.method === "GET" && skuBatchTaskMatch) {
      try {
        const task = skuReplacementBatchService.getExecution(skuBatchTaskMatch[1]);
        if (!task) throw Object.assign(new Error("批量更换任务不存在"), { code:"SKU_REPLACEMENT_TASK_NOT_FOUND" });
        return send(res,200,{ success:true,data:task });
      } catch (error) {
        throw skuReplacementFailure(error,"SKU_REPLACEMENT_TASK_NOT_FOUND","批量更换任务不存在",404);
      }
    }
    if (req.method === "GET" && url.pathname === "/api/fulfillment/agent/status") {
      return send(res, 200, { success: true, data: fulfillmentAgent.status() });
    }
    if (req.method === "POST" && url.pathname === "/api/fulfillment/agent/chat") {
      const payload = await body(req);
      return send(res, 200, { success: true, data: await fulfillmentAgent.chat(payload) });
    }
    if (req.method === "GET" && url.pathname === "/api/fulfillment/dashboard") {
      const window = dashboardWindows(new Date(), url.searchParams.get("days"));
      return send(res, 200, { success: true, data: await repository.getDashboardSummary(window) });
    }
    if (req.method === "POST" && url.pathname === "/api/fulfillment/notifications/test") {
      const result = await notifier.notifyAndWait({ title: "马帮自动发货通知测试", message: "通知功能正常，后台服务可以向当前 Windows 桌面发送提醒。" });
      return send(res, result.delivered ? 200 : 409, { success: result.delivered, data: result.delivered ? result : undefined,
        error: result.delivered ? undefined : { code: result.code, message: result.message || "Windows 通知未启用" } });
    }
    if (req.method === "GET" && url.pathname === "/api/fulfillment/scheduler") {
      return send(res, 200, { success: true, data: await scheduler.status() });
    }
    if (req.method === "POST" && url.pathname === "/api/fulfillment/scheduler/scan") {
      try { return send(res, 200, { success: true, data: await scheduler.scanNow() }); }
      catch (error) { throw new FulfillmentError(error.code || "SCHEDULER_SCAN_FAILED", error.message || "定时扫描失败", 409); }
    }
    if (req.method === "POST" && url.pathname === "/api/fulfillment/manual-reviews/recheck") {
      const payload = await body(req);
      const schedulerState = await scheduler.status();
      if (schedulerState.scanning || schedulerState.activeBatch) {
        throw new FulfillmentError("FULFILLMENT_BUSY", "当前正在扫描或执行发货批次，请稍后重新核对", 409);
      }
      const shopService = serviceForShop(payload.shopId);
      try {
        const result = await shopService.recheckManualReview(payload.orderId, preflightsByShopId.get(shopService.config.shopId));
        return send(res, 200, { success: true, data: result });
      } catch (error) {
        if (error instanceof FulfillmentError) throw error;
        throw new FulfillmentError(error.code || "MANUAL_REVIEW_RECHECK_FAILED", error.message || "人工处理订单重新核对失败", 409);
      }
    }
    if (req.method === "GET" && url.pathname === "/api/fulfillment/batches") {
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 20));
      return send(res, 200, { success: true, data: await service.listRecentBatches(limit) });
    }
    if (req.method === "GET" && url.pathname === "/api/fulfillment/tracking-recoveries") {
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50));
      const items = await repository.listTrackingRecoveries(limit);
      return send(res, 200, { success: true, data: items });
    }
    if (req.method === "POST" && url.pathname === "/api/fulfillment/tracking-recoveries/check") {
      const schedulerState = await scheduler.status();
      if (schedulerState.scanning || schedulerState.activeBatch) {
        throw new FulfillmentError("FULFILLMENT_BUSY", "当前正在扫描或执行发货批次，请稍后回查运单号", 409);
      }
      const payload = await body(req);
      const selected = payload.shopId ? [serviceForShop(payload.shopId)] : services;
      const allowReset = payload.confirmation === "TRACKING_RECOVERY_CONFIRMED"
        && Boolean(String(payload.shopId || "").trim()) && Boolean(String(payload.orderId || "").trim());
      const results = [];
      for (const shopService of selected) results.push(await shopService.recoverPendingTrackingNumbers({
        limit: payload.orderId ? 1 : 5, orderId: payload.orderId || null, allowReset,
      }));
      return send(res, 200, { success: true, data: results });
    }
    if (req.method === "POST" && url.pathname === "/api/fulfillment/preflights") {
      const payload = await body(req);
      try { const shopService = serviceForShop(payload.shopId);
        return send(res, 200, { success: true, data: await shopService.runPreflight(payload.orderId, preflightsByShopId.get(shopService.config.shopId)) }); }
      catch (error) { throw new FulfillmentError(error.code || "PREFLIGHT_FAILED", error.message || "深度预检失败", error.code === "INVALID_ORDER_ID" ? 400 : 409); }
    }
    if (req.method === "POST" && url.pathname === "/api/fulfillment/previews") {
      const payload = await body(req); const result = await serviceForShop(payload.shopId).createPreview(payload);
      return send(res, 201, { success: true, data: result });
    }
    let match = url.pathname.match(/^\/api\/fulfillment\/previews\/([^/]+)$/);
    if (req.method === "GET" && match) return send(res, 200, { success: true, data: await (await serviceForPreview(match[1])).getPreview(match[1]) });
    match = url.pathname.match(/^\/api\/fulfillment\/previews\/([^/]+)\/confirmation-token$/);
    if (req.method === "POST" && match) return send(res, 200, { success: true, data: await (await serviceForPreview(match[1])).issueConfirmationToken(match[1]) });
    match = url.pathname.match(/^\/api\/fulfillment\/previews\/([^/]+)\/confirm$/);
    if (req.method === "POST" && match) {
      const payload = await body(req); const result = await (await serviceForPreview(match[1])).enqueuePreview(match[1], payload.confirmationToken);
      return send(res, 202, { success: true, data: result });
    }
    match = url.pathname.match(/^\/api\/fulfillment\/batches\/([^/]+)$/);
    if (req.method === "GET" && match) return send(res, 200, { success: true, data: await service.getBatch(match[1]) });
    return send(res, 404, { success: false, error: { code: "NOT_FOUND", message: "接口不存在" } });
  } catch (error) {
    const status = error instanceof FulfillmentError ? error.status : 500;
    const errorBody = { code: error.code || "INTERNAL_ERROR", message: status === 500 ? "服务内部错误" : error.message };
    if (status !== 500 && error.details) errorBody.details = error.details;
    send(res, status, { success: false, error: errorBody });
  }
});

server.listen(config.port, config.host, () => console.log(`Mabang fulfillment API listening on http://${config.host}:${config.port}`));
function shutdown() { scheduler.stop(); server.close(async () => { await scheduler.waitForIdle(); await Promise.all(services.map((shopService) => shopService.waitForIdle())); await repository.close(); process.exit(0); }); }
process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
