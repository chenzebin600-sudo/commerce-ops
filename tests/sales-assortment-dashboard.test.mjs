import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { GrowthRadarService } from "../lib/growth-radar/growth-radar-service.mjs";
import { resolvePythonRuntime } from "../lib/python-runtime.mjs";
import { SalesAssortmentAnalysisStore } from "../lib/sales-assortment/sales-assortment-analysis-store.mjs";
import { SalesAssortmentAiService } from "../lib/sales-assortment/sales-assortment-ai-service.mjs";
import {
  buildSalesAssortmentDailyReport,
  salesDailyReportScopeFor,
  salesReportDateFor,
} from "../lib/sales-assortment/sales-assortment-daily-report.mjs";
import { SalesAssortmentService } from "../lib/sales-assortment/sales-assortment-service.mjs";
import { LocalStorageProvider } from "../lib/storage/local-storage-provider.mjs";

const root = path.resolve(".");
const python = resolvePythonRuntime({ appRoot: root, requiredModules: ["openpyxl"] });

function repositoryFixture() {
  return {
    sourceStatus: async () => ({
      order: { row_count: 2, collected_at: "2026-07-30T00:00:00Z" },
      inventory: { row_count: 1, collected_at: "2026-07-30T00:00:00Z" },
      productPackage: { row_count: 1, source_period: "202607" },
    }),
    warehouseMappings: async () => [],
    productPackageRows: async () => [{
      country_normalized: "泰国",
      sku_normalized: "SKU-1",
      warehouse_normalized: "泰国A仓",
      product_name: "测试产品",
      category_l1: "家居",
      category_l2: "收纳",
      style_name: "测试款",
      main_sku_code: "MAIN-1",
      cost_cny: "10",
      cost_local: "50",
      exchange_rate: "5",
      exchange_direction: null,
    }],
    latestInventoryRows: async () => ({
      batch: { id: "inventory-1" },
      rows: [{
        normalized_source_sku: "SKU-1",
        normalized_warehouse_name: "泰国A仓",
        source_visible_sales_7d: 10,
        source_visible_sales_28d: 40,
        source_visible_sales_42d: 60,
        source_predicted_daily_sales: 5,
        available_quantity: 100,
        in_transit_quantity: 20,
        product_status: "正常销售",
        category_level_1: "家居",
        category_level_2: "收纳",
        raw_values_json: JSON.stringify({
          中文名称: "测试产品",
          活跃度: "旺款",
          是否新款: "是",
          当前可售天数: 50,
        }),
      }],
    }),
    currentOrderRows: async () => [{
      order_header_id: "order-older",
      order_line_id: "line-older",
      normalized_source_sku: "SKU-1",
      normalized_source_warehouse_name: "泰国A仓",
      quantity: 10,
      line_amount: null,
      line_amount_status: "unavailable",
      order_currency: "CNY",
      product_name: "测试产品",
      paid_at: "2026-07-17 10:00:00",
      platform: "shopee",
      source_shop_name: "测试店",
      raw_values_json: JSON.stringify({ 店长: "张三" }),
    }, {
      order_header_id: "order-current",
      order_line_id: "line-current",
      normalized_source_sku: "SKU-1",
      normalized_source_warehouse_name: "泰国A仓",
      quantity: 2,
      line_amount: null,
      line_amount_status: "unavailable",
      order_currency: "CNY",
      product_name: "测试产品",
      paid_at: "2026-07-30 10:00:00",
      platform: "shopee",
      source_shop_name: "测试店",
      raw_values_json: JSON.stringify({ 店长: "张三" }),
    }],
  };
}

