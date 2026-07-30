import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { mkdtempSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SchedulerDatabase } from "../lib/mabang-scheduler/db.mjs";
import { encryptSecret } from "../lib/mabang-scheduler/crypto.mjs";
import { createTaskExecutor } from "../lib/mabang-scheduler/executor.mjs";
import { MabangSchedulerService } from "../lib/mabang-scheduler/service.mjs";
import { createOperationAuditService } from "../lib/security/audit-service.mjs";

process.env.APP_ENCRYPTION_KEY = "integration-test-key-not-for-production";

function setup({ withRobot = true, nextRunAt = "2026-07-15T00:30:00.000Z", taskType = "order_export" } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "commerce-ops-scheduler-"));
  const dbPath = path.join(root, "scheduler.sqlite");
  const db = new SchedulerDatabase({ databasePath: dbPath, migrationsDir: path.resolve("migrations") });
  db.migrate();
  const account = db.saveAccountProfile({ name: "Mock Mabang", username: "mock-user", encryptedPassword: encryptSecret("mock-password"), enabled: true });
  const robot = withRobot ? db.saveDingtalkConfig({
    name: "Mock Robot", encryptedWebhookUrl: encryptSecret("https://oapi.dingtalk.com/robot/send?access_token=mock"),
    encryptedSecret: encryptSecret("mock-secret"), enabled: true, notifyOnSuccess: true, notifyOnFailure: true, notifyOnEmpty: true,
  }) : null;
  const task = db.saveTask({
    taskType, name: taskType === "inventory_export" ? "Mock Daily Inventory" : "Mock Daily Orders", description: "integration", accountProfileId: account.id,
    dingtalkConfigId: robot?.id || null, scheduleType: "daily", scheduleConfig: { hour: 8, minute: 30 }, timezone: "Asia/Shanghai",
    paymentDateMode: taskType === "inventory_export" ? "snapshot" : "yesterday", paymentDateConfig: {},
    filters: taskType === "inventory_export" ? [] : [{ fieldId: "uq172", field: "店长", operator: "equals", values: ["兰双满"] }],
    enabled: true, fileRetentionDays: 30, notifyEnabled: Boolean(robot), catchUpEnabled: true, nextRunAt,
  });
  return { root, dbPath, exportRoot: path.join(root, "exports"), db, task };
}

function successfulWorker() {
  return async (payload) => {
    if (payload.action === "orders") return {
      ok: true,
      columns: ["订单编号", "交易编号", "店长", "店铺名", "SKU"],
      records: [{ 订单编号: "O-1", 交易编号: "T-1", 店长: "兰双满", 店铺名: "TIXX PH", SKU: "SKU-1" }],
      summary: { collectedOrders: 2, orders: 1, rows: 1, orderFilterDescription: "店长 等于 兰双满" },
    };
    if (payload.action === "write-xlsx") {
      await fs.writeFile(payload.outputPath, "mock xlsx content");
      return { ok: true, rows: payload.records.length };
    }
    throw new Error(`Unexpected worker action ${payload.action}`);
  };
}

