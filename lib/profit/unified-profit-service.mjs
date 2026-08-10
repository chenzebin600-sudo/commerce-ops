import { aggregateResults, buildCnySummary, cnyEquivalent } from "./profit-service.mjs";
import { profitBillingPresets, resolveProfitBillingPeriod } from "./profit-billing-periods.mjs";

const PLATFORMS = ["LAZADA", "SHOPEE"];

function normalizedPlatform(value, fallback = "ALL") {
  const platform = String(value || fallback).trim().toUpperCase();
  if (!["ALL", ...PLATFORMS].includes(platform)) {
    throw Object.assign(new Error("利润平台筛选无效。"), { code: "PROFIT_PLATFORM_INVALID", status: 400 });
  }
  return platform;
}

function servicesFor(platform, services) {
  return (platform === "ALL" ? PLATFORMS : [platform]).map((name) => [name, services[name]]).filter(([, service]) => service);
}

function periodFor(platform, input, now, transactionCutoffDate = null) {
  const hasCustomDates = input.dateFrom || input.dateTo;
  return resolveProfitBillingPeriod({
    platform,
    preset: hasCustomDates ? "CUSTOM" : input.preset || "CURRENT_BILLING_PERIOD",
    referenceDate: now,
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
    transactionCutoffDate,
  });
}

function combineExchangeRates(dashboards) {
  const rows = dashboards.flatMap((dashboard) => dashboard.exchangeRates || []);
  const byCountry = new Map();
  for (const row of rows) if (!byCountry.has(row.countryCode)) byCountry.set(row.countryCode, row);
  return [...byCountry.values()].sort((left, right) => left.countryCode.localeCompare(right.countryCode));
}

function selectionRange(periods) {
  const ranges = periods.map((period) => period.transactionRange);
  return {
    dateFrom: ranges.map((range) => range.dateFrom).sort()[0],
    dateTo: ranges.map((range) => range.dateTo).sort().at(-1),
  };
}

export class UnifiedProfitService {
  constructor({ lazadaService, shopeeService, repository, transactionCutoffDate = null, now = () => new Date() } = {}) {
    if (!lazadaService || !shopeeService || !repository) throw new TypeError("Unified profit services are required");
    this.services = { LAZADA: lazadaService, SHOPEE: shopeeService };
    this.repository = repository;
    this.transactionCutoffDate = String(transactionCutoffDate || "").trim() || null;
    this.now = now;
  }

  periods(input = {}) {
    const platform = normalizedPlatform(input.platform);
    const entries = servicesFor(platform, this.services)
      .map(([name]) => periodFor(name, input, this.now(), this.transactionCutoffDate));
    return { platform, selectionRange: selectionRange(entries), items: entries,
      presets: profitBillingPresets(this.now(), { transactionCutoffDate: this.transactionCutoffDate }) };
  }

