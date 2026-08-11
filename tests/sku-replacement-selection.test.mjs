import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSkuReplacementSelections,
  diagnosticRows,
  executionStatusesFromTask,
  filterSkuReplacementPlans,
  replacementItemKey,
  setSkuSelectionWarehouse,
  summarizeSkuSelections,
  taskItemFor,
  toggleSkuSelection,
} from "../frontend/commerce-ops-vue/src/services/sku-replacement-selection.ts";
import { ApiError } from "../frontend/commerce-ops-vue/src/services/api.ts";

const plans = [
  {
    order: { internalOrderId: "1", platformOrderId: "ORDER_1", shopId: "10", platformId: "17", orderStatus: "pending" },
    candidateCount: 3, replaceableItemCount: 2, unresolvedItemCount: 0,
    items: [
      {
        itemId: "1", originalSku: "CHAIR-WHITE-3", chineseName: "人体工学椅 白色 3层", quantity: 1,
        currentWarehouse: "深圳仓", available: 0, shortage: 1, requiresBundleReview: false,
        candidates: [
          { sku: "CHAIR-BLACK-3", chineseName: "人体工学椅 黑色 3层", warehouse: "深圳仓", available: 8,
            productStatus: "在售", category1: "家具", category2: "椅子", kind: "COLOR", label: "同款换色", riskLevel: "MEDIUM",
            colorChanged: true, specRelation: "SAME", originalColors: ["白色"], candidateColors: ["黑色"],
            warehouseMode: "KEEP_CURRENT", targetWarehouse: "深圳仓",
            warehouseAlternatives: [{ warehouse: "深圳仓", mode: "KEEP_CURRENT", remaining: 7 }] },
          { sku: "CHAIR-WHITE-2", chineseName: "人体工学椅 白色 2层", warehouse: "深圳仓", available: 5,
            productStatus: "在售", category1: "家具", category2: "椅子", kind: "SMALLER", label: "更小规格", riskLevel: "HIGH",
            colorChanged: false, specRelation: "SMALLER", originalColors: ["白色"], candidateColors: ["白色"],
            warehouseMode: "MOVE_WHOLE_ORDER", targetWarehouse: "允许仓B",
            warehouseAlternatives: [
              { warehouse: "允许仓B", mode: "MOVE_WHOLE_ORDER", remaining: 6 },
              { warehouse: "允许仓A", mode: "MOVE_WHOLE_ORDER", remaining: 3 },
            ] },
        ],
      },
      {
        itemId: "2", originalSku: "DESK-WHITE-3", chineseName: "书桌 白色 3层", quantity: 1,
        currentWarehouse: "深圳仓", available: 0, shortage: 1, requiresBundleReview: false,
        candidates: [
          { sku: "DESK-WHITE-3B", chineseName: "书桌 白色 3层", warehouse: "深圳仓", available: 4,
            productStatus: "在售", category1: "家具", category2: "书桌", kind: "SAME", label: "完全同款", riskLevel: "LOW",
            colorChanged: false, specRelation: "SAME", originalColors: ["白色"], candidateColors: ["白色"],
            warehouseMode: "KEEP_CURRENT", targetWarehouse: "深圳仓",
            warehouseAlternatives: [{ warehouse: "深圳仓", mode: "KEEP_CURRENT", remaining: 3 }] },
        ],
      },
    ],
  },
  {
    order: { internalOrderId: "2", platformOrderId: "ORDER_2", shopId: "10", platformId: "17", orderStatus: "pending" },
    candidateCount: 0, replaceableItemCount: 0, unresolvedItemCount: 1,
    items: [{ itemId: "3", originalSku: "SOFA-1", chineseName: "沙发", quantity: 1, currentWarehouse: "深圳仓",
      available: 0, shortage: 1, requiresBundleReview: false, candidates: [] }],
  },
];

