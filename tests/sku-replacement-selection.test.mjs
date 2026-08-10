import test from "node:test";
import assert from "node:assert/strict";
import {
  filterSkuReplacementPlans,
  replacementItemKey,
  summarizeSkuSelections,
  toggleSkuSelection,
} from "../frontend/commerce-ops-vue/src/services/sku-replacement-selection.ts";

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
