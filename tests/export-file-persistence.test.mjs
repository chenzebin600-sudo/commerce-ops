import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SchedulerDatabase } from "../lib/mabang-scheduler/db.mjs";
import { createExportFileService, ExportFileService, toPublicExportFile } from "../lib/files/export-file-service.mjs";
import { createFileApi } from "../lib/files/file-api.mjs";
import { createOperationAuditService } from "../lib/security/audit-service.mjs";
import { createTemporaryFilePath, hashFileBuffer } from "../lib/security/file-policy.mjs";

const migrationsDir = path.resolve("migrations");

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "commerce-files-"));
  const exportRoot = path.join(root, "exports");
  const tempRoot = path.join(root, "temp");
  await fs.mkdir(exportRoot, { recursive: true });
  await fs.mkdir(tempRoot, { recursive: true });
  const databasePath = path.join(root, "commerce.sqlite");
  const db = new SchedulerDatabase({ databasePath, migrationsDir });
  db.migrate();
  const audit = createOperationAuditService({ db, env: {} });
  const service = createExportFileService({ db, exportRoot, tempRoot, audit });
  return { root, exportRoot, tempRoot, databasePath, db, audit, service };
}

async function close(context) {
  context.db?.close();
  await fs.rm(context.root, { recursive: true, force: true });
}

async function persist(context, {
  sourceType = "mabang_manual_order",
  requestKey = `manual:${crypto.randomUUID()}`,
  content = Buffer.from("manual export content"),
  taskId = null,
  runId = null,
} = {}) {
  const id = crypto.randomUUID();
  const temporary = await createTemporaryFilePath(context.tempRoot, { prefix: "manual", extension: ".xlsx" });
  await fs.writeFile(temporary.path, content);
  const relativePath = `manual/2026-07/${id}.xlsx`;
  const result = await context.service.persistTemporaryExport({
    id,
    requestKey,
    temporaryPath: temporary.path,
    sourceType,
    taskId,
    runId,
    originalFilename: sourceType.includes("inventory") ? "inventory.xlsx" : "orders.xlsx",
    storageFilename: `${id}.xlsx`,
    relativePath,
    metadata: { exportedRows: 2, sourceRows: 3, generatedBy: "manual" },
  });
  return { ...result, content, relativePath, absolutePath: path.join(context.exportRoot, ...relativePath.split("/")) };
}

function responseRecorder() {
  return {
    status: 0,
    headers: {},
    body: Buffer.alloc(0),
    writeHead(status, headers = {}) { this.status = status; this.headers = headers; },
    end(body = "") { this.body = Buffer.isBuffer(body) ? body : Buffer.from(String(body)); },
  };
}

async function stageMigrations(root, names) {
  const staged = path.join(root, "migrations");
  await fs.mkdir(staged, { recursive: true });
  for (const name of names) await fs.copyFile(path.join(migrationsDir, name), path.join(staged, name));
  return staged;
}

