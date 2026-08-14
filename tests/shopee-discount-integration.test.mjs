import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { runCapacityCheck } from "../scripts/shopee-discount-capacity-check.mjs";
import { createShopeeDiscountApi } from "../lib/shopee-discount/api.mjs";
import {
  ShopeeDiscountScheduler,
  resolveShopeeDiscountSchedulerReadiness,
  resolveShopeeDiscountSchedulerStartup,
} from "../lib/shopee-discount/scheduler.mjs";
import { openCommerceDataAccess } from "../lib/data/data-access.mjs";
import { FoundationService } from "../lib/foundation/foundation-service.mjs";
import { ShopeeDiscountService } from "../lib/shopee-discount/service.mjs";
import { runApprovedPlan } from "../lib/shopee-discount/executor.mjs";

const NOW = new Date("2026-08-14T10:00:00.000Z");

function writeSecurity() {
  return {
    enabled: true,
    mode: "trusted_single_role",
    safeStatus: { enabled: true, reasonCode: "SHOPEE_WRITE_ENABLED" },
    constraints: { countries: ["TH"], shops: ["1"], maxBatchItems: 10 },
  };
}

function warehouseSnapshot(skus) {
  const watermark = "2026-08-14T09:00:00.000Z";
  return {
    status: "READY",
    rows: skus.map((sku) => ({
      sku, country: "TH", category: "HOME", platform: "SHOPEE", status: "ACTIVE",
      dailyMinor: "9000", eventMinor: null, megaMinor: null,
      dailyApprovedAt: "2026-08-14T08:00:00.000Z", eventApprovedAt: null, megaApprovedAt: null, watermark,
    })),
    warnings: [],
    evidence: { watermark, scope: { country: "TH", category: "HOME", skus } },
  };
}

function integrationShopee() {
  const items = ["10", "11", "12"].map((item_id) => ({ item_id, item_status: "NORMAL" }));
  const models = {
    10: [{ model_id: "100", model_sku: "SKU-DRIFT", model_status: "NORMAL", original_price_minor: "10000", current_discount_minor: "9500" }],
    11: [{ model_id: "101", model_sku: "SKU-OK", model_status: "NORMAL", original_price_minor: "10000", current_discount_minor: "9500" }],
    12: [{ model_id: "102", model_sku: "SKU-UNKNOWN", model_status: "NORMAL", original_price_minor: "10000", current_discount_minor: "9500" }],
  };
  const starts = String((NOW.getTime() - 60_000) / 1_000);
  const ends = String((NOW.getTime() + 86_400_000) / 1_000);
  return {
    async listShops() { return { data: { shops: [{ shop_id: "1", country: "TH", shop_name: "Integration", healthy: true }] } }; },
    async listActiveItems({ cursor }) { return { data: { item: cursor === "0" ? items : [], has_next_page: false } }; },
    async getItemBaseInfo({ itemIds }) { return { data: { item_list: itemIds.map((item_id) => ({ item_id, item_status: "NORMAL" })) } }; },
    async getModelList({ itemId }) { return { data: { model: models[itemId] } }; },
    async listDiscounts() { return { data: { discount_list: [{ discount_id: "900", status: "ongoing", start_time: starts, end_time: ends }], more: false } }; },
    async getDiscount() {
      return { data: { discount_id: "900", status: "ongoing", start_time: starts, end_time: ends, more: false,
        item_list: items.map(({ item_id }, index) => ({ item_id, model_list: [{ model_id: String(100 + index) }] })) } };
    },
  };
}

function createService(access) {
  const foundation = new FoundationService({ repository: access.repositories.foundation, now: () => NOW });
  const service = new ShopeeDiscountService({
    repository: access.repositories.shopeeDiscount,
    foundation,
    shopee: integrationShopee(),
    warehouse: { async scanPrices({ skus }) { return warehouseSnapshot(skus); } },
    writeSecurity,
    now: () => NOW,
    approvalTtlMs: 60 * 60_000,
    siteCapabilities: { TH: { currency: "THB", scale: 2, minMinor: "1", maxMinor: "99999999", stepMinor: "1" } },
    shardSize: 2,
  });
  return { service, foundation };
}

