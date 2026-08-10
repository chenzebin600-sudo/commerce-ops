import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  PRODUCT_PACKAGE_SOURCE_COLUMNS,
  PRODUCT_PACKAGE_SOURCE_FIELDS,
  buildProductPackageSourceRowKey,
  createProductPackageSnapshotHasher,
  normalizeProductPackageSourceRow,
} from "../lib/product-package-sync/product-package-source-contract.mjs";
import { resolveProductPackageSourceConfig } from "../lib/product-package-sync/mysql-product-package-source.mjs";
import { ProductPackageScheduleRunner, shanghaiScheduleState } from "../lib/product-package-sync/product-package-schedule-runner.mjs";
import { ProductPackageSyncService } from "../lib/product-package-sync/product-package-sync-service.mjs";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function sourceRow(overrides = {}) {
  return {
    ...Object.fromEntries(PRODUCT_PACKAGE_SOURCE_COLUMNS.map((column) => [column, null])),
    period: "202608",
    stock_sku: "M4AA3088820",
    warehouse_id: "1064350",
    warehouse_name: "Malaysia warehouse A",
    sales_sku: "AA8820",
    country: "MY",
    sku_name_cn: "electric standing desk",
    parent_category_name: "living room furniture",
    category_name: "standing desks",
    time_created: "2025-09-09",
    period_created: "2025-09-09",
    case_size: "60*80cm",
    net_weight: "14394.00",
    weight: "15798.00",
    length: "91.50",
    width: "38.00",
    height: "16.50",
    carton_size: 1,
    delivery_mode: "FCL",
    sales_cost: "285.0900",
    exchange_rate: "0.595000",
    sales_cost_ori: "169.6286",
    update_time: "2026-08-05 06:16:53",
    stock_status: "3",
    style_name: "electric standing desk",
    style_number: "5D0219",
    saleSpec: "solid wood board",
    storage: 3,
    jointRate: "0.21",
    monthNum: 20,
    picture: "https://example.invalid/reference.jpg",
    ...overrides,
  };
}

test("AI_Project_A product package contract maps every source column and keeps images as source facts only", () => {
  assert.equal(PRODUCT_PACKAGE_SOURCE_FIELDS.length, 62);
  assert.equal(new Set(PRODUCT_PACKAGE_SOURCE_COLUMNS).size, 62);
  const normalized = normalizeProductPackageSourceRow(sourceRow(), 2);
  assert.equal(normalized.productKey, "MY|M4AA3088820");
  assert.equal(normalized.normalizedPayload.product_name, "electric standing desk");
  assert.equal(normalized.normalizedPayload.main_sku_code, "AA8820");
  assert.equal(normalized.normalizedPayload.lifecycle_status, "ACTIVE");
  assert.equal(normalized.normalizedPayload.exchange_direction, "local_per_cny");
  assert.equal(normalized.normalizedPayload.cost_cny, 285.09);
  assert.equal(normalized.normalizedPayload.cost_local, 169.6286);
  assert.equal(normalized.normalizedPayload.source_picture_url, "https://example.invalid/reference.jpg");
  assert.equal(normalized.normalizedPayload.price_tier_45, null);
  assert.equal(normalized.normalizedPayload.target_price_50, 339.2572);
  assert.match(normalized.sourceRowKey, /^[a-f0-9]{64}$/);
  assert.match(normalized.productId, /^[a-f0-9-]{36}$/);
});

test("source row identity is stable while every source field participates in change hashing", () => {
  const first = normalizeProductPackageSourceRow(sourceRow(), 2);
  const renamed = normalizeProductPackageSourceRow(sourceRow({ sku_name_cn: "renamed product" }), 2);
  assert.equal(first.sourceRowKey, renamed.sourceRowKey);
  assert.notEqual(first.rowSha256, renamed.rowSha256);
  assert.equal(buildProductPackageSourceRowKey(sourceRow()), first.sourceRowKey);
  const hasher = createProductPackageSnapshotHasher();
  hasher.update(first);
  const snapshot = hasher.digest();
  assert.equal(snapshot.rowCount, 1);
  assert.match(snapshot.sha256, /^[a-f0-9]{64}$/);
});

