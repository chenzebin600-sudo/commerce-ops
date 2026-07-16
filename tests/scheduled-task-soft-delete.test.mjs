import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { SchedulerDatabase } from "../lib/mabang-scheduler/db.mjs";
import { createMabangSchedulerApi } from "../lib/mabang-scheduler/api.mjs";
import { encryptSecret } from "../lib/mabang-scheduler/crypto.mjs";
import { createTaskExecutor } from "../lib/mabang-scheduler/executor.mjs";
import { MabangSchedulerService } from "../lib/mabang-scheduler/service.mjs";
import { createHttpAuditContext, completeHttpAudit } from "../lib/security/audit-http.mjs";
import { createOperationAuditService } from "../lib/security/audit-service.mjs";

process.env.APP_ENCRYPTION_KEY = "soft-delete-test-encryption-key";

const migrationsDir = path.resolve("migrations");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function createContext({ enabled = true, accountEnabled = true, nextRunAt = "2026-07-16T00:00:00.000Z" } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "commerce-ops-soft-delete-"));
  const exportRoot = path.join(root, "exports");
  const db = new SchedulerDatabase({ databasePath: path.join(root, "commerce-ops.sqlite"), migrationsDir });
  db.migrate();
  const account = db.saveAccountProfile({
    name: "Temporary account",
    username: "temporary-user",
    encryptedPassword: encryptSecret("temporary-password"),
    enabled: accountEnabled,
  });
  const task = db.saveTask({
    taskType: "order_export",
    name: "Temporary scheduled task",
    description: "soft delete test",
    accountProfileId: account.id,
    dingtalkConfigId: null,
    scheduleType: "daily",
    scheduleConfig: { hour: 8, minute: 0 },
    timezone: "Asia/Shanghai",
    paymentDateMode: "yesterday",
    paymentDateConfig: {},
    filters: [],
    enabled,
    fileRetentionDays: 30,
    notifyEnabled: false,
    catchUpEnabled: true,
    nextRunAt: enabled ? nextRunAt : null,
  });
  const audit = createOperationAuditService({ db, env: {} });
  return { root, exportRoot, db, account, task, audit };
}

async function createHistory(context, { status = "success" } = {}) {
  const run = context.db.createRun({
    taskId: context.task.id,
    triggerType: "manual",
    scheduledRunAt: new Date("2026-07-15T00:00:00.000Z"),
  });
  assert.equal(context.db.claimRun(run.id).claimed, true);
  const content = Buffer.from("historical xlsx bytes are intentionally unchanged");
  const relativePath = `${context.task.id}/2026-07/history.xlsx`;
  const target = path.join(context.exportRoot, ...relativePath.split("/"));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
  const file = context.db.createExportFile({
    taskId: context.task.id,
    runId: run.id,
    originalFilename: "history.xlsx",
    storageFilename: "history.xlsx",
    relativePath,
    fileSize: content.length,
    fileHash: sha256(content),
    status: "available",
  });
  context.db.updateRun(run.id, {
    status,
    finishedAt: "2026-07-15T00:01:00.000Z",
    exportFileId: file.id,
  });
  return { run: context.db.getRun(run.id), file, target, content };
}

function createApiHarness(context) {
  const handler = createMabangSchedulerApi({
    db: context.db,
    runWorker: async () => { throw new Error("External worker must not run in API soft-delete tests"); },
    exportRoot: context.exportRoot,
    now: () => new Date("2026-07-16T01:00:00.000Z"),
  });
  return async function request(method, requestPath, body) {
    const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
    const req = Readable.from(payload);
    req.method = method;
    req.headers = { authorization: "Bearer temporary-test-token" };
    req.socket = { remoteAddress: "127.0.0.1" };
    const url = new URL(requestPath, "http://127.0.0.1:3101");
    const auditContext = createHttpAuditContext(req, url);
    const chunks = [];
    const res = {
      statusCode: 200,
      headers: {},
      writeHead(status, headers = {}) { this.statusCode = status; this.headers = headers; },
      end(value) { if (value !== undefined) chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(String(value))); },
    };
    await handler(req, res, url);
    const contentType = String(res.headers["content-type"] || "");
    const buffer = Buffer.concat(chunks);
    const data = contentType.includes("application/json") && buffer.length ? JSON.parse(buffer.toString("utf8")) : null;
    completeHttpAudit(context.audit, auditContext, {
      httpStatus: res.statusCode,
      error: res.statusCode >= 400 ? data?.error : null,
      now: () => new Date("2026-07-16T01:00:01.000Z"),
    });
    return { status: res.statusCode, headers: res.headers, buffer, data };
  };
}

