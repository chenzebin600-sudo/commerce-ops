import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SchedulerDatabase } from "../lib/mabang-scheduler/db.mjs";
import { createExportFileRepository } from "../lib/files/file-repository.mjs";
import { FileLifecycleRepository } from "../lib/files/file-lifecycle-repository.mjs";
import {
  FileLifecycleScanner,
  buildLifecycleRoots,
  hashFileStream,
  maskLifecycleFilename,
} from "../lib/files/file-lifecycle-scanner.mjs";
import { resolveLifecyclePolicy } from "../lib/files/file-lifecycle-policy.mjs";
import { hashFileBuffer } from "../lib/security/file-policy.mjs";

const migrationsDir = path.resolve("migrations");
const NOW = new Date("2026-07-20T08:00:00.000Z");

async function setup({ protectedIds = new Set(), env = {} } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lifecycle-scan-"));
  const storageRoot = path.join(root, "main-storage");
  const fileStorageConfig = {
    storageRoot,
    exportRoot: path.join(storageRoot, "exports", "mabang"),
    uploadRoot: path.join(storageRoot, "uploads"),
    tempRoot: path.join(storageRoot, "temp"),
  };
  const adAnalyzerDir = path.join(root, "ads", "webapp");
  const configured = {
    AD_LIFECYCLE_STORAGE_ROOT: path.join(adAnalyzerDir, "storage"),
    AD_LIFECYCLE_UPLOAD_ROOT: path.join(adAnalyzerDir, "storage", "uploads"),
    AD_LIFECYCLE_TEMP_ROOT: path.join(adAnalyzerDir, "storage", "temp"),
    AD_LIFECYCLE_OUTPUT_ROOT: path.join(root, "ads", "outputs"),
    FILE_RETENTION_MANUAL_DAYS: "1",
    FILE_RETENTION_SCHEDULED_DAYS: "1",
    FILE_RETENTION_AD_SOURCE_DAYS: "1",
    FILE_RETENTION_AD_OUTPUT_DAYS: "1",
    FILE_RETENTION_REPORT_DAYS: "1",
    FILE_RETENTION_FAILED_TEMP_HOURS: "1",
    FILE_LIFECYCLE_RECENT_MINUTES: "5",
    FILE_LIFECYCLE_MAX_FILES: "1000",
    FILE_LIFECYCLE_TIMEOUT_SECONDS: "30",
    FILE_LIFECYCLE_LEGACY_CUTOFF: "2026-07-16T00:00:00.000Z",
    ...env,
  };
  const roots = buildLifecycleRoots({ fileStorageConfig, adAnalyzerDir, env: configured });
  for (const descriptor of roots) await fs.mkdir(descriptor.root, { recursive: true });
  const db = new SchedulerDatabase({ databasePath: path.join(root, "database.sqlite"), migrationsDir });
  db.migrate();
  const fileRepository = createExportFileRepository(db);
  const lifecycleRepository = new FileLifecycleRepository({ db });
  const policy = resolveLifecyclePolicy(configured);
  const scanner = new FileLifecycleScanner({ fileRepository, roots, policy, protectedFileIds: protectedIds, now: () => new Date(NOW) });
  return { root, db, fileRepository, lifecycleRepository, policy, scanner, roots, ...fileStorageConfig };
}

async function close(context) {
  context.db.close();
  await fs.rm(context.root, { recursive: true, force: true });
}

async function writeFile(root, relative, content = Buffer.from("PK\u0003\u0004 lifecycle"), modified = "2026-07-18T00:00:00.000Z") {
  const target = path.join(root, ...relative.split("/"));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
  const date = new Date(modified);
  await fs.utimes(target, date, date);
  return target;
}

