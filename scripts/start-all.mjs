import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "../lib/env.mjs";
import { resolveRuntimeConfig, runtimeEnvironment } from "../lib/runtime-config.mjs";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
loadLocalEnv(rootDir);
const runtimeConfig = resolveRuntimeConfig({ bootstrapRoot: rootDir, env: process.env });
const childEnv = { ...process.env, ...runtimeEnvironment(runtimeConfig) };
const children = ["server.mjs", "scheduler.mjs"].map((entry) => spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(rootDir, entry)], {
  cwd: runtimeConfig.appRoot,
  env: childEnv,
  stdio: "inherit",
  windowsHide: true,
}));

let stopping = false;
function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode == null && !child.killed) child.kill();
  }
  setTimeout(() => process.exit(exitCode), 1500).unref();
}

for (const child of children) {
  child.on("exit", (code) => {
    if (!stopping) stop(code || 1);
  });
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