test("sales assortment dashboard compares assortment and own standardized estimates with one CNY basis", async () => {
  const dashboard = await new SalesAssortmentService({
    repository: repositoryFixture(),
  }).dashboard({ periodDays: 7 });

  assert.equal(dashboard.summary.assortmentQuantity, 5);
  assert.equal(dashboard.summary.assortmentDailyAmount, 100);
  assert.equal(dashboard.summary.assortmentAmount, 100);
  assert.equal(dashboard.summary.ownQuantity, 2);
  assert.equal(dashboard.summary.ownAmount, 40);
  assert.equal(dashboard.summary.ownEstimatedAmount, 40);
  assert.equal(dashboard.summary.ownAmountStatus, "estimated");
  assert.equal(dashboard.summary.ownShareStatus, "estimated");
  assert.equal(dashboard.summary.gapAmountStatus, "estimated");
  assert.equal(dashboard.summary.averageOrderValueStatus, "estimated");
  assert.equal(dashboard.summary.actualSalesAmount, null);
  assert.equal(dashboard.summary.actualSalesAmountAvailability, "unavailable");
  assert.equal(dashboard.summary.actualSalesAmountStatus, "unavailable");
  assert.equal(dashboard.summary.actualSalesAmountCurrency, null);
  assert.deepEqual(dashboard.summary.actualSalesOrderCoverage, {
    totalOrderCount: 1,
    confirmedOrderCount: 0,
    directOrderCount: 0,
    derivedOrderCount: 0,
    missingAmountOrderCount: 1,
    conflictingAmountOrderCount: 0,
    partialAttributionOrderCount: 0,
    currencyMissingOrderCount: 0,
    missingOrderKeyLineCount: 0,
  });
  assert.deepEqual(dashboard.summary.actualSalesLineCoverage, {
    totalLineCount: 1,
    confirmedLineCount: 0,
    unconfirmedLineCount: 0,
    unavailableLineCount: 1,
    currencyMissingLineCount: 0,
  });
  assert.equal(dashboard.summary.ownShare, 40);
  assert.equal(dashboard.summary.dailySalesGap, 60);
  assert.equal(dashboard.summary.ownDataDays, 1);
  assert.equal(dashboard.topProducts[0].productName, "测试产品");
  assert.equal(dashboard.stores[0].manager, "张三");
  assert.equal(dashboard.storeSalesTrend[0].changeRate, -80);
  assert.equal(dashboard.storeAnomalies.declines[0].platform, "shopee");
  assert.equal(dashboard.storeSalesTrend[0].impactAmount, 160);
  assert.equal(dashboard.storeSalesTrend[0].trendStatus, "decline");
  assert.equal(dashboard.productSalesRanking[0].rank, 1);
  assert.equal(dashboard.productSalesRanking[0].changeRate, -80);
  assert.equal(dashboard.styleAnomalies.declines[0].impactQuantity, 8);
  assert.equal(dashboard.styleAnomalies.declines[0].storeImpacts[0].store, "测试店");
  assert.equal(dashboard.styleAnomalies.declines[0].storeImpacts[0].quantityChange, -8);
  assert.equal(dashboard.businessOpportunities[0].opportunityAmount, 60);
  assert.equal(dashboard.businessOpportunities[0].inventoryValue, 2000);
  assert.equal(dashboard.priorityAlerts.some((item) => item.type === "store_decline"), true);
  assert.equal(dashboard.priorityAlerts.some((item) => item.type === "product_decline"), true);
  assert.equal(dashboard.dailyReport.summary.storeAnomalyCount, 1);
  assert.equal(dashboard.dailyReport.delivery.preferred, "dingtalk_interactive_card");
  assert.equal(dashboard.dailyReport.sections.movementWindows.stores7d.declines[0].store, "测试店");
  assert.deepEqual(dashboard.dailyReport.sections.movementWindows.stores7d.window, {
    currentFrom: "2026-07-24",
    currentTo: "2026-07-30",
    previousFrom: "2026-07-17",
    previousTo: "2026-07-23",
  });
  assert.deepEqual({
    currentFrom: dashboard.period.currentComparisonFrom,
    currentTo: dashboard.period.currentComparisonTo,
    previousFrom: dashboard.period.previousComparisonFrom,
    previousTo: dashboard.period.previousComparisonTo,
  }, {
    currentFrom: "2026-07-24",
    currentTo: "2026-07-30",
    previousFrom: "2026-07-17",
    previousTo: "2026-07-23",
  });
  assert.equal(dashboard.dailyReport.sections.movementWindows.styles7d.declines[0].storeImpacts[0].manager, "张三");
  assert.equal(dashboard.trend.length, 7);
  assert.equal(dashboard.contract.aggregationKey, "国家 + 商品中文名称");
  assert.equal(dashboard.contract.version, "SALES-ASSORTMENT-1.5.0");
  assert.equal(
    dashboard.contract.amountBasis,
    "我方标准化估值=订单商品数量×同国家50%目标利润标价；货盘标准化估值=库存预测日销量×同国家50%目标利润标价×订单有效付款日期天数；实际销售额按订单头的订单核算金额（人民币）并以唯一订单ID去重，每单仅计一次",
  );
  assert.equal(dashboard.contract.listPriceProfitTarget, 50);
  assert.equal(dashboard.contract.listPriceFormula, "50%目标利润标价=销售成本÷(1-50%)");
  assert.equal(dashboard.contract.dailySalesGapFormula, "(货盘标准化估值-我方标准化估值)÷我方数据天数");
});

test("sales assortment rejects invalid source and reversed date ranges instead of silently changing scope", async () => {
  const service = new SalesAssortmentService({ repository: repositoryFixture() });
  await assert.rejects(
    service.sourceRows({ source: "unexpected-source" }),
    { code: "SALES_ASSORTMENT_INVALID_SOURCE", status: 400 },
  );
  await assert.rejects(
    service.dashboard({ dateFrom: "2026-08-10", dateTo: "2026-08-01" }),
    { code: "SALES_ASSORTMENT_INVALID_DATE_RANGE", status: 400 },
  );
  await assert.rejects(
    service.dashboard({ dateFrom: "2026-08-01" }),
    { code: "SALES_ASSORTMENT_INVALID_DATE_RANGE", status: 400 },
  );
});