  async dashboard(input = {}) {
    const requestedPlatform = normalizedPlatform(input.platform);
    const periodEntries = servicesFor(requestedPlatform, this.services).map(([platform, service]) => ({
      platform, service, period: periodFor(platform, input, this.now(), this.transactionCutoffDate),
    }));
    const dashboards = await Promise.all(periodEntries.map(async ({ platform, service, period }) => ({
      ...(await service.dashboard({
        dateFrom: period.transactionRange.dateFrom,
        dateTo: period.transactionRange.dateTo,
        country: input.country,
        shopId: input.shopId,
      })),
      platform,
      period,
    })));
    const allShops = dashboards.flatMap((dashboard) => dashboard.shops.map((shop) => ({ ...shop, platform: dashboard.platform })))
      .filter((shop) => !input.platform || requestedPlatform === "ALL" || shop.platform === requestedPlatform);
    const selectedCountry = String(input.country || "").trim().toUpperCase();
    const selectedShop = String(input.shopId || "").trim();
    const filteredShops = allShops.filter((shop) => (!selectedCountry || shop.countryCode === selectedCountry)
      && (!selectedShop || shop.connectorShopId === selectedShop || shop.canonicalShopId === selectedShop));
    const exchangeRates = combineExchangeRates(dashboards);
    const ratesByCountry = new Map(exchangeRates.map((row) => [row.countryCode, row]));
    const countryCodes = [...new Set(allShops.map((shop) => shop.countryCode))].sort();
    const countries = countryCodes.map((countryCode) => {
      const rows = allShops.filter((shop) => shop.countryCode === countryCode);
      const aggregate = aggregateResults(rows, { countryCode });
      const exchangeRate = ratesByCountry.get(countryCode) || null;
      return {
        ...aggregate,
        exchangeRate,
        cnyEquivalent: cnyEquivalent(aggregate, exchangeRate),
        platforms: PLATFORMS.map((platform) => {
          const platformRows = rows.filter((row) => row.platform === platform);
          return platformRows.length ? { platform, ...aggregateResults(platformRows, { countryCode }) } : null;
        }).filter(Boolean),
      };
    });
    const platformSummaries = dashboards.map((dashboard) => ({
      platform: dashboard.platform,
      period: dashboard.period,
      run: dashboard.run,
      coverage: dashboard.coverage,
      calculation: dashboard.calculation,
      metrics: aggregateResults(allShops.filter((shop) => shop.platform === dashboard.platform)),
    }));
    const range = selectionRange(periodEntries.map((entry) => entry.period));
    const snapshots = await this.repository.listRuns({
      platform: requestedPlatform === "ALL" ? null : requestedPlatform,
      limit: 40,
    });
    return {
      platform: requestedPlatform,
      ruleVersion: "UNIFIED-PROFIT-1.0.0",
      range,
      periods: periodEntries.map(({ period }) => period),
      presets: profitBillingPresets(this.now(), { transactionCutoffDate: this.transactionCutoffDate }),
      run: dashboards.length === 1 ? dashboards[0].run : null,
      calculation: dashboards.length === 1 ? dashboards[0].calculation : null,
      coverage: dashboards.length === 1 ? dashboards[0].coverage : null,
      automation: {
        enabled: dashboards.some((dashboard) => dashboard.automation?.enabled),
        timeZone: "Asia/Shanghai",
        scheduleTime: dashboards.map((dashboard) => dashboard.automation?.scheduleTime).filter(Boolean).sort()[0] || "09:30",
        mode: "PLATFORM_DAILY_INCREMENTAL",
        transactionCutoffDate: this.transactionCutoffDate,
      },
      filters: {
        platforms: PLATFORMS,
        countries: [...new Set(dashboards.flatMap((dashboard) => dashboard.filters.countries))].sort(),
        shops: dashboards.flatMap((dashboard) => dashboard.filters.shops.map((shop) => ({ ...shop, platform: dashboard.platform }))),
      },
      selection: aggregateResults(filteredShops, { countryCode: selectedCountry || null }),
      countries,
      platforms: platformSummaries,
      shops: filteredShops,
      exchangeRates,
      cnySummary: buildCnySummary(allShops, exchangeRates),
      snapshots,
    };
  }

  async status(input = {}) {
    const platform = normalizedPlatform(input.platform);
    const statuses = await Promise.all(servicesFor(platform, this.services).map(async ([name, service]) => {
      const period = periodFor(name, input, this.now(), this.transactionCutoffDate);
      return { platform: name, period, ...(await service.status(period.transactionRange)) };
    }));
    return { platform, statuses, range: selectionRange(statuses.map((status) => status.period)) };
  }

  async startSync(input = {}) {
    const platform = normalizedPlatform(input.platform);
    const outcomes = await Promise.all(servicesFor(platform, this.services).map(async ([name, service]) => {
      const period = periodFor(name, input, this.now(), this.transactionCutoffDate);
      const currentShopeeDailyIncrement = name === "SHOPEE"
        && period.preset === "CURRENT_BILLING_PERIOD" && !input.dateFrom && !input.dateTo;
      const syncRange = currentShopeeDailyIncrement
        ? { dateFrom: period.transactionRange.dateTo, dateTo: period.transactionRange.dateTo }
        : period.transactionRange;
      try {
        return { platform: name, period, ok: true, result: await service.startSync({ ...syncRange, triggerType: input.triggerType }) };
      } catch (error) {
        return { platform: name, period, ok: false, code: error?.code || "PROFIT_SYNC_FAILED", error: String(error?.message || error).slice(0, 200) };
      }
    }));
    return { accepted: outcomes.some((row) => row.ok && row.result?.accepted), platform, outcomes };
  }

  async runSync(input = {}) {
    const platform = normalizedPlatform(input.platform);
    const outcomes = await Promise.all(servicesFor(platform, this.services).map(async ([name, service]) => {
      const period = periodFor(name, input, this.now(), this.transactionCutoffDate);
      try {
        return { platform: name, period, ok: true, result: await service.runSync({ ...period.transactionRange, triggerType: input.triggerType }) };
      } catch (error) {
        return { platform: name, period, ok: false, code: error?.code || "PROFIT_SYNC_FAILED", error: String(error?.message || error).slice(0, 200) };
      }
    }));
    return { platform, outcomes };
  }

  importShopeeStatement(input) {
    return this.services.SHOPEE.importStatement(input);
  }

  checkShopeeStatementAccess(input) {
    return this.services.SHOPEE.checkStatementAccess(input);
  }
}
