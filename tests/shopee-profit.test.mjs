import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  calculateShopeeShopProfit,
  prepareShopeeFinanceRows,
  shopeeRevenuePreview,
} from "../lib/profit/shopee-profit-adapter.mjs";
import { profitBillingPresets, resolveProfitBillingPeriod } from "../lib/profit/profit-billing-periods.mjs";
import { ShopeeFinanceApi } from "../connectors/shopee/finance.mjs";
import { ShopeeProfitService } from "../lib/profit/shopee-profit-service.mjs";
import { ProfitScheduleRunner } from "../lib/profit/profit-schedule-runner.mjs";
import { UnifiedProfitService } from "../lib/profit/unified-profit-service.mjs";
import { resolvePythonRuntime } from "../lib/python-runtime.mjs";

const projectRoot = path.resolve(".");

function statement(countryCode, { summary = {}, orders = [], adjustment = "0" } = {}) {
  return {
    countryCode,
    dateFrom: "2026-08-01",
    dateTo: "2026-08-07",
    sourceHash: `fixture-${countryCode}`,
    summary,
    adjustment: { totalAmount: adjustment, sheetPresent: adjustment !== "0" },
    income: { orderRows: orders },
  };
}

function row(orderId, components) {
  return { orderId, payoutCompletedDate: "2026-08-07", components };
}

