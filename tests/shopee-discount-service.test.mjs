import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openCommerceDataAccess } from "../lib/data/data-access.mjs";
import { FoundationService } from "../lib/foundation/foundation-service.mjs";
import { ShopeeDiscountService } from "../lib/shopee-discount/service.mjs";

const NOW = new Date("2026-08-13T10:00:00.000Z");

function readySecurity(overrides = {}) {
  return {
    enabled: true,
    mode: "trusted_single_role",
    privilegedApprovalRequired: false,
    reasonCode: "SHOPEE_WRITE_ENABLED",
    safeStatus: { enabled: true, reasonCode: "SHOPEE_WRITE_ENABLED" },
    constraints: { countries: ["TH"], shops: ["1", "2"], maxBatchItems: 10 },
    ...overrides,
  };
}

function shop(shopId, country, extra = {}) {
  return { shop_id: shopId, country, shop_name: `Shop ${shopId}`, healthy: true, ...extra };
}

function model(modelId, sku, originalMinor, currentMinor, stock = 1, extra = {}) {
  return {
    model_id: modelId,
    model_sku: sku,
    model_status: "NORMAL",
    original_price_minor: originalMinor,
    current_discount_minor: currentMinor,
    stock_info_v2: { seller_stock: [{ stock }] },
    ...extra,
  };
}

function warehouseSnapshot(rows, watermark = "2026-08-13T09:00:00.000Z") {
  return {
    status: "READY",
    rows: rows.map((row) => ({
      sku: row.sku,
      country: "TH",
      category: "HOME",
      platform: "SHOPEE",
      status: "ACTIVE",
      dailyMinor: row.dailyMinor ?? null,
      eventMinor: row.eventMinor ?? null,
      megaMinor: row.megaMinor ?? null,
      dailyApprovedAt: row.dailyApprovedAt ?? "2026-08-13T08:00:00.000Z",
      eventApprovedAt: null,
      megaApprovedAt: null,
      watermark,
    })),
    warnings: [],
    evidence: { watermark, scope: { country: "TH", category: "HOME", skus: rows.map(({ sku }) => sku) } },
  };
}

function fakeShopee({ shops = [shop("1", "TH")], itemsByShop = {}, modelsByItem = {}, discountsByShop = {}, discountDetails = {} } = {}) {
  return {
    writeCalls: 0,
    async listShops() { return { data: { shops }, requestId: "shops-request", attempts: 1 }; },
    async listActiveItems({ shopId, cursor }) {
      const items = itemsByShop[shopId] || [];
      return { data: { item: cursor === "0" ? items : [], has_next_page: false, next_offset: 0 }, requestId: "items-request", attempts: 1 };
    },
    async getItemBaseInfo({ itemIds }) {
      return { data: { item_list: itemIds.map((itemId) => ({ item_id: itemId, item_status: "NORMAL" })) }, requestId: "base-request", attempts: 1 };
    },
    async getModelList({ itemId }) {
      return { data: { model: modelsByItem[itemId] || [], tier_variation: [] }, requestId: "models-request", attempts: 1 };
    },
    async listDiscounts({ shopId }) {
      return { data: { discount_list: discountsByShop[shopId] || [], more: false }, requestId: "discounts-request", attempts: 1 };
    },
    async getDiscount({ discountId }) {
      return { data: discountDetails[discountId] || { discount_id: discountId, item_list: [], more: false }, requestId: "discount-request", attempts: 1 };
    },
  };
}

async function fixture({ shopee = fakeShopee(), warehouse, security = readySecurity(), approvalTtlMs = 300_000 } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shopee-discount-service-"));
  const access = openCommerceDataAccess({ rootDir: path.resolve("."), databasePath: path.join(root, "commerce.sqlite"), migrationsDir: path.resolve("migrations") });
  const foundation = new FoundationService({ repository: access.repositories.foundation, now: () => NOW });
  const service = new ShopeeDiscountService({
    repository: access.repositories.shopeeDiscount,
    foundation,
    shopee,
    warehouse: warehouse || { async scanPrices({ skus }) { return warehouseSnapshot(skus.map((sku) => ({ sku, dailyMinor: "9000" }))); } },
    writeSecurity: () => security,
    now: () => NOW,
    approvalTtlMs,
    siteCapability: { currency: "THB", scale: 2, minMinor: "1", maxMinor: "99999999", stepMinor: "1" },
    shardSize: 2,
  });
  return {
    access,
    service,
    shopee,
    async close() { access.close(); await fs.rm(root, { recursive: true, force: true }); },
  };
}

