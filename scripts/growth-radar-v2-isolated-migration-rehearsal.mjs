import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { backup, DatabaseSync } from "node:sqlite";
import { SchedulerDatabase } from "../lib/data/sqlite/sqlite-scheduler-repository.mjs";

const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const migrationsRoot = path.join(appRoot, "migrations");
const sourcePath = path.resolve(
  process.env.GRV2_REHEARSAL_SOURCE
    || path.join(appRoot, "storage", "commerce-ops.sqlite"),
);
const through = String(
  process.env.GRV2_REHEARSAL_THROUGH
    || "021_growth_radar_task_lifecycle.sql",
).trim();

if (sourcePath !== path.join(appRoot, "storage", "commerce-ops.sqlite")) {
  throw new Error("The rehearsal source must be the configured formal SQLite path.");
}
await access(sourcePath, constants.R_OK);

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "grv2-migration-rehearsal-"));
const snapshotPath = path.join(tempRoot, "formal-snapshot.sqlite");
const rehearsalPath = path.join(tempRoot, "rehearsal.sqlite");
const stagedMigrations = path.join(tempRoot, "migrations");
let scheduler = null;

try {
  const sourceBefore = await databaseFileEvidence(sourcePath);
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    await backup(source, snapshotPath);
  } finally {
    source.close();
  }
  await copyFile(snapshotPath, rehearsalPath);

  await stageMigrations(migrationsRoot, stagedMigrations, through);
  const snapshot = new DatabaseSync(snapshotPath, { readOnly: true });
  const protectedTableEvidence = tableEvidence(snapshot);
  const appliedBefore = snapshot
    .prepare("SELECT version FROM schema_migrations ORDER BY version")
    .all()
    .map((row) => row.version);
  snapshot.close();

  scheduler = new SchedulerDatabase({
    databasePath: rehearsalPath,
    migrationsDir: stagedMigrations,
  });
  const appliedNow = scheduler.migrate();
  scheduler.close();
  scheduler = null;

  const rehearsed = new DatabaseSync(rehearsalPath, { readOnly: true });
  const appliedAfter = rehearsed
    .prepare("SELECT version FROM schema_migrations ORDER BY version")
    .all()
    .map((row) => row.version);
  const protectedAfter = tableEvidence(rehearsed, protectedTableEvidence.map((entry) => entry.table));
  const changedProtectedTables = protectedTableEvidence
    .filter((entry, index) => (
      entry.rowCount !== protectedAfter[index].rowCount
      || entry.sha256 !== protectedAfter[index].sha256
    ))
    .map((entry) => entry.table);
  const schemaObjects = rehearsed.prepare(`SELECT type,name
    FROM sqlite_master
    WHERE name LIKE 'growth_%'
      AND type IN ('table','view')
    ORDER BY type,name`).all();
  const activeRule = rehearsed.prepare(`SELECT version,metrics_contract_version,status
    FROM growth_rule_sets
    WHERE status='active'
    ORDER BY effective_from DESC,id DESC
    LIMIT 1`).get();
  const integrity = rehearsed.prepare("PRAGMA integrity_check").get().integrity_check;
  const foreignKeyViolations = rehearsed.prepare("PRAGMA foreign_key_check").all().length;
  rehearsed.close();

  const sourceAfter = await databaseFileEvidence(sourcePath);
  const sourceUnchanged = sameDatabaseContent(sourceBefore, sourceAfter);
  const expectedApplied = appliedAfter.filter((version) => !appliedBefore.includes(version));
  const result = {
    ok: sourceUnchanged
      && changedProtectedTables.length === 0
      && integrity === "ok"
      && foreignKeyViolations === 0
      && expectedApplied.join("|") === appliedNow.join("|")
      && appliedAfter.at(-1) === through,
    source: {
      path: path.relative(appRoot, sourcePath),
      openedReadOnly: true,
      unchanged: sourceUnchanged,
      before: sourceBefore,
      after: sourceAfter,
    },
    migration: {
      through,
      appliedBefore: appliedBefore.at(-1) || null,
      appliedNow,
      appliedAfter: appliedAfter.at(-1) || null,
    },
    protectedData: {
      tableCount: protectedTableEvidence.length,
      changedTables: changedProtectedTables,
    },
    target: {
      integrity,
      foreignKeyViolations,
      activeRule: activeRule || null,
      growthSchemaObjects: schemaObjects,
    },
    cleanup: {
      temporaryCopyRetained: false,
    },
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
} finally {
  if (scheduler) scheduler.close();
  await rm(tempRoot, { recursive: true, force: true });
}

async function stageMigrations(sourceDir, targetDir, lastVersion) {
  const entries = (await readdir(sourceDir))
    .filter((name) => name.endsWith(".sql") && name.localeCompare(lastVersion) <= 0)
    .sort();
  if (!entries.includes(lastVersion)) {
    throw new Error(`Migration ${lastVersion} does not exist.`);
  }
  await mkdir(targetDir, { recursive: true });
  for (const filename of entries) {
    await copyFile(path.join(sourceDir, filename), path.join(targetDir, filename));
  }
}

async function fileEvidence(filename) {
  const value = await stat(filename);
  return {
    bytes: value.size,
    modifiedAtMs: value.mtimeMs,
    sha256: await hashFile(filename),
  };
}

async function databaseFileEvidence(filename) {
  return {
    main: await fileEvidence(filename),
    wal: await optionalFileEvidence(`${filename}-wal`),
    shm: await optionalFileEvidence(`${filename}-shm`),
  };
}

async function optionalFileEvidence(filename) {
  try {
    return await fileEvidence(filename);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function hashFile(filename) {
  const { createReadStream } = await import("node:fs");
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filename);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  return hash.digest("hex");
}

function tableEvidence(database, selectedTables = null) {
  const tables = selectedTables || database.prepare(`SELECT name
    FROM sqlite_master
    WHERE type='table'
      AND name NOT LIKE 'sqlite_%'
      AND name<>'schema_migrations'
    ORDER BY name`).all().map((row) => row.name);
  return tables.map((table) => {
    const columns = database
      .prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)
      .all()
      .map((row) => row.name);
    const rows = database
      .prepare(`SELECT ${columns.map(quoteIdentifier).join(",")} FROM ${quoteIdentifier(table)}`)
      .all()
      .map((row) => stableRow(row, columns))
      .sort();
    const hash = createHash("sha256");
    for (const row of rows) hash.update(row).update("\n");
    return {
      table,
      rowCount: rows.length,
      sha256: hash.digest("hex"),
    };
  });
}

function stableRow(row, columns) {
  return JSON.stringify(columns.map((column) => normalizeValue(row[column])));
}

function normalizeValue(value) {
  if (value instanceof Uint8Array) return { type: "blob", base64: Buffer.from(value).toString("base64") };
  if (typeof value === "bigint") return value.toString();
  return value;
}

function sameDatabaseContent(before, after) {
  return ["main", "wal", "shm"].every((key) => {
    const left = before[key];
    const right = after[key];
    if (left === null || right === null) return left === right;
    return left.bytes === right.bytes && left.sha256 === right.sha256;
  });
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}
