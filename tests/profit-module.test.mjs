import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { LazadaFinanceApi, normalizeLazadaFinanceTransaction } from "../connectors/lazada/finance.mjs";
import { calculateLazadaShopProfit } from "../lib/profit/profit-calculator.mjs";
import { convertLocalAmountToCny, resolveCountryExchangeRates } from "../lib/profit/profit-fx.mjs";
import { aggregateResults, buildCnySummary } from "../lib/profit/profit-service.mjs";
import { prepareLazadaFinanceRows } from "../lib/profit/lazada-profit-adapter.mjs";
import { SqliteProvider } from "../lib/data/sqlite/sqlite-provider.mjs";
import { ProfitRepository } from "../lib/profit/profit-repository.mjs";

test("Lazada finance adapter parses comma amounts and paginates the official detail endpoint", async () => {
  const calls = [];
  const client = {
    async request(input) {
      calls.push(input);
      const offset = Number(input.parameters.offset);
      return {
        request_id: `request-${offset}`,
        data: offset === 0
          ? Array.from({ length: 2 }, (_, index) => ({
              transaction_date: "2026-08-01 10:00:00 +0700",
              fee_name: "Item Price Credit",
              amount: index ? "1,234.50" : "20",
              order_no: `ORDER-${index + 1}`,
            }))
          : [],
      };
    },
  };
  const result = await new LazadaFinanceApi(client).getTransactions({
    startTime: "2026-08-01T00:00:00+07:00",
    endTime: "2026-08-01T23:59:59+07:00",
    limit: 2,
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].path, "/finance/transaction/details/get");
  assert.equal(calls[1].parameters.offset, 2);
  assert.equal(result.records[1].amount, "1234.50");
  assert.deepEqual(result.providerRequestIds, ["request-0", "request-2"]);
});

test("Lazada finance normalization rejects missing fee names instead of inventing data", () => {
  assert.throws(() => normalizeLazadaFinanceTransaction({ amount: "1" }), /fee_name is required/);
});

test("Seller Center date labels remain local business dates without UTC day shifts", () => {
  const [row] = prepareLazadaFinanceRows({
    records: [{ transactionDate: "07 Aug 2026", feeName: "Item Price Credit", amount: "1", orderNo: "O-1" }],
    shop: { country: "TH" },
    fetchedAt: "2026-08-08T00:00:00.000Z",
  });
  assert.equal(row.transactionDate, "2026-08-07");
  assert.equal(row.transactionTime, null);
});

test("Lazada profit calculator reproduces the S-NAIDE golden totals and warehouse cost rule", () => {
  const result = calculateLazadaShopProfit({
    financeRows: [
      { fee_name_raw: "Item Price Credit", fee_name_normalized: "货款", amount: "55288.90", order_no: "1000000000000001" },
      { fee_name_raw: "Payment Fee", fee_name_normalized: "Payment Fee", amount: "-16307.25", order_no: "1000000000000001" },
    ],
    orderLines: [{
      transactionId: "1000000000000001",
      sourceSku: "SKU-1",
      normalizedSourceSku: "SKU-1",
      quantity: "1",
      sourceWarehouseName: "泰国TZ-AD仓-1308",
      normalizedSourceWarehouseName: "泰国TZ-AD仓-1308",
      raw: { 是否测评: "否" },
    }],
    productCostRows: [
      { sku: "SKU-1", warehouse: "泰国其他仓", unitCost: "29000" },
      { sku: "SKU-1", warehouse: "泰国TZ-AD仓-1308", unitCost: "29337.427" },
    ],
  });
  assert.equal(result.dataStatus, "COMPLETE");
  assert.equal(result.listRevenue, "55288.9");
  assert.equal(result.receivedRevenue, "38981.65");
  assert.equal(result.totalCost, "29337.427");
  assert.ok(Math.abs(Number(result.listProfitMargin) - 46.94) < 0.01);
  assert.ok(Math.abs(Number(result.receivedProfitMargin) - 24.74) < 0.01);
  assert.ok(Math.abs(Number(result.listToReceivedProfitMargin) - 17.44) < 0.01);
});