test("soft-delete migration is additive and preserves all existing business rows", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "commerce-ops-soft-delete-migration-"));
  const stagedMigrations = path.join(root, "migrations");
  await fs.mkdir(stagedMigrations);
  await fs.copyFile(path.join(migrationsDir, "001_mabang_scheduler.sql"), path.join(stagedMigrations, "001_mabang_scheduler.sql"));
  await fs.copyFile(path.join(migrationsDir, "002_operation_audit_events.sql"), path.join(stagedMigrations, "002_operation_audit_events.sql"));
  const db = new SchedulerDatabase({ databasePath: path.join(root, "database.sqlite"), migrationsDir: stagedMigrations });
  db.migrate();
  const account = db.saveAccountProfile({ name: "Existing", username: "existing", encryptedPassword: encryptSecret("password"), enabled: true });
  const task = db.saveTask({
    taskType: "order_export", name: "Existing task", accountProfileId: account.id, scheduleType: "daily",
    scheduleConfig: { hour: 8, minute: 0 }, timezone: "Asia/Shanghai", paymentDateMode: "yesterday",
    paymentDateConfig: {}, filters: [], enabled: false, fileRetentionDays: 30, notifyEnabled: false,
    catchUpEnabled: true, nextRunAt: null,
  });
  const before = {
    tasks: db.db.prepare("SELECT COUNT(*) count FROM scheduled_export_tasks").get().count,
    accounts: db.db.prepare("SELECT COUNT(*) count FROM mabang_account_profiles").get().count,
  };
  await fs.copyFile(path.join(migrationsDir, "003_scheduled_task_soft_delete.sql"), path.join(stagedMigrations, "003_scheduled_task_soft_delete.sql"));
  assert.deepEqual(db.migrate(), ["003_scheduled_task_soft_delete.sql"]);
  const after = {
    tasks: db.db.prepare("SELECT COUNT(*) count FROM scheduled_export_tasks").get().count,
    accounts: db.db.prepare("SELECT COUNT(*) count FROM mabang_account_profiles").get().count,
  };
  assert.deepEqual(after, before);
  assert.equal(db.getTask(task.id).deleted, false);
  assert.equal(db.db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  db.close();
});

test("a failed soft-delete migration rolls back the added column and version", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "commerce-ops-soft-delete-rollback-"));
  const stagedMigrations = path.join(root, "migrations");
  await fs.mkdir(stagedMigrations);
  await fs.copyFile(path.join(migrationsDir, "001_mabang_scheduler.sql"), path.join(stagedMigrations, "001_mabang_scheduler.sql"));
  await fs.writeFile(path.join(stagedMigrations, "002_broken.sql"), "ALTER TABLE scheduled_export_tasks ADD COLUMN deleted_at TEXT;\nINVALID SQL;\n");
  const db = new SchedulerDatabase({ databasePath: path.join(root, "database.sqlite"), migrationsDir: stagedMigrations });
  assert.throws(() => db.migrate());
  const columns = db.db.prepare("PRAGMA table_info('scheduled_export_tasks')").all().map((row) => row.name);
  assert.equal(columns.includes("deleted_at"), false);
  assert.equal(db.db.prepare("SELECT COUNT(*) count FROM schema_migrations WHERE version='002_broken.sql'").get().count, 0);
  db.close();
});