async function trackedFile(context, {
  id = crypto.randomUUID(), relative = `manual/2026-07/${crypto.randomUUID()}.xlsx`,
  content = Buffer.from("PK\u0003\u0004 tracked"), size = null, hash = null,
  sourceType = "mabang_manual_order", modified = "2026-07-19T00:00:00.000Z",
} = {}) {
  const target = await writeFile(context.exportRoot, relative, content, modified);
  const record = context.fileRepository.create({
    id, sourceType, originalFilename: path.basename(relative), storageFilename: path.basename(relative), relativePath: relative,
    fileSize: size ?? content.length, fileHash: hash ?? hashFileBuffer(content), status: "available",
    createdAt: modified,
  });
  return { record, target, content };
}

function item(report, classification) {
  return report.items.find((entry) => entry.classification === classification);
}

test("matching metadata, size and SHA-256 classify a file as healthy", async () => {
  const context = await setup();
  try {
    await trackedFile(context);
    const report = await context.scanner.scan(["main_export"]);
    assert.equal(report.summary.healthy, 1);
    assert.equal(item(report, "healthy").physicalStatus, "present");
  } finally { await close(context); }
});

test("a database record without a physical file is physical_missing", async () => {
  const context = await setup();
  try {
    context.fileRepository.create({ sourceType: "mabang_manual_order", originalFilename: "missing.xlsx", storageFilename: "missing.xlsx", relativePath: "manual/missing.xlsx", fileSize: 10, fileHash: "a".repeat(64) });
    const report = await context.scanner.scan(["main_export"]);
    assert.equal(item(report, "physical_missing").reasonCode, "DATABASE_RECORD_WITHOUT_FILE");
  } finally { await close(context); }
});

test("an untracked formal file is metadata_missing", async () => {
  const context = await setup();
  try {
    await writeFile(context.uploadRoot, "other.xlsx");
    const report = await context.scanner.scan(["main_upload"]);
    assert.equal(item(report, "metadata_missing").scope, "main_upload");
  } finally { await close(context); }
});

test("a stored size mismatch is reported before hashing", async () => {
  const context = await setup();
  try {
    await trackedFile(context, { size: 999 });
    const report = await context.scanner.scan(["main_export"]);
    assert.equal(item(report, "size_mismatch").shortHash, null);
  } finally { await close(context); }
});

test("an equal-size SHA-256 mismatch is hash_mismatch", async () => {
  const context = await setup();
  try {
    await trackedFile(context, { hash: "b".repeat(64) });
    const report = await context.scanner.scan(["main_export"]);
    assert.equal(item(report, "hash_mismatch").suggestQuarantine, true);
  } finally { await close(context); }
});