test("Shopee parser supports expense-only parsing for the fingerprinted MY mojibake layout", async (t) => {
  const python = resolvePythonRuntime({ appRoot: projectRoot, requiredModules: ["openpyxl"] });
  if (!python.ok) return t.skip("openpyxl runtime unavailable");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "shopee-mojibake-summary-"));
  const validPath = path.join(directory, "valid.xlsx");
  const changedPath = path.join(directory, "changed.xlsx");
  try {
    const create = [
      "from openpyxl import Workbook",
      "import sys",
      "mark=chr(0xfffd)",
      "def make(filename,row50):",
      " wb=Workbook(); summary=wb.active; summary.title='Summary'",
      " summary.cell(10,2,'2026-08-01'); summary.cell(11,2,'2026-08-01'); summary.cell(13,4,'RM')",
      " summary.cell(14,1,'1. '+mark); summary.cell(27,1,'2. '+mark); summary.cell(50,1,row50)",
      " summary.cell(29,2,'Shipping Fee Paid by Buyer (excl. SST)')",
      " summary.cell(40,2,mark); summary.cell(40,3,-0.55); summary.cell(45,2,mark)",
      " income=wb.create_sheet('Income'); income.cell(1,1,mark)",
      " adjustment=wb.create_sheet('Adjustment'); adjustment.cell(1,1,mark); adjustment.cell(1,2,-2); wb.save(filename)",
      "make(sys.argv[1],'3. '+mark)",
      "make(sys.argv[2],'layout changed')",
    ].join("\n");
    const generated = spawnSync(python.executable, ["-c", create, validPath, changedPath], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(generated.status, 0, generated.stderr);

    const parse = (workbookPath, summaryOnly = false) => spawnSync(python.executable, [
      path.join(projectRoot, "scripts", "shopee-profit-parser.py"),
      workbookPath,
      "--country",
      "MY",
      ...(summaryOnly ? ["--summary-only"] : []),
    ], { encoding: "utf8", windowsHide: true });
    const full = parse(validPath);
    assert.equal(full.status, 1, full.stderr);
    assert.equal(JSON.parse(full.stdout).reason, "ADJUSTMENT_TOTAL_MISSING");
    const valid = parse(validPath, true);
    assert.equal(valid.status, 0, valid.stderr);
    const validStatement = JSON.parse(valid.stdout).statement;
    assert.deepEqual(validStatement.summary, {
      SUMMARY_AMS_COMMISSION: "-0.55",
      SUMMARY_ADS_ESCROW_TOP_UP: "0",
    });
    assert.equal(validStatement.income.sourceComplete, false);
    const changed = parse(changedPath, true);
    assert.equal(changed.status, 1, changed.stderr);
    assert.equal(JSON.parse(changed.stdout).reason, "SUMMARY_COMPONENT_MISSING");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("Shopee country formula contracts reproduce the confirmed TH, ID and PH samples", () => {
  const cases = [
    ["TH", statement("TH", {
      summary: { SUMMARY_TOTAL_RELEASED: "3202", SUMMARY_AMS_COMMISSION: "0", SUMMARY_ADS_CREDIT_TOP_UP_ESCROW: "-129" },
      orders: [row("TH-1", { ORIGINAL_PRODUCT_PRICE: "8298", SELLER_PRODUCT_PROMOTION: "-4164", REFUND_AMOUNT: "0", REBATE_SHOPEE: "0", VOUCHER_SELLER: "-104", COFUND_VOUCHER_SELLER: "0", COIN_CASHBACK_SELLER: "0", COFUND_COIN_CASHBACK_SELLER: "0" })],
    }), "4030", "3073"],
    ["ID", statement("ID", {
      summary: { SUMMARY_TOTAL_RELEASED: "618145", SUMMARY_AMS_COMMISSION: "0", SUMMARY_ADS_ESCROW_TOP_UP: "0" },
      orders: [row("ID-1", { ORIGINAL_PRODUCT_PRICE: "790167", SELLER_PRODUCT_PROMOTION: "0", REFUND_AMOUNT: "0", REBATE_SHOPEE: "0", VOUCHER_SELLER: "0", COFUND_VOUCHER_SELLER: "0", COIN_CASHBACK_SELLER: "0", COFUND_COIN_CASHBACK_SELLER: "0", SELLER_ADJUSTMENT_1: "-22287" })],
    }), "790167", "595858"],
    ["PH", statement("PH", {
      summary: { SUMMARY_TOTAL_RELEASED: "30693.36", SUMMARY_AMS_COMMISSION: "-263", SUMMARY_ADS_SALES_TOP_UP: "0" },
      orders: [row("PH-1", { ORIGINAL_PRODUCT_PRICE: "68407", SELLER_PRODUCT_PROMOTION: "-29499", REFUND_AMOUNT: "0", REBATE_SHOPEE: "0", VOUCHER_SELLER: "-30", COFUND_VOUCHER_SELLER: "0", COIN_CASHBACK_SELLER: "0", COFUND_COIN_CASHBACK_SELLER: "0" })],
    }), "38878", "30430.36"],
  ];
  for (const [countryCode, input, expectedList, expectedReceived] of cases) {
    const result = shopeeRevenuePreview(input);
    assert.equal(result.listRevenue, expectedList, countryCode);
    assert.equal(result.receivedRevenue, expectedReceived, countryCode);
  }
});

test("Indonesia adjustment is counted once per deduplicated order", () => {
  const input = statement("ID", {
    summary: { SUMMARY_TOTAL_RELEASED: "100", SUMMARY_AMS_COMMISSION: "0", SUMMARY_ADS_ESCROW_TOP_UP: "0" },
    orders: [
      row("ID-1", { ORIGINAL_PRODUCT_PRICE: "60", SELLER_PRODUCT_PROMOTION: "0", REFUND_AMOUNT: "0", REBATE_SHOPEE: "0", VOUCHER_SELLER: "0", COFUND_VOUCHER_SELLER: "0", COIN_CASHBACK_SELLER: "0", COFUND_COIN_CASHBACK_SELLER: "0", SELLER_ADJUSTMENT_1: "-5" }),
      row("ID-1", { ORIGINAL_PRODUCT_PRICE: "40", SELLER_PRODUCT_PROMOTION: "0", REFUND_AMOUNT: "0", REBATE_SHOPEE: "0", VOUCHER_SELLER: "0", COFUND_VOUCHER_SELLER: "0", COIN_CASHBACK_SELLER: "0", COFUND_COIN_CASHBACK_SELLER: "0", SELLER_ADJUSTMENT_1: "-5" }),
    ],
  });
  assert.equal(shopeeRevenuePreview(input).receivedRevenue, "95");
});

test("Shopee cost matching fails closed when an order or SKU cost is missing", () => {
  const input = statement("MY", {
    adjustment: "-2",
    orders: [row("MY-1", { PRODUCT_PRICE: "100", REFUND_AMOUNT: "0", REBATE_SHOPEE: "0", VOUCHER_SELLER: "0", COFUND_VOUCHER_SELLER: "0", COIN_CASHBACK_SELLER: "0", COFUND_COIN_CASHBACK_SELLER: "0", INCOME_TOTAL_RELEASED: "80", INCOME_AMS_COMMISSION: "-3", INCOME_ADS_ESCROW_TOP_UP: "-1" })],
  });
  const financeRows = prepareShopeeFinanceRows({ statement: input, shop: { country: "MY" }, fetchedAt: "2026-08-08T00:00:00Z" });
  const complete = calculateShopeeShopProfit({
    countryCode: "MY", financeRows,
    orderLines: [{ transactionId: "MY-1", sourceSku: "SKU-1", quantity: "2", sourceWarehouseName: "WH" }],
    productCostRows: [{ sku: "SKU-1", warehouse: "WH", unitCost: "10" }],
  });
  assert.equal(complete.receivedRevenue, "82");
  assert.equal(complete.totalCost, "20");
  assert.equal(complete.dataStatus, "COMPLETE");
  const partial = calculateShopeeShopProfit({ countryCode: "MY", financeRows, orderLines: [], productCostRows: [] });
  assert.equal(partial.totalCost, null);
  assert.equal(partial.dataStatus, "PARTIAL");
});

test("billing presets use Shopee calendar months and Lazada complete weeks", () => {
  const referenceDate = new Date("2026-08-08T04:00:00Z");
  const presets = profitBillingPresets(referenceDate);
  assert.deepEqual(presets.platforms.SHOPEE.current.accountingRange, { dateFrom: "2026-08-01", dateTo: "2026-08-31" });
  assert.deepEqual(presets.platforms.SHOPEE.current.transactionRange, { dateFrom: "2026-08-01", dateTo: "2026-08-07" });
  assert.deepEqual(presets.platforms.LAZADA.current.accountingRange, { dateFrom: "2026-07-27", dateTo: "2026-08-30" });
  assert.deepEqual(resolveProfitBillingPeriod({ platform: "SHOPEE", preset: "LAST_BILLING_PERIOD", referenceDate }).accountingRange,
    { dateFrom: "2026-07-01", dateTo: "2026-07-31" });
});

test("temporary transaction cutoff keeps all profit metrics on the last approved GMV date", () => {
  const referenceDate = new Date("2026-08-09T04:00:00Z");
  const presets = profitBillingPresets(referenceDate, { transactionCutoffDate: "2026-08-07" });
  assert.deepEqual(presets.platforms.SHOPEE.current.transactionRange, { dateFrom: "2026-08-01", dateTo: "2026-08-07" });
  assert.deepEqual(presets.platforms.LAZADA.current.transactionRange, { dateFrom: "2026-07-27", dateTo: "2026-08-07" });
  const custom = resolveProfitBillingPeriod({
    platform: "SHOPEE", preset: "CUSTOM", referenceDate,
    dateFrom: "2026-08-08", dateTo: "2026-08-08", transactionCutoffDate: "2026-08-07",
  });
  assert.deepEqual(custom.transactionRange, { dateFrom: "2026-08-07", dateTo: "2026-08-07" });
  assert.equal(custom.cutoffApplied, true);
});

test("Shopee official income report flow generates, polls and downloads a bounded workbook", async () => {
  const calls = [];
  const finance = new ShopeeFinanceApi({
    async call(operation, input) {
      calls.push({ operation, input });
      if (operation === "generate_income_report") {
        return { data: { response: { id: "report-1" } }, providerRequestId: "request-1" };
      }
      return { data: { response: { status: 2, file_link: "https://files.shopeeusercontent.com/report.xlsx" } } };
    },
  }, {
    shopId: "1618749121",
    countryCode: "MY",
    sleeper: async () => {},
    fetchImpl: async () => new Response(Buffer.from("PK\u0003\u0004fixture"), {
      status: 200,
      headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
    }),
  });
  const result = await finance.getTransactions({ dateFrom: "2026-08-01", dateTo: "2026-08-07" });
  assert.equal(result.incomeReportId, "report-1");
  assert.equal(Buffer.isBuffer(result.workbookBuffer), true);
  assert.deepEqual(calls.map((call) => call.operation), ["generate_income_report", "get_income_report"]);
  assert.equal(calls[0].input.params.release_time_from, 1785513600);
  assert.equal(calls[0].input.params.release_time_to, 1786118399);
  assert.deepEqual(calls[1].input.params, { income_report_id: "report-1" });
});

test("Shopee official income report polling resumes the same pending report across connector instances", async () => {
  let generatedReports = 0;
  let statusChecks = 0;
  const relayClient = {
    async call(operation) {
      if (operation === "generate_income_report") {
        generatedReports += 1;
        return { data: { response: { id: "slow-report" } }, providerRequestId: "request-slow" };
      }
      statusChecks += 1;
      return statusChecks < 2
        ? { data: { response: { status: 1 } } }
        : { data: { response: { status: 2, file_link: "https://files.shopeeusercontent.com/slow-report.xlsx" } } };
    },
  };
  const options = {
    shopId: "1618749121",
    countryCode: "MY",
    pollAttempts: 1,
    sleeper: async () => {},
    fetchImpl: async () => new Response(Buffer.from("PK\u0003\u0004fixture"), {
      status: 200,
      headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
    }),
  };
  const first = new ShopeeFinanceApi(relayClient, options);
  await assert.rejects(
    first.getTransactions({ dateFrom: "2026-08-01", dateTo: "2026-08-01" }),
    (error) => error?.code === "SHOPEE_INCOME_REPORT_PENDING",
  );
  const second = new ShopeeFinanceApi(relayClient, options);
  const result = await second.getTransactions({ dateFrom: "2026-08-01", dateTo: "2026-08-01" });
  assert.equal(result.incomeReportId, "slow-report");
  assert.equal(generatedReports, 1);
  assert.equal(statusChecks, 2);
});

test("Shopee profit service persists a complete statement snapshot with Mabang and product-package cost", async () => {
  let currentRun;
  let savedFinance = [];
  let savedResult;
  const repository = {
    async isReady() { return true; },
    async createRun(input) { currentRun = { ...input, status: "RUNNING", currentStage: input.currentStage }; return currentRun; },
    async updateRun(id, input) { currentRun = { ...currentRun, ...input, id }; return currentRun; },
    async orderCostInputs(orderNumbers) {
      return orderNumbers.map((transactionId) => ({ transactionId, sourceSku: "SKU-1", quantity: "2", sourceWarehouseName: "WH" }));
    },
    async productCostRows() { return [{ sku: "SKU-1", warehouse: "WH", unitCost: "10" }]; },
    async replaceFinanceWindow(input) { savedFinance = input.rows; },
    async upsertShopResult(input) { savedResult = input; },
  };
  const service = new ShopeeProfitService({
    repository,
    shopDirectoryService: {
      async list() {
        return [{ id: "shopee:1", directoryShopId: "shop-1", shopCode: "MY001", shopName: "Fine Nest", country: "MY", callable: true, identityStatus: "CONFIRMED" }];
      },
    },
    now: () => new Date("2026-08-08T02:00:00Z"),
  });
  const input = statement("MY", {
    adjustment: "-2",
    orders: [row("MY-1", { PRODUCT_PRICE: "100", REFUND_AMOUNT: "0", REBATE_SHOPEE: "0", VOUCHER_SELLER: "0", COFUND_VOUCHER_SELLER: "0", COIN_CASHBACK_SELLER: "0", COFUND_COIN_CASHBACK_SELLER: "0", INCOME_TOTAL_RELEASED: "80", INCOME_AMS_COMMISSION: "-3", INCOME_ADS_ESCROW_TOP_UP: "-1" })],
  });
  const run = await service.importStatement({ statement: input, shopId: "shopee:1" });
  assert.equal(run.status, "COMPLETE");
  assert.equal(savedResult.receivedRevenue, "82");
  assert.equal(savedResult.totalCost, "20");
  assert.equal(savedResult.selectedOrderCount, 1);
  assert.equal(savedFinance.some((fact) => fact.feeNameNormalized === "ADJUSTMENT_TOTAL"), true);
});

test("Shopee expense-only statement writes a complete daily fee without replacing profit finance facts", async () => {
  let currentRun;
  let savedExpense;
  let replacedFinance = false;
  const repository = {
    async isReady() { return true; },
    async createRun(input) { currentRun = { ...input, status: "RUNNING", currentStage: input.currentStage }; return currentRun; },
    async updateRun(id, input) { currentRun = { ...currentRun, ...input, id }; return currentRun; },
    async replaceFinanceWindow() { replacedFinance = true; },
    async replaceExpenseTransactionWindow() {},
    async upsertDailyExpenseFacts(facts) { [savedExpense] = facts; },
  };
  const service = new ShopeeProfitService({
    repository,
    shopDirectoryService: {
      async list() {
        return [{ id: "shopee:1", directoryShopId: "shop-1", shopCode: "MY001", shopName: "Fine Nest", country: "MY", callable: true, identityStatus: "CONFIRMED" }];
      },
    },
    expenseTransactionSource: async () => ({
      paginationComplete: true,
      records: [{
        transactionDate: "2026-08-01",
        transactionTabType: "WALLET_WALLET_PAYMENT",
        moneyFlow: "MONEY_OUT",
        amount: "-10",
        currency: "MYR",
      }],
    }),
    now: () => new Date("2026-08-08T02:00:00Z"),
  });
  const run = await service.importStatement({
    shopId: "shopee:1",
    statement: {
      countryCode: "MY",
      dateFrom: "2026-08-01",
      dateTo: "2026-08-01",
      sourceHash: "summary-only",
      summary: { SUMMARY_AMS_COMMISSION: "-0.55", SUMMARY_ADS_ESCROW_TOP_UP: "0" },
      income: { sourceComplete: false, issue: "INCOME_HEADER_MISSING", orderRows: [] },
    },
  });
  assert.equal(run.status, "PARTIAL");
  assert.equal(replacedFinance, false);
  assert.equal(savedExpense.dataStatus, "COMPLETE");
  assert.equal(savedExpense.sourceComplete, true);
  assert.equal(savedExpense.advertisingExpenseSigned, "-10");
  assert.equal(savedExpense.billingExpenseSigned, "-0.55");
  assert.equal(savedExpense.expenseValue, "10.55");
});

test("Shopee batch sync times out one stalled statement without blocking the batch", async () => {
  const runs = new Map();
  const service = new ShopeeProfitService({
    repository: {
      async isReady() { return true; },
      async financeCoverageWindows() { return []; },
      async dailyExpenseFactsForRange() { return []; },
      async createRun(input) {
        const run = { ...input, status: "RUNNING", currentStage: input.currentStage };
        runs.set(run.id, run);
        return run;
      },
      async updateRun(id, input) {
        const run = { ...runs.get(id), ...input, id };
        runs.set(id, run);
        return run;
      },
    },
    shopDirectoryService: {
      async list() {
        return [{ id: "shopee:slow", shopCode: "MY-SLOW", shopName: "Slow", country: "MY", callable: true, identityStatus: "CONFIRMED" }];
      },
    },
    incomeStatementSource: () => new Promise(() => {}),
    statementTimeoutMs: 20,
  });
  const completed = await service.runSync({ dateFrom: "2026-08-01", dateTo: "2026-08-01" });
  assert.equal(completed.status, "FAILED");
  assert.equal(completed.runs[0].code, "SHOPEE_STATEMENT_ACQUISITION_TIMEOUT");
});

test("unified daily schedule keeps Lazada gap sync and imports only Shopee's previous day", async () => {
  const calls = [];
  const service = {
    periods() { return {}; },
    async runSync(input) {
      calls.push(input);
      return { outcomes: [{ platform: input.platform, ok: true, result: { status: "COMPLETE" } }] };
    },
  };
  const runner = new ProfitScheduleRunner({
    service,
    now: () => new Date("2026-08-08T02:00:00Z"),
    retryIntervalMs: 60_000,
  });
  await runner.runDue();
  await runner.runDue();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], {
    platform: "LAZADA",
    preset: "CURRENT_BILLING_PERIOD",
    triggerType: "scheduled",
  });
  assert.deepEqual(calls[1], {
    platform: "SHOPEE",
    dateFrom: "2026-08-07",
    dateTo: "2026-08-07",
    triggerType: "scheduled",
  });
  assert.equal(runner.status().mode, "PLATFORM_DAILY_INCREMENTAL");
});