test("选择候选采用自动仓，切换仓库保留 SKU，切换 SKU 重置自动仓", () => {
  const key = replacementItemKey("ORDER_1", "1");
  const keepCandidate = plans[0].items[0].candidates[0];
  const moveCandidate = plans[0].items[0].candidates[1];
  const selected = toggleSkuSelection({}, key, moveCandidate);
  assert.deepEqual(selected, { [key]: { sku: "CHAIR-WHITE-2", targetWarehouse: "允许仓B" } });

  const changedWarehouse = setSkuSelectionWarehouse(selected, key, "允许仓A");
  assert.deepEqual(changedWarehouse, { [key]: { sku: "CHAIR-WHITE-2", targetWarehouse: "允许仓A" } });
  assert.deepEqual(toggleSkuSelection(changedWarehouse, key, keepCandidate),
    { [key]: { sku: "CHAIR-BLACK-3", targetWarehouse: "深圳仓" } });
  assert.deepEqual(toggleSkuSelection(selected, key, moveCandidate), {});
});

test("替换类型、风险和已选择状态组合筛选不会清除隐藏选择", () => {
  const firstKey = replacementItemKey("ORDER_1", "1");
  const secondKey = replacementItemKey("ORDER_1", "2");
  const selections = {
    [firstKey]: { sku: "CHAIR-BLACK-3", targetWarehouse: "深圳仓" },
    [secondKey]: { sku: "DESK-WHITE-3B", targetWarehouse: "深圳仓" },
  };
  const filtered = filterSkuReplacementPlans(plans, { kind: "COLOR", risk: "MEDIUM", status: "SELECTED" }, selections, {});
  assert.deepEqual(filtered.map((plan) => [plan.order.platformOrderId, plan.items.map((item) => [item.itemId, item.candidates.map((candidate) => candidate.sku)])]),
    [["ORDER_1", [["1", ["CHAIR-BLACK-3"]]]]]);
  assert.deepEqual(selections, {
    [firstKey]: { sku: "CHAIR-BLACK-3", targetWarehouse: "深圳仓" },
    [secondKey]: { sku: "DESK-WHITE-3B", targetWarehouse: "深圳仓" },
  });
  assert.deepEqual(summarizeSkuSelections(plans, selections), { selectedItems: 2, selectedOrders: 1 });
});

test("无候选与执行结果状态能独立筛选", () => {
  const completedKey = replacementItemKey("ORDER_1", "2");
  const completed = filterSkuReplacementPlans(plans, { kind: "ALL", risk: "ALL", status: "COMPLETED" }, {},
    { [completedKey]: "COMPLETED" });
  assert.deepEqual(completed.map((plan) => plan.items.map((item) => item.itemId)), [["2"]]);
  const noCandidate = filterSkuReplacementPlans(plans, { kind: "ALL", risk: "ALL", status: "NO_CANDIDATE" }, {}, {});
  assert.deepEqual(noCandidate.map((plan) => [plan.order.platformOrderId, plan.items.map((item) => item.itemId)]), [["ORDER_2", ["3"]]]);
});

test("批量请求只包含仍存在于完整预览中的有效选择", () => {
  const selections = {
    [replacementItemKey("ORDER_1", "1")]: { sku: "CHAIR-WHITE-2", targetWarehouse: "允许仓A" },
    [replacementItemKey("ORDER_1", "2")]: { sku: "DESK-WHITE-3B", targetWarehouse: "任意仓" },
    [replacementItemKey("REMOVED", "9")]: { sku: "STALE-SKU", targetWarehouse: "任意仓" },
  };
  assert.deepEqual(buildSkuReplacementSelections(plans, selections), [
    { orderReference:"ORDER_1",itemId:"1",replacementSku:"CHAIR-WHITE-2",targetWarehouse:"允许仓A" },
  ]);
});

test("后台批量任务逐项状态可恢复为页面筛选状态", () => {
  assert.deepEqual(executionStatusesFromTask({ items:[
    { orderReference:"ORDER_1",itemId:"1",status:"RUNNING" },
    { orderReference:"ORDER_1",itemId:"2",status:"COMPLETED" },
    { orderReference:"ORDER_2",itemId:"3",status:"MANUAL_REVIEW" },
    { orderReference:"ORDER_3",itemId:"4",status:"PENDING" },
  ] }), {
    [replacementItemKey("ORDER_1", "1")]: "RUNNING",
    [replacementItemKey("ORDER_1", "2")]: "COMPLETED",
    [replacementItemKey("ORDER_2", "3")]: "MANUAL_REVIEW",
  });
});

