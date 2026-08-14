import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "./lib/env.mjs";
import { createMabangWorkerRunner } from "./lib/mabang-worker-runner.mjs";
import { createMabangDataPersistenceService } from "./lib/mabang-data/persistence-service.mjs";
import { openConfiguredCommerceDataAccess } from "./lib/data/data-access.mjs";
import { createTaskExecutor } from "./lib/mabang-scheduler/executor.mjs";
import { MabangSchedulerService } from "./lib/mabang-scheduler/service.mjs";
import { GrowthRadarService } from "./lib/growth-radar/growth-radar-service.mjs";
import {
  cleanupTemporaryFiles,
  ensureFileStorageRoots,
  resolveFileStorageConfig,
} from "./lib/security/file-policy.mjs";
import { createOperationAuditService } from "./lib/security/audit-service.mjs";
import { resolveRuntimeConfig, runtimeEnvironment } from "./lib/runtime-config.mjs";
import { createExternalTaskPolicy } from "./lib/runtime/external-task-policy.mjs";
import { createExportFileService } from "./lib/files/export-file-service.mjs";
import { pythonRuntimeError, resolvePythonRuntime } from "./lib/python-runtime.mjs";
import { AiGateway } from "./lib/ai/ai-gateway.mjs";
import { DeepSeekProvider, resolveDeepSeekEndpoint } from "./lib/ai/providers/deepseek-provider.mjs";
import { SalesAssortmentService } from "./lib/sales-assortment/sales-assortment-service.mjs";
import { SalesAssortmentAiService } from "./lib/sales-assortment/sales-assortment-ai-service.mjs";
import { ShopeeHealthClient } from "./lib/shopee-health/client.mjs";
import { ShopeeHealthService } from "./lib/shopee-health/service.mjs";
import { FoundationService } from "./lib/foundation/foundation-service.mjs";
import { decryptSecret } from "./lib/mabang-scheduler/crypto.mjs";
import { sendDingtalkMessage } from "./lib/mabang-scheduler/dingtalk.mjs";
import { ShopeeReadAdapter } from "./lib/shopee-discount/shopee-read-adapter.mjs";
import { WarehouseControlPriceClient } from "./lib/shopee-discount/warehouse-client.mjs";
import { ShopeeDiscountService } from "./lib/shopee-discount/service.mjs";
import { ShopeeDiscountScheduler } from "./lib/shopee-discount/scheduler.mjs";
import { ShopeeDiscountNotifications } from "./lib/shopee-discount/notifications.mjs";
import {
  buildSalesAssortmentDailyReport,
  salesReportDateFor,
} from "./lib/sales-assortment/sales-assortment-daily-report.mjs";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
loadLocalEnv(rootDir);
const runtimeConfig = resolveRuntimeConfig({ bootstrapRoot: rootDir, env: process.env });
const runtimeEnv = { ...process.env, ...runtimeEnvironment(runtimeConfig) };
const externalTaskPolicy = createExternalTaskPolicy({ databaseProvider: runtimeConfig.databaseProvider, env: runtimeEnv });

