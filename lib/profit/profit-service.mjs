import { randomUUID } from "node:crypto";
import {
  LAZADA_PROFIT_RULE_VERSION,
  lazadaTransactionWindow,
  prepareLazadaFinanceRows,
  SITE_CURRENCIES,
} from "./lazada-profit-adapter.mjs";
import { calculateLazadaShopProfit, selectedLazadaOrderNumbers } from "./profit-calculator.mjs";
import {
  convertLocalAmountToCny,
  PROFIT_FX_RULE_VERSION,
  resolveCountryExchangeRates,
} from "./profit-fx.mjs";
import {
  buildFinanceCoverage,
  defaultProfitRange,
  publicFinanceCoverage,
} from "./profit-date-coverage.mjs";
import { decimalToScaled, percentageString, scaledToDecimal } from "./profit-money.mjs";
import { calculateLazadaDailyExpenses, expenseTransactionDate } from "./expense-calculator.mjs";
import { decorateGmvResults, expenseRate } from "./gmv-calculator.mjs";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function profitError(message, code, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function dateRange(input = {}, now = new Date()) {
  const defaults = defaultProfitRange(now);
  const dateFrom = String(input.dateFrom || defaults.dateFrom).trim();
  const dateTo = String(input.dateTo || defaults.dateTo).trim();
  if (!DATE_PATTERN.test(dateFrom) || !DATE_PATTERN.test(dateTo) || dateFrom > dateTo) {
    throw profitError("利润日期范围无效。", "PROFIT_DATE_RANGE_INVALID");
  }
  const days = Math.round((Date.parse(`${dateTo}T00:00:00Z`) - Date.parse(`${dateFrom}T00:00:00Z`)) / 86_400_000) + 1;
  if (days > 92) throw profitError("单次利润同步最多支持 92 天。", "PROFIT_DATE_RANGE_TOO_LARGE");
  return { dateFrom, dateTo };
}

async function mapConcurrent(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

function hasMetricValue(row, field) {
  return row[field] !== null && row[field] !== undefined && row[field] !== "";
}

function rowsWithMetrics(results, fields) {
  return results.filter((row) => fields.every((field) => hasMetricValue(row, field)));
}

function sumAvailable(results, field) {
  const available = rowsWithMetrics(results, [field]);
  if (!available.length) return null;
  return scaledToDecimal(available.reduce((total, row) => total + decimalToScaled(row[field]), 0n));
}

function aggregateResults(results, { countryCode = null } = {}) {
  const currencies = [...new Set(results.map((row) => row.currency).filter(Boolean))];
  const mixedCurrency = currencies.length > 1;
  const listRevenueRows = rowsWithMetrics(results, ["listRevenue"]);
  const receivedRevenueRows = rowsWithMetrics(results, ["receivedRevenue"]);
  const totalCostRows = rowsWithMetrics(results, ["totalCost"]);
  const knownCostRows = results.filter((row) => row.dataStatus !== "FAILED" && hasMetricValue(row, "knownTotalCost"));
  const expenseRows = rowsWithMetrics(results, ["expenseValue"]);
  const gmvRows = rowsWithMetrics(results, ["gmvValue"]);
  const knownGmvRows = results.filter((row) => row.gmvDataStatus !== "FAILED" && hasMetricValue(row, "knownGmvValue"));
  const expenseRateRows = rowsWithMetrics(results, ["expenseValue", "gmvValue"]);
  const advertisingExpenseRows = rowsWithMetrics(results, ["advertisingExpenseSigned"]);
  const billingExpenseRows = rowsWithMetrics(results, ["billingExpenseSigned"]);
  const listMarginRows = rowsWithMetrics(results, ["listRevenue", "totalCost"]);
  const receivedMarginRows = rowsWithMetrics(results, ["receivedRevenue", "totalCost"]);
  const listToReceivedMarginRows = rowsWithMetrics(results, ["listRevenue", "receivedRevenue", "totalCost"]);
  const listRevenue = mixedCurrency ? null : sumAvailable(listRevenueRows, "listRevenue");
  const receivedRevenue = mixedCurrency ? null : sumAvailable(receivedRevenueRows, "receivedRevenue");
  const totalCost = mixedCurrency ? null : sumAvailable(totalCostRows, "totalCost");
  const knownTotalCost = mixedCurrency ? null : sumAvailable(knownCostRows, "knownTotalCost");
  const expenseValue = mixedCurrency ? null : sumAvailable(expenseRows, "expenseValue");
  const gmvValue = mixedCurrency ? null : sumAvailable(gmvRows, "gmvValue");
  const knownGmvValue = mixedCurrency ? null : sumAvailable(knownGmvRows, "knownGmvValue");
  const advertisingExpenseSigned = mixedCurrency ? null : sumAvailable(advertisingExpenseRows, "advertisingExpenseSigned");
  const billingExpenseSigned = mixedCurrency ? null : sumAvailable(billingExpenseRows, "billingExpenseSigned");
  const listMarginRevenue = mixedCurrency ? null : sumAvailable(listMarginRows, "listRevenue");
  const listMarginCost = mixedCurrency ? null : sumAvailable(listMarginRows, "totalCost");
  const receivedMarginRevenue = mixedCurrency ? null : sumAvailable(receivedMarginRows, "receivedRevenue");
  const receivedMarginCost = mixedCurrency ? null : sumAvailable(receivedMarginRows, "totalCost");
  const listToReceivedMarginList = mixedCurrency ? null : sumAvailable(listToReceivedMarginRows, "listRevenue");
  const listToReceivedMarginReceived = mixedCurrency ? null : sumAvailable(listToReceivedMarginRows, "receivedRevenue");
  const listToReceivedMarginCost = mixedCurrency ? null : sumAvailable(listToReceivedMarginRows, "totalCost");
  const list = listMarginRevenue === null ? null : decimalToScaled(listMarginRevenue);
  const listCost = listMarginCost === null ? null : decimalToScaled(listMarginCost);
  const received = receivedMarginRevenue === null ? null : decimalToScaled(receivedMarginRevenue);
  const receivedCost = receivedMarginCost === null ? null : decimalToScaled(receivedMarginCost);
  const listToReceivedList = listToReceivedMarginList === null ? null : decimalToScaled(listToReceivedMarginList);
  const listToReceivedReceived = listToReceivedMarginReceived === null ? null : decimalToScaled(listToReceivedMarginReceived);
  const listToReceivedCost = listToReceivedMarginCost === null ? null : decimalToScaled(listToReceivedMarginCost);
  return {
    countryCode,
    currency: mixedCurrency ? null : currencies[0] || (countryCode ? SITE_CURRENCIES[countryCode] : null),
    mixedCurrency,
    dataStatus: !results.length ? "EMPTY" : results.every((row) => row.dataStatus === "COMPLETE") ? "COMPLETE" : "PARTIAL",
    shopCount: results.length,
    completeShopCount: results.filter((row) => row.dataStatus === "COMPLETE").length,
    partialShopCount: results.filter((row) => row.dataStatus === "PARTIAL").length,
    failedShopCount: results.filter((row) => row.dataStatus === "FAILED").length,
    listRevenue,
    receivedRevenue,
    totalCost,
    knownTotalCost,
    expenseValue,
    gmvValue,
    knownGmvValue,
    expenseRate: mixedCurrency || !results.length || expenseRateRows.length !== results.length
      ? null : expenseRate(sumAvailable(expenseRateRows, "expenseValue"), sumAvailable(expenseRateRows, "gmvValue")),
    advertisingExpenseSigned,
    billingExpenseSigned,
    expenseDataStatus: !results.length ? "EMPTY" : results.every((row) => row.expenseDataStatus === "COMPLETE") ? "COMPLETE" : "PARTIAL",
    completeExpenseShopCount: results.filter((row) => row.expenseDataStatus === "COMPLETE").length,
    partialExpenseShopCount: results.filter((row) => row.expenseDataStatus !== "COMPLETE").length,
    gmvDataStatus: !results.length ? "EMPTY" : results.every((row) => row.gmvDataStatus === "COMPLETE") ? "COMPLETE" : "PARTIAL",
    completeGmvShopCount: results.filter((row) => row.gmvDataStatus === "COMPLETE").length,
    partialGmvShopCount: results.filter((row) => row.gmvDataStatus !== "COMPLETE").length,
    expenseRateDataStatus: !results.length ? "EMPTY"
      : results.every((row) => row.expenseRateDataStatus === "COMPLETE") ? "COMPLETE" : "PARTIAL",
    metricCoverage: {
      listRevenueShopCount: listRevenueRows.length,
      receivedRevenueShopCount: receivedRevenueRows.length,
      totalCostShopCount: totalCostRows.length,
      knownCostShopCount: knownCostRows.length,
      expenseShopCount: expenseRows.length,
      gmvShopCount: gmvRows.length,
      expenseRateShopCount: expenseRateRows.length,
      listProfitMarginShopCount: listMarginRows.length,
      receivedProfitMarginShopCount: receivedMarginRows.length,
      listToReceivedProfitMarginShopCount: listToReceivedMarginRows.length,
    },
    listProfitMargin: list === null || listCost === null ? null : percentageString(list - listCost, list),
    receivedProfitMargin: received === null || receivedCost === null
      ? null : percentageString(received - receivedCost, received),
    listToReceivedProfitMargin: listToReceivedList === null || listToReceivedReceived === null || listToReceivedCost === null
      ? null : percentageString(listToReceivedReceived - listToReceivedCost, listToReceivedList),
    selectedOrderCount: results.reduce((total, row) => total + row.selectedOrderCount, 0),
    missingOrderCount: results.reduce((total, row) => total + row.missingOrderCount, 0),
    missingCostLineCount: results.reduce((total, row) => total + row.missingCostLineCount, 0),
    ambiguousCostLineCount: results.reduce((total, row) => total + row.ambiguousCostLineCount, 0),
    gmvOrderCount: results.reduce((total, row) => total + Number(row.gmvOrderCount || 0), 0),
    confirmedGmvOrderCount: results.reduce((total, row) => total + Number(row.confirmedGmvOrderCount || 0), 0),
    missingGmvOrderCount: results.reduce((total, row) => total + Number(row.missingGmvOrderCount || 0), 0),
    conflictingGmvOrderCount: results.reduce((total, row) => total + Number(row.conflictingGmvOrderCount || 0), 0),
    invalidGmvOrderCount: results.reduce((total, row) => total + Number(row.invalidGmvOrderCount || 0), 0),
  };
}

function cnyEquivalent(metrics, exchangeRate) {
  return {
    currency: "CNY",
    listRevenue: convertLocalAmountToCny(metrics.listRevenue, exchangeRate),
    receivedRevenue: convertLocalAmountToCny(metrics.receivedRevenue, exchangeRate),
    totalCost: convertLocalAmountToCny(metrics.totalCost, exchangeRate),
    knownTotalCost: convertLocalAmountToCny(metrics.knownTotalCost, exchangeRate),
    expenseValue: convertLocalAmountToCny(metrics.expenseValue, exchangeRate),
    gmvValue: convertLocalAmountToCny(metrics.gmvValue, exchangeRate),
    knownGmvValue: convertLocalAmountToCny(metrics.knownGmvValue, exchangeRate),
    expenseRate: metrics.expenseRate ?? null,
    advertisingExpenseSigned: convertLocalAmountToCny(metrics.advertisingExpenseSigned, exchangeRate),
    billingExpenseSigned: convertLocalAmountToCny(metrics.billingExpenseSigned, exchangeRate),
    exchangeRate,
  };
}

function buildCnySummary(results, exchangeRates) {
  const ratesByCountry = new Map((exchangeRates || []).map((rate) => [rate.countryCode, rate]));
  const convertedResults = (results || []).map((row) => {
    const exchangeRate = ratesByCountry.get(row.countryCode);
    const equivalent = cnyEquivalent(row, exchangeRate);
    return {
      ...row,
      currency: "CNY",
      dataStatus: exchangeRate?.status === "MATCHED" ? row.dataStatus : "PARTIAL",
      expenseDataStatus: exchangeRate?.status === "MATCHED" ? row.expenseDataStatus : "PARTIAL",
      gmvDataStatus: exchangeRate?.status === "MATCHED" ? row.gmvDataStatus : "PARTIAL",
      expenseRateDataStatus: exchangeRate?.status === "MATCHED" ? row.expenseRateDataStatus : "PARTIAL",
      listRevenue: equivalent.listRevenue,
      receivedRevenue: equivalent.receivedRevenue,
      totalCost: equivalent.totalCost,
      knownTotalCost: equivalent.knownTotalCost,
      expenseValue: equivalent.expenseValue,
      gmvValue: equivalent.gmvValue,
      knownGmvValue: equivalent.knownGmvValue,
      advertisingExpenseSigned: equivalent.advertisingExpenseSigned,
      billingExpenseSigned: equivalent.billingExpenseSigned,
    };
  });
  const summary = aggregateResults(convertedResults, { countryCode: "ALL" });
  const countries = [...new Set((results || []).map((row) => row.countryCode).filter(Boolean))].sort();
  const matched = (exchangeRates || []).filter((rate) => rate.status === "MATCHED" && countries.includes(rate.countryCode));
  const missingCountries = (exchangeRates || []).filter((rate) => rate.status === "MISSING").map((rate) => rate.countryCode);
  const ambiguousCountries = (exchangeRates || []).filter((rate) => rate.status === "AMBIGUOUS").map((rate) => rate.countryCode);
  return {
    ...summary,
    countryCode: "ALL",
    currency: "CNY",
    mixedCurrency: false,
    exchangeRateRuleVersion: PROFIT_FX_RULE_VERSION,
    rateCoverage: {
      countryCount: countries.length,
      convertedCountryCount: matched.length,
      missingCountries,
      ambiguousCountries,
      source: "PRODUCT_PACKAGE_CURRENT",
      sourceField: "国家汇率",
      sourceUpdatedAt: matched.map((rate) => String(rate.sourceUpdatedAt || "")).filter(Boolean).sort().at(-1) || null,
    },
  };
}

function failedShopResult({ runId, shop, message }) {
  return {
    runId,
    platform: "LAZADA",
    canonicalShopId: shop.directoryShopId || null,
    connectorShopId: shop.id,
    shopCode: shop.shopCode,
    shopName: shop.shopName,
    countryCode: shop.country,
    currency: SITE_CURRENCIES[shop.country],
    dataStatus: "FAILED",
    listRevenue: null,
    receivedRevenue: null,
    totalCost: null,
    knownTotalCost: "0",
    listProfitMargin: null,
    receivedProfitMargin: null,
    listToReceivedProfitMargin: null,
    warnings: [{ code: "LAZADA_FINANCE_FETCH_FAILED", message: String(message || "读取失败").slice(0, 200) }],
  };
}

function emptyExpenseMetrics(expectedExpenseDayCount = 0, issues = []) {
  return {
    expenseDataStatus: "PARTIAL",
    advertisingExpenseSigned: null,
    billingExpenseSigned: null,
    sourceSignedTotal: null,
    expenseValue: null,
    expenseClassification: null,
    expenseDayCount: 0,
    completeExpenseDayCount: 0,
    expectedExpenseDayCount,
    advertisingExpenseRowCount: 0,
    billingExpenseRowCount: 0,
    duplicateExpenseGroupCount: 0,
    duplicateExpenseRemovedCount: 0,
    expenseRuleVersions: [],
    expenseIssues: issues,
  };
}

export class ProfitService {
  constructor({
    repository,
    platformGatewayService,
    shopDirectoryService,
    shopRepository = null,
    syncMabangOrders = null,
    financeConcurrency = 4,
    exchangeRateCacheTtlMs = 10 * 60 * 1000,
    previewCacheTtlMs = 5 * 60 * 1000,
    automaticSync = { enabled: true, timeZone: "Asia/Shanghai", scheduleTime: "09:30", mode: "PREVIOUS_DAY_MISSING_ONLY" },
    now = () => new Date(),
  } = {}) {
    if (!repository) throw new TypeError("Profit repository is required");
    if (!platformGatewayService) throw new TypeError("Platform Gateway service is required");
    if (!shopDirectoryService) throw new TypeError("Shop directory service is required");
    this.repository = repository;
    this.platformGatewayService = platformGatewayService;
    this.shopDirectoryService = shopDirectoryService;
    this.shopRepository = shopRepository;
    this.syncMabangOrders = syncMabangOrders;
    this.financeConcurrency = Math.max(1, Math.min(8, Number(financeConcurrency) || 4));
    this.now = now;
    this.activeRuns = new Map();
    this.exchangeRateCacheTtlMs = Math.max(60_000, Number(exchangeRateCacheTtlMs) || 10 * 60 * 1000);
    this.exchangeRateCache = null;
    this.exchangeRateCachePending = null;
    this.previewCacheTtlMs = Math.max(10_000, Number(previewCacheTtlMs) || 5 * 60 * 1000);
    this.previewCache = new Map();
    this.automaticSync = { ...automaticSync };
    const prewarm = setTimeout(() => {
      this.#countryExchangeRates(Object.keys(SITE_CURRENCIES)).catch(() => null);
    }, 0);
    prewarm.unref?.();
  }

  async #assertReady() {
    if (!await this.repository.isReady()) {
      throw profitError("利润模块数据库迁移尚未应用。", "PROFIT_MIGRATION_REQUIRED", 503);
    }
  }

  async #countryExchangeRates(countryCodes) {
    const requested = [...new Set((countryCodes || []).map((value) => String(value || "").trim().toUpperCase()).filter(Boolean))].sort();
    const now = Date.now();
    if (this.exchangeRateCache && this.exchangeRateCache.expiresAt > now) {
      return this.exchangeRateCache.rates.filter((rate) => requested.includes(rate.countryCode));
    }
    if (!this.exchangeRateCachePending) {
      const allCountryCodes = Object.keys(SITE_CURRENCIES).sort();
      this.exchangeRateCachePending = this.repository.countryExchangeRateCandidates({ countryCodes: allCountryCodes })
        .then((candidates) => {
          const rates = resolveCountryExchangeRates(candidates, allCountryCodes);
          this.exchangeRateCache = { rates, expiresAt: Date.now() + this.exchangeRateCacheTtlMs };
          return rates;
        })
        .finally(() => { this.exchangeRateCachePending = null; });
    }
    const rates = await this.exchangeRateCachePending;
    return rates.filter((rate) => requested.includes(rate.countryCode));
  }

  async #shops() {
    let shops = (await this.shopDirectoryService.list({ platform: "lazada" }))
      .filter((shop) => shop.callable && shop.identityStatus === "CONFIRMED")
      .sort((left, right) => `${left.country}|${left.shopCode}`.localeCompare(`${right.country}|${right.shopCode}`));
    if (!this.shopRepository) return shops;
    const canonicalRows = await this.shopRepository.getByIds(shops.map((shop) => shop.directoryShopId).filter(Boolean));
    const canonicalById = new Map(canonicalRows.map((shop) => [shop.id, shop]));
    return shops.map((shop) => {
      const canonical = canonicalById.get(shop.directoryShopId);
      return canonical ? {
        ...shop,
        directoryShopId: canonical.id,
        shopCode: canonical.shopCode || shop.shopCode,
        shopName: canonical.shopName || shop.shopName,
        country: canonical.countryCode || shop.country,
        normalizedShopName: canonical.normalizedShopName || shop.normalizedShopName,
        growthShopId: canonical.growthShopId || shop.growthShopId || null,
      } : shop;
    });
  }

  async #coverage(range, shops) {
    const windows = await this.repository.financeCoverageWindows({
      platform: "LAZADA",
      connectorShopIds: shops.map((shop) => shop.id),
      ...range,
    });
    return buildFinanceCoverage({ shops, windows, ...range });
  }

  async #expenseCoverage(range, shops) {
    if (typeof this.repository.dailyExpenseFactsForRange !== "function") {
      return buildFinanceCoverage({ shops, windows: [], ...range });
    }
    const facts = await this.repository.dailyExpenseFactsForRange({
      platform: "LAZADA", connectorShopIds: shops.map((shop) => shop.id), ...range,
    });
    const windows = facts.filter((fact) => fact.dataStatus === "COMPLETE" && fact.sourceComplete).map((fact) => ({
      connectorShopId: fact.connectorShopId,
      dateFrom: fact.transactionDate,
      dateTo: fact.transactionDate,
      completedAt: fact.calculatedAt,
    }));
    return buildFinanceCoverage({ shops, windows, ...range });
  }

  async #decorateExpenses(results, range) {
    const expected = Math.round((Date.parse(`${range.dateTo}T00:00:00Z`) - Date.parse(`${range.dateFrom}T00:00:00Z`)) / 86_400_000) + 1;
    if (typeof this.repository.expenseAggregatesForRange !== "function") {
      return results.map((row) => ({ ...row, ...emptyExpenseMetrics(expected, ["EXPENSE_REPOSITORY_UNAVAILABLE"]) }));
    }
    const aggregates = await this.repository.expenseAggregatesForRange({
      platform: "LAZADA", connectorShopIds: results.map((row) => row.connectorShopId), ...range,
    });
    const byShop = new Map(aggregates.map((row) => [row.connectorShopId, row]));
    return results.map((row) => ({ ...row, ...(byShop.get(row.connectorShopId) || emptyExpenseMetrics(expected)) }));
  }

  async #calculateResults({ range, shops, financeRows = null, orderLines = null, runId = null }) {
    const rows = financeRows || await this.repository.financeRowsForRange({
      platform: "LAZADA",
      connectorShopIds: shops.map((shop) => shop.id),
      ...range,
    });
    const rowsByShop = new Map();
    for (const row of rows) {
      const shopId = String(row.connector_shop_id || row.connectorShopId || "").trim();
      if (!rowsByShop.has(shopId)) rowsByShop.set(shopId, []);
      rowsByShop.get(shopId).push(row);
    }
    const ordersByShop = new Map(shops.map((shop) => [shop.id, selectedLazadaOrderNumbers(rowsByShop.get(shop.id) || [])]));
    const selectedOrders = [...new Set([...ordersByShop.values()].flat())];
    const resolvedOrderLines = orderLines || await this.repository.orderCostInputs(selectedOrders);
    const linesByOrder = new Map();
    for (const line of resolvedOrderLines) {
      if (!linesByOrder.has(line.transactionId)) linesByOrder.set(line.transactionId, []);
      linesByOrder.get(line.transactionId).push(line);
    }
    const skusByCountry = new Map();
    for (const shop of shops) {
      if (!skusByCountry.has(shop.country)) skusByCountry.set(shop.country, new Set());
      for (const orderNo of ordersByShop.get(shop.id) || []) {
        for (const line of linesByOrder.get(orderNo) || []) {
          const sku = line.normalizedSourceSku || line.sourceSku;
          if (sku) skusByCountry.get(shop.country).add(sku);
        }
      }
    }
    const costRowsByCountry = new Map();
    await Promise.all([...skusByCountry].map(async ([countryCode, skus]) => {
      costRowsByCountry.set(countryCode, await this.repository.productCostRows({ countryCode, skus: [...skus] }));
    }));
    const calculatedAt = this.now().toISOString();
    const results = shops.map((shop) => {
      const shopFinanceRows = rowsByShop.get(shop.id) || [];
      const shopOrderLines = (ordersByShop.get(shop.id) || []).flatMap((orderNo) => linesByOrder.get(orderNo) || []);
      const calculated = calculateLazadaShopProfit({
        financeRows: shopFinanceRows,
        orderLines: shopOrderLines,
        productCostRows: costRowsByCountry.get(shop.country) || [],
      });
      const { selectedOrders: ignoredSelectedOrders, ...metrics } = calculated;
      return {
        ...metrics,
        id: runId ? undefined : `preview:${shop.id}`,
        runId,
        platform: "LAZADA",
        canonicalShopId: shop.directoryShopId || null,
        connectorShopId: shop.id,
        shopCode: shop.shopCode,
        shopName: shop.shopName,
        countryCode: shop.country,
        currency: SITE_CURRENCIES[shop.country],
        calculatedAt,
      };
    });
    return { results, selectedOrders, orderLines: resolvedOrderLines, calculatedAt };
  }

  async #previewRange(range, shops) {
    const key = `${range.dateFrom}:${range.dateTo}:${shops.map((shop) => shop.id).sort().join("|")}`;
    const now = Date.now();
    const cached = this.previewCache.get(key);
    if (cached && cached.expiresAt > now) return cached.promise;
    const promise = this.#calculateResults({ range, shops }).catch((error) => {
      this.previewCache.delete(key);
      throw error;
    });
    this.previewCache.set(key, { promise, expiresAt: now + this.previewCacheTtlMs });
    return promise;
  }

  #clearPreviewCache() {
    this.previewCache.clear();
  }

  async startSync(input = {}) {
    await this.#assertReady();
    const range = dateRange(input, this.now());
    const lockKey = `LAZADA:${range.dateFrom}:${range.dateTo}`;
    const active = this.activeRuns.get(lockKey);
    if (active) return { accepted: false, reused: true, runId: active.runId, ...range };
    if (!input.forceRefresh) {
      const existing = await this.repository.latestRun({ platform: "LAZADA", ...range });
      if (existing && ["COMPLETE", "PARTIAL"].includes(existing.status) && existing.currentStage === "COMPLETE") {
        const shops = await this.#shops();
        const expenseCoverage = await this.#expenseCoverage(range, shops);
        if (expenseCoverage.status === "COVERED") {
          return { accepted: false, reused: true, runId: existing.id, shopCount: existing.totalShopCount, ...range };
        }
      }
    }
    const shops = await this.#shops();
    const run = await this.repository.createRun({
      id: randomUUID(), platform: "LAZADA", ...range, ruleVersion: LAZADA_PROFIT_RULE_VERSION,
      totalShopCount: shops.length, currentStage: "FETCHING_FINANCE", startedAt: this.now().toISOString(),
    });
    const promise = this.#executeRun(run, shops)
      .catch(async (error) => {
        await this.repository.updateRun(run.id, {
          status: "FAILED", currentStage: "FAILED", completedAt: this.now().toISOString(),
          warnings: [{ code: error?.code || "PROFIT_SYNC_FAILED", message: String(error?.message || error).slice(0, 240) }],
        }).catch(() => {});
      })
      .finally(() => this.activeRuns.delete(lockKey));
    this.activeRuns.set(lockKey, { runId: run.id, promise });
    return { accepted: true, reused: false, runId: run.id, shopCount: shops.length, ...range };
  }

  async runSync(input = {}) {
    const started = await this.startSync(input);
    const lockKey = `LAZADA:${started.dateFrom}:${started.dateTo}`;
    const active = this.activeRuns.get(lockKey);
    if (active) await active.promise;
    return this.repository.getRun(started.runId);
  }

  async #executeRun(run, shops) {
    const range = { dateFrom: run.dateFrom, dateTo: run.dateTo };
    const coverageBefore = await this.#coverage(range, shops);
    const expenseCoverageBefore = await this.#expenseCoverage(range, shops);
    const fetchedAt = this.now().toISOString();
    const finance = await mapConcurrent(shops, this.financeConcurrency, async (shop) => {
      try {
        const missingRanges = coverageBefore.missingByShop.get(shop.id) || [];
        for (const missing of missingRanges) {
          const window = lazadaTransactionWindow(shop.country, missing.dateFrom, missing.dateTo);
          const response = await this.platformGatewayService.getFinanceTransactions({
            platform: "lazada", shopId: shop.id, input: window,
          });
          const prepared = prepareLazadaFinanceRows({
            records: response.data.records, shop, fetchedAt, providerRequestId: response.data.providerRequestId,
          }).filter((row) => row.transactionDate >= missing.dateFrom && row.transactionDate <= missing.dateTo);
          await this.repository.replaceFinanceWindow({
            platform: "LAZADA", connectorShopId: shop.id, ...missing, rows: prepared,
          });
        }
        const expensePersistenceAvailable = typeof this.repository.replaceExpenseTransactionWindow === "function"
          && typeof this.repository.upsertDailyExpenseFacts === "function"
          && typeof this.platformGatewayService.getExpenseTransactions === "function";
        const expenseMissingRanges = expensePersistenceAvailable
          ? expenseCoverageBefore.missingByShop.get(shop.id) || []
          : [];
        for (const missing of expenseMissingRanges) {
          let advertisingRows = [];
          let advertisingSourceComplete = false;
          let expenseIssue = null;
          try {
            const response = await this.platformGatewayService.getExpenseTransactions({
              platform: "lazada", shopId: shop.id,
              input: { ...missing, currency: SITE_CURRENCIES[shop.country] },
            });
            advertisingRows = (response.data.records || []).map((row) => ({
              canonicalShopId: shop.directoryShopId || null,
              countryCode: shop.country,
              currency: row.currency || SITE_CURRENCIES[shop.country],
              transactionDate: expenseTransactionDate(row.transactionDate),
              transactionTime: /^\d{4}-\d{2}-\d{2}T/.test(String(row.transactionDate || "")) ? row.transactionDate : null,
              transactionType: row.transactionType,
              transactionSubtype: row.transactionSubtype,
              amount: row.amount,
              transactionNumber: row.transactionNumber,
              remarks: row.remarks,
              sourceWindow: row.sourceWindow || `${missing.dateFrom}:${missing.dateTo}`,
              providerRequestId: response.data.providerRequestId || null,
              fetchedAt,
            })).filter((row) => row.transactionDate >= missing.dateFrom && row.transactionDate <= missing.dateTo);
            advertisingSourceComplete = response.data.paginationComplete === true;
            await this.repository.replaceExpenseTransactionWindow({
              platform: "LAZADA", connectorShopId: shop.id, ...missing, rows: advertisingRows,
            });
          } catch (error) {
            expenseIssue = error?.code || "LAZADA_ADVERTISING_FETCH_FAILED";
          }
          const billingRows = await this.repository.financeRows({
            platform: "LAZADA", connectorShopId: shop.id, ...missing,
          });
          const expense = calculateLazadaDailyExpenses({
            shop: { ...shop, currency: SITE_CURRENCIES[shop.country] },
            ...missing,
            advertisingRows,
            financeRows: billingRows,
            advertisingSourceComplete,
            financeSourceComplete: true,
            calculatedAt: fetchedAt,
          });
          if (expenseIssue) expense.facts.forEach((fact) => fact.issues.push(expenseIssue));
          await this.repository.upsertDailyExpenseFacts(expense.facts);
        }
        const rows = await this.repository.financeRows({
          platform: "LAZADA", connectorShopId: shop.id, dateFrom: run.dateFrom, dateTo: run.dateTo,
        });
        return { shop, rows, failed: false, fetchedRanges: missingRanges };
      } catch (error) {
        return { shop, rows: [], failed: true, error };
      }
    });
    const successful = finance.filter((item) => !item.failed);
    const selectedOrders = [...new Set(successful.flatMap((item) => selectedLazadaOrderNumbers(item.rows)))];
    await this.repository.updateRun(run.id, {
      currentStage: "RESOLVING_MABANG_ORDERS", financeSuccessCount: successful.length,
      selectedOrderCount: selectedOrders.length,
    });

    let orderLines = await this.repository.orderCostInputs(selectedOrders);
    const linkedBefore = new Set(orderLines.map((line) => line.transactionId));
    const missingBefore = selectedOrders.filter((orderNo) => !linkedBefore.has(orderNo));
    const runWarnings = [];
    if (coverageBefore.coveredShopDays) {
      runWarnings.push({
        code: "FINANCE_CACHE_REUSED",
        coveredShopDays: coverageBefore.coveredShopDays,
        fetchedShopDays: coverageBefore.missingShopDays,
      });
    }
    let mabangSyncStatus = "NOT_REQUIRED";
    if (missingBefore.length) {
      if (typeof this.syncMabangOrders === "function") {
        mabangSyncStatus = "RUNNING";
        await this.repository.updateRun(run.id, { mabangSyncStatus, currentStage: "SYNCING_MABANG_ORDERS" });
        try {
          if (missingBefore.length > 200) {
            await this.syncMabangOrders({
              mode: "date_range", dateFrom: run.dateFrom, dateTo: run.dateTo,
              missingOrderNumbers: missingBefore, runId: run.id, platform: "LAZADA",
            });
            orderLines = await this.repository.orderCostInputs(selectedOrders);
          }
          const linkedAfterRange = new Set(orderLines.map((line) => line.transactionId));
          const stillMissing = selectedOrders.filter((orderNo) => !linkedAfterRange.has(orderNo));
          for (let offset = 0; offset < stillMissing.length; offset += 1000) {
            await this.syncMabangOrders({
              mode: "references", dateFrom: run.dateFrom, dateTo: run.dateTo,
              missingOrderNumbers: stillMissing.slice(offset, offset + 1000), runId: run.id, platform: "LAZADA",
            });
          }
          if (stillMissing.length) {
            orderLines = await this.repository.orderCostInputs(selectedOrders);
          }
          const linkedAfterExact = new Set(orderLines.map((line) => line.transactionId));
          const unresolved = selectedOrders.filter((orderNo) => !linkedAfterExact.has(orderNo));
          mabangSyncStatus = unresolved.length ? "PARTIAL" : "COMPLETE";
          if (unresolved.length) runWarnings.push({ code: "MABANG_ORDERS_UNRESOLVED", count: unresolved.length });
        } catch (error) {
          mabangSyncStatus = "FAILED";
          runWarnings.push({ code: error?.code || "MABANG_SYNC_FAILED", message: String(error?.message || error).slice(0, 240) });
        }
      } else {
        mabangSyncStatus = "NOT_CONFIGURED";
        runWarnings.push({ code: "MABANG_SYNC_NOT_CONFIGURED", count: missingBefore.length });
      }
    }
    await this.repository.updateRun(run.id, { mabangSyncStatus, currentStage: "CALCULATING_SHOPS", warnings: runWarnings });

    const calculated = await this.#calculateResults({
      range,
      shops: successful.map((item) => item.shop),
      financeRows: successful.flatMap((item) => item.rows),
      orderLines,
      runId: run.id,
    });
    for (const result of calculated.results) await this.repository.upsertShopResult(result);
    for (const item of finance.filter((entry) => entry.failed)) {
      await this.repository.upsertShopResult(failedShopResult({ runId: run.id, shop: item.shop, message: item.error?.message }));
    }
    const results = await this.repository.resultsForRun(run.id);
    const complete = results.filter((row) => row.dataStatus === "COMPLETE").length;
    const partial = results.filter((row) => row.dataStatus === "PARTIAL").length;
    const failed = results.filter((row) => row.dataStatus === "FAILED").length;
    const status = failed === results.length && results.length ? "FAILED" : partial || failed ? "PARTIAL" : "COMPLETE";
    await this.repository.updateRun(run.id, {
      status, currentStage: "COMPLETE", completeShopCount: complete, partialShopCount: partial,
      failedShopCount: failed, completedAt: this.now().toISOString(), warnings: runWarnings,
    });
    this.#clearPreviewCache();
  }

  async status(input = {}) {
    await this.#assertReady();
    const range = dateRange(input, this.now());
    return { range, run: await this.repository.latestRun({ platform: "LAZADA", ...range }) };
  }

  async dashboard(input = {}) {
    await this.#assertReady();
    const range = dateRange(input, this.now());
    const shops = await this.#shops();
    const coverage = await this.#coverage(range, shops);
    const run = await this.repository.latestRun({ platform: "LAZADA", ...range });
    let allResults = [];
    let calculation = null;
    if (run && run.status !== "FAILED") {
      allResults = await this.repository.resultsForRun(run.id);
      calculation = {
        mode: "SNAPSHOT",
        calculatedAt: run.completedAt || run.updatedAt || run.startedAt,
        costBasis: "SNAPSHOT_AT_CALCULATION",
        sourceRunId: run.id,
      };
    } else if (coverage.status === "COVERED") {
      const preview = await this.#previewRange(range, shops);
      allResults = preview.results;
      calculation = {
        mode: "CACHED_PREVIEW",
        calculatedAt: preview.calculatedAt,
        costBasis: "PRODUCT_PACKAGE_CURRENT",
        sourceRunId: null,
      };
    }
    allResults = await this.#decorateExpenses(allResults, range);
    allResults = await decorateGmvResults({
      repository: this.repository, platform: "LAZADA", results: allResults, shops, range,
    });
    const shopsById = new Map(shops.map((shop) => [shop.id, shop]));
    allResults = allResults.map((row) => {
      const shop = shopsById.get(row.connectorShopId);
      return shop ? {
        ...row,
        canonicalShopId: shop.directoryShopId || row.canonicalShopId || null,
        shopCode: shop.shopCode || row.shopCode,
        shopName: shop.shopName || row.shopName,
        countryCode: shop.country || row.countryCode,
        currency: SITE_CURRENCIES[shop.country] || row.currency,
      } : row;
    });
    const countryCodes = [...new Set(allResults.map((row) => row.countryCode))].sort();
    const exchangeRates = await this.#countryExchangeRates(countryCodes)
      .catch(() => resolveCountryExchangeRates([], countryCodes));
    const exchangeRatesByCountry = new Map(exchangeRates.map((rate) => [rate.countryCode, rate]));
    const countries = countryCodes.map((countryCode) => {
      const aggregate = aggregateResults(allResults.filter((row) => row.countryCode === countryCode), { countryCode });
      const exchangeRate = exchangeRatesByCountry.get(countryCode);
      return { ...aggregate, exchangeRate, cnyEquivalent: cnyEquivalent(aggregate, exchangeRate) };
    });
    const country = String(input.country || "").trim().toUpperCase();
    const shopId = String(input.shopId || "").trim();
    const filtered = allResults.filter((row) => (!country || row.countryCode === country)
      && (!shopId || row.connectorShopId === shopId));
    return {
      platform: "LAZADA",
      ruleVersion: run?.ruleVersion || LAZADA_PROFIT_RULE_VERSION,
      range,
      run,
      calculation,
      coverage: publicFinanceCoverage(coverage),
      automation: this.automaticSync,
      filters: {
        countries: [...new Set(shops.map((shop) => shop.country))].sort(),
        shops: shops.map((shop) => ({
          id: shop.id, shopCode: shop.shopCode, shopName: shop.shopName,
          countryCode: shop.country, currency: SITE_CURRENCIES[shop.country],
        })),
      },
      selection: aggregateResults(filtered, { countryCode: country || null }),
      countries,
      shops: filtered,
      exchangeRates,
      cnySummary: buildCnySummary(allResults, exchangeRates),
    };
  }
}

export { aggregateResults, buildCnySummary, cnyEquivalent, dateRange };
