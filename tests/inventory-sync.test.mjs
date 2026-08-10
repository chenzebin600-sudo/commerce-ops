import assert from "node:assert/strict";
import test from "node:test";
import { encryptSecret } from "../lib/mabang-scheduler/crypto.mjs";
import { InventorySyncService, inventorySyncInternals } from "../lib/inventory-sync/inventory-sync-service.mjs";

process.env.APP_ENCRYPTION_KEY ||= "inventory-sync-test-key";

function listing(shopId, internalId, variants) {
  return {
    shop_id: shopId,
    shop_name: `Shop ${shopId}`,
    internal_id: internalId,
    product_id: `product-${internalId}`,
    title: `Product ${internalId}`,
    variants,
  };
}

test("prepare merges concurrent reads, compacts rows, reuses snapshots, and honors force refresh", async () => {
  const account = {
    id: "account-1", name: "Main", username: "operator", usernameMasked: "op***or",
    enabled: true, passwordConfigured: true, encryptedPassword: encryptSecret("secret"),
  };
  let workerCalls = 0;
  let savedSnapshot = null;
  const service = new InventorySyncService({
    accountRepository: { list: () => [account], get: () => account },
    operationPlans: {},
    listingClient: {
      async login() {},
      async shopeeShops() { return [{ id: "shop-1", name: "Shop 1", site: "MY" }]; },
    },
    ensureListingService: async () => ({ ok: true }),
    runWorker: async (payload) => {
      workerCalls += 1;
      assert.equal(payload.compact, true);
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { records: [
        { 库存SKU编号: "SKU-A", 仓库: "仓库 A", 可用库存量: 4, 无用字段: "不会持久化" },
        { 库存SKU编号: "sku-a", 仓库: "仓库 A", 可用库存量: 6, 无用字段: "不会持久化" },
      ], summary: { rows: 2 } };
    },
    snapshotStore: {
      async save(snapshot) { savedSnapshot = structuredClone(snapshot); },
      async loadLatest() { return savedSnapshot && structuredClone(savedSnapshot); },
    },
    now: () => new Date("2026-08-06T10:00:00.000Z"),
  });

  const [first, joined] = await Promise.all([
    service.prepare({ accountProfileId: "account-1" }),
    service.prepare({ accountProfileId: "account-1" }),
  ]);
  assert.equal(workerCalls, 1);
  assert.equal(first.snapshot.id, joined.snapshot.id);
  assert.equal(first.snapshot.rowCount, 2);
  assert.equal(first.snapshot.compactRowCount, 1);
  assert.equal(savedSnapshot.records[0]["可用库存量"], 10);
  assert.equal(Object.hasOwn(savedSnapshot.records[0], "无用字段"), false);

  const reused = await service.prepare({ accountProfileId: "account-1" });
  assert.equal(reused.snapshot.reused, true);
  assert.equal(workerCalls, 1);

  const refreshed = await service.prepare({ accountProfileId: "account-1", forceRefresh: true });
  assert.equal(refreshed.snapshot.reused, false);
  assert.equal(workerCalls, 2);
});

test("shared inventory allocation subtracts safety stock and never duplicates the pool", () => {
  const inventory = inventorySyncInternals.aggregateInventory([
    { 库存SKU编号: "SKU-A", 仓库: "马来-A仓", 可用库存量: 11 },
    { 库存SKU编号: "SKU-A", 仓库: "其他仓", 可用库存量: 50 },
  ], ["马来-A仓"]);
  const rows = inventorySyncInternals.flattenListings([
    listing("shop-1", "listing-1", [
      { variant_id: "v1", sku: "SELLER-A1", stock_sku: "SKU-A", stock: 1 },
      { variant_id: "v2", sku: "SELLER-A2", stock_sku: "SKU-A", stock: 1 },
      { variant_id: "v3", sku: "SELLER-X", stock_sku: "SKU-X", stock: 2 },
    ]),
  ], ["shop-1"]);
  const items = inventorySyncInternals.buildPlanItems(rows, inventory.bySku, {
    safetyStock: 3,
    perListingCap: 999,
  });
  const matched = items.filter((item) => item.normalizedStockSku === "SKU-A");
  assert.deepEqual(matched.map((item) => item.targetStock), [4, 4]);
  assert.equal(matched.reduce((total, item) => total + item.targetStock, 0), 8);
  assert.equal(items.find((item) => item.sellerSku === "SELLER-X").reasonCode, "INVENTORY_SKU_NOT_FOUND");
});

