import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, root), "utf8");

test("Shopee Discount typed client exposes only fixed first-party routes", () => {
  const source = read("frontend/commerce-ops-vue/src/services/shopee-discount.ts");
  assert.match(source, /const BASE = "\/api\/shopee-discount"/);
  for (const route of ["/status", "/shops", "/previews", "/runs", "/activities", "/issues", "/scans"]) {
    assert.ok(source.includes(route), `missing fixed route ${route}`);
  }
  for (const operation of ["loadDiscountStatus", "loadDiscountShops", "createDiscountPreview", "loadDiscountPreviewItems", "approveDiscountPreview", "executeDiscountPreview", "loadDiscountRuns", "loadDiscountActivities", "loadDiscountIssues", "requestDiscountScan"]) {
    assert.match(source, new RegExp(`export function ${operation}\\(`), `missing ${operation}`);
  }
  assert.doesNotMatch(source, /apiPath|accessToken|refreshToken|partnerKey|secret|credential/i);
});

test("Shopee Discount page is registered in the existing router and execution sidebar", () => {
  const router = read("frontend/commerce-ops-vue/src/router/index.ts");
  const sidebar = read("frontend/commerce-ops-vue/src/components/OpsSidebar.vue");
  assert.match(router, /path: "\/shopee-discount"/);
  assert.match(router, /ShopeeDiscountPage\.vue/);
  assert.match(sidebar, /path: "\/shopee-discount", label: "折扣控价"/);
});

test("operations page carries accessible scope, preview, approval and coordination controls", () => {
  const page = read("frontend/commerce-ops-vue/src/pages/ShopeeDiscountPage.vue");
  for (const label of [
    "选择国家", "选择价格档位", "选择工作流", "选择店铺", "默认覆盖全部在售商品",
    "批量导入链接覆盖", "生成价格预览", "预览明细", "价格来源", "匹配规则", "冲突原因",
    "运营确认人", "输入完整确认语句", "确认价格方案", "提交人工确认后的执行任务",
    "执行进度", "异常与 UNKNOWN 协调", "续期提醒", "立即检查",
  ]) assert.ok(page.includes(label), `missing accessible/visible contract: ${label}`);
  assert.match(page, /:disabled="!canApprove"/);
  assert.match(page, /:disabled="!canExecute"/);
  assert.match(page, /useDefaultShops/);
  assert.match(page, /linkOverrides/);
  assert.match(page, /nextCursor/);
  assert.match(page, /aria-live="polite"/);
  assert.match(page, /role="alert"/);
  assert.match(page, /@media \(max-width:/);
});
