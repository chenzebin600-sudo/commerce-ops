import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openCommerceDataAccess } from "../lib/data/data-access.mjs";
import { FoundationService } from "../lib/foundation/foundation-service.mjs";
import { parseShopeeProductReference, ShopeeDiscountService } from "../lib/shopee-discount/service.mjs";
import { schedulerRequestId } from "../lib/shopee-discount/scheduler.mjs";

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
      const fallback = [{ discount_id: "900", status: "ongoing", start_time: String(NOW.getTime() / 1000 - 3600), end_time: String(NOW.getTime() / 1000 + 86400) }];
      return { data: { discount_list: Object.hasOwn(discountsByShop, shopId) ? discountsByShop[shopId] : fallback, more: false }, requestId: "discounts-request", attempts: 1 };
    },
    async getDiscount({ discountId }) {
      return { data: discountDetails[discountId] || { discount_id: discountId, status: "ongoing", start_time: String(NOW.getTime() / 1000 - 3600),
        end_time: String(NOW.getTime() / 1000 + 86400), item_list: [], more: false }, requestId: "discount-request", attempts: 1 };
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
    foundation,
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
    activitySelection: overrides.workflow === "NEXT_RENEWAL" ? [] : [{ shopId: "1", discountId: "900", priceTier: "DAILY" }],
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

test("current preview rejects a selected Discount that is absent or outside its ongoing window", async () => {
  for (const shopee of [
    fakeShopee({ itemsByShop: { "1": [{ item_id: "10", item_status: "NORMAL" }] }, modelsByItem: { "10": [model("100", "SKU", "10000", "9500")] }, discountsByShop: { "1": [] } }),
    fakeShopee({ itemsByShop: { "1": [{ item_id: "10", item_status: "NORMAL" }] }, modelsByItem: { "10": [model("100", "SKU", "10000", "9500")] },
      discountsByShop: { "1": [{ discount_id: "900", status: "ongoing", start_time: "1", end_time: "2" }] },
      discountDetails: { "900": { discount_id: "900", status: "ongoing", start_time: "1", end_time: "2", item_list: [] } } }),
  ]) {
    const context = await fixture({ shopee });
    try {
      const preview = await context.service.createPreview(previewInput(), {});
      assert.equal(preview.summary.counts.ready, 0);
      assert.equal(preview.summary.codes.CURRENT_ACTIVITY_AMBIGUOUS, 1);
    } finally { await context.close(); }
  }
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

test("renewal preview persists its immutable activity marker and warehouse approval time for execution", async () => {
  const shopee = fakeShopee({
    itemsByShop: { "1": [{ item_id: "10", item_status: "NORMAL" }] },
    modelsByItem: { "10": [model("100", "SKU", "10000", "9500")] },
  });
  const context = await fixture({ shopee });
  try {
    const preview = await context.service.createPreview(previewInput({
      workflow: "NEXT_RENEWAL",
      renewal: { requestedStartAt: "2026-08-15T00:00:00.000Z", durationDays: 30 },
    }), { requestId: "renewal-preview" });
    const [activity] = await context.access.repositories.shopeeDiscount.listPlanActivities(preview.id);
    assert.equal(activity.activityType, "NEXT_RENEWAL");
    assert.match(activity.metadata.discountName, /^PM-TH-DAILY-2026-08-15-[A-F0-9]{8}$/);
    assert.match(activity.metadata.fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(activity.metadata.workflow, "NEXT_RENEWAL");
    assert.equal(activity.metadata.priceTier, "DAILY");
    const page = await context.service.listPreviewItems(preview.id, { pageSize: 10 }, {});
    assert.equal(page.items[0].payload.warehouseApprovedAt, "2026-08-13T08:00:00.000Z");
  } finally { await context.close(); }
});

test("renewal identity uses each shop override tier and approval binds the stored target fields", async () => {
  const shopee = fakeShopee({
    shops: [shop("1", "TH"), shop("2", "TH")],
    itemsByShop: {
      "1": [{ item_id: "10", item_status: "NORMAL" }],
      "2": [{ item_id: "20", item_status: "NORMAL" }],
    },
    modelsByItem: {
      "10": [model("100", "SKU-A", "10000", "9500")],
      "20": [model("200", "SKU-B", "10000", "9500")],
    },
  });
  const warehouse = { async scanPrices({ skus }) {
    return warehouseSnapshot(skus.map((sku) => ({ sku, dailyMinor: "9000", eventMinor: "8800" })));
  } };
  const context = await fixture({ shopee, warehouse });
  try {
    context.access.repositories.shopeeDiscount.getStorageMode = async () => ({ dialect: "postgres", productionScale: true, pilotLimits: null });
    const preview = await context.service.createPreview(previewInput({
      shopIds: ["1", "2"],
      workflow: "NEXT_RENEWAL",
      renewal: { requestedStartAt: "2026-08-15T00:00:00.000Z", durationDays: 30 },
      shopOverrides: [{ shopId: "2", priceTier: "EVENT" }],
    }), { requestId: "renewal-tier-preview" });
    const activities = await context.access.repositories.shopeeDiscount.listPlanActivities(preview.id);
    assert.deepEqual(activities.map(({ shopId, metadata }) => [shopId, metadata.priceTier]), [["1", "DAILY"], ["2", "EVENT"]]);
    assert.match(activities[1].metadata.discountName, /^PM-TH-EVENT-/);
    const page = await context.service.listPreviewItems(preview.id, { pageSize: 10 }, {});
    assert.deepEqual(page.items.map(({ shopId, payload }) => [shopId, payload.approvalTarget.renewalPriceTier]), [["1", "DAILY"], ["2", "EVENT"]]);
  } finally { await context.close(); }
});

test("a normal renewal preview can be approved, queued, and executed without live Shopee", async () => {
  const shopee = fakeShopee({
    itemsByShop: { "1": [{ item_id: "10", item_status: "NORMAL" }] },
    modelsByItem: { "10": [model("100", "SKU", "10000", "9500")] },
  });
  const context = await fixture({ shopee });
  try {
    await context.access.repositories.shopeeDiscount.saveSettings(
      { encryptedWarehouseKeyCiphertext: "cipher-generation-1" }, { actorId: "test" },
    );
    const preview = await context.service.createPreview(previewInput({
      workflow: "NEXT_RENEWAL",
      renewal: { requestedStartAt: "2026-08-15T00:00:00.000Z", durationDays: 30 },
    }), { requestId: "renewal-e2e-preview" });
    assert.equal(preview.summary.settingsGeneration, 1);
    await context.service.approvePreview({
      planId: preview.id,
      merkleRoot: preview.merkleRoot,
      operatorName: "Alice",
      confirmationText: preview.confirmationText,
    }, { actorId: "session-user" });
    await context.service.requestExecution({ planId: preview.id, merkleRoot: preview.merkleRoot }, { identity: "shared" });
    const writes = [];
    const workerContext = {
      repository: context.access.repositories.shopeeDiscount,
      foundation: context.foundation,
      workerId: "worker-e2e",
      requestId: "renewal-e2e-execute",
      identity: "shared",
      currentPolicyHash: preview.policyHash,
      now: () => NOW,
      leaseMs: 1_000,
      writeSecurity: () => readySecurity(),
      siteCapability: { priceScale: 2, maxAddItems: 10 },
      shopeeWrite: {
        async createDiscount(input) { writes.push({ operation: "createDiscount", input }); return { data: {} }; },
        async addDiscountItems(input) { writes.push({ operation: "addDiscountItems", input }); return { data: {} }; },
        async updateDiscountItems(input) { writes.push({ operation: "updateDiscountItems", input }); return { data: {} }; },
      },
      readers: {
        async findActivityByMarker() { return null; },
        async getShopAuthorization() { return { authorized: true }; },
        async getWarehouseState({ item }) {
          return { targetPriceMinor: item.targetPriceMinor, watermark: item.payload.warehouseWatermark, approvedAt: item.payload.warehouseApprovedAt };
        },
        async getListingState({ item }) { return { status: "ACTIVE", sku: item.sku, originalPriceMinor: item.payload.originalMinor }; },
        async getDiscountState({ activity }) { return { conflict: false, activityId: activity.platformActivityId, membership: false }; },
        async readbackIntent({ intent, item, activity }) {
          return item
            ? { platformObjectId: "901", activityId: "901", membership: true, itemId: item.itemId, modelId: item.modelId, priceMinor: item.targetPriceMinor }
            : { verified: true, platformObjectId: "901", markerVerified: true, activityId: "901", operationUuid: intent.operationUuid,
              payloadHash: intent.payloadHash, shopId: activity.shopId, discountName: activity.metadata.discountName,
              marker: activity.metadata.marker, fingerprint: activity.metadata.fingerprint,
              startTime: String(new Date(activity.startsAt).getTime() / 1000), endTime: String(new Date(activity.endsAt).getTime() / 1000) };
        },
      },
    };
    const { runApprovedPlan } = await import("../lib/shopee-discount/executor.mjs");
    const summary = await runApprovedPlan(preview.id, workerContext);
    assert.equal(summary.status, "SUCCEEDED");
    assert.deepEqual(writes.map(({ operation }) => operation), ["createDiscount", "addDiscountItems"]);
  } finally { await context.close(); }
});

test("a committed scheduler preview replays to the same domain and Foundation plan after due-job crash", async () => {
  const context = await fixture();
  try {
    const input = previewInput({
      workflow: "NEXT_RENEWAL",
      renewal: { requestedStartAt: "2026-08-15T00:00:00.000Z", durationDays: 30 },
    });
    const requestId = schedulerRequestId("due-renewal-crash-1");
    const first = await context.service.createPreview(input, { actorId: "shopee-discount-scheduler", requestId });
    const replayed = await context.service.createPreview(input, { actorId: "shopee-discount-scheduler", requestId });
    assert.equal(replayed.id, first.id);
    assert.equal(replayed.foundationPlanId, first.foundationPlanId);
    assert.equal((await context.access.repositories.shopeeDiscount.listPlans()).length, 1);
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
    discountsByShop: { "1": [{ discount_id: "900", status: "ongoing", discount_name: "External Sale", start_time: String(Math.floor((NOW.getTime() - 60 * 60_000) / 1000)), end_time: String(Math.floor((NOW.getTime() + 60 * 60_000) / 1000)) }] },
    discountDetails: { "900": { discount_id: "900", status: "ongoing", discount_name: "External Sale", start_time: String(Math.floor((NOW.getTime() - 60 * 60_000) / 1000)), end_time: String(Math.floor((NOW.getTime() + 60 * 60_000) / 1000)), item_list: [{ item_id: "10", model_list: [{ model_id: "100" }] }], more: false } },
  });
  const noSelection = await fixture({ shopee });
  try {
    const result = await noSelection.service.createPreview(previewInput({ activitySelection: [] }), {});
    assert.equal(result.summary.codes.EXTERNAL_ACTIVITY_TIER_REQUIRED, 1);
    assert.equal(result.summary.codes.CURRENT_ACTIVITY_TARGET_REQUIRED, 2);
    assert.equal(result.summary.codes.NEXT_PLAN_REQUIRED, undefined);
    assert.equal(result.summary.counts.ready, 0);
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
    assert.equal(result.summary.counts.ready, 0);
    assert.equal(result.summary.codes.DISCOUNT_OVERLAP, 1);
    assert.equal(result.summary.codes.CURRENT_ACTIVITY_AMBIGUOUS, 1);
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
    discountsByShop: { "1": [{ discount_id: "900", status: "ongoing", discount_name: "External-DAILY-Sale", start_time: String(Math.floor((NOW.getTime() - 60 * 60_000) / 1000)), end_time: ending }] },
    discountDetails: { "900": { discount_id: "900", status: "ongoing", discount_name: "External-DAILY-Sale", start_time: String(Math.floor((NOW.getTime() - 60 * 60_000) / 1000)), end_time: ending, item_list: [{ item_id: "10", model_list: [{ model_id: "100" }] }] } },
  });
  const context = await fixture({ shopee });
  try {
    const external = await context.service.createPreview(previewInput({ activitySelection: [] }), {});
    assert.equal(external.summary.codes.EXTERNAL_ACTIVITY_TIER_REQUIRED, 1);
    assert.equal(external.summary.codes.CURRENT_ACTIVITY_ENDING_SOON, undefined);
  } finally { await context.close(); }

  shopee.getDiscount = async () => ({ data: { discount_id: "900", status: "ongoing", discount_name: "External-DAILY-Sale",
    start_time: String(Math.floor((NOW.getTime() - 60 * 60_000) / 1000)), end_time: ending,
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
    discountsByShop: { "1": [{ discount_id: "900", status: "ongoing", discount_name: "Arbitrary Name", start_time: String(Math.floor((NOW.getTime() - 60 * 60_000) / 1000)), end_time: ending }] },
    discountDetails: { "900": { discount_id: "900", status: "ongoing", discount_name: "Arbitrary Name", start_time: String(Math.floor((NOW.getTime() - 60 * 60_000) / 1000)), end_time: ending,
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
    assert.equal(preview.summary.codes.CURRENT_ACTIVITY_TARGET_STALE, 1);
    assert.equal((await stored.service.listPreviewItems(preview.id, {}, { authorizedShopIds: ["1"] })).items.length, 0);
  } finally { await stored.close(); }
});

test("current preview uses one exact persisted system activity without an explicit selection", async () => {
  const startTime = String(Math.floor((NOW.getTime() - 60 * 60_000) / 1000));
  const endTime = String(Math.floor((NOW.getTime() + 24 * 60 * 60_000) / 1000));
  const shopee = fakeShopee({
    itemsByShop: { "1": [{ item_id: "10", item_status: "NORMAL" }] },
    modelsByItem: { "10": [model("100", "SKU", "10000", "9500")] },
    discountsByShop: { "1": [{ discount_id: "900", status: "ongoing", start_time: startTime, end_time: endTime }] },
    discountDetails: { "900": { discount_id: "900", status: "ongoing", start_time: startTime, end_time: endTime, item_list: [] } },
  });
  const context = await fixture({ shopee });
  try {
    const repository = context.access.repositories.shopeeDiscount;
    const stored = await repository.createPlan({
      id: "exact-system-activity", country: "TH",
      activities: [{ shopId: "1", platformActivityId: "900", metadata: { systemManaged: true, priceTier: "EVENT" } }],
      targetStartsAt: new Date(Number(startTime) * 1000).toISOString(),
      targetEndsAt: new Date(Number(endTime) * 1000).toISOString(),
      sourceSnapshotHash: "exact-snapshot", policyHash: "exact-policy", createdBy: "system",
    });
    await repository.markPlanState({ planId: stored.id, fromState: "PREVIEWING", toState: "CANCELLED", expectedVersion: stored.stateVersion });
    const preview = await context.service.createPreview(previewInput({ activitySelection: [] }), {});
    const items = await context.service.listPreviewItems(preview.id, {}, { authorizedShopIds: ["1"] });
    assert.equal(preview.summary.counts.ready, 1);
    assert.equal(items.items[0].payload.approvalTarget.targetDiscountId, "900");
    assert.equal(items.items[0].payload.priceTier, "EVENT");
  } finally { await context.close(); }
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
      linkOverrides: [{ shopId: "1", itemId: "11", priceTier: "EVENT", note: "本期活动覆盖" }],
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
    const manualOne = await context.service.requestManualScan({ country: "TH", shopIds: ["1"] }, { authorizedShopIds: ["1"] });
    const manualTwo = await context.service.requestManualScan({ country: "TH", shopIds: ["1"] }, { authorizedShopIds: ["1"] });
    assert.notEqual(manualOne.dedupeKey, manualTwo.dedupeKey);
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

test("production preview persists deterministic shards while retaining at most one shop and one shard", async () => {
  const itemsByShop = { "1": [], "2": [] };
  const modelsByItem = {};
  for (const shopId of ["1", "2"]) for (let index = 0; index < 6; index += 1) {
    const itemId = `${shopId}${index}`;
    itemsByShop[shopId].push({ item_id: itemId, item_status: "NORMAL" });
    modelsByItem[itemId] = [model(`${shopId}${index}0`, `SKU-${shopId}-${index}`, "10000", "9500")];
  }
  const resident = [];
  let productionRoot;
  const context = await fixture({
    shopee: fakeShopee({ shops: [shop("2", "TH"), shop("1", "TH")], itemsByShop, modelsByItem }),
    security: readySecurity({ constraints: { countries: ["TH"], shops: ["1", "2"], maxBatchItems: 10 } }),
    serviceOptions: { shardSize: 4, previewObserver: (sample) => resident.push(sample) },
  });
  context.access.repositories.shopeeDiscount.getStorageMode = async () => ({ dialect: "postgres", productionScale: true, pilotLimits: null });
  try {
    const preview = await context.service.createPreview(previewInput({ shopIds: ["2", "1"], activitySelection: [
      { shopId: "2", discountId: "900", priceTier: "DAILY" },
      { shopId: "1", discountId: "900", priceTier: "DAILY" },
    ] }), { requestId: "bounded-production-preview" });
    productionRoot = preview.merkleRoot;
    assert.equal(preview.itemCount, 12);
    assert.equal(Math.max(...resident.map(({ shopVariants }) => shopVariants)), 6);
    assert.equal(Math.max(...resident.map(({ shardBuffer }) => shardBuffer)), 4);
    assert.equal(resident.every(({ countryVariants }) => countryVariants == null), true);
    assert.equal(resident.every(({ activitySelectionShopCount }) => activitySelectionShopCount === 2), true);
    const page = await context.access.repositories.shopeeDiscount.listPlanItems(preview.id, { pageSize: 100 });
    assert.deepEqual(page.items.map((item) => item.shopId), ["1", "1", "1", "1", "1", "1", "2", "2", "2", "2", "2", "2"]);
  } finally { await context.close(); }

  const legacy = await fixture({
    shopee: fakeShopee({ shops: [shop("1", "TH"), shop("2", "TH")], itemsByShop, modelsByItem }),
    security: readySecurity({ constraints: { countries: ["TH"], shops: ["1", "2"], maxBatchItems: 10 } }),
    serviceOptions: { shardSize: 4 },
  });
  legacy.access.repositories.shopeeDiscount.getStorageMode = async () => ({ dialect: "sqlite", productionScale: false,
    pilotLimits: { shops: 100, variants: 1_000 } });
  try {
    const preview = await legacy.service.createPreview(previewInput({ shopIds: ["1", "2"], activitySelection: [
      { shopId: "1", discountId: "900", priceTier: "DAILY" },
      { shopId: "2", discountId: "900", priceTier: "DAILY" },
    ] }), { requestId: "legacy-equivalence" });
    assert.equal(preview.merkleRoot, productionRoot);
  } finally { await legacy.close(); }
});

test("concurrent production previews with one request converge while conflicting payload is rejected", async () => {
  const shopee = fakeShopee({ itemsByShop: { "1": [{ item_id: "10", item_status: "NORMAL" }] },
    modelsByItem: { "10": [model("100", "SKU", "10000", "9500")] } });
  const context = await fixture({ shopee });
  context.access.repositories.shopeeDiscount.getStorageMode = async () => ({ dialect: "postgres", productionScale: true, pilotLimits: null });
  try {
    const input = previewInput();
    const settled = await Promise.allSettled([
      context.service.createPreview(input, { actorId: "operator", requestId: "same-request" }),
      context.service.createPreview(input, { actorId: "operator", requestId: "same-request" }),
    ]);
    assert.deepEqual(settled.map(({ status }) => status), ["fulfilled", "fulfilled"],
      JSON.stringify(settled.map((entry) => entry.status === "rejected" ? { code: entry.reason?.code, details: entry.reason?.details } : null)));
    const [left, right] = settled.map(({ value }) => value);
    assert.equal(left.id, right.id);
    assert.equal(left.merkleRoot, right.merkleRoot);
    assert.equal((await context.access.repositories.shopeeDiscount.getPlan(left.id)).state, "PREVIEWED");
    await assert.rejects(context.service.createPreview(previewInput({ defaultTier: "EVENT" }),
      { actorId: "operator", requestId: "same-request" }), { code: "SHOPEE_DISCOUNT_PREVIEW_SAGA_CONFLICT" });
  } finally {
    await new Promise((resolve) => setImmediate(resolve));
    await context.close();
  }
});

test("expired production preview owner resumes and verifies already persisted shards", async () => {
  const shopee = fakeShopee({ itemsByShop: { "1": [{ item_id: "10", item_status: "NORMAL" }] },
    modelsByItem: { "10": [model("100", "SKU", "10000", "9500")] } });
  const context = await fixture({ shopee });
  context.access.repositories.shopeeDiscount.getStorageMode = async () => ({ dialect: "postgres", productionScale: true, pilotLimits: null });
  const requestContext = { actorId: "operator", requestId: "crash-resume-request" };
  try {
    const first = await context.service.createPreview(previewInput(), requestContext);
    const stored = await context.access.repositories.shopeeDiscount.getPlan(first.id);
    const shardCount = context.access.provider.connection.prepare("SELECT COUNT(*) count FROM shopee_discount_plan_shards WHERE plan_id=?")
      .get(first.id).count;
    const staleSummary = { ...stored.summary, previewOwnerToken: "crashed-owner",
      previewOwnerEpoch: stored.summary.previewOwnerEpoch + 1, previewOwnerLeaseUntil: new Date(NOW.getTime() - 1).toISOString() };
    context.access.provider.connection.prepare(`UPDATE shopee_discount_plans SET state='PREVIEWING',merkle_root=NULL,
      item_count=0,shard_count=0,sealed_at=NULL,state_version=state_version+1,summary_json=?,preview_owner_token=?,
      preview_owner_epoch=?,preview_owner_lease_until=? WHERE id=?`)
      .run(JSON.stringify(staleSummary), staleSummary.previewOwnerToken, staleSummary.previewOwnerEpoch,
        staleSummary.previewOwnerLeaseUntil, first.id);

    const resumed = await context.service.createPreview(previewInput(), requestContext);
    assert.equal(resumed.id, first.id);
    assert.equal(resumed.merkleRoot, first.merkleRoot);
    assert.equal(context.access.provider.connection.prepare("SELECT COUNT(*) count FROM shopee_discount_plan_shards WHERE plan_id=?")
      .get(first.id).count, shardCount);
    assert.equal((await context.access.repositories.shopeeDiscount.getPlan(first.id)).state, "PREVIEWED");
  } finally { await context.close(); }
});

test("production preview heartbeats a single long-running shop with a virtual clock", async () => {
  let clock = new Date(NOW);
  const shopee = fakeShopee({ itemsByShop: { "1": [{ item_id: "10", item_status: "NORMAL" }] },
    modelsByItem: { "10": [model("100", "SKU", "10000", "9500")] } });
  const getModels = shopee.getModelList.bind(shopee);
  shopee.getModelList = async (input) => {
    setTimeout(() => { clock = new Date(clock.getTime() + 45); }, 12);
    setTimeout(() => { clock = new Date(clock.getTime() + 45); }, 28);
    await new Promise((resolve) => setTimeout(resolve, 55));
    return getModels(input);
  };
  const context = await fixture({ shopee, serviceOptions: {
    now: () => clock, previewLeaseMs: 60, previewHeartbeatMs: 10,
  } });
  context.access.repositories.shopeeDiscount.getStorageMode = async () => ({ dialect: "postgres", productionScale: true, pilotLimits: null });
  const claim = context.access.repositories.shopeeDiscount.claimPreviewOwnership.bind(context.access.repositories.shopeeDiscount);
  let renewals = 0;
  context.access.repositories.shopeeDiscount.claimPreviewOwnership = async (input) => { renewals += 1; return claim(input); };
  try {
    const preview = await context.service.createPreview(previewInput(), { actorId: "operator", requestId: "long-shop" });
    assert.equal(preview.state, "PREVIEWED");
    assert.ok(renewals >= 3, `expected heartbeat renewals during the shop, observed ${renewals}`);
  } finally { await context.close(); }
});

test("a stale preview owner cannot block Foundation after takeover wins the domain fence", async () => {
  const shopee = fakeShopee({ itemsByShop: { "1": [{ item_id: "10", item_status: "NORMAL" }] },
    modelsByItem: { "10": [model("100", "SKU", "10000", "9500")] } });
  const context = await fixture({ shopee });
  context.access.repositories.shopeeDiscount.getStorageMode = async () => ({ dialect: "postgres", productionScale: true, pilotLimits: null });
  const repository = context.access.repositories.shopeeDiscount;
  const bind = repository.bindFoundationPlan.bind(repository);
  repository.bindFoundationPlan = async () => { throw Object.assign(new Error("bind failed"), { code: "BIND_FAILED" }); };
  const mark = repository.markPlanState.bind(repository);
  repository.markPlanState = async (input) => {
    const stored = await repository.getPlan(input.planId);
    context.access.provider.connection.prepare(`UPDATE shopee_discount_plans SET state='PREVIEWED',merkle_root=?,
      preview_owner_token='new-owner',preview_owner_epoch=preview_owner_epoch+1 WHERE id=?`).run(stored.summary.merkleRoot, input.planId);
    return mark(input);
  };
  const block = context.foundation.operationPlans.block.bind(context.foundation.operationPlans);
  let foundationBlocks = 0;
  context.foundation.operationPlans.block = async (...args) => { foundationBlocks += 1; return block(...args); };
  try {
    await assert.rejects(context.service.createPreview(previewInput(), { actorId: "operator", requestId: "stale-block" }),
      { code: "SHOPEE_DISCOUNT_FOUNDATION_BIND_FAILED" });
    assert.equal(foundationBlocks, 0);
    const domain = (await repository.listPlans()).find(({ createdBy }) => createdBy === "operator");
    assert.equal(domain.state, "PREVIEWED");
    assert.equal((await context.foundation.operationPlans.get(`shopee-discount-${domain.summary.previewSagaId.slice(0, 40)}`)).state, "PREVIEWED");
  } finally { repository.bindFoundationPlan = bind; await context.close(); }
});

test("heartbeat failure drains the single flight and never renews after preview returns", async () => {
  const shopee = fakeShopee({ itemsByShop: { "1": [{ item_id: "10", item_status: "NORMAL" }] },
    modelsByItem: { "10": [model("100", "SKU", "10000", "9500")] } });
  shopee.getModelList = async () => { await new Promise((resolve) => setTimeout(resolve, 35)); throw new Error("planner failed"); };
  const context = await fixture({ shopee, serviceOptions: { previewLeaseMs: 100, previewHeartbeatMs: 10 } });
  context.access.repositories.shopeeDiscount.getStorageMode = async () => ({ dialect: "postgres", productionScale: true, pilotLimits: null });
  const repository = context.access.repositories.shopeeDiscount;
  const claim = repository.claimPreviewOwnership.bind(repository);
  let calls = 0, active = 0;
  repository.claimPreviewOwnership = async (input) => {
    calls += 1;
    if (calls !== 2) return claim(input);
    active += 1;
    await new Promise((resolve) => setTimeout(resolve, 250));
    active -= 1;
    throw Object.assign(new Error("renew failed"), { code: "RENEW_FAILED" });
  };
  try {
    await assert.rejects(context.service.createPreview(previewInput(), { actorId: "operator", requestId: "heartbeat-drain" }));
    assert.equal(active, 0, "preview must await its in-flight heartbeat before returning");
    const settledCalls = calls;
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(calls, settledCalls, "no heartbeat may renew after preview returns");
  } finally { await new Promise((resolve) => setTimeout(resolve, 270)); await context.close(); }
});

test("manual execution invokes only the authenticated production callback after exact approval", async () => {
  const invoked = [];
  const context = await fixture({
    shopee: fakeShopee({ itemsByShop: { "1": [{ item_id: "10", item_status: "NORMAL" }] }, modelsByItem: { "10": [model("100", "SKU", "10000", "9500")] } }),
    serviceOptions: { executeApprovedPlan: async (planId, envelope) => invoked.push({ planId, envelope }) },
  });
  try {
    const preview = await context.service.createPreview(previewInput({ workflow: "NEXT_RENEWAL", renewal: { requestedStartAt: "2026-08-15T00:00:00.000Z", durationDays: 30 } }), { requestId: "manual-runtime-preview" });
    await context.service.approvePreview({ planId: preview.id, merkleRoot: preview.merkleRoot, operatorName: "Alice", confirmationText: preview.confirmationText }, { actorId: "ops-1" });
    await context.service.requestExecution({ planId: preview.id, merkleRoot: preview.merkleRoot }, { actorId: "ops-1", identity: { actorId: "ops-1", roles: ["shopee_discount_execute"] }, requestId: "manual-runtime-execute" });
    assert.equal(invoked.length, 1);
    assert.equal(invoked[0].planId, preview.id);
    assert.equal(invoked[0].envelope.context.identity.actorId, "ops-1");
  } finally { await context.close(); }
});

test("authenticated manual execution resumes an EXECUTING job after its lease expires", async () => {
  let context;
  let calls = 0;
  let clock = new Date(NOW);
  context = await fixture({
    shopee: fakeShopee({ itemsByShop: { "1": [{ item_id: "10", item_status: "NORMAL" }] }, modelsByItem: { "10": [model("100", "SKU", "10000", "9500")] } }),
    serviceOptions: {
      now: () => new Date(clock),
      executeApprovedPlan: async (planId, { job }) => {
        calls += 1;
        if (calls !== 1) return;
        const repository = context.access.repositories.shopeeDiscount;
        const claim = await repository.claimJob({ jobId: job.id, ownerId: "crashed-worker", leaseMs: 100 });
        const plan = await repository.getPlan(planId);
        await repository.markPlanState({ planId, fromState: "APPROVED", toState: "EXECUTING", expectedVersion: plan.stateVersion });
        const foundationPlan = await context.foundation.operationPlans.get(plan.foundationPlanId);
        await context.foundation.operationPlans.beginExecution(foundationPlan.id, {
          planHash: foundationPlan.planHash,
          scope: foundationPlan.scope,
          sourceSnapshot: foundationPlan.sourceSnapshot,
          policy: foundationPlan.policy,
          items: foundationPlan.items,
          actorId: "crashed-worker",
        });
        assert.equal(claim.claimed, true);
      },
    },
  });
  context.access.repositories.shopeeDiscount.now = () => new Date(clock);
  try {
    const preview = await context.service.createPreview(previewInput({ workflow: "NEXT_RENEWAL", renewal: { requestedStartAt: "2026-08-15T00:00:00.000Z", durationDays: 30 } }), { requestId: "resume-preview" });
    await context.service.approvePreview({ planId: preview.id, merkleRoot: preview.merkleRoot, operatorName: "Alice", confirmationText: preview.confirmationText }, { actorId: "ops-1" });
    const actor = { actorId: "ops-1", identity: { actorId: "ops-1", roles: ["shopee_discount_execute"] } };
    await context.service.requestExecution({ planId: preview.id, merkleRoot: preview.merkleRoot }, actor);
    clock = new Date(NOW.getTime() + 10 * 60_000);
    const running = (await context.access.repositories.shopeeDiscount.listExecutionJobs(preview.id))[0];
    assert.equal(running.status, "RUNNING");
    assert.ok(new Date(running.leaseUntil).getTime() <= clock.getTime());
    await context.service.requestExecution({ planId: preview.id, merkleRoot: preview.merkleRoot }, actor);
    assert.equal(calls, 2);
  } finally { await context.close(); }
});

test("current correction scan reads live Discounts and produces a draft without approval or execution", async () => {
  const context = await fixture({ shopee: fakeShopee({
    itemsByShop: { "1": [{ item_id: "10", item_status: "NORMAL" }] }, modelsByItem: { "10": [model("100", "SKU", "10000", "9500")] },
    discountDetails: { "900": { discount_id: "900", status: "ongoing", start_time: String(NOW.getTime() / 1000 - 3600), end_time: String(NOW.getTime() / 1000 + 86400), item_list: [{ item_id: "10", model_list: [{ model_id: "100" }] }], more: false } },
  }) });
  try {
    const draft = await context.service.runCurrentCorrectionScan({ country: "TH", shopIds: ["1"], category: "HOME", defaultTier: "DAILY" }, { actorId: "scheduler", requestId: "scan-due-1" });
    assert.equal(draft.state, "PREVIEWED");
    assert.equal(draft.summary.counts.ready, 1);
    assert.equal((await context.access.repositories.shopeeDiscount.listExecutionJobs(draft.id)).length, 0);
  } finally { await context.close(); }
});

test("settings stay redacted, verify fail-closed, and Shopee links resolve to bounded validation echoes", async () => {
  const context = await fixture({
    shopee: fakeShopee({ itemsByShop: { "1": [{ item_id: "10", item_status: "NORMAL" }] }, modelsByItem: { "10": [model("100", "SKU-ONE", "10000", "9500"), model("101", "SKU-ONE", "10000", "9500")] } }),
    serviceOptions: { protectWarehouseKey: async (value) => `encrypted:${value.length}`, verifyWarehouseKey: async () => true },
  });
  const identity = { actorId: "admin-1", roles: ["shopee_discount_execute"] };
  try {
    const saved = await context.service.updateSettings({ enabled: true, timezone: "Asia/Bangkok", warehouseKey: "zndr_super_secret" }, { identity });
    assert.equal(saved.warehouseConfigured, true);
    assert.equal(JSON.stringify(saved).includes("super_secret"), false);
    const verified = await context.service.verifySettings({ identity });
    assert.ok(verified.warehouseKeyVerifiedAt);
    const lookup = await context.service.lookupOverrides({ country: "TH", shopIds: ["1"], query: "https://shopee.co.th/product-name-i.1.10", limit: 10 }, { requestId: "lookup-1" });
    assert.equal(lookup.parsedItemId, "10");
    assert.deepEqual(lookup.rows.map(({ shopId, itemId, sku, variantCount }) => ({ shopId, itemId, sku, variantCount })), [{ shopId: "1", itemId: "10", sku: "SKU-ONE", variantCount: 2 }]);
  } finally { await context.close(); }
});

test("Shopee product reference parser accepts only anchored canonical HTTPS links", () => {
  assert.deepEqual(parseShopeeProductReference("https://shopee.co.th/product-name-i.1.10?utm_source=ops"), { shopId: "1", itemId: "10", kind: "PRODUCT_LINK" });
  assert.deepEqual(parseShopeeProductReference("https://shopee.sg/product/2/20"), { shopId: "2", itemId: "20", kind: "PRODUCT_LINK" });
  assert.equal(parseShopeeProductReference("prefix https://shopee.co.th/product-name-i.1.10 suffix"), null);
  assert.equal(parseShopeeProductReference("https://shopee.co.th.evil.example/product-name-i.1.10"), null);
  assert.equal(parseShopeeProductReference("http://shopee.co.th/product-name-i.1.10"), null);
});

test("batch override lookup scans each shop once and returns stable ordered echoes", async () => {
  const shopee = fakeShopee({ itemsByShop: { "1": [{ item_id: "10", item_status: "NORMAL" }] },
    modelsByItem: { "10": [model("100", "SKU-ONE", "10000", "9500"), model("101", "SKU-ONE", "10000", "9500")] } });
  let listingCalls = 0, modelCalls = 0;
  const listActiveItems = shopee.listActiveItems.bind(shopee), getModelList = shopee.getModelList.bind(shopee);
  shopee.listActiveItems = async (...args) => { listingCalls += 1; return listActiveItems(...args); };
  shopee.getModelList = async (...args) => { modelCalls += 1; return getModelList(...args); };
  const context = await fixture({ shopee });
  try {
    const result = await context.service.lookupOverrideBatch({ country: "TH", rows: [
      { shopId: "1", query: "https://shopee.co.th/name-i.1.10", priceTier: "EVENT", note: "same reason" },
      { shopId: "1", query: "SKU-ONE", priceTier: "EVENT", note: "same reason" },
    ] }, { requestId: "batch-lookup" });
    assert.equal(listingCalls, 1);
    assert.equal(modelCalls, 1);
    assert.deepEqual(result.rows.map(({ index, status, itemId, variantCount, finalTier }) => ({ index, status, itemId, variantCount, finalTier })), [
      { index: 0, status: "READY", itemId: "10", variantCount: 2, finalTier: "EVENT" },
    ]);
    const conflicting = await context.service.lookupOverrideBatch({ country: "TH", rows: [
      { shopId: "1", query: "10", priceTier: "EVENT", note: "first" },
      { shopId: "1", query: "SKU-ONE", priceTier: "MEGA", note: "second" },
    ] }, { requestId: "batch-conflict" });
    assert.deepEqual(conflicting.rows.map(({ status, errorCode }) => ({ status, errorCode })), [
      { status: "ERROR", errorCode: "SHOPEE_DISCOUNT_OVERRIDE_DUPLICATE_CONFLICT" },
      { status: "ERROR", errorCode: "SHOPEE_DISCOUNT_OVERRIDE_DUPLICATE_CONFLICT" },
    ]);
  } finally { await context.close(); }
});

test("warehouse verification cannot certify a credential generation changed in flight", async () => {
  let releaseVerification;
  let verificationStarted;
  const started = new Promise((resolve) => { verificationStarted = resolve; });
  const blocked = new Promise((resolve) => { releaseVerification = resolve; });
  const context = await fixture({ serviceOptions: {
    protectWarehouseKey: async (value) => `encrypted:${value}`,
    verifyWarehouseKey: async () => { verificationStarted(); await blocked; return true; },
  } });
  const identity = { actorId: "admin-1", roles: ["shopee_discount_execute"] };
  try {
    await context.service.updateSettings({ warehouseKey: "zndr_generation_A" }, { identity });
    const verification = context.service.verifySettings({ identity });
    await started;
    await context.service.updateSettings({ warehouseKey: "zndr_generation_B" }, { identity });
    releaseVerification();
    await assert.rejects(verification, { code: "SHOPEE_DISCOUNT_SETTINGS_CHANGED_REVERIFY" });
    const settings = await context.service.getSettings({ identity });
    assert.equal(settings.warehouseKeyVerifiedAt, null);
  } finally { await context.close(); }
});
