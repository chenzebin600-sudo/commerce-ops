import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "./lib/env.mjs";
import { createMabangWorkerRunner } from "./lib/mabang-worker-runner.mjs";
import { createMabangDataPersistenceService } from "./lib/mabang-data/persistence-service.mjs";
import { openProviderRuntimeDataAccess } from "./lib/data/provider-runtime-data-access.mjs";
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
import { createExportFileService } from "./lib/files/export-file-service.mjs";
import { pythonRuntimeError, resolvePythonRuntime } from "./lib/python-runtime.mjs";
import { AiGateway } from "./lib/ai/ai-gateway.mjs";
import { createAiAuditLogger } from "./lib/ai/ai-audit-logger.mjs";
import { DeepSeekProvider, resolveDeepSeekEndpoint } from "./lib/ai/providers/deepseek-provider.mjs";
import { AgentRuntime } from "./lib/ai/agent/agent-runtime.mjs";
import { AiContextService } from "./lib/ai/context/ai-context-service.mjs";
import { DailyReportContextService } from "./lib/ai/context/daily-report-context-service.mjs";
import { registerDailyReportContext } from "./lib/ai/context/daily-report-context-registration.mjs";
import { AgentToolRegistry } from "./lib/ai/tools/agent-tool-registry.mjs";
import { FoundationService } from "./lib/foundation/foundation-service.mjs";
import { SalesAssortmentService } from "./lib/sales-assortment/sales-assortment-service.mjs";
import { createMysqlPriceControlSource } from "./lib/price-control/mysql-price-control-source.mjs";
import { PriceControlService } from "./lib/price-control/price-control-service.mjs";
import { PriceControlScheduleRunner } from "./lib/price-control/price-control-schedule-runner.mjs";
import { PriceControlDingtalkNotifier } from "./lib/price-control/price-control-dingtalk.mjs";
import { createMysqlProductPackageSource } from "./lib/product-package-sync/mysql-product-package-source.mjs";
import { ProductPackageSyncService } from "./lib/product-package-sync/product-package-sync-service.mjs";
import { ProductPackageScheduleRunner } from "./lib/product-package-sync/product-package-schedule-runner.mjs";
import {
  DAILY_REPORT_AGENT_DEFINITION,
  DAILY_REPORT_AGENT_OUTPUT_VALIDATOR,
  DailyReportAgent,
} from "./lib/sales-assortment/daily-report-agent.mjs";
import {
  buildSalesAssortmentDailyReport,
  salesDailyReportScopeFor,
} from "./lib/sales-assortment/sales-assortment-daily-report.mjs";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
loadLocalEnv(rootDir);
const runtimeConfig = resolveRuntimeConfig({ bootstrapRoot: rootDir, env: process.env });
const runtimeEnv = { ...process.env, ...runtimeEnvironment(runtimeConfig) };

const fileStorage = await ensureFileStorageRoots(resolveFileStorageConfig(runtimeConfig.appRoot, runtimeEnv));
const cleanup = await cleanupTemporaryFiles(fileStorage.tempRoot, {
  retentionHours: fileStorage.tempFileRetentionHours,
});
if (cleanup.removed || cleanup.errors) {
  console.log(`Temporary file cleanup: ${cleanup.removed} removed, ${cleanup.errors} errors`);
}
const exportRoot = fileStorage.exportRoot;
const dataAccess = openProviderRuntimeDataAccess({
  rootDir: runtimeConfig.appRoot,
  databasePath: runtimeConfig.databasePath,
  env: runtimeEnv,
});
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
const aiGateway = new AiGateway({
  provider: new DeepSeekProvider({
    apiKey: deepSeekApiKey,
    endpoint: resolveDeepSeekEndpoint(runtimeEnv.DEEPSEEK_BASE_URL),
  }),
  logger: createAiAuditLogger({ audit }),
});
const foundationService = new FoundationService({ repository: dataAccess.repositories.foundation });
const priceControlSyncEnabled = String(runtimeEnv.PRICE_CONTROL_SYNC_ENABLED || "").toLowerCase() === "true";
const priceControlSource = createMysqlPriceControlSource(runtimeEnv);
const priceControlService = new PriceControlService({
  repository: dataAccess.repositories.priceControl,
  source: priceControlSource,
  foundationRepository: dataAccess.repositories.foundation,
  foundationTaskService: foundationService.tasks,
  notificationConfigRepository: db,
  audit,
  syncEnabled: priceControlSyncEnabled,
  syncIntervalMs: runtimeEnv.PRICE_CONTROL_SYNC_INTERVAL_MS,
  staleRunTimeoutMs: runtimeEnv.PRICE_CONTROL_STALE_RUN_TIMEOUT_MS,
  batchLimit: runtimeEnv.PRICE_CONTROL_BATCH_LIMIT,
  batchesPerCountry: runtimeEnv.PRICE_CONTROL_BATCHES_PER_COUNTRY,
});
const priceControlNotifier = new PriceControlDingtalkNotifier({
  configRepository: db,
  audit,
});
const priceControlScheduleRunner = new PriceControlScheduleRunner({
  service: priceControlService,
  notifier: priceControlNotifier,
  enabled: priceControlSyncEnabled,
  intervalMs: Number(runtimeEnv.PRICE_CONTROL_SYNC_INTERVAL_MS || 60 * 60 * 1000),
});
const productPackageSyncEnabled = String(runtimeEnv.PRODUCT_PACKAGE_SYNC_ENABLED || "").toLowerCase() === "true";
const productPackageSource = createMysqlProductPackageSource(runtimeEnv);
const productPackageSyncService = dataAccess.repositories.productPackageSync
  ? new ProductPackageSyncService({
    repository: dataAccess.repositories.productPackageSync,
    source: productPackageSource,
    enabled: productPackageSyncEnabled,
    manualSyncEnabled: true,
    batchSize: runtimeEnv.PRODUCT_PACKAGE_SYNC_BATCH_SIZE,
    maxRemovalRatio: runtimeEnv.PRODUCT_PACKAGE_MAX_REMOVAL_RATIO,
    audit,
  })
  : null;