test("capacity check streams the locked country scale through bounded pages", async () => {
  let tick = 0;
  const report = await runCapacityCheck({
    shopCount: 1_000,
    linksPerShop: 1_000,
    variantsPerShop: 10_000,
    pageSize: 1_000,
    now: () => tick++ * 5,
    heapUsed: () => 64 * 1024 * 1024,
  });

  assert.deepEqual(report.scale, {
    shops: 1_000,
    links: 1_000_000,
    variants: 10_000_000,
  });
  assert.equal(report.pages.shops, 1);
  assert.equal(report.pages.links, 1_000);
  assert.equal(report.pages.variants, 10_000);
  assert.deepEqual(report.bounds.maxResidentComponents, {
    shopPageRecords: 1_000, sourcePageRecords: 1_000, plannerShardRecords: 1_000, activitySelectionEntries: 1_000,
  });
  assert.equal(report.bounds.maxResidentRecords, 4_000);
  assert.equal(report.productionCore.selectedVariants, 10_000_000);
  assert.equal(report.productionCore.persistedShards, 10_000);
  assert.equal(report.bounds.heapGrowthBytes, 0);
  assert.equal(report.databaseMode, "SIMULATED_PAGED_DRY_RUN");
  assert.equal(report.livePostgresqlDdlExecuted, false);
  assert.equal(report.elapsedMs, 5);
});

test("capacity check rejects unbounded pages and PostgreSQL mode without explicit configuration", async () => {
  await assert.rejects(runCapacityCheck({ pageSize: 10_001 }), { code: "SHOPEE_DISCOUNT_CAPACITY_PAGE_UNBOUNDED" });
  await assert.rejects(runCapacityCheck({ mode: "postgresql" }), { code: "SHOPEE_DISCOUNT_CAPACITY_POSTGRES_CONFIG_REQUIRED" });
});

test("PostgreSQL capacity mode proves observed totals and cursor progress", async () => {
  const exactSource = {
    async shops(cursor) {
      return cursor == null
        ? { items: [{ id: "1" }], nextCursor: "shop-1", total: 2 }
        : { items: [{ id: "2" }], nextCursor: null, total: 2 };
    },
    async links(shop, cursor) {
      return cursor == null
        ? { items: [{ id: `${shop.id}-l1` }], nextCursor: "link-1", total: 2 }
        : { items: [{ id: `${shop.id}-l2` }], nextCursor: null, total: 2 };
    },
    async variants(shop, cursor) {
      return cursor == null
        ? { items: [{ id: `${shop.id}-v1` }], nextCursor: "variant-1", total: 2 }
        : { items: [{ id: `${shop.id}-v2` }], nextCursor: null, total: 2 };
    },
  };
  const report = await runCapacityCheck({ mode: "postgresql", databaseUrl: "postgres://configured", postgresSource: exactSource,
    shopCount: 2, linksPerShop: 2, variantsPerShop: 2, pageSize: 1 });
  assert.deepEqual(report.observed, { shops: 2, links: 4, variants: 4 });

  for (const [name, source] of [
    ["empty", { ...exactSource, shops: async () => ({ items: [], nextCursor: null, total: 2 }) }],
    ["short", { ...exactSource, links: async () => ({ items: [{ id: "only" }], nextCursor: null, total: 2 }) }],
    ["duplicate cursor", { ...exactSource, variants: async () => ({ items: [{ id: "v" }], nextCursor: "same", total: 2 }) }],
    ["empty terminal page", { ...exactSource, shops: async (cursor) => cursor == null
      ? { items: [{ id: "1" }], nextCursor: "second", total: 2 }
      : cursor === "second" ? { items: [{ id: "2" }], nextCursor: "surplus", total: 2 }
        : { items: [], nextCursor: null, total: 2 } }],
  ]) {
    await assert.rejects(runCapacityCheck({ mode: "postgresql", databaseUrl: "postgres://configured", postgresSource: source,
      shopCount: 2, linksPerShop: 2, variantsPerShop: 2, pageSize: 1 }), { code: "SHOPEE_DISCOUNT_CAPACITY_INCOMPLETE" }, name);
  }

  const intermediateShort = {
    async shops() { return { items: [{ id: "1" }], nextCursor: null, total: 1 }; },
    async variants() { return { items: [{ id: "v1" }], nextCursor: null, total: 1 }; },
    async links(_shop, cursor) {
      if (cursor == null) return { items: [{ id: "l1" }], nextCursor: "a", total: 4 };
      if (cursor === "a") return { items: [{ id: "l2" }, { id: "l3" }], nextCursor: "b", total: 4 };
      return { items: [{ id: "l4" }], nextCursor: null, total: 4 };
    },
  };
  await assert.rejects(runCapacityCheck({ mode: "postgresql", databaseUrl: "postgres://configured",
    postgresSource: intermediateShort, shopCount: 1, linksPerShop: 4, variantsPerShop: 1, pageSize: 2 }),
  { code: "SHOPEE_DISCOUNT_CAPACITY_INCOMPLETE" });
});

