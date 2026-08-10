import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WarehouseTransferService } from "../fulfillment-service/warehouse-transfer.mjs";

function fixtureService() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "warehouse-transfer-"));
  const calls = [];
  const runWorker = async (payload) => {
    calls.push(payload);
    if (payload.action === "order-warehouse-inspect") return { order: {
      internalOrderId: `I_${payload.orderReference}`, platformOrderId: payload.orderReference, shopId: "88", platformId: "17", orderStatus: "2",
      items: [
        { itemId: "1", stockSku: "AA001234", title: "上衣", quantity: 2, stockWarehouseName: "旧仓", warehouseOptions: [{ value: "10", text: "旧仓" }, { value: "20", text: "目标仓" }] },
        { itemId: "2", stockSku: "BB005678", title: "裤子", quantity: 1, stockWarehouseName: "旧仓", warehouseOptions: [{ value: "10", text: "旧仓" }, { value: "20", text: "目标仓" }] },
      ],
    } };
    if (payload.action === "inventory") return { records: [
      { 仓库: "目标仓", 库存SKU编号: "AA001234", 可用库存量: 5 },
      { 仓库: "目标仓", 库存SKU编号: "BB005678", 可用库存量: 3 },
    ] };
    if (payload.action === "order-warehouse-change") return { result: { changed: true, targetWarehouse: payload.targetWarehouse } };
    throw new Error(`unexpected action ${payload.action}`);
  };
  return { rootDir, calls, service: new WarehouseTransferService({ rootDir, runWorker, credentials: () => ({ ok: true, username: "u", password: "p" }),
    hasShopAccess: (shopId) => shopId === "88", allowedWarehouses: () => ["目标仓"] }) };
}

test("换仓预览仅选择整单 SKU 库存均充足的允许仓", async () => {
  const { service, rootDir } = fixtureService();
  try {
    const plan = await service.preview({ orderReference: "ORDER_10001" });
    assert.equal(plan.targetWarehouse, "目标仓");
    assert.equal(plan.items.length, 2);
    assert.equal(plan.stock.every((item) => item.available >= item.quantity), true);
    assert.match(plan.approvalText, /确认换仓 ORDER_10001 -> 目标仓/);
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }); }
});

test("换仓计划要求精确确认且只能执行一次", async () => {
  const { service, calls, rootDir } = fixtureService();
  try {
    const plan = await service.preview({ orderReference: "ORDER_10001" });
    await assert.rejects(() => service.execute({ planHash: plan.planHash, approvalText: "确认" }), /请输入完整确认文字/);
    const completed = await service.execute({ planHash: plan.planHash, approvalText: plan.approvalText });
    assert.equal(completed.status, "COMPLETED");
    assert.equal(calls.filter((call) => call.action === "order-warehouse-change").length, 1);
    await assert.rejects(() => service.execute({ planHash: plan.planHash, approvalText: plan.approvalText }), /不存在或已经执行/);
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }); }
});

test("批量预览去重订单并整批只读取一次库存", async () => {
  const { service, calls, rootDir } = fixtureService();
  try {
    const batch = await service.previewBatch({ orderReferences: ["ORDER_10001", "ORDER_10002", "ORDER_10001"] });
    assert.equal(batch.requestedCount, 2);
    assert.equal(batch.plans.length, 2);
    assert.equal(batch.failures.length, 0);
    assert.equal(calls.filter((call) => call.action === "inventory").length, 1);
    const inventoryCall = calls.find((call) => call.action === "inventory");
    assert.equal(inventoryCall.compact, true);
    assert.deepEqual(inventoryCall.warehouseNames, ["目标仓"]);
    assert.equal(batch.approvalText, "确认批量换仓 2 单");
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }); }
});

test("批量预览会预占前序订单库存，禁止重复分配同一库存", async () => {
  const { service, rootDir } = fixtureService();
  try {
    const batch = await service.previewBatch({ orderReferences: ["ORDER_10001", "ORDER_10002", "ORDER_10003"] });
    assert.equal(batch.plans.length, 2);
    assert.equal(batch.failures.length, 1);
    assert.equal(batch.failures[0].orderReference, "ORDER_10003");
    assert.equal(batch.failures[0].code, "WAREHOUSE_NO_COMMON_STOCK");
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }); }
});

test("批量执行按选择逐单完成并汇总结果", async () => {
  const { service, calls, rootDir } = fixtureService();
  try {
    const batch = await service.previewBatch({ orderReferences: ["ORDER_10001", "ORDER_10002"] });
    const result = await service.executeBatch({ batchHash: batch.batchHash,
      planHashes: batch.plans.map((plan) => plan.planHash), approvalText: "确认批量换仓 2 单" });
    assert.deepEqual(result.summary, { completed: 2, failed: 0 });
    assert.equal(calls.filter((call) => call.action === "order-warehouse-change").length, 2);
    assert.equal(calls.filter((call) => call.action === "inventory").length, 2, "预览和执行应各读取一次库存，而不是逐单刷新");
    await assert.rejects(() => service.executeBatch({ batchHash: batch.batchHash,
      planHashes: batch.plans.map((plan) => plan.planHash), approvalText: "确认批量换仓 2 单" }), /不存在或已经执行/);
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }); }
});

test("批量执行共享最新库存账本，马帮库存延迟更新时也不会超额换仓", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "warehouse-transfer-runtime-ledger-"));
  const calls = [];
  let inventoryReads = 0;
  const runWorker = async (payload) => {
    calls.push(payload);
    if (payload.action === "order-warehouse-inspect") return { order: {
      internalOrderId: `I_${payload.orderReference}`, platformOrderId: payload.orderReference, shopId: "88", platformId: "17", orderStatus: "2",
      items: [{ itemId: "1", stockSku: "SAME_SKU", title: "同款商品", quantity: 2, stockWarehouseName: "旧仓",
        warehouseOptions: [{ value: "10", text: "旧仓" }, { value: "20", text: "目标仓" }] }],
    } };
    if (payload.action === "inventory") {
      inventoryReads += 1;
      return { records: [{ 仓库: "目标仓", 库存SKU编号: "SAME_SKU", 可用库存量: inventoryReads === 1 ? 4 : 3 }] };
    }
    if (payload.action === "order-warehouse-change") return { result: { changed: true, targetWarehouse: payload.targetWarehouse } };
    throw new Error(`unexpected action ${payload.action}`);
  };
  const service = new WarehouseTransferService({ rootDir, runWorker, credentials: () => ({ ok: true, username: "u", password: "p" }),
    hasShopAccess: (shopId) => shopId === "88", allowedWarehouses: () => ["目标仓"] });
  try {
    const batch = await service.previewBatch({ orderReferences: ["ORDER_FIRST", "ORDER_SECOND"] });
    assert.equal(batch.plans.length, 2, "预览库存 4 应允许两单进入计划");
    const result = await service.executeBatch({ batchHash: batch.batchHash,
      planHashes: [...batch.plans].reverse().map((plan) => plan.planHash), approvalText: "确认批量换仓 2 单" });
    assert.deepEqual(result.results.map((item) => [item.orderReference, item.status]), [
      ["ORDER_FIRST", "COMPLETED"],
      ["ORDER_SECOND", "FAILED"],
    ]);
    assert.equal(result.results[1].code, "WAREHOUSE_INVENTORY_CHANGED");
    assert.equal(calls.filter((call) => call.action === "order-warehouse-change").length, 1);
    assert.equal(inventoryReads, 2);
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }); }
});