test("an invalid database relative path is path_invalid", async () => {
  const context = await setup();
  try {
    context.db.db.exec("PRAGMA foreign_keys=OFF");
    context.db.db.prepare(`INSERT INTO export_files
      (id,file_type,source_type,original_filename,storage_filename,relative_path,mime_type,file_size,status,metadata_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      crypto.randomUUID(), "excel", "mabang_manual_order", "bad.xlsx", "bad.xlsx", "../bad.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", 1, "available", "{}", NOW.toISOString(), NOW.toISOString(),
    );
    const report = await context.scanner.scan(["main_export"]);
    assert.equal(item(report, "path_invalid").reasonCode, "DATABASE_PATH_INVALID");
  } finally { await close(context); }
});

test("an old temporary file is temp_stale", async () => {
  const context = await setup();
  try {
    await writeFile(context.tempRoot, "failed.xlsx", Buffer.from("temp"), "2026-07-19T00:00:00.000Z");
    const report = await context.scanner.scan(["main_temp"]);
    assert.equal(item(report, "temp_stale").suggestCleanup, true);
  } finally { await close(context); }
});

test("an old unprotected tracked file receives expired_candidate without changing its primary health", async () => {
  const context = await setup();
  try {
    await trackedFile(context, { modified: "2026-07-18T00:00:00.000Z" });
    const report = await context.scanner.scan(["main_export"]);
    assert.equal(report.items[0].classification, "healthy");
    assert.ok(report.items[0].categories.includes("expired_candidate"));
  } finally { await close(context); }
});

test("a pre-D2B1 manual xlsx without metadata is legacy_untracked_export", async () => {
  const context = await setup();
  try {
    await writeFile(context.exportRoot, "manual/2026-07/legacy.xlsx", Buffer.from("PK\u0003\u0004 legacy"), "2026-07-15T00:00:00.000Z");
    const report = await context.scanner.scan(["main_export"]);
    assert.equal(item(report, "legacy_untracked_export").reasonCode, "PRE_D2B1_MANUAL_EXPORT_WITHOUT_METADATA");
  } finally { await close(context); }
});

test("a manual file matching a tracked hash is not misclassified as a legacy orphan", async () => {
  const context = await setup();
  try {
    const content = Buffer.from("PK\u0003\u0004 registered content");
    await trackedFile(context, { content, modified: "2026-07-15T00:00:00.000Z" });
    await writeFile(context.exportRoot, "manual/2026-07/untracked-copy.xlsx", content, "2026-07-15T00:00:00.000Z");
    const report = await context.scanner.scan(["main_export"]);
    assert.equal(report.summary.legacy_untracked_export, 0);
    assert.equal(report.summary.duplicate_content, 2);
  } finally { await close(context); }
});

test("a recently modified file is active_or_recent and never a cleanup candidate", async () => {
  const context = await setup();
  try {
    await writeFile(context.tempRoot, "active.xlsx", Buffer.from("active"), "2026-07-20T07:58:00.000Z");
    const report = await context.scanner.scan(["main_temp"]);
    assert.equal(item(report, "active_or_recent").suggestCleanup, false);
  } finally { await close(context); }
});

test("an unrecognized file directly under controlled storage is unknown_file", async () => {
  const context = await setup();
  try {
    await writeFile(context.storageRoot, "unrecognized.bin", Buffer.from("unknown"));
    const report = await context.scanner.scan(["main_storage"]);
    assert.equal(item(report, "unknown_file").reasonCode, "UNRECOGNIZED_STORED_FILE");
  } finally { await close(context); }
});

test("advertising outputs use their own retention policy and source label", async () => {
  const context = await setup();
  try {
    const outputRoot = context.roots.find((entry) => entry.scope === "ad_output").root;
    await writeFile(outputRoot, "job/output/result.json", Buffer.from("{}"), "2026-07-18T00:00:00.000Z");
    const report = await context.scanner.scan(["ad_output"]);
    assert.equal(report.items[0].sourceType, "advertising_output");
    assert.ok(report.items[0].categories.includes("expired_candidate"));
  } finally { await close(context); }
});

test("the scanner stops at the configured file-count limit", async () => {
  const context = await setup({ env: { FILE_LIFECYCLE_MAX_FILES: "10" } });
  try {
    for (let index = 0; index < 12; index += 1) await writeFile(context.uploadRoot, `file-${index}.xlsx`, Buffer.from(String(index)));
    const report = await context.scanner.scan(["main_upload"]);
    assert.equal(report.truncated, true);
    assert.equal(report.totalFiles, 10);
  } finally { await close(context); }
});

test("hashing uses a streaming implementation and returns the correct digest", async () => {
  const context = await setup();
  try {
    const target = await writeFile(context.uploadRoot, "stream.xlsx", Buffer.alloc(2 * 1024 * 1024, 7));
    const expected = crypto.createHash("sha256").update(Buffer.alloc(2 * 1024 * 1024, 7)).digest("hex");
    assert.equal(await hashFileStream(target), expected);
    const source = await fs.readFile(path.resolve("lib/files/file-lifecycle-scanner.mjs"), "utf8");
    assert.match(source, /createReadStream/);
    assert.doesNotMatch(source, /readFile\(physical\.absolutePath/);
  } finally { await close(context); }
});

test("stream hashing observes the lifecycle scan deadline", async () => {
  const context = await setup();
  try {
    const target = await writeFile(context.uploadRoot, "timeout.xlsx", Buffer.alloc(1024, 1));
    await assert.rejects(hashFileStream(target, { deadline: Date.now() - 1 }), (error) => error.code === "SCAN_TIMEOUT");
  } finally { await close(context); }
});

test("a symbolic link is rejected without following it outside the root", async (t) => {
  const context = await setup();
  try {
    const outside = path.join(context.root, "outside-link-target");
    await fs.mkdir(outside, { recursive: true });
    await writeFile(outside, "outside.xlsx", Buffer.from("outside"));
    const link = path.join(context.uploadRoot, "escape-link");
    try { await fs.symlink(outside, link, "junction"); } catch (error) {
      if (["EPERM", "EACCES"].includes(error.code)) return t.skip("Symlinks require elevated Windows privileges");
      throw error;
    }
    const report = await context.scanner.scan(["main_upload"]);
    assert.equal(item(report, "path_invalid").errorCode, "SYMLINK_REJECTED");
  } finally { await close(context); }
});

for (const directory of [".git", "backups", "chrome-user-data", "sales-assortment-ai"]) {
  test(`${directory} directories are excluded from lifecycle traversal`, async () => {
    const context = await setup();
    try {
      await writeFile(context.uploadRoot, `${directory}/ignored.xlsx`);
      const report = await context.scanner.scan(["main_upload"]);
      assert.equal(report.totalFiles, 0);
    } finally { await close(context); }
  });
}

test("duplicate physical content is flagged without exposing the full hash", async () => {
  const context = await setup();
  try {
    const bytes = Buffer.from("same content");
    await writeFile(context.uploadRoot, "one.xlsx", bytes);
    await writeFile(context.uploadRoot, "two.xlsx", bytes);
    const report = await context.scanner.scan(["main_upload"]);
    assert.equal(report.summary.duplicate_content, 2);
    assert.ok(report.items.every((entry) => entry.shortHash.length === 12 && !("fileHash" in entry)));
  } finally { await close(context); }
});

test("a missing configured root records a bounded scope error and does not fail the scan", async () => {
  const context = await setup();
  try {
    await fs.rm(context.roots.find((entry) => entry.scope === "ad_output").root, { recursive: true });
    const report = await context.scanner.scan(["ad_output"]);
    assert.deepEqual(report.scopeErrors, [{ scope: "ad_output", code: "ROOT_NOT_FOUND" }]);
  } finally { await close(context); }
});

test("one path error does not prevent a healthy file from being reported", async (t) => {
  const context = await setup();
  try {
    await trackedFile(context);
    const outside = path.join(context.root, "outside-second-target");
    await fs.mkdir(outside, { recursive: true });
    await writeFile(outside, "outside.xlsx", Buffer.from("outside"));
    try { await fs.symlink(outside, path.join(context.exportRoot, "escape-link"), "junction"); } catch (error) {
      if (["EPERM", "EACCES"].includes(error.code)) return t.skip("Symlinks require elevated Windows privileges");
      throw error;
    }
    const report = await context.scanner.scan(["main_export"]);
    assert.equal(report.summary.healthy, 1);
    assert.equal(report.summary.path_invalid, 1);
  } finally { await close(context); }
});

test("scan leaves file bytes, size and modification time unchanged", async () => {
  const context = await setup();
  try {
    const created = await trackedFile(context);
    const before = await fs.stat(created.target);
    const hashBefore = await hashFileStream(created.target);
    await context.scanner.scan(["main_export"]);
    const after = await fs.stat(created.target);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(await hashFileStream(created.target), hashBefore);
  } finally { await close(context); }
});

test("protected baseline files remain healthy after their retention age", async () => {
  const context = await setup();
  try {
    const first = await trackedFile(context, { modified: "2026-07-15T00:00:00.000Z" });
    const second = await trackedFile(context, { modified: "2026-07-15T00:00:00.000Z" });
    context.scanner.protectedFileIds = new Set([first.record.id, second.record.id]);
    const report = await context.scanner.scan(["main_export"]);
    assert.equal(report.summary.healthy, 2);
    assert.equal(report.summary.expired_candidate, 0);
  } finally { await close(context); }
});

test("filename masking does not expose a complete stored filename", () => {
  assert.equal(maskLifecycleFilename("customer-orders-sensitive.xlsx"), "cus***ve.xlsx");
});
