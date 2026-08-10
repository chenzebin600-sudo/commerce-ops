import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { loadLocalEnv } from "../lib/env.mjs";
import { resolveFulfillmentConfig } from "../fulfillment-service/config.mjs";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
loadLocalEnv(rootDir);
const config = resolveFulfillmentConfig({ rootDir });
const logDir = path.join(rootDir, "storage", "logs");
const logPath = path.join(logDir, "fulfillment-service.log");
const lockPath = path.join(rootDir, "storage", "fulfillment-supervisor.lock");
mkdirSync(logDir, { recursive: true });

function timestamp() { return new Date().toISOString(); }
function rotateLogIfNeeded() {
  try {
    if (!existsSync(logPath) || Number(statSync(logPath).size) < 5 * 1024 * 1024) return;
    const suffix = new Date().toISOString().replace(/[:.]/g, "-");
    renameSync(logPath, path.join(logDir, `fulfillment-service-${suffix}.log`));
  } catch {}
}
function log(message) {
  const line = `[${timestamp()}] ${String(message).replace(/[\r\n]+/g, " ")}\n`;
  try { appendFileSync(logPath, line, "utf8"); } catch {}
  process.stdout.write(line);
}
function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function acquireLock() {
  if (existsSync(lockPath)) {
    const existingPid = Number(readFileSync(lockPath, "utf8").trim());
    if (Number.isInteger(existingPid) && existingPid > 0 && processAlive(existingPid)) {
      log(`Supervisor already running with PID ${existingPid}; exiting duplicate instance.`);
      process.exit(0);
    }
    try { unlinkSync(lockPath); } catch {}
  }
  const descriptor = openSync(lockPath, "wx");
  writeFileSync(descriptor, String(process.pid));
  closeSync(descriptor);
}
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function serviceAlreadyRunning() {
  try {
    const response = await fetch(`http://${config.host}:${config.port}/health`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch { return false; }
}

rotateLogIfNeeded();
acquireLock();
let stopping = false;
let child = null;
let restartDelay = 2000;
let waitingForExistingService = false;

async function supervise() {
  while (!stopping) {
    if (await serviceAlreadyRunning()) {
      if (!waitingForExistingService) log(`A fulfillment service is already listening on ${config.host}:${config.port}; waiting before taking over.`);
      waitingForExistingService = true;
      await delay(10000);
      continue;
    }
    waitingForExistingService = false;
    const startedAt = Date.now();
    log("Starting Mabang fulfillment service.");
    child = spawn(process.execPath, [path.join(rootDir, "fulfillment-service", "server.mjs")], {
      cwd: rootDir, windowsHide: true, env: { ...process.env, FULFILLMENT_SUPERVISED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => log(`OUT ${String(chunk).trimEnd()}`));
    child.stderr.on("data", (chunk) => log(`ERR ${String(chunk).trimEnd()}`));
    const exit = await new Promise((resolve) => {
      child.once("error", (error) => resolve({ code: null, signal: null, error }));
      child.once("exit", (code, signal) => resolve({ code, signal, error: null }));
    });
    child = null;
    if (stopping) break;
    const runtime = Date.now() - startedAt;
    log(`Service stopped unexpectedly (${exit.error?.code || exit.code || exit.signal || "unknown"}); restarting in ${restartDelay / 1000}s.`);
    if (runtime > 60000) restartDelay = 2000; else restartDelay = Math.min(restartDelay * 2, 60000);
    await delay(restartDelay);
  }
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  log("Stopping fulfillment supervisor; requesting the service to drain active operations first.");
  if (child && !child.killed) {
    try {
      const response = await fetch(`http://${config.host}:${config.port}/api/fulfillment/maintenance/restart`, {
        method: "POST", headers: { "x-fulfillment-maintenance": "drain-and-restart" }, signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json().catch(() => ({}));
      log(payload.data?.message || "Fulfillment service entered drain mode.");
    } catch (error) {
      log(`Could not request a graceful drain (${error.message}); refusing to force-stop the fulfillment child.`);
      stopping = false;
      return;
    }
  }
  try { unlinkSync(lockPath); } catch {}
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", () => { try { unlinkSync(lockPath); } catch {} });

supervise().finally(() => {
  try { unlinkSync(lockPath); } catch {}
  process.exit(0);
});