const productPackageScheduleRunner = productPackageSyncService
  ? new ProductPackageScheduleRunner({ service: productPackageSyncService, enabled: productPackageSyncEnabled })
  : null;
const aiContextService = new AiContextService({ repository: dataAccess.repositories.aiContext });
const dailyReportContextService = new DailyReportContextService();
registerDailyReportContext({
  registry: aiContextService.registry,
  contextService: dailyReportContextService,
});
const agentRuntime = new AgentRuntime({
  taskService: foundationService.tasks,
  contextRegistry: aiContextService.registry,
  toolRegistry: new AgentToolRegistry(),
  gateway: aiGateway,
  auditService: audit,
});
const dailyReportAgent = agentRuntime.createAgent({
  definition: DAILY_REPORT_AGENT_DEFINITION,
  Agent: DailyReportAgent,
  options: {
    configured: Boolean(deepSeekApiKey),
    model: runtimeEnv.SALES_ASSORTMENT_DEEPSEEK_MODEL
      || runtimeEnv.DEEPSEEK_MODEL
      || "deepseek-v4-flash",
  },
  outputValidator: DAILY_REPORT_AGENT_OUTPUT_VALIDATOR,
});
const executor = createTaskExecutor({
  db,
  runWorker,
  exportRoot,
  tempRoot: fileStorage.tempRoot,
  audit,
  fileService: exportFileService,
  persistCollectedData: (input) => mabangDataPersistence.persistFile(input),
  generateDailyReport: async ({ generatedAt, run }) => {
    const reportScope = salesDailyReportScopeFor(generatedAt);
    const dashboard = await salesAssortmentService.dashboard(reportScope);
    let analysis = null;
    if (deepSeekApiKey) {
      try {
        const contextInput = dailyReportContextService.prepareInput({ dashboard, generatedAt });
        const agentRun = await dailyReportAgent.run({
          contextInput,
          generatedAt,
          requestId: run.id,
          idempotencyKey: run.id,
          correlationId: run.id,
          requestedBy: "mabang-scheduler",
        });
        analysis = agentRun.analysis;
      } catch (error) {
        console.warn(`Daily Report Agent V2 summary skipped: ${error.message}`);
      }
    }
    return buildSalesAssortmentDailyReport({ dashboard, analysis, generatedAt });
  },
});
const scheduler = new MabangSchedulerService({ db, executor, exportRoot, audit });

await scheduler.start();
priceControlScheduleRunner.start();
productPackageScheduleRunner?.start();
console.log(`Mabang scheduler started. Poll interval: ${scheduler.pollIntervalMs}ms`);
if (priceControlSyncEnabled) console.log(`Price control scheduler started. Poll interval: ${priceControlScheduleRunner.intervalMs}ms`);
if (productPackageSyncEnabled) console.log("Product package scheduler started. Daily time: 09:00 Asia/Shanghai");

async function shutdown() {
  await scheduler.stop();
  priceControlScheduleRunner.stop();
  productPackageScheduleRunner?.stop();
  await productPackageSource?.close().catch(() => null);
  await priceControlSource?.close().catch(() => null);
  await dataAccess.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
