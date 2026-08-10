import assert from "node:assert/strict";
import test from "node:test";

import {
  buildInventoryConfigImportPreview,
  parseInventorySyncConfigWorkbook,
} from "../lib/inventory-sync/inventory-config-import.mjs";
import { InventorySyncService } from "../lib/inventory-sync/inventory-sync-service.mjs";

test("inventory config CSV parses the full configuration columns", () => {
  const csv = [
    "店编,马帮店名,平台,国家,当前对应仓库,同步方式,指定同步仓,主仓,副仓,SKU对应仓说明",
    "SS0001,Shop SG,Shopee,新加坡,新加坡-A仓,按对应仓库匹配,503,503,503,按马帮现有SKU仓库绑定",
  ].join("\n");
  const parsed = parseInventorySyncConfigWorkbook({ filename: "inventory.csv", buffer: Buffer.from(csv) });
  assert.equal(parsed.sheetName, "CSV");
  assert.equal(parsed.rows.length, 1);
  assert.deepEqual(parsed.rows[0].warehouses, ["新加坡-A仓"]);
  assert.equal(parsed.rows[0].syncMode, "按对应仓库匹配");
  assert.equal(parsed.rows[0].skuWarehouseNote, "按马帮现有SKU仓库绑定");
});

test("inventory config preview keeps overlapping warehouses in isolated per-shop pools", () => {
  const rows = [
    { sourceRow: 5, shopCode: "SS1", shopName: "Shop A", platform: "Shopee", country: "新加坡", countryCode: "SG", warehouses: ["仓库-A"], syncMode: "按对应仓库匹配", specifiedWarehouse: "503" },
    { sourceRow: 6, shopCode: "SS2", shopName: "Shop B", platform: "Shopee", country: "新加坡", countryCode: "SG", warehouses: ["仓库 A", "仓库B"], syncMode: "按对应仓库匹配" },
    { sourceRow: 7, shopCode: "LS1", shopName: "Shop C", platform: "Lazada", country: "新加坡", countryCode: "SG", warehouses: ["仓库B"], syncMode: "按对应仓库匹配" },
  ];
  const preview = buildInventoryConfigImportPreview({
    rows,
    shops: [
      { id: "shop-a", name: "Shop A", site: "SG" },
      { id: "shop-b", name: "Shop B", site: "SG" },
    ],
    warehouseOptions: [{ name: "仓库 A" }, { name: "仓库B" }],
  });
  assert.deepEqual(preview.summary, {
    total: 3,
    ready: 2,
    needsReview: 1,
    shopee: 2,
    lazada: 1,
    inventoryPoolCount: 2,
    warningCount: 1,
  });
  assert.deepEqual(preview.inventoryPools[0].shopIds, ["shop-a"]);
  assert.deepEqual(preview.inventoryPools[0].warehouseNames, ["仓库 A"]);
  assert.deepEqual(preview.inventoryPools[1].shopIds, ["shop-b"]);
  assert.deepEqual(preview.inventoryPools[1].warehouseNames, ["仓库 A", "仓库B"]);
  assert.match(preview.rows[0].warnings.join(" "), /当前模式下不会参与计算/);
  assert.match(preview.rows[2].issues.join(" "), /当前选择 Shopee.*跳过 Lazada/);
});

test("inventory config preview applies Lazada rows and records other platforms as skipped", () => {
  const preview = buildInventoryConfigImportPreview({
    selectedPlatform: "Lazada",
    rows: [
      { sourceRow: 2, shopCode: "L1", shopName: "Lazada A", platform: "Lazada", countryCode: "MY", warehouses: ["马来仓"], syncMode: "按对应仓库匹配" },
      { sourceRow: 3, shopCode: "S1", shopName: "Shopee A", platform: "Shopee", countryCode: "MY", warehouses: ["马来仓"], syncMode: "按对应仓库匹配" },
    ],
    shops: [{ id: "lazada-a", name: "Lazada A", site: "MY" }],
    warehouseOptions: [{ name: "马来仓" }],
  });
  assert.equal(preview.summary.ready, 1);
  assert.deepEqual(preview.inventoryPools[0].shopIds, ["lazada-a"]);
  assert.match(preview.rows[1].issues.join(" "), /当前选择 Lazada.*跳过 Shopee/);
});

test("inventory config preview rejects unsupported synchronization modes", () => {
  const preview = buildInventoryConfigImportPreview({
    rows: [{ sourceRow: 5, shopCode: "SS1", shopName: "Shop A", platform: "Shopee", countryCode: "SG", warehouses: ["仓库A"], syncMode: "主副仓" }],
    shops: [{ id: "shop-a", name: "Shop A", site: "SG" }],
    warehouseOptions: [{ name: "仓库A" }],
  });
  assert.equal(preview.summary.ready, 0);
  assert.match(preview.rows[0].issues.join(" "), /同步方式暂不支持/);
});

test("inventory sync service previews an uploaded configuration against the active snapshot", async () => {
  const csv = [
    "店编,马帮店名,平台,国家,当前对应仓库,同步方式,SKU对应仓说明",
    "SS1,Shop A,Shopee,新加坡,仓库A,按对应仓库匹配,按马帮现有SKU仓库绑定",
  ].join("\n");
  const snapshot = {
    id: "snapshot-1",
    accountProfileId: "account-1",
    capturedAt: "2026-08-07T09:00:00.000Z",
    expiresAt: "2026-08-07T10:00:00.000Z",
    sourceRowCount: 1,
    records: [{ 库存SKU编号: "SKU-A", 仓库: "仓库A", 可用库存量: 5 }],
    shops: [{ id: "shop-a", name: "Shop A", site: "SG" }],
    summary: {},
    hash: "snapshot-hash",
  };
  const service = new InventorySyncService({
    accountRepository: {},
    operationPlans: {},
    runWorker: async () => ({}),
    listingClient: {},
    ensureListingService: async () => ({ ok: true }),
    snapshotStore: { async loadLatest() { return snapshot; } },
    now: () => new Date("2026-08-07T09:10:00.000Z"),
  });
  const result = await service.previewConfigImport({
    accountProfileId: "account-1",
    snapshotId: "snapshot-1",
    filename: "config.csv",
    fileBase64: Buffer.from(csv).toString("base64"),
  });
  assert.equal(result.summary.ready, 1);
  assert.deepEqual(result.inventoryPools[0].shopIds, ["shop-a"]);
});