test("inventory execution hash ignores unrelated SKU movement", () => {
  const before = [
    { 库存SKU编号: "SKU-A", 仓库: "马来-A仓", 可用库存量: 10 },
    { 库存SKU编号: "UNRELATED", 仓库: "马来-A仓", 可用库存量: 20 },
  ];
  const after = [
    { 库存SKU编号: "SKU-A", 仓库: "马来-A仓", 可用库存量: 10 },
    { 库存SKU编号: "UNRELATED", 仓库: "马来-A仓", 可用库存量: 3 },
  ];
  assert.equal(
    inventorySyncInternals.inventoryScopeHash(before, ["马来-A仓"], ["SKU-A"]),
    inventorySyncInternals.inventoryScopeHash(after, ["马来-A仓"], ["SKU-A"]),
  );
  assert.notEqual(
    inventorySyncInternals.inventoryScopeHash(before, ["马来-A仓"]),
    inventorySyncInternals.inventoryScopeHash(after, ["马来-A仓"]),
  );
});

test("inventory pools isolate shop allocation and detect stock moving across warehouses", () => {
  const pools = inventorySyncInternals.normalizeInventoryPools([
    { id: "my", name: "马来库存池", shopIds: ["shop-my"], warehouseNames: ["马来仓"] },
    { id: "ph", name: "菲律宾库存池", shopIds: ["shop-ph"], warehouseNames: ["菲律宾仓"] },
  ]);
  const records = [
    { 库存SKU编号: "SKU-A", 仓库: "马来仓", 可用库存量: 10 },
    { 库存SKU编号: "SKU-A", 仓库: "菲律宾仓", 可用库存量: 30 },
  ];
  const listings = [
    listing("shop-my", "listing-my", [{ variant_id: "v-my", sku: "SELLER-MY", stock_sku: "SKU-A", stock: 0 }]),
    listing("shop-ph", "listing-ph", [{ variant_id: "v-ph", sku: "SELLER-PH", stock_sku: "SKU-A", stock: 0 }]),
  ];
  const items = pools.flatMap((pool) => inventorySyncInternals.buildPlanItems(
    inventorySyncInternals.flattenListings(listings, pool.shopIds).map((row) => ({ ...row, inventoryPoolId: pool.id })),
    inventorySyncInternals.aggregateInventory(records, pool.warehouseNames).bySku,
    { safetyStock: 2, perListingCap: 999 },
  ));
  assert.equal(items.find((item) => item.shopId === "shop-my").targetStock, 8);
  assert.equal(items.find((item) => item.shopId === "shop-ph").targetStock, 28);

  const moved = [
    { 库存SKU编号: "SKU-A", 仓库: "马来仓", 可用库存量: 9 },
    { 库存SKU编号: "SKU-A", 仓库: "菲律宾仓", 可用库存量: 31 },
  ];
  assert.notEqual(
    inventorySyncInternals.inventoryScopeHash(records, ["马来仓"], ["SKU-A"]),
    inventorySyncInternals.inventoryScopeHash(moved, ["马来仓"], ["SKU-A"]),
  );
  assert.throws(
    () => inventorySyncInternals.normalizeInventoryPools([
      { id: "shared", shopIds: ["shop-1", "shop-2"], warehouseNames: ["共享仓"] },
    ]),
    (error) => error.code === "INVENTORY_SYNC_POOL_SHOP_SHARING_FORBIDDEN",
  );
  const repeatedWarehousePools = inventorySyncInternals.normalizeInventoryPools([
      { id: "one", shopIds: ["shop-1"], warehouseNames: ["共享仓"] },
      { id: "two", shopIds: ["shop-2"], warehouseNames: ["共享仓"] },
  ]);
  assert.equal(repeatedWarehousePools.length, 2);
  assert.deepEqual(repeatedWarehousePools.map((pool) => pool.shopIds), [["shop-1"], ["shop-2"]]);
});