test("soft deletion is transactional, disables scheduling and is idempotent", () => {
  const context = createContext();
  const first = context.db.softDeleteTask(context.task.id, {
    deletedBy: "authenticated_session",
    deleteReason: "retired test task",
    now: new Date("2026-07-16T01:00:00.000Z"),
  });
  assert.equal(first.alreadyDeleted, false);
  assert.equal(first.task.enabled, false);
  assert.equal(first.task.nextRunAt, null);
  assert.equal(first.task.deletedAt, "2026-07-16T01:00:00.000Z");
  assert.equal(first.task.deletedBy, "authenticated_session");
  const second = context.db.softDeleteTask(context.task.id, { deletedBy: "scheduler", deleteReason: "changed" });
  assert.equal(second.alreadyDeleted, true);
  assert.equal(second.task.deletedAt, first.task.deletedAt);
  assert.equal(second.task.deleteReason, "retired test task");
  assert.equal(context.db.db.prepare("SELECT COUNT(*) count FROM scheduled_export_tasks WHERE id=?").get(context.task.id).count, 1);
  context.db.close();
});

test("soft deletion preserves run rows, file metadata, physical Excel and hash", async () => {
  const context = createContext();
  const history = await createHistory(context);
  const beforeHash = sha256(await fs.readFile(history.target));
  context.db.softDeleteTask(context.task.id);
  assert.equal(context.db.listRuns({ taskId: context.task.id }).length, 1);
  assert.equal(context.db.getExportFile(history.file.id).taskId, context.task.id);
  assert.equal(sha256(await fs.readFile(history.target)), beforeHash);
  context.db.close();
});

test("default task queries exclude deleted rows while include_deleted returns safe deletion metadata", async () => {
  const context = createContext();
  const request = createApiHarness(context);
  context.db.softDeleteTask(context.task.id, { deletedBy: "authenticated_session", deleteReason: "obsolete" });
  const normal = await request("GET", "/api/mabang/scheduled-tasks");
  const managed = await request("GET", "/api/mabang/scheduled-tasks?include_deleted=true");
  assert.equal(normal.data.tasks.length, 0);
  assert.equal(managed.data.tasks.length, 1);
  assert.equal(managed.data.tasks[0].deleted, true);
  assert.equal(managed.data.tasks[0].deletedBy, "authenticated_session");
  assert.equal(Object.hasOwn(managed.data.tasks[0], "encryptedPassword"), false);
  context.db.close();
});

test("deleted tasks reject edits, state changes, execution, preview and duplication with TASK_DELETED", async () => {
  const context = createContext();
  const request = createApiHarness(context);
  context.db.softDeleteTask(context.task.id);
  const operations = [
    ["PUT", `/api/mabang/scheduled-tasks/${context.task.id}`, {}],
    ["POST", `/api/mabang/scheduled-tasks/${context.task.id}/enable`, {}],
    ["POST", `/api/mabang/scheduled-tasks/${context.task.id}/disable`, {}],
    ["POST", `/api/mabang/scheduled-tasks/${context.task.id}/run-now`, {}],
    ["POST", `/api/mabang/scheduled-tasks/${context.task.id}/preview`, {}],
    ["POST", `/api/mabang/scheduled-tasks/${context.task.id}/duplicate`, {}],
  ];
  for (const [method, requestPath, body] of operations) {
    const response = await request(method, requestPath, body);
    assert.equal(response.status, 409, requestPath);
    assert.equal(response.data.code, "TASK_DELETED", requestPath);
    assert.equal(response.data.error, "该定时任务已删除，不能继续执行。如需使用，请先恢复任务。");
    assert.doesNotMatch(JSON.stringify(response.data), /[A-Za-z]:\\|at executeRun|node:internal/);
  }
  assert.ok(context.audit.queryEvents({ action: "mabang.task.deleted_execution_rejected" }).total >= 1);
  context.db.close();
});

test("retrying a historical run is rejected after its task is deleted", async () => {
  const context = createContext();
  const history = await createHistory(context, { status: "failed" });
  const request = createApiHarness(context);
  context.db.softDeleteTask(context.task.id);
  const response = await request("POST", `/api/mabang/scheduled-runs/${history.run.id}/retry`, {});
  assert.equal(response.status, 409);
  assert.equal(response.data.code, "TASK_DELETED");
  assert.equal(context.db.listRuns({ taskId: context.task.id }).length, 1);
  context.db.close();
});

