import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "../lib/env.mjs";
import { resolvePythonRuntime, pythonRuntimeError } from "../lib/python-runtime.mjs";
import { resolveRuntimeConfig, runtimeEnvironment } from "../lib/runtime-config.mjs";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
loadLocalEnv(rootDir);
const config = resolveRuntimeConfig({ bootstrapRoot: rootDir, env: process.env });
const runtimeEnv = { ...process.env, ...runtimeEnvironment(config) };
const python = resolvePythonRuntime({
  appRoot: config.appRoot,
  env: runtimeEnv,
  requiredModules: ["openpyxl", "pandas", "requests"],
});
if (!python.ok) throw pythonRuntimeError(python, "Mabang-getdata tests");

const result = spawnSync(
  python.executable,
  ["-m", "unittest", "discover", "-s", ".", "-p", "test_*.py"],
  {
    cwd: config.mabangListingServiceDir,
    env: { ...runtimeEnv, PYTHONIOENCODING: "utf-8" },
    encoding: "utf8",
    windowsHide: true,
    stdio: "inherit",
  },
);
process.exit(result.status ?? 1);
