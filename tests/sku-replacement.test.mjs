import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { aggregateReplacementInventory, findSkuReplacementCandidates, SkuReplacementService } from "../fulfillment-service/sku-replacement.mjs";
import { SkuReplacementBatchService } from "../fulfillment-service/sku-replacement-batch.mjs";

const rows = aggregateReplacementInventory([
  { 仓库: "深圳仓", 库存SKU编号: "CHAIR-WHITE-3", 中文名称: "人体工学椅 白色 3层", 一级目录: "家具", 可用库存量: 0 },
  { 仓库: "深圳仓", 库存SKU编号: "CHAIR-BLACK-3", 中文名称: "人体工学椅 黑色 3层", 一级目录: "家具", 可用库存量: 8 },
  { 仓库: "深圳仓", 库存SKU编号: "CHAIR-WHITE-2", 中文名称: "人体工学椅 白色 2层", 一级目录: "家具", 可用库存量: 5 },
  { 仓库: "深圳仓", 库存SKU编号: "CHAIR-WHITE-4", 中文名称: "人体工学椅 白色 4层", 一级目录: "家具", 可用库存量: 10 },
  { 仓库: "广州仓", 库存SKU编号: "CHAIR-BLACK-3", 中文名称: "人体工学椅 黑色 3层", 一级目录: "家具", 可用库存量: 20 },
  { 仓库: "深圳仓", 库存SKU编号: "TABLE-WHITE-3", 中文名称: "书桌 白色 3层", 一级目录: "家具", 可用库存量: 10 },
]);

const fixtureDiagnostic = {
  version: 1, capturedAt: "2026-08-11T01:02:03+00:00", stage: "mabang_response", endpoint: "order.doChanegOrderItem",
  request: { fieldNames: ["orderItemId", "stockId", "type"], orderItemId: "123", stockId: "2679193", type: "2" },
  response: { httpStatus: 409, contentType: "application/json", success: false, code: "FIELD_INVALID",
    message: "type 字段无效", fieldNames: ["code", "message", "success"], bodyKind: "json", bodyLength: 63 },
  verification: { beforeSku: "CHAIR-WHITE-3", targetSku: "CHAIR-BLACK-3", afterSku: "CHAIR-WHITE-3", result: "original" },
};

function warehouseRouteFixture({ allowedWarehouses = ["允许仓A", "允许仓B"], currentOriginalAvailable = 0,
  remoteOriginalAvailable = 0 } = {}) {
  const order = { internalOrderId: "99", platformOrderId: "ORDER_ROUTE_10001", shopId: "10", platformId: "17", orderStatus: "pending",
    trackNumber: "", items: [
      { itemId: "123", stockSku: "CHAIR-WHITE-3", title: "人体工学椅 白色 3层", quantity: 2,
        stockWarehouseName: "当前仓", warehouseOptions: [{ text: "允许仓A" }, { text: "允许仓B" }], isCombo: false },
      { itemId: "456", stockSku: "TABLE-BASIC", title: "书桌", quantity: 1,
        stockWarehouseName: "当前仓", warehouseOptions: [{ text: "允许仓A" }, { text: "允许仓B" }], isCombo: false },
    ] };
  const inventoryRecords = [
    ...(currentOriginalAvailable == null ? [] : [
      { 仓库: "当前仓", 库存SKU编号: "CHAIR-WHITE-3", 中文名称: "人体工学椅 白色 3层", 一级目录: "家具", 可用库存量: currentOriginalAvailable },
    ]),
    { 仓库: "当前仓", 库存SKU编号: "CHAIR-BLACK-3", 中文名称: "人体工学椅 黑色 3层", 一级目录: "家具", 可用库存量: 8 },
    { 仓库: "当前仓", 库存SKU编号: "TABLE-BASIC", 中文名称: "书桌", 一级目录: "家具", 可用库存量: 5 },
    ...(remoteOriginalAvailable ? [
      { 仓库: "允许仓A", 库存SKU编号: "CHAIR-WHITE-3", 中文名称: "人体工学椅 白色 3层", 一级目录: "家具", 可用库存量: remoteOriginalAvailable },
    ] : []),
    { 仓库: "允许仓A", 库存SKU编号: "CHAIR-WHITE-2", 中文名称: "人体工学椅 白色 2层", 一级目录: "家具", 可用库存量: 4 },
    { 仓库: "允许仓A", 库存SKU编号: "TABLE-BASIC", 中文名称: "书桌", 一级目录: "家具", 可用库存量: 2 },
    { 仓库: "允许仓B", 库存SKU编号: "CHAIR-WHITE-2", 中文名称: "人体工学椅 白色 2层", 一级目录: "家具", 可用库存量: 9 },
    { 仓库: "允许仓B", 库存SKU编号: "TABLE-BASIC", 中文名称: "书桌", 一级目录: "家具", 可用库存量: 4 },
  ];
  const calls = [];
  const service = new SkuReplacementService({ rootDir: mkdtempSync(path.join(tmpdir(), "sku-replacement-routing-")),
    credentials: () => ({ ok: true, username: "u", password: "p" }), hasShopAccess: () => true,
    allowedWarehouses: () => allowedWarehouses, now: () => new Date("2026-08-11T04:00:00.000Z"),
    runWorker: async (payload) => {
      calls.push(payload);
      if (payload.action === "order-warehouse-inspect-batch") return { orders: payload.orderReferences.map((orderReference) => ({ orderReference, order })), failures: [] };
      if (payload.action === "order-warehouse-inspect") return { order };
      if (payload.action === "inventory") return { records: inventoryRecords };
      if (payload.action === "order-sku-resolve") return { result: { stockId: `stock-${payload.replacementSku}`, stockSku: payload.replacementSku } };
      throw new Error(`unexpected ${payload.action}`);
    } });
  return { service, calls };
}