test("restoring a task clears deletion state, stays disabled and preserves history", async () => {
  const context = createContext();
  const history = await createHistory(context);
  context.db.softDeleteTask(context.task.id, { deleteReason: "temporary removal" });
  const first = context.db.restoreTask(context.task.id, { now: new Date("2026-07-16T02:00:00.000Z") });
  assert.equal(first.alreadyRestored, false);
  assert.equal(first.task.deleted, false);
  assert.equal(first.task.deletedAt, null);
  assert.equal(first.task.deletedBy, null);
  assert.equal(first.task.deleteReason, null);
  assert.equal(first.task.enabled, false);
  assert.equal(first.task.nextRunAt, null);
  assert.equal(context.db.listRuns({ taskId: context.task.id }).length, 1);
  assert.equal(context.db.getExportFile(history.file.id).id, history.file.id);
  const second = context.db.restoreTask(context.task.id);
  assert.equal(second.alreadyRestored, true);
  assert.equal(second.task.enabled, false);
  context.db.close();
});

test("a task linked to a disabled account can be restored but cannot be enabled", async () => {
  const context = createContext({ accountEnabled: false, enabled: false });
  const request = createApiHarness(context);
  context.db.softDeleteTask(context.task.id);
  const restored = await request("POST", `/api/mabang/scheduled-tasks/${context.task.id}/restore`, {});
  assert.equal(restored.status, 200);
  assert.equal(restored.data.canEnable, false);
  assert.match(restored.data.warning, /账号不存在或已停用/);
  const enabled = await request("POST", `/api/mabang/scheduled-tasks/${context.task.id}/enable`, {});
  assert.equal(enabled.status, 409);
  assert.equal(enabled.data.code, "TASK_ACCOUNT_UNAVAILABLE");
  context.db.close();
});

test("deleted tasks are excluded from due scheduling and remain excluded after restart", () => {
  const context = createContext({ nextRunAt: "2026-07-16T00:00:00.000Z" });
  context.db.softDeleteTask(context.task.id);
  assert.equal(context.db.dueTasks(new Date("2026-07-16T01:00:00.000Z")).length, 0);
  context.db.close();
  const reopened = new SchedulerDatabase({ databasePath: path.join(context.root, "commerce-ops.sqlite"), migrationsDir });
  reopened.migrate();
  const service = new MabangSchedulerService({
    db: reopened,
    executor: { executeRun: async () => assert.fail("Deleted task must not execute") },
    exportRoot: context.exportRoot,
    now: () => new Date("2026-07-16T01:00:00.000Z"),
  });
  service.initialize();
  const task = reopened.getTask(context.task.id);
  assert.equal(task.deleted, true);
  assert.equal(task.nextRunAt, null);
  assert.equal(reopened.dueTasks(new Date("2026-07-17T01:00:00.000Z")).length, 0);
  reopened.close();
});

test("a queued run is skipped when its task is deleted before execution and is audited", async () => {
  const context = createContext();
  const run = context.db.createRun({ taskId: context.task.id, triggerType: "scheduled", scheduledRunAt: new Date("2026-07-16T00:00:00.000Z") });
  context.db.softDeleteTask(context.task.id);
  const executor = createTaskExecutor({
    db: context.db,
    runWorker: async () => assert.fail("Deleted queued task must not call worker"),
    exportRoot: context.exportRoot,
    retryDelays: [],
    audit: context.audit,
  });
  const result = await executor.executeRun(run.id);
  assert.equal(result.status, "skipped");
  assert.equal(result.errorCode, "TASK_DELETED");
  assert.equal(context.db.getRunDetails(run.id).events.some((event) => event.errorCode === "TASK_DELETED"), true);
  assert.equal(context.audit.queryEvents({ action: "mabang.task.deleted_scheduler_skipped" }).total, 1);
  context.db.close();
});

