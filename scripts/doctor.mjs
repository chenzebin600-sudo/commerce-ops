import { constants, existsSync, accessSync, readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { loadLocalEnv } from "../lib/env.mjs";
import { inspectRuntimeIsolation, resolveRuntimeConfig } from "../lib/runtime-config.mjs";
import { resolvePythonRuntime } from "../lib/python-runtime.mjs";
import { resolveChromeRuntime } from "../lib/chrome-runtime.mjs";
import { loadSharedPostgresqlConfig } from "../lib/data/postgresql/shared-runtime-config.mjs";
import { openProvider } from "../lib/data/open-provider.mjs";
import { inspectPostgresqlReadiness } from "../lib/data/postgresql/postgresql-doctor.mjs";
import { createExternalTaskPolicy } from "../lib/runtime/external-task-policy.mjs";

const bootstrapRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
loadLocalEnv(bootstrapRoot);
const rows = [];
const add = (level, name, detail) => rows.push({ level, name, detail });

let config;
const isolation = inspectRuntimeIsolation({ bootstrapRoot, env: process.env });
for (const item of isolation.checks) {
  add(item.ok ? "OK" : "ERROR", `isolation ${item.id}`, item.detail);
}
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
  add("OK", "runtime profile", config.runtimeProfile);
  add("OK", "database provider", config.databaseProvider);
  add("OK", "storage path", path.relative(config.appRoot, config.storageRoot) || ".");
  const python = resolvePythonRuntime({
    appRoot: config.appRoot,
    env: { ...process.env, PYTHON_EXECUTABLE: config.pythonExecutable, PYTHON_VENV_DIR: config.pythonVenvDir },
    requiredModules: ["openpyxl", "pandas", "requests"],
  });
  add(python.ok ? "OK" : "ERROR", "Python", python.ok ? `${python.version} (${python.source})` : python.errorCode);
  add(existsSync(config.mabangWorkerPath) ? "OK" : "ERROR", "Mabang worker", existsSync(config.mabangWorkerPath) ? "available" : "missing");
  add(existsSync(path.join(config.adServiceDir, "server.mjs")) ? "OK" : (config.adServiceMode === "external" ? "WARNING" : "ERROR"), "advertising service", `${config.adServiceMode} mode`);
  if (config.databaseProvider === "sqlite") {
    add("OK", "SQLite path", path.relative(config.appRoot, config.databasePath) || path.basename(config.databasePath));
    add(existsSync(config.databasePath) ? "OK" : "ERROR", "SQLite", existsSync(config.databasePath) ? "configured database exists" : "configured database is missing");
  }
  if (config.databaseProvider === "sqlite" && existsSync(config.databasePath)) {
    try {
      const db = new DatabaseSync(config.databasePath, { readOnly: true });
      const integrity = db.prepare("PRAGMA integrity_check").get().integrity_check;
      db.close();
      add(integrity === "ok" ? "OK" : "ERROR", "SQLite integrity", integrity === "ok" ? "ok" : "failed");
    } catch {
      add("ERROR", "SQLite integrity", "read-only check failed");
    }
  }
  if (config.databaseProvider === "postgres") {
    let provider;
    try {
      const postgresql = loadSharedPostgresqlConfig({ rootDir: config.appRoot, env: process.env });
      const password = String(process.env.POSTGRES_APP_PASSWORD || "");
      if (!password) throw new Error("POSTGRES_APP_PASSWORD is required");
      const fingerprint = `sha256:${createHash("sha256").update(postgresql.ssl.ca).digest("hex")}`;
      provider = await openProvider({ providerName: "postgres", postgresqlConfig: postgresql, credentials: { password } });
      const external = createExternalTaskPolicy({ databaseProvider: "postgres", env: process.env }).status().state;
      const report = await inspectPostgresqlReadiness({ provider, config: postgresql, caFingerprint: fingerprint,
        externalTaskStatus: external, tcpCheck: portOpen });
      for (const [name, detail] of Object.entries(report.details)) add(report.ready ? "OK" : "ERROR", `PostgreSQL ${name}`, String(detail));
    } catch (error) {
      add("ERROR", "PostgreSQL readiness", String(error?.code || error?.message || "check failed").slice(0, 120));
    } finally { await provider?.close().catch(() => {}); }
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
  for (const [name, host, port] of [["main port", config.appHost, config.appPort], ["advertising port", config.adServiceHost, config.adServicePort]]) {
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