test("manual current-period sync keeps Lazada range but requests one Shopee business day", async () => {
  const calls = [];
  const service = (platform) => ({
    async startSync(input) {
      calls.push({ platform, ...input });
      return { accepted: true };
    },
  });
  const unified = new UnifiedProfitService({
    lazadaService: service("LAZADA"),
    shopeeService: service("SHOPEE"),
    repository: {},
    now: () => new Date("2026-08-08T16:05:00Z"),
  });
  await unified.startSync({ platform: "ALL", preset: "CURRENT_BILLING_PERIOD", triggerType: "manual_sync" });
  assert.deepEqual(calls, [
    { platform: "LAZADA", dateFrom: "2026-07-27", dateTo: "2026-08-08", triggerType: "manual_sync" },
    { platform: "SHOPEE", dateFrom: "2026-08-08", dateTo: "2026-08-08", triggerType: "manual_sync" },
  ]);
});

test("manual current-period sync respects the configured GMV transaction cutoff", async () => {
  const calls = [];
  const service = (platform) => ({
    async startSync(input) {
      calls.push({ platform, ...input });
      return { accepted: true };
    },
  });
  const unified = new UnifiedProfitService({
    lazadaService: service("LAZADA"), shopeeService: service("SHOPEE"), repository: {},
    transactionCutoffDate: "2026-08-07", now: () => new Date("2026-08-09T04:00:00Z"),
  });
  await unified.startSync({ platform: "ALL", preset: "CURRENT_BILLING_PERIOD", triggerType: "manual_sync" });
  assert.deepEqual(calls, [
    { platform: "LAZADA", dateFrom: "2026-07-27", dateTo: "2026-08-07", triggerType: "manual_sync" },
    { platform: "SHOPEE", dateFrom: "2026-08-07", dateTo: "2026-08-07", triggerType: "manual_sync" },
  ]);
});

