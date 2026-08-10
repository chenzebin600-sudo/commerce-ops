import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WarehouseTransferBatchService } from "../fulfillment-service/warehouse-transfer-batch.mjs";
import { WarehouseTransferService } from "../fulfillment-service/warehouse-transfer.mjs";

function createFixture({
  anomalyReasons = [],
  warehouseOptions = [
    { value: "10", text: "旧仓", available: 10 },
    { value: "20", text: "目标仓", available: 10 },
  ],
  inventoryRecords = [{ warehouse: "目标仓", sku: "SKU_1001", available: 10 }],
  allowedWarehouses = ["目标仓"],
  writeEnabled = false,
  changeError = null,
} = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "warehouse-transfer-"));
  const calls = [];
  const runWorker = async (payload) => {
    calls.push(payload);
    if (payload.action === "order-warehouse-inspect") {
      return { order: {
        internalOrderId: "INTERNAL_1",
        platformOrderId: payload.orderReference,
        shopId: "88",
        platformId: "17",
        orderStatus: "2",
        anomalyReasons,
        items: [{
          itemId: "1",
          stockSku: "SKU_1001",
          title: "测试商品",
          quantity: 1,
          stockWarehouseName: "旧仓",
          warehouseOptions,
        }],
      } };
    }
    if (payload.action === "inventory") {
      return { records: inventoryRecords };
    }
    if (payload.action === "order-warehouse-change") {
      if (typeof changeError === "function") {
        const error = changeError(payload);
        if (error) throw error;
      } else if (changeError) throw changeError;
      return { result: { changed: true, targetWarehouse: payload.targetWarehouse } };
    }
    throw new Error(`unexpected action ${payload.action}`);
  };
  const service = new WarehouseTransferService({
    rootDir,
    runWorker,
    credentials: () => ({ ok: true, username: "user", password: "secret" }),
    hasShopAccess: (shopId) => shopId === "88",
    allowedWarehouses: () => allowedWarehouses,
    writeEnabled,
  });
  return { rootDir, calls, service };
}

