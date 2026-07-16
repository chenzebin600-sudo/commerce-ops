import test from "node:test";
import assert from "node:assert/strict";
import crypto, { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SchedulerDatabase } from "../lib/mabang-scheduler/db.mjs";
import { createExportFileRepository } from "../lib/files/file-repository.mjs";
import { FileLifecycleRepository } from "../lib/files/file-lifecycle-repository.mjs";
import { FileLifecycleScanner, hashFileStream, maskLifecycleFilename } from "../lib/files/file-lifecycle-scanner.mjs";
import { resolveLifecyclePolicy } from "../lib/files/file-lifecycle-policy.mjs";
import { FileReviewRepository } from "../lib/files/file-review-repository.mjs";
import { FileReviewService, resolveFileReviewPolicy } from "../lib/files/file-review-service.mjs";
import { classifyAdvertisingScanItems } from "../lib/files/advertising-file-classifier.mjs";
import { createOperationAuditService } from "../lib/security/audit-service.mjs";

const migrationsDir = path.resolve("migrations");

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "commerce-ops-file-review-"));
  const storageRoot = path.join(root, "storage");
  const roots = [
    { scope: "ad_upload", root: path.join(root, "ads", "uploads") },
    { scope: "ad_output", root: path.join(root, "ads", "outputs") },
    { scope: "ad_temp", root: path.join(root, "ads", "temp") },
    { scope: "main_temp", root: path.join(storageRoot, "temp") },
  ];
  for (const descriptor of roots) await fs.mkdir(descriptor.root, { recursive: true });
  const db = new SchedulerDatabase({ databasePath: path.join(root, "database.sqlite"), migrationsDir });
  db.migrate();
  const lifecycleRepository = new FileLifecycleRepository({ db });
  const reviewRepository = new FileReviewRepository({ db });
  const audit = createOperationAuditService({ db, env: {} });
  const scanId = randomUUID();
  const now = new Date().toISOString();
  db.db.prepare(`INSERT INTO file_lifecycle_scans
    (id,status,scopes_json,summary_json,scope_errors_json,total_files,total_bytes,truncated,started_at,finished_at,created_at,updated_at)
    VALUES (?,'completed','[]','{}','[]',0,0,0,?,?,?,?)`).run(scanId, now, now, now, now);
  const quarantineRoot = path.join(storageRoot, "quarantine");
  const service = new FileReviewService({
    repository: reviewRepository,
    lifecycleRepository,
    roots,
    storageRoot,
    quarantineRoot,
    audit,
    policy: resolveFileReviewPolicy({ FILE_DELETION_ENABLED: "false", FILE_QUARANTINE_RETENTION_DAYS: "30" }),
  });
  await service.ensureQuarantineRoot();
  return { root, storageRoot, roots, db, lifecycleRepository, reviewRepository, audit, scanId, quarantineRoot, service };
}

async function close(context) {
  context.db.close();
  await fs.rm(context.root, { recursive: true, force: true });
}

function rootFor(context, scope) {
  return context.roots.find((entry) => entry.scope === scope).root;
}

async function writeControlled(context, scope, relativePath, bytes) {
  const target = path.join(rootFor(context, scope), ...relativePath.split("/"));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, bytes);
  return target;
}

async function addItem(context, {
  scope,
  relativePath,
  bytes = Buffer.from("{}"),
  classification = "metadata_missing",
  categories = [classification],
  fileId = null,
} = {}) {
  const target = await writeControlled(context, scope, relativePath, bytes);
  const stat = await fs.stat(target);
  const hash = await hashFileStream(target);
  const id = randomUUID();
  context.db.db.prepare(`INSERT INTO file_lifecycle_items (
    id,scan_id,classification,categories_json,scope,source_type,file_id,task_id,run_id,masked_filename,
    file_size,file_created_at,file_modified_at,database_status,physical_status,suggest_quarantine,suggest_cleanup,
    reason_code,short_hash,error_code,created_at
  ) VALUES (?,?,?,?,?,NULL,?,NULL,NULL,?,?,?,?,NULL,'present',0,0,'TEST_ITEM',?,NULL,?)`).run(
    id,
    context.scanId,
    classification,
    JSON.stringify(categories),
    scope,
    fileId,
    maskLifecycleFilename(path.basename(relativePath)),
    stat.size,
    stat.birthtime.toISOString(),
    stat.mtime.toISOString(),
    hash.slice(0, 12),
    new Date().toISOString(),
  );
  return { id, target, hash, stat, relativePath, scope };
}