const fileStorage = await ensureFileStorageRoots(resolveFileStorageConfig(runtimeConfig.appRoot, runtimeEnv));
const cleanup = await cleanupTemporaryFiles(fileStorage.tempRoot, {
  retentionHours: fileStorage.tempFileRetentionHours,
});
if (cleanup.removed || cleanup.errors) {
  console.log(`Temporary file cleanup: ${cleanup.removed} removed, ${cleanup.errors} errors`);
}
const exportRoot = fileStorage.exportRoot;
const dataAccess = await openConfiguredCommerceDataAccess({ runtimeConfig, env: process.env });
const db = dataAccess.repositories.scheduler;
const audit = createOperationAuditService({ repository: dataAccess.repositories.audit, env: process.env });
const exportFileService = createExportFileService({
  repository: dataAccess.repositories.exportFiles,
  exportRoot,
  tempRoot: fileStorage.tempRoot,
  audit,
});
const runWorker = createMabangWorkerRunner({
  rootDir: runtimeConfig.appRoot,
  exportRoot: fileStorage.tempRoot,
  runtimeConfig,
  env: runtimeEnv,
});
const growthRadarPython = resolvePythonRuntime({
  appRoot: runtimeConfig.appRoot,
  env: runtimeEnv,
  requiredModules: ["openpyxl"],
});
if (!growthRadarPython.ok) throw pythonRuntimeError(growthRadarPython, "Mabang data persistence");
const growthRadarService = new GrowthRadarService({
  repository: dataAccess.repositories.growthRadar,
  pythonExecutable: growthRadarPython.executable,
  parserScript: path.join(runtimeConfig.appRoot, "scripts", "growth-radar-parser.py"),
  fileStorageConfig: fileStorage,
  maxRows: Number(process.env.GROWTH_RADAR_IMPORT_MAX_ROWS || 200000),
  parseTimeoutMs: Number(process.env.GROWTH_RADAR_IMPORT_PARSE_TIMEOUT_MS || 600000),
});
const mabangDataPersistence = createMabangDataPersistenceService({
  growthRadarService,
  runWorker,
  tempRoot: fileStorage.tempRoot,
});
const salesAssortmentService = new SalesAssortmentService({
  repository: dataAccess.repositories.salesAssortment,
});
const deepSeekApiKey = String(runtimeEnv.DEEPSEEK_API_KEY || "").trim();
const salesAssortmentAiService = new SalesAssortmentAiService({
  dashboardService: salesAssortmentService,
  gateway: new AiGateway({
    provider: new DeepSeekProvider({
      apiKey: deepSeekApiKey,
      endpoint: resolveDeepSeekEndpoint(runtimeEnv.DEEPSEEK_BASE_URL),
    }),
  }),
  configured: Boolean(deepSeekApiKey),
  model: runtimeEnv.SALES_ASSORTMENT_DEEPSEEK_MODEL || runtimeEnv.DEEPSEEK_MODEL || "deepseek-v4-flash",
});
const executor = createTaskExecutor({
  db,
  runWorker,
  exportRoot,
  tempRoot: fileStorage.tempRoot,
  audit,
  fileService: exportFileService,
  persistCollectedData: (input) => mabangDataPersistence.persistFile(input),
  generateDailyReport: async ({ generatedAt }) => {
    const reportDate = salesReportDateFor(generatedAt);
    const reportScope = { periodDays: 1, dateFrom: reportDate, dateTo: reportDate, comparisonDays: 1 };
    const dashboard = await salesAssortmentService.dashboard(reportScope);
    let analysis = null;
    if (deepSeekApiKey) {
      try {
        analysis = await salesAssortmentAiService.analyze(reportScope);
      } catch (error) {
        console.warn(`Sales assortment daily report AI summary skipped: ${error.message}`);
      }
    }
    return buildSalesAssortmentDailyReport({ dashboard, analysis, generatedAt });
  },
});
const scheduler = new MabangSchedulerService({
  db, executor, exportRoot, audit,
  ownerId: externalTaskPolicy.status().instanceId || undefined,
});
const shopeeHealthService = new ShopeeHealthService({
  repository: dataAccess.repositories.shopeeHealth,
  client: new ShopeeHealthClient({
    baseUrl: process.env.SHOPEE_RELAY_BASE_URL || "http://10.110.80.95:8788",
  }),
  robotRepository: db,
});

const shopeeDiscountSchedulerEnabled = String(runtimeEnv.SHOPEE_DISCOUNT_SCHEDULER_ENABLED || "").trim().toLowerCase() === "true";
const shopeeDiscountShopIds = String(runtimeEnv.SHOPEE_DISCOUNT_SCHEDULER_SHOP_IDS || "")
  .split(",").map((value) => value.trim()).filter((value) => /^[1-9]\d*$/.test(value));