function previewInput(overrides = {}) {
  return {
    country: "TH",
    shopIds: ["1"],
    workflow: "CURRENT_CORRECTION",
    defaultTier: "DAILY",
    shopOverrides: [],
    linkOverrides: [],
    category: "HOME",
    ...overrides,
  };
}

test("preview validates single-country shop scope and rejects conflicting tier overrides", async () => {
  const context = await fixture({ shopee: fakeShopee({ shops: [shop("1", "TH"), shop("2", "TH"), shop("3", "SG")] }) });
  try {
    await assert.rejects(context.service.createPreview(previewInput({ shopIds: [], useDefaultShops: false }), {}), { code: "SHOPEE_DISCOUNT_SHOP_SCOPE_REQUIRED" });
    await assert.rejects(context.service.createPreview(previewInput({ shopIds: ["1", "3"] }), {}), { code: "SHOPEE_DISCOUNT_SHOP_COUNTRY_MISMATCH" });
    await assert.rejects(context.service.createPreview(previewInput({ shopIds: ["1"], useDefaultShops: true }), {}), { code: "SHOPEE_DISCOUNT_SHOP_SCOPE_CONFLICT" });
    await assert.rejects(context.service.createPreview(previewInput({ defaultTier: "FLASH" }), {}), { code: "SHOPEE_DISCOUNT_INPUT_INVALID" });
    await assert.rejects(context.service.createPreview(previewInput({ shopOverrides: [{ shopId: "1", priceTier: "EVENT" }, { shopId: "1", priceTier: "MEGA" }] }), {}), { code: "SHOPEE_DISCOUNT_OVERRIDE_CONFLICT" });
    await assert.rejects(context.service.createPreview(previewInput({ shopOverrides: [{ shopId: "2", priceTier: "EVENT" }] }), {}), { code: "SHOPEE_DISCOUNT_OVERRIDE_SCOPE_MISMATCH" });
    await assert.rejects(context.service.createPreview({ ...previewInput(), unknown: true }, {}), { code: "SHOPEE_DISCOUNT_INPUT_INVALID" });
  } finally { await context.close(); }
});

test("preview includes zero stock, shares warehouse SKU prices, falls back per variant, and isolates abnormal variants", async () => {
  const shopee = fakeShopee({
    itemsByShop: { "1": [
      { item_id: "10", item_status: "NORMAL" },
      { item_id: "11", item_status: "NORMAL" },
      { item_id: "12", item_status: "BANNED" },
    ] },
    modelsByItem: {
      "10": [model("100", "SHARED", "10000", "9500", 0), model("101", "MISSING", "5000", "4800", 3)],
      "11": [model("102", "SHARED", "10000", "9500", 2), model("103", "ABNORMAL", "10000", "9500", 2)],
    },
  });
  const warehouse = { async scanPrices() { return warehouseSnapshot([
    { sku: "SHARED", dailyMinor: "9000" },
    { sku: "MISSING", dailyMinor: null },
    { sku: "ABNORMAL", dailyMinor: "11000" },
  ]); } };
  const context = await fixture({ shopee, warehouse });
  try {
    const result = await context.service.createPreview(previewInput(), { requestId: "preview-request" });
    assert.equal(result.state, "PREVIEWED");
    assert.deepEqual(result.summary.counts, { discovered: 4, ready: 3, skipped: 1, blocked: 0 });
    assert.equal(result.summary.codes.TARGET_NOT_BELOW_ORIGINAL, 1);
    assert.equal(Object.hasOwn(result.summary, "items"), false);
    assert.equal(result.confirmationText, "确认执行 TH 1 店 3 个变体");
    const page = await context.service.listPreviewItems(result.id, { pageSize: 2 }, {});
    assert.equal(page.items.length, 2);
    const second = await context.service.listPreviewItems(result.id, { pageSize: 2, cursor: page.nextCursor }, {});
    const items = [...page.items, ...second.items];
    assert.deepEqual(items.map(({ targetPriceMinor }) => targetPriceMinor).sort(), ["4950", "9000", "9000"]);
    assert.equal(items.find(({ modelId }) => modelId === "100").payload.stock, 0);
    assert.equal(result.merkleRoot.length, 64);
    assert.equal(result.summary.shardCount, 2);
  } finally { await context.close(); }
});