async function saveEvidence(context, item, detectedFileType, overrides = {}) {
  const extension = path.extname(item.relativePath).toLowerCase();
  return context.reviewRepository.saveEvidence(item.id, {
    scanId: context.scanId,
    detectedFileType,
    rootKey: item.scope,
    relativePath: item.relativePath,
    fileHash: item.hash,
    jobId: overrides.jobId || null,
    mimeType: overrides.mimeType || (extension === ".xlsx"
      ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      : "application/json"),
    signatureCode: overrides.signatureCode || (extension === ".xlsx" ? "xlsx_zip" : "json_text"),
    reasonCode: overrides.reasonCode || "TEST_VERIFIED_FILE",
  });
}

async function trustedJob(context, { outputName = null } = {}) {
  const jobId = randomUUID();
  const sourceName = `${randomUUID()}.xlsx`;
  const sourceRelative = `advertising/${jobId}/source/${sourceName}`;
  const source = await writeControlled(context, "ad_upload", sourceRelative, Buffer.from("PK\x03\x04 source"));
  const sourceStat = await fs.stat(source);
  const sourceHash = await hashFileStream(source);
  await writeControlled(context, "ad_upload", `advertising/${jobId}/file_metadata.json`, Buffer.from(JSON.stringify({
    id: jobId,
    originalFilename: "masked.xlsx",
    storageFilename: sourceName,
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    fileSize: sourceStat.size,
    fileHash: sourceHash,
    createdAt: new Date().toISOString(),
    status: "available",
  })));
  const targetRelative = outputName ? `advertising/${jobId}/output/${outputName}` : sourceRelative;
  if (outputName) await writeControlled(context, "ad_upload", targetRelative, Buffer.from("{}"));
  const target = path.join(rootFor(context, "ad_upload"), ...targetRelative.split("/"));
  const targetStat = await fs.stat(target);
  const targetHash = await hashFileStream(target);
  const item = await addExistingItem(context, "ad_upload", targetRelative, target, targetStat, targetHash);
  return { jobId, item, sourceName };
}

async function addExistingItem(context, scope, relativePath, target, stat = null, hash = null) {
  const fileStat = stat || await fs.stat(target);
  const fileHash = hash || await hashFileStream(target);
  const id = randomUUID();
  context.db.db.prepare(`INSERT INTO file_lifecycle_items (
    id,scan_id,classification,categories_json,scope,masked_filename,file_size,file_created_at,file_modified_at,
    physical_status,suggest_quarantine,suggest_cleanup,reason_code,short_hash,created_at
  ) VALUES (?,?,'metadata_missing','["metadata_missing"]',?,?,?,?,?,'present',1,0,'PHYSICAL_FILE_WITHOUT_METADATA',?,?)`).run(
    id,
    context.scanId,
    scope,
    maskLifecycleFilename(path.basename(relativePath)),
    fileStat.size,
    fileStat.birthtime.toISOString(),
    fileStat.mtime.toISOString(),
    fileHash.slice(0, 12),
    new Date().toISOString(),
  );
  return { id, target, hash: fileHash, stat: fileStat, relativePath, scope };
}

async function classified(context, itemId) {
  await context.service.classifyScan(context.scanId);
  return context.reviewRepository.getItem(itemId);
}

async function registrationFixture(context) {
  const item = await addItem(context, {
    scope: "ad_output",
    relativePath: `${randomUUID()}/analysis_data.json`,
    bytes: Buffer.from("{}"),
  });
  const evidence = await classified(context, item.id);
  return { item, evidence };
}

test("advertising uploads are classified as advertising_source", async () => {
  const context = await setup();
  try {
    const { item } = await trustedJob(context);
    const result = await context.service.classifyScan(context.scanId);
    assert.equal(result.evidence.find((entry) => entry.lifecycleItemId === item.id).detectedFileType, "advertising_source");
  } finally { await close(context); }
});