test("profit calculator fails closed for missing orders or ambiguous product costs", () => {
  const missingOrder = calculateLazadaShopProfit({
    financeRows: [{ fee_name_raw: "Item Price Credit", fee_name_normalized: "货款", amount: "100", order_no: "ORDER-1" }],
    orderLines: [],
    productCostRows: [],
  });
  assert.equal(missingOrder.dataStatus, "PARTIAL");
  assert.equal(missingOrder.listRevenue, null);
  assert.equal(missingOrder.totalCost, null);

  const ambiguous = calculateLazadaShopProfit({
    financeRows: [{ fee_name_raw: "Item Price Credit", fee_name_normalized: "货款", amount: "100", order_no: "ORDER-1" }],
    orderLines: [{ transactionId: "ORDER-1", sourceSku: "SKU", quantity: "1", raw: { 是否测评: "否" } }],
    productCostRows: [
      { sku: "SKU", warehouse: "WH-A", unitCost: "20" },
      { sku: "SKU", warehouse: "WH-B", unitCost: "30" },
    ],
  });
  assert.equal(ambiguous.dataStatus, "PARTIAL");
  assert.equal(ambiguous.ambiguousCostLineCount, 1);
  assert.equal(ambiguous.totalCost, null);
});

test("evaluation flags exclude the entire finance order and all of its cost lines", () => {
  const result = calculateLazadaShopProfit({
    financeRows: [
      { fee_name_raw: "Item Price Credit", fee_name_normalized: "货款", amount: "100", order_no: "EVAL" },
      { fee_name_raw: "Item Price Credit", fee_name_normalized: "货款", amount: "200", order_no: "NORMAL" },
    ],
    orderLines: [
      { transactionId: "EVAL", sourceSku: "SKU", quantity: "1", raw: { 是否测评: "是" } },
      { transactionId: "NORMAL", sourceSku: "SKU", quantity: "1", raw: { 是否测评: "否" } },
    ],
    productCostRows: [{ sku: "SKU", warehouse: null, unitCost: "50" }],
  });
  assert.equal(result.evaluationOrderCount, 1);
  assert.equal(result.listRevenue, "200");
  assert.equal(result.totalCost, "50");
});

test("country aggregation recomputes weighted margins and never sums mixed currencies", () => {
  const base = {
    dataStatus: "COMPLETE",
    selectedOrderCount: 1,
    missingOrderCount: 0,
    missingCostLineCount: 0,
    ambiguousCostLineCount: 0,
    knownTotalCost: 50,
  };
  const thailand = aggregateResults([
    { ...base, currency: "THB", listRevenue: 100, receivedRevenue: 80, totalCost: 50 },
    { ...base, currency: "THB", listRevenue: 300, receivedRevenue: 240, totalCost: 150 },
  ], { countryCode: "TH" });
  assert.equal(thailand.listRevenue, "400");
  assert.equal(thailand.totalCost, "200");
  assert.equal(thailand.listProfitMargin, "50");

  const mixed = aggregateResults([
    { ...base, currency: "THB", listRevenue: 100, receivedRevenue: 80, totalCost: 50 },
    { ...base, currency: "MYR", listRevenue: 100, receivedRevenue: 80, totalCost: 50 },
  ]);
  assert.equal(mixed.mixedCurrency, true);
  assert.equal(mixed.listRevenue, null);
  assert.equal(mixed.listProfitMargin, null);
});