test("warehouse failure seals nothing and SQLite rejects more than ten variants", async () => {
  const unavailable = await fixture({
    shopee: fakeShopee({ itemsByShop: { "1": [{ item_id: "10", item_status: "NORMAL" }] }, modelsByItem: { "10": [model("100", "SKU", "10000", "9500")] } }),
    warehouse: { async scanPrices() { return { status: "BLOCKED", code: "WAREHOUSE_UNAVAILABLE", rows: [], warnings: [], evidence: {} }; } },
  });
  try {
    await assert.rejects(unavailable.service.createPreview(previewInput(), {}), { code: "WAREHOUSE_UNAVAILABLE" });
    assert.equal((await unavailable.access.repositories.shopeeDiscount.listPlans()).length, 0);
  } finally { await unavailable.close(); }

  const tooMany = await fixture({ shopee: fakeShopee({
    itemsByShop: { "1": [{ item_id: "10", item_status: "NORMAL" }] },
    modelsByItem: { "10": Array.from({ length: 11 }, (_, index) => model(String(100 + index), `SKU-${index}`, "10000", "9500")) },
  }) });
  try {
    await assert.rejects(tooMany.service.createPreview(previewInput(), {}), { code: "SHOPEE_DISCOUNT_SQLITE_LIMIT" });
  } finally { await tooMany.close(); }
});

test("Foundation root binding failure leaves a non-approvable BLOCKED domain plan", async () => {
  const context = await fixture({ shopee: fakeShopee({
    itemsByShop: { "1": [{ item_id: "10", item_status: "NORMAL" }] },
    modelsByItem: { "10": [model("100", "SKU", "10000", "9500")] },
  }) });
  try {
    context.service.foundation.operationPlans.create = async () => { throw Object.assign(new Error("foundation down"), { code: "FOUNDATION_UNAVAILABLE" }); };
    await assert.rejects(context.service.createPreview(previewInput(), {}), { code: "SHOPEE_DISCOUNT_FOUNDATION_BIND_FAILED" });
    const plans = await context.access.repositories.shopeeDiscount.listPlans();
    assert.equal(plans.length, 1);
    assert.equal(plans[0].state, "BLOCKED");
    assert.equal(plans[0].reasonCode, "SHOPEE_DISCOUNT_FOUNDATION_BIND_FAILED");
    assert.equal(plans[0].merkleRoot, null);
  } finally { await context.close(); }
});

test("activity overlap and external tier selection isolate affected variants while near-end new items move to next plan", async () => {
  const shopee = fakeShopee({
    itemsByShop: { "1": [
      { item_id: "10", item_status: "NORMAL", update_time: Math.floor(NOW.getTime() / 1000) },
      { item_id: "11", item_status: "NORMAL", update_time: Math.floor(NOW.getTime() / 1000) },
      { item_id: "12", item_status: "NORMAL", update_time: Math.floor((NOW.getTime() - 7 * 24 * 60 * 60_000) / 1000) },
    ] },
    modelsByItem: {
      "10": [model("100", "SKU-A", "10000", "9500")],
      "11": [model("101", "SKU-B", "10000", "9500")],
      "12": [model("102", "SKU-C", "10000", "9500")],
    },
    discountsByShop: { "1": [{ discount_id: "900", discount_name: "External Sale", end_time: String(Math.floor((NOW.getTime() + 60 * 60_000) / 1000)) }] },
    discountDetails: { "900": { discount_id: "900", discount_name: "External Sale", end_time: String(Math.floor((NOW.getTime() + 60 * 60_000) / 1000)), item_list: [{ item_id: "10", model_list: [{ model_id: "100" }] }], more: false } },
  });
  const noSelection = await fixture({ shopee });
  try {
    const result = await noSelection.service.createPreview(previewInput(), {});
    assert.equal(result.summary.codes.EXTERNAL_ACTIVITY_TIER_REQUIRED, 1);
    assert.equal(result.summary.codes.CURRENT_ACTIVITY_ENDING_SOON, 1);
    assert.equal(result.summary.counts.ready, 1);
  } finally { await noSelection.close(); }

  const selected = await fixture({ shopee });
  try {
    const result = await selected.service.createPreview(previewInput({ activitySelection: [{ shopId: "1", discountId: "900", priceTier: "EVENT" }] }), {});
    assert.equal(result.summary.counts.ready, 2);
    assert.equal(result.summary.codes.CURRENT_ACTIVITY_ENDING_SOON, 1);
  } finally { await selected.close(); }
});