test("sales assortment counts an order header amount once and never sums repeated line amounts", async () => {
  const repository = repositoryFixture();
  const rows = await repository.currentOrderRows();
  repository.currentOrderRows = async () => rows.map((row, index) => ({
    ...row,
    order_header_id: "canonical-order-1",
    order_line_id: `canonical-line-${index + 1}`,
    source_order_id: "same-transaction",
    paid_at: "2026-07-30 10:00:00",
    order_amount: 138.42,
    order_amount_source_field: "订单核算金额（人民币）",
    order_currency: "CNY",
    line_amount: 999,
    line_amount_status: "unconfirmed",
  }));

  const dashboard = await new SalesAssortmentService({ repository }).dashboard({ periodDays: 1 });

  assert.equal(dashboard.summary.ownAmount, 240);
  assert.equal(dashboard.summary.ownAmountStatus, "estimated");
  assert.equal(dashboard.summary.actualSalesAmount, 138.42);
  assert.equal(dashboard.summary.actualSalesAmountAvailability, "available");
  assert.equal(dashboard.summary.actualSalesAmountStatus, "confirmed");
  assert.equal(dashboard.summary.actualSalesAmountCurrency, "CNY");
  assert.deepEqual(dashboard.summary.actualSalesAmountsByCurrency, { CNY: 138.42 });
  assert.equal(dashboard.summary.actualSalesOrderCoverage.totalOrderCount, 1);
  assert.equal(dashboard.summary.actualSalesOrderCoverage.confirmedOrderCount, 1);
  assert.equal(dashboard.summary.actualSalesOrderCoverage.directOrderCount, 1);
  assert.equal(dashboard.summary.actualSalesLineCoverage.confirmedLineCount, 2);
});

test("sales assortment derives missing CNY order amount from original currency amount and exchange rate", async () => {
  const repository = repositoryFixture();
  const rows = await repository.currentOrderRows();
  repository.currentOrderRows = async () => [{
    ...rows[1],
    order_amount: null,
    order_amount_source_field: null,
    order_currency: null,
    raw_values_json: JSON.stringify({
      店长: "张三",
      "订单核算金额（原始货币）": 100,
      "汇率（原始货币）": 1.5,
    }),
  }];

  const dashboard = await new SalesAssortmentService({ repository }).dashboard({ periodDays: 7 });

  assert.equal(dashboard.summary.actualSalesAmount, 150);
  assert.equal(dashboard.summary.actualSalesAmountAvailability, "available");
  assert.equal(dashboard.summary.actualSalesAmountStatus, "confirmed");
  assert.equal(dashboard.summary.actualSalesAmountCurrency, "CNY");
  assert.equal(dashboard.summary.actualSalesOrderCoverage.derivedOrderCount, 1);
});

test("sales assortment refuses to attribute a whole order amount to a partial product filter match", async () => {
  const repository = repositoryFixture();
  const rows = await repository.currentOrderRows();
  const selected = {
    ...rows[1],
    order_header_id: "mixed-product-order",
    order_line_id: "mixed-product-line-1",
    order_amount: 120,
    order_amount_source_field: "订单核算金额（人民币）",
  };
  const excluded = {
    ...selected,
    order_line_id: "mixed-product-line-2",
    normalized_source_sku: "SKU-OUTSIDE",
    source_sku: "SKU-OUTSIDE",
    product_name: "其他商品",
  };
  repository.currentOrderRows = async () => [selected, excluded];

  const dashboard = await new SalesAssortmentService({ repository }).dashboard({
    periodDays: 7,
    categoryL1: "家居",
  });

  assert.equal(dashboard.summary.actualSalesAmount, null);
  assert.equal(dashboard.summary.actualSalesAmountAvailability, "unavailable");
  assert.equal(dashboard.summary.actualSalesAmountStatus, "unavailable");
  assert.equal(dashboard.summary.actualSalesAmountCurrency, null);
  assert.equal(dashboard.summary.actualSalesOrderCoverage.partialAttributionOrderCount, 1);
  assert.equal(dashboard.summary.actualSalesOrderCoverage.confirmedOrderCount, 0);
});

test("sales assortment includes unmatched order lines in unfiltered actual sales coverage", async () => {
  const repository = repositoryFixture();
  const rows = await repository.currentOrderRows();
  const matched = {
    ...rows[1],
    order_header_id: "mixed-unfiltered-order",
    order_line_id: "mixed-unfiltered-line-1",
    order_amount: 120,
    order_amount_source_field: "订单核算金额（人民币）",
  };
  const unmatched = {
    ...matched,
    order_line_id: "mixed-unfiltered-line-2",
    normalized_source_sku: "SKU-NOT-IN-CURRENT-ASSORTMENT",
    source_sku: "SKU-NOT-IN-CURRENT-ASSORTMENT",
    product_name: "订单独有商品",
  };
  repository.currentOrderRows = async () => [matched, unmatched];

  const dashboard = await new SalesAssortmentService({ repository }).dashboard({ periodDays: 7 });

  assert.equal(dashboard.summary.actualSalesAmount, 120);
  assert.equal(dashboard.summary.actualSalesAmountAvailability, "available");
  assert.equal(dashboard.summary.actualSalesOrderCoverage.confirmedOrderCount, 1);
  assert.equal(dashboard.summary.actualSalesOrderCoverage.partialAttributionOrderCount, 0);
});

