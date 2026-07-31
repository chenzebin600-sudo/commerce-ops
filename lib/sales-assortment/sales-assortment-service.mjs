const COUNTRY_ALIASES = Object.freeze({
  "ID": "印度尼西亚",
  "TH": "泰国",
  "PH": "菲律宾",
  "VN": "越南",
  "MY": "马来西亚",
  "SG": "新加坡",
  "印尼": "印度尼西亚",
  "印度尼西亚": "印度尼西亚",
  "泰国": "泰国",
  "菲律宾": "菲律宾",
  "越南": "越南",
  "马来": "马来西亚",
  "马来西亚": "马来西亚",
  "新加坡": "新加坡",
});

const DEFAULT_PERIOD_DAYS = 7;
const MAX_PERIOD_DAYS = 90;
const COMPARISON_DAYS = new Set([1, 3, 7]);

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function text(value, fallback = "") {
  const result = String(value ?? "").trim();
  return result || fallback;
}

function number(value, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((number(value) + Number.EPSILON) * factor) / factor;
}

function canonicalCountry(value) {
  const normalized = text(value);
  return COUNTRY_ALIASES[normalized] || normalized || "待映射";
}

function countryFromWarehouse(value) {
  const warehouse = text(value);
  for (const [prefix, country] of Object.entries(COUNTRY_ALIASES)) {
    if (warehouse.startsWith(prefix)) return country;
  }
  return "待映射";
}

