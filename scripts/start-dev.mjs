import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveAppConfig } from "../lib/app-access.mjs";
import { loadLocalEnv } from "../lib/env.mjs";
import { resolveRuntimeConfig, runtimeEnvironment } from "../lib/runtime-config.mjs";
import { resolveFulfillmentConfig } from "../fulfillment-service/config.mjs";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
loadLocalEnv(rootDir);
const runtimeConfig = resolveRuntimeConfig({ bootstrapRoot: rootDir, env: process.env });
const appConfig = resolveAppConfig(process.env);
const fulfillmentConfig = resolveFulfillmentConfig({ rootDir });
const childEnv = { ...process.env, ...runtimeEnvironment(runtimeConfig), COMMERCE_OPS_DEV: "1" };

function probeHost(host) {
  return ["0.0.0.0", "::", "[::]"].includes(String(host).trim()) ? "127.0.0.1" : host;
}

async function portIsActive(url) {
  try { return (await fetch(url, { signal: AbortSignal.timeout(1000) })).ok; }
  catch { return false; }
}

const active = [];
const mainUrl = `http://${probeHost(appConfig.host)}:${appConfig.port}/api/health`;
const fulfillmentUrl = `http://${probeHost(fulfillmentConfig.host)}:${fulfillmentConfig.port}/health`;
if (await portIsActive(mainUrl)) active.push(`main (${mainUrl})`);
if (await portIsActive(fulfillmentUrl)) active.push(`fulfillment (${fulfillmentUrl})`);
if (active.length) {
  console.error(`Cannot start unified development mode because services are already running: ${active.join(", ")}`);
  console.error("Stop the Windows background task with scripts\\stop-system.cmd, then run npm.cmd run dev again.");
  process.exitCode = 1;
  await new Promise((resolve) => setTimeout(resolve, 1100));
} else {
const specs = [
  { name: "main", args: ["--watch", "--watch-preserve-output", path.join(rootDir, "server.mjs")] },
  { name: "scheduler", args: [path.join(rootDir, "scheduler.mjs")] },
  { name: "fulfillment", args: ["--watch", "--watch-preserve-output", path.join(rootDir, "fulfillment-service", "server.mjs")] },
];
const children = new Map();
let stopping = false;

function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children.values()) {
    if (!child.killed && child.exitCode == null) child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(exitCode), 1500).unref();
}

for (const spec of specs) {
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", ...spec.args], {
    cwd: runtimeConfig.appRoot,
    env: childEnv,
    windowsHide: true,
    stdio: "inherit",
  });
  children.set(spec.name, child);
  child.once("error", (error) => {
    console.error(`[${spec.name}] failed to start: ${error.code || error.message}`);
    stop(1);
  });
  child.once("exit", (code) => {
    if (!stopping) {
      console.error(`[${spec.name}] stopped; unified development mode is shutting down.`);
      stop(code || 1);
    }
  });
}

console.log(`Unified development mode started: main ${appConfig.port}, fulfillment ${fulfillmentConfig.port}.`);
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
}