test("sales assortment exposes a clearly partial subtotal without treating missing order amounts as zero", async () => {
  const repository = repositoryFixture();
  const rows = await repository.currentOrderRows();
  repository.currentOrderRows = async () => [{
    ...rows[1],
    order_header_id: "confirmed-order",
    order_line_id: "confirmed-line",
    order_amount: 80,
    order_amount_source_field: "订单核算金额（人民币）",
  }, {
    ...rows[1],
    order_header_id: "missing-order",
    order_line_id: "missing-line",
    order_amount: null,
    order_amount_source_field: null,
  }];

  const dashboard = await new SalesAssortmentService({ repository }).dashboard({ periodDays: 7 });

  assert.equal(dashboard.summary.actualSalesAmount, 80);
  assert.equal(dashboard.summary.actualSalesAmountAvailability, "partial");
  assert.equal(dashboard.summary.actualSalesAmountStatus, "partial");
  assert.equal(dashboard.summary.actualSalesAmountCurrency, "CNY");
  assert.equal(dashboard.summary.actualSalesOrderCoverage.totalOrderCount, 2);
  assert.equal(dashboard.summary.actualSalesOrderCoverage.confirmedOrderCount, 1);
  assert.equal(dashboard.summary.actualSalesOrderCoverage.missingAmountOrderCount, 1);
});

test("sales assortment uses canonical order IDs even when transaction identifiers collide", async () => {
  const repository = repositoryFixture();
  const rows = await repository.currentOrderRows();
  repository.currentOrderRows = async () => [80, 20].map((orderAmount, index) => ({
    ...rows[1],
    order_header_id: `canonical-order-${index + 1}`,
    order_line_id: `canonical-line-${index + 1}`,
    source_order_id: "shared-source-order-id",
    order_amount: orderAmount,
    order_amount_source_field: "订单核算金额（人民币）",
  }));

  const dashboard = await new SalesAssortmentService({ repository }).dashboard({ periodDays: 7 });

  assert.equal(dashboard.summary.actualSalesAmount, 100);
  assert.equal(dashboard.summary.actualSalesOrderCoverage.totalOrderCount, 2);
  assert.equal(dashboard.summary.orderCount, 2);
});

test("sales assortment reuses an unchanged source revision across dashboard projections", async () => {
  const repository = repositoryFixture();
  const originalOrderRows = repository.currentOrderRows;
  let sourceRevision = "orders-1";
  let orderReads = 0;
  repository.sourceStatus = async () => ({
    order: { id: sourceRevision, row_count: 2 },
    inventory: { id: "inventory-1", row_count: 1 },
    productPackage: { id: "package-1", row_count: 1 },
  });
  repository.currentOrderRows = async () => {
    orderReads += 1;
    return originalOrderRows();
  };

  const service = new SalesAssortmentService({ repository });
  const [dashboard, trend] = await Promise.all([
    service.dashboard({ periodDays: 7 }),
    service.trend({ periodDays: 28 }),
  ]);
  assert.equal(orderReads, 1);
  assert.equal(dashboard.contract.version, "SALES-ASSORTMENT-1.5.0");
  assert.equal(Array.isArray(trend), true);

  const overview = await service.overview({ periodDays: 7 });
  assert.equal(orderReads, 1);
  assert.deepEqual(Object.keys(overview).sort(), ["stores", "summary", "trend"]);

  sourceRevision = "orders-2";
  await service.dashboard({ periodDays: 7 });
  assert.equal(orderReads, 1);
  await service.dashboard({ periodDays: 7, forceRefresh: true });
  assert.equal(orderReads, 2);
});

test("sales assortment trend projections do not retain full dashboards in the LRU cache", async () => {
  const service = new SalesAssortmentService({ repository: repositoryFixture() });

  await service.trend({ dateFrom: "2026-07-01", dateTo: "2026-07-30" });
  assert.equal(service.dashboardCache.size, 0);

  await service.dashboard({ dateFrom: "2026-07-01", dateTo: "2026-07-30" });
  assert.equal(service.dashboardCache.size, 1);
});

test("sales assortment bounds database order reads to the required comparison history", async () => {
  const repository = repositoryFixture();
  let receivedRange = null;
  const originalOrderRows = repository.currentOrderRows;
  repository.latestOrderDay = async () => "2026-07-30 10:00:00";
  repository.currentOrderRows = async (range) => {
    receivedRange = range;
    return originalOrderRows();
  };

  await new SalesAssortmentService({ repository }).dashboard({
    dateFrom: "2026-07-30",
    dateTo: "2026-07-30",
    comparisonDays: 7,
  });

  assert.deepEqual(receivedRange, {
    dateFrom: "2026-07-17",
    dateToExclusive: "2026-07-31",
  });
});

test("sales assortment shares product and inventory reference reads across date windows", async () => {
  const repository = repositoryFixture();
  const originalPackageRows = repository.productPackageRows;
  const originalInventoryRows = repository.latestInventoryRows;
  const originalOrderRows = repository.currentOrderRows;
  let packageReads = 0;
  let inventoryReads = 0;
  let orderReads = 0;
  repository.latestOrderDay = async () => "2026-07-30 10:00:00";
  repository.productPackageRows = async () => {
    packageReads += 1;
    return originalPackageRows();
  };
  repository.latestInventoryRows = async () => {
    inventoryReads += 1;
    return originalInventoryRows();
  };
  repository.currentOrderRows = async () => {
    orderReads += 1;
    return originalOrderRows();
  };

  const service = new SalesAssortmentService({ repository });
  await Promise.all([
    service.dashboard({ dateFrom: "2026-07-30", dateTo: "2026-07-30" }),
    service.trend({ dateFrom: "2026-07-01", dateTo: "2026-07-30" }),
  ]);

  assert.equal(packageReads, 1);
  assert.equal(inventoryReads, 1);
  assert.equal(orderReads, 2);
});

