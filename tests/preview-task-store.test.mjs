import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PreviewTaskStore } from "../fulfillment-service/preview-task-store.mjs";

test("相同运行中预览请求复用任务且完成结果可持久化恢复", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "preview-task-"));
  let resolveOperation;
  const operation = new Promise((resolve) => { resolveOperation = resolve; });
  const store = new PreviewTaskStore({ rootDir, randomUUID: () => "task-1",
    now: () => new Date("2026-08-11T14:00:00.000Z") });
  try {
    const first = store.start({ kind: "warehouse-batch-preview", input: { orderReferences: ["ORDER_B", "ORDER_A"] },
      run: async () => operation });
    const repeated = store.start({ kind: "warehouse-batch-preview", input: { orderReferences: ["ORDER_A", "ORDER_B", "ORDER_A"] },
      run: async () => { throw new Error("不得重复执行"); } });
    assert.equal(repeated.taskId, first.taskId);
    assert.ok(["QUEUED", "RUNNING"].includes(store.get(first.taskId).state));
    resolveOperation({ batchHash: "result-1" });
    await store.wait(first.taskId);
    assert.deepEqual(store.get(first.taskId).result, { batchHash: "result-1" });
    const restarted = new PreviewTaskStore({ rootDir });
    assert.deepEqual(restarted.get(first.taskId).result, { batchHash: "result-1" });
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }); }
});

test("服务重启不会重放运行中预览而是标记安全失败", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "preview-task-interrupted-"));
  const directory = path.join(rootDir, "storage", "preview-tasks");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "task-old.json"), JSON.stringify({ version: 1, taskId: "task-old",
    kind: "sku-batch-preview", fingerprint: "abc", state: "RUNNING", createdAt: "2026-08-11T13:00:00.000Z",
    startedAt: "2026-08-11T13:00:01.000Z", finishedAt: null, result: null, error: null }), "utf8");
  try {
    const store = new PreviewTaskStore({ rootDir, now: () => new Date("2026-08-11T14:00:00.000Z") });
    const task = store.get("task-old");
    assert.equal(task.state, "FAILED");
    assert.equal(task.error.code, "PREVIEW_TASK_INTERRUPTED");
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }); }
});

test("预览任务只持久化清洗后的错误", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "preview-task-error-"));
  const store = new PreviewTaskStore({ rootDir, randomUUID: () => "task-error" });
  try {
    const task = store.start({ kind: "sku-batch-preview", input: { orderReferences: ["ORDER_A"] }, run: async () => {
      throw Object.assign(new Error("失败 secret-password"), { code: "HTTP_409", diagnostic: { password: "secret-password" } });
    } });
    await store.wait(task.taskId);
    const failed = store.get(task.taskId);
    assert.equal(failed.state, "FAILED");
    assert.equal(failed.error.code, "HTTP_409");
    assert.equal(JSON.stringify(failed).includes("secret-password"), false);
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }); }
});