function dayKey(value) {
  const source = text(value);
  const match = source.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function validDay(value) {
  const day = dayKey(value);
  return day && dateFromDay(day) ? day : null;
}

function dateFromDay(value) {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function addDays(value, days) {
  const result = new Date(value);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function dateRange(from, to) {
  const start = dateFromDay(from);
  const end = dateFromDay(to);
  if (!start || !end || start > end) return [];
  const result = [];
  for (let cursor = start; cursor <= end; cursor = addDays(cursor, 1)) {
    result.push(cursor.toISOString().slice(0, 10));
  }
  return result;
}

function daysBetween(from, to) {
  const start = dateFromDay(from);
  const end = dateFromDay(to);
  if (!start || !end || start > end) return 0;
  return Math.round((end - start) / 86400000) + 1;
}

function rateOfChange(current, previous) {
  if (previous <= 0) return current > 0 ? null : 0;
  return round(((current - previous) / previous) * 100, 1);
}

function trendStatus(changeRate, current, previous, sufficient) {
  if (!sufficient) return "data_insufficient";
  if (previous <= 0) return current > 0 ? "new_activity" : "stable";
  if (changeRate <= -20) return "decline";
  if (changeRate >= 30) return "growth";
  return "stable";
}

function trendPriority(status, changeRate) {
  if (status === "decline" && changeRate <= -50) return "P0";
  if (status === "decline") return "P1";
  if (status === "growth" || status === "new_activity") return "P2";
  return "P3";
}

function changeImpact(current, previous, changeRate) {
  const delta = number(current) - number(previous);
  const magnitude = Math.abs(delta);
  const rateWeight = 1 + Math.min(Math.abs(number(changeRate)), 100) / 100;
  return {
    delta: round(delta),
    magnitude: round(magnitude),
    score: round(magnitude * rateWeight),
  };
}

function byBusinessImpact(left, right) {
  return number(right.impactScore) - number(left.impactScore)
    || number(right.impactAmount ?? right.impactQuantity) - number(left.impactAmount ?? left.impactQuantity)
    || Math.abs(number(right.changeRate)) - Math.abs(number(left.changeRate));
}

function severityOrderValue(priority) {
  return ({ P0: 0, P1: 1, P2: 2, P3: 3 })[priority] ?? 4;
}

function selectInventoryInsightMix(items, limit = 100) {
  const quotas = [
    ["stockout", 35],
    ["low_stock", 20],
    ["rapid_drop", 15],
    ["restock_arrival", 15],
    ["new_arrival", 15],
  ];
  const selected = [];
  const selectedItems = new Set();
  for (const [type, quota] of quotas) {
    for (const item of items.filter((entry) => entry.type === type).slice(0, quota)) {
      selected.push(item);
      selectedItems.add(item);
    }
  }
  for (const item of items) {
    if (selected.length >= limit) break;
    if (!selectedItems.has(item)) selected.push(item);
  }
  return selected.sort((a, b) => severityOrderValue(a.priority) - severityOrderValue(b.priority)
    || b.assortmentAmount - a.assortmentAmount
    || Math.abs(number(b.inventoryChange)) - Math.abs(number(a.inventoryChange)))
    .slice(0, limit);
}

function percent(numerator, denominator) {
  return denominator > 0 ? round((numerator / denominator) * 100, 1) : 0;
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN"));
}

function mapKey(...parts) {
  return parts.map((part) => text(part).toLowerCase()).join("\u001f");
}

function mergeTotals(target, source) {
  target.assortmentQuantity += source.assortmentQuantity;
  target.assortmentAmount += source.assortmentAmount;
  target.predictedDailySales += source.predictedDailySales;
  target.availableQuantity += source.availableQuantity;
  target.inTransitQuantity += source.inTransitQuantity;
  target.inventoryValue += source.inventoryValue;
  target.ownQuantity += source.ownQuantity;
  target.ownAmount += source.ownAmount;
  target.skuSet.add(source.sku);
}

function publicTotals(value, ownDataDays = value.periodDays) {
  const dataDays = Math.max(0, number(ownDataDays, 0));
  const assortmentDailyAmount = value.assortmentAmount;
  const assortmentAmount = assortmentDailyAmount * dataDays;
  const dailyGap = dataDays > 0 ? (assortmentAmount - value.ownAmount) / dataDays : 0;
  return {
    assortmentQuantity: round(value.assortmentQuantity),
    assortmentDailyAmount: round(assortmentDailyAmount),
    assortmentAmount: round(assortmentAmount),
    predictedDailySales: round(value.predictedDailySales),
    availableQuantity: round(value.availableQuantity),
    inTransitQuantity: round(value.inTransitQuantity),
    inventoryValue: round(value.inventoryValue),
    ownQuantity: round(value.ownQuantity),
    ownAmount: round(value.ownAmount),
    ownShare: percent(value.ownAmount, assortmentAmount),
    dailySalesGap: round(dailyGap),
    ownDataDays: dataDays,
    skuCount: value.skuSet.size,
  };
}

function emptyTotals(periodDays) {
  return {
    periodDays,
    assortmentQuantity: 0,
    assortmentAmount: 0,
    predictedDailySales: 0,
    availableQuantity: 0,
    inTransitQuantity: 0,
    inventoryValue: 0,
    ownQuantity: 0,
    ownAmount: 0,
    skuSet: new Set(),
  };
}

function filterMatch(item, filters) {
  return (!filters.country || item.country === filters.country)
    && (!filters.categoryL1 || item.categoryL1 === filters.categoryL1)
    && (!filters.categoryL2 || item.categoryL2 === filters.categoryL2)
    && (!filters.style || item.style === filters.style);
}

function withinRange(day, from, to) {
  return Boolean(day) && (!from || day >= from) && (!to || day <= to);
}

function resolveObservationWindow(input, latestOrderDay) {
  const requestedFrom = validDay(input.dateFrom);
  const requestedTo = validDay(input.dateTo);
  if (requestedFrom && requestedTo && requestedFrom <= requestedTo) {
    const spanDays = Math.min(daysBetween(requestedFrom, requestedTo), MAX_PERIOD_DAYS);
    const start = spanDays === daysBetween(requestedFrom, requestedTo)
      ? requestedFrom
      : addDays(dateFromDay(requestedTo), -(MAX_PERIOD_DAYS - 1)).toISOString().slice(0, 10);
    return { dateFrom: start, dateTo: requestedTo, spanDays, mode: "custom" };
  }
  const requestedDays = Math.max(1, Math.min(Number(input.periodDays) || DEFAULT_PERIOD_DAYS, MAX_PERIOD_DAYS));
  if (!latestOrderDay) return { dateFrom: null, dateTo: null, spanDays: requestedDays, mode: "relative" };
  return {
    dateFrom: addDays(dateFromDay(latestOrderDay), -(requestedDays - 1)).toISOString().slice(0, 10),
    dateTo: latestOrderDay,
    spanDays: requestedDays,
    mode: "relative",
  };
}

function resolveOrderReadWindow(input, latestOrderValue) {
  const latestOrderDay = validDay(latestOrderValue);
  const comparisonDays = COMPARISON_DAYS.has(Number(input.comparisonDays))
    ? Number(input.comparisonDays)
    : 7;
  const observation = resolveObservationWindow(input, latestOrderDay);
  const currentComparisonStart = observation.dateTo
    ? addDays(dateFromDay(observation.dateTo), -(comparisonDays - 1)).toISOString().slice(0, 10)
    : null;
  const previousComparisonEnd = currentComparisonStart
    ? addDays(dateFromDay(currentComparisonStart), -1).toISOString().slice(0, 10)
    : null;
  const previousComparisonStart = previousComparisonEnd
    ? addDays(dateFromDay(previousComparisonEnd), -(comparisonDays - 1)).toISOString().slice(0, 10)
    : null;
  const dailyBriefHistoryStart = observation.dateTo
    ? addDays(dateFromDay(observation.dateTo), -13).toISOString().slice(0, 10)
    : null;
  const dateFrom = [observation.dateFrom, previousComparisonStart, dailyBriefHistoryStart]
    .filter(Boolean)
    .sort()[0] || null;
  const dateToExclusive = observation.dateTo
    ? addDays(dateFromDay(observation.dateTo), 1).toISOString().slice(0, 10)
    : null;
  return { observation, comparisonDays, dateFrom, dateToExclusive };
}

export class SalesAssortmentService {
  constructor({ repository, dashboardCacheLimit = 16, metadataCacheTtlMs = 30_000 }) {
    this.repository = repository;
    this.dashboardCacheLimit = Math.max(1, Number(dashboardCacheLimit) || 16);
    this.dashboardCache = new Map();
    this.dashboardInflight = new Map();
    this.sourceDataCache = new Map();
    this.sourceDataInflight = new Map();
    this.referenceDataCache = new Map();
    this.referenceDataInflight = new Map();
    this.metadataCacheTtlMs = Math.max(1_000, Number(metadataCacheTtlMs) || 30_000);
    this.metadataCache = null;
    this.metadataInflight = null;
  }

  async sourceRows(input = {}) {
    const source = ["orders", "inventory", "product-package"].includes(input.source)
      ? input.source
      : "orders";
    const page = Math.max(1, Number(input.page) || 1);
    const pageSize = Math.max(1, Math.min(Number(input.pageSize) || 50, 100));
    const result = await this.repository.sourceRows(source, { page, pageSize });
    const rows = result.rows.map((row) => {
      const raw = parseJson(row.raw_values_json);
      if (source === "orders") {
        return {
          orderId: text(row.source_order_id),
          paidAt: text(row.paid_at),
          store: text(row.source_shop_name),
          platform: text(row.platform),
          manager: text(raw["店长"], "待补负责人"),
          status: text(row.order_status),
          warehouse: text(row.source_warehouse_name),
          sku: text(row.source_sku),
          productName: text(row.product_name),
          quantity: number(row.quantity),
        };
      }
      if (source === "inventory") {
        return {
          sku: text(row.normalized_source_sku || row.source_sku),
          productName: text(raw["中文名称"], text(row.product_name)),
          status: text(row.product_status),
          activity: text(raw["活跃度"]),
          isNew: text(raw["是否新款"]),
          categoryL1: text(row.category_level_1),
          categoryL2: text(row.category_level_2),
          warehouse: text(row.normalized_warehouse_name || row.warehouse_name),
          sales7d: number(row.source_visible_sales_7d),
          sales28d: number(row.source_visible_sales_28d),
          sales42d: number(row.source_visible_sales_42d),
          predictedDailySales: number(row.source_predicted_daily_sales),
          availableQuantity: number(row.available_quantity),
          inTransitQuantity: number(row.in_transit_quantity),
          daysOfSupply: number(raw["当前可售天数"], number(row.days_of_supply)),
        };
      }
      const payload = parseJson(row.normalized_payload_json);
      return {
        sku: text(row.sku_normalized || payload.sku_code),
        productName: text(payload.product_name),
        mainSku: text(payload.main_sku_code),
        country: canonicalCountry(row.country_normalized || payload.country_raw),
        categoryL1: text(payload.category_l1),
        categoryL2: text(payload.category_l2),
        style: text(payload.style_name),
        warehouse: text(row.warehouse_normalized || payload.warehouse_raw),
        priceTier45: number(payload.price_tier_45),
        exchangeRate: number(payload.exchange_rate),
        costCny: number(payload.cost_cny),
      };
    });
    return { source, page, pageSize, total: Number(result.total || 0), rows };
  }

  async dashboard(input = {}) {
    const { sourceStatus, mappingRows, latestOrderValue } = await this.loadMetadata({
      forceRefresh: Boolean(input.forceRefresh),
    });
    const orderReadWindow = latestOrderValue
      ? resolveOrderReadWindow(input, latestOrderValue)
      : null;
    const cacheKey = JSON.stringify({
      input: {
        periodDays: Number(input.periodDays) || null,
        dateFrom: text(input.dateFrom),
        dateTo: text(input.dateTo),
        comparisonDays: Number(input.comparisonDays) || null,
        country: text(input.country),
        categoryL1: text(input.categoryL1),
        categoryL2: text(input.categoryL2),
        style: text(input.style),
        store: text(input.store),
      },
      sources: sourceStatus,
      warehouseMappings: mappingRows,
    });

    if (!input.forceRefresh && this.dashboardCache.has(cacheKey)) {
      const cached = this.dashboardCache.get(cacheKey);
      this.dashboardCache.delete(cacheKey);
      this.dashboardCache.set(cacheKey, cached);
      return cached;
    }
    if (!input.forceRefresh && this.dashboardInflight.has(cacheKey)) {
      return this.dashboardInflight.get(cacheKey);
    }

    const sourceDataKey = JSON.stringify({
      sourceStatus,
      mappingRows,
      orderDateFrom: orderReadWindow?.dateFrom || null,
      orderDateToExclusive: orderReadWindow?.dateToExclusive || null,
    });
    const sourceData = await this.loadSourceData(sourceDataKey, {
      sourceStatus,
      mappingRows,
      orderReadWindow,
      forceRefresh: Boolean(input.forceRefresh),
    });
    const pending = this.buildDashboard(input, sourceData)
      .then((dashboard) => {
        this.dashboardCache.set(cacheKey, dashboard);
        while (this.dashboardCache.size > this.dashboardCacheLimit) {
          this.dashboardCache.delete(this.dashboardCache.keys().next().value);
        }
        return dashboard;
      })
      .finally(() => {
        if (this.dashboardInflight.get(cacheKey) === pending) this.dashboardInflight.delete(cacheKey);
      });
    this.dashboardInflight.set(cacheKey, pending);
    return pending;
  }

  async loadMetadata({ forceRefresh = false } = {}) {
    const now = Date.now();
    if (!forceRefresh && this.metadataCache && this.metadataCache.expiresAt > now) {
      return this.metadataCache.value;
    }
    if (this.metadataInflight) return this.metadataInflight;

    const pending = Promise.all([
      this.repository.sourceStatus(),
      this.repository.warehouseMappings(),
      this.repository.latestOrderDay ? this.repository.latestOrderDay() : Promise.resolve(null),
    ]).then(([sourceStatus, mappingRows, latestOrderValue]) => {
      const value = { sourceStatus, mappingRows, latestOrderValue };
      this.metadataCache = { value, expiresAt: Date.now() + this.metadataCacheTtlMs };
      return value;
    }).finally(() => {
      if (this.metadataInflight === pending) this.metadataInflight = null;
    });
    this.metadataInflight = pending;
    return pending;
  }

  async loadSourceData(cacheKey, {
    sourceStatus,
    mappingRows,
    orderReadWindow = null,
    forceRefresh = false,
  }) {
    if (!forceRefresh && this.sourceDataCache.has(cacheKey)) {
      return this.sourceDataCache.get(cacheKey);
    }
    if (!forceRefresh && this.sourceDataInflight.has(cacheKey)) {
      return this.sourceDataInflight.get(cacheKey);
    }

    const referenceDataKey = JSON.stringify({ sourceStatus, mappingRows });
    const pending = Promise.all([
      this.loadReferenceData(referenceDataKey, {
        sourceStatus,
        mappingRows,
        forceRefresh,
      }),
      this.repository.currentOrderRows(orderReadWindow ? {
        dateFrom: orderReadWindow.dateFrom,
        dateToExclusive: orderReadWindow.dateToExclusive,
      } : undefined),
    ]).then(([referenceData, orderRows]) => {
      const result = {
        ...referenceData,
        orderRows,
        observation: orderReadWindow?.observation || null,
      };
      this.sourceDataCache.set(cacheKey, result);
      while (this.sourceDataCache.size > 2) {
        this.sourceDataCache.delete(this.sourceDataCache.keys().next().value);
      }
      return result;
    }).finally(() => {
      if (this.sourceDataInflight.get(cacheKey) === pending) this.sourceDataInflight.delete(cacheKey);
    });
    this.sourceDataInflight.set(cacheKey, pending);
    return pending;
  }

  async loadReferenceData(cacheKey, {
    sourceStatus,
    mappingRows,
    forceRefresh = false,
  }) {
    if (!forceRefresh && this.referenceDataCache.has(cacheKey)) {
      return this.referenceDataCache.get(cacheKey);
    }
    if (this.referenceDataInflight.has(cacheKey)) {
      return this.referenceDataInflight.get(cacheKey);
    }

    const pending = Promise.all([
      this.repository.productPackageRows(),
      this.repository.latestInventoryRows(),
      this.repository.previousInventoryRows
        ? this.repository.previousInventoryRows()
        : Promise.resolve({ batch: null, rows: [] }),
    ]).then(([packageRows, inventoryResult, previousInventoryResult]) => {
      const result = {
        sourceStatus,
        mappingRows,
        packageRows,
        inventoryResult,
        previousInventoryResult,
      };
      this.referenceDataCache.set(cacheKey, result);
      while (this.referenceDataCache.size > 2) {
        this.referenceDataCache.delete(this.referenceDataCache.keys().next().value);
      }
      return result;
    }).finally(() => {
      if (this.referenceDataInflight.get(cacheKey) === pending) {
        this.referenceDataInflight.delete(cacheKey);
      }
    });
    this.referenceDataInflight.set(cacheKey, pending);
    return pending;
  }

  async overview(input = {}) {
    const dashboard = await this.dashboard(input);
    return {
      summary: dashboard.summary,
      trend: dashboard.trend,
      stores: dashboard.stores,
    };
  }

  async trend(input = {}) {
    return (await this.dashboard(input)).trend;
  }

  async buildDashboard(input = {}, preloaded = {}) {
    const comparisonDays = COMPARISON_DAYS.has(Number(input.comparisonDays))
      ? Number(input.comparisonDays)
      : 7;
    const filters = {
      country: text(input.country),
      categoryL1: text(input.categoryL1),
      categoryL2: text(input.categoryL2),
      style: text(input.style),
      store: text(input.store),
    };

    const [sourceStatus, mappingRows, packageRows, inventoryResult, previousInventoryResult, orderRows] = await Promise.all([
      Promise.resolve(preloaded.sourceStatus ?? this.repository.sourceStatus()),
      Promise.resolve(preloaded.mappingRows ?? this.repository.warehouseMappings()),
      Promise.resolve(preloaded.packageRows ?? this.repository.productPackageRows()),
      Promise.resolve(preloaded.inventoryResult ?? this.repository.latestInventoryRows()),
      Promise.resolve(preloaded.previousInventoryResult ?? (this.repository.previousInventoryRows
        ? this.repository.previousInventoryRows()
        : { batch: null, rows: [] })),
      Promise.resolve(preloaded.orderRows ?? this.repository.currentOrderRows()),
    ]);

    const warehouseCountries = new Map();
    for (const row of mappingRows) {
      const country = canonicalCountry(row.country_name || row.country_code);
      warehouseCountries.set(text(row.normalized_warehouse_name || row.source_warehouse_name).toLowerCase(), country);
    }

    const exactProducts = new Map();
    const countryProducts = new Map();
    const skuProducts = new Map();
    for (const row of packageRows) {
      const payload = parseJson(row.normalized_payload_json);
      const country = canonicalCountry(row.country_normalized || payload.country_raw);
      const sku = text(row.sku_normalized || payload.sku_code);
      const warehouse = text(row.warehouse_normalized || payload.warehouse_raw);
      const exchangeRate = number(payload.exchange_rate);
      const localPrice = number(payload.price_tier_45);
      const costCny = number(payload.cost_cny);
      const costLocal = number(payload.cost_local);
      const standardPriceCny = costCny > 0 && costLocal > 0
        ? localPrice * (costCny / costLocal)
        : exchangeRate > 0
          ? localPrice / exchangeRate
          : costCny;
      const product = {
        country,
        sku,
        warehouse,
        productName: text(payload.product_name, sku),
        categoryL1: text(payload.category_l1, "未分类"),
        categoryL2: text(payload.category_l2, "未分类"),
        style: text(payload.style_name, text(payload.product_name, "未归款")),
        mainSku: text(payload.main_sku_code, sku),
        standardPriceCny,
      };
      if (!sku) continue;
      const exactKey = mapKey(warehouse, sku);
      if (!exactProducts.has(exactKey)) exactProducts.set(exactKey, product);
      const countryKey = mapKey(country, sku);
      if (!countryProducts.has(countryKey)) countryProducts.set(countryKey, product);
       if (!skuProducts.has(sku)) skuProducts.set(sku, product);
       else if (skuProducts.get(sku)?.country !== country) skuProducts.set(sku, null);
    }

    const productFor = (warehouse, sku) => {
      const warehouseName = text(warehouse);
      const normalizedSku = text(sku);
      const mappedCountry = warehouseCountries.get(warehouseName.toLowerCase())
        || countryFromWarehouse(warehouseName);
      return exactProducts.get(mapKey(warehouseName, normalizedSku))
        || countryProducts.get(mapKey(mappedCountry, normalizedSku))
        || (mappedCountry === "待映射" ? skuProducts.get(normalizedSku) : null)
        || null;
    };

    const products = new Map();
    const inventoryRows = inventoryResult.rows;
    const previousInventory = new Map();
    for (const row of previousInventoryResult.rows) {
      const sku = text(row.normalized_source_sku || row.source_sku);
      const warehouse = text(row.normalized_warehouse_name || row.warehouse_name);
      previousInventory.set(mapKey(warehouse, sku), number(row.available_quantity));
    }
    for (const row of inventoryRows) {
      const raw = parseJson(row.raw_values_json);
      const sku = text(row.normalized_source_sku || row.source_sku);
      const warehouse = text(row.normalized_warehouse_name || row.warehouse_name);
      const matched = productFor(warehouse, sku);
      const country = matched?.country
        || warehouseCountries.get(warehouse.toLowerCase())
        || countryFromWarehouse(warehouse);
      const productName = matched?.productName || text(raw["中文名称"], text(row.product_name, sku));
      const key = mapKey(country, productName);
      const current = products.get(key) || {
        key,
        country,
        productName,
        categoryL1: matched?.categoryL1 || text(row.category_level_1, "未分类"),
        categoryL2: matched?.categoryL2 || text(row.category_level_2, "未分类"),
        style: matched?.style || productName,
        mainSku: matched?.mainSku || sku,
        activity: text(raw["活跃度"], "未标记"),
        isNew: text(raw["是否新款"]) === "是",
        productStatus: text(row.product_status, "未知"),
        daysOfSupply: number(raw["当前可售天数"], number(row.days_of_supply)),
        periodDays: DEFAULT_PERIOD_DAYS,
        assortmentQuantity: 0,
        assortmentAmount: 0,
        predictedDailySales: 0,
        availableQuantity: 0,
        inTransitQuantity: 0,
        inventoryValue: 0,
        ownQuantity: 0,
        ownAmount: 0,
        skuSet: new Set(),
        sku,
        priceCoverage: 0,
        previousAvailableQuantity: 0,
        hasPreviousInventory: false,
        lastInboundAt: null,
      };
      const assortmentQuantity = number(row.source_predicted_daily_sales);
      const price = number(matched?.standardPriceCny);
      current.assortmentQuantity += assortmentQuantity;
      current.assortmentAmount += assortmentQuantity * price;
      current.predictedDailySales += assortmentQuantity;
      current.availableQuantity += number(row.available_quantity);
      current.inTransitQuantity += number(row.in_transit_quantity);
      current.inventoryValue += Math.max(0, number(row.available_quantity)) * price;
      const previousAvailable = previousInventory.get(mapKey(warehouse, sku));
      if (previousAvailable !== undefined) {
        current.previousAvailableQuantity += previousAvailable;
        current.hasPreviousInventory = true;
      }
      const lastInboundAt = validDay(raw["最后入库时间"]);
      if (lastInboundAt && (!current.lastInboundAt || lastInboundAt > current.lastInboundAt)) {
        current.lastInboundAt = lastInboundAt;
      }
      current.skuSet.add(sku);
      if (price > 0) current.priceCoverage += 1;
      current.isNew ||= text(raw["是否新款"]) === "是";
      current.daysOfSupply = Math.max(current.daysOfSupply, number(raw["当前可售天数"], number(row.days_of_supply)));
      products.set(key, current);
    }

    const allOrderDays = preloaded.observation
      ? []
      : orderRows.map((row) => dayKey(row.paid_at)).filter(Boolean).sort();
    const latestOrderDay = allOrderDays.at(-1) || null;
    const observation = preloaded.observation || resolveObservationWindow(input, latestOrderDay);
    const startOrderDay = observation.dateFrom;
    const maxOrderDay = observation.dateTo;
    const periodDays = observation.spanDays;
    for (const product of products.values()) product.periodDays = periodDays;
    const currentComparisonStart = maxOrderDay
      ? addDays(dateFromDay(maxOrderDay), -(comparisonDays - 1)).toISOString().slice(0, 10)
      : null;
    const previousComparisonEnd = currentComparisonStart
      ? addDays(dateFromDay(currentComparisonStart), -1).toISOString().slice(0, 10)
      : null;
    const previousComparisonStart = previousComparisonEnd
      ? addDays(dateFromDay(previousComparisonEnd), -(comparisonDays - 1)).toISOString().slice(0, 10)
      : null;
    const dailyBriefHistoryStart = maxOrderDay
      ? addDays(dateFromDay(maxOrderDay), -13).toISOString().slice(0, 10)
      : null;
    const historyStartDay = [startOrderDay, previousComparisonStart, dailyBriefHistoryStart]
      .filter(Boolean)
      .sort()[0] || null;
    const orderFacts = [];
    for (const row of orderRows) {
      const paidDay = dayKey(row.paid_at);
      if (!paidDay || (historyStartDay && paidDay < historyStartDay) || (maxOrderDay && paidDay > maxOrderDay)) continue;
      const raw = parseJson(row.raw_values_json);
      const sku = text(row.normalized_source_sku || row.source_sku);
      const warehouse = text(row.normalized_source_warehouse_name || row.source_warehouse_name);
      const matched = productFor(warehouse, sku);
      const country = matched?.country
        || warehouseCountries.get(warehouse.toLowerCase())
        || countryFromWarehouse(warehouse);
      const productName = matched?.productName || text(row.product_name, sku);
      const productKey = mapKey(country, productName);
      const quantity = number(row.quantity);
      const price = number(matched?.standardPriceCny);
      const amount = quantity * price;
      const fact = {
        productKey,
        country,
        productName,
        categoryL1: matched?.categoryL1 || "未分类",
        categoryL2: matched?.categoryL2 || "未分类",
        style: matched?.style || productName,
        sku,
        store: text(row.source_shop_name, "未识别店铺"),
        manager: text(raw["店长"], "待补负责人"),
        platform: text(row.platform, "unknown").toLowerCase(),
        transactionId: text(raw["交易编号"], text(row.source_order_id)),
        quantity,
        amount,
        paidDay,
      };
      orderFacts.push(fact);
    }

    const allProducts = [...products.values()];
    const optionProducts = allProducts.filter((item) => (
      (!filters.country || item.country === filters.country)
      && (!filters.categoryL1 || item.categoryL1 === filters.categoryL1)
      && (!filters.categoryL2 || item.categoryL2 === filters.categoryL2)
    ));
    const filteredProducts = allProducts.filter((item) => filterMatch(item, filters));
    const selectedKeys = new Set(filteredProducts.map((item) => item.key));
    const filteredHistoricalOrders = orderFacts.filter((item) => (
      selectedKeys.has(item.productKey)
      && (!filters.store || item.store === filters.store)
    ));
    const filteredOrders = filteredHistoricalOrders.filter((item) => withinRange(item.paidDay, startOrderDay, maxOrderDay));
    for (const fact of filteredOrders) {
      const product = products.get(fact.productKey);
      if (!product) continue;
      product.ownQuantity += fact.quantity;
      product.ownAmount += fact.amount;
    }
    const ownDataDays = new Set(orderFacts
      .filter((item) => withinRange(item.paidDay, startOrderDay, maxOrderDay))
      .map((item) => item.paidDay)
      .filter(Boolean)).size;
    const orderCount = new Set(filteredOrders.map((item) => item.transactionId).filter(Boolean)).size;

    const summaryTotals = emptyTotals(periodDays);
    for (const product of filteredProducts) mergeTotals(summaryTotals, product);

    const hierarchyDimension = !filters.country
      ? "country"
      : !filters.categoryL1
        ? "categoryL1"
        : !filters.categoryL2
          ? "categoryL2"
          : "style";
    const hierarchyMap = new Map();
    for (const product of filteredProducts) {
      const label = product[hierarchyDimension] || "未分类";
      const item = hierarchyMap.get(label) || { label, ...emptyTotals(periodDays) };
      mergeTotals(item, product);
      hierarchyMap.set(label, item);
    }
    const hierarchy = [...hierarchyMap.values()]
      .map((item) => ({ label: item.label, ...publicTotals(item, ownDataDays) }))
      .sort((a, b) => b.assortmentAmount - a.assortmentAmount);

    const matrixMap = new Map();
    for (const product of filteredProducts) {
      const key = mapKey(product.country, product.categoryL1);
      const item = matrixMap.get(key) || {
        country: product.country,
        category: product.categoryL1,
        ...emptyTotals(periodDays),
      };
      mergeTotals(item, product);
      matrixMap.set(key, item);
    }
    const opportunityMatrix = [...matrixMap.values()].map((item) => {
      const totals = publicTotals(item, ownDataDays);
      return {
        country: item.country,
        category: item.category,
        ...totals,
        opportunityScore: round(Math.max(0, 100 - totals.ownShare)),
      };
    });

    const topProducts = filteredProducts
      .map((item) => {
        const totals = publicTotals(item, ownDataDays);
        return {
          key: item.key,
          country: item.country,
          productName: item.productName,
          categoryL1: item.categoryL1,
          categoryL2: item.categoryL2,
          style: item.style,
          mainSku: item.mainSku,
          activity: item.activity,
          isNew: item.isNew,
          productStatus: item.productStatus,
          daysOfSupply: round(item.daysOfSupply),
          ...totals,
          gapAmount: round(Math.max(0, totals.assortmentAmount - totals.ownAmount)),
        };
      })
      .sort((a, b) => b.assortmentAmount - a.assortmentAmount)
      .slice(0, 80);

    const storeMap = new Map();
    for (const fact of filteredOrders) {
      const key = mapKey(fact.store, fact.country);
      const item = storeMap.get(key) || {
        store: fact.store,
        country: fact.country,
        manager: fact.manager,
        platform: fact.platform,
        ownAmount: 0,
        ownQuantity: 0,
        categoryAmounts: new Map(),
        productKeys: new Set(),
      };
      item.ownAmount += fact.amount;
      item.ownQuantity += fact.quantity;
      item.manager = item.manager === "待补负责人" ? fact.manager : item.manager;
      item.categoryAmounts.set(fact.categoryL1, (item.categoryAmounts.get(fact.categoryL1) || 0) + fact.amount);
      item.productKeys.add(fact.productKey);
      storeMap.set(key, item);
    }
    const countryTotals = new Map();
    for (const product of filteredProducts) {
      const item = countryTotals.get(product.country) || emptyTotals(periodDays);
      mergeTotals(item, product);
      countryTotals.set(product.country, item);
    }
    const stores = [...storeMap.values()].map((store) => {
      const countryTotal = countryTotals.get(store.country) || emptyTotals(periodDays);
      const strengths = [...store.categoryAmounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([name]) => name);
      const countryProducts = filteredProducts
        .filter((product) => product.country === store.country)
        .sort((a, b) => b.assortmentAmount - a.assortmentAmount);
      const opportunities = countryProducts
        .filter((product) => !store.productKeys.has(product.key) && product.availableQuantity > 0)
        .slice(0, 5);
      const countryCategoryTotals = new Map();
      for (const product of countryProducts) {
        countryCategoryTotals.set(
          product.categoryL1,
          (countryCategoryTotals.get(product.categoryL1) || 0) + product.assortmentAmount,
        );
      }
      const weakCategory = [...countryCategoryTotals.entries()]
        .filter(([label]) => !strengths.includes(label))
        .sort((a, b) => b[1] - a[1])[0]?.[0] || "暂无";
      return {
        store: store.store,
        country: store.country,
        manager: store.manager,
        platform: store.platform,
        ownAmount: round(store.ownAmount),
        ownQuantity: round(store.ownQuantity),
        countryShare: percent(store.ownAmount, publicTotals(countryTotal, ownDataDays).assortmentAmount),
        strength: strengths.join("、") || "待观察",
        weakness: weakCategory,
        opportunityCount: opportunities.length,
        opportunityProducts: opportunities.map((item) => item.productName),
      };
    }).sort((a, b) => b.ownAmount - a.ownAmount);

    const trendDates = startOrderDay && maxOrderDay ? dateRange(startOrderDay, maxOrderDay) : [];
    const comparisonHistoryDays = orderFacts
      .filter((item) => withinRange(item.paidDay, previousComparisonStart, maxOrderDay))
      .map((item) => item.paidDay)
      .sort();
    const comparisonCoverageDays = comparisonHistoryDays.length > 0
      ? daysBetween(previousComparisonStart, maxOrderDay)
      : 0;
    const comparisonSufficient = comparisonHistoryDays.length > 0
      && comparisonHistoryDays[0] <= previousComparisonStart
      && comparisonCoverageDays >= comparisonDays * 2;

    const storeTrendMap = new Map();
    for (const fact of filteredHistoricalOrders) {
      const key = mapKey(fact.store, fact.country, fact.platform);
      const item = storeTrendMap.get(key) || {
        key,
        store: fact.store,
        country: fact.country,
        platform: fact.platform,
        manager: fact.manager,
        daily: new Map(),
        currentAmount: 0,
        previousAmount: 0,
        totalAmount: 0,
      };
      item.manager = item.manager === "待补负责人" ? fact.manager : item.manager;
      if (!startOrderDay || fact.paidDay >= startOrderDay) {
        item.totalAmount += fact.amount;
        item.daily.set(fact.paidDay, (item.daily.get(fact.paidDay) || 0) + fact.amount);
      }
      if (withinRange(fact.paidDay, currentComparisonStart, maxOrderDay)) item.currentAmount += fact.amount;
      if (withinRange(fact.paidDay, previousComparisonStart, previousComparisonEnd)) {
        item.previousAmount += fact.amount;
      }
      storeTrendMap.set(key, item);
    }
    const storeSalesTrend = [...storeTrendMap.values()].map((item) => {
      const changeRate = rateOfChange(item.currentAmount, item.previousAmount);
      const status = trendStatus(changeRate, item.currentAmount, item.previousAmount, comparisonSufficient);
      const impact = changeImpact(item.currentAmount, item.previousAmount, changeRate);
      return {
        store: item.store,
        country: item.country,
        platform: item.platform,
        manager: item.manager,
        totalAmount: round(item.totalAmount),
        currentAmount: round(item.currentAmount),
        previousAmount: round(item.previousAmount),
        current7dAmount: round(item.currentAmount),
        previous7dAmount: round(item.previousAmount),
        comparisonDays,
        changeRate,
        amountChange: impact.delta,
        impactAmount: impact.magnitude,
        impactScore: impact.score,
        trendStatus: status,
        priority: trendPriority(status, changeRate),
        points: trendDates.map((date) => ({ date, amount: round(item.daily.get(date) || 0) })),
      };
    }).sort((a, b) => b.totalAmount - a.totalAmount);

    const productTrendMap = new Map();
    for (const fact of filteredHistoricalOrders) {
      const item = productTrendMap.get(fact.productKey) || {
        daily: new Map(),
        currentAmount: 0,
        previousAmount: 0,
      };
      if (!startOrderDay || fact.paidDay >= startOrderDay) {
        item.daily.set(fact.paidDay, (item.daily.get(fact.paidDay) || 0) + fact.amount);
      }
      if (withinRange(fact.paidDay, currentComparisonStart, maxOrderDay)) item.currentAmount += fact.amount;
      if (withinRange(fact.paidDay, previousComparisonStart, previousComparisonEnd)) {
        item.previousAmount += fact.amount;
      }
      productTrendMap.set(fact.productKey, item);
    }
    const currentProductRanks = new Map([...productTrendMap.entries()]
      .sort((a, b) => b[1].currentAmount - a[1].currentAmount)
      .map(([key], index) => [key, index + 1]));
    const previousProductRanks = new Map([...productTrendMap.entries()]
      .filter(([, item]) => item.previousAmount > 0)
      .sort((a, b) => b[1].previousAmount - a[1].previousAmount)
      .map(([key], index) => [key, index + 1]));
    const productSalesRanking = [...filteredProducts]
      .filter((item) => item.ownAmount > 0)
      .sort((a, b) => b.ownAmount - a.ownAmount)
      .slice(0, 30)
      .map((item, index) => {
        const trend = productTrendMap.get(item.key) || { daily: new Map(), currentAmount: 0, previousAmount: 0 };
        const changeRate = rateOfChange(trend.currentAmount, trend.previousAmount);
        const status = trendStatus(changeRate, trend.currentAmount, trend.previousAmount, comparisonSufficient);
        const impact = changeImpact(trend.currentAmount, trend.previousAmount, changeRate);
        const current7dRank = currentProductRanks.get(item.key) || null;
        const previous7dRank = previousProductRanks.get(item.key) || null;
        return {
          rank: index + 1,
          current7dRank,
          previous7dRank,
          rankChange: current7dRank && previous7dRank ? previous7dRank - current7dRank : null,
          country: item.country,
          productName: item.productName,
          mainSku: item.mainSku,
          categoryL1: item.categoryL1,
          categoryL2: item.categoryL2,
          style: item.style,
          ownAmount: round(item.ownAmount),
          ownQuantity: round(item.ownQuantity),
          current7dAmount: round(trend.currentAmount),
          previous7dAmount: round(trend.previousAmount),
          currentAmount: round(trend.currentAmount),
          previousAmount: round(trend.previousAmount),
          comparisonDays,
          changeRate,
          amountChange: impact.delta,
          impactAmount: impact.magnitude,
          impactScore: impact.score,
          trendStatus: status,
          priority: trendPriority(status, changeRate),
          points: trendDates.map((date) => ({ date, amount: round(trend.daily.get(date) || 0) })),
        };
      });

    const styleTrendMap = new Map();
    for (const fact of filteredHistoricalOrders) {
      const key = mapKey(fact.country, fact.style);
      const item = styleTrendMap.get(key) || {
        country: fact.country,
        style: fact.style,
        categoryL1: fact.categoryL1,
        categoryL2: fact.categoryL2,
        currentQuantity: 0,
        previousQuantity: 0,
      };
      if (withinRange(fact.paidDay, currentComparisonStart, maxOrderDay)) item.currentQuantity += fact.quantity;
      if (withinRange(fact.paidDay, previousComparisonStart, previousComparisonEnd)) item.previousQuantity += fact.quantity;
      styleTrendMap.set(key, item);
    }
    const styleSalesTrend = [...styleTrendMap.values()].map((item) => {
      const changeRate = rateOfChange(item.currentQuantity, item.previousQuantity);
      const status = trendStatus(changeRate, item.currentQuantity, item.previousQuantity, comparisonSufficient);
      const impact = changeImpact(item.currentQuantity, item.previousQuantity, changeRate);
      return {
        ...item,
        currentQuantity: round(item.currentQuantity),
        previousQuantity: round(item.previousQuantity),
        changeRate,
        quantityChange: impact.delta,
        impactQuantity: impact.magnitude,
        impactScore: impact.score,
        trendStatus: status,
        priority: trendPriority(status, changeRate),
        comparisonDays,
      };
    });

    const storeAnomalies = {
      comparisonDays,
      declines: storeSalesTrend.filter((item) => item.trendStatus === "decline").sort(byBusinessImpact),
      growth: storeSalesTrend.filter((item) => item.trendStatus === "growth" || item.trendStatus === "new_activity").sort(byBusinessImpact),
    };
    const styleAnomalies = {
      comparisonDays,
      declines: styleSalesTrend.filter((item) => item.trendStatus === "decline").sort(byBusinessImpact),
      growth: styleSalesTrend.filter((item) => item.trendStatus === "growth" || item.trendStatus === "new_activity").sort(byBusinessImpact),
    };

    const buildMovementWindow = (days, entity) => {
      const currentFrom = maxOrderDay
        ? addDays(dateFromDay(maxOrderDay), -(days - 1)).toISOString().slice(0, 10)
        : null;
      const previousTo = currentFrom
        ? addDays(dateFromDay(currentFrom), -1).toISOString().slice(0, 10)
        : null;
      const previousFrom = previousTo
        ? addDays(dateFromDay(previousTo), -(days - 1)).toISOString().slice(0, 10)
        : null;
      const coveredDays = filteredHistoricalOrders.map((item) => item.paidDay).filter(Boolean).sort();
      const sufficient = Boolean(previousFrom && coveredDays.length && coveredDays[0] <= previousFrom);
      const movements = new Map();
      for (const fact of filteredHistoricalOrders) {
        if (!withinRange(fact.paidDay, previousFrom, maxOrderDay)) continue;
        const key = entity === "store"
          ? mapKey(fact.store, fact.country, fact.platform)
          : mapKey(fact.country, fact.style);
        const item = movements.get(key) || (entity === "store" ? {
          store: fact.store,
          country: fact.country,
          platform: fact.platform,
          manager: fact.manager,
          currentAmount: 0,
          previousAmount: 0,
        } : {
          country: fact.country,
          style: fact.style,
          categoryL1: fact.categoryL1,
          categoryL2: fact.categoryL2,
          currentQuantity: 0,
          previousQuantity: 0,
        });
        const value = entity === "store" ? fact.amount : fact.quantity;
        if (withinRange(fact.paidDay, currentFrom, maxOrderDay)) {
          if (entity === "store") item.currentAmount += value;
          else item.currentQuantity += value;
        }
        if (withinRange(fact.paidDay, previousFrom, previousTo)) {
          if (entity === "store") item.previousAmount += value;
          else item.previousQuantity += value;
        }
        movements.set(key, item);
      }
      const rows = [...movements.values()].map((item) => {
        const current = entity === "store" ? item.currentAmount : item.currentQuantity;
        const previous = entity === "store" ? item.previousAmount : item.previousQuantity;
        const changeRate = rateOfChange(current, previous);
        const status = trendStatus(changeRate, current, previous, sufficient);
        const impact = changeImpact(current, previous, changeRate);
        return {
          ...item,
          ...(entity === "store" ? {
            currentAmount: round(current),
            previousAmount: round(previous),
            amountChange: impact.delta,
            impactAmount: impact.magnitude,
          } : {
            currentQuantity: round(current),
            previousQuantity: round(previous),
            quantityChange: impact.delta,
            impactQuantity: impact.magnitude,
          }),
          comparisonDays: days,
          changeRate,
          impactScore: impact.score,
          trendStatus: status,
          priority: trendPriority(status, changeRate),
        };
      });
      return {
        comparisonDays: days,
        sufficient,
        declines: rows.filter((item) => item.trendStatus === "decline").sort(byBusinessImpact).slice(0, 10),
        growth: rows.filter((item) => item.trendStatus === "growth" || item.trendStatus === "new_activity").sort(byBusinessImpact).slice(0, 10),
      };
    };
    const dailyMovementWindows = {
      stores1d: buildMovementWindow(1, "store"),
      stores7d: buildMovementWindow(7, "store"),
      styles1d: buildMovementWindow(1, "style"),
      styles7d: buildMovementWindow(7, "style"),
    };

    const opportunityGroups = new Map();
    for (const product of filteredProducts) {
      const key = mapKey(product.country, product.style);
      const group = opportunityGroups.get(key) || {
        key,
        country: product.country,
        categoryL1: product.categoryL1,
        categoryL2: product.categoryL2,
        style: product.style,
        ...emptyTotals(periodDays),
        children: [],
      };
      mergeTotals(group, product);
      const totals = publicTotals(product, ownDataDays);
      group.children.push({
        key: `${group.key}\u001f${product.key}`,
        country: product.country,
        productName: product.productName,
        categoryL1: product.categoryL1,
        categoryL2: product.categoryL2,
        style: product.style,
        ...totals,
        assortmentDailySales: round(product.predictedDailySales),
        ownDailySales: ownDataDays > 0 ? round(product.ownQuantity / ownDataDays) : 0,
        ownDailySalesShare: ownDataDays > 0 ? percent(product.ownQuantity / ownDataDays, product.predictedDailySales) : 0,
        opportunityAmount: round(Math.max(0, totals.assortmentAmount - totals.ownAmount)),
      });
      opportunityGroups.set(key, group);
    }
    const businessOpportunities = [...opportunityGroups.values()].map((group) => {
      const totals = publicTotals(group, ownDataDays);
      const ownDailySales = ownDataDays > 0 ? group.ownQuantity / ownDataDays : 0;
      const opportunityAmount = Math.max(0, totals.assortmentAmount - totals.ownAmount);
      return {
        key: group.key,
        country: group.country,
        categoryL1: group.categoryL1,
        categoryL2: group.categoryL2,
        style: group.style,
        ...totals,
        assortmentDailySales: round(group.predictedDailySales),
        ownDailySales: round(ownDailySales),
        ownDailySalesShare: percent(ownDailySales, group.predictedDailySales),
        opportunityAmount: round(opportunityAmount),
        opportunityScore: round(opportunityAmount * (1 + Math.max(0, 10 - percent(ownDailySales, group.predictedDailySales)) / 10)),
        children: group.children.sort((a, b) => b.opportunityAmount - a.opportunityAmount
          || a.ownDailySalesShare - b.ownDailySalesShare),
      };
    }).filter((item) => item.assortmentAmount > 0 && item.availableQuantity > 0)
      .sort((a, b) => b.opportunityScore - a.opportunityScore
        || b.assortmentAmount - a.assortmentAmount)
      .slice(0, 120);

    const inventoryReferenceDay = validDay(inventoryResult.batch?.collected_at) || maxOrderDay;
    const inventoryInsightCandidates = filteredProducts.map((product) => {
      const ownDailySales = ownDataDays > 0 ? product.ownQuantity / ownDataDays : 0;
      const inventoryChange = product.hasPreviousInventory
        ? product.availableQuantity - product.previousAvailableQuantity
        : null;
      const inventoryChangeRate = inventoryChange === null
        ? null
        : product.previousAvailableQuantity > 0
          ? round((inventoryChange / product.previousAvailableQuantity) * 100, 1)
          : inventoryChange > 0 ? null : 0;
      const dropThreshold = Math.max(20, product.predictedDailySales * 7);
      const arrivalThreshold = Math.max(30, product.predictedDailySales * 14);
      const rapidDrop = inventoryChange !== null && inventoryChange < 0
        && (number(inventoryChangeRate) <= -30 || Math.abs(inventoryChange) >= dropThreshold);
      const restockArrival = inventoryChange !== null && inventoryChange > 0
        && (inventoryChangeRate === null || inventoryChangeRate >= 50 || inventoryChange >= arrivalThreshold);
      const inboundAgeDays = product.lastInboundAt && inventoryReferenceDay
        ? daysBetween(product.lastInboundAt, inventoryReferenceDay) - 1
        : null;
      let type = "observe";
      let priority = "P3";
      let action = "保持观察，按最新销售速度复核库存。";
      if (product.predictedDailySales > 0 && product.availableQuantity <= 0) {
        type = "stockout";
        priority = "P0";
        action = "已断货，立即核查平台库存并修改库存或预售状态。";
      } else if (ownDailySales > 0 && product.daysOfSupply <= 7) {
        type = "low_stock";
        priority = "P1";
        action = "即将断货，优先核查在途量并调整平台库存。";
      } else if (rapidDrop) {
        type = "rapid_drop";
        priority = "P1";
        action = "库存较上次快照明显下降，结合订单、调拨和平台库存核查是否出现销量加速。";
      } else if (product.isNew && product.availableQuantity > 0 && inboundAgeDays !== null && inboundAgeDays <= 14) {
        type = "new_arrival";
        priority = "P2";
        action = "新品近期到货，核查在线状态并补充可售库存。";
      } else if (restockArrival) {
        type = "restock_arrival";
        priority = "P2";
        action = "库存较上次快照明显增加，核查到仓数量并同步平台可售库存。";
      }
      const productTotals = publicTotals(product, ownDataDays);
      return {
        country: product.country,
        productName: product.productName,
        style: product.style,
        categoryL1: product.categoryL1,
        categoryL2: product.categoryL2,
        type,
        priority,
        ownDailySales: round(ownDailySales),
        predictedDailySales: round(product.predictedDailySales),
        assortmentDailyAmount: round(product.assortmentAmount),
        assortmentAmount: productTotals.assortmentAmount,
        ownAmount: round(product.ownAmount),
        inventoryValue: round(product.inventoryValue),
        availableQuantity: round(product.availableQuantity),
        inTransitQuantity: round(product.inTransitQuantity),
        daysOfSupply: round(product.daysOfSupply),
        previousAvailableQuantity: product.hasPreviousInventory ? round(product.previousAvailableQuantity) : null,
        inventoryChange: inventoryChange === null ? null : round(inventoryChange),
        inventoryChangeRate,
        currentInventoryCollectedAt: inventoryResult.batch?.collected_at || inventoryResult.batch?.imported_at || null,
        previousInventoryCollectedAt: previousInventoryResult.batch?.collected_at || previousInventoryResult.batch?.imported_at || null,
        lastInboundAt: product.lastInboundAt,
        action,
      };
    }).filter((item) => item.ownDailySales > 0 || item.type !== "observe")
      .sort((a, b) => severityOrderValue(a.priority) - severityOrderValue(b.priority)
        || b.assortmentAmount - a.assortmentAmount
        || Math.abs(number(b.inventoryChange)) - Math.abs(number(a.inventoryChange)));
    const inventoryInsights = selectInventoryInsightMix(inventoryInsightCandidates);

    const severityOrder = { P0: 0, P1: 1, P2: 2, P3: 3 };
    const priorityAlerts = [];
    for (const item of storeAnomalies.declines) {
      priorityAlerts.push({
        id: `store:${mapKey(item.store, item.country, item.platform)}`,
        priority: item.priority,
        type: "store_decline",
        entityType: "store",
        entityName: item.store,
        title: `${item.store} 近${comparisonDays}日销售额下滑`,
        summary: `${item.country} · ${item.platform} · ${item.manager}`,
        metricLabel: `环比前${comparisonDays}日`,
        metricValue: `${item.changeRate}%`,
        action: "核查流量、在线商品与重点 SKU 变化。",
        evidence: [`本期 ${round(item.currentAmount)} 元`, `上期 ${round(item.previousAmount)} 元`],
        impactScore: item.impactScore,
      });
    }
    for (const item of productSalesRanking.filter((entry) => entry.trendStatus === "decline").sort(byBusinessImpact)) {
      priorityAlerts.push({
        id: `product:${mapKey(item.country, item.productName)}`,
        priority: item.priority,
        type: "product_decline",
        entityType: "product",
        entityName: item.productName,
        title: `${item.productName} 近${comparisonDays}日销售额下滑`,
        summary: `${item.country} · ${item.categoryL1}`,
        metricLabel: `环比前${comparisonDays}日`,
        metricValue: `${item.changeRate}%`,
        action: "核查对应店铺、库存与商品在线状态。",
        evidence: [`本期 ${round(item.currentAmount)} 元`, `上期 ${round(item.previousAmount)} 元`],
        impactScore: item.impactScore,
      });
    }
    for (const item of topProducts.filter((entry) => (
      entry.predictedDailySales > 0 && entry.daysOfSupply <= 14
    )).slice(0, 8)) {
      const priority = item.daysOfSupply <= 0 ? "P0" : item.daysOfSupply <= 7 ? "P1" : "P2";
      priorityAlerts.push({
        id: `inventory:${mapKey(item.country, item.productName)}`,
        priority,
        type: "inventory_risk",
        entityType: "product",
        entityName: item.productName,
        title: `${item.productName} 可售天数偏低`,
        summary: `${item.country} · ${item.categoryL1}`,
        metricLabel: "可售天数",
        metricValue: `${item.daysOfSupply} 天`,
        action: "核查仓库级库存和在途量后安排补货。",
        evidence: [`可用库存 ${item.availableQuantity}`, `预测日销量 ${item.predictedDailySales}`],
        impactScore: number(item.assortmentAmount),
      });
    }
    priorityAlerts.sort((a, b) => (
      severityOrder[a.priority] - severityOrder[b.priority]
      || number(b.impactScore) - number(a.impactScore)
      || String(a.title).localeCompare(String(b.title), "zh-CN")
    ));
    const dailySales = new Map(trendDates.map((date) => [date, { amount: 0, quantity: 0 }]));
    for (const fact of filteredOrders) {
      const day = dailySales.get(fact.paidDay) || { amount: 0, quantity: 0 };
      day.amount += fact.amount;
      day.quantity += fact.quantity;
      dailySales.set(fact.paidDay, day);
    }

    const coverageDays = ownDataDays;
    const packagePriced = packageRows.filter((row) => {
      const payload = parseJson(row.normalized_payload_json);
      return number(payload.price_tier_45) > 0 && number(payload.exchange_rate) > 0;
    }).length;

    return {
      contract: {
        version: "SALES-ASSORTMENT-1.3.0",
        amountBasis: "我方销售额=订单商品数量×产品包4档价(45%)；货盘金额=库存预测日销量×产品包4档价(45%)×订单有效付款日期天数",
        ownShareFormula: "我方销售额÷货盘金额",
        dailySalesGapFormula: "(货盘金额-我方销售额)÷我方数据天数",
        orderStatuses: ["待处理", "配货中", "已发货", "已完成"],
        aggregationKey: "国家 + 商品中文名称",
      },
      sourceStatus,
      filters: {
        selected: {
          ...filters,
          periodDays,
          dateFrom: startOrderDay,
          dateTo: maxOrderDay,
          comparisonDays,
        },
        options: {
          countries: uniqueSorted(allProducts.map((item) => item.country)),
          categoryL1: uniqueSorted(allProducts
            .filter((item) => !filters.country || item.country === filters.country)
            .map((item) => item.categoryL1)),
          categoryL2: uniqueSorted(allProducts
            .filter((item) => (!filters.country || item.country === filters.country)
              && (!filters.categoryL1 || item.categoryL1 === filters.categoryL1))
            .map((item) => item.categoryL2)),
          styles: uniqueSorted(optionProducts.map((item) => item.style)),
          stores: uniqueSorted(orderFacts
            .filter((item) => selectedKeys.has(item.productKey))
            .map((item) => item.store)),
        },
      },
      period: {
        days: periodDays,
        mode: observation.mode,
        orderDateFrom: startOrderDay,
        orderDateTo: maxOrderDay,
        availableOrderDays: coverageDays,
        sufficient: coverageDays >= periodDays,
        comparisonDays,
        comparisonSufficient,
        currentComparisonFrom: currentComparisonStart,
        currentComparisonTo: maxOrderDay,
        previousComparisonFrom: previousComparisonStart,
        previousComparisonTo: previousComparisonEnd,
      },
      summary: {
        ...publicTotals(summaryTotals, ownDataDays),
        gapAmount: round(Math.max(0, publicTotals(summaryTotals, ownDataDays).assortmentAmount
          - summaryTotals.ownAmount)),
        orderCount,
        averageOrderValue: orderCount > 0 ? round(summaryTotals.ownAmount / orderCount) : 0,
        countryCount: new Set(filteredProducts.map((item) => item.country)).size,
        productCount: filteredProducts.length,
        storeCount: new Set(filteredOrders.map((item) => item.store)).size,
      },
      hierarchy: {
        dimension: hierarchyDimension,
        rows: hierarchy,
      },
      opportunityMatrix,
      trend: trendDates
        .map((date) => ({
          date,
          ownAmount: round(dailySales.get(date)?.amount || 0),
          ownQuantity: round(dailySales.get(date)?.quantity || 0),
          assortmentDailyAmount: round(summaryTotals.assortmentAmount),
        })),
      topProducts,
      stores: stores.slice(0, 100),
      storeSalesTrend,
      productSalesRanking,
      storeAnomalies,
      styleSalesTrend,
      styleAnomalies,
      businessOpportunities,
      inventoryComparison: {
        currentCollectedAt: inventoryResult.batch?.collected_at || inventoryResult.batch?.imported_at || null,
        previousCollectedAt: previousInventoryResult.batch?.collected_at || previousInventoryResult.batch?.imported_at || null,
        comparable: Boolean(inventoryResult.batch && previousInventoryResult.batch),
      },
      inventoryInsights,
      priorityAlerts: priorityAlerts.slice(0, 10),
      dailyReport: {
        version: "SALES-ASSORTMENT-DAILY-1.0.0",
        reportDate: maxOrderDay,
        title: "销售与货盘经营日报",
        summary: {
          ownAmount: round(summaryTotals.ownAmount),
          assortmentAmount: publicTotals(summaryTotals, ownDataDays).assortmentAmount,
          gapAmount: round(Math.max(0, publicTotals(summaryTotals, ownDataDays).assortmentAmount
            - summaryTotals.ownAmount)),
          ownShare: publicTotals(summaryTotals, ownDataDays).ownShare,
          orderCount,
          averageOrderValue: orderCount > 0 ? round(summaryTotals.ownAmount / orderCount) : 0,
          storeCount: new Set(filteredOrders.map((item) => item.store)).size,
          productCount: filteredProducts.length,
          priorityCount: priorityAlerts.filter((item) => item.priority === "P0" || item.priority === "P1").length,
          storeAnomalyCount: storeSalesTrend.filter((item) => item.trendStatus === "decline").length,
          storeGrowthCount: storeSalesTrend.filter((item) => item.trendStatus === "growth" || item.trendStatus === "new_activity").length,
          productAnomalyCount: productSalesRanking.filter((item) => item.trendStatus === "decline").length,
          styleAnomalyCount: styleSalesTrend.filter((item) => item.trendStatus === "decline").length,
          styleGrowthCount: styleSalesTrend.filter((item) => item.trendStatus === "growth" || item.trendStatus === "new_activity").length,
          inventoryChangeCount: inventoryInsights.filter((item) => ["rapid_drop", "restock_arrival", "new_arrival"].includes(item.type)).length,
        },
        sections: {
          priorityAlerts: priorityAlerts.slice(0, 10),
          storeMovements: storeSalesTrend.filter((item) => item.trendStatus !== "stable").slice(0, 10),
          productMovements: productSalesRanking.filter((item) => item.trendStatus !== "stable").slice(0, 10),
          businessOpportunities: businessOpportunities.slice(0, 10),
          inventoryInsights: inventoryInsights.slice(0, 10),
          movementWindows: dailyMovementWindows,
        },
        delivery: {
          preferred: "dingtalk_interactive_card",
          fallback: "dingtalk_markdown",
        },
      },
      quality: {
        inventoryRows: inventoryRows.length,
        previousInventoryRows: previousInventoryResult.rows.length,
        orderRows: orderRows.length,
        productPackageRows: packageRows.length,
        priceCoverage: percent(packagePriced, packageRows.length),
        unmatchedInventoryProducts: filteredProducts.filter((item) => item.priceCoverage === 0).length,
      },
    };
  }
}