function createOldHistory(db) {
  const now = new Date("2026-07-15T00:00:00.000Z").toISOString();
  const account = db.saveAccountProfile({ name: "Existing", username: "existing", encryptedPassword: "encrypted", enabled: true });
  const task = db.saveTask({
    taskType: "order_export", name: "Existing", accountProfileId: account.id, scheduleType: "daily",
    scheduleConfig: { hour: 8, minute: 0 }, timezone: "Asia/Shanghai", paymentDateMode: "yesterday",
    paymentDateConfig: {}, filters: [], enabled: false, fileRetentionDays: 30, notifyEnabled: false,
    catchUpEnabled: true, nextRunAt: null,
  });
  const run = db.createRun({ taskId: task.id, triggerType: "manual", scheduledRunAt: new Date(now) });
  const fileId = crypto.randomUUID();
  const relativePath = `${task.id}/2026-07/history.xlsx`;
  const content = Buffer.from("unchanged historical export");
  db.db.prepare(`INSERT INTO export_files
    (id,task_id,run_id,original_filename,storage_filename,relative_path,file_size,file_hash,status,expires_at,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    fileId, task.id, run.id, "history.xlsx", "history.xlsx", relativePath, content.length,
    hashFileBuffer(content), "available", null, now,
  );
  db.updateRun(run.id, { exportFileId: fileId });
  return { task, run, fileId, relativePath, content };
}

test("004 migration preserves historical file identity, relationships and metadata", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-migration-"));
  const staged = await stageMigrations(root, ["001_mabang_scheduler.sql", "002_operation_audit_events.sql", "003_scheduled_task_soft_delete.sql"]);
  const db = new SchedulerDatabase({ databasePath: path.join(root, "database.sqlite"), migrationsDir: staged });
  try {
    db.migrate();
    const before = createOldHistory(db);
    await fs.copyFile(path.join(migrationsDir, "004_export_file_persistence.sql"), path.join(staged, "004_export_file_persistence.sql"));
    assert.deepEqual(db.migrate(), ["004_export_file_persistence.sql"]);
    const after = db.getExportFile(before.fileId);
    assert.equal(after.id, before.fileId);
    assert.equal(after.taskId, before.task.id);
    assert.equal(after.runId, before.run.id);
    assert.equal(after.relativePath, before.relativePath);
    assert.equal(after.fileSize, before.content.length);
    assert.equal(after.fileHash, hashFileBuffer(before.content));
    assert.equal(after.sourceType, "mabang_scheduled_order");
    assert.equal(db.db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  } finally {
    db.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a failed 004 migration rolls back the table rebuild and migration version", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-migration-rollback-"));
  const staged = await stageMigrations(root, ["001_mabang_scheduler.sql", "002_operation_audit_events.sql", "003_scheduled_task_soft_delete.sql"]);
  const db = new SchedulerDatabase({ databasePath: path.join(root, "database.sqlite"), migrationsDir: staged });
  try {
    db.migrate();
    const before = createOldHistory(db);
    const migration = await fs.readFile(path.join(migrationsDir, "004_export_file_persistence.sql"), "utf8");
    await fs.writeFile(path.join(staged, "004_broken.sql"), `${migration}\nINSERT INTO missing_table(value) VALUES (1);\n`);
    assert.throws(() => db.migrate());
    const columns = db.db.prepare("PRAGMA table_info(export_files)").all();
    assert.equal(columns.find((column) => column.name === "task_id").notnull, 1);
    assert.equal(columns.some((column) => column.name === "source_type"), false);
    assert.equal(db.db.prepare("SELECT count(*) total FROM export_files WHERE id=?").get(before.fileId).total, 1);
    assert.equal(db.db.prepare("SELECT 1 FROM schema_migrations WHERE version='004_broken.sql'").get(), undefined);
  } finally {
    db.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("manual order export stores a stable UUID, size, SHA-256 and whitelisted metadata", async () => {
  const context = await setup();
  try {
    const created = await persist(context);
    const stored = context.db.getExportFile(created.file.id);
    assert.match(stored.id, /^[0-9a-f-]{36}$/i);
    assert.equal(stored.sourceType, "mabang_manual_order");
    assert.equal(stored.fileSize, created.content.length);
    assert.equal(stored.fileHash, hashFileBuffer(created.content));
    assert.deepEqual(stored.metadata, { exportedRows: 2, sourceRows: 3, generatedBy: "manual" });
  } finally { await close(context); }
});

test("manual inventory export uses the same persistent file service", async () => {
  const context = await setup();
  try {
    const created = await persist(context, { sourceType: "mabang_manual_inventory" });
    assert.equal(context.db.getExportFile(created.file.id).sourceType, "mabang_manual_inventory");
    assert.equal((await context.service.download(created.file.id)).content.toString(), created.content.toString());
  } finally { await close(context); }
});

test("service restart preserves file queries and downloads without an in-memory map", async () => {
  const context = await setup();
  try {
    const created = await persist(context);
    context.db.close();
    context.db = new SchedulerDatabase({ databasePath: context.databasePath, migrationsDir });
    context.db.migrate();
    context.service = createExportFileService({ db: context.db, exportRoot: context.exportRoot, tempRoot: context.tempRoot });
    const queried = await context.service.listFiles({ sourceType: "mabang_manual_order" });
    assert.equal(queried.files[0].id, created.file.id);
    assert.deepEqual((await context.service.download(created.file.id)).content, created.content);
    const serverSource = await fs.readFile(path.resolve("server.mjs"), "utf8");
    assert.equal(serverSource.includes("manualExportFiles"), false);
  } finally { await close(context); }
});

test("idempotency request keys return one file record and remove the redundant temporary file", async () => {
  const context = await setup();
  try {
    const requestKey = `manual:${crypto.randomUUID()}`;
    const first = await persist(context, { requestKey });
    const temporary = await createTemporaryFilePath(context.tempRoot, { prefix: "retry", extension: ".xlsx" });
    await fs.writeFile(temporary.path, Buffer.from("retry bytes"));
    const second = await context.service.persistTemporaryExport({
      id: crypto.randomUUID(), requestKey, temporaryPath: temporary.path, sourceType: "mabang_manual_order",
      originalFilename: "retry.xlsx", storageFilename: `${crypto.randomUUID()}.xlsx`,
      relativePath: `manual/2026-07/${crypto.randomUUID()}.xlsx`,
    });
    assert.equal(second.reused, true);
    assert.equal(second.file.id, first.file.id);
    assert.equal(context.db.listExportFiles().total, 1);
    await assert.rejects(fs.stat(temporary.path));
  } finally { await close(context); }
});

test("a concurrent idempotent export removes its temporary file when the destination is already claimed", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "concurrent-export-"));
  const exportRoot = path.join(root, "exports");
  const tempRoot = path.join(root, "temp");
  await fs.mkdir(exportRoot, { recursive: true });
  await fs.mkdir(tempRoot, { recursive: true });
  const temporary = await createTemporaryFilePath(tempRoot, { prefix: "retry", extension: ".xlsx" });
  await fs.writeFile(temporary.path, Buffer.from("redundant retry"));
  const relativePath = `manual/2026-07/${crypto.randomUUID()}.xlsx`;
  const destination = path.join(exportRoot, ...relativePath.split("/"));
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, Buffer.from("winning request"));
  const existing = { id: crypto.randomUUID(), sourceType: "mabang_manual_order", status: "available" };
  let lookups = 0;
  const repository = { getByRequestKey: () => (++lookups === 1 ? null : existing) };
  const service = new ExportFileService({ db: {}, exportRoot, tempRoot, repository });
  try {
    const result = await service.persistTemporaryExport({
      id: crypto.randomUUID(), requestKey: `manual:${crypto.randomUUID()}`, temporaryPath: temporary.path,
      sourceType: "mabang_manual_order", originalFilename: "retry.xlsx", storageFilename: path.basename(relativePath), relativePath,
    });
    assert.equal(result.reused, true);
    assert.equal(result.file.id, existing.id);
    await assert.rejects(fs.stat(temporary.path));
    assert.equal((await fs.readFile(destination)).toString(), "winning request");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("a generation failure creates no available metadata record", async () => {
  const context = await setup();
  try {
    await assert.rejects(context.service.persistTemporaryExport({
      id: crypto.randomUUID(), requestKey: `manual:${crypto.randomUUID()}`, temporaryPath: path.join(context.tempRoot, "missing.xlsx"),
      sourceType: "mabang_manual_order", originalFilename: "failed.xlsx", storageFilename: "failed.xlsx",
      relativePath: `manual/2026-07/${crypto.randomUUID()}.xlsx`,
    }));
    assert.equal(context.db.listExportFiles().total, 0);
  } finally { await close(context); }
});

test("a metadata write failure removes the newly moved formal file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "metadata-failure-"));
  const exportRoot = path.join(root, "exports");
  const tempRoot = path.join(root, "temp");
  await fs.mkdir(exportRoot, { recursive: true });
  await fs.mkdir(tempRoot, { recursive: true });
  const temporary = await createTemporaryFilePath(tempRoot, { prefix: "failure", extension: ".xlsx" });
  await fs.writeFile(temporary.path, Buffer.from("must be removed"));
  const relativePath = `manual/2026-07/${crypto.randomUUID()}.xlsx`;
  const repository = { getByRequestKey: () => null, create: () => { throw new Error("database unavailable"); } };
  const service = new ExportFileService({ db: {}, exportRoot, tempRoot, repository });
  try {
    await assert.rejects(service.persistTemporaryExport({
      id: crypto.randomUUID(), requestKey: `manual:${crypto.randomUUID()}`, temporaryPath: temporary.path,
      sourceType: "mabang_manual_order", originalFilename: "failed.xlsx", storageFilename: path.basename(relativePath), relativePath,
    }), /database unavailable/);
    await assert.rejects(fs.stat(path.join(exportRoot, ...relativePath.split("/"))));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("missing physical files receive a stable error and remain traceable", async () => {
  const context = await setup();
  try {
    const created = await persist(context);
    await fs.rm(created.absolutePath);
    await assert.rejects(context.service.download(created.file.id), (error) => error.code === "FILE_MISSING");
    const stored = context.db.getExportFile(created.file.id);
    assert.equal(stored.status, "missing");
    assert.ok(stored.missingAt);
  } finally { await close(context); }
});

test("size mismatch is rejected and marks the file as integrity_failed", async () => {
  const context = await setup();
  try {
    const created = await persist(context);
    await fs.appendFile(created.absolutePath, "tamper");
    await assert.rejects(context.service.download(created.file.id), (error) => error.code === "FILE_INTEGRITY_FAILED");
    assert.equal(context.db.getExportFile(created.file.id).status, "integrity_failed");
  } finally { await close(context); }
});

test("SHA-256 mismatch with equal size is rejected", async () => {
  const context = await setup();
  try {
    const created = await persist(context, { content: Buffer.from("same-size-original") });
    await fs.writeFile(created.absolutePath, Buffer.from("same-size-tampered"));
    assert.equal((await fs.stat(created.absolutePath)).size, created.file.fileSize);
    await assert.rejects(context.service.download(created.file.id), (error) => error.code === "FILE_INTEGRITY_FAILED");
    assert.equal(context.db.getExportFile(created.file.id).status, "integrity_failed");
  } finally { await close(context); }
});

test("file queries paginate, filter by source and expose no storage path or hash", async () => {
  const context = await setup();
  try {
    await persist(context, { sourceType: "mabang_manual_order" });
    await persist(context, { sourceType: "mabang_manual_inventory" });
    const filtered = await context.service.listFiles({ sourceType: "mabang_manual_inventory", page: 1, pageSize: 1 });
    assert.equal(filtered.total, 1);
    assert.equal(filtered.files[0].sourceType, "mabang_manual_inventory");
    const publicFile = toPublicExportFile(filtered.files[0]);
    assert.equal("relativePath" in publicFile, false);
    assert.equal("fileHash" in publicFile, false);
    assert.equal(JSON.stringify(publicFile).includes(context.exportRoot), false);
  } finally { await close(context); }
});

test("unified file API lists and downloads persistent files by ID", async () => {
  const context = await setup();
  try {
    const created = await persist(context);
    const handler = createFileApi({ fileService: context.service });
    const listed = responseRecorder();
    await handler({ method: "GET" }, listed, new URL("http://local/api/files?source_type=mabang_manual_order&page_size=10"));
    const payload = JSON.parse(listed.body.toString());
    assert.equal(listed.status, 200);
    assert.equal(payload.files[0].id, created.file.id);
    assert.equal(JSON.stringify(payload).includes(context.exportRoot), false);
    const downloaded = responseRecorder();
    await handler({ method: "GET" }, downloaded, new URL(`http://local/api/files/${created.file.id}/download`));
    assert.equal(downloaded.status, 200);
    assert.deepEqual(downloaded.body, created.content);
  } finally { await close(context); }
});

