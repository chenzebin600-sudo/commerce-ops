import { randomUUID } from "node:crypto";
import {
  SHOPEE_PROFIT_RULE_SET_VERSION,
  SHOPEE_COUNTRY_RULES,
  calculateShopeeShopProfit,
  prepareShopeeFinanceRows,
  selectedShopeeOrderNumbers,
} from "./shopee-profit-adapter.mjs";
import { SITE_CURRENCIES } from "./lazada-profit-adapter.mjs";
import { aggregateResults, buildCnySummary, cnyEquivalent, dateRange } from "./profit-service.mjs";
import { resolveCountryExchangeRates } from "./profit-fx.mjs";
import { addDateDays, buildFinanceCoverage, publicFinanceCoverage } from "./profit-date-coverage.mjs";
import { decimalToScaled, percentageString, scaledToDecimal } from "./profit-money.mjs";
import { calculateShopeeDailyExpense, expenseTransactionDate } from "./expense-calculator.mjs";
import { decorateGmvResults } from "./gmv-calculator.mjs";

function profitError(message, code, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function normalized(value) {
  return String(value || "").normalize("NFKC").trim();
}

function countryCode(value) {
  return normalized(value).toUpperCase();
}

function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(profitError(
      "Shopee official statement acquisition timed out.",
      "SHOPEE_STATEMENT_ACQUISITION_TIMEOUT",
      504,
    )), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function hasMetric(row, field) {
  return row[field] !== null && row[field] !== undefined && row[field] !== "";
}

function sumRequired(rows, field) {
  if (!rows.length || !rows.every((row) => hasMetric(row, field))) return null;
  return scaledToDecimal(rows.reduce((total, row) => total + decimalToScaled(row[field]), 0n));
}

function uniqueWarnings(rows) {
  const warnings = rows.flatMap((row) => row.warnings || []);
  const seen = new Set();
  return warnings.filter((warning) => {
    const key = JSON.stringify(warning);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function combineShopeeWindows(rows) {
  const first = rows[0];
  const listRevenue = sumRequired(rows, "listRevenue");
  const receivedRevenue = sumRequired(rows, "receivedRevenue");
  const totalCost = sumRequired(rows, "totalCost");
  const knownTotalCost = sumRequired(rows, "knownTotalCost") || "0";
  const list = listRevenue === null ? null : decimalToScaled(listRevenue);
  const received = receivedRevenue === null ? null : decimalToScaled(receivedRevenue);
  const cost = totalCost === null ? null : decimalToScaled(totalCost);
  const countFields = [
    "financeRowCount", "selectedOrderCount", "linkedOrderCount", "evaluationOrderCount",
    "costLineCount", "matchedCostLineCount", "missingOrderCount", "missingCostLineCount",
    "ambiguousCostLineCount",
  ];
  return {
    ...first,
    id: null,
    runId: null,
    dataStatus: rows.every((row) => row.dataStatus === "COMPLETE") ? "COMPLETE" : "PARTIAL",
    listRevenue,
    receivedRevenue,
    totalCost,
    knownTotalCost,
    listProfitMargin: list === null || cost === null ? null : percentageString(list - cost, list),
    receivedProfitMargin: received === null || cost === null ? null : percentageString(received - cost, received),
    listToReceivedProfitMargin: list === null || received === null || cost === null
      ? null
      : percentageString(received - cost, list),
    ...Object.fromEntries(countFields.map((field) => [field, rows.reduce((total, row) => total + Number(row[field] || 0), 0)])),
    warnings: uniqueWarnings(rows),
    calculatedAt: rows.map((row) => row.calculatedAt || "").sort().at(-1) || null,
    sourceRunIds: rows.map((row) => row.runId).filter(Boolean),
  };
}

function contiguousShopeeWindows(rows, range) {
  const selected = [];
  let cursor = range.dateFrom;
  while (cursor <= range.dateTo) {
    const candidates = rows.filter((row) => row.window?.dateFrom === cursor && row.window.dateTo <= range.dateTo)
      .sort((left, right) => right.window.dateTo.localeCompare(left.window.dateTo)
        || String(right.runCreatedAt || "").localeCompare(String(left.runCreatedAt || "")));
    const next = candidates[0];
    if (!next) break;
    selected.push(next);
    cursor = addDateDays(next.window.dateTo, 1);
  }
  return { selected, complete: cursor > range.dateTo };
}

export class ShopeeProfitService {
  constructor({
    repository,
    shopDirectoryService,
    shopRepository = null,
    syncMabangOrders = null,
    incomeStatementSource = null,
    expenseTransactionSource = null,
    statementConcurrency = 4,
    statementTimeoutMs = 180_000,
    automaticSync = { enabled: true, timeZone: "Asia/Shanghai", scheduleTime: "09:30", mode: "PREVIOUS_DAY_MISSING_ONLY" },
    now = () => new Date(),
  } = {}) {
    if (!repository) throw new TypeError("Profit repository is required");
    if (!shopDirectoryService) throw new TypeError("Shop directory service is required");
    this.repository = repository;
    this.shopDirectoryService = shopDirectoryService;
    this.shopRepository = shopRepository;
    this.syncMabangOrders = syncMabangOrders;
    this.incomeStatementSource = incomeStatementSource;
    this.expenseTransactionSource = expenseTransactionSource;
    this.statementConcurrency = Math.max(1, Math.min(8, Number(statementConcurrency) || 4));
    this.statementTimeoutMs = Math.max(10, Math.min(10 * 60_000, Number(statementTimeoutMs) || 180_000));
    this.automaticSync = { ...automaticSync };
    this.now = now;
    this.activeSync = null;
  }

  async #assertReady() {
    if (!await this.repository.isReady()) throw profitError("利润模块数据库迁移尚未应用。", "PROFIT_MIGRATION_REQUIRED", 503);
  }

  async #allShops() {
    let shops = (await this.shopDirectoryService.list({ platform: "shopee" }))
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

  async #shops() {
    return (await this.#allShops()).filter((shop) => Object.hasOwn(SHOPEE_COUNTRY_RULES, countryCode(shop.country)));
  }

  async #shop(identifier) {
    const target = normalized(identifier);
    const shops = await this.#shops();
    const shop = shops.find((row) => [row.id, row.directoryShopId, row.shopCode, row.shopName].some((value) => normalized(value) === target));
    if (!shop) throw profitError("未找到可调用的 Shopee 店铺。", "SHOPEE_PROFIT_SHOP_NOT_FOUND", 404);
    return shop;
  }

  async #orderCostData(statement, shop, runId) {
    const financeRows = prepareShopeeFinanceRows({
      statement,
      shop,
      fetchedAt: this.now().toISOString(),
      providerRequestId: statement.providerRequestId || null,
    });
    const orders = selectedShopeeOrderNumbers(financeRows);
    let orderLines = await this.repository.orderCostInputs(orders);
    const linked = new Set(orderLines.map((line) => normalized(line.transactionId)));
    const missing = orders.filter((orderNo) => !linked.has(orderNo));
    const warnings = [];
    let mabangSyncStatus = "NOT_REQUIRED";
    if (missing.length && typeof this.syncMabangOrders === "function") {
      mabangSyncStatus = "RUNNING";
      try {
        for (let offset = 0; offset < missing.length; offset += 1000) {
          await this.syncMabangOrders({
            mode: "references",
            dateFrom: statement.dateFrom,
            dateTo: statement.dateTo,
            missingOrderNumbers: missing.slice(offset, offset + 1000),
            runId,
            platform: "SHOPEE",
          });
        }
      } catch (error) {
        mabangSyncStatus = "FAILED";
        warnings.push({ code: error?.code || "MABANG_SYNC_FAILED", count: missing.length });
      }
      orderLines = await this.repository.orderCostInputs(orders);
      const resolved = new Set(orderLines.map((line) => normalized(line.transactionId)));
      const unresolved = orders.filter((orderNo) => !resolved.has(orderNo));
      if (mabangSyncStatus !== "FAILED") mabangSyncStatus = unresolved.length ? "PARTIAL" : "COMPLETE";
      if (unresolved.length) warnings.push({ code: "MABANG_ORDERS_UNRESOLVED", count: unresolved.length });
    } else if (missing.length) {
      mabangSyncStatus = "NOT_REQUIRED";
      warnings.push({ code: "MABANG_ORDERS_UNRESOLVED", count: missing.length, source: "EXISTING_MABANG_FACTS" });
    }
    const skus = [...new Set(orderLines.map((line) => line.normalizedSourceSku || line.sourceSku).filter(Boolean))];
    const productCostRows = await this.repository.productCostRows({ countryCode: shop.country, skus });
    return { financeRows, orderLines, productCostRows, warnings, mabangSyncStatus };
  }

  async #persistDailyExpense({ statement, shop, range }) {
    if (range.dateFrom !== range.dateTo || typeof this.repository.upsertDailyExpenseFacts !== "function") return;
    let walletRows = [];
    let walletSourceComplete = false;
    let expenseIssue = null;
    if (typeof this.expenseTransactionSource === "function") {
      try {
        const wallet = await this.expenseTransactionSource({ shop, ...range });
        walletRows = (wallet.records || []).map((row) => ({
          canonicalShopId: shop.directoryShopId || null,
          countryCode: countryCode(shop.country),
          currency: row.currency || SITE_CURRENCIES[countryCode(shop.country)],
          transactionDate: expenseTransactionDate(row.transactionDate),
          transactionTime: row.transactionTime || null,
          transactionType: row.transactionType,
          transactionSubtype: row.transactionSubtype,
          transactionTabType: row.transactionTabType,
          moneyFlow: row.moneyFlow,
          amount: row.amount,
          transactionNumber: row.transactionNumber,
          remarks: row.remarks,
          sourceWindow: row.sourceWindow || `${range.dateFrom}:${range.dateTo}`,
          providerRequestId: wallet.providerRequestId || null,
          fetchedAt: this.now().toISOString(),
        })).filter((row) => row.transactionDate === range.dateFrom);
        walletSourceComplete = wallet.paginationComplete === true;
        if (typeof this.repository.replaceExpenseTransactionWindow === "function") {
          await this.repository.replaceExpenseTransactionWindow({
            platform: "SHOPEE", connectorShopId: shop.id, ...range, rows: walletRows,
          });
        }
      } catch (error) {
        expenseIssue = error?.code || "SHOPEE_WALLET_FETCH_FAILED";
      }
    } else {
      expenseIssue = "SHOPEE_WALLET_SOURCE_UNAVAILABLE";
    }
    const expense = calculateShopeeDailyExpense({
      shop: { ...shop, currency: SITE_CURRENCIES[countryCode(shop.country)] },
      ...range, walletRows, statement, walletSourceComplete, calculatedAt: this.now().toISOString(),
    });
    if (expenseIssue) expense.facts.forEach((fact) => fact.issues.push(expenseIssue));
    await this.repository.upsertDailyExpenseFacts(expense.facts);
  }

  async #decorateExpenses(results, range) {
    const expected = Math.round((Date.parse(`${range.dateTo}T00:00:00Z`) - Date.parse(`${range.dateFrom}T00:00:00Z`)) / 86_400_000) + 1;
    if (typeof this.repository.expenseAggregatesForRange !== "function") {
      return results.map((row) => ({ ...row, expenseDataStatus: "PARTIAL", expenseValue: null,
        advertisingExpenseSigned: null, billingExpenseSigned: null, expenseDayCount: 0,
        completeExpenseDayCount: 0, expectedExpenseDayCount: expected, expenseIssues: ["EXPENSE_REPOSITORY_UNAVAILABLE"] }));
    }
    const aggregates = await this.repository.expenseAggregatesForRange({
      platform: "SHOPEE", connectorShopIds: results.map((row) => row.connectorShopId), ...range,
    });
    const byShop = new Map(aggregates.map((row) => [row.connectorShopId, row]));
    return results.map((row) => ({
      ...row,
      ...(byShop.get(row.connectorShopId) || {
        expenseDataStatus: "PARTIAL", expenseValue: null, advertisingExpenseSigned: null,
        billingExpenseSigned: null, expenseDayCount: 0, completeExpenseDayCount: 0,
        expectedExpenseDayCount: expected, expenseIssues: [],
      }),
    }));
  }

  async importStatement({ statement, shopId, triggerType = "manual_import" } = {}) {
    await this.#assertReady();
    if (!statement || typeof statement !== "object") throw profitError("Shopee 账单解析结果无效。", "SHOPEE_STATEMENT_INVALID");
    const shop = await this.#shop(shopId);
    if (countryCode(statement.countryCode) !== countryCode(shop.country)) {
      throw profitError("账单国家与所选 Shopee 店铺不一致。", "SHOPEE_STATEMENT_COUNTRY_MISMATCH");
    }
    const range = dateRange({ dateFrom: statement.dateFrom, dateTo: statement.dateTo }, this.now());
    const run = await this.repository.createRun({
      id: randomUUID(),
      platform: "SHOPEE",
      ...range,
      ruleVersion: SHOPEE_PROFIT_RULE_SET_VERSION,
      totalShopCount: 1,
      currentStage: "RESOLVING_MABANG_ORDERS",
      warnings: [{ code: "SHOPEE_STATEMENT_SOURCE", source: triggerType, sourceHash: statement.sourceHash || null }],
      startedAt: this.now().toISOString(),
    });
    try {
      if (statement.income?.sourceComplete === false) {
        await this.#persistDailyExpense({ statement, shop, range });
        const warnings = [{
          code: "SHOPEE_INCOME_SOURCE_INCOMPLETE",
          reason: statement.income.issue || "SUMMARY_ONLY",
        }];
        return await this.repository.updateRun(run.id, {
          status: "PARTIAL",
          currentStage: "COMPLETE",
          financeSuccessCount: 1,
          completeShopCount: 0,
          partialShopCount: 1,
          failedShopCount: 0,
          completedAt: this.now().toISOString(),
          warnings,
        });
      }
      const data = await this.#orderCostData(statement, shop, run.id);
      await this.repository.updateRun(run.id, {
        financeSuccessCount: 1,
        selectedOrderCount: selectedShopeeOrderNumbers(data.financeRows).length,
        mabangSyncStatus: data.mabangSyncStatus,
        currentStage: "CALCULATING_SHOPS",
        warnings: data.warnings,
      });
      await this.repository.replaceFinanceWindow({
        platform: "SHOPEE", connectorShopId: shop.id, ...range, rows: data.financeRows.map((row) => ({
          ...row, canonicalShopId: shop.directoryShopId || null,
        })),
      });
      await this.#persistDailyExpense({ statement, shop, range });
      const calculated = calculateShopeeShopProfit({
        countryCode: shop.country,
        financeRows: data.financeRows,
        orderLines: data.orderLines,
        productCostRows: data.productCostRows,
      });
      const { selectedOrders: ignored, ...metrics } = calculated;
      await this.repository.upsertShopResult({
        ...metrics,
        runId: run.id,
        platform: "SHOPEE",
        canonicalShopId: shop.directoryShopId || null,
        connectorShopId: shop.id,
        shopCode: shop.shopCode,
        shopName: shop.shopName,
        countryCode: countryCode(shop.country),
        currency: SITE_CURRENCIES[countryCode(shop.country)],
        warnings: [...data.warnings, ...metrics.warnings],
        calculatedAt: this.now().toISOString(),
      });
      const status = calculated.dataStatus === "COMPLETE" ? "COMPLETE" : "PARTIAL";
      return await this.repository.updateRun(run.id, {
        status,
        currentStage: "COMPLETE",
        completeShopCount: status === "COMPLETE" ? 1 : 0,
        partialShopCount: status === "PARTIAL" ? 1 : 0,
        failedShopCount: 0,
        completedAt: this.now().toISOString(),
        warnings: [...data.warnings, ...metrics.warnings],
      });
    } catch (error) {
      await this.repository.updateRun(run.id, {
        status: "FAILED", currentStage: "FAILED", failedShopCount: 1, completedAt: this.now().toISOString(),
        warnings: [{ code: error?.code || "SHOPEE_PROFIT_IMPORT_FAILED", message: String(error?.message || error).slice(0, 240) }],
      }).catch(() => {});
      throw error;
    }
  }

  async startSync(input = {}) {
    await this.#assertReady();
    if (typeof this.incomeStatementSource !== "function") {
      throw profitError("Shopee 官方账单源尚未配置；可先手动导入账单。", "SHOPEE_INCOME_STATEMENT_SOURCE_UNAVAILABLE", 503);
    }
    const range = dateRange(input, this.now());
    if (this.activeSync) return { accepted: false, reused: true, batchId: this.activeSync.batchId, ...range };
    const discoveredShops = await this.#shops();
    let coveredShopIds = new Set();
    if (input.skipCovered !== false && range.dateFrom === range.dateTo
      && typeof this.repository.financeCoverageWindows === "function") {
      const windows = await this.repository.financeCoverageWindows({
        platform: "SHOPEE",
        connectorShopIds: discoveredShops.map((shop) => shop.id),
      });
      coveredShopIds = new Set(windows
        .filter((window) => window.dateFrom <= range.dateFrom && window.dateTo >= range.dateTo)
        .map((window) => normalized(window.connectorShopId))
        .filter(Boolean));
      if (typeof this.repository.dailyExpenseFactsForRange === "function") {
        const expenseFacts = await this.repository.dailyExpenseFactsForRange({
          platform: "SHOPEE", connectorShopIds: discoveredShops.map((shop) => shop.id), ...range,
        });
        const expenseCovered = new Set(expenseFacts
          .filter((fact) => fact.transactionDate === range.dateFrom && fact.dataStatus === "COMPLETE" && fact.sourceComplete)
          .map((fact) => normalized(fact.connectorShopId)));
        coveredShopIds = new Set([...coveredShopIds].filter((id) => expenseCovered.has(id)));
      }
    } else if (input.skipCovered !== false) {
      const coveredResults = await this.repository.latestResultsForRange({ platform: "SHOPEE", ...range });
      coveredShopIds = new Set(coveredResults.map((row) => normalized(row.connectorShopId)).filter(Boolean));
    }
    const shops = discoveredShops.filter((shop) => !coveredShopIds.has(normalized(shop.id)));
    if (!shops.length) {
      return {
        accepted: false,
        reused: false,
        alreadyCovered: true,
        batchId: null,
        totalShopCount: discoveredShops.length,
        coveredShopCount: coveredShopIds.size,
        pendingShopCount: 0,
        ...range,
      };
    }
    const batchId = randomUUID();
    const promise = (async () => {
      const runs = new Array(shops.length);
      let cursor = 0;
      const worker = async () => {
        while (cursor < shops.length) {
          const index = cursor;
          cursor += 1;
          const shop = shops[index];
          let statement;
          try {
            statement = await withTimeout(this.incomeStatementSource({ shop, ...range }), this.statementTimeoutMs);
          } catch (error) {
            const code = error?.code || "SHOPEE_STATEMENT_ACQUISITION_FAILED";
            const failedRun = await this.repository.createRun({
              id: randomUUID(), platform: "SHOPEE", ...range,
              ruleVersion: SHOPEE_PROFIT_RULE_SET_VERSION,
              totalShopCount: 1,
              currentStage: "ACQUIRING_STATEMENT",
              warnings: [{ code, reason: error?.reason || null, shopCode: shop.shopCode, countryCode: countryCode(shop.country) }],
              startedAt: this.now().toISOString(),
            });
            await this.repository.updateRun(failedRun.id, {
              status: "FAILED", currentStage: "FAILED", failedShopCount: 1,
              completedAt: this.now().toISOString(),
              warnings: [{ code, reason: error?.reason || null, shopCode: shop.shopCode, countryCode: countryCode(shop.country) }],
            });
            runs[index] = { platform: "SHOPEE", shopId: shop.id, shopCode: shop.shopCode, status: "FAILED", code };
            continue;
          }
          try {
            runs[index] = await this.importStatement({ statement, shopId: shop.id, triggerType: input.triggerType || "official_api" });
          } catch (error) {
            runs[index] = { platform: "SHOPEE", shopId: shop.id, shopCode: shop.shopCode, status: "FAILED", code: error?.code || "SHOPEE_SYNC_FAILED" };
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(this.statementConcurrency, shops.length) }, worker));
      return runs;
    })().finally(() => { this.activeSync = null; });
    this.activeSync = { batchId, promise, totalShopCount: discoveredShops.length, pendingShopCount: shops.length };
    return {
      accepted: true,
      reused: false,
      batchId,
      totalShopCount: discoveredShops.length,
      coveredShopCount: coveredShopIds.size,
      pendingShopCount: shops.length,
      ...range,
    };
  }

  async checkStatementAccess(input = {}) {
    await this.#assertReady();
    if (typeof this.incomeStatementSource !== "function") {
      throw profitError("Shopee 官方账单源尚未配置。", "SHOPEE_INCOME_STATEMENT_SOURCE_UNAVAILABLE", 503);
    }
    const range = dateRange(input, this.now());
    const shop = await this.#shop(input.shopId);
    const statement = await this.incomeStatementSource({ shop, ...range });
    if (countryCode(statement.countryCode) !== countryCode(shop.country)) {
      throw profitError("官方账单国家与店铺国家不一致。", "SHOPEE_STATEMENT_COUNTRY_MISMATCH", 502);
    }
    return {
      available: true,
      platform: "SHOPEE",
      connectorShopId: shop.id,
      shopCode: shop.shopCode,
      shopName: shop.shopName,
      countryCode: countryCode(shop.country),
      requestedRange: range,
      statementRange: { dateFrom: statement.dateFrom, dateTo: statement.dateTo },
      reportId: statement.reportId || null,
      sheetNames: statement.sheetNames || [],
      orderCount: statement.income?.orderRows?.length || 0,
      ruleVersion: SHOPEE_PROFIT_RULE_SET_VERSION,
    };
  }

  async runSync(input = {}) {
    const started = await this.startSync(input);
    const active = this.activeSync;
    const runs = active ? await active.promise : [];
    const successful = runs.filter((run) => ["COMPLETE", "PARTIAL"].includes(run?.status));
    return {
      ...started,
      status: !runs.length ? "EMPTY" : !successful.length ? "FAILED" : successful.length === runs.length ? "COMPLETE" : "PARTIAL",
      runs,
    };
  }

  async status(input = {}) {
    await this.#assertReady();
    const range = dateRange(input, this.now());
    return { range, run: await this.repository.latestRun({ platform: "SHOPEE", ...range }) };
  }

  async dashboard(input = {}) {
    await this.#assertReady();
    const range = dateRange(input, this.now());
    const authorizedShops = await this.#allShops();
    const shops = authorizedShops.filter((shop) => Object.hasOwn(SHOPEE_COUNTRY_RULES, countryCode(shop.country)));
    const exactResults = await this.repository.latestResultsForRange({ platform: "SHOPEE", ...range });
    const resultWindows = typeof this.repository.resultWindowsForRange === "function"
      ? await this.repository.resultWindowsForRange({
        platform: "SHOPEE",
        ...range,
        connectorShopIds: shops.map((shop) => shop.id),
      })
      : exactResults.map((result) => ({
        ...result,
        window: { ...range },
        runCreatedAt: result.calculatedAt || null,
        runCompletedAt: result.calculatedAt || null,
      }));
    const windowsByShop = new Map();
    for (const result of resultWindows) {
      if (!windowsByShop.has(result.connectorShopId)) windowsByShop.set(result.connectorShopId, []);
      windowsByShop.get(result.connectorShopId).push(result);
    }
    const selectedWindows = [];
    const composedResults = [];
    let usesComposedSnapshots = false;
    for (const shop of shops) {
      const composition = contiguousShopeeWindows(windowsByShop.get(shop.id) || [], range);
      selectedWindows.push(...composition.selected.map((result) => ({
        connectorShopId: shop.id,
        ...result.window,
        completedAt: result.runCompletedAt || result.calculatedAt || null,
      })));
      if (!composition.complete || !composition.selected.length) continue;
      if (composition.selected.length > 1) usesComposedSnapshots = true;
      composedResults.push(combineShopeeWindows(composition.selected));
    }
    const shopsById = new Map(shops.map((shop) => [shop.id, shop]));
    const refreshedProfitResults = composedResults.map((result) => {
      const shop = shopsById.get(result.connectorShopId);
      return shop ? {
        ...result, platform: "SHOPEE", canonicalShopId: shop.directoryShopId || result.canonicalShopId,
        shopCode: shop.shopCode || result.shopCode, shopName: shop.shopName || result.shopName,
        countryCode: countryCode(shop.country || result.countryCode), currency: SITE_CURRENCIES[countryCode(shop.country)] || result.currency,
      } : { ...result, platform: "SHOPEE" };
    });
    const refreshedResults = await this.#decorateExpenses(refreshedProfitResults, range);
    const gmvResults = await decorateGmvResults({
      repository: this.repository, platform: "SHOPEE", results: refreshedResults, shops, range,
    });
    const countriesWithResults = [...new Set(gmvResults.map((row) => row.countryCode))].sort();
    const exchangeRates = resolveCountryExchangeRates(
      await this.repository.countryExchangeRateCandidates({ countryCodes: countriesWithResults }),
      countriesWithResults,
    );
    const ratesByCountry = new Map(exchangeRates.map((row) => [row.countryCode, row]));
    const countries = countriesWithResults.map((code) => {
      const aggregate = aggregateResults(gmvResults.filter((row) => row.countryCode === code), { countryCode: code });
      const exchangeRate = ratesByCountry.get(code);
      return { ...aggregate, exchangeRate, cnyEquivalent: cnyEquivalent(aggregate, exchangeRate) };
    });
    const selectedCountry = countryCode(input.country);
    const selectedShop = normalized(input.shopId);
    const filtered = gmvResults.filter((row) => (!selectedCountry || row.countryCode === selectedCountry)
      && (!selectedShop || row.connectorShopId === selectedShop || row.canonicalShopId === selectedShop));
    const run = await this.repository.latestRun({ platform: "SHOPEE", ...range });
    const financeCoverage = buildFinanceCoverage({ shops, windows: selectedWindows, ...range });
    const coverage = {
      ...publicFinanceCoverage(financeCoverage, "RUN_COVERAGE"),
      authorizedShopCount: authorizedShops.length,
      unsupportedShopCount: Math.max(0, authorizedShops.length - shops.length),
    };
    const sourceRunIds = [...new Set(gmvResults.flatMap((result) => result.sourceRunIds || []).filter(Boolean))];
    return {
      platform: "SHOPEE",
      ruleVersion: run?.ruleVersion || SHOPEE_PROFIT_RULE_SET_VERSION,
      range,
      run,
      calculation: gmvResults.length ? {
        mode: usesComposedSnapshots ? "COMPOSED_SNAPSHOTS" : "SNAPSHOT",
        calculatedAt: financeCoverage.latestCoverageAt,
        costBasis: "SNAPSHOT_AT_CALCULATION",
        sourceRunId: sourceRunIds.length === 1 ? sourceRunIds[0] : null,
        sourceRunIds,
      } : null,
      coverage,
      automation: this.automaticSync,
      filters: {
        countries: [...new Set(authorizedShops.map((shop) => countryCode(shop.country)))].sort(),
        shops: authorizedShops.map((shop) => ({ id: shop.id, shopCode: shop.shopCode, shopName: shop.shopName,
          countryCode: countryCode(shop.country), currency: SITE_CURRENCIES[countryCode(shop.country)] || null,
          platform: "SHOPEE", profitRuleSupported: Object.hasOwn(SHOPEE_COUNTRY_RULES, countryCode(shop.country)) })),
      },
      selection: aggregateResults(filtered, { countryCode: selectedCountry || null }),
      countries,
      shops: filtered,
      exchangeRates,
      cnySummary: buildCnySummary(gmvResults, exchangeRates),
    };
  }
}
