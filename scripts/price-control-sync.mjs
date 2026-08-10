import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "../lib/env.mjs";
import { openProviderRuntimeDataAccess } from "../lib/data/provider-runtime-data-access.mjs";
import { FoundationService } from "../lib/foundation/foundation-service.mjs";
import { createMysqlPriceControlSource } from "../lib/price-control/mysql-price-control-source.mjs";
import { PriceControlService } from "../lib/price-control/price-control-service.mjs";
import { resolveRuntimeConfig, runtimeEnvironment } from "../lib/runtime-config.mjs";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
loadLocalEnv(rootDir);
const runtimeConfig = resolveRuntimeConfig({ bootstrapRoot: rootDir, env: process.env });
const runtimeEnv = { ...process.env, ...runtimeEnvironment(runtimeConfig) };
const mode = process.argv.includes("--baseline") ? "baseline" : "incremental";
const source = createMysqlPriceControlSource(runtimeEnv);
if (!source) throw new Error("Price control source is not configured.");
const dataAccess = openProviderRuntimeDataAccess({
  rootDir: runtimeConfig.appRoot,
  databasePath: runtimeConfig.databasePath,
  env: runtimeEnv,
});
const foundation = new FoundationService({ repository: dataAccess.repositories.foundation });
const service = new PriceControlService({
  repository: dataAccess.repositories.priceControl,
  source,
  foundationRepository: dataAccess.repositories.foundation,
  foundationTaskService: foundation.tasks,
  syncEnabled: true,
  manualSyncEnabled: true,
  batchLimit: runtimeEnv.PRICE_CONTROL_BATCH_LIMIT,
  batchesPerCountry: runtimeEnv.PRICE_CONTROL_BATCHES_PER_COUNTRY,
});

try {
  const result = await service.sync({ mode, triggerType: "manual", requestedBy: "price-control-cli" });
  console.log(JSON.stringify({
    id: result.run.id,
    mode: result.run.syncMode,
    status: result.run.status,
    batchesSeen: result.run.batchesSeen,
    batchesApplied: result.run.batchesApplied,
    sourceRowsSeen: result.run.sourceRowsSeen,
    pricePointsSeen: result.run.pricePointsSeen,
    changeCount: result.run.changeCount,
    sourceCheckedAt: result.run.sourceCheckedAt,
    sourceTableUpdatedAt: result.run.sourceTableUpdatedAt,
    sourceBusinessUpdatedAt: result.run.sourceBusinessUpdatedAt,
    fetchedAt: result.run.fetchedAt,
  }, null, 2));
} finally {
  await source.close();
  await dataAccess.close();
}