test("different Discount overlap blocks only affected variants and records original activity identity and time", async () => {
  const shopee = fakeShopee({
    itemsByShop: { "1": [{ item_id: "10", item_status: "NORMAL" }, { item_id: "11", item_status: "NORMAL" }] },
    modelsByItem: { "10": [model("100", "SKU-A", "10000", "9500")], "11": [model("101", "SKU-B", "10000", "9500")] },
    discountsByShop: { "1": [
      { discount_id: "900", discount_name: "External A", start_time: "1786611600", end_time: "1786698000" },
      { discount_id: "901", discount_name: "External B", start_time: "1786611600", end_time: "1786698000" },
    ] },
    discountDetails: {
      "900": { discount_id: "900", discount_name: "External A", start_time: "1786611600", end_time: "1786698000", item_list: [{ item_id: "10", model_list: [{ model_id: "100" }] }] },
      "901": { discount_id: "901", discount_name: "External B", start_time: "1786611600", end_time: "1786698000", item_list: [{ item_id: "10", model_list: [{ model_id: "100" }] }] },
    },
  });
  const context = await fixture({ shopee });
  try {
    const result = await context.service.createPreview(previewInput({ activitySelection: [
      { shopId: "1", discountId: "900", priceTier: "DAILY" },
      { shopId: "1", discountId: "901", priceTier: "DAILY" },
    ] }), {});
    assert.equal(result.summary.counts.ready, 1);
    assert.equal(result.summary.codes.DISCOUNT_OVERLAP, 1);
    const issues = await context.service.listIssues({ planId: result.id, code: "DISCOUNT_OVERLAP" });
    assert.equal(issues.length, 1);
    assert.deepEqual(issues[0].evidence.samples[0].activities.map(({ discountId }) => discountId), ["900", "901"]);
    assert.equal(issues[0].evidence.samples[0].activities[0].startsAt, "1786611600");
  } finally { await context.close(); }
});

