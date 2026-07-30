import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveAppConfig } from "../lib/app-access.mjs";
import { loadLocalEnv } from "../lib/env.mjs";
import { resolveRuntimeConfig, runtimeEnvironment } from "../lib/runtime-config.mjs";
import { resolveFulfillmentConfig } from "../fulfillment-service/config.mjs";
import { createSystemServiceDefinitions, nextRestartDelay } from "../lib/system-startup-policy.mjs";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
loadLocalEnv(rootDir);
const runtimeConfig = resolveRuntimeConfig({ bootstrapRoot: rootDir, env: process.env });
const appConfig = resolveAppConfig(process.env);
const fulfillmentConfig = resolveFulfillmentConfig({ rootDir });
const childEnv = { ...process.env, ...runtimeEnvironment(runtimeConfig), COMMERCE_OPS_SUPERVISED: "1" };
const logDir = path.join(rootDir, "storage", "logs");
const logPath = path.join(logDir, "commerce-ops-system.log");
const lockPath = path.join(rootDir, "storage", "commerce-ops-supervisor.lock");
mkdirSync(logDir, { recursive: true });

function rotateLogIfNeeded() {
  try {
    if (!existsSync(logPath) || Number(statSync(logPath).size) < 5 * 1024 * 1024) return;
    const suffix = new Date().toISOString().replace(/[:.]/g, "-");
    renameSync(logPath, path.join(logDir, `commerce-ops-system-${suffix}.log`));
  } catch {}
}

function log(service, message) {
  const safe = String(message || "").replace(/[\r\n]+/g, " ").slice(0, 4000);
  const line = `[${new Date().toISOString()}] [${service}] ${safe}\n`;
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
      log("system", `Unified supervisor already running with PID ${existingPid}; exiting duplicate instance.`);
      process.exit(0);
    }
    try { unlinkSync(lockPath); } catch {}
  }
  const descriptor = openSync(lockPath, "wx");
  writeFileSync(descriptor, String(process.pid));
  closeSync(descriptor);
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function healthy(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch { return false; }
}

const services = createSystemServiceDefinitions({ rootDir, appConfig, fulfillmentConfig });

rotateLogIfNeeded();
acquireLock();
let stopping = false;
const children = new Map();
const owned = new Set();

async function supervise(spec) {
  let restartDelay = 2000;
  let waitingForExternal = false;
  while (!stopping) {
    if (spec.requiresOwned && !owned.has(spec.requiresOwned)) {
      await delay(1000);
      continue;
    }
    if (spec.healthUrl && await healthy(spec.healthUrl)) {
      if (!waitingForExternal) log(spec.name, `A healthy service already exists at ${spec.healthUrl}; monitoring it instead of starting a duplicate.`);
      waitingForExternal = true;
      await delay(10000);
      continue;
    }
    waitingForExternal = false;
    const startedAt = Date.now();
    log(spec.name, `Starting ${path.relative(rootDir, spec.entry)}.`);
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", spec.entry], {
      cwd: runtimeConfig.appRoot,
      env: childEnv,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.set(spec.name, child);
    owned.add(spec.name);
    child.stdout.on("data", (chunk) => log(spec.name, `OUT ${String(chunk).trimEnd()}`));
    child.stderr.on("data", (chunk) => log(spec.name, `ERR ${String(chunk).trimEnd()}`));
    const exit = await new Promise((resolve) => {
      child.once("error", (error) => resolve({ code: null, signal: null, error }));
      child.once("exit", (code, signal) => resolve({ code, signal, error: null }));
    });
    children.delete(spec.name);
    owned.delete(spec.name);
    if (stopping) break;
    const runtime = Date.now() - startedAt;
    restartDelay = nextRestartDelay({ previousDelay: restartDelay, runtimeMs: runtime });
    log(spec.name, `Stopped unexpectedly (${exit.error?.code || exit.code || exit.signal || "unknown"}); restarting in ${restartDelay / 1000}s.`);
    await delay(restartDelay);
  }
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  log("system", "Stopping unified supervisor and owned services.");
  for (const child of children.values()) {
    if (!child.killed && child.exitCode == null) child.kill("SIGTERM");
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", () => { try { unlinkSync(lockPath); } catch {} });

log("system", "Unified Commerce Ops supervisor started.");
Promise.all(services.map(supervise)).finally(() => {
  try { unlinkSync(lockPath); } catch {}
  process.exit(0);
});