test("root scheduler startup remains disabled until every preview and reminder gate is configured", () => {
  const complete = {
    SHOPEE_DISCOUNT_SCHEDULER_ENABLED: "true",
    SHOPEE_DISCOUNT_SCHEDULER_SHOP_IDS: "1,2",
    SHOPEE_DISCOUNT_SHOP_TIMEZONES_JSON: JSON.stringify({ 1: "Asia/Bangkok", 2: "Asia/Bangkok" }),
    SHOPEE_DISCOUNT_WAREHOUSE_BASE_URL: "https://warehouse.internal.example",
    SHOPEE_DISCOUNT_DINGTALK_CONFIG_ID: "discount-ops-group",
    SHOPEE_DISCOUNT_ENTRY_BASE_URL: "http://127.0.0.1:3101/discount",
  };
  for (const missing of [
    "SHOPEE_DISCOUNT_SCHEDULER_SHOP_IDS",
    "SHOPEE_DISCOUNT_SHOP_TIMEZONES_JSON",
    "SHOPEE_DISCOUNT_WAREHOUSE_BASE_URL",
    "SHOPEE_DISCOUNT_DINGTALK_CONFIG_ID",
    "SHOPEE_DISCOUNT_ENTRY_BASE_URL",
  ]) {
    assert.equal(resolveShopeeDiscountSchedulerStartup({ ...complete, [missing]: "" }).enabled, false, missing);
  }
  assert.equal(resolveShopeeDiscountSchedulerStartup({ ...complete, SHOPEE_DISCOUNT_WAREHOUSE_BASE_URL: "http://warehouse" }).enabled, false);
  assert.deepEqual(resolveShopeeDiscountSchedulerStartup(complete), {
    enabled: true,
    reasonCode: "SHOPEE_DISCOUNT_SCHEDULER_READY",
    shopIds: ["1", "2"],
    shopTimeZones: { 1: "Asia/Bangkok", 2: "Asia/Bangkok" },
    warehouseBaseUrl: "https://warehouse.internal.example",
  });
});

test("scheduler readiness verifies durable keys, shop authorization, and the enabled DingTalk group before READY", async () => {
  const env = {
    SHOPEE_DISCOUNT_SCHEDULER_ENABLED: "true",
    SHOPEE_DISCOUNT_SCHEDULER_SHOP_IDS: "1",
    SHOPEE_DISCOUNT_SHOP_TIMEZONES_JSON: JSON.stringify({ 1: "Asia/Bangkok" }),
    SHOPEE_DISCOUNT_WAREHOUSE_BASE_URL: "HTTPS://warehouse.example/path",
    SHOPEE_DISCOUNT_DINGTALK_CONFIG_ID: "group",
    SHOPEE_DISCOUNT_ENTRY_BASE_URL: "http://localhost/discount",
  };
  const probes = {
    async getDiscountSettings() { return { encryptedWarehouseKeyCiphertext: "cipher" }; },
    async verifyWarehouseKey() { return true; },
    async listAuthorizedShops() { return [{ shopId: "1", authorized: true }]; },
    async getDingTalkConfig() { return { id: "group", enabled: true }; },
  };
  const ready = await resolveShopeeDiscountSchedulerReadiness({ env, ...probes });
  assert.equal(ready.enabled, true);
  assert.equal(ready.warehouseBaseUrl, "https://warehouse.example/path");
  for (const [override, reasonCode] of [
    [{ getDiscountSettings: async () => ({}) }, "SHOPEE_DISCOUNT_SCHEDULER_WAREHOUSE_KEY_REQUIRED"],
    [{ verifyWarehouseKey: async () => false }, "SHOPEE_DISCOUNT_SCHEDULER_WAREHOUSE_KEY_INVALID"],
    [{ listAuthorizedShops: async () => [] }, "SHOPEE_DISCOUNT_SCHEDULER_SHOP_AUTH_REQUIRED"],
    [{ getDingTalkConfig: async () => ({ enabled: false }) }, "SHOPEE_DISCOUNT_SCHEDULER_DINGTALK_UNAVAILABLE"],
  ]) {
    const result = await resolveShopeeDiscountSchedulerReadiness({ env, ...probes, ...override });
    assert.equal(result.enabled, false);
    assert.equal(result.reasonCode, reasonCode);
  }
});