test("approval is exact and idempotent, privileged identity is server-derived, and execution queues once without Shopee writes", async () => {
  const shopee = fakeShopee({ itemsByShop: { "1": [{ item_id: "10", item_status: "NORMAL" }] }, modelsByItem: { "10": [model("100", "SKU", "10000", "9500")] } });
  const context = await fixture({ shopee });
  try {
    const preview = await context.service.createPreview(previewInput(), { requestId: "preview-request" });
    await assert.rejects(context.service.approvePreview({ planId: preview.id, merkleRoot: "wrong", operatorName: "Alice", confirmationText: preview.confirmationText }, {}), { code: "SHOPEE_DISCOUNT_APPROVAL_ROOT_MISMATCH" });
    const approvalInput = { planId: preview.id, merkleRoot: preview.merkleRoot, operatorName: "Alice", confirmationText: preview.confirmationText };
    const approved = await context.service.approvePreview(approvalInput, { actorId: "session-user" });
    assert.equal(approved.state, "APPROVED");
    assert.deepEqual(await context.service.approvePreview(approvalInput, { actorId: "session-user" }), approved);
    await assert.rejects(context.service.approvePreview(approvalInput, { actorId: "different-session-user" }), { code: "SHOPEE_DISCOUNT_APPROVAL_CHANGED" });
    await assert.rejects(context.service.approvePreview({ ...approvalInput, operatorName: "Mallory" }, { actorId: "session-user" }), { code: "SHOPEE_DISCOUNT_APPROVAL_CHANGED" });
    const jobs = await Promise.all(Array.from({ length: 5 }, () => context.service.requestExecution(
      { planId: preview.id, merkleRoot: preview.merkleRoot },
      { identity: "shared" },
    )));
    const [firstJob, secondJob] = jobs;
    assert.equal(new Set(jobs.map(({ id }) => id)).size, 1);
    assert.equal(firstJob.id, secondJob.id);
    assert.equal(firstJob.status, "PENDING");
    assert.equal(shopee.writeCalls, 0);
    context.service.writeSecurity = () => readySecurity({ enabled: false, reasonCode: "SHOPEE_WRITE_SWITCH_DISABLED", safeStatus: { enabled: false, reasonCode: "SHOPEE_WRITE_SWITCH_DISABLED" } });
    await assert.rejects(context.service.requestExecution({ planId: preview.id, merkleRoot: preview.merkleRoot }, { identity: "shared" }), { code: "SHOPEE_WRITE_DISABLED" });
    context.service.writeSecurity = () => readySecurity({ constraints: { countries: ["TH"], shops: ["2"], maxBatchItems: 10 } });
    await assert.rejects(context.service.requestExecution({ planId: preview.id, merkleRoot: preview.merkleRoot }, { identity: "shared" }), { code: "SHOPEE_WRITE_TARGET_NOT_AUTHORIZED" });
  } finally { await context.close(); }

  const separate = await fixture({
    shopee,
    security: readySecurity({ mode: "separate_execute_identity", privilegedApprovalRequired: true }),
  });
  try {
    const preview = await separate.service.createPreview(previewInput(), {});
    const input = {
      planId: preview.id,
      merkleRoot: preview.merkleRoot,
      operatorName: "Alice",
      confirmationText: preview.confirmationText,
      privilegedApproval: { planId: preview.id, merkleRoot: preview.merkleRoot, policyHash: preview.policyHash, expiresAt: preview.expiresAt },
    };
    await assert.rejects(separate.service.approvePreview(input, { actorId: "body-claimed-admin" }), { code: "SHOPEE_WRITE_PRIVILEGED_IDENTITY_REQUIRED" });
    const approved = await separate.service.approvePreview(input, { actorId: "session-user", privilegedIdentity: "privileged_execute_identity" });
    assert.equal(approved.state, "APPROVED");
    await assert.rejects(separate.service.requestExecution({ planId: preview.id, merkleRoot: preview.merkleRoot }, { identity: "shared" }), { code: "SHOPEE_WRITE_PRIVILEGED_IDENTITY_REQUIRED" });
  } finally { await separate.close(); }
});

test("expired preview and changed policy cannot be approved", async () => {
  let policyHash = "policy-v1";
  const shopee = fakeShopee({ itemsByShop: { "1": [{ item_id: "10", item_status: "NORMAL" }] }, modelsByItem: { "10": [model("100", "SKU", "10000", "9500")] } });
  const context = await fixture({ shopee, approvalTtlMs: 1_000 });
  context.service.policy = () => ({ hash: policyHash, value: { version: policyHash } });
  try {
    const preview = await context.service.createPreview(previewInput(), {});
    policyHash = "policy-v2";
    await assert.rejects(context.service.approvePreview({ planId: preview.id, merkleRoot: preview.merkleRoot, operatorName: "Alice", confirmationText: preview.confirmationText }, {}), { code: "SHOPEE_DISCOUNT_APPROVAL_POLICY_MISMATCH" });
    context.service.policy = () => ({ hash: preview.policyHash, value: { version: "policy-v1" } });
    context.service.now = () => new Date("2026-08-13T10:00:01.000Z");
    await assert.rejects(context.service.approvePreview({ planId: preview.id, merkleRoot: preview.merkleRoot, operatorName: "Alice", confirmationText: preview.confirmationText }, {}), { code: "SHOPEE_DISCOUNT_PLAN_EXPIRED" });
  } finally { await context.close(); }
});