test("missing stock_sku falls back only when seller SKU exactly exists in inventory", () => {
  const inventory = inventorySyncInternals.aggregateInventory([
    { 库存SKU编号: "T3AA2124955", 仓库: "泗水仓", 可用库存量: 9 },
    { 库存SKU编号: "T5AA3483973", 仓库: "泗水仓", 可用库存量: 7 },
  ], ["泗水仓"]);
  const rows = inventorySyncInternals.flattenListings([
    listing("shop-1", "listing-1", [
      { variant_id: "v1", sku: "t3aa2124955", stock_sku: "", stock: 2 },
      { variant_id: "v2", sku: "T3AA2123973", stock_sku: "", stock: 2 },
      { variant_id: "v3", sku: "T3AA2123973X", stock_sku: "", stock: 2 },
      { variant_id: "v4", sku: "NOT-IN-INVENTORY", stock_sku: "", stock: 2 },
    ]),
  ], ["shop-1"]);
  const items = inventorySyncInternals.buildPlanItems(rows, inventory.bySku, {
    safetyStock: 1,
    perListingCap: 999,
  });
  const matched = items.find((item) => item.sellerSku === "t3aa2124955");
  assert.equal(matched.status, "READY");
  assert.equal(matched.stockSku, "T3AA2124955");
  assert.equal(matched.stockSkuSource, "seller_sku_exact_inventory_match");
  assert.equal(matched.targetStock, 8);
  const rebind = items.find((item) => item.sellerSku === "T3AA2123973");
  assert.equal(rebind.reasonCode, "SELLER_SKU_REBIND_REQUIRED");
  assert.deepEqual(rebind.candidateStockSkus, [{ stockSku: "T5AA3483973", availableQuantity: 7 }]);
  assert.equal(items.find((item) => item.sellerSku === "T3AA2123973X").reasonCode, "COMBO_SKU_MAPPING_REQUIRED");
  assert.equal(items.find((item) => item.sellerSku === "NOT-IN-INVENTORY").reasonCode, "SELLER_SKU_NOT_IN_INVENTORY");
});

test("blocked combo SKUs do not prevent ordinary exact SKUs from remaining executable", () => {
  const inventory = inventorySyncInternals.aggregateInventory([
    { 库存SKU编号: "SKU-A", 仓库: "泗水仓", 可用库存量: 10 },
  ], ["泗水仓"]);
  const rows = inventorySyncInternals.flattenListings([
    listing("shop-1", "listing-1", [
      { variant_id: "v1", sku: "SKU-A", stock_sku: "", stock: 1 },
      { variant_id: "v2", sku: "T3AA2123973X", stock_sku: "", stock: 1 },
    ]),
  ], ["shop-1"]);
  const items = inventorySyncInternals.buildPlanItems(rows, inventory.bySku, {
    safetyStock: 2,
    perListingCap: 999,
  });
  assert.equal(items.find((item) => item.sellerSku === "SKU-A").status, "READY");
  assert.equal(items.find((item) => item.sellerSku === "T3AA2123973X").reasonCode, "COMBO_SKU_MAPPING_REQUIRED");
});

test("execution rebases changed inventory downward and isolates unsafe items", () => {
  const currentListings = [listing("shop-1", "listing-1", [
    { variant_id: "v1", sku: "SKU-A", stock_sku: "SKU-A", stock: 1 },
    { variant_id: "v2", sku: "SKU-B", stock_sku: "SKU-B", stock: 1 },
  ])];
  const plan = {
    scope: {
      shopIds: ["shop-1"],
      warehouseNames: ["SG-A"],
      inventoryPools: [{ id: "pool-1", name: "SG", shopIds: ["shop-1"], warehouseNames: ["SG-A"] }],
    },
    policy: { safetyStock: 2, perListingCap: 999 },
    items: [
      { ...inventorySyncInternals.flattenListings(currentListings, ["shop-1"])[0], inventoryPoolId: "pool-1", inventoryPoolName: "SG", status: "READY", stockSku: "SKU-A", targetStock: 8 },
      { ...inventorySyncInternals.flattenListings(currentListings, ["shop-1"])[1], inventoryPoolId: "pool-1", inventoryPoolName: "SG", status: "READY", stockSku: "SKU-B", targetStock: 8 },
    ],
  };
  const rebased = inventorySyncInternals.rebaseExecutionItems(plan, currentListings, [
    { 库存SKU编号: "SKU-A", 仓库: "SG-A", 可用库存量: 9 },
  ]);
  assert.equal(rebased.plannedCount, 2);
  assert.equal(rebased.executable.length, 1);
  assert.equal(rebased.executable[0].sellerSku, "SKU-A");
  assert.equal(rebased.executable[0].targetStock, 7);
  assert.equal(rebased.adjusted.length, 1);
  assert.equal(rebased.skipped.length, 1);
  assert.equal(rebased.skipped[0].sellerSku, "SKU-B");
  assert.equal(rebased.skipped[0].reasonCode, "INVENTORY_SKU_NOT_FOUND");
});