test("trusted advertising results are classified as advertising_output", async () => {
  const context = await setup();
  try {
    const { item } = await trustedJob(context, { outputName: "client_result.json" });
    const result = await context.service.classifyScan(context.scanId);
    assert.equal(result.evidence.find((entry) => entry.lifecycleItemId === item.id).detectedFileType, "advertising_output");
  } finally { await close(context); }
});

test("unidentified advertising files remain advertising_unknown", async () => {
  const context = await setup();
  try {
    const item = await addItem(context, { scope: "ad_output", relativePath: `${randomUUID()}/capture.png`, bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) });
    assert.equal((await classified(context, item.id)).detectedFileType, "advertising_unknown");
  } finally { await close(context); }
});

test("duplicate content is only a hint and never an automatic cleanup candidate", async () => {
  const context = await setup();
  try {
    const bytes = Buffer.from("{}");
    const first = await addItem(context, { scope: "ad_output", relativePath: `${randomUUID()}/analysis_data.json`, bytes });
    const second = await addItem(context, { scope: "ad_output", relativePath: `${randomUUID()}/analysis_data.json`, bytes });
    const result = await context.service.classifyScan(context.scanId);
    assert.equal(result.evidence.find((entry) => entry.lifecycleItemId === first.id).duplicateContent, true);
    assert.equal(result.evidence.find((entry) => entry.lifecycleItemId === second.id).duplicateContent, true);
    assert.equal(context.reviewRepository.getItem(first.id).reviewStatus, "pending_review");
  } finally { await close(context); }
});

test("verified formal advertising files can be registered", async () => {
  const context = await setup();
  try {
    const { item } = await registrationFixture(context);
    const file = await context.service.registerItem(item.id);
    assert.equal(file.sourceType, "advertising_output");
    assert.equal(context.reviewRepository.getItem(item.id).reviewStatus, "registered");
  } finally { await close(context); }
});