const shopeeDiscountCountry = String(runtimeEnv.SHOPEE_DISCOUNT_COUNTRY || "TH").trim().toUpperCase();
const shopeeDiscountCategory = String(runtimeEnv.SHOPEE_DISCOUNT_CATEGORY || "家具").trim();
const shopeeDiscountTier = String(runtimeEnv.SHOPEE_DISCOUNT_DEFAULT_TIER || "DAILY").trim().toUpperCase();
const foundationService = new FoundationService({ repository: dataAccess.repositories.foundation });
const discountReadAdapter = new ShopeeReadAdapter({
  transport: async (request) => {
    const settings = await dataAccess.repositories.shopeeHealth.getSettings({ includeSecret: true });
    if (!settings?.encryptedTokenKey) return { status: 503, body: { error: "SHOPEE_TOKEN_NOT_CONFIGURED" } };
    try {
      const body = await shopeeHealthService.client.request(request.relayPath, decryptSecret(settings.encryptedTokenKey), {
        method: request.relayMethod,
        ...(request.body ? { headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(request.body) } : {}),
      });
      return { status: 200, body };
    } catch (cause) {
      return { status: Number(cause?.status) || 503, body: { error: String(cause?.code || "SHOPEE_RELAY_FAILED") } };
    }
  },
  retryPolicy: { maxAttempts: 3, delaysMs: [5_000, 15_000] },
});
const discountWarehouse = /^https:\/\//.test(String(runtimeEnv.SHOPEE_DISCOUNT_WAREHOUSE_BASE_URL || ""))
  ? new WarehouseControlPriceClient({
      fetchImpl: globalThis.fetch,
      baseUrl: runtimeEnv.SHOPEE_DISCOUNT_WAREHOUSE_BASE_URL,
      getKey: async () => {
        const settings = await dataAccess.repositories.shopeeDiscount.getSettings();
        return settings?.encryptedWarehouseKeyCiphertext ? decryptSecret(settings.encryptedWarehouseKeyCiphertext) : null;
      },
    })
  : { async scanPrices() { return { status: "BLOCKED", code: "WAREHOUSE_UNAVAILABLE", rows: [], warnings: [], evidence: {} }; } };
const discountService = new ShopeeDiscountService({
  repository: dataAccess.repositories.shopeeDiscount,
  foundation: foundationService,
  shopee: discountReadAdapter,
  warehouse: discountWarehouse,
  writeSecurity: () => ({ enabled: false, mode: "closed", reasonCode: "SCHEDULER_PREVIEW_ONLY" }),
  siteCapabilities: {
    [shopeeDiscountCountry]: {
      currency: runtimeEnv.SHOPEE_DISCOUNT_CURRENCY || (shopeeDiscountCountry === "TH" ? "THB" : ""),
      scale: Number(runtimeEnv.SHOPEE_DISCOUNT_PRICE_SCALE || 2),
      minMinor: runtimeEnv.SHOPEE_DISCOUNT_MIN_PRICE_MINOR || "1",
      maxMinor: runtimeEnv.SHOPEE_DISCOUNT_MAX_PRICE_MINOR || "999999999",
      stepMinor: runtimeEnv.SHOPEE_DISCOUNT_PRICE_STEP_MINOR || "1",
    },
  },
});

let discountNotifications = null;
const discountDingtalkConfigId = String(runtimeEnv.SHOPEE_DISCOUNT_DINGTALK_CONFIG_ID || "").trim();
const discountEntryBaseUrl = String(runtimeEnv.SHOPEE_DISCOUNT_ENTRY_BASE_URL || "").trim();
if (discountDingtalkConfigId && discountEntryBaseUrl) {
  const robot = await db.getDingtalkConfig(discountDingtalkConfigId, { includeSecret: true });
  if (!robot?.enabled) throw new Error("Configured Shopee Discount DingTalk group is unavailable");
  discountNotifications = new ShopeeDiscountNotifications({
    repository: dataAccess.repositories.shopeeDiscount,
    groupId: discountDingtalkConfigId,
    entryBaseUrl: discountEntryBaseUrl,
    transport: async ({ payload }) => sendDingtalkMessage({
      webhookUrl: decryptSecret(robot.encryptedWebhookUrl),
      secret: robot.encryptedSecret ? decryptSecret(robot.encryptedSecret) : "",
      title: payload.markdown.title,
      markdown: payload.markdown.text,
    }),
  });
}