test("inventory sync service creates, approves and executes a read-backed plan", async () => {
  const account = {
    id: "account-1",
    name: "Main",
    username: "operator",
    usernameMasked: "op***or",
    enabled: true,
    passwordConfigured: true,
    encryptedPassword: encryptSecret("secret"),
  };
  let storedPlan = null;
  const operationPlans = {
    async list() { return storedPlan ? [storedPlan] : []; },
    async create(input) {
      storedPlan = { ...input, id: "plan-1", state: "PREVIEWED", planHash: "hash-1", result: {}, createdAt: "2026-08-05T00:00:00.000Z", expiresAt: "2026-08-05T00:15:00.000Z" };
      return storedPlan;
    },
    async get() { return storedPlan; },
    async approve() { storedPlan = { ...storedPlan, state: "APPROVED", approvedAt: "2026-08-05T00:01:00.000Z" }; return storedPlan; },
    async beginExecution() { storedPlan = { ...storedPlan, state: "IN_FLIGHT" }; return storedPlan; },
    async finish(_id, state, options) { storedPlan = { ...storedPlan, state, result: options.result, finishedAt: "2026-08-05T00:02:00.000Z" }; return storedPlan; },
  };
  const listingRows = [listing("shop-1", "listing-1", [
    { variant_id: "v1", sku: "SELLER-A", stock_sku: "SKU-A", stock: 1 },
  ])];
  const calls = [];
  const listingClient = {
    async login(input) { calls.push(["login", input.username]); },
    async shopeeShops() { return [{ id: "shop-1", name: "Shop 1", site: "MY" }]; },
    async shopeeListings() { return listingRows; },
    async inventoryPreview(items) { calls.push(["preview", items]); return { preview_token: "preview-1", changes: [{ change_id: "change-1" }] }; },
    async executePreview() { return { job_id: "job-1" }; },
    async waitForJob(_jobId, { onProgress } = {}) {
      await onProgress?.({ state: "running", total_products: 2, processed_products: 1, successful_products: 1, failed_products: 0, message: "processing" });
      return { state: "completed", total_products: 2, processed_products: 2, successful_products: 2, failed_products: 0, results: [{ status: "success" }] };
    },
  };
  let inventoryQuantity = 10;
  const service = new InventorySyncService({
    accountRepository: { list: () => [account], get: () => account },
    operationPlans,
    listingClient,
    ensureListingService: async () => ({ ok: true }),
    runWorker: async () => ({ records: [{ 库存SKU编号: "SKU-A", 仓库: "马来-A仓", 可用库存量: inventoryQuantity }], summary: { cacheUpdateTime: "2026-08-05 08:00" } }),
    now: () => new Date("2026-08-05T00:00:00.000Z"),
  });
  const prepared = await service.prepare({ accountProfileId: "account-1" });
  const preview = await service.preview({
    snapshotId: prepared.snapshot.id,
    accountProfileId: "account-1",
    inventoryPools: [{ id: "pool-my", name: "马来库存池", shopIds: ["shop-1"], warehouseNames: ["马来-A仓"] }],
    safetyStock: 2,
    perListingCap: 999,
    multiWarehouseMode: "proportional",
  });
  assert.equal(preview.plan.summary.readyCount, 1);
  assert.equal(preview.plan.scope.inventoryPools[0].name, "马来库存池");
  assert.equal(preview.plan.sourceSnapshot.inventoryPools[0].readyStockSkus[0], "SKU-A");
  assert.equal(preview.plan.sourceSnapshot.listingRead.listingCount, 1);
  assert.equal(preview.plan.items[0].targetStock, 8);
  const previewProgress = await service.getPreviewProgress("account-1");
  assert.equal(previewProgress.progress.stage, "COMPLETED");
  assert.equal(previewProgress.progress.totalCount, 1);
  await service.approve({ planId: "plan-1", planHash: "hash-1", approvalText: preview.approvalText });
  const inventoryProgress = [];
  const result = await service.execute({ planId: "plan-1", planHash: "hash-1", onProgress: (update) => inventoryProgress.push(update) });
  assert.equal(result.state, "SUCCEEDED");
  assert.equal(calls.find(([name]) => name === "preview")[1][0].target_stock, 8);
  assert.equal(calls.find(([name]) => name === "preview")[1][0].multi_warehouse_mode, "proportional");
  assert.deepEqual([...new Set(inventoryProgress.map((item) => item.stage))], ["VALIDATING", "PREFLIGHT", "SUBMITTING", "PROCESSING", "SUCCEEDED"]);

  storedPlan = { ...storedPlan, state: "APPROVED" };
  inventoryQuantity = 9;
  const rebased = await service.execute({ planId: "plan-1", planHash: "hash-1" });
  assert.equal(rebased.state, "SUCCEEDED");
  assert.equal(calls.filter(([name]) => name === "preview").at(-1)[1][0].target_stock, 7);
  assert.equal(rebased.result.executionAdjustment.adjustedCount, 1);
  assert.equal(rebased.result.executionAdjustment.adjusted[0].approvedTarget, 8);
  assert.equal(rebased.result.executionAdjustment.adjusted[0].executionTarget, 7);

  storedPlan = { ...storedPlan, state: "APPROVED" };
  inventoryQuantity = 10;
  listingRows[0].variants[0].stock = 3;
  const onlineRebased = await service.execute({ planId: "plan-1", planHash: "hash-1" });
  assert.equal(onlineRebased.state, "SUCCEEDED");
  assert.equal(calls.filter(([name]) => name === "preview").at(-1)[1][0].target_stock, 8);
  assert.equal(onlineRebased.result.executionAdjustment.adjusted[0].onlineStockChanged, true);

  listingRows[0].variants[0].stock = 1;
  storedPlan = { ...storedPlan, state: "APPROVED" };
  inventoryQuantity = 10;
  listingClient.executePreview = async () => {
    const error = new Error("request timed out after submission");
    error.name = "TimeoutError";
    throw error;
  };
  const uncertain = await service.execute({ planId: "plan-1", planHash: "hash-1" });
  assert.equal(uncertain.state, "UNKNOWN");
});