test("仅推荐同仓同款的换色或更小规格 SKU", () => {
  const candidates = findSkuReplacementCandidates({ originalSku: "CHAIR-WHITE-3", originalName: "人体工学椅 白色 3层",
    warehouse: "深圳仓", quantity: 2, inventory: rows });
  assert.deepEqual(candidates.map((item) => [item.sku, item.kind]), [
    ["CHAIR-BLACK-3", "COLOR"], ["CHAIR-WHITE-2", "SMALLER"],
  ]);
  assert.ok(!candidates.some((item) => item.sku === "CHAIR-WHITE-4"), "更大规格不能替换");
  assert.ok(!candidates.some((item) => item.sku === "TABLE-WHITE-3"), "不同产品不能替换");
});

test("批量建议只拉取一次涉及仓库的完整库存", async () => {
  const calls = [];
  const rootDir = mkdtempSync(path.join(tmpdir(), "sku-replacement-batch-"));
  const service = new SkuReplacementService({ rootDir, credentials: () => ({ ok: true, username: "u", password: "p" }),
    hasShopAccess: () => true, now: () => new Date("2026-08-10T04:00:00.000Z"),
    runWorker: async (payload) => {
      calls.push(payload);
      if (payload.action === "inventory") return { records: rows.map((row) => ({ 仓库: row.warehouse, 库存SKU编号: row.sku,
        中文名称: row.name, 一级目录: row.category1, 可用库存量: row.available })) };
      if (payload.action === "order-warehouse-inspect-batch") return { orders: payload.orderReferences.map((orderReference) => ({ orderReference,
        order: { internalOrderId: `internal-${orderReference}`, platformOrderId: orderReference, shopId: "10", platformId: "17",
          orderStatus: "pending", items: [{ itemId: "1", stockSku: "CHAIR-WHITE-3", title: "人体工学椅 白色 3层", quantity: 2,
            stockWarehouseName: "深圳仓", warehouseOptions: [] }] } })), failures: [] };
      throw new Error(`unexpected ${payload.action}`);
    } });
  const result = await service.previewBatch({ orderReferences: ["ORDER_10001", "ORDER_10002", "ORDER_10001"] });
  assert.equal(calls.filter((call) => call.action === "inventory").length, 1);
  assert.equal(calls.filter((call) => call.action === "order-warehouse-inspect-batch").length, 1);
  assert.equal(result.requestedCount, 2);
  assert.equal(result.summary.ordersWithCandidates, 2);
  assert.equal(result.plans[0].items[0].candidates[0].sku, "CHAIR-BLACK-3");
  assert.equal(result.executionAvailable, true);
  assert.deepEqual(service.recoverBatch({ orderReferences: ["ORDER_10002", "ORDER_10001"] }).plans.map((plan) => plan.order.platformOrderId),
    ["ORDER_10001", "ORDER_10002"]);
});

test("替换预览优先保留当前仓并只从店铺白名单提供整单换仓路线", async () => {
  const { service, calls } = warehouseRouteFixture();
  const result = await service.previewBatch({ orderReferences: ["ORDER_ROUTE_10001"] });
  const candidates = result.plans[0].items[0].candidates;
  const previewCandidate = candidates.find((candidate) => candidate.sku === "CHAIR-BLACK-3");
  const moveCandidate = candidates.find((candidate) => candidate.sku === "CHAIR-WHITE-2");

  assert.equal(previewCandidate.warehouseMode, "KEEP_CURRENT");
  assert.equal(previewCandidate.targetWarehouse, "当前仓");
  assert.equal(moveCandidate.targetWarehouse, "允许仓B");
  assert.deepEqual(moveCandidate.warehouseAlternatives.map((item) => item.warehouse), ["允许仓B", "允许仓A"]);
  assert.deepEqual(calls.find((call) => call.action === "inventory").warehouseNames, ["当前仓", "允许仓A", "允许仓B"]);
});

test("空店铺仓库白名单允许保留当前仓但不会产生整单换仓候选", async () => {
  const { service } = warehouseRouteFixture({ allowedWarehouses: [] });
  const result = await service.previewBatch({ orderReferences: ["ORDER_ROUTE_10001"] });
  const candidates = result.plans[0].items[0].candidates;

  assert.equal(candidates.find((candidate) => candidate.sku === "CHAIR-BLACK-3").warehouseMode, "KEEP_CURRENT");
  assert.equal(candidates.some((candidate) => candidate.warehouseMode === "MOVE_WHOLE_ORDER"), false);
  assert.equal(candidates.some((candidate) => candidate.sku === "CHAIR-WHITE-2"), false);
});

