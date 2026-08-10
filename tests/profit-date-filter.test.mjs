import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFinanceCoverage,
  defaultProfitRange,
  missingDateRanges,
} from "../lib/profit/profit-date-coverage.mjs";
import { ProfitScheduleRunner } from "../lib/profit/profit-schedule-runner.mjs";
import { ProfitService } from "../lib/profit/profit-service.mjs";

function shop(overrides = {}) {
  return {
    id: "shop-1",
    directoryShopId: "canonical-1",
    shopCode: "BS0425",
    shopName: "S-NAIDE",
    country: "TH",
    callable: true,
    identityStatus: "CONFIRMED",
    ...overrides,
  };
}

test("date coverage supports arbitrary subranges and identifies only missing shop-days", () => {
  assert.deepEqual(defaultProfitRange(new Date("2026-08-08T04:00:00.000Z")), {
    dateFrom: "2026-08-01",
    dateTo: "2026-08-07",
  });
  assert.deepEqual(missingDateRanges({
    dateFrom: "2026-08-01",
    dateTo: "2026-08-07",
    coveredRanges: [
      { dateFrom: "2026-07-27", dateTo: "2026-08-03" },
      { dateFrom: "2026-08-05", dateTo: "2026-08-08" },
    ],
  }), [{ dateFrom: "2026-08-04", dateTo: "2026-08-04" }]);

  const coverage = buildFinanceCoverage({
    shops: [shop(), shop({ id: "shop-2" })],
    windows: [
      { connectorShopId: "shop-1", dateFrom: "2026-07-27", dateTo: "2026-08-07", completedAt: "2026-08-08T00:00:00Z" },
      { connectorShopId: "shop-2", dateFrom: "2026-08-01", dateTo: "2026-08-03", completedAt: "2026-08-08T00:00:00Z" },
      { connectorShopId: "shop-2", dateFrom: "2026-08-05", dateTo: "2026-08-07", completedAt: "2026-08-08T00:00:00Z" },
    ],
    dateFrom: "2026-08-01",
    dateTo: "2026-08-07",
  });
  assert.equal(coverage.status, "PARTIAL");
  assert.equal(coverage.coveredShopDays, 13);
  assert.equal(coverage.missingShopDays, 1);
  assert.deepEqual(coverage.missingByShop.get("shop-2"), [{ dateFrom: "2026-08-04", dateTo: "2026-08-04" }]);
});

test("covered ranges render an immediate cached profit preview without calling Lazada", async () => {
  let gatewayCalls = 0;
  const repository = {
    async isReady() { return true; },
    async latestRun() { return null; },
    async financeCoverageWindows() {
      return [{ connectorShopId: "shop-1", dateFrom: "2026-07-27", dateTo: "2026-08-07", completedAt: "2026-08-08T00:00:00Z" }];
    },
    async financeRowsForRange() {
      return [
        { connector_shop_id: "shop-1", fee_name_raw: "Item Price Credit", fee_name_normalized: "货款", amount: "100", order_no: "ORDER-1" },
        { connector_shop_id: "shop-1", fee_name_raw: "Payment Fee", fee_name_normalized: "Payment Fee", amount: "-20", order_no: "ORDER-1" },
      ];
    },
    async orderCostInputs() {
      return [{ transactionId: "ORDER-1", sourceSku: "SKU-1", normalizedSourceSku: "SKU-1", quantity: "1", raw: { 是否测评: "否" } }];
    },
    async productCostRows() { return [{ countryCode: "TH", sku: "SKU-1", warehouse: null, unitCost: "50" }]; },
    async countryExchangeRateCandidates() {
      return [{ countryCode: "TH", exchangeRate: "4.9", exchangeDirection: "local_per_cny", rowCount: 1, updatedAt: "2026-08-07" }];
    },
  };
  const service = new ProfitService({
    repository,
    platformGatewayService: { async getFinanceTransactions() { gatewayCalls += 1; throw new Error("must not call provider"); } },
    shopDirectoryService: { async list() { return [shop()]; } },
    now: () => new Date("2026-08-08T00:00:00.000Z"),
  });
  const dashboard = await service.dashboard({ dateFrom: "2026-08-01", dateTo: "2026-08-07" });
  assert.equal(gatewayCalls, 0);
  assert.equal(dashboard.run, null);
  assert.equal(dashboard.coverage.status, "COVERED");
  assert.equal(dashboard.calculation.mode, "CACHED_PREVIEW");
  assert.equal(dashboard.selection.listRevenue, "100");
  assert.equal(dashboard.selection.receivedRevenue, "80");
  assert.equal(dashboard.selection.totalCost, "50");
});

test("profit synchronization fetches only uncovered date gaps", async () => {
  const calls = [];
  const results = [];
  let run = null;
  const repository = {
    async isReady() { return true; },
    async latestRun() { return null; },
    async financeCoverageWindows() {
      return [{ connectorShopId: "shop-1", dateFrom: "2026-08-01", dateTo: "2026-08-03", completedAt: "2026-08-04T00:00:00Z" }];
    },
    async createRun(input) {
      run = { ...input, status: "RUNNING", currentStage: input.currentStage, financeSuccessCount: 0 };
      return run;
    },
    async updateRun(id, input) { run = { ...run, ...input, id }; return run; },
    async getRun() { return run; },
    async replaceFinanceWindow(input) { calls.push({ type: "replace", dateFrom: input.dateFrom, dateTo: input.dateTo }); },
    async financeRows() { return []; },
    async orderCostInputs() { return []; },
    async productCostRows() { return []; },
    async upsertShopResult(input) { results.push(input); },
    async resultsForRun() { return results; },
  };
  const service = new ProfitService({
    repository,
    platformGatewayService: {
      async getFinanceTransactions({ input }) {
        calls.push({ type: "gateway", input });
        return { data: { records: [], providerRequestId: "request-1" } };
      },
    },
    shopDirectoryService: { async list() { return [shop()]; } },
    now: () => new Date("2026-08-08T00:00:00.000Z"),
  });
  const completed = await service.runSync({ dateFrom: "2026-08-01", dateTo: "2026-08-05" });
  const gateway = calls.find((call) => call.type === "gateway");
  assert.equal(gateway.input.startTime, "2026-08-04T00:00:00+07:00");
  assert.equal(gateway.input.endTime, "2026-08-05T23:59:59+07:00");
  assert.deepEqual(calls.find((call) => call.type === "replace"), { type: "replace", dateFrom: "2026-08-04", dateTo: "2026-08-05" });
  assert.equal(completed.status, "COMPLETE");
});

test("daily runner fills the previous Shanghai business day once after 09:30", async () => {
  const calls = [];
  const service = {
    async status() { return { run: null }; },
    async runSync(input) { calls.push(input); return { id: "run-1", status: "COMPLETE", completedAt: "2026-08-08T02:00:00Z" }; },
  };
  const runner = new ProfitScheduleRunner({
    service,
    now: () => new Date("2026-08-08T02:00:00.000Z"),
  });
  await runner.runDue();
  await runner.runDue();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { dateFrom: "2026-08-07", dateTo: "2026-08-07", triggerType: "scheduled" });
  assert.equal(runner.status().mode, "PREVIOUS_DAY_MISSING_ONLY");
});