test("Lazada sync shares the inventory workflow and records unmatched pools without stopping valid shops", async () => {
  const account = {
    id: "account-lazada", name: "Main", username: "operator", usernameMasked: "op***or",
    enabled: true, passwordConfigured: true, encryptedPassword: encryptSecret("secret"),
  };
  let storedPlan = null;
  const operationPlans = {
    async list() { return storedPlan ? [storedPlan] : []; },
    async create(input) {
      storedPlan = { ...input, id: "plan-lazada", state: "PREVIEWED", planHash: "hash-lazada", result: {}, createdAt: "2026-08-09T00:00:00.000Z", expiresAt: "2026-08-09T00:15:00.000Z" };
      return storedPlan;
    },
    async get() { return storedPlan; },
    async approve() { storedPlan = { ...storedPlan, state: "APPROVED" }; return storedPlan; },
    async beginExecution() { storedPlan = { ...storedPlan, state: "IN_FLIGHT" }; return storedPlan; },
    async finish(_id, state, options) { storedPlan = { ...storedPlan, state, result: options.result }; return storedPlan; },
  };
  const submitted = [];
  const lazadaListings = [listing("lazada-1", "listing-lazada", [
    { sku_id: "lv1", sku: "SKU-L", stock_sku: "SKU-L", stock: 1 },
  ])];
  Object.defineProperty(lazadaListings, "readMetrics", { value: { shopCount: 1, pageCount: 1, listingCount: 1, fresh: true }, enumerable: false });
  const service = new InventorySyncService({
    accountRepository: { list: () => [account], get: () => account },
    operationPlans,
    listingClient: {
      async login() {},
      async lazadaShops() { return [{ id: "lazada-1", name: "Lazada One", site: "MY" }]; },
      async lazadaListings() { return lazadaListings; },
      async inventoryPreview(items) { submitted.push(items); return { preview_token: "lazada-preview", changes: items.map((_, index) => ({ change_id: `change-${index}` })) }; },
      async executePreview() { return { job_id: "lazada-job" }; },
      async waitForJob() { return { state: "completed", total_products: 1, processed_products: 1, successful_products: 1, failed_products: 0, results: [{ status: "success" }] }; },
    },
    ensureListingService: async () => ({ ok: true }),
    runWorker: async () => ({ records: [{ 库存SKU编号: "SKU-L", 仓库: "马来仓", 可用库存量: 12 }], summary: {} }),
    now: () => new Date("2026-08-09T00:00:00.000Z"),
  });

  const prepared = await service.prepare({ accountProfileId: account.id, platform: "lazada" });
  const preview = await service.preview({
    snapshotId: prepared.snapshot.id,
    accountProfileId: account.id,
    platform: "lazada",
    inventoryPools: [
      { id: "valid", name: "有效店", shopIds: ["lazada-1"], warehouseNames: ["马来仓"] },
      { id: "missing", name: "失效店", shopIds: ["missing-shop"], warehouseNames: ["马来仓"] },
    ],
    safetyStock: 2,
    perListingCap: 999,
  });
  assert.equal(preview.plan.operationType, "MABANG.INVENTORY_SYNC.LAZADA");
  assert.equal(preview.plan.scope.platform, "lazada");
  assert.equal(preview.plan.summary.readyCount, 1);
  assert.equal(preview.plan.summary.skippedInventoryPoolCount, 1);
  assert.equal(preview.plan.items.find((item) => item.reasonCode === "SHOP_NOT_FOUND").status, "BLOCKED");
  await service.approve({ planId: storedPlan.id, planHash: storedPlan.planHash, approvalText: preview.approvalText });
  const result = await service.execute({ planId: storedPlan.id, planHash: storedPlan.planHash });
  assert.equal(result.state, "SUCCEEDED");
  assert.equal(submitted[0][0].platform, "lazada");
  assert.equal(submitted[0][0].target_stock, 10);
});