test("允许仓中的原 SKU 库存不能掩盖当前仓缺货", async () => {
  const { service } = warehouseRouteFixture({ currentOriginalAvailable: null, remoteOriginalAvailable: 50 });
  const preview = await service.previewBatch({ orderReferences: ["ORDER_ROUTE_10001"] });
  const item = preview.plans[0].items[0];

  assert.equal(item.available, 0);
  assert.equal(item.shortage, 2);
  assert.equal(item.candidates.some((candidate) => candidate.sku === "CHAIR-WHITE-2"), true);
  const plan = await service.createPlan({ orderReference: "ORDER_ROUTE_10001", itemId: "123",
    replacementSku: "CHAIR-WHITE-2", targetWarehouse: "允许仓A" });
  assert.equal(plan.item.available, 0);
  assert.equal(plan.targetWarehouse, "允许仓A");
});

test("库存不足的候选不会进入建议", () => {
  const candidates = findSkuReplacementCandidates({ originalSku: "CHAIR-WHITE-3", originalName: "人体工学椅 白色 3层",
    warehouse: "深圳仓", quantity: 9, inventory: rows });
  assert.equal(candidates.length, 0);
});

test("更换计划需精确确认、可从持久化记录恢复且只能执行一次", async () => {
  const calls = [];
  let skuChanged = false;
  const rootDir = mkdtempSync(path.join(tmpdir(), "sku-replacement-"));
  const inventoryRecords = rows.map((row) => ({ 仓库: row.warehouse, 库存SKU编号: row.sku, 中文名称: row.name,
    一级目录: row.category1, 可用库存量: row.available }));
  const order = { internalOrderId: "99", platformOrderId: "ORDER_10001", shopId: "10", platformId: "17", orderStatus: "pending",
    trackNumber: "", items: [{ itemId: "123", stockSku: "CHAIR-WHITE-3", title: "人体工学椅 白色 3层", quantity: 2,
      stockWarehouseName: "深圳仓", warehouseOptions: [], isCombo: false }] };
  const service = new SkuReplacementService({ rootDir, credentials: () => ({ ok: true, username: "u", password: "p" }),
    hasShopAccess: () => true, now: () => new Date("2026-08-10T04:00:00.000Z"), runWorker: async (payload) => {
      calls.push(payload);
      if (payload.action === "order-warehouse-inspect") return { order: skuChanged ? { ...order, items: order.items.map((item) => ({
        ...item, stockSku: item.itemId === "123" ? "CHAIR-BLACK-3" : item.stockSku,
      })) } : order };
      if (payload.action === "inventory") return { records: inventoryRecords };
      if (payload.action === "order-sku-resolve") return { result: { stockId: "2679193", stockSku: payload.replacementSku } };
      if (payload.action === "order-sku-change") { skuChanged = true; return { result: { changed: true, stockId: payload.expectedStockId } }; }
      throw new Error(`unexpected ${payload.action}`);
    } });
  const plan = await service.createPlan({ orderReference: "ORDER_10001", itemId: "123", replacementSku: "CHAIR-BLACK-3" });
  await assert.rejects(service.execute({ planHash: plan.planHash, approvalText: "确认" }), /请输入完整确认文字/);
  service.plans.clear();
  service.restorePlan(plan);
  const completed = await service.execute({ planHash: plan.planHash, approvalText: plan.approvalText });
  assert.equal(completed.status, "COMPLETED");
  const write = calls.find((call) => call.action === "order-sku-change");
  assert.equal(write.commit, "ORDER_SKU_CHANGE_CONFIRMED");
  assert.equal(write.expectedStockId, "2679193");
  await assert.rejects(service.execute({ planHash: plan.planHash, approvalText: plan.approvalText }), /不存在或已经执行/);
});