test("country aggregation keeps available shop metrics when other shops are partial", () => {
  const complete = {
    dataStatus: "COMPLETE", currency: "IDR", listRevenue: 100, receivedRevenue: 80,
    totalCost: 50, knownTotalCost: 50, selectedOrderCount: 1, missingOrderCount: 0,
    missingCostLineCount: 0, ambiguousCostLineCount: 0,
  };
  const missingOrder = {
    dataStatus: "PARTIAL", currency: "IDR", listRevenue: null, receivedRevenue: null,
    totalCost: null, knownTotalCost: 25, selectedOrderCount: 2, missingOrderCount: 1,
    missingCostLineCount: 0, ambiguousCostLineCount: 0,
  };
  const missingCost = {
    dataStatus: "PARTIAL", currency: "IDR", listRevenue: 200, receivedRevenue: 160,
    totalCost: null, knownTotalCost: 75, selectedOrderCount: 1, missingOrderCount: 0,
    missingCostLineCount: 1, ambiguousCostLineCount: 0,
  };
  const result = aggregateResults([complete, missingOrder, missingCost], { countryCode: "ID" });

  assert.equal(result.dataStatus, "PARTIAL");
  assert.equal(result.listRevenue, "300");
  assert.equal(result.receivedRevenue, "240");
  assert.equal(result.totalCost, "50");
  assert.equal(result.knownTotalCost, "150");
  assert.equal(result.listProfitMargin, "50");
  assert.equal(result.receivedProfitMargin, "37.5");
  assert.equal(result.listToReceivedProfitMargin, "30");
  assert.deepEqual(result.metricCoverage, {
    listRevenueShopCount: 2,
    receivedRevenueShopCount: 2,
    totalCostShopCount: 1,
    knownCostShopCount: 3,
    expenseShopCount: 0,
    gmvShopCount: 0,
    expenseRateShopCount: 0,
    listProfitMarginShopCount: 1,
    receivedProfitMarginShopCount: 1,
    listToReceivedProfitMarginShopCount: 1,
  });
});

test("product-package exchange rates normalize reciprocal directions and fail closed on conflicts", () => {
  const rates = resolveCountryExchangeRates([
    { countryCode: "PH", exchangeRate: "9.08", exchangeDirection: "local_per_cny", rowCount: 100, updatedAt: new Date("2026-08-07T07:01:13.389Z") },
    { countryCode: "PH", exchangeRate: "0.110133", exchangeDirection: "cny_per_local", rowCount: 2, updatedAt: "2026-08-07" },
    { countryCode: "TH", exchangeRate: "4.9", exchangeDirection: "local_per_cny", rowCount: 100, updatedAt: "2026-08-07" },
    { countryCode: "TH", exchangeRate: "0.3", exchangeDirection: "cny_per_local", rowCount: 1, updatedAt: "2026-08-07" },
  ], ["PH", "TH", "VN"]);

  assert.equal(rates.find((rate) => rate.countryCode === "PH").status, "MATCHED");
  assert.equal(rates.find((rate) => rate.countryCode === "PH").sourceUpdatedAt, "2026-08-07T07:01:13.389Z");
  assert.equal(convertLocalAmountToCny("908", rates.find((rate) => rate.countryCode === "PH")), "100");
  assert.equal(rates.find((rate) => rate.countryCode === "TH").status, "AMBIGUOUS");
  assert.equal(rates.find((rate) => rate.countryCode === "VN").status, "MISSING");
  assert.equal(convertLocalAmountToCny("100", rates.find((rate) => rate.countryCode === "TH")), null);
});

test("all-country CNY summary converts each shop before recomputing totals and margins", () => {
  const exchangeRates = resolveCountryExchangeRates([
    { countryCode: "ID", exchangeRate: "2640", exchangeDirection: "local_per_cny", rowCount: 10, updatedAt: "2026-08-07" },
    { countryCode: "MY", exchangeRate: "0.595", exchangeDirection: "local_per_cny", rowCount: 10, updatedAt: "2026-08-07" },
  ], ["ID", "MY"]);
  const base = {
    dataStatus: "COMPLETE", selectedOrderCount: 1, missingOrderCount: 0,
    missingCostLineCount: 0, ambiguousCostLineCount: 0,
  };
  const summary = buildCnySummary([
    { ...base, countryCode: "ID", currency: "IDR", listRevenue: "264000", receivedRevenue: "211200", totalCost: "132000", knownTotalCost: "132000" },
    { ...base, countryCode: "MY", currency: "MYR", listRevenue: "59.5", receivedRevenue: "47.6", totalCost: "29.75", knownTotalCost: "29.75" },
  ], exchangeRates);

  assert.equal(summary.currency, "CNY");
  assert.equal(summary.listRevenue, "200");
  assert.equal(summary.receivedRevenue, "160");
  assert.equal(summary.totalCost, "100");
  assert.equal(summary.listProfitMargin, "50");
  assert.equal(summary.receivedProfitMargin, "37.5");
  assert.equal(summary.listToReceivedProfitMargin, "30");
  assert.equal(summary.rateCoverage.convertedCountryCount, 2);
  assert.equal(summary.rateCoverage.countryCount, 2);
});