test("Shopee previous-day sync skips shops already covered by a wider statement window", async () => {
  let providerCalls = 0;
  const service = new ShopeeProfitService({
    repository: {
      async isReady() { return true; },
      async financeCoverageWindows() {
        return [{ connectorShopId: "shopee:1", dateFrom: "2026-08-01", dateTo: "2026-08-07" }];
      },
    },
    shopDirectoryService: {
      async list() {
        return [{ id: "shopee:1", shopCode: "MY001", shopName: "Fine Nest", country: "MY", callable: true, identityStatus: "CONFIRMED" }];
      },
    },
    incomeStatementSource: async () => { providerCalls += 1; },
    now: () => new Date("2026-08-08T02:00:00Z"),
  });
  const result = await service.runSync({ dateFrom: "2026-08-07", dateTo: "2026-08-07", triggerType: "scheduled" });
  assert.equal(result.alreadyCovered, true);
  assert.equal(result.coveredShopCount, 1);
  assert.equal(result.status, "EMPTY");
  assert.equal(providerCalls, 0);
});

test("Shopee dashboard composes contiguous daily snapshots into the requested month range", async () => {
  const base = {
    platform: "SHOPEE",
    connectorShopId: "shopee:1",
    canonicalShopId: "shop-1",
    shopCode: "MY001",
    shopName: "Fine Nest",
    countryCode: "MY",
    currency: "MYR",
    dataStatus: "COMPLETE",
    knownTotalCost: 20,
    financeRowCount: 1,
    selectedOrderCount: 1,
    linkedOrderCount: 1,
    evaluationOrderCount: 0,
    costLineCount: 1,
    matchedCostLineCount: 1,
    missingOrderCount: 0,
    missingCostLineCount: 0,
    ambiguousCostLineCount: 0,
    warnings: [],
  };
  const service = new ShopeeProfitService({
    repository: {
      async isReady() { return true; },
      async latestResultsForRange() { return []; },
      async resultWindowsForRange() {
        return [
          { ...base, runId: "run-1", window: { dateFrom: "2026-08-01", dateTo: "2026-08-07" }, listRevenue: 100, receivedRevenue: 80, totalCost: 20, calculatedAt: "2026-08-08T01:00:00Z", runCompletedAt: "2026-08-08T01:00:00Z" },
          { ...base, runId: "run-2", window: { dateFrom: "2026-08-08", dateTo: "2026-08-08" }, listRevenue: 30, receivedRevenue: 24, totalCost: 6, knownTotalCost: 6, calculatedAt: "2026-08-09T01:00:00Z", runCompletedAt: "2026-08-09T01:00:00Z" },
        ];
      },
      async latestRun() { return null; },
      async countryExchangeRateCandidates() { return []; },
    },
    shopDirectoryService: {
      async list() {
        return [{ id: "shopee:1", directoryShopId: "shop-1", shopCode: "MY001", shopName: "Fine Nest", country: "MY", callable: true, identityStatus: "CONFIRMED" }];
      },
    },
  });
  const dashboard = await service.dashboard({ dateFrom: "2026-08-01", dateTo: "2026-08-08" });
  assert.equal(dashboard.coverage.status, "COVERED");
  assert.equal(dashboard.calculation.mode, "COMPOSED_SNAPSHOTS");
  assert.equal(dashboard.selection.listRevenue, "130");
  assert.equal(dashboard.selection.receivedRevenue, "104");
  assert.equal(dashboard.selection.totalCost, "26");
  assert.equal(dashboard.selection.selectedOrderCount, 2);
});