test("sales assortment amount uses distinct valid paid dates in the observation window", async () => {
  const repository = repositoryFixture();
  const sourceRows = await repository.currentOrderRows();
  repository.currentOrderRows = async () => [{
    ...sourceRows[1],
    quantity: 1,
    paid_at: "2026-07-29 10:00:00",
  }, {
    ...sourceRows[1],
    quantity: 2,
    paid_at: "2026-07-30 10:00:00",
  }];

  const dashboard = await new SalesAssortmentService({ repository }).dashboard({ periodDays: 7 });

  assert.equal(dashboard.summary.ownDataDays, 2);
  assert.equal(dashboard.summary.assortmentDailyAmount, 100);
  assert.equal(dashboard.summary.assortmentAmount, 200);
  assert.equal(dashboard.summary.ownAmount, 60);
  assert.equal(dashboard.summary.ownShare, 30);
  assert.equal(dashboard.summary.dailySalesGap, 70);
  assert.equal(dashboard.topProducts[0].gapAmount, 140);
  assert.equal(dashboard.opportunityMatrix[0].opportunityScore, 70);
  assert.equal(dashboard.stores[0].countryShare, 30);
  assert.equal(dashboard.dailyReport.summary.ownShare, 30);
  assert.equal(dashboard.trend[0].assortmentDailyAmount, 100);
});

test("sales assortment daily report keeps deterministic metrics when AI is unavailable", async () => {
  const dashboard = await new SalesAssortmentService({ repository: repositoryFixture() }).dashboard({ periodDays: 7 });
  dashboard.dailyReport.sections.movementWindows.styles7d.growth = [{
    style: "增长款",
    changeRate: 50,
    impactQuantity: 5,
    storeImpacts: [{
      store: "增长店",
      manager: "李四",
      quantityChange: 5,
      changeRate: 50,
    }],
  }];
  dashboard.dailyReport.sections.inventoryInsights = [{
    type: "low_stock",
    country: "泰国",
    productName: "测试产品",
    inventoryChange: -12,
    assortmentAmount: 500,
    action: "核查库存。",
  }];
  const report = buildSalesAssortmentDailyReport({ dashboard, generatedAt: new Date("2026-07-30T08:00:00Z") });

  assert.equal(report.version, "SALES-ASSORTMENT-DAILY-1.5.0");
  assert.match(report.markdown, /实际销售额：\*\*待确认\*\*/);
  assert.match(report.markdown, /我方标准化估值/);
  assert.match(report.markdown, /货盘标准化估值/);
  assert.doesNotMatch(report.markdown, /我方 GMV|货盘 GMV|GMV 缺口/);
  assert.match(report.markdown, /确定性规则/);
  assert.match(report.markdown, /店铺近7日趋势（最近7天环比前7天）/);
  assert.match(report.markdown, /库存快照变化/);
  assert.match(report.markdown, /🟢 下滑/);
  assert.match(report.markdown, /🔴 上涨/);
  assert.match(report.markdown, /主要影响店铺/);
  assert.match(report.markdown, /泰国 · 测试产品/);
  assert.equal(report.aiIncluded, false);
});

test("scheduled sales report always resolves to the previous Shanghai calendar day", () => {
  assert.equal(salesReportDateFor(new Date("2026-08-03T00:30:00.000Z")), "2026-08-02");
  assert.deepEqual(salesDailyReportScopeFor(new Date("2026-08-03T00:30:00.000Z")), {
    periodDays: 1,
    dateFrom: "2026-08-02",
    dateTo: "2026-08-02",
    comparisonDays: 7,
  });
});

test("sales anomalies rank material business impact ahead of tiny-base percentage swings", async () => {
  const repository = repositoryFixture();
  const base = (await repository.currentOrderRows())[1];
  repository.currentOrderRows = async () => [
    { ...base, source_shop_name: "大额店", quantity: 100, paid_at: "2026-07-29 10:00:00" },
    { ...base, source_shop_name: "大额店", quantity: 50, paid_at: "2026-07-30 10:00:00" },
    { ...base, source_shop_name: "小额店", quantity: 1, paid_at: "2026-07-29 10:00:00" },
  ];
  const dashboard = await new SalesAssortmentService({ repository }).dashboard({ periodDays: 2, comparisonDays: 1 });

  assert.equal(dashboard.storeAnomalies.declines[0].store, "大额店");
  assert.equal(dashboard.storeAnomalies.declines[0].impactAmount, 1000);
  assert.equal(dashboard.storeAnomalies.declines[1].store, "小额店");
});

