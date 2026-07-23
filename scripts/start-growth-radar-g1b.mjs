import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "../lib/env.mjs";
import { RUNTIME_PROFILES, resolveRuntimeConfig, runtimeEnvironment } from "../lib/runtime-config.mjs";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
loadLocalEnv(rootDir, {
  filenames: [".env.growth-radar-g1b.local"],
  required: true,
  override: true,
});

const config = resolveRuntimeConfig({ bootstrapRoot: rootDir, env: process.env });
if (config.runtimeProfile !== RUNTIME_PROFILES.GROWTH_RADAR_G1B) {
  throw new Error("COMMERCE_OPS_RUNTIME_PROFILE must be growth-radar-g1b");
}

const relativeDatabase = path.relative(config.appRoot, config.databasePath) || path.basename(config.databasePath);
const relativeStorage = path.relative(config.appRoot, config.storageRoot) || ".";
console.log(`Runtime profile: ${config.runtimeProfile}`);
console.log(`SQLite path: ${relativeDatabase}`);
console.log(`Storage root: ${relativeStorage}`);
console.log(`Application port: ${config.appPort}`);

const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(rootDir, "server.mjs")], {
  cwd: config.appRoot,
  env: { ...process.env, ...runtimeEnvironment(config) },
  stdio: "inherit",
  windowsHide: true,
});

let stopping = false;
function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  if (child.exitCode === null && !child.killed) child.kill(signal);
}

child.on("exit", (code, signal) => {
  if (signal) process.exitCode = 0;
  else process.exitCode = code ?? 1;
});
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
