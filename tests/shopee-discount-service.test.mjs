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

async function fixture({ shopee = fakeShopee(), warehouse, security = readySecurity(), approvalTtlMs = 300_000,
  siteCapabilities, serviceOptions = {} } = {}) {
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
    siteCapabilities: siteCapabilities || { TH: { currency: "THB", scale: 2, minMinor: "1", maxMinor: "99999999", stepMinor: "1" } },
    shardSize: 2,
    ...serviceOptions,
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

test("activity overlap and external tier selection isolate affected variants without using unrelated listing timestamps", async () => {
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
    assert.equal(result.summary.codes.NEXT_PLAN_REQUIRED, undefined);
    assert.equal(result.summary.counts.ready, 2);
  } finally { await noSelection.close(); }

  const selected = await fixture({ shopee });
  try {
    const result = await selected.service.createPreview(previewInput({ activitySelection: [{ shopId: "1", discountId: "900", priceTier: "EVENT" }] }), {});
    assert.equal(result.summary.counts.ready, 3);
    assert.equal(result.summary.codes.NEXT_PLAN_REQUIRED, undefined);
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

test("warehouse omission is blocked while an explicit validated missing row may fall back and persists a scoped baseline", async () => {
  const shopee = fakeShopee({ itemsByShop: { "1": [{ item_id: "10", item_status: "NORMAL" }] }, modelsByItem: { "10": [model("100", "SKU", "10000", "9500")] } });
  const omitted = await fixture({ shopee, warehouse: { async scanPrices() { return warehouseSnapshot([]); } } });
  try {
    await assert.rejects(omitted.service.createPreview(previewInput(), {}), { code: "WAREHOUSE_SKU_COVERAGE_INCOMPLETE" });
    assert.equal((await omitted.access.repositories.shopeeDiscount.listPlans()).length, 0);
  } finally { await omitted.close(); }

  const explicit = await fixture({ shopee, warehouse: { async scanPrices() { return warehouseSnapshot([{ sku: "SKU", dailyMinor: null }]); } } });
  try {
    const preview = await explicit.service.createPreview(previewInput(), {});
    const item = (await explicit.service.listPreviewItems(preview.id, {}, { authorizedShopIds: ["1"] })).items[0];
    assert.equal(item.targetPriceMinor, "9900");
    const baseline = await explicit.access.repositories.shopeeDiscount.getLatestWarehouseBaseline({ country: "TH", category: "HOME", tier: "DAILY" });
    assert.deepEqual(baseline.rows.map(({ sku }) => sku), ["SKU"]);
  } finally { await explicit.close(); }
});

test("zero-ready approved plan always runs plan security then rejects without queuing", async () => {
  const shopee = fakeShopee({ itemsByShop: { "1": [{ item_id: "10", item_status: "NORMAL" }] }, modelsByItem: { "10": [model("100", "SKU", "10000", "9500")] } });
  const context = await fixture({ shopee, warehouse: { async scanPrices() { return warehouseSnapshot([{ sku: "SKU", dailyMinor: "11000" }]); } } });
  try {
    const preview = await context.service.createPreview(previewInput(), {});
    await context.service.approvePreview({ planId: preview.id, merkleRoot: preview.merkleRoot, operatorName: "Alice", confirmationText: preview.confirmationText }, { actorId: "user" });
    context.service.writeSecurity = () => readySecurity({ enabled: false, reasonCode: "SHOPEE_WRITE_SWITCH_DISABLED" });
    await assert.rejects(context.service.requestExecution({ planId: preview.id, merkleRoot: preview.merkleRoot }, {}), { code: "SHOPEE_WRITE_DISABLED" });
    context.service.writeSecurity = () => readySecurity();
    await assert.rejects(context.service.requestExecution({ planId: preview.id, merkleRoot: preview.merkleRoot }, {}), { code: "SHOPEE_DISCOUNT_NO_EXECUTABLE_ITEMS" });
    assert.equal((await context.access.repositories.shopeeDiscount.listExecutionJobs(preview.id)).length, 0);
  } finally { await context.close(); }
});

test("activity names never establish system ownership and next-plan rule needs membership activation evidence", async () => {
  const ending = String(Math.floor((NOW.getTime() + 60 * 60_000) / 1000));
  const shopee = fakeShopee({
    itemsByShop: { "1": [{ item_id: "10", item_status: "NORMAL", update_time: Math.floor(NOW.getTime() / 1000) }] },
    modelsByItem: { "10": [model("100", "SKU", "10000", "9500")] },
    discountsByShop: { "1": [{ discount_id: "900", discount_name: "External-DAILY-Sale", end_time: ending }] },
    discountDetails: { "900": { discount_id: "900", discount_name: "External-DAILY-Sale", end_time: ending, item_list: [{ item_id: "10", model_list: [{ model_id: "100" }] }] } },
  });
  const context = await fixture({ shopee });
  try {
    const external = await context.service.createPreview(previewInput(), {});
    assert.equal(external.summary.codes.EXTERNAL_ACTIVITY_TIER_REQUIRED, 1);
    assert.equal(external.summary.codes.CURRENT_ACTIVITY_ENDING_SOON, undefined);
  } finally { await context.close(); }

  shopee.getDiscount = async () => ({ data: { discount_id: "900", discount_name: "External-DAILY-Sale", end_time: ending,
    item_list: [{ item_id: "10", model_list: [{ model_id: "100", added_at: String(Math.floor(NOW.getTime() / 1000)) }] }] } });
  const membership = await fixture({ shopee });
  try {
    const next = await membership.service.createPreview(previewInput({ activitySelection: [{ shopId: "1", discountId: "900", priceTier: "DAILY" }] }), {});
    assert.equal(next.summary.codes.NEXT_PLAN_REQUIRED, 1);
    const issues = await membership.service.listIssues({ planId: next.id, code: "NEXT_PLAN_REQUIRED" }, { authorizedShopIds: ["1"] });
    assert.equal(issues[0].evidence.samples[0].discountId, "900");
    assert.ok(issues[0].evidence.samples[0].membershipActiveAt);
  } finally { await membership.close(); }

  const storedShopee = fakeShopee({
    itemsByShop: { "1": [{ item_id: "10", item_status: "NORMAL" }] },
    modelsByItem: { "10": [model("100", "SKU", "10000", "9500")] },
    discountsByShop: { "1": [{ discount_id: "900", discount_name: "Arbitrary Name", end_time: ending }] },
    discountDetails: { "900": { discount_id: "900", discount_name: "Arbitrary Name", end_time: ending,
      item_list: [{ item_id: "10", model_list: [{ model_id: "100" }] }] } },
  });
  const stored = await fixture({ shopee: storedShopee });
  try {
    const repository = stored.access.repositories.shopeeDiscount;
    const historical = await repository.createPlan({
      id: "historical-system-activity", country: "TH",
      activities: [{ shopId: "1", platformActivityId: "900", metadata: { systemManaged: true, priceTier: "EVENT" } }],
      targetStartsAt: "2026-07-01T00:00:00.000Z", targetEndsAt: "2026-07-31T00:00:00.000Z",
      sourceSnapshotHash: "historical-snapshot", policyHash: "historical-policy", createdBy: "system",
    });
    await repository.markPlanState({ planId: historical.id, fromState: "PREVIEWING", toState: "CANCELLED", expectedVersion: historical.stateVersion });
    const preview = await stored.service.createPreview(previewInput(), { requestId: "stored-system-activity" });
    assert.equal(preview.summary.codes.EXTERNAL_ACTIVITY_TIER_REQUIRED, undefined);
    assert.equal((await stored.service.listPreviewItems(preview.id, {}, { authorizedShopIds: ["1"] })).items[0].payload.priceTier, "EVENT");
  } finally { await stored.close(); }
});

test("country-specific site capabilities reject unsupported countries and persist exact currency", async () => {
  const sgShopee = fakeShopee({ shops: [shop("1", "SG")], itemsByShop: { "1": [{ item_id: "10", item_status: "NORMAL" }] }, modelsByItem: { "10": [model("100", "SKU", "10000", "9500")] } });
  const unsupported = await fixture({ shopee: sgShopee });
  try {
    await assert.rejects(unsupported.service.createPreview(previewInput({ country: "SG" }), {}), { code: "SHOPEE_DISCOUNT_SITE_UNSUPPORTED" });
  } finally { await unsupported.close(); }
  const supported = await fixture({ shopee: sgShopee, siteCapabilities: { SG: { currency: "SGD", scale: 2, minMinor: "1", maxMinor: "99999999", stepMinor: "1" } } });
  try {
    const preview = await supported.service.createPreview(previewInput({ country: "SG" }), {});
    assert.equal((await supported.service.listPreviewItems(preview.id, {}, { authorizedShopIds: ["1"] })).items[0].currency, "SGD");
  } finally { await supported.close(); }
});

test("unknown statuses and exhausted item or Discount pagination fail closed", async () => {
  const unknown = await fixture({ shopee: fakeShopee({ itemsByShop: { "1": [{ item_id: "10" }] }, modelsByItem: { "10": [model("100", "SKU", "10000", "9500")] } }) });
  try {
    const preview = await unknown.service.createPreview(previewInput(), {});
    assert.equal(preview.summary.counts.ready, 0);
    assert.equal(preview.summary.codes.LISTING_STATUS_UNKNOWN, 1);
  } finally { await unknown.close(); }

  const paged = fakeShopee();
  paged.listActiveItems = async () => ({ data: { item: [], has_next_page: true, next_offset: 1 } });
  const bounded = await fixture({ shopee: paged, serviceOptions: { maxItemPages: 1 } });
  try { await assert.rejects(bounded.service.createPreview(previewInput(), {}), { code: "SHOPEE_DISCOUNT_SHOPEE_PAGINATION" }); } finally { await bounded.close(); }

  const discounts = fakeShopee();
  discounts.listDiscounts = async () => ({ data: { discount_list: [], more: true } });
  const discountBounded = await fixture({ shopee: discounts, serviceOptions: { maxDiscountPages: 1 } });
  try { await assert.rejects(discountBounded.service.createPreview(previewInput(), {}), { code: "SHOPEE_DISCOUNT_SHOPEE_PAGINATION" }); } finally { await discountBounded.close(); }
});

test("production preview bounds model concurrency and pins one warehouse watermark across SKU chunks", async () => {
  const shopee = fakeShopee({
    itemsByShop: { "1": ["10", "11", "12"].map((item_id) => ({ item_id, item_status: "NORMAL" })) },
    modelsByItem: {
      "10": [model("100", "SKU-A", "10000", "9500")],
      "11": [model("101", "SKU-B", "10000", "9500")],
      "12": [model("102", "SKU-C", "10000", "9500")],
    },
  });
  let activeModels = 0;
  let peakModels = 0;
  const getModelList = shopee.getModelList.bind(shopee);
  shopee.getModelList = async (input) => {
    activeModels += 1;
    peakModels = Math.max(peakModels, activeModels);
    await new Promise((resolve) => setTimeout(resolve, 5));
    try { return await getModelList(input); } finally { activeModels -= 1; }
  };
  const warehouseCalls = [];
  const watermark = "2026-08-13T09:00:00.000Z";
  const warehouse = { async scanPrices(input) {
    warehouseCalls.push(input);
    return warehouseSnapshot(input.skus.map((sku) => ({ sku, dailyMinor: "9000" })), watermark);
  } };
  const context = await fixture({ shopee, warehouse, serviceOptions: { modelConcurrency: 2, warehouseChunkSize: 2 } });
  try {
    const preview = await context.service.createPreview(previewInput(), {});
    assert.equal(preview.summary.counts.ready, 3);
    assert.equal(peakModels, 2);
    assert.equal(warehouseCalls.length, 2);
    assert.equal(warehouseCalls[0].watermark, null);
    assert.equal(warehouseCalls[1].watermark, watermark);
  } finally { await context.close(); }
});

test("warehouse watermark is pinned across different price tiers", async () => {
  const shopee = fakeShopee({
    itemsByShop: { "1": [{ item_id: "10", item_status: "NORMAL" }, { item_id: "11", item_status: "NORMAL" }] },
    modelsByItem: { "10": [model("100", "DAILY-SKU", "10000", "9500")], "11": [model("101", "EVENT-SKU", "10000", "9500")] },
  });
  const calls = [];
  const warehouse = { async scanPrices(input) {
    calls.push(input);
    const event = input.skus.includes("EVENT-SKU");
    return warehouseSnapshot(input.skus.map((sku) => ({ sku, dailyMinor: "9000", eventMinor: "8800" })),
      event ? "2026-08-13T09:01:00.000Z" : "2026-08-13T09:00:00.000Z");
  } };
  const context = await fixture({ shopee, warehouse });
  try {
    await assert.rejects(context.service.createPreview(previewInput({
      linkOverrides: [{ shopId: "1", itemId: "11", priceTier: "EVENT" }],
    }), {}), { code: "WAREHOUSE_WATERMARK_CHANGED" });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].watermark, "2026-08-13T09:00:00.000Z");
  } finally { await context.close(); }
});

test("trusted shop scope protects preview/read models and manual scans validate duplicates, health and country", async () => {
  const shopee = fakeShopee({ shops: [shop("1", "TH"), shop("2", "TH", { healthy: false }), shop("3", "SG")] });
  const context = await fixture({ shopee });
  try {
    const preview = await context.service.createPreview(previewInput(), {});
    const denied = { authorizedShopIds: ["3"] };
    await assert.rejects(context.service.getPreview(preview.id, denied), { code: "SHOPEE_DISCOUNT_SHOP_NOT_AUTHORIZED" });
    await assert.rejects(context.service.listPreviewItems(preview.id, {}, denied), { code: "SHOPEE_DISCOUNT_SHOP_NOT_AUTHORIZED" });
    assert.equal((await context.service.listActivities({}, denied)).length, 0);
    assert.equal((await context.service.listIssues({}, denied)).length, 0);
    await assert.rejects(context.service.requestManualScan({ country: "TH", shopIds: ["1", "1"] }, { authorizedShopIds: ["1"] }), { code: "SHOPEE_DISCOUNT_OVERRIDE_CONFLICT" });
    await assert.rejects(context.service.requestManualScan({ country: "TH", shopIds: ["2"] }, { authorizedShopIds: ["2"] }), { code: "SHOPEE_DISCOUNT_SHOP_NOT_AUTHORIZED" });
    await assert.rejects(context.service.requestManualScan({ country: "TH", shopIds: ["3"] }, { authorizedShopIds: ["3"] }), { code: "SHOPEE_DISCOUNT_SHOP_COUNTRY_MISMATCH" });
  } finally { await context.close(); }
});

test("preview saga deterministically blocks both stores after shard failure and issue event failure cannot unseal a preview", async () => {
  const shopee = fakeShopee({ itemsByShop: { "1": [{ item_id: "10", item_status: "NORMAL" }] }, modelsByItem: { "10": [model("100", "SKU", "10000", "9500")] } });
  const failed = await fixture({ shopee });
  try {
    const append = failed.access.repositories.shopeeDiscount.appendPlanShard.bind(failed.access.repositories.shopeeDiscount);
    failed.access.repositories.shopeeDiscount.appendPlanShard = async () => { throw Object.assign(new Error("disk"), { code: "SHARD_WRITE_FAILED" }); };
    await assert.rejects(failed.service.createPreview(previewInput(), { requestId: "saga-failure" }), { code: "SHARD_WRITE_FAILED" });
    failed.access.repositories.shopeeDiscount.appendPlanShard = append;
    const [plan] = await failed.access.repositories.shopeeDiscount.listPlans();
    assert.equal(plan.state, "BLOCKED");
    assert.equal((await failed.service.foundation.operationPlans.get(plan.foundationPlanId)).state, "BLOCKED");
    await assert.rejects(failed.service.createPreview(previewInput(), { requestId: "saga-failure" }), { code: "SHOPEE_DISCOUNT_PREVIEW_SAGA_BLOCKED" });
  } finally { await failed.close(); }

  const foundationEventFailure = await fixture({ shopee });
  try {
    const repository = foundationEventFailure.service.foundation.operationPlans.repository;
    const append = repository.addOperationPlanEvent.bind(repository);
    let failedCreateAudit = false;
    repository.addOperationPlanEvent = async (event, now) => {
      if (!failedCreateAudit && event.eventType === "CREATED") {
        failedCreateAudit = true;
        throw Object.assign(new Error("foundation audit unavailable"), { code: "FOUNDATION_AUDIT_FAILED" });
      }
      return append(event, now);
    };
    await assert.rejects(foundationEventFailure.service.createPreview(previewInput(), { requestId: "foundation-event-failure" }),
      { code: "SHOPEE_DISCOUNT_FOUNDATION_BIND_FAILED" });
    const [plan] = await foundationEventFailure.access.repositories.shopeeDiscount.listPlans();
    assert.equal(plan.state, "BLOCKED");
    assert.equal((await foundationEventFailure.service.foundation.operationPlans.get(`shopee-discount-${plan.summary.previewSagaId.slice(0, 40)}`)).state, "BLOCKED");
  } finally { await foundationEventFailure.close(); }

  const eventFailure = await fixture({ shopee, warehouse: { async scanPrices() { return warehouseSnapshot([{ sku: "SKU", dailyMinor: "11000" }]); } } });
  try {
    const appendEvent = eventFailure.access.repositories.shopeeDiscount.appendEvent.bind(eventFailure.access.repositories.shopeeDiscount);
    eventFailure.access.repositories.shopeeDiscount.appendEvent = async (input) => input.eventType === "PREVIEW_ISSUE" ? Promise.reject(new Error("event unavailable")) : appendEvent(input);
    const preview = await eventFailure.service.createPreview(previewInput(), { requestId: "event-failure" });
    assert.equal(preview.state, "PREVIEWED");
  } finally { await eventFailure.close(); }
});

test("a blocked preview remains auditable but does not dead-end a replacement request", async () => {
  const shopee = fakeShopee({ itemsByShop: { "1": [{ item_id: "10", item_status: "NORMAL" }] }, modelsByItem: { "10": [model("100", "SKU", "10000", "9500")] } });
  const context = await fixture({ shopee });
  try {
    const append = context.access.repositories.shopeeDiscount.appendPlanShard.bind(context.access.repositories.shopeeDiscount);
    context.access.repositories.shopeeDiscount.appendPlanShard = async () => { throw Object.assign(new Error("disk"), { code: "SHARD_WRITE_FAILED" }); };
    await assert.rejects(context.service.createPreview(previewInput(), { requestId: "blocked-first" }), { code: "SHARD_WRITE_FAILED" });
    context.access.repositories.shopeeDiscount.appendPlanShard = append;
    const replacement = await context.service.createPreview(previewInput(), { requestId: "replacement" });
    const plans = await context.access.repositories.shopeeDiscount.listPlans({ limit: 10 });
    assert.equal(replacement.state, "PREVIEWED");
    assert.equal(plans.some((plan) => plan.state === "BLOCKED"), true);
  } finally { await context.close(); }
});

test("approval saga is concurrency-idempotent and blocks both stores when Foundation approval fails", async () => {
  const shopee = fakeShopee({ itemsByShop: { "1": [{ item_id: "10", item_status: "NORMAL" }] }, modelsByItem: { "10": [model("100", "SKU", "10000", "9500")] } });
  const concurrent = await fixture({ shopee });
  try {
    const preview = await concurrent.service.createPreview(previewInput(), { requestId: "approval-concurrent" });
    const input = { planId: preview.id, merkleRoot: preview.merkleRoot, operatorName: "Alice", confirmationText: preview.confirmationText };
    const results = await Promise.all(Array.from({ length: 4 }, () => concurrent.service.approvePreview(input, { actorId: "user" })));
    assert.equal(results.every(({ state }) => state === "APPROVED"), true);
    assert.equal((await concurrent.access.repositories.shopeeDiscount.getPlanApproval(preview.id)).actorId, "user");
  } finally { await concurrent.close(); }

  const failed = await fixture({ shopee });
  try {
    const preview = await failed.service.createPreview(previewInput(), { requestId: "approval-failure" });
    failed.service.foundation.operationPlans.approve = async () => { throw Object.assign(new Error("foundation"), { code: "FOUNDATION_APPROVAL_FAILED" }); };
    await assert.rejects(failed.service.approvePreview({ planId: preview.id, merkleRoot: preview.merkleRoot, operatorName: "Alice", confirmationText: preview.confirmationText }, { actorId: "user" }), { code: "FOUNDATION_APPROVAL_FAILED" });
    assert.equal((await failed.access.repositories.shopeeDiscount.getPlan(preview.id)).state, "BLOCKED");
    assert.equal((await failed.service.foundation.operationPlans.get(preview.foundationPlanId)).state, "BLOCKED");
  } finally { await failed.close(); }

  const compensation = await fixture({ shopee });
  try {
    const preview = await compensation.service.createPreview(previewInput(), { requestId: "approval-compensation-failure" });
    compensation.service.foundation.operationPlans.approve = async () => { throw Object.assign(new Error("foundation"), { code: "FOUNDATION_APPROVAL_FAILED" }); };
    compensation.service.foundation.operationPlans.block = async () => { throw Object.assign(new Error("foundation block"), { code: "FOUNDATION_BLOCK_FAILED" }); };
    await assert.rejects(compensation.service.approvePreview({ planId: preview.id, merkleRoot: preview.merkleRoot,
      operatorName: "Alice", confirmationText: preview.confirmationText }, { actorId: "user" }), { code: "FOUNDATION_APPROVAL_FAILED" });
    assert.equal((await compensation.access.repositories.shopeeDiscount.getPlan(preview.id)).state, "BLOCKED");
    assert.equal((await compensation.access.repositories.shopeeDiscount.getApprovalSagaPhase(preview.id)).phase, "COMPENSATION_FAILED");
    await assert.rejects(compensation.service.requestExecution({ planId: preview.id, merkleRoot: preview.merkleRoot }, {}),
      { code: "SHOPEE_DISCOUNT_EXECUTION_NOT_APPROVED" });
  } finally { await compensation.close(); }
});

test("approval reconciles process loss and execution requires the exact Foundation approval binding", async () => {
  const shopee = fakeShopee({ itemsByShop: { "1": [{ item_id: "10", item_status: "NORMAL" }] }, modelsByItem: { "10": [model("100", "SKU", "10000", "9500")] } });
  const context = await fixture({ shopee });
  try {
    const preview = await context.service.createPreview(previewInput(), { requestId: "approval-process-loss" });
    await context.access.repositories.shopeeDiscount.approvePlan({
      planId: preview.id, merkleRoot: preview.merkleRoot, policyHash: preview.policyHash,
      approval: { id: "process-loss-approval", actorId: "user", actorName: "Alice", mode: "human",
        evidence: { confirmationText: preview.confirmationText, privilegedBinding: null, approvalIdentity: null } },
      expectedVersion: preview.stateVersion,
    });
    await assert.rejects(context.service.requestExecution({ planId: preview.id, merkleRoot: preview.merkleRoot }, {}),
      { code: "SHOPEE_DISCOUNT_FOUNDATION_APPROVAL_REQUIRED" });
    const approved = await context.service.approvePreview({ planId: preview.id, merkleRoot: preview.merkleRoot,
      operatorName: "Alice", confirmationText: preview.confirmationText }, { actorId: "user" });
    assert.equal(approved.state, "APPROVED");
    assert.equal((await context.service.foundation.operationPlans.get(preview.foundationPlanId)).state, "APPROVED");
    assert.equal((await context.access.repositories.shopeeDiscount.getApprovalSagaPhase(preview.id)).phase, "BOTH_APPROVED");
  } finally { await context.close(); }
});

test("multi-shop execution applies identity once and batch caps per shop", async () => {
  const itemsByShop = { "1": [], "2": [] };
  const modelsByItem = {};
  for (const shopId of ["1", "2"]) for (let index = 0; index < 5; index += 1) {
    const itemId = `${shopId}${index}`;
    itemsByShop[shopId].push({ item_id: itemId, item_status: "NORMAL" });
    modelsByItem[itemId] = [model(`${shopId}${index}0`, `SKU-${shopId}-${index}`, "10000", "9500")];
  }
  const context = await fixture({
    shopee: fakeShopee({ shops: [shop("1", "TH"), shop("2", "TH")], itemsByShop, modelsByItem }),
    security: readySecurity({ constraints: { countries: ["TH"], shops: ["1", "2"], maxBatchItems: 5 } }),
  });
  context.access.repositories.shopeeDiscount.getStorageMode = async () => ({ dialect: "postgres", productionScale: true, pilotLimits: null });
  try {
    const preview = await context.service.createPreview(previewInput({ shopIds: ["1", "2"] }), { requestId: "two-shops" });
    await context.service.approvePreview({ planId: preview.id, merkleRoot: preview.merkleRoot,
      operatorName: "Alice", confirmationText: preview.confirmationText }, { actorId: "user" });
    const job = await context.service.requestExecution({ planId: preview.id, merkleRoot: preview.merkleRoot }, {});
    assert.equal(job.status, "PENDING");
  } finally { await context.close(); }
});