test("managed registration creates a stable UUID", async () => {
  const context = await setup();
  try {
    const { item } = await registrationFixture(context);
    const first = await context.service.registerItem(item.id);
    const second = await context.service.registerItem(item.id);
    assert.match(first.id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(second.id, first.id);
  } finally { await close(context); }
});

test("managed registration stores relative path size and hash", async () => {
  const context = await setup();
  try {
    const { item } = await registrationFixture(context);
    const file = await context.service.registerItem(item.id);
    assert.equal(path.isAbsolute(file.relativePath), false);
    assert.equal(file.fileSize, item.stat.size);
    assert.equal(file.fileHash, item.hash);
  } finally { await close(context); }
});

test("managed registration leaves physical bytes and timestamps unchanged", async () => {
  const context = await setup();
  try {
    const { item } = await registrationFixture(context);
    const before = { hash: await hashFileStream(item.target), stat: await fs.stat(item.target) };
    await context.service.registerItem(item.id);
    const after = { hash: await hashFileStream(item.target), stat: await fs.stat(item.target) };
    assert.equal(after.hash, before.hash);
    assert.equal(after.stat.size, before.stat.size);
    assert.equal(after.stat.mtimeMs, before.stat.mtimeMs);
  } finally { await close(context); }
});

test("duplicate registration is idempotent", async () => {
  const context = await setup();
  try {
    const { item } = await registrationFixture(context);
    await context.service.registerItem(item.id);
    await context.service.registerItem(item.id);
    assert.equal(context.db.db.prepare("SELECT COUNT(*) count FROM managed_files").get().count, 1);
  } finally { await close(context); }
});

test("failed registration leaves no managed file record", async () => {
  const context = await setup();
  try {
    const { item } = await registrationFixture(context);
    await fs.writeFile(item.target, "changed");
    await assert.rejects(() => context.service.registerItem(item.id), { code: "FILE_SIZE_CHANGED" });
    assert.equal(context.db.db.prepare("SELECT COUNT(*) count FROM managed_files").get().count, 0);
  } finally { await close(context); }
});

test("registration rejects a path outside its controlled root", async () => {
  const context = await setup();
  try {
    const { item } = await registrationFixture(context);
    context.db.db.prepare("UPDATE file_lifecycle_items SET relative_path='../outside.json' WHERE id=?").run(item.id);
    await assert.rejects(() => context.service.registerItem(item.id));
    assert.equal(context.db.db.prepare("SELECT COUNT(*) count FROM managed_files").get().count, 0);
  } finally { await close(context); }
});

test("registration rejects a changed hash", async () => {
  const context = await setup();
  try {
    const { item } = await registrationFixture(context);
    const changed = Buffer.from("[]");
    assert.equal(changed.length, item.stat.size);
    await fs.writeFile(item.target, changed);
    await assert.rejects(() => context.service.registerItem(item.id), { code: "FILE_HASH_CHANGED" });
  } finally { await close(context); }
});

test("new lifecycle anomalies default to pending_review", async () => {
  const context = await setup();
  try {
    const item = await addItem(context, { scope: "ad_output", relativePath: `${randomUUID()}/unknown.bin`, bytes: Buffer.from("test") });
    assert.equal(context.reviewRepository.getItem(item.id).reviewStatus, "pending_review");
  } finally { await close(context); }
});

test("an item cannot be quarantined before explicit approval", async () => {
  const context = await setup();
  try {
    const item = await addItem(context, { scope: "ad_temp", relativePath: "stale.tmp", classification: "temp_stale", categories: ["temp_stale"], bytes: Buffer.from("temporary") });
    await saveEvidence(context, item, "advertising_temp", { signatureCode: "unknown", mimeType: "application/octet-stream" });
    await assert.rejects(() => context.service.quarantineItem(item.id), { code: "QUARANTINE_NOT_APPROVED" });
  } finally { await close(context); }
});

test("protected files cannot be approved for quarantine", async () => {
  const context = await setup();
  try {
    const item = await addItem(context, { scope: "ad_temp", relativePath: "protected.tmp", classification: "temp_stale", categories: ["temp_stale"], bytes: Buffer.from("temporary") });
    await saveEvidence(context, item, "advertising_temp", { signatureCode: "unknown", mimeType: "application/octet-stream" });
    context.service.protectItem(item.id);
    assert.throws(() => context.service.approveQuarantine(item.id), { code: "QUARANTINE_NOT_ELIGIBLE" });
  } finally { await close(context); }
});

test("historical registered exports cannot be approved for quarantine", async () => {
  const context = await setup();
  try {
    const item = await addItem(context, { scope: "main_temp", relativePath: "historical.xlsx", classification: "expired_candidate", categories: ["expired_candidate"], fileId: randomUUID(), bytes: Buffer.from("PK\x03\x04 old") });
    await saveEvidence(context, item, "advertising_temp", { signatureCode: "xlsx_zip" });
    assert.throws(() => context.service.approveQuarantine(item.id), { code: "QUARANTINE_NOT_ELIGIBLE" });
  } finally { await close(context); }
});

test("a managed non-protected file can become a reviewed quarantine candidate after expiry", async () => {
  const context = await setup();
  try {
    const { item } = await registrationFixture(context);
    await context.service.registerItem(item.id);
    context.db.db.prepare("UPDATE file_lifecycle_items SET categories_json='[\"metadata_missing\",\"expired_candidate\"]' WHERE id=?").run(item.id);
    const approved = context.service.approveQuarantine(item.id);
    assert.equal(approved.reviewStatus, "approved_for_quarantine");
  } finally { await close(context); }
});

async function quarantinableFixture(context, name = "stale.tmp") {
  const item = await addItem(context, { scope: "ad_temp", relativePath: name, classification: "temp_stale", categories: ["temp_stale"], bytes: Buffer.from("temporary-test-file") });
  await saveEvidence(context, item, "advertising_temp", { signatureCode: "unknown", mimeType: "application/octet-stream" });
  context.service.approveQuarantine(item.id);
  return item;
}

test("quarantine moves only an explicitly approved temporary test file", async () => {
  const context = await setup();
  try {
    const item = await quarantinableFixture(context);
    const record = await context.service.quarantineItem(item.id);
    await assert.rejects(() => fs.stat(item.target), { code: "ENOENT" });
    assert.equal(record.status, "quarantined");
  } finally { await close(context); }
});

test("quarantine preserves SHA-256", async () => {
  const context = await setup();
  try {
    const item = await quarantinableFixture(context);
    const record = await context.service.quarantineItem(item.id);
    const internal = context.reviewRepository.getQuarantineRecord(record.id);
    const target = path.join(context.quarantineRoot, ...internal.quarantineRelativePath.split("/"));
    assert.equal(await hashFileStream(target), item.hash);
  } finally { await close(context); }
});

test("a quarantine persistence failure rolls the file back and preserves review state", async () => {
  const context = await setup();
  try {
    const item = await quarantinableFixture(context);
    context.reviewRepository.recordQuarantine = () => { throw Object.assign(new Error("test failure"), { code: "TEST_DB_FAILURE" }); };
    await assert.rejects(() => context.service.quarantineItem(item.id), { code: "TEST_DB_FAILURE" });
    assert.equal((await fs.stat(item.target)).isFile(), true);
    assert.equal(context.reviewRepository.getItem(item.id).reviewStatus, "approved_for_quarantine");
  } finally { await close(context); }
});

test("restore returns a quarantined file to its original path", async () => {
  const context = await setup();
  try {
    const item = await quarantinableFixture(context);
    await context.service.quarantineItem(item.id);
    const restored = await context.service.restoreItem(item.id);
    assert.equal(restored.status, "restored");
    assert.equal(await hashFileStream(item.target), item.hash);
  } finally { await close(context); }
});

test("restore refuses to overwrite an existing target", async () => {
  const context = await setup();
  try {
    const item = await quarantinableFixture(context);
    await context.service.quarantineItem(item.id);
    await fs.writeFile(item.target, "conflict");
    await assert.rejects(() => context.service.restoreItem(item.id));
    assert.equal(context.reviewRepository.getItem(item.id).reviewStatus, "quarantined");
  } finally { await close(context); }
});

test("permanent deletion is rejected while FILE_DELETION_ENABLED is false", async () => {
  const context = await setup();
  try {
    const item = await addItem(context, { scope: "ad_output", relativePath: `${randomUUID()}/unknown.json` });
    assert.throws(() => context.service.rejectPermanentDeletion(item.id), { code: "FILE_DELETION_DISABLED" });
  } finally { await close(context); }
});

test("the quarantine implementation has no direct deletion primitive", async () => {
  const source = await fs.readFile(path.resolve("lib/files/file-review-service.mjs"), "utf8");
  assert.doesNotMatch(source, /\b(?:unlink|rm|removeFileInsideRoot|removeEntryInsideRoot)\b/);
});

test("the lifecycle page has no delete-all control", async () => {
  const html = await fs.readFile(path.resolve("public/index.html"), "utf8");
  assert.doesNotMatch(html, /一键删除|删除全部|永久删除/);
});

test("the lifecycle page has no automatic deduplication control", async () => {
  const source = `${await fs.readFile(path.resolve("public/index.html"), "utf8")}\n${await fs.readFile(path.resolve("public/app.js"), "utf8")}`;
  assert.doesNotMatch(source, /一键去重|自动去重|deduplicate-all/);
});

test("a failed 006 migration rolls back all review schema changes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "commerce-ops-review-migration-fail-"));
  const staged = path.join(root, "migrations");
  await fs.mkdir(staged);
  for (const name of ["001_mabang_scheduler.sql", "002_operation_audit_events.sql", "003_scheduled_task_soft_delete.sql", "004_export_file_persistence.sql", "005_file_lifecycle_scanning.sql"]) {
    await fs.copyFile(path.join(migrationsDir, name), path.join(staged, name));
  }
  const sql = await fs.readFile(path.join(migrationsDir, "006_file_quarantine_and_review.sql"), "utf8");
  await fs.writeFile(path.join(staged, "006_file_quarantine_and_review.sql"), `${sql}\nINVALID SQL;\n`);
  const db = new SchedulerDatabase({ databasePath: path.join(root, "database.sqlite"), migrationsDir: staged });
  try {
    assert.throws(() => db.migrate());
    assert.equal(db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='managed_files'").get(), undefined);
    assert.equal(db.db.prepare("PRAGMA table_info('file_lifecycle_items')").all().some((column) => column.name === "review_status"), false);
  } finally { db.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test("006 migration preserves existing lifecycle and business row counts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "commerce-ops-review-migration-preserve-"));
  const staged = path.join(root, "migrations");
  await fs.mkdir(staged);
  for (const name of ["001_mabang_scheduler.sql", "002_operation_audit_events.sql", "003_scheduled_task_soft_delete.sql", "004_export_file_persistence.sql", "005_file_lifecycle_scanning.sql"]) {
    await fs.copyFile(path.join(migrationsDir, name), path.join(staged, name));
  }
  const db = new SchedulerDatabase({ databasePath: path.join(root, "database.sqlite"), migrationsDir: staged });
  try {
    db.migrate();
    const scanId = randomUUID();
    const now = new Date().toISOString();
    db.db.prepare("INSERT INTO file_lifecycle_scans(id,status,scopes_json,started_at,created_at,updated_at) VALUES (?,'running','[]',?,?,?)").run(scanId, now, now, now);
    const before = db.db.prepare("SELECT COUNT(*) count FROM file_lifecycle_scans").get().count;
    await fs.copyFile(path.join(migrationsDir, "006_file_quarantine_and_review.sql"), path.join(staged, "006_file_quarantine_and_review.sql"));
    assert.deepEqual(db.migrate(), ["006_file_quarantine_and_review.sql"]);
    assert.equal(db.db.prepare("SELECT COUNT(*) count FROM file_lifecycle_scans").get().count, before);
    assert.equal(db.db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  } finally { db.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test("file review audit records contain no paths hashes or business content", async () => {
  const context = await setup();
  try {
    const { item } = await registrationFixture(context);
    await context.service.registerItem(item.id, { reason: "approved" });
    const rows = context.db.db.prepare("SELECT action,metadata_json,error_summary FROM operation_audit_events WHERE action LIKE 'file.%' ORDER BY id").all();
    const serialized = JSON.stringify(rows);
    assert.doesNotMatch(serialized, new RegExp(context.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
    assert.equal(serialized.includes(item.relativePath), false);
    assert.equal(serialized.includes(item.hash), false);
  } finally { await close(context); }
});

test("registered advertising files are healthy on later lifecycle scans", async () => {
  const context = await setup();
  try {
    const { item } = await registrationFixture(context);
    await context.service.registerItem(item.id);
    const scanner = new FileLifecycleScanner({
      fileRepository: createExportFileRepository(context.db),
      managedFileRepository: context.reviewRepository,
      roots: context.roots,
      policy: resolveLifecyclePolicy({ FILE_LIFECYCLE_RECENT_MINUTES: "1" }),
      now: () => new Date(Date.now() + 10 * 60 * 1000),
    });
    const report = await scanner.scan(["ad_output"]);
    const managed = report.items.find((entry) => entry.managedFileId);
    assert.ok(managed);
    assert.notEqual(managed.classification, "metadata_missing");
    assert.equal(managed.reviewStatus, "registered");
  } finally { await close(context); }
});

test("trusted job metadata is identified for protection rather than formal registration", async () => {
  const context = await setup();
  try {
    const { jobId } = await trustedJob(context);
    const relative = `advertising/${jobId}/file_metadata.json`;
    const target = path.join(rootFor(context, "ad_upload"), ...relative.split("/"));
    const item = await addExistingItem(context, "ad_upload", relative, target);
    const result = await classifyAdvertisingScanItems({ scanItems: context.reviewRepository.scanItems(context.scanId), roots: context.roots });
    const evidence = result.evidence.find((entry) => entry.lifecycleItemId === item.id);
    assert.equal(evidence.detectedFileType, "advertising_unknown");
    assert.equal(evidence.protectRecommended, true);
  } finally { await close(context); }
});

test("quarantine list responses hide original paths quarantine paths and hashes", async () => {
  const context = await setup();
  try {
    const item = await quarantinableFixture(context);
    await context.service.quarantineItem(item.id);
    const result = context.service.listQuarantineRecords({});
    assert.equal("originalRelativePath" in result.records[0], false);
    assert.equal("quarantineRelativePath" in result.records[0], false);
    assert.equal("fileHash" in result.records[0], false);
  } finally { await close(context); }
});

test("deletion cannot be enabled accidentally in this release", () => {
  assert.throws(() => resolveFileReviewPolicy({ FILE_DELETION_ENABLED: "true" }), /must remain false/);
});

test("D2B2B file fixtures stay below the operating-system temporary root", async () => {
  const context = await setup();
  try {
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(context.root));
    assert.equal(relative.startsWith("..") || path.isAbsolute(relative), false);
  } finally { await close(context); }
});
