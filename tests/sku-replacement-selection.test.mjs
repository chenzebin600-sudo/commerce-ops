import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSkuReplacementSelections,
  diagnosticRows,
  executionStatusesFromTask,
  filterSkuReplacementPlans,
  replacementItemKey,
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
            colorChanged: true, specRelation: "SAME", originalColors: ["白色"], candidateColors: ["黑色"] },
          { sku: "CHAIR-WHITE-2", chineseName: "人体工学椅 白色 2层", warehouse: "深圳仓", available: 5,
            productStatus: "在售", category1: "家具", category2: "椅子", kind: "SMALLER", label: "更小规格", riskLevel: "HIGH",
            colorChanged: false, specRelation: "SMALLER", originalColors: ["白色"], candidateColors: ["白色"] },
        ],
      },
      {
        itemId: "2", originalSku: "DESK-WHITE-3", chineseName: "书桌 白色 3层", quantity: 1,
        currentWarehouse: "深圳仓", available: 0, shortage: 1, requiresBundleReview: false,
        candidates: [
          { sku: "DESK-WHITE-3B", chineseName: "书桌 白色 3层", warehouse: "深圳仓", available: 4,
            productStatus: "在售", category1: "家具", category2: "书桌", kind: "SAME", label: "完全同款", riskLevel: "LOW",
            colorChanged: false, specRelation: "SAME", originalColors: ["白色"], candidateColors: ["白色"] },
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

test("同一商品行只保留一个候选且再次点击已选候选会取消", () => {
  const key = replacementItemKey("ORDER_1", "1");
  assert.deepEqual(toggleSkuSelection({}, key, "CHAIR-BLACK-3"), { [key]: "CHAIR-BLACK-3" });
  assert.deepEqual(toggleSkuSelection({ [key]: "CHAIR-BLACK-3" }, key, "CHAIR-WHITE-2"), { [key]: "CHAIR-WHITE-2" });
  assert.deepEqual(toggleSkuSelection({ [key]: "CHAIR-BLACK-3" }, key, "CHAIR-BLACK-3"), {});
});

test("替换类型、风险和已选择状态组合筛选不会清除隐藏选择", () => {
  const firstKey = replacementItemKey("ORDER_1", "1");
  const secondKey = replacementItemKey("ORDER_1", "2");
  const selections = { [firstKey]: "CHAIR-BLACK-3", [secondKey]: "DESK-WHITE-3B" };
  const filtered = filterSkuReplacementPlans(plans, { kind: "COLOR", risk: "MEDIUM", status: "SELECTED" }, selections, {});
  assert.deepEqual(filtered.map((plan) => [plan.order.platformOrderId, plan.items.map((item) => [item.itemId, item.candidates.map((candidate) => candidate.sku)])]),
    [["ORDER_1", [["1", ["CHAIR-BLACK-3"]]]]]);
  assert.deepEqual(selections, { [firstKey]: "CHAIR-BLACK-3", [secondKey]: "DESK-WHITE-3B" });
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
    [replacementItemKey("ORDER_1", "1")]: "CHAIR-BLACK-3",
    [replacementItemKey("ORDER_1", "2")]: "MISSING-SKU",
    [replacementItemKey("REMOVED", "9")]: "STALE-SKU",
  };
  assert.deepEqual(buildSkuReplacementSelections(plans, selections), [
    { orderReference:"ORDER_1",itemId:"1",replacementSku:"CHAIR-BLACK-3" },
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
    request: { fieldNames: ["orderItemId", "stockId", "type"], orderItemId: "477372993", stockId: "2679193", type: "2" },
    response: { httpStatus: 409, contentType: "application/json", success: false, code: "FIELD_INVALID",
      message: "type 字段无效", fieldNames: ["code", "message", "success"], bodyKind: "json", bodyLength: 63 },
    verification: { beforeSku: "OLD", targetSku: "NEW", afterSku: "OLD", result: "original" },
  };
  assert.deepEqual(diagnosticRows(diagnostic), [
    { label: "阶段", value: "mabang_response" },
    { label: "HTTP", value: "409" },
    { label: "请求字段", value: "orderItemId=477372993 · stockId=2679193 · type=2" },
    { label: "业务码", value: "FIELD_INVALID" },
    { label: "马帮信息", value: "type 字段无效" },
    { label: "返回字段", value: "code · message · success" },
    { label: "回读", value: "OLD → NEW，最终 OLD（original）" },
  ]);
  assert.equal(diagnosticRows(null).length, 0);
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
