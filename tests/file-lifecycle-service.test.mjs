import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SchedulerDatabase } from "../lib/mabang-scheduler/db.mjs";
import { createExportFileRepository } from "../lib/files/file-repository.mjs";
import { createExportFileService } from "../lib/files/export-file-service.mjs";
import { FileLifecycleRepository } from "../lib/files/file-lifecycle-repository.mjs";
import { FileLifecycleService } from "../lib/files/file-lifecycle-service.mjs";
import { createFileLifecycleApi } from "../lib/files/file-lifecycle-api.mjs";
import { FileLifecycleScanner } from "../lib/files/file-lifecycle-scanner.mjs";
import { resolveLifecyclePolicy } from "../lib/files/file-lifecycle-policy.mjs";
import { createOperationAuditService } from "../lib/security/audit-service.mjs";
import { hashFileBuffer } from "../lib/security/file-policy.mjs";

const migrationsDir = path.resolve("migrations");

function emptyReport(overrides = {}) {
  return {
    items: [],
    summary: { healthy: 0 },
    totalFiles: 0,
    totalBytes: 0,
    truncated: false,
    scopeErrors: [],
    ...overrides,
  };
}

async function setup({ scanner = null, runWorker = null } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lifecycle-service-"));
  const exportRoot = path.join(root, "exports");
  const tempRoot = path.join(root, "temp");
  await fs.mkdir(exportRoot, { recursive: true });
  await fs.mkdir(tempRoot, { recursive: true });
  const db = new SchedulerDatabase({ databasePath: path.join(root, "database.sqlite"), migrationsDir });
  db.migrate();
  const repository = new FileLifecycleRepository({ db });
  const audit = createOperationAuditService({ db, env: {} });
  const fileService = createExportFileService({ db, exportRoot, tempRoot, audit });
  const policy = resolveLifecyclePolicy({ FILE_LIFECYCLE_RECENT_MINUTES: "5" });
  const service = new FileLifecycleService({
    repository,
    scanner: scanner || { scan: async () => emptyReport() },
    audit,
    fileService,
    tempRoot,
    runWorker,
    policy,
    now: () => new Date("2026-07-20T08:00:00.000Z"),
  });
  return { root, exportRoot, tempRoot, db, repository, audit, fileService, policy, service };
}

async function close(context) {
  context.db.close();
  await fs.rm(context.root, { recursive: true, force: true });
}

async function stageMigrations(root, names) {
  const target = path.join(root, "migrations");
  await fs.mkdir(target, { recursive: true });
  for (const name of names) await fs.copyFile(path.join(migrationsDir, name), path.join(target, name));
  return target;
}

function responseRecorder() {
  return {
    status: 0, headers: {}, body: Buffer.alloc(0),
    writeHead(status, headers = {}) { this.status = status; this.headers = headers; },
    end(value = "") { this.body = Buffer.isBuffer(value) ? value : Buffer.from(String(value)); },
  };
}

function request(method, body = null) {
  const bytes = body == null ? [] : [Buffer.from(JSON.stringify(body))];
  return {
    method,
    auditContext: { annotate() {} },
    async *[Symbol.asyncIterator]() { for (const chunk of bytes) yield chunk; },
  };
}

