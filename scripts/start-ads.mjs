import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "../lib/env.mjs";
import { resolveAdServiceInternalToken } from "../lib/ad-service-token.mjs";
import { resolveRuntimeConfig, runtimeEnvironment } from "../lib/runtime-config.mjs";
import { advertisingChildEnvironment } from "../lib/ad-service-manager.mjs";

const bootstrapRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
loadLocalEnv(bootstrapRoot);
const config = resolveRuntimeConfig({ bootstrapRoot, env: process.env });
const entry = path.join(config.adServiceDir, "server.mjs");
if (!existsSync(entry)) {
  console.error("ERROR Advertising service directory is unavailable; configure AD_SERVICE_DIR");
  process.exit(1);
}
const internalToken = await resolveAdServiceInternalToken({
  configuredToken: process.env.AD_SERVICE_INTERNAL_TOKEN,
  tokenFile: config.adServiceTokenFile,
});
const child = spawn(process.execPath, [entry], {
  cwd: config.adServiceDir,
  env: advertisingChildEnvironment({
    env: { ...process.env, ...runtimeEnvironment(config) },
    serviceDir: config.adServiceDir,
    host: config.adServiceHost,
    port: config.adServicePort,
    internalToken,
  }),
  stdio: "inherit",
  windowsHide: true,
});
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  if (child.exitCode == null && !child.killed) child.kill();
}
child.on("exit", (code) => process.exit(code || 0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
