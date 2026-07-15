import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "./lib/env.mjs";
import { createMabangWorkerRunner } from "./lib/mabang-worker-runner.mjs";
import { openSchedulerDatabase } from "./lib/mabang-scheduler/db.mjs";
import { createTaskExecutor } from "./lib/mabang-scheduler/executor.mjs";
import { MabangSchedulerService } from "./lib/mabang-scheduler/service.mjs";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
loadLocalEnv(rootDir);

const exportRoot = path.resolve(rootDir, process.env.EXPORT_STORAGE_PATH || "storage/exports/mabang");
const db = openSchedulerDatabase({ rootDir });
const runWorker = createMabangWorkerRunner({ rootDir, exportRoot });
const executor = createTaskExecutor({ db, runWorker, exportRoot });
const scheduler = new MabangSchedulerService({ db, executor, exportRoot });

scheduler.start();
console.log(`Mabang scheduler started. Poll interval: ${scheduler.pollIntervalMs}ms`);

function shutdown() {
  scheduler.stop();
  db.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