test("普通可编辑订单不能生成换仓计划", async () => {
  const { rootDir, service } = createFixture();
  try {
    await assert.rejects(
      () => service.preview({ orderReference: "ORDER_10001" }),
      (error) => error?.code === "WAREHOUSE_ORDER_NOT_ANOMALOUS",
    );
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("真实换仓要求独立开关、精确确认且同一计划只能执行一次", async () => {
  const disabled = createFixture({ anomalyReasons: ["out_of_stock"] });
  try {
    const plan = await disabled.service.preview({ orderReference: "ORDER_10001" });
    await assert.rejects(
      () => disabled.service.execute({ planHash: plan.planHash, approvalText: plan.approvalText }),
      (error) => error?.code === "WAREHOUSE_TRANSFER_DISABLED",
    );
    assert.equal(disabled.calls.some((call) => call.action === "order-warehouse-change"), false);
  } finally {
    fs.rmSync(disabled.rootDir, { recursive: true, force: true });
  }

  const enabled = createFixture({ anomalyReasons: ["out_of_stock"], writeEnabled: true });
  try {
    const plan = await enabled.service.preview({ orderReference: "ORDER_10002" });
    await assert.rejects(
      () => enabled.service.execute({ planHash: plan.planHash, approvalText: "确认" }),
      (error) => error?.code === "WAREHOUSE_APPROVAL_INVALID",
    );
    const completed = await enabled.service.execute({ planHash: plan.planHash, approvalText: plan.approvalText });
    assert.equal(completed.status, "COMPLETED");
    assert.equal(enabled.calls.filter((call) => call.action === "order-warehouse-change").length, 1);
    await assert.rejects(
      () => enabled.service.execute({ planHash: plan.planHash, approvalText: plan.approvalText }),
      (error) => error?.code === "WAREHOUSE_PLAN_NOT_FOUND",
    );
  } finally {
    fs.rmSync(enabled.rootDir, { recursive: true, force: true });
  }
});

test("系统自动选择执行后剩余库存最多的共同允许仓", async () => {
  const { rootDir, service, calls } = createFixture({
    anomalyReasons: ["out_of_stock"],
    warehouseOptions: [
      { value: "10", text: "旧仓", available: 0 },
      { value: "20", text: "仓库A", available: 4 },
      { value: "30", text: "仓库B", available: 9 },
    ],
    inventoryRecords: [
      { warehouse: "仓库A", sku: "SKU_1001", available: 4 },
      { warehouse: "仓库B", sku: "SKU_1001", available: 9 },
    ],
    allowedWarehouses: ["仓库A", "仓库B"],
  });
  try {
    const plan = await service.preview({ orderReference: "ORDER_10001" });
    assert.equal(plan.targetWarehouse, "仓库B");
    assert.deepEqual(plan.stock, [{ sku: "SKU_1001", quantity: 1, available: 9 }]);
    assert.equal(plan.approvalText, "确认换仓 ORDER_10001 -> 仓库B");
    assert.deepEqual(calls.find((call) => call.action === "inventory")?.warehouseNames, ["仓库A", "仓库B"]);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("批量计划会占用库存且不会把同一份库存分配给两个订单", async () => {
  const { rootDir, service } = createFixture({
    anomalyReasons: ["out_of_stock"],
    inventoryRecords: [{ warehouse: "目标仓", sku: "SKU_1001", available: 1 }],
  });
  const batchService = new WarehouseTransferBatchService({ rootDir,warehouseTransferService:service });
  try {
    const plan = await batchService.createPlan({ orderReferences:["ORDER_FIRST","ORDER_SECOND"] });
    assert.deepEqual(plan.items.map((item) => item.orderReference), ["ORDER_FIRST"]);
    assert.equal(plan.failures[0]?.orderReference, "ORDER_SECOND");
    assert.equal(plan.failures[0]?.code, "WAREHOUSE_NO_COMMON_STOCK");
  } finally {
    fs.rmSync(rootDir, { recursive:true,force:true });
  }
});

test("持久批次逐单执行且单单失败不会阻断后续订单", async () => {
  const rejected = Object.assign(new Error("马帮拒绝换仓"), { code: "WAREHOUSE_CHANGE_REJECTED" });
  const { rootDir, service, calls } = createFixture({
    anomalyReasons: ["multi_warehouse"],
    writeEnabled: true,
    changeError: (payload) => payload.orderReference === "ORDER_FAIL" ? rejected : null,
  });
  const batchService = new WarehouseTransferBatchService({
    rootDir,
    warehouseTransferService: service,
    randomUUID: () => "warehouse-task-1",
  });
  try {
    const plan = await batchService.createPlan({ orderReferences: ["ORDER_FAIL", "ORDER_OK"] });
    assert.equal(plan.approvalText, "确认批量换仓 2 单");
    const queued = batchService.createExecution({ batchHash: plan.batchHash, approvalText: plan.approvalText });
    assert.equal(queued.status, "QUEUED");
    const completed = await batchService.runExecution(queued.taskId);
    assert.equal(completed.status, "COMPLETED_WITH_FAILURES");
    assert.deepEqual(completed.items.map((item) => [item.orderReference, item.status]), [
      ["ORDER_FAIL", "FAILED"],
      ["ORDER_OK", "COMPLETED"],
    ]);
    assert.deepEqual(
      calls.filter((call) => call.action === "order-warehouse-change").map((call) => call.orderReference),
      ["ORDER_FAIL", "ORDER_OK"],
    );
    assert.deepEqual(batchService.getExecution(queued.taskId).summary, {
      total: 2,
      processed: 2,
      completed: 1,
      failed: 1,
      manualReview: 0,
      notExecuted: 0,
      prevalidationFailed: 0,
    });
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("服务重启后写入中的订单转人工核对且未开始订单不自动重放", async () => {
  const { rootDir, service, calls } = createFixture({
    anomalyReasons: ["pending_review"],
    writeEnabled: true,
  });
  const first = new WarehouseTransferBatchService({
    rootDir,
    warehouseTransferService: service,
    randomUUID: () => "warehouse-task-restart",
  });
  try {
    const plan = await first.createPlan({ orderReferences: ["ORDER_RUNNING", "ORDER_PENDING"] });
    const queued = first.createExecution({ batchHash: plan.batchHash, approvalText: plan.approvalText });
    const taskPath = path.join(rootDir, "storage", "warehouse-transfers", "batch-executions", `${queued.taskId}.json`);
    const interrupted = JSON.parse(fs.readFileSync(taskPath, "utf8"));
    interrupted.status = "RUNNING";
    interrupted.currentItem = 0;
    interrupted.items[0].status = "RUNNING";
    interrupted.items[1].status = "PENDING";
    fs.writeFileSync(taskPath, `${JSON.stringify(interrupted, null, 2)}\n`, "utf8");

    const restarted = new WarehouseTransferBatchService({ rootDir, warehouseTransferService: service });
    const recovered = restarted.reconcileInterruptedExecutions();
    assert.equal(recovered.length, 1);
    assert.deepEqual(recovered[0].items.map((item) => [item.status, item.code]), [
      ["MANUAL_REVIEW", "WAREHOUSE_EXECUTION_INTERRUPTED"],
      ["NOT_EXECUTED", "WAREHOUSE_NOT_EXECUTED"],
    ]);
    assert.equal(calls.some((call) => call.action === "order-warehouse-change"), false);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
