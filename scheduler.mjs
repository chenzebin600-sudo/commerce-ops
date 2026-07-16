import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "./lib/env.mjs";
import { createMabangWorkerRunner } from "./lib/mabang-worker-runner.mjs";
import { openSchedulerDatabase } from "./lib/mabang-scheduler/db.mjs";
import { createTaskExecutor } from "./lib/mabang-scheduler/executor.mjs";
import { MabangSchedulerService } from "./lib/mabang-scheduler/service.mjs";
import {
  cleanupTemporaryFiles,
  ensureFileStorageRoots,
  resolveFileStorageConfig,
} from "./lib/security/file-policy.mjs";
import { createOperationAuditService } from "./lib/security/audit-service.mjs";
import { resolveRuntimeConfig, runtimeEnvironment } from "./lib/runtime-config.mjs";

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
const db = openSchedulerDatabase({ rootDir: runtimeConfig.appRoot, databasePath: runtimeConfig.databasePath });
const audit = createOperationAuditService({ db, env: process.env });
const runWorker = createMabangWorkerRunner({
  rootDir: runtimeConfig.appRoot,
  exportRoot: fileStorage.tempRoot,
  runtimeConfig,
  env: runtimeEnv,
});
const executor = createTaskExecutor({ db, runWorker, exportRoot, tempRoot: fileStorage.tempRoot, audit });
const scheduler = new MabangSchedulerService({ db, executor, exportRoot, audit });

scheduler.start();
console.log(`Mabang scheduler started. Poll interval: ${scheduler.pollIntervalMs}ms`);

function shutdown() {
  scheduler.stop();
  db.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