test("005 migration preserves old export rows and protects the pre-lifecycle baseline", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lifecycle-migration-"));
  const staged = await stageMigrations(root, [
    "001_mabang_scheduler.sql", "002_operation_audit_events.sql", "003_scheduled_task_soft_delete.sql", "004_export_file_persistence.sql",
  ]);
  const db = new SchedulerDatabase({ databasePath: path.join(root, "database.sqlite"), migrationsDir: staged });
  try {
    db.migrate();
    const columnsBefore = db.db.prepare("PRAGMA table_info(export_files)").all().map((column) => ({ name: column.name, type: column.type, notnull: column.notnull, pk: column.pk }));
    const id = crypto.randomUUID();
    const content = Buffer.from("old export");
    db.exportFiles.create({ id, sourceType: "mabang_scheduled_order", originalFilename: "old.xlsx", storageFilename: "old.xlsx", relativePath: "old/old.xlsx", fileSize: content.length, fileHash: hashFileBuffer(content) });
    await fs.copyFile(path.join(migrationsDir, "005_file_lifecycle_scanning.sql"), path.join(staged, "005_file_lifecycle_scanning.sql"));
    assert.deepEqual(db.migrate(), ["005_file_lifecycle_scanning.sql"]);
    assert.equal(db.getExportFile(id).id, id);
    const columnsAfter = db.db.prepare("PRAGMA table_info(export_files)").all().map((column) => ({ name: column.name, type: column.type, notnull: column.notnull, pk: column.pk }));
    assert.deepEqual(columnsAfter, columnsBefore);
    assert.equal(db.db.prepare("SELECT reason FROM file_lifecycle_protected_files WHERE file_id=?").get(id).reason, "pre_lifecycle_baseline");
    assert.equal(db.db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  } finally { db.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test("a failed 005 migration rolls back all lifecycle tables and its migration version", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lifecycle-migration-fail-"));
  const staged = await stageMigrations(root, [
    "001_mabang_scheduler.sql", "002_operation_audit_events.sql", "003_scheduled_task_soft_delete.sql", "004_export_file_persistence.sql",
  ]);
  const db = new SchedulerDatabase({ databasePath: path.join(root, "database.sqlite"), migrationsDir: staged });
  try {
    db.migrate();
    const sql = await fs.readFile(path.join(migrationsDir, "005_file_lifecycle_scanning.sql"), "utf8");
    await fs.writeFile(path.join(staged, "005_broken.sql"), `${sql}\nINSERT INTO missing_table(value) VALUES (1);\n`);
    assert.throws(() => db.migrate());
    assert.equal(db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='file_lifecycle_scans'").get(), undefined);
    assert.equal(db.db.prepare("SELECT 1 FROM schema_migrations WHERE version='005_broken.sql'").get(), undefined);
    assert.equal(db.db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  } finally { db.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test("completed scan reports persist items with pagination and category filters", async () => {
  const context = await setup();
  try {
    const scan = context.repository.createScan(["main_export"]);
    context.repository.completeScan(scan.id, emptyReport({
      items: [
        { id: crypto.randomUUID(), classification: "healthy", categories: ["healthy"], scope: "main_export", maskedFilename: "one.xlsx", fileSize: 1, physicalStatus: "present", reasonCode: "OK" },
        { id: crypto.randomUUID(), classification: "metadata_missing", categories: ["metadata_missing", "expired_candidate"], scope: "main_export", maskedFilename: "two.xlsx", fileSize: 2, physicalStatus: "present", reasonCode: "MISSING" },
      ],
      summary: { healthy: 1, metadata_missing: 1, expired_candidate: 1 }, totalFiles: 2, totalBytes: 3,
    }));
    const page = context.repository.listItems(scan.id, { page: 1, pageSize: 1 });
    const filtered = context.repository.listItems(scan.id, { classification: "expired_candidate" });
    assert.equal(page.total, 2);
    assert.equal(page.items.length, 1);
    assert.equal(filtered.total, 1);
    assert.deepEqual(context.repository.getScan(scan.id).scopeErrors, []);
  } finally { await close(context); }
});

test("only one lifecycle scan can run at a time", async () => {
  let release;
  const scanner = { scan: () => new Promise((resolve) => { release = () => resolve(emptyReport()); }) };
  const context = await setup({ scanner });
  try {
    const first = await context.service.startScan(["main_export"]);
    await new Promise((resolve) => setImmediate(resolve));
    const second = await context.service.startScan(["main_export"]);
    assert.equal(second.reused, true);
    assert.equal(second.scan.id, first.scan.id);
    release();
    await context.service.waitForIdle();
  } finally { await close(context); }
});

test("scan scope input cannot contain an arbitrary path", async () => {
  const context = await setup();
  try {
    await assert.rejects(() => context.service.startScan(["C:/Users"]), /Unsupported lifecycle scan scope/);
    assert.equal(context.repository.listScans().total, 0);
  } finally { await close(context); }
});

test("a scanner failure is persisted and does not escape the asynchronous worker", async () => {
  const context = await setup({ scanner: { scan: async () => { throw Object.assign(new Error("failed"), { code: "SCAN_TEST_FAILURE" }); } } });
  try {
    const { scan } = await context.service.startScan(["main_export"]);
    await context.service.waitForIdle();
    const failed = context.repository.getScan(scan.id);
    assert.equal(failed.status, "failed");
    assert.equal(failed.errorCode, "SCAN_TEST_FAILURE");
  } finally { await close(context); }
});

test("lifecycle APIs start asynchronously and return paged reports without paths or hashes", async () => {
  const context = await setup();
  try {
    const api = createFileLifecycleApi({ service: context.service });
    const start = responseRecorder();
    await api(request("POST", { scopes: ["main_export"] }), start, new URL("http://local/api/files/lifecycle/scan"));
    assert.equal(start.status, 202);
    const scanId = JSON.parse(start.body).scan.id;
    await context.service.waitForIdle();
    const detail = responseRecorder();
    await api(request("GET"), detail, new URL(`http://local/api/files/lifecycle/reports/${scanId}?page=1&page_size=10`));
    assert.equal(detail.status, 200);
    const serialized = detail.body.toString();
    assert.equal(/[A-Za-z]:[\\/]/.test(serialized), false);
    assert.equal(serialized.includes("fileHash"), false);
    assert.equal(serialized.includes("relativePath"), false);
  } finally { await close(context); }
});

test("lifecycle API rejects an arbitrary scope without creating a report", async () => {
  const context = await setup();
  try {
    const api = createFileLifecycleApi({ service: context.service });
    const response = responseRecorder();
    await api(request("POST", { scopes: ["D:/"] }), response, new URL("http://local/api/files/lifecycle/scan"));
    assert.equal(response.status, 400);
    assert.equal(context.repository.listScans().total, 0);
  } finally { await close(context); }
});

test("report export uses the persistent file service and a stable lifecycle source type", async () => {
  let workerPayload;
  const context = await setup({ runWorker: async (payload) => {
    workerPayload = payload;
    await fs.writeFile(payload.outputPath, Buffer.from("mock safe lifecycle xlsx"));
    return { ok: true, sanitizedCells: [{ sheet: "Lifecycle report", count: 1 }] };
  } });
  try {
    const scan = context.repository.createScan(["main_export"]);
    context.repository.completeScan(scan.id, emptyReport({
      items: [{ id: crypto.randomUUID(), classification: "metadata_missing", categories: ["metadata_missing"], scope: "main_export", maskedFilename: "=fo***la.xlsx", fileSize: 4, physicalStatus: "present", reasonCode: "MISSING" }],
      summary: { metadata_missing: 1 }, totalFiles: 1, totalBytes: 4,
    }));
    const file = await context.service.exportReport(scan.id);
    assert.equal(file.sourceType, "system_file_lifecycle_report");
    assert.equal(context.fileService.repository.list({ sourceType: "system_file_lifecycle_report" }).total, 1);
    assert.equal(context.fileService.repository.list({ sourceType: "mabang_manual_order" }).total, 0);
    assert.equal(context.repository.getScan(scan.id).reportFileId, file.id);
    assert.equal(workerPayload.kind, "lifecycle");
    assert.equal(workerPayload.records[0].filename, "=fo***la.xlsx");
    assert.equal((await context.fileService.download(file.id)).content.toString(), "mock safe lifecycle xlsx");
  } finally { await close(context); }
});

test("a registered lifecycle report is not identified as an untracked business file", async () => {
  const context = await setup({ runWorker: async (payload) => {
    await fs.writeFile(payload.outputPath, Buffer.from("report bytes"));
    return { ok: true, sanitizedCells: [] };
  } });
  try {
    const scan = context.repository.createScan(["main_export"]);
    context.repository.completeScan(scan.id, emptyReport());
    await context.service.exportReport(scan.id);
    const scanner = new FileLifecycleScanner({
      fileRepository: context.fileService.repository,
      roots: [{ scope: "main_export", root: context.exportRoot }],
      policy: context.policy,
      protectedFileIds: new Set(),
      now: () => new Date("2026-07-20T08:00:00.000Z"),
    });
    const next = await scanner.scan(["main_export"]);
    assert.equal(next.summary.metadata_missing, 0);
    assert.equal(next.summary.legacy_untracked_export, 0);
  } finally { await close(context); }
});

test("scan audit events contain counts but no file paths or filenames", async () => {
  const context = await setup();
  try {
    await context.service.startScan(["main_export"]);
    await context.service.waitForIdle();
    const events = [
      ...context.audit.queryEvents({ action: "file.lifecycle.scan.started" }).events,
      ...context.audit.queryEvents({ action: "file.lifecycle.scan.completed" }).events,
    ];
    const serialized = JSON.stringify(events);
    assert.equal(events.length, 2);
    assert.equal(/[A-Za-z]:[\\/]/.test(serialized), false);
    assert.equal(serialized.includes(".xlsx"), false);
  } finally { await close(context); }
});

test("a lifecycle scan never updates existing export_files rows", async () => {
  const context = await setup();
  try {
    const record = context.fileService.repository.create({ sourceType: "mabang_manual_order", originalFilename: "missing.xlsx", storageFilename: "missing.xlsx", relativePath: "manual/missing.xlsx", fileSize: 1, fileHash: "a".repeat(64) });
    const before = context.db.db.prepare("SELECT * FROM export_files WHERE id=?").get(record.id);
    await context.service.startScan(["main_export"]);
    await context.service.waitForIdle();
    const after = context.db.db.prepare("SELECT * FROM export_files WHERE id=?").get(record.id);
    assert.deepEqual(after, before);
  } finally { await close(context); }
});

test("the lifecycle page exposes read-only actions and no cleanup controls", async () => {
  const html = await fs.readFile(path.resolve("public/index.html"), "utf8");
  const app = await fs.readFile(path.resolve("public/app.js"), "utf8");
  assert.match(html, /id="startLifecycleScanBtn"/);
  assert.match(html, /id="lifecycleItemsTable"/);
  assert.match(app, /\/api\/files\/lifecycle\/scan/);
  assert.doesNotMatch(html, /data-lifecycle-action="(?:delete|cleanup|isolate|repair|relink)"/i);
  assert.doesNotMatch(app, /data-lifecycle-action=['"](?:delete|cleanup|isolate|repair|relink)/i);
});