test("scheduled file wrapper persists source type and remains linked to task and run", async () => {
  const context = await setup();
  try {
    const account = context.db.saveAccountProfile({ name: "Scheduled", username: "scheduled", encryptedPassword: "encrypted", enabled: true });
    const task = context.db.saveTask({
      taskType: "order_export", name: "Scheduled", accountProfileId: account.id, scheduleType: "daily",
      scheduleConfig: { hour: 8, minute: 0 }, timezone: "Asia/Shanghai", paymentDateMode: "yesterday",
      paymentDateConfig: {}, filters: [], enabled: false, fileRetentionDays: 30, notifyEnabled: false,
      catchUpEnabled: true, nextRunAt: null,
    });
    const run = context.db.createRun({ taskId: task.id, triggerType: "manual", scheduledRunAt: new Date() });
    const created = await persist(context, { sourceType: "mabang_scheduled_order", taskId: task.id, runId: run.id });
    assert.equal(created.file.taskId, task.id);
    assert.equal(created.file.runId, run.id);
    assert.equal(context.db.getExportFile(created.file.id).sourceType, "mabang_scheduled_order");
  } finally { await close(context); }
});

test("file persistence and integrity failures write bounded audit events without paths or content", async () => {
  const context = await setup();
  try {
    const created = await persist(context, { content: Buffer.from("private order contents") });
    await fs.appendFile(created.absolutePath, "tamper");
    await assert.rejects(context.service.download(created.file.id));
    const createdEvents = context.audit.queryEvents({ action: "file.export.created" });
    const integrityEvents = context.audit.queryEvents({ action: "file.integrity_failed" });
    assert.equal(createdEvents.total, 1);
    assert.equal(integrityEvents.total, 1);
    const serialized = JSON.stringify([...createdEvents.events, ...integrityEvents.events]);
    assert.equal(serialized.includes(context.exportRoot), false);
    assert.equal(serialized.includes("private order contents"), false);
  } finally { await close(context); }
});

test("the Mabang page exposes a persistent export history view and unified downloads", async () => {
  const html = await fs.readFile(path.resolve("public/index.html"), "utf8");
  const app = await fs.readFile(path.resolve("public/app.js"), "utf8");
  assert.match(html, /data-mabang-view="files"/);
  assert.match(html, /id="mabangFilesTable"/);
  assert.match(app, /\/api\/files\?page=1&page_size=50/);
  assert.match(app, /\/api\/files\/\$\{encodeURIComponent\(fileId\)\}\/download/);
  assert.match(app, /requestId: crypto\.randomUUID\(\)/);
});
