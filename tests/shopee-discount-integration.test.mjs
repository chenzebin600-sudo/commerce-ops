import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCapacityCheck } from "../scripts/shopee-discount-capacity-check.mjs";
import { resolveShopeeDiscountSchedulerStartup } from "../lib/shopee-discount/scheduler.mjs";
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
  assert.equal(report.bounds.maxResidentRecords, 1_000);
  assert.equal(report.bounds.heapGrowthBytes, 0);
  assert.equal(report.databaseMode, "SIMULATED_PAGED_DRY_RUN");
  assert.equal(report.livePostgresqlDdlExecuted, false);
  assert.equal(report.elapsedMs, 5);
});

test("capacity check rejects unbounded pages and PostgreSQL mode without explicit configuration", async () => {
  await assert.rejects(runCapacityCheck({ pageSize: 10_001 }), { code: "SHOPEE_DISCOUNT_CAPACITY_PAGE_UNBOUNDED" });
  await assert.rejects(runCapacityCheck({ mode: "postgresql" }), { code: "SHOPEE_DISCOUNT_CAPACITY_POSTGRES_CONFIG_REQUIRED" });
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
  });
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

test("SQLite migrations are fresh-install, 027-upgrade, and reopen idempotent through notification coordination", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shopee-discount-migrations-"));
  const initialMigrations = path.join(root, "migrations-through-027");
  const databasePath = path.join(root, "commerce.sqlite");
  await fs.mkdir(initialMigrations);
  const migrationNames = (await fs.readdir(path.resolve("migrations"))).filter((name) => name.endsWith(".sql"));
  for (const name of migrationNames.filter((candidate) => !/^(?:028|029|030|031|032)_shopee_discount/.test(candidate))) {
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
    ]);
    const columns = access.provider.connection.prepare("PRAGMA table_info('shopee_discount_notifications')").all().map(({ name }) => name);
    assert.equal(columns.includes("coordination_state"), true);
    access.close();

    access = openCommerceDataAccess({ rootDir: path.resolve("."), databasePath, migrationsDir: path.resolve("migrations") });
    const reopened = access.provider.connection.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map(({ version }) => version);
    assert.deepEqual(reopened, versions);
    access.close();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