test("a running task may finish after deletion but is not scheduled again", async () => {
  const context = createContext();
  const run = context.db.createRun({ taskId: context.task.id, triggerType: "manual", scheduledRunAt: new Date("2026-07-16T00:00:00.000Z") });
  let markStarted;
  let releaseWorker;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const released = new Promise((resolve) => { releaseWorker = resolve; });
  const worker = async (payload) => {
    if (payload.action === "orders") {
      markStarted();
      await released;
      return { ok: true, columns: ["订单编号"], records: [{ 订单编号: "O-1" }], summary: { collectedOrders: 1, orders: 1, rows: 1 } };
    }
    if (payload.action === "write-xlsx") {
      await fs.writeFile(payload.outputPath, "temporary xlsx");
      return { ok: true, rows: 1 };
    }
    throw new Error("Unexpected worker action");
  };
  const executor = createTaskExecutor({ db: context.db, runWorker: worker, exportRoot: context.exportRoot, retryDelays: [], audit: context.audit });
  const execution = executor.executeRun(run.id);
  await started;
  context.db.softDeleteTask(context.task.id, { now: new Date("2026-07-16T00:00:30.000Z") });
  releaseWorker();
  const result = await execution;
  assert.equal(result.status, "success");
  assert.equal(context.db.getTask(context.task.id).nextRunAt, null);
  assert.equal(context.db.getRunDetails(run.id).events.some((event) => event.errorCode === "TASK_DELETED_DURING_EXECUTION"), true);
  context.db.close();
});

test("delete and restore APIs write dedicated audit actions", async () => {
  const context = createContext();
  const request = createApiHarness(context);
  assert.equal((await request("DELETE", `/api/mabang/scheduled-tasks/${context.task.id}`, { reason: "test cleanup" })).status, 200);
  assert.equal((await request("POST", `/api/mabang/scheduled-tasks/${context.task.id}/restore`, {})).status, 200);
  assert.equal(context.audit.queryEvents({ action: "mabang.task.delete" }).total, 1);
  assert.equal(context.audit.queryEvents({ action: "mabang.task.restore" }).total, 1);
  context.db.close();
});

test("delete reasons are bounded and redact configured secrets and credentials", async () => {
  const context = createContext();
  const request = createApiHarness(context);
  const previous = process.env.APP_ACCESS_TOKEN;
  process.env.APP_ACCESS_TOKEN = "temporary-secret-token-value";
  try {
    const response = await request("DELETE", `/api/mabang/scheduled-tasks/${context.task.id}`, {
      reason: "retire token=temporary-secret-token-value password=do-not-store 18912341369",
    });
    assert.equal(response.status, 200);
    const stored = context.db.getTask(context.task.id).deleteReason;
    assert.doesNotMatch(stored, /temporary-secret-token-value|do-not-store|18912341369/);
    assert.match(stored, /\[REDACTED\]|\*\*\*\*/);
    assert.ok(stored.length <= 240);
  } finally {
    if (previous === undefined) delete process.env.APP_ACCESS_TOKEN;
    else process.env.APP_ACCESS_TOKEN = previous;
  }
  context.db.close();
});

test("historical details and file downloads remain available after deletion", async () => {
  const context = createContext();
  const history = await createHistory(context);
  const request = createApiHarness(context);
  context.db.softDeleteTask(context.task.id);
  const details = await request("GET", `/api/mabang/scheduled-runs/${history.run.id}`);
  const download = await request("GET", `/api/mabang/export-files/${history.file.id}/download`);
  assert.equal(details.status, 200);
  assert.equal(details.data.run.taskName, context.task.name);
  assert.equal(details.data.run.task.deleted, true);
  assert.equal(download.status, 200);
  assert.deepEqual(download.buffer, history.content);
  context.db.close();
});

test("the task page exposes deleted filtering and restore without executable deleted actions", async () => {
  const html = await fs.readFile(path.resolve("public/index.html"), "utf8");
  const app = await fs.readFile(path.resolve("public/app.js"), "utf8");
  assert.match(html, /id="scheduledIncludeDeleted"/);
  assert.match(app, /include_deleted=true/);
  assert.match(app, /data-task-action="restore"/);
  assert.match(app, /task\.deleted \? `\s*<button[^`]+历史记录与文件[^`]+恢复/s);
  assert.match(app, /!run\.taskDeleted/);
});