test("inventory actions compare the latest two snapshots and carry standardized estimate evidence", async () => {
  const repository = repositoryFixture();
  repository.latestInventoryRows = async () => ({
    batch: { id: "inventory-current", collected_at: "2026-07-30T00:00:00Z" },
    rows: [{
      ...(await repositoryFixture().latestInventoryRows()).rows[0],
      available_quantity: 100,
    }],
  });
  repository.previousInventoryRows = async () => ({
    batch: { id: "inventory-previous", collected_at: "2026-07-29T00:00:00Z" },
    rows: [{ normalized_source_sku: "SKU-1", normalized_warehouse_name: "泰国A仓", available_quantity: 200 }],
  });
  const dashboard = await new SalesAssortmentService({ repository }).dashboard({ periodDays: 7 });
  const insight = dashboard.inventoryInsights.find((item) => item.productName === "测试产品");

  assert.equal(dashboard.inventoryComparison.comparable, true);
  assert.equal(insight.type, "rapid_drop");
  assert.equal(insight.inventoryChange, -100);
  assert.equal(insight.inventoryChangeRate, -50);
  assert.equal(insight.assortmentAmount, 100);
  assert.equal(insight.ownAmount, 40);
});

test("sales assortment source viewer exposes operational fields without order PII", async () => {
  const service = new SalesAssortmentService({
    repository: {
      sourceRows: async (source) => ({
        total: 1,
        rows: source === "orders" ? [{
          source_order_id: "ORDER-1",
          paid_at: "2026-07-30 10:00:00",
          source_shop_name: "测试店",
          platform: "Shopee",
          order_status: "已发货",
          source_warehouse_name: "泰国A仓",
          source_sku: "SKU-1",
          quantity: 2,
          line_amount: 18,
          line_amount_status: "unconfirmed",
          order_currency: "CNY",
          product_name: "测试产品",
          raw_values_json: JSON.stringify({ 店长: "张三", 客户姓名: "不应返回", 电话1: "13800000000" }),
        }] : source === "inventory" ? [{
          normalized_source_sku: "SKU-1",
          normalized_warehouse_name: "泰国A仓",
          source_predicted_daily_sales: 5,
          available_quantity: 100,
          in_transit_quantity: 20,
          raw_values_json: JSON.stringify({ 中文名称: "测试产品", 当前可售天数: 50 }),
        }] : [{
          sku_normalized: "SKU-1",
          country_normalized: "泰国",
          normalized_payload_json: JSON.stringify({ product_name: "测试产品", cost_cny: 10, cost_local: 50 }),
        }],
      }),
    },
  });

  const orders = await service.sourceRows({ source: "orders" });
  const inventory = await service.sourceRows({ source: "inventory" });
  const productPackage = await service.sourceRows({ source: "product-package" });

  assert.equal(orders.rows[0].manager, "张三");
  assert.equal(orders.rows[0].quantity, 2);
  assert.equal(orders.rows[0].lineAmount, 18);
  assert.equal(orders.rows[0].lineAmountStatus, "unconfirmed");
  assert.equal(orders.rows[0].currency, "CNY");
  assert.equal("客户姓名" in orders.rows[0], false);
  assert.equal("电话1" in orders.rows[0], false);
  assert.equal(inventory.rows[0].predictedDailySales, 5);
  assert.equal(productPackage.rows[0].targetPrice50, 100);
  assert.equal(productPackage.rows[0].targetPrice50Cny, 20);
});

test("sales assortment DeepSeek analysis keeps the first result until an explicit refresh", async () => {
  const dashboardService = new SalesAssortmentService({
    repository: repositoryFixture(),
  });
  const requests = [];
  const service = new SalesAssortmentAiService({
    dashboardService,
    configured: true,
    model: "deepseek-v4-flash",
    now: () => new Date("2026-07-31T08:00:00Z"),
    gateway: {
      complete: async (request) => {
        requests.push(request);
        return {
          success: true,
          provider: "deepseek",
          model: request.model,
          usage: { total_tokens: 123 },
          content: JSON.stringify({
            headline: "泰国家居货盘值得优先核查",
            overview: "货盘表现强于我方承接，库存能够支持人工测试。",
            conclusions: [{
              type: "opportunity",
              title: "测试产品承接不足",
              reason: "货盘销量高于我方销量。",
              evidence: ["货盘销量 10", "我方销量 2"],
            }],
            recommendations: [{
              priority: "P1",
              title: "核查测试店覆盖",
              action: "确认在线状态后安排低风险测试。",
              reason: "当前占比仅 20%。",
              evidence: ["我方占比 20%"],
            }],
            risks: [],
            dataLimitations: ["订单窗口仅 1 天"],
            modules: {
              trend: {
                headline: "近期开单趋势需要持续观察",
                summary: "当前订单窗口较短，先观察每日销量变化。",
                findings: [{
                  type: "observation",
                  title: "订单窗口较短",
                  reason: "现有趋势数据不足一个完整周期。",
                  evidence: ["订单窗口仅 1 天"],
                }],
                recommendations: [{
                  priority: "P2",
                  title: "补足趋势数据",
                  action: "继续每日导入订单后再判断趋势。",
                  reason: "短窗口不适合判断持续增长。",
                  evidence: ["订单窗口仅 1 天"],
                }],
                dataLimitations: ["趋势样本不足"],
              },
            },
          }),
        };
      },
    },
  });

  const first = await service.analyze({ periodDays: 7 });
  const second = await service.analyze({ periodDays: 7 });

  assert.equal(first.analysis.recommendations[0].priority, "P1");
  assert.equal(first.analysis.modules.trend.recommendations[0].priority, "P2");
  assert.equal(first.analysis.modules.stores, null);
  assert.equal(first.model, "deepseek-v4-flash");
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].moduleId, "sales_assortment");
  assert.deepEqual(requests[0].responseFormat, { type: "json_object" });
  assert.match(requests[0].messages[1].content, /货盘标准化估值/);
  assert.match(requests[0].messages[1].content, /绝不能称为实际销售额或 GMV/);
  assert.match(requests[0].messages[1].content, /trend=销售与货盘趋势/);
  assert.match(requests[0].messages[1].content, /storeSalesTrend/);
  assert.match(requests[0].messages[1].content, /productSalesRanking/);
  assert.match(requests[0].messages[1].content, /priorityAlerts/);
  assert.match(requests[0].messages[1].content, /storeDeclines=高影响下滑店铺/);
  assert.match(requests[0].messages[1].content, /绝对影响金额或销量/);
  assert.match(requests[0].messages[1].content, /dailyMovementWindows/);
  assert.doesNotMatch(requests[0].messages[1].content, /topProducts/);
  assert.doesNotMatch(requests[0].messages[1].content, /客户姓名|邮寄地址|电话1/);

  const refreshed = await service.analyze({ periodDays: 7, forceRefresh: true });
  assert.equal(refreshed.cached, false);
  assert.equal(requests.length, 2);
  assert.equal((await service.current()).cached, true);
});