test("inventory preview splits more than 100 ready products into explicit safe batches", async () => {
  const account = {
    id: "account-1", name: "Main", username: "operator", usernameMasked: "op***or",
    enabled: true, passwordConfigured: true, encryptedPassword: encryptSecret("secret"),
  };
  let sequence = 0;
  const operationPlans = {
    async list() { return []; },
    async create(input) {
      sequence += 1;
      return { ...input, id: `plan-${sequence}`, state: "PREVIEWED", planHash: `hash-${sequence}`, createdAt: "2026-08-05T00:00:00.000Z", expiresAt: "2026-08-05T00:15:00.000Z" };
    },
  };
  const listings = Array.from({ length: 101 }, (_value, index) => listing(
    "shop-1",
    `listing-${String(index + 1).padStart(3, "0")}`,
    index === 0
      ? Array.from({ length: 450 }, (_variant, variantIndex) => ({ variant_id: `v-1-${variantIndex + 1}`, sku: "SKU-A", stock_sku: "SKU-A", stock: 0 }))
      : [{ variant_id: `v-${index + 1}`, sku: "SKU-A", stock_sku: "SKU-A", stock: 0 }],
  ));
  listings.push(listing("shop-1", "listing-unmatched", [
    { variant_id: "v-unmatched", sku: "SKU-NOT-IN-INVENTORY", stock_sku: "SKU-NOT-IN-INVENTORY", stock: 7 },
  ]));
  const service = new InventorySyncService({
    accountRepository: { list: () => [account], get: () => account },
    operationPlans,
    listingClient: {
      async login() {},
      async shopeeShops() { return [{ id: "shop-1", name: "Shop 1", site: "SG" }]; },
      async shopeeListings() { return listings; },
    },
    ensureListingService: async () => ({ ok: true }),
    runWorker: async () => ({ records: [{ 库存SKU编号: "SKU-A", 仓库: "SG-A", 可用库存量: 2025 }], summary: {} }),
    now: () => new Date("2026-08-05T00:00:00.000Z"),
  });
  const prepared = await service.prepare({ accountProfileId: "account-1" });
  const input = {
    snapshotId: prepared.snapshot.id,
    accountProfileId: "account-1",
    inventoryPools: [{ id: "pool-sg", name: "SG", shopIds: ["shop-1"], warehouseNames: ["SG-A"] }],
    safetyStock: 5,
    perListingCap: 999,
  };
  await assert.rejects(
    () => service.preview(input),
    (error) => error.code === "INVENTORY_SYNC_PRODUCT_LIMIT" && error.productBatchCount === 2,
  );
  const first = await service.preview({ ...input, productBatchNumber: 1 });
  assert.equal(first.plan.summary.uniqueProductCount, 51);
  assert.equal(first.plan.summary.readyCount, 500);
  assert.equal(first.plan.summary.totalReadyProductCount, 101);
  assert.equal(first.plan.summary.totalProductCount, 102);
  assert.equal(first.plan.summary.totalVariantCount, 551);
  assert.equal(first.plan.summary.totalBlockedVariantCount, 1);
  assert.equal(first.plan.summary.blockedCount, 1);
  assert.ok(first.plan.items.some((item) => item.internalId === "listing-unmatched" && item.status === "BLOCKED"));
  assert.equal(first.plan.summary.productBatchCount, 2);
  assert.match(first.approvalText, /第 1\/2 批/);
  const second = await service.preview({ ...input, productBatchNumber: 2 });
  assert.equal(second.plan.summary.uniqueProductCount, 50);
  assert.equal(second.plan.summary.readyCount, 50);
  assert.ok(second.plan.items.some((item) => item.internalId === "listing-unmatched" && item.status === "BLOCKED"));
  assert.match(second.approvalText, /第 2\/2 批/);

  const deferred = await service.preview({
    ...input,
    productBatchNumber: 1,
    excludedProducts: [{ shopId: "shop-1", internalId: "listing-001" }],
  });
  assert.equal(deferred.plan.summary.productBatchCount, 1);
  assert.equal(deferred.plan.summary.uniqueProductCount, 100);
  assert.equal(deferred.plan.summary.deferredProductCount, 1);
  assert.equal(deferred.plan.summary.deferredVariantCount, 450);
  assert.ok(deferred.plan.items.some((item) => item.internalId === "listing-001"
    && item.status === "BLOCKED" && item.reasonCode === "DEFERRED_AFTER_BATCH_FAILURE"));

  const targeted = await service.preview({
    ...input,
    selectedProducts: [{ shopId: "shop-1", internalId: "listing-050" }],
  });
  assert.equal(targeted.plan.summary.uniqueProductCount, 1);
  assert.equal(targeted.plan.summary.readyCount, 1);
  assert.equal(targeted.plan.summary.totalReadyProductCount, 101);
  assert.equal(targeted.plan.summary.selectedReadyProductCount, 1);
  assert.deepEqual(targeted.plan.scope.selectedProducts, [{ shopId: "shop-1", internalId: "listing-050" }]);
  assert.match(targeted.approvalText, /专项验证 1 个商品/);
  assert.ok(targeted.plan.items.every((item) => item.internalId === "listing-050"));

  const targetedItem = await service.preview({
    ...input,
    selectedItems: [{ shopId: "shop-1", internalId: "listing-050", variationId: "v-50" }],
  });
  assert.equal(targetedItem.plan.summary.readyCount, 1);
  assert.equal(targetedItem.plan.summary.selectedReadyVariantCount, 1);
  assert.deepEqual(targetedItem.plan.scope.selectedItems, [{ shopId: "shop-1", internalId: "listing-050", variationId: "v-50" }]);
  assert.match(targetedItem.approvalText, /专项验证 1 个规格/);
  assert.deepEqual(targetedItem.plan.items.map((item) => item.variationId), ["v-50"]);

  await assert.rejects(
    () => service.preview({ ...input, selectedProducts: [{ shopId: "shop-1", internalId: "missing" }] }),
    (error) => error.code === "INVENTORY_SYNC_SELECTED_PRODUCT_NOT_FOUND",
  );
});

