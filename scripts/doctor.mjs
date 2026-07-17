import { constants, existsSync, accessSync, readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { loadLocalEnv } from "../lib/env.mjs";
import { resolveRuntimeConfig } from "../lib/runtime-config.mjs";
import { resolvePythonRuntime } from "../lib/python-runtime.mjs";
import { resolveChromeRuntime } from "../lib/chrome-runtime.mjs";

const bootstrapRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
loadLocalEnv(bootstrapRoot);
const rows = [];
const add = (level, name, detail) => rows.push({ level, name, detail });

let config;
try {
  config = resolveRuntimeConfig({ bootstrapRoot, env: process.env });
  add("OK", "runtime configuration", "resolved");
} catch (error) {
  add("ERROR", "runtime configuration", String(error.message || "invalid configuration"));
}

add("OK", "Node.js", process.version);
const packagePath = path.join(bootstrapRoot, "package.json");
add(existsSync(packagePath) ? "OK" : "ERROR", "npm project", "package metadata");
if (existsSync(packagePath)) {
  const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
  const dependencies = Object.keys({ ...(pkg.dependencies || {}), ...(pkg.optionalDependencies || {}) });
  const missing = dependencies.filter((name) => !existsSync(path.join(bootstrapRoot, "node_modules", name)));
  add(missing.length ? "ERROR" : "OK", "npm dependencies", missing.length ? `${missing.length} missing` : `${dependencies.length} declared`);
}

if (config) {
  const python = resolvePythonRuntime({
    appRoot: config.appRoot,
    env: { ...process.env, PYTHON_EXECUTABLE: config.pythonExecutable, PYTHON_VENV_DIR: config.pythonVenvDir },
    requiredModules: ["openpyxl", "pandas", "requests"],
  });
  add(python.ok ? "OK" : "ERROR", "Python", python.ok ? `${python.version} (${python.source})` : python.errorCode);
  add(existsSync(config.mabangWorkerPath) ? "OK" : "ERROR", "Mabang worker", existsSync(config.mabangWorkerPath) ? "available" : "missing");
  add(existsSync(path.join(config.adServiceDir, "server.mjs")) ? "OK" : (config.adServiceMode === "external" ? "WARNING" : "ERROR"), "advertising service", `${config.adServiceMode} mode`);
  add(existsSync(config.databasePath) ? "OK" : "ERROR", "SQLite", existsSync(config.databasePath) ? "configured database exists" : "configured database is missing");
  if (existsSync(config.databasePath)) {
    try {
      const db = new DatabaseSync(config.databasePath, { readOnly: true });
      const integrity = db.prepare("PRAGMA integrity_check").get().integrity_check;
      db.close();
      add(integrity === "ok" ? "OK" : "ERROR", "SQLite integrity", integrity === "ok" ? "ok" : "failed");
    } catch {
      add("ERROR", "SQLite integrity", "read-only check failed");
    }
  }
  try {
    accessSync(config.storageRoot, constants.R_OK | constants.W_OK);
    add("OK", "storage", "readable and writable");
  } catch {
    add("ERROR", "storage", "unavailable or not writable");
  }
  const chrome = resolveChromeRuntime({ env: { ...process.env, CHROME_EXECUTABLE: config.chromeExecutable } });
  add(chrome.ok ? "OK" : "WARNING", "Chrome", chrome.ok ? chrome.source : chrome.errorCode);
  const externalHost = !["127.0.0.1", "localhost", "::1"].includes(String(process.env.APP_HOST || "127.0.0.1").toLowerCase());
  const unauthenticatedLan = /^(1|true|yes|on)$/i.test(String(process.env.APP_ALLOW_UNAUTHENTICATED_LAN || "").trim());
  const accessConfigured = Boolean(process.env.APP_ACCESS_TOKEN) || unauthenticatedLan;
  add(!externalHost || accessConfigured ? "OK" : "ERROR", "main access policy", externalHost
    ? (unauthenticatedLan ? "unauthenticated LAN access explicitly enabled" : "access token configured")
    : "loopback mode");
  const tokenReady = Boolean(process.env.AD_SERVICE_INTERNAL_TOKEN) || existsSync(config.adServiceTokenFile);
  add(tokenReady ? "OK" : "WARNING", "advertising internal token", tokenReady ? "configured" : "will be generated on first managed start");
  for (const [name, host, port] of [["main port", process.env.APP_HOST || "127.0.0.1", Number(process.env.APP_PORT || 3101)], ["advertising port", config.adServiceHost, config.adServicePort]]) {
    const occupied = await portOpen(host, port);
    add(occupied ? "WARNING" : "OK", name, occupied ? "already in use" : "available");
  }
}

for (const row of rows) console.log(`${row.level.padEnd(7)} ${row.name}: ${row.detail}`);
process.exitCode = rows.some((row) => row.level === "ERROR") ? 1 : 0;

function portOpen(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(500);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}
