import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { loadLocalEnv } from "../lib/env.mjs";
import { buildLifecycleRoots } from "../lib/files/file-lifecycle-scanner.mjs";
import { resolveRuntimeConfig } from "../lib/runtime-config.mjs";
import { resolveFileStorageConfig } from "../lib/security/file-policy.mjs";

const CORE_TABLES = Object.freeze([
  "scheduled_export_tasks",
  "scheduled_export_runs",
  "mabang_account_profiles",
  "dingtalk_robot_configs",
  "export_files",
  "managed_files",
]);

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function fileEvidence(root, row) {
  const target = path.resolve(root, String(row.relative_path || ""));
  if (!inside(root, target) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
    return { id: row.id, exists: false, size: null, digest: null };
  }
  const stat = fs.statSync(target);
  return { id: row.id, exists: true, size: stat.size, digest: sha256(fs.readFileSync(target)) };
}

export function captureF1ProtectionSnapshot({ rootDir, env = process.env } = {}) {
  const runtime = resolveRuntimeConfig({ bootstrapRoot: rootDir, env });
  const storage = resolveFileStorageConfig(rootDir, env);
  const roots = new Map(buildLifecycleRoots({ fileStorageConfig: storage, adAnalyzerDir: runtime.adServiceDir, env })
    .map((entry) => [entry.scope, entry.root]));
  const database = new DatabaseSync(runtime.databasePath, { readOnly: true });
  try {
    const tables = database.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    const counts = Object.fromEntries(tables.map(({ name }) => [name, Number(database.prepare(`SELECT count(*) count FROM "${name}"`).get().count)]));
    const core = {};
    for (const table of CORE_TABLES) {
      const rows = database.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all();
      core[table] = { count: rows.length, digest: sha256(JSON.stringify(rows)) };
    }
    const exported = database.prepare("SELECT id,relative_path FROM export_files ORDER BY id").all()
      .map((row) => fileEvidence(storage.exportRoot, row));
    const managed = database.prepare("SELECT id,root_key,relative_path FROM managed_files ORDER BY id").all()
      .map((row) => fileEvidence(roots.get(row.root_key) || "", row));
    const files = [...exported, ...managed].sort((left, right) => String(left.id).localeCompare(String(right.id)));
    return {
      version: 1,
      createdAt: new Date().toISOString(),
      databaseFilename: path.basename(runtime.databasePath),
      integrity: database.prepare("PRAGMA integrity_check").get().integrity_check,
      foreignKeyViolations: database.prepare("PRAGMA foreign_key_check").all().length,
      schemaDigest: sha256(JSON.stringify(tables)),
      tableCount: tables.length,
      counts,
      core,
      registeredFiles: {
        count: files.length,
        healthy: files.filter((file) => file.exists).length,
        digest: sha256(JSON.stringify(files)),
      },
    };
  } finally {
    database.close();
  }
}

export function compareF1ProtectionSnapshots(baseline, current) {
  const failures = [];
  if (current.integrity !== "ok") failures.push("SQLITE_INTEGRITY_FAILED");
  if (current.foreignKeyViolations !== 0) failures.push("SQLITE_FOREIGN_KEY_FAILED");
  if (baseline.schemaDigest !== current.schemaDigest) failures.push("SQLITE_SCHEMA_CHANGED");
  for (const table of CORE_TABLES) {
    if (baseline.core?.[table]?.count !== current.core?.[table]?.count) failures.push(`CORE_COUNT_CHANGED:${table}`);
    if (baseline.core?.[table]?.digest !== current.core?.[table]?.digest) failures.push(`CORE_DATA_CHANGED:${table}`);
  }
  if (baseline.registeredFiles?.count !== current.registeredFiles?.count) failures.push("REGISTERED_FILE_COUNT_CHANGED");
  if (baseline.registeredFiles?.digest !== current.registeredFiles?.digest) failures.push("REGISTERED_FILE_HASH_CHANGED");
  return { ok: failures.length === 0, failures };
}

async function main() {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  loadLocalEnv(rootDir);
  const baselinePath = path.resolve(process.env.POSTGRES_F1_BASELINE_PATH || path.join(os.tmpdir(), "commerce-ops-f1-baseline.json"));
  const command = process.argv[2];
  if (command === "capture") {
    const snapshot = captureF1ProtectionSnapshot({ rootDir, env: process.env });
    fs.writeFileSync(baselinePath, JSON.stringify(snapshot, null, 2), { encoding: "utf8", mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ status: "CAPTURED", baselinePath, integrity: snapshot.integrity, foreignKeyViolations: snapshot.foreignKeyViolations, tableCount: snapshot.tableCount, coreCounts: Object.fromEntries(Object.entries(snapshot.core).map(([name, value]) => [name, value.count])), registeredFiles: snapshot.registeredFiles.count, healthyRegisteredFiles: snapshot.registeredFiles.healthy }, null, 2)}\n`);
    return;
  }
  if (command === "verify") {
    if (!fs.existsSync(baselinePath)) throw new Error("F1 protection baseline is missing");
    const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
    const current = captureF1ProtectionSnapshot({ rootDir, env: process.env });
    const comparison = compareF1ProtectionSnapshots(baseline, current);
    process.stdout.write(`${JSON.stringify({ status: comparison.ok ? "UNCHANGED" : "CHANGED", integrity: current.integrity, foreignKeyViolations: current.foreignKeyViolations, tableCount: current.tableCount, coreCounts: Object.fromEntries(Object.entries(current.core).map(([name, value]) => [name, value.count])), registeredFiles: current.registeredFiles.count, healthyRegisteredFiles: current.registeredFiles.healthy, failures: comparison.failures }, null, 2)}\n`);
    if (!comparison.ok) process.exitCode = 1;
    return;
  }
  throw new Error("Use capture or verify");
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (entry === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`PostgreSQL F1 protection check failed: ${String(error?.message || error).split(/\r?\n/)[0].slice(0, 400)}\n`);
    process.exitCode = 1;
  });
}
