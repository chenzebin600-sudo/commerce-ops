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

let shopeeHealthTimer = null;
if (!externalTaskPolicy.status().enabled) {
  console.log("External task runners disabled by configuration.");
} else if (await scheduler.start({ requireInitialLease: true })) {
  externalTaskPolicy.setState("active");
  await shopeeHealthService.runScheduledIfDue();
  shopeeHealthTimer = setInterval(() => shopeeHealthService.runScheduledIfDue(), 60_000);
  console.log(`Mabang scheduler started. Poll interval: ${scheduler.pollIntervalMs}ms`);
  console.log("Shopee health scheduler started. Daily timezone: Asia/Shanghai");
} else {
  externalTaskPolicy.setState("waiting_for_lease");
  console.log("External task runners waiting for the shared scheduler lease.");
}

async function shutdown() {
  if (shopeeHealthTimer) clearInterval(shopeeHealthTimer);
  await scheduler.stop();
  await dataAccess.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
