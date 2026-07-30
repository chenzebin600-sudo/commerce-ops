import { spawn } from "node:child_process";
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
  requiredModules: ["openpyxl", "pandas", "requests", "tkinter"],
});
if (!python.ok) throw pythonRuntimeError(python, "Mabang WPS assistant");

const entry = path.join(
  config.mabangListingServiceDir,
  "mabang_assistant_app.py",
);
const child = spawn(python.executable, [entry], {
  cwd: config.mabangListingServiceDir,
  env: {
    ...runtimeEnv,
    PYTHONIOENCODING: "utf-8",
  },
  stdio: "inherit",
  windowsHide: false,
});
child.once("exit", (code) => process.exit(code ?? 0));
