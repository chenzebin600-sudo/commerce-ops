import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "../lib/env.mjs";
import { openProviderRuntimeDataAccess } from "../lib/data/provider-runtime-data-access.mjs";
import { createMysqlProductPackageSource } from "../lib/product-package-sync/mysql-product-package-source.mjs";
import { ProductPackageSyncService } from "../lib/product-package-sync/product-package-sync-service.mjs";
import { resolveRuntimeConfig, runtimeEnvironment } from "../lib/runtime-config.mjs";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
loadLocalEnv(rootDir);
const runtimeConfig = resolveRuntimeConfig({ bootstrapRoot: rootDir, env: process.env });
const runtimeEnv = { ...process.env, ...runtimeEnvironment(runtimeConfig) };
const access = openProviderRuntimeDataAccess({
  rootDir: runtimeConfig.appRoot,
  databasePath: runtimeConfig.databasePath,
  env: runtimeEnv,
});
const source = createMysqlProductPackageSource(runtimeEnv);

try {
  if (!access.repositories.productPackageSync) throw new Error("Product package database sync requires PostgreSQL.");
  const service = new ProductPackageSyncService({
    repository: access.repositories.productPackageSync,
    source,
    enabled: true,
    manualSyncEnabled: true,
    batchSize: runtimeEnv.PRODUCT_PACKAGE_SYNC_BATCH_SIZE,
    maxRemovalRatio: runtimeEnv.PRODUCT_PACKAGE_MAX_REMOVAL_RATIO,
  });
  const result = await service.sync({
    triggerType: process.argv.includes("--initial") ? "initial" : "manual",
    requestedBy: "product-package-cli",
    allowLargeRemoval: process.argv.includes("--allow-large-removal"),
  });
  console.log(JSON.stringify({
    id: result.run.id,
    status: result.run.status,
    changed: result.changed,
    sourceRowCount: result.run.sourceRowCount,
    localRowCountAfter: result.run.localRowCountAfter,
    newCount: result.run.newCount,
    updatedCount: result.run.updatedCount,
    unchangedCount: result.run.unchangedCount,
    removedCount: result.run.removedCount,
    fieldChangeCount: result.run.fieldChangeCount,
    sourceCheckedAt: result.run.sourceCheckedAt,
    sourceMaxUpdatedAt: result.run.sourceMaxUpdatedAt,
  }, null, 2));
} finally {
  await source?.close().catch(() => null);
  await access.close();
}
