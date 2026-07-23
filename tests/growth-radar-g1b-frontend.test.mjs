import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  GROWTH_RADAR_PERMISSIONS,
  GROWTH_RADAR_VIEWS,
  QUALITY_COPY,
  SEMANTIC_DEFINITIONS,
  formatCount,
  formatMetricValue,
  permissionState,
  previewGate,
  requestPlanForView,
  safeAuditText,
} from "../public/growth-radar-page.mjs";

const projectRoot = path.resolve(".");
const read = (filename) => fs.readFile(path.join(projectRoot, filename), "utf8");
const future = "2026-07-22T12:30:00.000Z";
const past = "2026-07-22T11:30:00.000Z";
const now = new Date("2026-07-22T12:00:00.000Z").getTime();

function preview(overrides = {}) {
  return {
    status: "preview_ready",
    expiresAt: future,
    issues: [],
    summary: { rawRowCount: 19, validRowCount: 17 },
    ...overrides,
  };
}

test("G1B2 frontend workflow and isolated validation contract", async (t) => {
  const [source, css, html, app, migrations, isolation] = await Promise.all([
    read("public/growth-radar-page.mjs"),
    read("public/growth-radar.css"),
    read("public/index.html"),
    read("public/app.js"),
    fs.readdir(path.join(projectRoot, "migrations")),
    read("lib/runtime-config.mjs"),
  ]);

  await t.test("01 empty counts remain an explicit dash instead of a fabricated zero", () => {
    assert.equal(formatCount(null), "—");
    assert.match(source, /暂无记录/);
  });

  await t.test("02 unavailable current_online renders unavailable rather than zero", () => {
    assert.equal(formatMetricValue({ semantic_type: "current_online", value: null, availability_status: "unavailable" }), "不可用");
  });

  await t.test("03 unavailable company_sales renders unavailable rather than zero", () => {
    assert.equal(formatMetricValue({ semantic_type: "company_sales", value: null, availability_status: "unavailable" }), "不可用");
  });

  await t.test("04 prediction is explicitly labeled non-actual", () => {
    assert.match(source, /来源预测，不是实际销量/);
    assert.equal(SEMANTIC_DEFINITIONS.find(([key]) => key === "source_predicted_daily_sales")[2].includes("不是实际销量"), true);
  });

  await t.test("05 historical observed is not described as current online", () => {
    const historical = SEMANTIC_DEFINITIONS.find(([key]) => key === "historical_observed");
    assert.match(historical[2], /不表示当前在线/);
  });

  await t.test("06 the shop workspace defaults to pending and warns about formal scope", () => {
    assert.match(source, /shopFilter: "pending"/);
    assert.match(source, /不进入正式机会范围/);
    assert.match(source, /测试\/验收数据/);
    assert.match(source, /真实马帮订单\/库存样本尚未执行/);
  });

  await t.test("07 client shop confirmation sends no confirmedBy field", () => {
    assert.match(source, /shops\/\$\{encodeURIComponent\(id\)\}\/confirm[^\n]+body: "\{\}"/);
    assert.doesNotMatch(source, /JSON\.stringify\(\{\s*confirmedBy/);
  });

  await t.test("08 read-only users receive a concrete disabled reason", () => {
    const capabilities = { permissions: { [GROWTH_RADAR_PERMISSIONS.scopeConfirm]: false } };
    assert.deepEqual(permissionState(capabilities, GROWTH_RADAR_PERMISSIONS.scopeConfirm), {
      granted: false,
      reason: "当前会话没有此操作权限",
    });
  });

  await t.test("09 revocation requires a reason in both form and request guard", () => {
    assert.match(source, /textarea name="reason" required/);
    assert.match(source, /if \(!reason\) throw new Error\("取消确认必须填写原因/);
  });

  await t.test("10 order preview calls preview only and states that it writes no facts", () => {
    assert.match(source, /import\/\$\{domain\}\/preview/);
    assert.match(source, /预览阶段不创建批次、不写原始行、不生成标准事实/);
  });

  await t.test("11 inventory preview is also separated from apply", () => {
    assert.deepEqual(requestPlanForView("inventory"), []);
    assert.match(source, /生成只读预览/);
  });

  await t.test("12 PII display is category-only and raw customer fields are absent", () => {
    assert.match(source, /个人身份、联系方式与客户备注/);
    assert.match(source, /不回显客户原值/);
    assert.doesNotMatch(source, /customerName|customerAddress|customerPhone/);
  });

  await t.test("13 formula injection is described as intercepted or safely handled", () => {
    assert.equal(QUALITY_COPY.formula_injection_risk[1], "数据已拦截或安全处理");
    assert.match(source, /不回显可执行公式/);
  });

  await t.test("14 duplicate rows have dedicated order and inventory metrics", () => {
    assert.match(source, /summary\.duplicateRowCount/);
    assert.match(source, /summary\.duplicateRecordCount/);
  });

  await t.test("15 multi-warehouse SKU uses the exact source key and is not merged", () => {
    assert.match(source, /source_sku \+ source_warehouse/);
    assert.match(source, /多仓 SKU 不合并/);
  });

  await t.test("16 blocking issues disable application", () => {
    const result = previewGate(preview({ issues: [{ severity: "blocker", blocking: true }] }), { canApply: true, scopeConfirmed: true, now });
    assert.deepEqual(result, { allowed: false, reason: "存在阻断问题" });
  });

  await t.test("17 expired previews cannot be applied", () => {
    const result = previewGate(preview({ expiresAt: past }), { canApply: true, scopeConfirmed: true, now });
    assert.deepEqual(result, { allowed: false, reason: "预览已过期，请重新生成" });
  });

  await t.test("18 repeated application has a non-error idempotent message", () => {
    assert.match(source, /该批次已经应用，无重复写入/);
  });

  await t.test("19 application result exposes created updated and ignored counts", () => {
    assert.match(source, /createdCount/);
    assert.match(source, /updatedCount/);
    assert.match(source, /ignoredCount/);
  });

  await t.test("20 views declare lazy request plans", () => {
    assert.deepEqual(requestPlanForView("orders"), []);
    assert.deepEqual(requestPlanForView("shops"), ["/api/growth-radar/shops"]);
    assert.equal(requestPlanForView("overview").includes("/api/growth-radar/semantics/status"), true);
  });

  await t.test("21 page and dynamic shell IDs are unique", () => {
    const staticIds = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    assert.equal(new Set(staticIds).size, staticIds.length);
    assert.equal((source.match(/id="grActionDialog"/g) ?? []).length, 1);
  });

  await t.test("22 430px layout confines wide tables to local scrolling", () => {
    assert.match(css, /@media \(max-width: 600px\)/);
    assert.match(css, /\.gr-table-wrap[\s\S]*overflow: auto/);
    assert.match(css, /#page-growth-radar[\s\S]*overflow-x: clip/);
    assert.match(css, /\.gr-split > section\s*\{[\s\S]*?min-width: 0/);
  });

  await t.test("23 product center listing and the single Growth Radar nav remain", () => {
    assert.equal((html.match(/data-page="growth-radar"/g) ?? []).length, 1);
    assert.match(html, /data-page="products"/);
    assert.match(app, /productCenterPage\.load/);
  });

  await t.test("24 migrations remain exactly 001 through 014", () => {
    const numbered = migrations.filter((name) => /^\d{3}_/.test(name)).sort();
    assert.equal(numbered.at(-1).startsWith("014_"), true);
    assert.equal(numbered.some((name) => /^(015|016|017)_/.test(name)), false);
  });

  await t.test("25 formal database paths remain fail-closed", () => {
    assert.match(isolation, /default_database_rejected|formal_database_rejected/);
    assert.match(isolation, /growth-radar-g1b\.sqlite/);
  });

  await t.test("26 a preview-only role cannot apply", () => {
    const result = previewGate(preview(), { canApply: false, scopeConfirmed: true, now });
    assert.equal(result.reason, "当前会话没有应用权限");
  });

  await t.test("27 application also requires explicit scope acknowledgement", () => {
    const result = previewGate(preview(), { canApply: true, scopeConfirmed: false, now });
    assert.equal(result.reason, "请先核对并确认来源范围");
  });

  await t.test("28 a fully eligible preview opens the second confirmation", () => {
    assert.deepEqual(previewGate(preview(), { canApply: true, scopeConfirmed: true, now }), { allowed: true, reason: "" });
    assert.match(source, /二次确认后才会写入 A2 隔离数据库/);
  });

  await t.test("29 all five requested permission interactions are visible", () => {
    for (const permission of ["view", "preview", "apply", "shopManage", "scopeConfirm"]) assert.ok(GROWTH_RADAR_PERMISSIONS[permission]);
    assert.match(source, /查看数据/);
    assert.match(source, /管理店铺/);
  });

  await t.test("30 audit text hides credentials and local paths", () => {
    assert.equal(safeAuditText("Authorization token=secret"), "[已隐藏]");
    assert.equal(safeAuditText("C:\\Users\\PC\\private.xlsx"), "[本机路径已隐藏]");
  });

  await t.test("31 all six required semantic cards exist", () => {
    assert.deepEqual(SEMANTIC_DEFINITIONS.map(([key]) => key), [
      "historical_observed", "current_online", "own_sales", "company_sales", "source_visible_sales", "source_predicted_daily_sales",
    ]);
  });

  await t.test("32 unavailable values are never coerced through value-or-zero", () => {
    assert.doesNotMatch(source, /value\s*\|\|\s*0/);
  });

  await t.test("33 quality coverage contains every required standardized code", () => {
    for (const code of [
      "missing_shop_mapping", "pending_shop_confirmation", "missing_sku", "empty_source_sku",
      "empty_source_warehouse", "duplicate_source_row", "invalid_order_status", "pii_field_filtered",
      "formula_injection_risk", "inventory_key_not_visible_in_source_scope", "current_online_source_unavailable",
      "company_sales_source_unavailable", "prediction_not_actual", "stale_preview", "source_scope_unconfirmed",
    ]) assert.ok(QUALITY_COPY[code], code);
  });

  await t.test("34 dialogs have an accessible name, visible labels, and native escape behavior", () => {
    assert.match(source, /aria-labelledby="grDialogTitle"/);
    assert.match(source, /aria-label="关闭弹窗"/);
    assert.match(source, /dialog\.showModal\(\)/);
  });

  await t.test("35 exactly eight G1B workspaces are exposed with no G2 view", () => {
    assert.equal(GROWTH_RADAR_VIEWS.length, 8);
    assert.equal(GROWTH_RADAR_VIEWS.some(([id]) => /score|opportun|recommend/i.test(id)), false);
  });
});