test("product package source reuses the approved AI_Project_A connection unless dedicated values are supplied", () => {
  const shared = resolveProductPackageSourceConfig({
    PRICE_CONTROL_MYSQL_HOST: "10.0.0.1",
    PRICE_CONTROL_MYSQL_DATABASE: "AI_Project_A",
    PRICE_CONTROL_MYSQL_USER: "reader",
    PRICE_CONTROL_MYSQL_PASSWORD: "secret",
  });
  assert.equal(shared.configured, true);
  assert.equal(shared.host, "10.0.0.1");
  assert.equal(shared.database, "AI_Project_A");
  const dedicated = resolveProductPackageSourceConfig({
    PRODUCT_PACKAGE_MYSQL_HOST: "10.0.0.2",
    PRODUCT_PACKAGE_MYSQL_DATABASE: "catalog",
    PRODUCT_PACKAGE_MYSQL_USER: "catalog_reader",
    PRODUCT_PACKAGE_MYSQL_PASSWORD: "dedicated",
    PRICE_CONTROL_MYSQL_HOST: "10.0.0.1",
  });
  assert.equal(dedicated.host, "10.0.0.2");
  assert.equal(dedicated.database, "catalog");
});

test("daily scheduler runs at or after 09:00 Asia/Shanghai and relies on the durable daily claim", async () => {
  assert.deepEqual(shanghaiScheduleState(new Date("2026-08-07T00:59:00.000Z")), {
    scheduleDate: "2026-08-07", hour: 8, minute: 59,
  });
  const calls = [];
  let now = new Date("2026-08-07T00:59:00.000Z");
  const runner = new ProductPackageScheduleRunner({
    enabled: true,
    now: () => now,
    service: { sync: async (input) => { calls.push(input); return input; } },
  });
  assert.equal(await runner.runDue(), null);
  now = new Date("2026-08-07T01:00:00.000Z");
  await runner.runDue();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].scheduleDate, "2026-08-07");
  assert.equal(calls[0].triggerType, "scheduled");
});

test("sync service stages a lossless snapshot and does not replace unchanged rows", async () => {
  const staged = [];
  const updates = [];
  const repository = {
    isReady: async () => true,
    getActiveRun: async () => null,
    createRun: async () => ({ claimed: true, run: { id: "run-1" } }),
    reconcile: async ({ loadRows }) => {
      const loaded = await loadRows(async (rows) => staged.push(...rows));
      return {
        changed: false,
        importBatchId: null,
        sourceCount: staged.length,
        localBefore: staged.length,
        localAfter: staged.length,
        fieldChangeCount: 0,
        counts: { newCount: 0, updatedCount: 0, unchangedCount: staged.length, removedCount: 0 },
        ...loaded,
      };
    },
    updateRun: async (id, patch) => {
      updates.push({ id, patch });
      return { id, ...patch };
    },
  };
  const source = {
    readSnapshot: async ({ onBatch }) => {
      await onBatch([sourceRow()]);
      return { rowCount: 1, sourceCheckedAt: "2026-08-07 09:00:00", maxUpdatedAt: "2026-08-05 08:38:19" };
    },
  };
  const service = new ProductPackageSyncService({ repository, source, manualSyncEnabled: true });
  const result = await service.sync({ triggerType: "manual", requestedBy: "test" });
  assert.equal(result.changed, false);
  assert.equal(result.run.status, "NO_CHANGES");
  assert.equal(staged.length, 1);
  assert.equal(staged[0].rawPayload.picture, "https://example.invalid/reference.jpg");
  assert.equal(updates.at(-1).patch.unchangedCount, 1);
});

test("migration adds durable run summaries and removed-row counts", async () => {
  const sql = await fs.readFile(path.join(projectRoot, "migrations", "029_product_package_database_sync.sql"), "utf8");
  const selectableColumnsSql = await fs.readFile(path.join(projectRoot, "postgresql", "shadow", "migrations", "012_product_center_selectable_columns.sql"), "utf8");
  assert.match(sql, /ALTER TABLE product_import_batches ADD COLUMN removed_count/);
  assert.match(sql, /CREATE TABLE product_package_sync_runs/);
  assert.match(sql, /UNIQUE \(trigger_type, schedule_date\)/);
  assert.match(selectableColumnsSql, /product_package_rows\(latest_import_row_id\)/);
});