test("profit repository restores valid repeated Mabang units from authoritative raw evidence", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE growth_order_headers (
      id TEXT PRIMARY KEY, source_shop_name TEXT, platform TEXT, source_batch_id TEXT
    );
    CREATE TABLE growth_order_raw_rows (
      batch_id TEXT, source_row_number INTEGER, raw_values_json TEXT,
      row_hash TEXT, parse_status TEXT
    );
    CREATE TABLE growth_order_lines (
      order_header_id TEXT, source_batch_id TEXT, source_row_number INTEGER,
      source_sku TEXT, normalized_source_sku TEXT, quantity NUMERIC,
      source_warehouse_name TEXT, normalized_source_warehouse_name TEXT,
      is_current INTEGER
    );
  `);
  const raw = JSON.stringify({
    交易编号: "ORDER-1", SKU: "SKU-1", 商品数量: "1", 仓库: "WH-1", 是否测评: "否",
  });
  const invalid = JSON.stringify({ 交易编号: "ORDER-1", 商品数量: "1", 仓库: "WH-1" });
  const insertRaw = db.prepare("INSERT INTO growth_order_raw_rows VALUES (?,?,?,?,?)");
  db.prepare("INSERT INTO growth_order_headers VALUES (?,?,?,?)")
    .run("header-1", "SHOP", "Lazada", "batch-1");
  insertRaw.run("batch-1", 2, raw, "same-hash", "parsed");
  insertRaw.run("batch-1", 3, raw, "same-hash", "rejected");
  insertRaw.run("batch-1", 4, invalid, "invalid-hash", "rejected");
  db.prepare("INSERT INTO growth_order_lines VALUES (?,?,?,?,?,?,?,?,?)")
    .run("header-1", "batch-1", 2, "SKU-1", "SKU-1", 1, "WH-1", "WH-1", 1);

  const repository = new ProfitRepository({ provider: new SqliteProvider({ connection: db }) });
  const lines = await repository.orderCostInputs(["ORDER-1"]);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((line) => line.quantity), ["1", "1"]);
  const result = calculateLazadaShopProfit({
    financeRows: [{ fee_name_raw: "Item Price Credit", fee_name_normalized: "货款", amount: "100", order_no: "ORDER-1" }],
    orderLines: lines,
    productCostRows: [{ sku: "SKU-1", warehouse: "WH-1", unitCost: "5" }],
  });
  assert.equal(result.totalCost, "10");
  assert.equal(result.costLineCount, 2);
  db.close();
});

test("profit repository migration persists idempotent finance facts and reusable snapshots", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE commerce_shop_registry(id TEXT PRIMARY KEY)");
  db.exec("CREATE TABLE product_package_rows(country_normalized TEXT,normalized_payload_json TEXT,updated_at TEXT)");
  db.exec(fs.readFileSync(new URL("../migrations/034_profit_module.sql", import.meta.url), "utf8"));
  db.exec(fs.readFileSync(new URL("../migrations/036_profit_expense_module.sql", import.meta.url), "utf8"));
  const repository = new ProfitRepository({ provider: new SqliteProvider({ connection: db }) });
  assert.equal(await repository.isReady(), true);
  const run = await repository.createRun({
    id: "run-1", platform: "LAZADA", dateFrom: "2026-07-27", dateTo: "2026-08-07",
    ruleVersion: "LAZADA-PROFIT-1.0.0", totalShopCount: 1, startedAt: "2026-08-08T00:00:00.000Z",
  });
  assert.equal(run.status, "RUNNING");
  const financeRow = {
    id: "finance-1", countryCode: "TH", currency: "THB", transactionDate: "2026-08-01",
    feeNameRaw: "Item Price Credit", feeNameNormalized: "货款", amount: "100", orderNo: "ORDER-1",
    sourceKey: "source-1", fetchedAt: "2026-08-08T00:00:00.000Z",
  };
  await repository.replaceFinanceWindow({
    platform: "LAZADA", connectorShopId: "shop-1", dateFrom: "2026-07-27", dateTo: "2026-08-07",
    rows: [financeRow],
  });
  await repository.replaceFinanceWindow({
    platform: "LAZADA", connectorShopId: "shop-1", dateFrom: "2026-07-27", dateTo: "2026-08-07",
    rows: [financeRow],
  });
  assert.equal((await repository.financeRows({
    platform: "LAZADA", connectorShopId: "shop-1", dateFrom: "2026-07-27", dateTo: "2026-08-07",
  })).length, 1);
  await repository.upsertShopResult({
    runId: "run-1", platform: "LAZADA", connectorShopId: "shop-1", shopCode: "BS0425",
    shopName: "S-NAIDE", countryCode: "TH", currency: "THB", dataStatus: "COMPLETE",
    listRevenue: "100", receivedRevenue: "80", totalCost: "50", knownTotalCost: "50",
    listProfitMargin: "50", receivedProfitMargin: "37.5", listToReceivedProfitMargin: "30",
    financeRowCount: 1, selectedOrderCount: 1,
  });
  const results = await repository.resultsForRun("run-1");
  assert.equal(results.length, 1);
  assert.equal(results[0].shopCode, "BS0425");
  assert.equal(results[0].listProfitMargin, 50);
  await repository.updateRun("run-1", {
    status: "COMPLETE", currentStage: "COMPLETE", financeSuccessCount: 1,
    completeShopCount: 1, completedAt: "2026-08-08T00:01:00.000Z",
  });
  const windows = await repository.financeCoverageWindows({
    platform: "LAZADA", connectorShopIds: ["shop-1"], dateFrom: "2026-08-01", dateTo: "2026-08-07",
  });
  assert.deepEqual(windows, [{
    connectorShopId: "shop-1", dateFrom: "2026-07-27", dateTo: "2026-08-07",
    completedAt: "2026-08-08T00:01:00.000Z", runId: "run-1",
  }]);
  assert.equal((await repository.financeRowsForRange({
    platform: "LAZADA", connectorShopIds: ["shop-1"], dateFrom: "2026-08-01", dateTo: "2026-08-07",
  })).length, 1);
  await repository.replaceExpenseTransactionWindow({
    platform: "LAZADA", connectorShopId: "shop-1", dateFrom: "2026-08-01", dateTo: "2026-08-01",
    rows: [{
      countryCode: "TH", currency: "THB", transactionDate: "2026-08-01",
      transactionType: "Payment", transactionSubtype: "Sponsored Solutions Top-up",
      amount: "-107", transactionNumber: "AD-1", sourceWindow: "2026-08-01:2026-08-01",
      fetchedAt: "2026-08-08T00:00:00.000Z",
    }],
  });
  await repository.upsertDailyExpenseFacts([{
    platform: "LAZADA", connectorShopId: "shop-1", countryCode: "TH", currency: "THB",
    transactionDate: "2026-08-01", dataStatus: "COMPLETE",
    advertisingExpenseSigned: "-107", billingExpenseSigned: "-213.37",
    sourceSignedTotal: "-320.37", expenseValue: "320.37", classification: "EXPENSE",
    ruleVersion: "LAZADA-EXPENSE-1.0.0", advertisingRowCount: 1, billingRowCount: 1,
    sourceWindowCount: 1, duplicateGroupCount: 0, duplicateRemovedCount: 0,
    sourceComplete: true, issues: [], calculatedAt: "2026-08-08T00:00:00.000Z",
  }]);
  assert.equal((await repository.expenseTransactions({
    platform: "LAZADA", connectorShopId: "shop-1", dateFrom: "2026-08-01", dateTo: "2026-08-01",
  })).length, 1);
  const [expense] = await repository.expenseAggregatesForRange({
    platform: "LAZADA", connectorShopIds: ["shop-1"], dateFrom: "2026-08-01", dateTo: "2026-08-01",
  });
  assert.equal(expense.expenseDataStatus, "COMPLETE");
  assert.equal(expense.expenseValue, "320.37");
  db.prepare("INSERT INTO product_package_rows VALUES (?,?,?)").run(
    "TH", JSON.stringify({ exchange_rate: 4.9, exchange_direction: "local_per_cny" }), "2026-08-07T07:01:13.389Z",
  );
  const rates = await repository.countryExchangeRateCandidates({ countryCodes: ["TH"] });
  assert.deepEqual(rates, [{
    countryCode: "TH", exchangeRate: "4.9", exchangeDirection: "local_per_cny",
    rowCount: 1, updatedAt: "2026-08-07T07:01:13.389Z",
  }]);
  db.close();
});