test("sales assortment keeps the latest DeepSeek analysis across service restarts and recovers its backup", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "sales-assortment-ai-"));
  try {
    const storage = new LocalStorageProvider({ rootDir });
    const first = {
      id: "analysis-first",
      generatedAt: "2026-08-08T01:00:00.000Z",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      promptVersion: "SALES-ASSORTMENT-AI-1.4.0",
      cached: false,
      scope: {},
      period: {},
      sources: {},
      analysis: { modules: {} },
    };
    const second = { ...first, id: "analysis-second", generatedAt: "2026-08-08T02:00:00.000Z" };
    await new SalesAssortmentAnalysisStore({ storage }).save(first);
    await new SalesAssortmentAnalysisStore({ storage }).save(second);

    assert.equal((await new SalesAssortmentAnalysisStore({ storage }).load()).id, "analysis-second");
    await storage.put("latest.json", Buffer.from("{broken", "utf8"));

    let dashboardCalls = 0;
    let gatewayCalls = 0;
    const service = new SalesAssortmentAiService({
      dashboardService: { dashboard: async () => { dashboardCalls += 1; return {}; } },
      gateway: { complete: async () => { gatewayCalls += 1; return { success: false }; } },
      analysisStore: new SalesAssortmentAnalysisStore({ storage }),
      configured: false,
    });
    const restored = await service.current();

    assert.equal(restored.id, "analysis-first");
    assert.equal(restored.cached, true);
    assert.equal(dashboardCalls, 0);
    assert.equal(gatewayCalls, 0);
    assert.equal(await storage.exists("latest.pending.json"), false);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("sales assortment AI reports an explicit configuration gate", async () => {
  const service = new SalesAssortmentAiService({
    dashboardService: new SalesAssortmentService({ repository: repositoryFixture() }),
    configured: false,
    gateway: { complete: async () => ({ success: false }) },
  });
  assert.equal(service.status().configured, false);
  await assert.rejects(
    service.analyze({ periodDays: 7 }),
    (error) => error.code === "AI_NOT_CONFIGURED" && error.status === 503,
  );
});

test("growth radar import accepts large legitimate worksheets without relaxing other workbook gates", () => {
  const service = new GrowthRadarService({
    repository: {},
    pythonExecutable: "python",
    parserScript: "unused-parser.py",
    fileStorageConfig: {
      tempRoot: os.tmpdir(),
      workbookLimits: {
        maxEntryBytes: 64 * 1024 * 1024,
        maxUncompressedBytes: 200 * 1024 * 1024,
        maxCompressionRatio: 200,
      },
    },
  });

  assert.equal(service.fileStorageConfig.workbookLimits.maxEntryBytes, 128 * 1024 * 1024);
  assert.equal(service.fileStorageConfig.workbookLimits.maxUncompressedBytes, 200 * 1024 * 1024);
  assert.equal(service.fileStorageConfig.workbookLimits.maxCompressionRatio, 200);
});

test("order parser inherits only common fields for multiline order rows and keeps manager", async (t) => {
  if (!python.ok) return t.skip("openpyxl runtime unavailable");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sales-assortment-parser-"));
  const workbookPath = path.join(directory, "orders.xlsx");
  try {
    const create = [
      "from openpyxl import Workbook",
      "import sys",
      "wb=Workbook(); ws=wb.active; ws.title='订单明细'",
      "ws.append(['订单编号','交易编号','店铺名','平台','店长','订单状态','仓库','SKU','商品数量','商品中文名称','付款时间','订单核算金额（人民币）'])",
      "ws.append(['O-1','T-1','店铺A','Shopee','张三','已发货','泰国A仓','SKU-1',1,'产品A','2026-07-30 10:00:00',100])",
      "ws.append([None,None,None,None,None,None,'泰国A仓','SKU-2',2,'产品B',None,None])",
      "wb.save(sys.argv[1])",
    ].join(";");
    const created = spawnSync(python.executable, ["-c", create, workbookPath], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(created.status, 0, created.stderr);

    const parsed = spawnSync(python.executable, [
      path.join(root, "scripts", "growth-radar-parser.py"),
      workbookPath,
      "--domain",
      "order",
    ], {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });
    assert.equal(parsed.status, 0, parsed.stderr);
    const result = JSON.parse(parsed.stdout);
    assert.equal(result.rows[1].parseStatus, "parsed");
    assert.equal(result.rows[1].rawPayload["订单编号"], "O-1");
    assert.equal(result.rows[1].rawPayload["店长"], "张三");
    assert.equal(result.rows[1].rawTypes["订单编号"], "inherited");
    assert.equal(result.rows[1].rawPayload["订单核算金额（人民币）"], null);
    assert.equal(result.redactedHeaders.includes("店长"), false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("sales assortment is active in Vue while the former React island remains a frozen fallback", async () => {
  const [html, app, loader, policy, vuePage, vueService, importComponent, importService, shell, growthApi, server] = await Promise.all([
    fs.readFile(path.join(root, "public", "index.html"), "utf8"),
    fs.readFile(path.join(root, "public", "app.js"), "utf8"),
    fs.readFile(path.join(root, "public", "sales-assortment-dashboard-loader.mjs"), "utf8"),
    fs.readFile(path.join(root, "frontend", "frontend-policy.json"), "utf8"),
    fs.readFile(path.join(root, "frontend", "commerce-ops-vue", "src", "pages", "SalesAssortmentPage.vue"), "utf8"),
    fs.readFile(path.join(root, "frontend", "commerce-ops-vue", "src", "services", "sales-automation.ts"), "utf8"),
    fs.readFile(path.join(root, "frontend", "commerce-ops-vue", "src", "components", "SalesSourceImports.vue"), "utf8"),
    fs.readFile(path.join(root, "frontend", "commerce-ops-vue", "src", "services", "sales-imports.ts"), "utf8"),
    fs.readFile(path.join(root, "frontend", "commerce-ops-vue", "src", "layouts", "OpsShell.vue"), "utf8"),
    fs.readFile(path.join(root, "lib", "growth-radar", "growth-radar-api.mjs"), "utf8"),
    fs.readFile(path.join(root, "server.mjs"), "utf8"),
  ]);
  assert.equal(JSON.parse(policy).activeWorkspace, "commerce-ops-vue");
  assert.match(html, /data-page="sales-assortment"/);
  assert.match(html, /id="salesAssortmentDashboardRoot"/);
  assert.match(app, /createSalesAssortmentDashboard/);
  assert.match(loader, /mountSalesAssortmentDashboard/);
  assert.doesNotMatch(loader, /iframe/i);
  assert.match(vuePage, /数据自动化设置/);
  assert.match(vuePage, /ModuleAiInsight/);
  assert.match(vuePage, /DailyOperationsBrief/);
  assert.match(vuePage, /标准化估值下滑店铺/);
  assert.equal((vuePage.match(/店铺 \/ 平台/g) || []).length, 2);
  assert.match(vuePage, /anomalyComparisonPeriod\.current/);
  assert.match(vuePage, /anomalyComparisonPeriod\.previous/);
  assert.match(vuePage, /款名销量上涨/);
  assert.match(vuePage, /商业机会/);
  assert.match(vuePage, /库存行动/);
  assert.doesNotMatch(vuePage, /订单与库存定时采集/);
  assert.doesNotMatch(vuePage, /DeepSeek 经营分析/);
  assert.match(vuePage, /钉钉机器人/);
  assert.match(vuePage, /SalesSourceImports/);
  assert.match(vuePage, /近7天/);
  assert.match(vuePage, /近14天/);
  assert.match(vuePage, /近30天/);
  assert.match(importComponent, /订单表/);
  assert.match(importComponent, /库存表/);
  assert.match(importComponent, /产品包/);
  assert.match(importComponent, /人工导入与定时采集共用正式文件目录和事实数据表/);
  assert.match(importComponent, /查看.*数据/);
  assert.match(importService, /\/api\/growth-radar\/import\/\$\{kind\}\/preview/);
  assert.match(importService, /\/api\/product-center\/imports/);
  assert.match(importService, /\/api\/sales-assortment\/source-rows/);
  assert.doesNotMatch(shell, /GlobalFilterBar/);
  assert.match(growthApi, /manual-imports/);
  assert.match(growthApi, /mabang_manual_order/);
  assert.match(growthApi, /mabang_manual_inventory/);
  assert.match(server, /fileService: exportFileService/);
  assert.match(vuePage, /订单 SKU × 商品数量 × 同国家50%目标利润标价/);
  assert.match(vuePage, /预测日销 × 同国家50%目标利润标价/);
  assert.match(vuePage, /50%目标利润标价/);
  assert.match(vuePage, /按交易编号去重/);
  assert.match(vueService, /\/api\/sales-assortment\/analyze/);
});
