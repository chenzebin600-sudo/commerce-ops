import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SqliteProvider } from "../lib/data/sqlite/sqlite-provider.mjs";
import { ProfitRepository } from "../lib/profit/profit-repository.mjs";
import { aggregateResults } from "../lib/profit/profit-service.mjs";

test("country expense rate uses total expense divided by total GMV", () => {
  const common = {
    currency: "THB", countryCode: "TH", dataStatus: "COMPLETE",
    expenseDataStatus: "COMPLETE", gmvDataStatus: "COMPLETE", expenseRateDataStatus: "COMPLETE",
    selectedOrderCount: 0, missingOrderCount: 0, missingCostLineCount: 0, ambiguousCostLineCount: 0,
    knownTotalCost: "0", knownGmvValue: "0", gmvOrderCount: 1, confirmedGmvOrderCount: 1,
  };
  const result = aggregateResults([
    { ...common, expenseValue: "10", gmvValue: "100", knownGmvValue: "100" },
    { ...common, expenseValue: "60", gmvValue: "300", knownGmvValue: "300" },
  ], { countryCode: "TH" });
  assert.equal(result.expenseValue, "70");
  assert.equal(result.gmvValue, "400");
  assert.equal(result.expenseRate, "17.5");
});

test("GMV migration counts repeated raw rows once and defaults unresolved orders to zero", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE growth_order_headers (
      id TEXT PRIMARY KEY, platform TEXT NOT NULL, source_shop_name TEXT NOT NULL,
      normalized_source_shop_name TEXT NOT NULL, internal_shop_id TEXT, source_order_id TEXT NOT NULL,
      paid_at TEXT, effective_status TEXT NOT NULL, source_batch_id TEXT NOT NULL
    );
    CREATE TABLE growth_order_raw_rows (
      batch_id TEXT NOT NULL, raw_values_json TEXT NOT NULL, parse_status TEXT NOT NULL
    );
    CREATE TABLE growth_source_batches (
      id TEXT PRIMARY KEY, source_type TEXT NOT NULL, query_started_at TEXT, query_ended_at TEXT,
      source_scope_status TEXT NOT NULL, status TEXT NOT NULL, source_scope_json TEXT NOT NULL,
      imported_at TEXT
    );
  `);
  const insertHeader = db.prepare("INSERT INTO growth_order_headers VALUES (?,?,?,?,?,?,?,?,?)");
  insertHeader.run("h-1", "Lazada", "S-NAIDE", "s naide", null, "ORDER-1", "2026-08-04T03:00:00.000Z", "valid", "batch-1");
  insertHeader.run("h-2", "Lazada", "S-NAIDE", "s naide", null, "ORDER-2", "2026-08-05T03:00:00.000Z", "valid", "batch-1");
  insertHeader.run("h-3", "Lazada", "S-NAIDE", "s naide", null, "ORDER-3", "2026-08-05T04:00:00.000Z", "valid", "batch-1");
  const insertRaw = db.prepare("INSERT INTO growth_order_raw_rows VALUES (?,?,?)");
  const raw1 = JSON.stringify({ 订单编号: "ORDER-1", 店铺名: "S-NAIDE", 平台: "Lazada", 原始商品总金额: "1000", "优惠金额（原始货币）": "100" });
  const raw2 = JSON.stringify({ 订单编号: "ORDER-2", 店铺名: "S-NAIDE", 平台: "Lazada", 原始商品总金额: "400", "优惠金额（原始货币）": "0" });
  insertRaw.run("batch-1", raw1, "parsed");
  insertRaw.run("batch-1", raw1, "parsed");
  insertRaw.run("batch-1", raw2, "parsed");
  const raw3 = JSON.parse(raw2);
  const raw3Keys = Object.keys(raw3);
  raw3[raw3Keys[0]] = "ORDER-3";
  raw3[raw3Keys[3]] = "500";
  delete raw3[raw3Keys[4]];
  insertRaw.run("batch-1", JSON.stringify(raw3), "parsed");
  db.prepare("INSERT INTO growth_source_batches VALUES (?,?,?,?,?,?,?,?)").run(
    "batch-1", "mabang_order", "2026-08-04", "2026-08-05", "confirmed", "applied",
    JSON.stringify({
      queryType: "profit_initial_sync", dateFrom: "2026-08-04", dateTo: "2026-08-05",
      shopScope: ["s-naide"],
    }),
    "2026-08-06T00:00:00.000Z",
  );
  db.exec(fs.readFileSync(new URL("../migrations/037_profit_gmv_module.sql", import.meta.url), "utf8"));

  const repository = new ProfitRepository({ provider: new SqliteProvider({ connection: db }) });
  assert.equal(await repository.isGmvReady(), true);
  const rows = await repository.gmvAggregatesForRange({
    platform: "LAZADA", dateFrom: "2026-08-04", dateTo: "2026-08-05",
    shops: [
      { connectorShopId: "connector-1", canonicalShopId: "shop-1", shopName: "S-NAIDE" },
      { connectorShopId: "connector-2", canonicalShopId: "shop-2", shopName: "No-order shop" },
    ],
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].gmvDataStatus, "COMPLETE");
  assert.equal(rows[0].gmvValue, "1300");
  assert.equal(rows[0].gmvOrderCount, 3);
  assert.equal(rows[0].confirmedGmvOrderCount, 2);
  assert.equal(rows[0].missingGmvOrderCount, 1);
  assert.equal(rows[0].gmvIssues.includes("GMV_UNRESOLVED_ORDER_DEFAULTED_TO_ZERO"), true);
  assert.equal(rows[1].gmvDataStatus, "COMPLETE");
  assert.equal(rows[1].gmvValue, "0");
  assert.equal(rows[1].gmvSourceCoveredDayCount, 2);
  assert.deepEqual(rows[1].gmvIssues, []);
  db.close();
});
