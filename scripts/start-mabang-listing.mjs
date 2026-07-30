import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "../lib/env.mjs";
import { resolvePythonRuntime, pythonRuntimeError } from "../lib/python-runtime.mjs";
import { resolveRuntimeConfig, runtimeEnvironment } from "../lib/runtime-config.mjs";
import { resolveMabangListingInternalToken } from "../lib/mabang-listing-token.mjs";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
loadLocalEnv(rootDir);
const config = resolveRuntimeConfig({ bootstrapRoot: rootDir, env: process.env });
const runtimeEnv = { ...process.env, ...runtimeEnvironment(config) };
const python = resolvePythonRuntime({
  appRoot: config.appRoot,
  env: runtimeEnv,
  requiredModules: ["requests"],
});
if (!python.ok) throw pythonRuntimeError(python, "Mabang listing");

const internalToken = await resolveMabangListingInternalToken({
  configuredToken: process.env.MABANG_LISTING_INTERNAL_TOKEN,
  tokenFile: config.mabangListingTokenFile,
});
const entry = path.join(
  config.mabangListingServiceDir,
  "mabang_listing_service.py",
);
const child = spawn(python.executable, [entry], {
  cwd: config.mabangListingServiceDir,
  env: {
    ...runtimeEnv,
    PYTHONIOENCODING: "utf-8",
    MABANG_LISTING_HOST: config.mabangListingHost,
    MABANG_LISTING_PORT: String(config.mabangListingPort),
    MABANG_LISTING_INTERNAL_TOKEN: internalToken,
    MABANG_LISTING_STORAGE_ROOT: config.mabangListingStorageRoot,
  },
  stdio: "inherit",
  windowsHide: false,
});
child.once("exit", (code) => process.exit(code ?? 0));