function initializeDatabaseInChild(databasePath) {
  const databaseModule = pathToFileURL(path.resolve("lib/mabang-scheduler/db.mjs")).href;
  const migrationsDir = path.resolve("migrations");
  const source = `
    import { SchedulerDatabase } from ${JSON.stringify(databaseModule)};
    const db = new SchedulerDatabase({ databasePath: ${JSON.stringify(databasePath)}, migrationsDir: ${JSON.stringify(migrationsDir)} });
    db.migrate();
    await new Promise((resolve) => setTimeout(resolve, 100));
    db.close();
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "--eval", source], {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr || `Database child exited with ${code}`)));
  });
}

test("mock login, orders, filter, Excel and DingTalk produce success", async () => {
  const context = setup();
  const audit = createOperationAuditService({ db: context.db, env: {} });
  let notified = false;
  let persisted;
  const executor = createTaskExecutor({
    db: context.db,
    runWorker: successfulWorker(),
    exportRoot: context.exportRoot,
    retryDelays: [0, 0, 0],
    notify: async () => { notified = true; return { ok: true, status: 200, code: 0 }; },
    audit,
    persistCollectedData: async (input) => {
      persisted = input;
      assert.ok((await fs.stat(input.filename)).size > 0);
      return { status: "applied", batchId: "order-batch-1", rowCount: 1 };
    },
  });
  const run = context.db.createRun({ taskId: context.task.id, triggerType: "manual", scheduledRunAt: new Date("2026-07-14T00:30:00Z") });
  const result = await executor.executeRun(run.id);
  assert.equal(result.status, "success");
  assert.equal(result.rawOrderCount, 2);
  assert.equal(result.filteredOrderCount, 1);
  assert.equal(result.detailRowCount, 1);
  assert.equal(result.fileStatus, "available");
  assert.equal(notified, true);
  assert.equal(persisted.kind, "orders");
  assert.equal(persisted.sourceFileId, result.exportFileId);
  assert.equal(persisted.sourceAccountId, context.task.accountProfileId);
  assert.equal(persisted.sourceScope.dateFrom, result.paymentStartDate);
  assert.equal(persisted.sourceScope.dateTo, result.paymentEndDate);
  assert.equal(context.db.getRunDetails(run.id).events.some((event) => event.stage === "persist_collected_data" && event.status === "success"), true);
  assert.equal(audit.queryEvents({ action: "mabang.task.execution.success" }).total, 1);
  assert.equal(audit.queryEvents({ action: "mabang.dingtalk.notify.success" }).total, 1);
  assert.ok((await fs.stat(path.join(context.exportRoot, context.db.getExportFile(result.exportFileId).relativePath))).size > 0);
  context.db.close();
});

test("inventory task collects a snapshot, writes inventory Excel and sends inventory notification", async () => {
  const context = setup({ taskType: "inventory_export" });
  const calls = [];
  let notification;
  let persisted;
  const worker = async (payload) => {
    calls.push(payload);
    if (payload.action === "inventory") return {
      ok: true,
      kind: "inventory",
      columns: ["库存SKU", "仓库", "可用库存"],
      records: [
        { 库存SKU: "SKU-1", 仓库: "PH", 可用库存: 12 },
        { 库存SKU: "SKU-2", 仓库: "PH", 可用库存: 8 },
      ],
      summary: { rows: 2, reportedRows: 2, total: 20, totalCost: 1000, inTransitTotal: 3 },
    };
    if (payload.action === "write-xlsx") {
      assert.equal(payload.kind, "inventory");
      assert.equal(payload.metadataSheetName, "任务信息");
      await fs.writeFile(payload.outputPath, "mock inventory xlsx");
      return { ok: true, rows: payload.records.length };
    }
    throw new Error(`Unexpected worker action ${payload.action}`);
  };
  const executor = createTaskExecutor({
    db: context.db,
    runWorker: worker,
    exportRoot: context.exportRoot,
    retryDelays: [],
    notify: async (payload) => { notification = payload; return { ok: true, status: 200, code: 0 }; },
    persistCollectedData: async (input) => {
      persisted = input;
      return { status: "applied", batchId: "inventory-batch-1", rowCount: 2 };
    },
  });
  const run = context.db.createRun({ taskId: context.task.id, triggerType: "manual", scheduledRunAt: new Date("2026-07-14T00:30:00Z") });
  const result = await executor.executeRun(run.id);
  assert.equal(result.status, "success");
  assert.equal(result.taskType, "inventory_export");
  assert.equal(result.paymentStartDate, null);
  assert.equal(result.paymentEndDate, null);
  assert.equal(result.rawOrderCount, 2);
  assert.equal(result.filteredOrderCount, 2);
  assert.equal(result.detailRowCount, 2);
  assert.equal(persisted.kind, "inventory");
  assert.equal(persisted.sourceFileId, result.exportFileId);
  assert.equal(persisted.sourceScope.queryType, "scheduled_export");
  assert.ok(persisted.sourceScope.snapshotAt);
  assert.match(result.filename, /^马帮库存_/);
  assert.equal(calls.some((payload) => payload.action === "orders"), false);
  assert.equal(notification.title, "马帮库存定时导出成功");
  assert.match(notification.markdown, /库存总量：20/);
  context.db.close();
});

test("DingTalk failure produces partial_success and keeps Excel", async () => {
  const context = setup();
  const audit = createOperationAuditService({ db: context.db, env: {} });
  const executor = createTaskExecutor({ db: context.db, runWorker: successfulWorker(), exportRoot: context.exportRoot, retryDelays: [0], notify: async () => { throw new Error("钉钉通知失败：HTTP 400，错误码 310000"); }, audit });
  const run = context.db.createRun({ taskId: context.task.id, triggerType: "manual", scheduledRunAt: new Date("2026-07-14T00:31:00Z") });
  const result = await executor.executeRun(run.id);
  assert.equal(result.status, "partial_success");
  assert.equal(result.notificationStatus, "failed");
  assert.equal(result.fileStatus, "available");
  assert.equal(audit.queryEvents({ action: "mabang.dingtalk.notify.failed" }).total, 1);
  context.db.close();
});

test("login failure is recorded without infinite retry", async () => {
  const context = setup({ withRobot: false });
  const audit = createOperationAuditService({ db: context.db, env: {} });
  const executor = createTaskExecutor({ db: context.db, runWorker: async () => { throw new Error("马帮登录失败：账号或密码验证不通过"); }, exportRoot: context.exportRoot, retryDelays: [0, 0, 0], audit });
  const run = context.db.createRun({ taskId: context.task.id, triggerType: "manual", scheduledRunAt: new Date("2026-07-14T00:32:00Z") });
  const result = await executor.executeRun(run.id);
  assert.equal(result.status, "failed");
  assert.equal(result.errorStage, "mabang_login");
  assert.equal(result.retryCount, 0);
  assert.equal(audit.queryEvents({ action: "mabang.task.execution.failed" }).total, 1);
  context.db.close();
});

test("empty orders are a successful run", async () => {
  const context = setup({ withRobot: false });
  const worker = async (payload) => {
    if (payload.action === "orders") return { ok: true, columns: ["订单编号"], records: [], summary: { collectedOrders: 0, orders: 0, rows: 0 } };
    await fs.writeFile(payload.outputPath, "empty xlsx");
    return { ok: true, rows: 0 };
  };
  const executor = createTaskExecutor({ db: context.db, runWorker: worker, exportRoot: context.exportRoot, retryDelays: [] });
  const run = context.db.createRun({ taskId: context.task.id, triggerType: "manual", scheduledRunAt: new Date("2026-07-14T00:33:00Z") });
  const result = await executor.executeRun(run.id);
  assert.equal(result.status, "success");
  assert.equal(result.detailRowCount, 0);
  context.db.close();
});

test("Excel failure is recorded as generate_excel failure", async () => {
  const context = setup({ withRobot: false });
  const worker = successfulWorker();
  const executor = createTaskExecutor({
    db: context.db,
    runWorker: async (payload) => payload.action === "write-xlsx" ? Promise.reject(new Error("Excel写入失败：目标目录无写入权限")) : worker(payload),
    exportRoot: context.exportRoot,
    retryDelays: [],
  });
  const run = context.db.createRun({ taskId: context.task.id, triggerType: "manual", scheduledRunAt: new Date("2026-07-14T00:34:00Z") });
  const result = await executor.executeRun(run.id);
  assert.equal(result.status, "failed");
  assert.equal(result.errorStage, "generate_excel");
  context.db.close();
});

test("database persistence failure fails the run after retaining the generated Excel", async () => {
  const context = setup({ withRobot: false });
  const executor = createTaskExecutor({
    db: context.db,
    runWorker: successfulWorker(),
    exportRoot: context.exportRoot,
    retryDelays: [],
    persistCollectedData: async () => {
      throw new Error("database persistence failed");
    },
  });
  const run = context.db.createRun({ taskId: context.task.id, triggerType: "manual", scheduledRunAt: new Date("2026-07-14T00:34:30Z") });
  const result = await executor.executeRun(run.id);
  assert.equal(result.status, "failed");
  assert.equal(result.errorStage, "persist_collected_data");
  assert.equal(result.fileStatus, "available");
  assert.ok(result.exportFileId);
  context.db.close();
});

test("same task cannot execute concurrently", async () => {
  const context = setup({ withRobot: false });
  const first = context.db.createRun({ taskId: context.task.id, triggerType: "manual", scheduledRunAt: new Date("2026-07-14T00:35:00Z") });
  const second = context.db.createRun({ taskId: context.task.id, triggerType: "manual", scheduledRunAt: new Date("2026-07-14T00:36:00Z") });
  assert.equal(context.db.claimRun(first.id).claimed, true);
  const executor = createTaskExecutor({ db: context.db, runWorker: successfulWorker(), exportRoot: context.exportRoot, retryDelays: [] });
  const result = await executor.executeRun(second.id);
  assert.equal(result.status, "skipped");
  assert.equal(result.errorCode, "TASK_ALREADY_RUNNING");
  context.db.close();
});

test("database restart preserves tasks and recovers stale runs", () => {
  const context = setup({ withRobot: false });
  const run = context.db.createRun({ taskId: context.task.id, triggerType: "manual", scheduledRunAt: new Date("2026-07-14T00:37:00Z") });
  context.db.claimRun(run.id);
  context.db.updateRun(run.id, { startedAt: "2026-07-14T00:00:00.000Z" });
  context.db.close();
  const reopened = new SchedulerDatabase({ databasePath: context.dbPath, migrationsDir: path.resolve("migrations") });
  reopened.migrate();
  assert.equal(reopened.listTasks().length, 1);
  assert.equal(reopened.recoverStaleRuns(new Date("2026-07-14T01:00:00Z"), 30 * 60 * 1000), 1);
  assert.equal(reopened.getRun(run.id).errorCode, "PROCESS_RESTART");
  reopened.close();
});

test("concurrent web and scheduler startup share migration safely", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "commerce-ops-concurrent-start-"));
  const databasePath = path.join(root, "scheduler.sqlite");
  await Promise.all(Array.from({ length: 4 }, () => initializeDatabaseInChild(databasePath)));
  const db = new SchedulerDatabase({ databasePath, migrationsDir: path.resolve("migrations") });
  db.migrate();
  const expectedMigrations = readdirSync(path.resolve("migrations")).filter((name) => name.endsWith(".sql")).length;
  assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get().count, expectedMigrations);
  db.close();
});

test("scheduler creates and executes one due scheduled run", async () => {
  const now = new Date("2026-07-14T00:30:30Z");
  const context = setup({ withRobot: false, nextRunAt: "2026-07-14T00:30:00.000Z" });
  const executed = [];
  const executor = {
    executeRun: async (runId) => {
      executed.push(runId);
      context.db.claimRun(runId);
      return context.db.updateRun(runId, { status: "success", finishedAt: now.toISOString() });
    },
  };
  const service = new MabangSchedulerService({ db: context.db, executor, exportRoot: context.exportRoot, now: () => now, pollIntervalMs: 10000 });
  await service.tick();
  assert.equal(executed.length, 1);
  assert.equal(context.db.listRuns()[0].triggerType, "scheduled");
  assert.notEqual(context.db.getTask(context.task.id).nextRunAt, "2026-07-14T00:30:00.000Z");
  context.db.close();
});
