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
const candidateName = "022_commerce_ops_foundation_v1.sql";
const candidatePath = path.join(migrationsRoot, "candidates", candidateName);
const formalPath = path.resolve(path.join(appRoot, "storage", "commerce-ops.sqlite"));
const protectedTables = [
  "mabang_account_profiles",
  "scheduled_export_tasks",
  "scheduled_export_runs",
  "product_models",
  "product_skus",
  "product_package_rows",
  "product_media_assets",
  "product_media_links",
  "mabang_sku_image_batches",
  "mabang_sku_image_sync_runs",
  "growth_shops",
  "growth_order_headers",
  "growth_order_lines",
  "growth_inventory_snapshots",
];

await access(formalPath, constants.R_OK);
await access(candidatePath, constants.R_OK);

const root = await mkdtemp(path.join(os.tmpdir(), "commerce-foundation-rehearsal-"));
const snapshotPath = path.join(root, "formal-snapshot.sqlite");
const rehearsalPath = path.join(root, "rehearsal.sqlite");
const stagedMigrations = path.join(root, "migrations");
let scheduler = null;

try {
  const formalBefore = await databaseFileEvidence(formalPath);
  const formal = new DatabaseSync(formalPath, { readOnly: true });
  try {
    await backup(formal, snapshotPath);
  } finally {
    formal.close();
  }
  await copyFile(snapshotPath, rehearsalPath);
  await stageMigrations(stagedMigrations);

  const before = new DatabaseSync(snapshotPath, { readOnly: true });
  const protectedBefore = tableEvidence(before, protectedTables);
  const appliedBefore = before.prepare(
    "SELECT version FROM schema_migrations ORDER BY version",
  ).all().map((row) => row.version);
  before.close();

  scheduler = new SchedulerDatabase({
    databasePath: rehearsalPath,
    migrationsDir: stagedMigrations,
  });
  const appliedNow = scheduler.migrate();
  scheduler.close();
  scheduler = null;

  const after = new DatabaseSync(rehearsalPath, { readOnly: true });
  const protectedAfter = tableEvidence(after, protectedTables);
  const changedProtectedTables = protectedBefore
    .filter((entry, index) => (
      entry.rowCount !== protectedAfter[index].rowCount
      || entry.sha256 !== protectedAfter[index].sha256
    ))
    .map((entry) => entry.table);
  const appliedAfter = after.prepare(
    "SELECT version FROM schema_migrations ORDER BY version",
  ).all().map((row) => row.version);
  const schemaObjects = after.prepare(`SELECT type,name
    FROM sqlite_master
    WHERE name LIKE 'foundation_%'
    ORDER BY type,name`).all();
  const foundationCounts = Object.fromEntries([
    "foundation_source_systems",
    "foundation_integration_accounts",
    "foundation_account_capabilities",
    "foundation_owners",
    "foundation_warehouses",
    "foundation_identity_links",
    "foundation_tasks",
  ].map((table) => [
    table,
    Number(after.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`).get().count),
  ]));
  const integrity = after.prepare("PRAGMA integrity_check").get().integrity_check;
  const foreignKeyViolations = after.prepare("PRAGMA foreign_key_check").all().length;
  after.close();

  const formalAfter = await databaseFileEvidence(formalPath);
  const formalUnchanged = sameDatabaseContent(formalBefore, formalAfter);
  const result = {
    ok: formalUnchanged
      && changedProtectedTables.length === 0
      && integrity === "ok"
      && foreignKeyViolations === 0
      && appliedAfter.at(-1) === candidateName
      && appliedNow.includes(candidateName),
    formalDatabase: {
      path: path.relative(appRoot, formalPath),
      openedReadOnly: true,
      unchanged: formalUnchanged,
      before: formalBefore,
      after: formalAfter,
    },
    migration: {
      appliedBefore: appliedBefore.at(-1) || null,
      appliedNow,
      appliedAfter: appliedAfter.at(-1) || null,
      candidate: candidateName,
    },
    protectedData: {
      tables: protectedTables.length,
      changedTables: changedProtectedTables,
    },
    target: {
      integrity,
      foreignKeyViolations,
      schemaObjects,
      foundationCounts,
    },
    cleanup: {
      temporaryCopyRetained: false,
    },
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
} finally {
  if (scheduler) scheduler.close();
  await rm(root, { recursive: true, force: true });
}

async function stageMigrations(target) {
  const topLevel = (await readdir(migrationsRoot))
    .filter((name) => name.endsWith(".sql") && name <= "021_growth_radar_task_lifecycle.sql")
    .sort();
  await mkdir(target, { recursive: true });
  for (const name of topLevel) {
    await copyFile(path.join(migrationsRoot, name), path.join(target, name));
  }
  await copyFile(candidatePath, path.join(target, candidateName));
}

function tableEvidence(database, tables) {
  return tables.map((table) => {
    const exists = database.prepare(
      "SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name=?",
    ).get(table);
    if (!exists) return { table, rowCount: 0, sha256: null };
    const columns = database.prepare(
      `PRAGMA table_info(${quoteIdentifier(table)})`,
    ).all().map((row) => row.name);
    const rows = database.prepare(
      `SELECT ${columns.map(quoteIdentifier).join(",")}
       FROM ${quoteIdentifier(table)}`,
    ).all().map((row) => JSON.stringify(columns.map((column) => normalize(row[column]))))
      .sort();
    const hash = createHash("sha256");
    for (const row of rows) hash.update(row).update("\n");
    return { table, rowCount: rows.length, sha256: hash.digest("hex") };
  });
}

function normalize(value) {
  if (value instanceof Uint8Array) {
    return { type: "blob", base64: Buffer.from(value).toString("base64") };
  }
  if (typeof value === "bigint") return value.toString();
  return value;
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
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

async function optionalFileEvidence(filename) {
  try {
    const value = await stat(filename);
    return { bytes: value.size, sha256: await hashFile(filename) };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function databaseFileEvidence(filename) {
  return {
    main: await optionalFileEvidence(filename),
    wal: await optionalFileEvidence(`${filename}-wal`),
    shm: await optionalFileEvidence(`${filename}-shm`),
  };
}

function sameDatabaseContent(before, after) {
  return ["main", "wal", "shm"].every((key) => {
    const left = before[key];
    const right = after[key];
    if (left === null || right === null) return left === right;
    return left.bytes === right.bytes && left.sha256 === right.sha256;
  });
}