test("ordinary Seller SKU rebind uses a separate approved plan and excludes combo SKUs", async () => {
  const account = {
    id: "account-1", name: "Main", username: "operator", usernameMasked: "op***or",
    enabled: true, passwordConfigured: true, encryptedPassword: encryptSecret("secret"),
  };
  const plans = new Map();
  let sequence = 0;
  let unrelatedQuantity = 99;
  const operationPlans = {
    async list() { return [...plans.values()]; },
    async create(input) {
      const id = `plan-${++sequence}`;
      const plan = { ...input, id, state: "PREVIEWED", planHash: `hash-${sequence}`, result: {}, createdAt: "2026-08-05T00:00:00.000Z", expiresAt: "2026-08-05T00:15:00.000Z" };
      plans.set(id, plan);
      return plan;
    },
    async get(id) { return plans.get(id) || null; },
    async approve(id) { const plan = { ...plans.get(id), state: "APPROVED" }; plans.set(id, plan); return plan; },
    async beginExecution(id) { const plan = { ...plans.get(id), state: "IN_FLIGHT" }; plans.set(id, plan); return plan; },
    async finish(id, state, options) { const plan = { ...plans.get(id), state, result: options.result }; plans.set(id, plan); return plan; },
  };
  const listings = [
    listing("shop-1", "listing-1", [
      { variant_id: "v1", sku: "T3AA2123973", stock_sku: "", stock: 1 },
      { variant_id: "v2", sku: "T3AA2123973X", stock_sku: "", stock: 1 },
    ]),
    listing("shop-1", "listing-2", [
      { variant_id: "v3", sku: "MANUAL-SELLER-A", stock_sku: "", stock: 1 },
    ]),
  ];
  const calls = [];
  const listingClient = {
    async login() {},
    async shopeeShops() { return [{ id: "shop-1", name: "Shop 1", site: "MY" }]; },
    async shopeeListings() { return listings; },
    async skuRebindPreview(items) {
      calls.push(items);
      return { preview_token: "rebind-preview", changes: items.map((item, index) => ({ change_id: `change-${index + 1}` })) };
    },
    async executePreview() {
      for (const change of calls[0]) {
        const product = listings.find((item) => item.internal_id === change.internal_id);
        const variant = product?.variants.find((item) => item.sku === change.from_sku);
        if (variant) variant.sku = change.to_sku;
      }
      return { job_id: "job-rebind" };
    },
    async waitForJob(_jobId, { onProgress } = {}) {
      await onProgress?.({ state: "running", total_products: 2, processed_products: 1, successful_products: 1, failed_products: 0, message: "processing" });
      return { state: "completed", total_products: 2, processed_products: 2, successful_products: 2, failed_products: 0, results: [{ status: "success" }] };
    },
  };
  const service = new InventorySyncService({
    accountRepository: { list: () => [account], get: () => account },
    operationPlans,
    listingClient,
    ensureListingService: async () => ({ ok: true }),
    runWorker: async () => ({ records: [
      { 库存SKU编号: "T5AA3483973", 仓库: "马来-A仓", 可用库存量: 20 },
      { 库存SKU编号: "MANUAL-STOCK-A", 仓库: "马来-A仓", 可用库存量: 12 },
      { 库存SKU编号: "UNRELATED-STOCK", 仓库: "马来-A仓", 可用库存量: unrelatedQuantity },
    ], summary: {} }),
    now: () => new Date("2026-08-05T00:00:00.000Z"),
  });
  const prepared = await service.prepare({ accountProfileId: "account-1" });
  const inventoryPreview = await service.preview({
    snapshotId: prepared.snapshot.id,
    accountProfileId: "account-1",
    shopIds: ["shop-1"],
    warehouseNames: ["马来-A仓"],
    safetyStock: 2,
    perListingCap: 999,
  });
  assert.equal(inventoryPreview.plan.items.find((item) => item.sellerSku.endsWith("X")).reasonCode, "COMBO_SKU_MAPPING_REQUIRED");
  await operationPlans.approve(inventoryPreview.plan.id);
  await assert.rejects(
    () => service.previewRebind({
      sourcePlanId: inventoryPreview.plan.id,
      sourcePlanHash: inventoryPreview.plan.planHash,
      mappings: [{ fromSku: "MANUAL-SELLER-A", toSku: "UNKNOWN-STOCK" }],
    }),
    (error) => error.code === "SKU_REBIND_MAPPING_TARGET_NOT_FOUND",
  );
  const rebindPreview = await service.previewRebind({
    sourcePlanId: inventoryPreview.plan.id,
    sourcePlanHash: inventoryPreview.plan.planHash,
    mappings: [{ fromSku: "MANUAL-SELLER-A", toSku: "MANUAL-STOCK-A" }],
  });
  assert.equal(rebindPreview.plan.summary.readyCount, 2);
  assert.equal(rebindPreview.plan.items.find((item) => item.fromSku === "T3AA2123973").toSku, "T5AA3483973");
  assert.equal(rebindPreview.plan.items.find((item) => item.fromSku === "MANUAL-SELLER-A").reasonCode, "MANUAL_CONFIRMED_INVENTORY_SKU");
  await service.approveRebind({ planId: rebindPreview.plan.id, planHash: rebindPreview.plan.planHash, approvalText: rebindPreview.approvalText });
  unrelatedQuantity = 7;
  const progress = [];
  const executed = await service.executeRebind({ planId: rebindPreview.plan.id, planHash: rebindPreview.plan.planHash, onProgress: (update) => progress.push(update) });
  assert.equal(executed.state, "SUCCEEDED");
  assert.equal(executed.result.verification.verifiedCount, 2);
  assert.equal(executed.result.verification.failedCount, 0);
  assert.equal(calls[0].length, 2);
  assert.deepEqual(calls[0].map((item) => item.to_sku).sort(), ["MANUAL-STOCK-A", "T5AA3483973"]);
  assert.deepEqual([...new Set(progress.map((item) => item.stage))], ["VALIDATING", "PREFLIGHT", "SUBMITTING", "PROCESSING", "READBACK", "SUCCEEDED"]);
  assert.equal(progress.at(-1).percent, 100);
});