test("frontend manual scan traverses the real API and scheduler into a Foundation reminder and DingTalk delivery", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shopee-discount-client-e2e-"));
  const access = openCommerceDataAccess({ rootDir: path.resolve("."), databasePath: path.join(root, "commerce.sqlite"),
    migrationsDir: path.resolve("migrations") });
  const { service, foundation } = createService(access);
  const handler = createShopeeDiscountApi({ service, maxBodyBytes: 1024 });
  const originalFetch = globalThis.fetch;
  const originalSessionStorage = globalThis.sessionStorage;
  const deliveries = [];
  globalThis.sessionStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
  globalThis.fetch = async (input, init = {}) => {
    const raw = init.body == null ? "" : String(init.body);
    const req = Readable.from(raw ? [Buffer.from(raw)] : []);
    req.method = init.method || "GET";
    req.headers = Object.fromEntries(new Headers(init.headers));
    req.auditContext = { requestId: "client-e2e", actorIdentifier: "operator-1", authorizedShopIds: ["1"], annotate() {} };
    const res = {
      statusCode: 500, body: "", writeHead(status) { this.statusCode = status; }, end(chunk = "") { this.body += chunk; },
    };
    await handler(req, res, new URL(String(input), "http://localhost"));
    return new Response(res.body, { status: res.statusCode, headers: { "content-type": "application/json" } });
  };
  try {
    const client = await import(new URL("../frontend/commerce-ops-vue/src/services/shopee-discount.ts", import.meta.url).href);
    const scanJob = await client.requestDiscountScan("TH", ["1"]);
    assert.equal(scanJob.jobType, "MANUAL_SCAN");

    const scheduler = new ShopeeDiscountScheduler({
      repository: access.repositories.shopeeDiscount, foundation, ownerId: "client-e2e-worker", now: () => NOW,
      externalTaskPolicy: { status: () => ({ enabled: true, state: "active" }), assertAllowed() {} },
      scan: async ({ country, shopIds, dueJobId }) => {
        await access.repositories.shopeeDiscount.createDueJob({ jobType: "REMINDER", dedupeKey: `reminder:${dueJobId}`,
          dueAt: NOW, payload: { country, shopId: shopIds[0], planId: "manual-scan-followup", severity: "INFO" } });
        return { checkedShops: shopIds.length };
      },
      notifications: { async sendReminder(payload) { deliveries.push(payload); return { status: "SENT" }; } },
    });
    const scanOutcome = await scheduler.tick({ enqueueDaily: false });
    const reminderOutcome = await scheduler.tick({ enqueueDaily: false });
    assert.deepEqual(scanOutcome.map(({ status }) => status), ["SUCCEEDED"]);
    assert.deepEqual(reminderOutcome.map(({ status }) => status), ["SUCCEEDED"]);
    assert.equal(reminderOutcome[0].result.notification.status, "SENT");
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].shopId, "1");
    const tasks = await access.repositories.foundation.listTasks({ limit: 20 });
    const reminderTask = tasks.find(({ taskKind }) => taskKind === "shopee_discount_renewal_reminder");
    assert.ok(reminderTask);
    assert.equal(reminderTask.input.planId, "manual-scan-followup");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.sessionStorage = originalSessionStorage;
    access.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SQLite integration survives restart without replaying an UNKNOWN write", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shopee-discount-integration-"));
  const databasePath = path.join(root, "commerce.sqlite");
  let clock = new Date(NOW);
  let access = openCommerceDataAccess({ rootDir: path.resolve("."), databasePath, migrationsDir: path.resolve("migrations") });
  access.repositories.shopeeDiscount.now = () => new Date(clock);
  const writeCalls = [];
  try {
    let { service, foundation } = createService(access);
    const preview = await service.createPreview({
      country: "TH", shopIds: ["1"], workflow: "CURRENT_CORRECTION", defaultTier: "DAILY",
      shopOverrides: [], linkOverrides: [], category: "HOME",
      activitySelection: [{ shopId: "1", discountId: "900", priceTier: "DAILY" }],
    }, { actorId: "operator-1", requestId: "integration-preview" });
    assert.equal(preview.summary.counts.ready, 3);
    await service.approvePreview({
      planId: preview.id, merkleRoot: preview.merkleRoot,
      operatorName: "Alice", confirmationText: preview.confirmationText,
    }, { actorId: "operator-1" });
    const job = await service.requestExecution({ planId: preview.id, merkleRoot: preview.merkleRoot }, {
      actorId: "operator-1", identity: "trusted-worker",
    });
    const context = {
      repository: access.repositories.shopeeDiscount,
      foundation,
      workerId: "worker-before-restart",
      requestId: "integration-execute-1",
      identity: "trusted-worker",
      currentPolicyHash: service.policy().hash,
      leaseMs: 5_000,
      writeSecurity,
      storageLimits: { maxShops: 1, maxVariants: 10 },
      siteCapability: { priceScale: 2, maxAddItems: 10 },
      readers: {
        async getShopAuthorization() { return { authorized: true }; },
        async getWarehouseState({ item }) {
          return { targetPriceMinor: item.sku === "SKU-DRIFT" ? "8800" : item.targetPriceMinor,
            watermark: item.payload.warehouseWatermark, approvedAt: item.payload.warehouseApprovedAt };
        },
        async getListingState({ item }) { return { status: "ACTIVE", sku: item.sku, originalPriceMinor: item.payload.originalMinor }; },
        async getDiscountState() { return { conflict: false, activityId: "900", membership: true }; },
        async readbackIntent({ item }) {
          return { activityId: "900", platformObjectId: "900", membership: true,
            itemId: item.itemId, modelId: item.modelId, priceMinor: item.targetPriceMinor };
        },
      },
      shopeeWrite: {
        async updateDiscountItems(input) {
          writeCalls.push(input);
          if (input.items[0].models[0].modelId === "102") {
            throw Object.assign(new Error("response lost"), { code: "SHOPEE_WRITE_UNKNOWN" });
          }
          return { data: {} };
        },
        async addDiscountItems() { throw new Error("unexpected add"); },
      },
      now: () => new Date(clock),
    };
    const blocked = await runApprovedPlan(preview.id, context);
    assert.equal(blocked.status, "BLOCKED");
    assert.equal(blocked.counts.REQUIRES_REAPPROVAL, 1);
    assert.equal(blocked.counts.SUCCEEDED, 1);
    assert.equal(blocked.counts.UNKNOWN, 1);
    assert.equal(writeCalls.length, 2);
    assert.equal((await access.repositories.shopeeDiscount.getJob(job.id)).status, "RUNNING");
    const discoverableUnknown = await service.listUnknownIntents({ limit: 10 }, { identity: { actorId: "operator-1" }, authorizedShopIds: ["1"] });
    assert.equal(discoverableUnknown.length, 1);
    assert.equal(discoverableUnknown[0].intentId, discoverableUnknown[0].id);

    access.close();
    clock = new Date(NOW.getTime() + 10_000);
    access = openCommerceDataAccess({ rootDir: path.resolve("."), databasePath, migrationsDir: path.resolve("migrations") });
    access.repositories.shopeeDiscount.now = () => new Date(clock);
    ({ service, foundation } = createService(access));
    const resumed = await runApprovedPlan(preview.id, {
      ...context,
      repository: access.repositories.shopeeDiscount,
      foundation,
      workerId: "worker-after-restart",
      requestId: "integration-execute-2",
      readers: { ...context.readers, async readbackIntent({ item }) {
        return { activityId: "900", platformObjectId: "900", membership: true,
          itemId: item.itemId, modelId: item.modelId, priceMinor: item.targetPriceMinor };
      } },
    });
    assert.equal(resumed.status, "PARTIAL_SUCCESS");
    assert.equal(resumed.counts.SUCCEEDED, 2);
    assert.equal(resumed.counts.REQUIRES_REAPPROVAL, 1);
    assert.equal(writeCalls.length, 2, "restart must coordinate the original intent without another POST");
  } finally {
    access?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SQLite migrations are fresh-install, 027-upgrade, and reopen idempotent through indexed baseline lookup", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shopee-discount-migrations-"));
  const initialMigrations = path.join(root, "migrations-through-027");
  const databasePath = path.join(root, "commerce.sqlite");
  await fs.mkdir(initialMigrations);
  const migrationNames = (await fs.readdir(path.resolve("migrations"))).filter((name) => name.endsWith(".sql"));
  for (const name of migrationNames.filter((candidate) => !/^(?:028|029|030|031|032|033|034)_shopee_discount/.test(candidate))) {
    await fs.copyFile(path.resolve("migrations", name), path.join(initialMigrations, name));
  }
  try {
    let access = openCommerceDataAccess({ rootDir: path.resolve("."), databasePath, migrationsDir: initialMigrations });
    let versions = access.provider.connection.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map(({ version }) => version);
    assert.equal(versions.includes("027_shopee_discount.sql"), true);
    assert.equal(versions.includes("032_shopee_discount_notification_legacy_sending.sql"), false);
    access.close();

    access = openCommerceDataAccess({ rootDir: path.resolve("."), databasePath, migrationsDir: path.resolve("migrations") });
    versions = access.provider.connection.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map(({ version }) => version);
    assert.deepEqual(versions.filter((version) => /shopee_discount/.test(version)), [
      "027_shopee_discount.sql",
      "028_shopee_discount_execution.sql",
      "029_shopee_discount_intent_attempts.sql",
      "030_shopee_discount_notification_delivery.sql",
      "031_shopee_discount_notification_coordination.sql",
      "032_shopee_discount_notification_legacy_sending.sql",
      "033_shopee_discount_baseline_lookup.sql",
      "034_shopee_discount_preview_fencing.sql",
    ]);
    const columns = access.provider.connection.prepare("PRAGMA table_info('shopee_discount_notifications')").all().map(({ name }) => name);
    assert.equal(columns.includes("coordination_state"), true);
    const eventColumns = access.provider.connection.prepare("PRAGMA table_info('shopee_discount_events')").all().map(({ name }) => name);
    assert.equal(eventColumns.includes("baseline_shop_id"), true);
    const planColumns = access.provider.connection.prepare("PRAGMA table_info('shopee_discount_plans')").all().map(({ name }) => name);
    assert.equal(planColumns.includes("preview_owner_epoch"), true);
    const shardColumns = access.provider.connection.prepare("PRAGMA table_info('shopee_discount_plan_shards')").all().map(({ name }) => name);
    assert.equal(shardColumns.includes("content_hash"), true);
    const queryPlan = access.provider.connection.prepare(`EXPLAIN QUERY PLAN SELECT evidence_json FROM shopee_discount_events
      WHERE event_type='WAREHOUSE_BASELINE' AND baseline_country=? AND baseline_category=?
      AND baseline_shop_id IS ? AND baseline_tier=? ORDER BY occurred_at DESC,id DESC LIMIT 1`)
      .all("TH", "HOME", "1", "DAILY").map(({ detail }) => detail).join(" ");
    assert.match(queryPlan, /idx_shopee_discount_events_baseline_scope/);
    access.close();

    access = openCommerceDataAccess({ rootDir: path.resolve("."), databasePath, migrationsDir: path.resolve("migrations") });
    const reopened = access.provider.connection.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map(({ version }) => version);
    assert.deepEqual(reopened, versions);
    access.close();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