async function skuExecutionFixture({ replacementSku = "CHAIR-WHITE-2", targetWarehouse = "广州仓",
  afterSkuItems = null, finalItems = null, warehouseExecuteError = null } = {}) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "sku-replacement-two-phase-"));
  const originalItems = [
    { itemId: "123", stockSku: "CHAIR-WHITE-3", title: "人体工学椅 白色 3层", quantity: 2,
      stockWarehouseName: "深圳仓", warehouseOptions: [{ text: "深圳仓" }, { text: "广州仓" }], isCombo: false },
    { itemId: "456", stockSku: "TABLE-BASIC", title: "书桌", quantity: 1,
      stockWarehouseName: "深圳仓", warehouseOptions: [{ text: "深圳仓" }, { text: "广州仓" }], isCombo: false },
  ];
  const order = { internalOrderId: "99", platformOrderId: "ORDER_PHASE_10001", shopId: "10", platformId: "17",
    orderStatus: "pending", trackNumber: "", items: originalItems };
  const inventoryRecords = [
    { 仓库: "深圳仓", 库存SKU编号: "CHAIR-WHITE-3", 中文名称: "人体工学椅 白色 3层", 一级目录: "家具", 可用库存量: 0 },
    { 仓库: "深圳仓", 库存SKU编号: "CHAIR-BLACK-3", 中文名称: "人体工学椅 黑色 3层", 一级目录: "家具", 可用库存量: 8 },
    { 仓库: "深圳仓", 库存SKU编号: "TABLE-BASIC", 中文名称: "书桌", 一级目录: "家具", 可用库存量: 5 },
    { 仓库: "广州仓", 库存SKU编号: "CHAIR-WHITE-2", 中文名称: "人体工学椅 白色 2层", 一级目录: "家具", 可用库存量: 8 },
    { 仓库: "广州仓", 库存SKU编号: "CHAIR-BLACK-3", 中文名称: "人体工学椅 黑色 3层", 一级目录: "家具", 可用库存量: 8 },
    { 仓库: "广州仓", 库存SKU编号: "TABLE-BASIC", 中文名称: "书桌", 一级目录: "家具", 可用库存量: 5 },
  ];
  const actions = [];
  const warehouseCalls = [];
  let executing = false;
  let inspectionIndex = 0;
  let skuWrites = 0;
  const inspectedItems = [afterSkuItems, finalItems].filter(Boolean);
  const warehouseTransferService = {
    preview: async (payload) => {
      actions.push("warehouse-preview"); warehouseCalls.push({ method: "preview", payload });
      return { planHash: "warehouse-plan-1", approvalText: `确认换仓 ORDER_PHASE_10001 -> ${targetWarehouse}` };
    },
    execute: async (payload) => {
      actions.push("warehouse-execute"); warehouseCalls.push({ method: "execute", payload });
      if (warehouseExecuteError) throw warehouseExecuteError;
      return { status: "COMPLETED" };
    },
  };
  const service = new SkuReplacementService({ rootDir, credentials: () => ({ ok: true, username: "u", password: "p" }),
    hasShopAccess: () => true, allowedWarehouses: () => ["深圳仓", "广州仓"],
    warehouseTransferService, now: () => new Date("2026-08-11T04:00:00.000Z"), runWorker: async (payload) => {
      if (payload.action === "order-warehouse-inspect") {
        if (!executing) return { order };
        actions.push("order-warehouse-inspect");
        const items = inspectedItems[inspectionIndex++];
        if (!items) throw new Error("unexpected execution inspection");
        return { order: { ...order, items } };
      }
      if (payload.action === "inventory") return { records: inventoryRecords };
      if (payload.action === "order-sku-resolve") return { result: { stockId: `stock-${payload.replacementSku}`, stockSku: payload.replacementSku } };
      if (payload.action === "order-sku-change") {
        executing = true; skuWrites += 1; actions.push("order-sku-change");
        return { result: { changed: true, stockId: payload.expectedStockId } };
      }
      throw new Error(`unexpected ${payload.action}`);
    } });
  const plan = await service.createPlan({ orderReference: "ORDER_PHASE_10001", itemId: "123", replacementSku, targetWarehouse });
  return { service, plan, rootDir, actions, warehouseCalls, skuWrites: () => skuWrites };
}

test("SKU 写入后按计划整单换仓并独立复核最终 SKU 与仓库", async () => {
  const afterSkuItems = [
    { itemId: "123", stockSku: "CHAIR-WHITE-2", quantity: 2, stockWarehouseName: "深圳仓" },
    { itemId: "456", stockSku: "TABLE-BASIC", quantity: 1, stockWarehouseName: "深圳仓" },
  ];
  const finalItems = afterSkuItems.map((item) => ({ ...item, stockWarehouseName: "广州仓" }));
  const { service, plan, actions, warehouseCalls } = await skuExecutionFixture({ afterSkuItems, finalItems });

  const completed = await service.execute({ planHash: plan.planHash, approvalText: plan.approvalText });

  assert.deepEqual(actions, ["order-sku-change", "order-warehouse-inspect", "warehouse-preview", "warehouse-execute", "order-warehouse-inspect"]);
  assert.deepEqual(warehouseCalls, [
    { method: "preview", payload: { orderReference: "ORDER_PHASE_10001", targetWarehouse: "广州仓" } },
    { method: "execute", payload: { planHash: "warehouse-plan-1", approvalText: "确认换仓 ORDER_PHASE_10001 -> 广州仓" } },
  ]);
  assert.equal(completed.result.warehouseRouting.mode, "MOVE_WHOLE_ORDER");
  assert.equal(completed.result.warehouseRouting.targetWarehouse, "广州仓");
  assert.equal(completed.result.warehouseRouting.transferSkipped, false);
  assert.deepEqual(completed.result.warehouseRouting.finalWarehouses, ["广州仓"]);
});

