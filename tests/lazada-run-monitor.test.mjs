import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLazadaRunStatusWriter, readLazadaRunStatus } from "../lib/inventory-sync/lazada-run-monitor.mjs";

test("structured Lazada monitor exposes live stage and failure details", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "lazada-monitor-"));
  const storageRoot = path.join(rootDir, "storage");
  const writer = createLazadaRunStatusWriter({ storageRoot, pid: process.pid, heartbeatMs: 60_000 });
  writer.update({ stage: "READING_LISTINGS", message: "在线商品 500/1200", counts: { listingsFetched: 500, listingsTotal: 1200 } });
  let status = readLazadaRunStatus({ rootDir, storageRoot });
  assert.equal(status.state, "RUNNING");
  assert.equal(status.stageLabel, "读取 Lazada 在线商品");
  assert.equal(status.counts.listingsFetched, 500);

  writer.fail(Object.assign(new Error("仓库映射失败"), { code: "WAREHOUSE_NOT_FOUND", details: [{ shop: "店铺A" }] }));
  status = readLazadaRunStatus({ rootDir, storageRoot });
  assert.equal(status.state, "FAILED");
  assert.equal(status.problem.code, "WAREHOUSE_NOT_FOUND");
  assert.deepEqual(status.problem.details, [{ shop: "店铺A" }]);
});

test("legacy monitor infers current inventory-reading stage from existing logs", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "lazada-monitor-legacy-"));
  const storageRoot = path.join(rootDir, "storage");
  const stdoutPath = path.join(rootDir, ".lazada-inventory-sync.execute.out.log");
  const stderrPath = path.join(rootDir, ".lazada-inventory-sync.execute.err.log");
  fs.writeFileSync(stdoutPath, "正在读取 79 家 Lazada 店铺和 42 个来源仓库。\n");
  fs.writeFileSync(stderrPath, "");
  fs.writeFileSync(path.join(rootDir, ".lazada-inventory-sync.execute.pid.json"), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), stdoutPath, stderrPath }));
  const status = readLazadaRunStatus({ rootDir, storageRoot });
  assert.equal(status.state, "RUNNING");
  assert.equal(status.stage, "READING_SOURCE_INVENTORY");
  assert.match(status.message, /79 家 Lazada/);
});

test("legacy monitor preserves a successful result after the process exits", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "lazada-monitor-success-"));
  const storageRoot = path.join(rootDir, "storage");
  const stdoutPath = path.join(rootDir, ".lazada-inventory-sync.execute.out.log");
  const stderrPath = path.join(rootDir, ".lazada-inventory-sync.execute.err.log");
  fs.writeFileSync(stdoutPath, "Lazada 库存同步完成，共 3 批。\n");
  fs.writeFileSync(stderrPath, "");
  fs.writeFileSync(path.join(rootDir, ".lazada-inventory-sync.execute.pid.json"), JSON.stringify({ pid: 999999, startedAt: new Date().toISOString(), stdoutPath, stderrPath }));
  const status = readLazadaRunStatus({ rootDir, storageRoot });
  assert.equal(status.state, "SUCCEEDED");
  assert.equal(status.problem, null);
});

test("legacy monitor surfaces an all-products-failed execution report", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "lazada-monitor-report-failure-"));
  const storageRoot = path.join(rootDir, "storage");
  const reportDir = path.join(storageRoot, "inventory-sync", "lazada-reports");
  fs.mkdirSync(reportDir, { recursive: true });
  const stdoutPath = path.join(rootDir, ".lazada-inventory-sync.execute.out.log");
  const stderrPath = path.join(rootDir, ".lazada-inventory-sync.execute.err.log");
  fs.writeFileSync(stdoutPath, "Lazada 库存同步完成，共 undefined 批。\n");
  fs.writeFileSync(stderrPath, "");
  fs.writeFileSync(path.join(rootDir, ".lazada-inventory-sync.execute.pid.json"), JSON.stringify({ pid: 999998, startedAt: new Date().toISOString(), stdoutPath, stderrPath }));
  fs.writeFileSync(path.join(reportDir, "run.json"), JSON.stringify({
    plan: { summary: { shopCount: 79, listingCount: 8537, variantCount: 58211, readyCount: 22151, blockedCount: 33588 } },
    execution: { plannedBatchCount: 48, successfulProducts: 0, failedProducts: 4293, failureCount: 4293, failures: [{ message: "fetch failed", shopName: "店铺A" }] },
  }));
  const status = readLazadaRunStatus({ rootDir, storageRoot });
  assert.equal(status.state, "FAILED");
  assert.equal(status.problem.code, "ALL_PRODUCTS_FAILED");
  assert.match(status.problem.message, /4293.*fetch failed/);
  assert.equal(status.counts.batchCount, 48);
  assert.equal(status.reportPath, path.join(reportDir, "run.json"));
});