test("接口诊断会转换为固定、可读且无 HTML 的字段行", () => {
  const diagnostic = {
    version: 1, capturedAt: "2026-08-11T01:02:03+00:00", stage: "mabang_response", endpoint: "order.doChanegOrderItem",
    request: { fieldNames: ["orderItemId", "stockId", "IsChangeWarehouse", "isChangeOrderItemPrice"],
      orderItemId: "477372993", stockId: "2679193", IsChangeWarehouse: "1", isChangeOrderItemPrice: "2" },
    response: { httpStatus: 409, contentType: "application/json", success: false, code: "FIELD_INVALID",
      message: "商品编号数据不存在", fieldNames: ["code", "message", "success"], bodyKind: "json", bodyLength: 63 },
    verification: { beforeSku: "OLD", targetSku: "NEW", afterSku: "OLD", result: "original" },
  };
  assert.deepEqual(diagnosticRows(diagnostic), [
    { label: "阶段", value: "mabang_response" },
    { label: "HTTP", value: "409" },
    { label: "请求字段", value: "orderItemId=477372993 · stockId=2679193 · IsChangeWarehouse=1 · isChangeOrderItemPrice=2" },
    { label: "业务码", value: "FIELD_INVALID" },
    { label: "马帮信息", value: "商品编号数据不存在" },
    { label: "返回字段", value: "code · message · success" },
    { label: "回读", value: "OLD → NEW，最终 OLD（original）" },
  ]);
  assert.equal(diagnosticRows(null).length, 0);
});

test("仓库阶段诊断会显示安全说明、尝试状态和目标与最终仓库", () => {
  const diagnostic = {
    version: 1, phase: "WAREHOUSE_EXECUTE", skuWriteConfirmed: true,
    warehousePreviewAttempted: true, warehouseWriteAttempted: true, warehouseWriteConfirmed: false,
    targetSku: "CHAIR-BLACK-3", observedSku: "CHAIR-BLACK-3", targetWarehouse: "深圳仓",
    finalWarehouses: ["自动跳仓"], message: "换仓写入结果无法确认",
    cause: { code: "WAREHOUSE_VERIFY_FAILED" },
  };

  assert.deepEqual(diagnosticRows(diagnostic), [
    { label: "阶段", value: "WAREHOUSE_EXECUTE" },
    { label: "说明", value: "换仓写入结果无法确认" },
    { label: "SKU", value: "CHAIR-BLACK-3 → CHAIR-BLACK-3" },
    { label: "目标仓", value: "深圳仓" },
    { label: "最终仓", value: "自动跳仓" },
    { label: "操作状态", value: "SKU 已确认 · 已尝试预览 · 已尝试写仓 · 写仓未确认" },
    { label: "原因码", value: "WAREHOUSE_VERIFY_FAILED" },
  ]);
});

test("按订单和商品行精确定位批量任务结果", () => {
  const expected = { orderReference: "ORDER_1", itemId: "2", status: "FAILED" };
  const task = { items: [
    { orderReference: "ORDER_1", itemId: "1", status: "COMPLETED" },
    expected,
    { orderReference: "ORDER_2", itemId: "2", status: "MANUAL_REVIEW" },
  ] };
  assert.equal(taskItemFor("ORDER_1", "2", task), expected);
  assert.equal(taskItemFor("ORDER_1", "9", task), null);
});

test("ApiError 保留服务端业务码和详情", () => {
  const details = { diagnostic: { version: 1 } };
  const error = new ApiError("马帮拒绝", 409, "SKU_REPLACEMENT_REJECTED", details);
  assert.equal(error.code, "SKU_REPLACEMENT_REJECTED");
  assert.equal(error.details, details);
});