test("马帮把 KEEP_CURRENT 更换自动跳仓后会整单迁回原仓", async () => {
  const afterSkuItems = [
    { itemId: "123", stockSku: "CHAIR-BLACK-3", quantity: 2, stockWarehouseName: "广州仓" },
    { itemId: "456", stockSku: "TABLE-BASIC", quantity: 1, stockWarehouseName: "广州仓" },
  ];
  const finalItems = afterSkuItems.map((item) => ({ ...item, stockWarehouseName: "深圳仓" }));
  const { service, plan, warehouseCalls } = await skuExecutionFixture({ replacementSku: "CHAIR-BLACK-3",
    targetWarehouse: "深圳仓", afterSkuItems, finalItems });

  const completed = await service.execute({ planHash: plan.planHash, approvalText: plan.approvalText });

  assert.equal(plan.warehouseMode, "KEEP_CURRENT");
  assert.deepEqual(warehouseCalls[0], { method: "preview", payload: { orderReference: "ORDER_PHASE_10001", targetWarehouse: "深圳仓" } });
  assert.equal(completed.result.warehouseRouting.targetWarehouse, "深圳仓");
  assert.equal(completed.result.warehouseRouting.transferSkipped, false);
  assert.deepEqual(completed.result.warehouseRouting.finalWarehouses, ["深圳仓"]);
});

test("SKU 写入后已经整单位于目标仓会跳过仓库写入", async () => {
  const afterSkuItems = [
    { itemId: "123", stockSku: "CHAIR-BLACK-3", quantity: 2, stockWarehouseName: "深圳仓" },
    { itemId: "456", stockSku: "TABLE-BASIC", quantity: 1, stockWarehouseName: "深圳仓" },
  ];
  const { service, plan, actions, warehouseCalls } = await skuExecutionFixture({ replacementSku: "CHAIR-BLACK-3",
    targetWarehouse: "深圳仓", afterSkuItems });

  const completed = await service.execute({ planHash: plan.planHash, approvalText: plan.approvalText });

  assert.deepEqual(actions, ["order-sku-change", "order-warehouse-inspect"]);
  assert.deepEqual(warehouseCalls, []);
  assert.equal(completed.result.warehouseRouting.transferSkipped, true);
  assert.deepEqual(completed.result.warehouseRouting.finalWarehouses, ["深圳仓"]);
});

test("已确认 SKU 后仓库写入失败会转为安全人工核对且不重试或回滚", async () => {
  const afterSkuItems = [
    { itemId: "123", stockSku: "CHAIR-WHITE-2", quantity: 2, stockWarehouseName: "深圳仓" },
    { itemId: "456", stockSku: "TABLE-BASIC", quantity: 1, stockWarehouseName: "深圳仓" },
  ];
  const failure = Object.assign(new Error("must-not-leak"), { code: "WAREHOUSE_VERIFY_FAILED",
    diagnostic: { request: { username: "must-not-leak", password: "must-not-leak" } } });
  const { service, plan, actions, rootDir, skuWrites } = await skuExecutionFixture({ afterSkuItems,
    warehouseExecuteError: failure });

  await assert.rejects(service.execute({ planHash: plan.planHash, approvalText: plan.approvalText }), (error) => {
    assert.equal(error.code, "SKU_REPLACEMENT_WAREHOUSE_VERIFY_FAILED");
    assert.equal(error.diagnostic.phase, "WAREHOUSE_EXECUTE");
    assert.equal(error.diagnostic.skuWriteConfirmed, true);
    assert.equal(JSON.stringify(error.diagnostic).includes("must-not-leak"), false);
    return true;
  });
  assert.deepEqual(actions, ["order-sku-change", "order-warehouse-inspect", "warehouse-preview", "warehouse-execute"]);
  assert.equal(skuWrites(), 1);
  const saved = JSON.parse(readFileSync(path.join(rootDir, "storage", "sku-replacements", "executions", `${plan.planHash}.json`), "utf8"));
  assert.equal(saved.status, "MANUAL_REVIEW");
  assert.equal(saved.code, "SKU_REPLACEMENT_WAREHOUSE_VERIFY_FAILED");
  assert.equal(saved.diagnostic.phase, "WAREHOUSE_EXECUTE");
});

test("最终复核出现混仓会拒绝成功并保留人工核对诊断", async () => {
  const afterSkuItems = [
    { itemId: "123", stockSku: "CHAIR-WHITE-2", quantity: 2, stockWarehouseName: "深圳仓" },
    { itemId: "456", stockSku: "TABLE-BASIC", quantity: 1, stockWarehouseName: "深圳仓" },
  ];
  const finalItems = [
    { ...afterSkuItems[0], stockWarehouseName: "广州仓" },
    { ...afterSkuItems[1], stockWarehouseName: "深圳仓" },
  ];
  const { service, plan, skuWrites } = await skuExecutionFixture({ afterSkuItems, finalItems });

  await assert.rejects(service.execute({ planHash: plan.planHash, approvalText: plan.approvalText }), (error) => {
    assert.equal(error.code, "SKU_REPLACEMENT_WAREHOUSE_VERIFY_FAILED");
    assert.equal(error.diagnostic.phase, "FINAL_VERIFY");
    assert.deepEqual(error.diagnostic.finalWarehouses, ["广州仓", "深圳仓"]);
    return true;
  });
  assert.equal(skuWrites(), 1);
});