let discountScheduler;
discountScheduler = new ShopeeDiscountScheduler({
  repository: dataAccess.repositories.shopeeDiscount,
  foundation: foundationService,
  notifications: discountNotifications,
  externalTaskPolicy,
  ownerId: `${scheduler.ownerId}:shopee-discount`,
  acquireSharedLease: () => db.acquireLease(
    "mabang_scheduler", scheduler.ownerId, new Date(), Math.max(30_000, scheduler.pollIntervalMs * 3),
  ),
  dailyScope: shopeeDiscountSchedulerEnabled && shopeeDiscountShopIds.length
    ? { country: shopeeDiscountCountry, shopIds: shopeeDiscountShopIds }
    : null,
  pollIntervalMs: Number(runtimeEnv.SHOPEE_DISCOUNT_POLL_INTERVAL_MS || 60_000),
  onError: (cause) => console.error(`Shopee Discount scheduler tick failed: ${cause?.code || cause?.message || "unknown"}`),
  scan: async ({ country, shopIds, timeZone }) => {
    let scheduled = 0;
    for (const shopId of shopIds) {
      const activities = await discountService.listActivities({ shopId, status: "ACTIVE", limit: 1000 });
      const current = activities.find((activity) => activity.endsAt || activity.targetEndsAt);
      if (!current) continue;
      await discountScheduler.scheduleRenewal({
        country, shopId, category: shopeeDiscountCategory,
        currentEndsAt: current.endsAt || current.targetEndsAt,
        currentTier: current.metadata?.priceTier || "DAILY",
        priceTier: shopeeDiscountTier,
        timeZone,
        variantCount: Number(current.metadata?.variantCount || 0),
        throughputPerHour: Number(runtimeEnv.SHOPEE_DISCOUNT_CAPACITY_PER_HOUR || 1000),
        safetyFactor: Number(runtimeEnv.SHOPEE_DISCOUNT_CAPACITY_SAFETY_FACTOR || 1.5),
        minimumDraftLeadHours: Number(runtimeEnv.SHOPEE_DISCOUNT_MIN_DRAFT_LEAD_HOURS || 24),
        maximumDraftLeadDays: Number(runtimeEnv.SHOPEE_DISCOUNT_MAX_DRAFT_LEAD_DAYS || 30),
      });
      scheduled += 1;
    }
    return { scheduled };
  },
  createRenewalDraft: async (payload) => discountService.createPreview({
    country: payload.country,
    shopIds: [payload.shopId],
    useDefaultShops: false,
    workflow: "NEXT_RENEWAL",
    defaultTier: payload.priceTier || "DAILY",
    category: payload.category || shopeeDiscountCategory,
    shopOverrides: [],
    linkOverrides: [],
    activitySelection: [],
    renewal: { requestedStartAt: payload.targetStartsAt, durationDays: 30 },
  }, { actorId: "shopee-discount-scheduler", requestId: `scheduler-${Date.now()}` }),
  // Execution remains fail-closed here. Operators queue approved execution through the API;
  // Task 6's executor is invoked only by a deployment-specific worker context with all write gates.
  executeApprovedPlan: null,
});

let shopeeHealthTimer = null;
if (!externalTaskPolicy.status().enabled) {
  console.log("External task runners disabled by configuration.");
} else if (await scheduler.start({ requireInitialLease: true })) {
  externalTaskPolicy.setState("active");
  await shopeeHealthService.runScheduledIfDue();
  shopeeHealthTimer = setInterval(() => shopeeHealthService.runScheduledIfDue(), 60_000);
  if (shopeeDiscountSchedulerEnabled) await discountScheduler.start();
  console.log(`Mabang scheduler started. Poll interval: ${scheduler.pollIntervalMs}ms`);
  console.log("Shopee health scheduler started. Daily timezone: Asia/Shanghai");
} else {
  externalTaskPolicy.setState("waiting_for_lease");
  console.log("External task runners waiting for the shared scheduler lease.");
}

async function shutdown() {
  if (shopeeHealthTimer) clearInterval(shopeeHealthTimer);
  await discountScheduler.stop();
  await scheduler.stop();
  await dataAccess.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