test("更换计划绑定选定仓库、路线备选和预期商品集合", async () => {
  const { service } = warehouseRouteFixture();
  const selection = { orderReference: "ORDER_ROUTE_10001", itemId: "123", replacementSku: "CHAIR-WHITE-2" };
  const plan = await service.createPlan({ ...selection, targetWarehouse: "允许仓A" });

  assert.equal(plan.warehouseMode, "MOVE_WHOLE_ORDER");
  assert.equal(plan.targetWarehouse, "允许仓A");
  assert.deepEqual(plan.warehouseAlternatives.map((item) => item.warehouse), ["允许仓B", "允许仓A"]);
  assert.equal(plan.prospectiveItems.find((item) => item.itemId === "123").stockSku, "CHAIR-WHITE-2");
  assert.match(plan.approvalText, /确认更换SKU并整单定仓 .* -> 允许仓A$/);
  await assert.rejects(service.createPlan({ ...selection, targetWarehouse: "任意仓" }), /目标仓库不在可选范围/);

  for (const changed of [
    { warehouseMode: "KEEP_CURRENT" },
    { targetWarehouse: "允许仓B" },
    { warehouseAlternatives: plan.warehouseAlternatives.slice(1) },
    { prospectiveItems: plan.prospectiveItems.map((item, index) => index ? item : { ...item, stockSku: "TAMPERED" }) },
  ]) {
    assert.throws(() => service.restorePlan({ ...plan, ...changed }), /更换计划校验失败/);
  }
});

test("单项更换失败会持久化马帮诊断", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "sku-replacement-failed-"));
  const inventoryRecords = rows.map((row) => ({ 仓库: row.warehouse, 库存SKU编号: row.sku, 中文名称: row.name,
    一级目录: row.category1, 可用库存量: row.available }));
  const order = { internalOrderId: "99", platformOrderId: "ORDER_10001", shopId: "10", platformId: "17", orderStatus: "pending",
    trackNumber: "", items: [{ itemId: "123", stockSku: "CHAIR-WHITE-3", title: "人体工学椅 白色 3层", quantity: 2,
      stockWarehouseName: "深圳仓", warehouseOptions: [], isCombo: false }] };
  const service = new SkuReplacementService({ rootDir, credentials: () => ({ ok: true, username: "u", password: "p" }),
    hasShopAccess: () => true, now: () => new Date("2026-08-11T04:00:00.000Z"), runWorker: async (payload) => {
      if (payload.action === "order-warehouse-inspect") return { order };
      if (payload.action === "inventory") return { records: inventoryRecords };
      if (payload.action === "order-sku-resolve") return { result: { stockId: "2679193", stockSku: payload.replacementSku } };
      if (payload.action === "order-sku-change") throw Object.assign(new Error("马帮拒绝写入"), {
        code: "SKU_REPLACEMENT_REJECTED", diagnostic: fixtureDiagnostic,
      });
      throw new Error(`unexpected ${payload.action}`);
    } });
  const plan = await service.createPlan({ orderReference: "ORDER_10001", itemId: "123", replacementSku: "CHAIR-BLACK-3" });

  await assert.rejects(service.execute({ planHash: plan.planHash, approvalText: plan.approvalText }),
    (error) => error.code === "SKU_REPLACEMENT_REJECTED" && error.diagnostic.response.httpStatus === 409);
  const saved = JSON.parse(readFileSync(path.join(rootDir, "storage", "sku-replacements", "executions", `${plan.planHash}.json`), "utf8"));
  assert.equal(saved.status, "FAILED");
  assert.equal(saved.code, "SKU_REPLACEMENT_REJECTED");
  assert.equal(saved.diagnostic.request.type, "2");
});

function batchPlanRecord(selection, index) {
  return {
    version: 1, createdAt: "2026-08-10T04:00:00.000Z", expiresAt: "2026-08-10T04:10:00.000Z",
    order: { internalOrderId: String(index), platformOrderId: selection.orderReference, shopId: "10", platformId: "17", orderStatus: "pending" },
    item: { itemId: selection.itemId, originalSku: `OLD-${index}`, chineseName: `商品 ${index}`, quantity: 1, currentWarehouse: "深圳仓", available: 0 },
    replacement: { sku: selection.replacementSku, chineseName: `替换 ${index}`, warehouse: "深圳仓", available: 8,
      productStatus: "在售", category1: "家具", category2: "", kind: "COLOR", label: "同款换色", riskLevel: "MEDIUM",
      colorChanged: true, specRelation: "equal", originalColors: ["白色"], candidateColors: ["黑色"] },
    replacementStockId: `stock-${index}`, planHash: `plan-${index}`, approvalText: `confirm-plan-${index}`,
  };
}

test("批量更换计划拒绝同一商品行选择多个目标 SKU", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "sku-replacement-batch-plan-"));
  const service = new SkuReplacementBatchService({ rootDir,
    skuReplacementService: { createPlan: async (selection) => batchPlanRecord(selection, 1) },
    now: () => new Date("2026-08-10T04:00:00.000Z") });
  await assert.rejects(service.createPlan({ selections: [
    { orderReference: "ORDER_10001", itemId: "1", replacementSku: "SKU-A" },
    { orderReference: "ORDER_10001", itemId: "1", replacementSku: "SKU-B" },
  ] }), /每个商品行只能选择一个替换 SKU/);
});

test("批量更换计划保留有效项并记录逐项预验证失败", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "sku-replacement-batch-plan-"));
  let index = 0;
  const service = new SkuReplacementBatchService({ rootDir,
    skuReplacementService: { createPlan: async (selection) => {
      index += 1;
      if (selection.orderReference === "ORDER_BAD") throw Object.assign(new Error("库存已变化"), { code: "SKU_REPLACEMENT_INVENTORY_CHANGED" });
      return batchPlanRecord(selection, index);
    } }, now: () => new Date("2026-08-10T04:00:00.000Z") });
  const result = await service.createPlan({ selections: [
    { orderReference: "ORDER_10001", itemId: "1", replacementSku: "SKU-A" },
    { orderReference: "ORDER_BAD", itemId: "2", replacementSku: "SKU-B" },
  ] });
  assert.equal(result.summary.executable, 1);
  assert.equal(result.summary.failed, 1);
  assert.equal(result.approvalText, "确认批量更换SKU 1项");
  assert.equal(result.items[0].plan.order.platformOrderId, "ORDER_10001");
  assert.deepEqual(result.failures, [{ orderReference: "ORDER_BAD", itemId: "2", replacementSku: "SKU-B",
    code: "SKU_REPLACEMENT_INVENTORY_CHANGED", message: "库存已变化" }]);
});

test("批量更换计划透传目标仓库并将其绑定到批量哈希", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "sku-replacement-batch-warehouse-"));
  const received = [];
  const service = new SkuReplacementBatchService({ rootDir,
    skuReplacementService: { createPlan: async (selection) => { received.push(selection); return batchPlanRecord(selection, 1); } },
    now: () => new Date("2026-08-10T04:00:00.000Z") });
  const warehouseA = await service.createPlan({ selections: [
    { orderReference: "ORDER_10001", itemId: "1", replacementSku: "SKU-A", targetWarehouse: " 允许仓A " },
  ] });
  const warehouseB = await service.createPlan({ selections: [
    { orderReference: "ORDER_10001", itemId: "1", replacementSku: "SKU-A", targetWarehouse: "允许仓B" },
  ] });

  assert.equal(received[0].targetWarehouse, "允许仓A");
  assert.equal(warehouseA.items[0].selection.targetWarehouse, "允许仓A");
  assert.notEqual(warehouseA.batchHash, warehouseB.batchHash);
  await assert.rejects(service.createPlan({ selections: [
    { orderReference: "ORDER_10001", itemId: "1", replacementSku: "SKU-A", targetWarehouse: "允许仓\nA" },
  ] }), /批量更换中存在无效/);
});

test("批量 SKU 执行要求精确确认且同一计划只能创建一个任务", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "sku-replacement-batch-execute-"));
  let index = 0;
  const single = { createPlan: async (selection) => batchPlanRecord(selection, ++index), restorePlan() {}, execute: async () => ({ status: "COMPLETED" }) };
  const service = new SkuReplacementBatchService({ rootDir, skuReplacementService: single,
    now: () => new Date("2026-08-10T04:00:00.000Z"), randomUUID: () => "task-1" });
  const plan = await service.createPlan({ selections: [{ orderReference: "ORDER_10001", itemId: "1", replacementSku: "SKU-A" }] });
  assert.throws(() => service.createExecution({ batchHash: plan.batchHash, approvalText: "确认" }), /请输入完整确认文字/);
  const first = service.createExecution({ batchHash: plan.batchHash, approvalText: plan.approvalText });
  const repeated = service.createExecution({ batchHash: plan.batchHash, approvalText: plan.approvalText });
  assert.equal(first.taskId, "task-1");
  assert.equal(repeated.taskId, first.taskId);
  assert.equal(first.status, "QUEUED");
});

test("批量 SKU 执行拒绝内容被篡改的持久化计划", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "sku-replacement-batch-tamper-"));
  const service = new SkuReplacementBatchService({ rootDir,
    skuReplacementService: { createPlan: async (selection) => batchPlanRecord(selection, 1) },
    now: () => new Date("2026-08-10T04:00:00.000Z") });
  const plan = await service.createPlan({ selections: [{ orderReference: "ORDER_10001", itemId: "1", replacementSku: "SKU-A" }] });
  const file = path.join(rootDir, "storage", "sku-replacements", "batch-plans", `${plan.batchHash}.json`);
  const tampered = JSON.parse(readFileSync(file, "utf8"));
  tampered.items[0].selection.replacementSku = "SKU-TAMPERED";
  writeFileSync(file, JSON.stringify(tampered), "utf8");
  assert.throws(() => service.createExecution({ batchHash: plan.batchHash, approvalText: plan.approvalText }), /批量更换计划校验失败/);
});

test("批量 SKU 串行执行且单项失败后继续后续项目", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "sku-replacement-batch-run-"));
  let planIndex = 0; let activeWrites = 0; let maxConcurrentWrites = 0;
  const executionOrder = [];
  const single = {
    createPlan: async (selection) => batchPlanRecord(selection, ++planIndex),
    restorePlan() {},
    execute: async ({ planHash }) => {
      activeWrites += 1; maxConcurrentWrites = Math.max(maxConcurrentWrites, activeWrites); executionOrder.push(planHash);
      await new Promise((resolve) => setTimeout(resolve, 2));
      activeWrites -= 1;
      if (planHash === "plan-2") throw Object.assign(new Error("马帮拒绝写入"), {
        code: "SKU_REPLACEMENT_REJECTED", diagnostic: fixtureDiagnostic,
      });
      return { status: "COMPLETED", planHash };
    },
  };
  const service = new SkuReplacementBatchService({ rootDir, skuReplacementService: single,
    now: () => new Date("2026-08-10T04:00:00.000Z"), randomUUID: () => "task-run" });
  const plan = await service.createPlan({ selections: [
    { orderReference: "ORDER_10001", itemId: "1", replacementSku: "SKU-A" },
    { orderReference: "ORDER_10002", itemId: "2", replacementSku: "SKU-B" },
    { orderReference: "ORDER_10003", itemId: "3", replacementSku: "SKU-C" },
  ] });
  const task = service.createExecution({ batchHash: plan.batchHash, approvalText: plan.approvalText });
  await service.runExecution(task.taskId);
  const completed = service.getExecution(task.taskId);
  assert.deepEqual(executionOrder, ["plan-1", "plan-2", "plan-3"]);
  assert.equal(maxConcurrentWrites, 1);
  assert.deepEqual(completed.items.map((item) => item.status), ["COMPLETED", "FAILED", "COMPLETED"]);
  assert.deepEqual(completed.summary, { total: 3, processed: 3, completed: 2, failed: 1, manualReview: 0, notExecuted: 0, prevalidationFailed: 0 });
  assert.equal(completed.status, "COMPLETED_WITH_FAILURES");
  const persisted = JSON.parse(readFileSync(path.join(rootDir, "storage", "sku-replacements", "batch-executions", "task-run.json"), "utf8"));
  assert.deepEqual(persisted.items.map((item) => item.status), ["COMPLETED", "FAILED", "COMPLETED"]);
  assert.deepEqual(persisted.items[1].diagnostic, fixtureDiagnostic);
});

test("仓库复核不确定项会人工核对且批量继续后续项目", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "sku-replacement-uncertain-"));
  let writes = 0; let planIndex = 0;
  const single = {
    createPlan: async (selection) => batchPlanRecord(selection, ++planIndex),
    restorePlan() {},
    execute: async ({ planHash }) => {
      writes += 1;
      if (planHash === "plan-1") throw Object.assign(new Error("换仓结果无法确认"), { code: "SKU_REPLACEMENT_WAREHOUSE_VERIFY_FAILED" });
      return { status: "COMPLETED" };
    },
  };
  const service = new SkuReplacementBatchService({ rootDir, skuReplacementService: single,
    now: () => new Date("2026-08-11T04:00:00.000Z"), randomUUID: () => "task-uncertain" });
  const plan = await service.createPlan({ selections: [
    { orderReference: "ORDER_10001", itemId: "1", replacementSku: "SKU-A" },
    { orderReference: "ORDER_10002", itemId: "2", replacementSku: "SKU-B" },
  ] });
  const task = service.createExecution({ batchHash: plan.batchHash, approvalText: plan.approvalText });

  await service.runExecution(task.taskId);

  const completed = service.getExecution(task.taskId);
  assert.equal(writes, 2);
  assert.equal(completed.items[0].status, "MANUAL_REVIEW");
  assert.equal(completed.items[0].code, "SKU_REPLACEMENT_WAREHOUSE_VERIFY_FAILED");
  assert.equal(completed.items[1].status, "COMPLETED");
});

test("服务重启会把状态不确定项标记为人工核对且不重放待执行项", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "sku-replacement-batch-reconcile-"));
  const directory = path.join(rootDir, "storage", "sku-replacements", "batch-executions");
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "task-stale.json"), JSON.stringify({
    version: 1, taskId: "task-stale", batchHash: "batch-1", status: "RUNNING", createdAt: "2026-08-10T03:59:00.000Z",
    startedAt: "2026-08-10T04:00:00.000Z", finishedAt: null, currentItem: 1, prevalidationFailures: [],
    items: [{ status: "COMPLETED" }, { status: "RUNNING" }, { status: "PENDING" }],
    summary: { total: 3, processed: 1, completed: 1, failed: 0, manualReview: 0, notExecuted: 0, prevalidationFailed: 0 },
  }), "utf8");
  const service = new SkuReplacementBatchService({ rootDir, skuReplacementService: {},
    now: () => new Date("2026-08-10T04:05:00.000Z") });
  service.reconcileInterruptedExecutions();
  const recovered = service.getExecution("task-stale");
  assert.equal(recovered.status, "COMPLETED_WITH_FAILURES");
  assert.deepEqual(recovered.items.map((item) => item.status), ["COMPLETED", "MANUAL_REVIEW", "NOT_EXECUTED"]);
  assert.deepEqual(recovered.summary, { total: 3, processed: 3, completed: 1, failed: 0, manualReview: 1, notExecuted: 1, prevalidationFailed: 0 });
});
