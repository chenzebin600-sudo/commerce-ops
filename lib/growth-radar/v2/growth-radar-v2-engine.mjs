const DEFAULT_METRICS_VERSION = "GRV2-METRICS-1.2.0";
const ACTIVE_STATUSES = new Set(["ACTIVE", "CLEARANCE"]);
const DAY_MS = 24 * 60 * 60 * 1000;

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function sumComplete(rows, field) {
  const values = rows.map((row) => numberOrNull(row[field]));
  return values.some((value) => value === null)
    ? null
    : values.reduce((sum, value) => sum + value, 0);
}

function consistentNumber(rows, field) {
  const values = [...new Set(rows
    .map((row) => numberOrNull(row[field]))
    .filter((value) => value !== null))];
  if (!values.length) return { value: null, status: "missing", values: [] };
  if (values.length > 1) return { value: null, status: "conflict", values };
  return { value: values[0], status: values[0] > 0 ? "available" : "zero", values };
}

function parseJson(value, fallback = {}) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function firstValue(rows, field) {
  return rows.map((row) => row[field]).find((value) => value !== null && value !== undefined && value !== "") ?? null;
}

function normalizedStatus(value) {
  const status = String(value || "").normalize("NFKC").trim().toUpperCase();
  const map = new Map([
    ["正常销售", "ACTIVE"],
    ["ACTIVE", "ACTIVE"],
    ["商品清仓", "CLEARANCE"],
    ["清仓", "CLEARANCE"],
    ["CLEARANCE", "CLEARANCE"],
    ["等待开发", "DEVELOPMENT"],
    ["DEVELOPMENT", "DEVELOPMENT"],
    ["停止销售", "DISCONTINUED"],
    ["DISCONTINUED", "DISCONTINUED"],
    ["ARCHIVED", "DISCONTINUED"],
  ]);
  return map.get(status) || "UNKNOWN";
}

function rawProductName(row) {
  const raw = parseJson(row.raw_values_json, {});
  return row.mapped_product_name
    || raw["商品中文名称"]
    || raw["中文名称"]
    || raw["商品中文名"]
    || raw.productName
    || null;
}

function uniqueNonEmpty(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function maxIso(values) {
  return values.filter(Boolean).sort().at(-1) || null;
}

function daysBetween(start, endDate) {
  if (!start) return null;
  const from = new Date(start);
  const to = new Date(`${endDate}T23:59:59+08:00`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / DAY_MS));
}

function percentileRanks(items, valueSelector) {
  if (!items.length) return new Map();
  const sorted = [...items].sort((left, right) => {
    const valueDifference = valueSelector(left) - valueSelector(right);
    return valueDifference || String(left.sku).localeCompare(String(right.sku), "en");
  });
  const firstIndexByValue = new Map();
  sorted.forEach((item, index) => {
    const value = valueSelector(item);
    if (!firstIndexByValue.has(value)) firstIndexByValue.set(value, index);
  });
  const denominator = Math.max(1, sorted.length - 1);
  return new Map(sorted.map((item) => [
    item,
    sorted.length === 1 ? 0 : firstIndexByValue.get(valueSelector(item)) / denominator,
  ]));
}

function descendingRanks(items, valueSelector) {
  const sorted = [...items].sort((left, right) => {
    const valueDifference = valueSelector(right) - valueSelector(left);
    return valueDifference || String(left.sku).localeCompare(String(right.sku), "en");
  });
  const firstRankByValue = new Map();
  sorted.forEach((item, index) => {
    const value = valueSelector(item);
    if (!firstRankByValue.has(value)) firstRankByValue.set(value, index + 1);
  });
  return new Map(sorted.map((item) => [item, firstRankByValue.get(valueSelector(item))]));
}

function groupsBy(items, selector) {
  const groups = new Map();
  for (const item of items) {
    const key = selector(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

function categoryComparison(metrics, valueField, percentileField, minSize, {
  rankField = null,
  sampleField = null,
  scopeField = null,
  strictCategory = false,
} = {}) {
  const valid = metrics.filter((metric) => numberOrNull(metric[valueField]) !== null && metric.qualityStatus !== "blocked");
  const byL2 = groupsBy(valid.filter((metric) => metric.categoryL2), (metric) => metric.categoryL2);
  const byL1 = groupsBy(valid.filter((metric) => metric.categoryL1), (metric) => metric.categoryL1);
  const rankCache = new Map();
  const descendingRankCache = new Map();

  function ranked(scope, items) {
    const key = `${scope}\u0000${items.map((item) => item.sku).join("\u0001")}`;
    if (!rankCache.has(key)) rankCache.set(key, percentileRanks(items, (item) => numberOrNull(item[valueField])));
    return rankCache.get(key);
  }

  function descending(scope, items) {
    const key = `${scope}\u0000${items.map((item) => item.sku).join("\u0001")}`;
    if (!descendingRankCache.has(key)) {
      descendingRankCache.set(key, descendingRanks(items, (item) => numberOrNull(item[valueField])));
    }
    return descendingRankCache.get(key);
  }

  for (const metric of metrics) {
    if (numberOrNull(metric[valueField]) === null || metric.qualityStatus === "blocked") continue;
    let candidates = metric.categoryL2 ? byL2.get(metric.categoryL2) || [] : [];
    const prefix = metric.countryCode ? `country:${metric.countryCode}|` : "";
    let scope = metric.categoryL2 ? `${prefix}category_l2:${metric.categoryL2}` : null;
    if (candidates.length < minSize) {
      candidates = metric.categoryL1 ? byL1.get(metric.categoryL1) || [] : [];
      scope = metric.categoryL1 ? `${prefix}category_l1:${metric.categoryL1}` : null;
    }
    if (!strictCategory && candidates.length < minSize) {
      candidates = valid;
      scope = `${prefix}all_valid_skus`;
    }
    if (!candidates.length || candidates.length < minSize) continue;
    metric[percentileField] = ranked(scope, candidates).get(metric);
    if (rankField) metric[rankField] = descending(scope, candidates).get(metric);
    if (sampleField) metric[sampleField] = candidates.length;
    if (scopeField) metric[scopeField] = scope;
  }
}

function daysOfSupply(availableQuantity, sales28d) {
  if (availableQuantity === null || availableQuantity < 0) {
    return { value: null, dailySales: null, status: "invalid_negative_or_missing_inventory" };
  }
  if (sales28d === null) return { value: null, dailySales: null, status: "sales_unavailable" };
  if (sales28d === 0 && availableQuantity > 0) {
    return { value: null, dailySales: 0, status: "no_sales_in_28d" };
  }
  if (sales28d === 0 && availableQuantity === 0) {
    return { value: null, dailySales: 0, status: "no_stock_no_sales" };
  }
  const dailySales = sales28d / 28;
  return { value: availableQuantity / dailySales, dailySales, status: "calculated" };
}

function coverageFromDailyForecast(availableQuantity, predictedDailySales) {
  if (availableQuantity === null || availableQuantity < 0) {
    return { value: null, status: "invalid_negative_or_missing_inventory" };
  }
  if (predictedDailySales === null) return { value: null, status: "forecast_unavailable" };
  if (predictedDailySales <= 0) return { value: null, status: "forecast_zero" };
  return { value: availableQuantity / predictedDailySales, status: "calculated" };
}

function signal(input) {
  return {
    dedupeKey: [
      input.ruleCode,
      input.subjectType,
      input.countryCode || "GLOBAL",
      input.normalizedWarehouseName || "-",
      input.shopId || "-",
      input.sku || "-",
    ].join("|"),
    signalType: input.signalType,
    ruleCode: input.ruleCode,
    ruleVersion: input.ruleVersion,
    subjectType: input.subjectType,
    countryCode: input.countryCode || null,
    sourceWarehouseName: input.sourceWarehouseName || null,
    normalizedWarehouseName: input.normalizedWarehouseName || null,
    sku: input.sku || null,
    shopId: input.shopId || null,
    severity: input.severity,
    reasonCode: input.reasonCode || input.ruleCode,
    recommendedActionCode: input.recommendedActionCode,
    availabilityStatus: input.availabilityStatus || "available",
    qualityStatus: input.qualityStatus || "confirmed",
    evidence: input.evidence || {},
    detectedAt: input.detectedAt,
  };
}

function severityUp(value) {
  if (value === "warning") return "high";
  if (value === "high") return "critical";
  return value;
}

function aggregationEvidence(rows, input) {
  return {
    inventoryBatchId: input.inventoryBatchId,
    orderWatermarkAt: input.orderWatermarkAt,
    snapshotAt: maxIso(rows.map((row) => row.snapshot_at)),
    sourceScopeStatus: uniqueNonEmpty(rows.map((row) => row.source_scope_status)),
    warehouses: rows.map((row) => ({
      name: row.normalized_warehouse_name,
      availableQuantity: numberOrNull(row.available_quantity),
      inTransitQuantity: numberOrNull(row.in_transit_quantity),
      sourceVisibleSales7d: numberOrNull(row.source_visible_sales_7d),
      sourceVisibleSales28d: numberOrNull(row.source_visible_sales_28d),
      sourceVisibleSales42d: numberOrNull(row.source_visible_sales_42d),
      sourcePredictedDailySales: numberOrNull(row.source_predicted_daily_sales),
    })),
  };
}

function warehouseSupplyStatus({
  availableQuantity,
  inTransitQuantity,
  sourceCurrentSellableDays,
  outOfStockDays,
  criticalDays,
  warningDays,
  hasConflict = false,
}) {
  if (hasConflict
    || availableQuantity < 0
    || inTransitQuantity < 0
    || sourceCurrentSellableDays < 0) {
    return "SUPPLY_DATA_CONFLICT";
  }
  if (availableQuantity === null
    || inTransitQuantity === null
    || sourceCurrentSellableDays === null) {
    return "SUPPLY_DATA_INSUFFICIENT";
  }
  if ((availableQuantity > 0 && sourceCurrentSellableDays <= outOfStockDays)
    || (availableQuantity <= 0 && inTransitQuantity <= 0 && sourceCurrentSellableDays > outOfStockDays)) {
    return "SUPPLY_DATA_CONFLICT";
  }
  if (availableQuantity <= 0 && inTransitQuantity > 0) return "IN_TRANSIT_ONLY";
  if (availableQuantity <= 0
    && inTransitQuantity <= 0
    && sourceCurrentSellableDays <= outOfStockDays) {
    return "OUT_OF_STOCK";
  }
  if (sourceCurrentSellableDays <= criticalDays) return "SUPPLY_CRITICAL";
  if (sourceCurrentSellableDays <= warningDays) return "SUPPLY_WARNING";
  return "SUPPLY_HEALTHY";
}

function warehouseSlowMovingStatus({
  availableQuantity,
  sourceCurrentSellableDays,
  watchDays,
  riskDays,
  severeDays,
}) {
  if (!(availableQuantity > 0) || sourceCurrentSellableDays === null) return "NOT_APPLICABLE";
  if (sourceCurrentSellableDays > severeDays) return "SLOW_MOVING_SEVERE";
  if (sourceCurrentSellableDays > riskDays) return "SLOW_MOVING_RISK";
  if (sourceCurrentSellableDays > watchDays) return "SLOW_MOVING_WATCH";
  return "NORMAL";
}

function aggregateWarehouseRows(rows, input, countryCode) {
  const available = consistentNumber(rows, "available_quantity");
  const inTransit = consistentNumber(rows, "in_transit_quantity");
  const sellableDays = consistentNumber(rows, "days_of_supply");
  const predicted = consistentNumber(rows, "source_predicted_daily_sales");
  const sales7 = consistentNumber(rows, "source_visible_sales_7d");
  const sales28 = consistentNumber(rows, "source_visible_sales_28d");
  const sales42 = consistentNumber(rows, "source_visible_sales_42d");
  const statuses = uniqueNonEmpty(rows.map((row) => normalizedStatus(row.product_status)));
  const categoriesL1 = uniqueNonEmpty(rows.map((row) => row.category_level_1));
  const categoriesL2 = uniqueNonEmpty(rows.map((row) => row.category_level_2));
  const mappedProductIds = uniqueNonEmpty(rows.map((row) => row.mapped_product_id));
  const conflictingFields = [
    ["available_quantity", available],
    ["in_transit_quantity", inTransit],
    ["days_of_supply", sellableDays],
    ["source_predicted_daily_sales", predicted],
    ["source_visible_sales_7d", sales7],
    ["source_visible_sales_28d", sales28],
    ["source_visible_sales_42d", sales42],
  ].filter(([, result]) => result.status === "conflict").map(([field]) => field);
  const supplyStatus = warehouseSupplyStatus({
    availableQuantity: available.value,
    inTransitQuantity: inTransit.value,
    sourceCurrentSellableDays: sellableDays.value,
    outOfStockDays: input.outOfStockDays,
    criticalDays: input.supplyCriticalDays,
    warningDays: input.supplyWarningDays,
    hasConflict: conflictingFields.length > 0,
  });
  const slowMovingStatus = supplyStatus === "SUPPLY_DATA_CONFLICT"
    || supplyStatus === "SUPPLY_DATA_INSUFFICIENT"
    ? "NOT_APPLICABLE"
    : warehouseSlowMovingStatus({
      availableQuantity: available.value,
      sourceCurrentSellableDays: sellableDays.value,
      watchDays: input.slowWatchDays,
      riskDays: input.slowRiskDays,
      severeDays: input.slowSevereDays,
    });
  const blocked = supplyStatus === "SUPPLY_DATA_CONFLICT";
  const degraded = supplyStatus === "SUPPLY_DATA_INSUFFICIENT";
  const normalizedWarehouseName = firstValue(rows, "normalized_warehouse_name");
  return {
    analysisDate: input.analysisDate,
    countryCode,
    sourceWarehouseName: firstValue(rows, "warehouse_name") || normalizedWarehouseName,
    normalizedWarehouseName,
    sku: rows[0].normalized_source_sku,
    sourceSku: firstValue(rows, "source_sku") || rows[0].normalized_source_sku,
    productName: rows.map(rawProductName).find(Boolean) || null,
    productStatus: statuses.length === 1 ? statuses[0] : "UNKNOWN",
    categoryL1: categoriesL1[0] || null,
    categoryL2: categoriesL2[0] || null,
    mappedProductId: mappedProductIds.length === 1 ? mappedProductIds[0] : null,
    mappingStatus: mappedProductIds.length === 1 ? "matched" : firstValue(rows, "mapping_status") || "unmatched",
    availableQuantity: available.value,
    inTransitQuantity: inTransit.value,
    sourceCurrentSellableDays: sellableDays.value,
    sourcePredictedDailySales: predicted.value,
    sourceVisibleSales7d: sales7.value,
    sourceVisibleSales28d: sales28.value,
    sourceVisibleSales42d: sales42.value,
    supplyStatus,
    slowMovingStatus,
    availabilityStatus: blocked ? "unavailable" : (degraded ? "degraded" : "available"),
    qualityStatus: blocked ? "blocked" : (degraded ? "degraded" : "confirmed"),
    reasonCode: conflictingFields[0]
      ? `WAREHOUSE_${conflictingFields[0].toUpperCase()}_CONFLICT`
      : supplyStatus,
    metricsVersion: input.metricsVersion,
    evidence: {
      inventoryBatchId: input.inventoryBatchId,
      snapshotAt: maxIso(rows.map((row) => row.snapshot_at)),
      sourceRowCount: rows.length,
      sourceWarehouseName: firstValue(rows, "warehouse_name"),
      normalizedWarehouseName,
      sourceCurrentSellableDays: sellableDays.value,
      sourceCurrentSellableDaysStatus: sellableDays.status,
      availableQuantityValues: available.values,
      inTransitQuantityValues: inTransit.values,
      sourcePredictedDailySalesValues: predicted.values,
      sourceVisibleSales7dValues: sales7.values,
      sourceVisibleSales28dValues: sales28.values,
      sourceVisibleSales42dValues: sales42.values,
      conflictingFields,
      thresholds: {
        outOfStockDays: input.outOfStockDays,
        criticalDays: input.supplyCriticalDays,
        warningDays: input.supplyWarningDays,
        slowWatchDays: input.slowWatchDays,
        slowRiskDays: input.slowRiskDays,
        slowSevereDays: input.slowSevereDays,
      },
      formula: "source_current_sellable_days_used_directly_at_country_warehouse_sku_grain",
    },
    calculatedAt: input.calculatedAt,
  };
}

function summarizeWarehouseSupply(metrics) {
  const count = (status) => metrics.filter((metric) => metric.supplyStatus === status).length;
  const summary = {
    warehouseCount: metrics.length,
    outOfStockCount: count("OUT_OF_STOCK"),
    inTransitOnlyCount: count("IN_TRANSIT_ONLY"),
    criticalCount: count("SUPPLY_CRITICAL"),
    warningCount: count("SUPPLY_WARNING"),
    healthyCount: count("SUPPLY_HEALTHY"),
    dataInsufficientCount: count("SUPPLY_DATA_INSUFFICIENT"),
    dataConflictCount: count("SUPPLY_DATA_CONFLICT"),
    slowWatchCount: metrics.filter((metric) => metric.slowMovingStatus === "SLOW_MOVING_WATCH").length,
    slowRiskCount: metrics.filter((metric) => metric.slowMovingStatus === "SLOW_MOVING_RISK").length,
    slowSevereCount: metrics.filter((metric) => metric.slowMovingStatus === "SLOW_MOVING_SEVERE").length,
  };
  return {
    summary,
    riskCount: summary.outOfStockCount + summary.inTransitOnlyCount
      + summary.criticalCount + summary.warningCount,
    criticalCount: summary.outOfStockCount + summary.criticalCount,
    warningCount: summary.warningCount,
    dataIssueCount: summary.dataInsufficientCount + summary.dataConflictCount,
  };
}

function aggregateSkuRows(rows, input, {
  scopeType = "global",
  scopeKey = "GLOBAL",
  countryCode = null,
  warehouseMetrics = [],
} = {}) {
  const sumWarehouseMetric = (field) => {
    const values = warehouseMetrics.map((metric) => numberOrNull(metric[field]));
    return values.some((value) => value === null)
      ? null
      : values.reduce((sum, value) => sum + value, 0);
  };
  const useWarehouseProjection = scopeType === "country";
  const availableQuantity = useWarehouseProjection
    ? sumWarehouseMetric("availableQuantity")
    : sumComplete(rows, "available_quantity");
  const inTransitQuantity = useWarehouseProjection
    ? sumWarehouseMetric("inTransitQuantity")
    : sumComplete(rows, "in_transit_quantity");
  const sourceVisibleSales7d = useWarehouseProjection
    ? sumWarehouseMetric("sourceVisibleSales7d")
    : sumComplete(rows, "source_visible_sales_7d");
  const sourceVisibleSales28d = useWarehouseProjection
    ? sumWarehouseMetric("sourceVisibleSales28d")
    : sumComplete(rows, "source_visible_sales_28d");
  const sourceVisibleSales42d = useWarehouseProjection
    ? sumWarehouseMetric("sourceVisibleSales42d")
    : sumComplete(rows, "source_visible_sales_42d");
  const sourcePredictedDailySales = useWarehouseProjection
    ? sumWarehouseMetric("sourcePredictedDailySales")
    : sumComplete(rows, "source_predicted_daily_sales");
  const statuses = uniqueNonEmpty(rows.map((row) => normalizedStatus(row.product_status)));
  const productStatus = statuses.length === 1 ? statuses[0] : "UNKNOWN";
  const categoryL1Values = uniqueNonEmpty(rows.map((row) => row.category_level_1));
  const categoryL2Values = uniqueNonEmpty(rows.map((row) => row.category_level_2));
  const scopeConfirmed = rows.every((row) => row.source_scope_status === "confirmed");
  const qualityReasons = [];
  if (availableQuantity === null) qualityReasons.push("AVAILABLE_INVENTORY_INCOMPLETE");
  if (availableQuantity !== null && availableQuantity < 0) qualityReasons.push("NEGATIVE_AVAILABLE_INVENTORY");
  if ([sourceVisibleSales7d, sourceVisibleSales28d, sourceVisibleSales42d].some((value) => value === null)) {
    qualityReasons.push("SOURCE_VISIBLE_SALES_INCOMPLETE");
  }
  if (!scopeConfirmed) qualityReasons.push("SOURCE_SCOPE_UNCONFIRMED");
  if (productStatus === "UNKNOWN") qualityReasons.push("PRODUCT_STATUS_UNKNOWN");
  if (!rows.every((row) => row.normalized_warehouse_name)) qualityReasons.push("WAREHOUSE_IDENTITY_MISSING");
  if (sourcePredictedDailySales === null) qualityReasons.push("SOURCE_PREDICTED_DAILY_SALES_INCOMPLETE");
  const blocked = qualityReasons.length > 0;
  const supply = summarizeWarehouseSupply(warehouseMetrics);
  const mappedProductIds = uniqueNonEmpty(rows.map((row) => row.mapped_product_id));
  const lifecycleStatuses = uniqueNonEmpty(rows.map((row) => row.lifecycle_status));
  const newStartedAt = firstValue(rows, "new_started_at")
    || (lifecycleStatuses.includes("NEW") ? firstValue(rows, "lifecycle_effective_at") : null);
  const newAgeDays = lifecycleStatuses.includes("NEW") ? daysBetween(newStartedAt, input.analysisDate) : null;
  return {
    analysisDate: input.analysisDate,
    scopeType,
    scopeKey,
    countryCode,
    sku: rows[0].normalized_source_sku,
    sourceSku: firstValue(rows, "source_sku") || rows[0].normalized_source_sku,
    productName: rows.map(rawProductName).find(Boolean) || null,
    productStatus,
    categoryL1: categoryL1Values[0] || null,
    categoryL2: categoryL2Values[0] || null,
    mappedProductId: mappedProductIds.length === 1 ? mappedProductIds[0] : null,
    mappingStatus: mappedProductIds.length === 1 ? "matched" : firstValue(rows, "mapping_status") || "unmatched",
    warehouseCount: useWarehouseProjection ? warehouseMetrics.length : rows.length,
    availableQuantity,
    inTransitQuantity,
    sourceVisibleSales7d,
    sourceVisibleSales28d,
    sourceVisibleSales42d,
    sourcePredictedDailySales,
    forecastStatus: sourcePredictedDailySales === null ? "missing" : "summed_unique_warehouses",
    forecastCoverageDays: null,
    forecastCoverageStatus: "warehouse_aggregate_only",
    forecastRank: null,
    forecastPercentile: null,
    forecastComparisonScope: null,
    forecastComparisonSampleSize: null,
    effectiveDailySales28d: null,
    computedDaysOfSupply: null,
    daysOfSupplyStatus: "warehouse_aggregate_only",
    demandPercentile28d: null,
    assortmentPercentile: null,
    assortmentStatus: "ASSORTMENT_DATA_INSUFFICIENT",
    inventoryPercentile: null,
    comparisonScope: null,
    comparisonSampleSize: null,
    sourceHighPerformance: false,
    warehouseSupplySummary: supply.summary,
    supplyRiskWarehouseCount: supply.riskCount,
    supplyCriticalWarehouseCount: supply.criticalCount,
    supplyWarningWarehouseCount: supply.warningCount,
    supplyDataIssueWarehouseCount: supply.dataIssueCount,
    isNew: lifecycleStatuses.includes("NEW") && newAgeDays !== null && newAgeDays <= 90,
    newAgeDays,
    availabilityStatus: blocked ? "unavailable" : (scopeType === "global" && !input.hasCountryMappings ? "degraded" : "available"),
    qualityStatus: blocked ? "blocked" : (scopeType === "global" && !input.hasCountryMappings ? "degraded" : "confirmed"),
    reasonCode: qualityReasons[0] || (scopeType === "global" && !input.hasCountryMappings
      ? "COUNTRY_MAPPING_UNAVAILABLE"
      : "METRIC_AVAILABLE"),
    metricsVersion: input.metricsVersion,
    evidence: {
      ...aggregationEvidence(rows, input),
      qualityReasons,
      sourceProductStatus: uniqueNonEmpty(rows.map((row) => row.product_status)),
      categoryL1Values,
      categoryL2Values,
      countrySupplySemantic: "warehouse_risk_counts_only",
      warehouseSupplySummary: supply.summary,
      sourcePredictedDailySales,
      sourcePredictedDailySalesStatus: sourcePredictedDailySales === null
        ? "incomplete"
        : "summed_unique_warehouses",
      sourcePredictedDailySalesValues: rows.map((row) => ({
        warehouse: row.normalized_warehouse_name,
        value: numberOrNull(row.source_predicted_daily_sales),
      })),
      forecastCoverageDays: null,
      forecastCoverageStatus: "warehouse_aggregate_only",
      newStartedAt,
    },
    calculatedAt: input.calculatedAt,
  };
}

function buildSkuMetrics(input) {
  const globalGroups = groupsBy(input.inventoryRows.filter((row) => row.normalized_source_sku),
    (row) => row.normalized_source_sku);
  const mappingByWarehouse = new Map(input.warehouseMappings
    .filter((mapping) => mapping.mapping_status === "confirmed")
    .map((mapping) => [mapping.normalized_warehouse_name, mapping]));
  const warehouseGroups = new Map();
  for (const row of input.inventoryRows) {
    const mapping = mappingByWarehouse.get(row.normalized_warehouse_name);
    if (!mapping || !row.normalized_source_sku) continue;
    const key = [
      mapping.country_code,
      row.normalized_warehouse_name,
      row.normalized_source_sku,
    ].join("\u0000");
    if (!warehouseGroups.has(key)) warehouseGroups.set(key, { mapping, rows: [] });
    warehouseGroups.get(key).rows.push(row);
  }
  const warehouseMetrics = [...warehouseGroups.values()].map(({ mapping, rows }) => (
    aggregateWarehouseRows(rows, input, mapping.country_code)
  ));
  const rawByCountrySku = new Map();
  for (const { mapping, rows } of warehouseGroups.values()) {
    const key = `${mapping.country_code}\u0000${rows[0].normalized_source_sku}`;
    if (!rawByCountrySku.has(key)) rawByCountrySku.set(key, []);
    rawByCountrySku.get(key).push(...rows);
  }
  const warehouseBySku = groupsBy(warehouseMetrics, (metric) => metric.sku);
  const globalMetrics = [...globalGroups.entries()].map(([sku, rows]) => aggregateSkuRows(rows, input, {
    warehouseMetrics: warehouseBySku.get(sku) || [],
  }));

  const warehouseByCountrySku = groupsBy(
    warehouseMetrics,
    (metric) => `${metric.countryCode}\u0000${metric.sku}`,
  );
  const countryMetrics = [...warehouseByCountrySku.entries()].map(([key, metrics]) => {
    const [countryCode, sku] = key.split("\u0000");
    return aggregateSkuRows(rawByCountrySku.get(key) || [], input, {
      scopeType: "country",
      scopeKey: countryCode,
      countryCode,
      warehouseMetrics: metrics,
    });
  });

  for (const metrics of groupsBy(countryMetrics, (metric) => metric.scopeKey).values()) {
    categoryComparison(metrics, "sourcePredictedDailySales", "forecastPercentile", input.minimumComparisonSize, {
      rankField: "forecastRank",
      sampleField: "forecastComparisonSampleSize",
      scopeField: "forecastComparisonScope",
      strictCategory: true,
    });
    categoryComparison(metrics, "availableQuantity", "inventoryPercentile", input.minimumComparisonSize);
    for (const metric of metrics) {
      metric.demandPercentile28d = metric.forecastPercentile;
      metric.assortmentPercentile = metric.forecastPercentile;
      metric.comparisonScope = metric.forecastComparisonScope;
      metric.comparisonSampleSize = metric.forecastComparisonSampleSize;
      if (metric.forecastPercentile === null
        || metric.forecastComparisonSampleSize < input.minimumComparisonSize) {
        metric.assortmentStatus = "ASSORTMENT_DATA_INSUFFICIENT";
      } else if (metric.sourcePredictedDailySales > 0
        && metric.forecastPercentile >= input.assortmentHighPercentile) {
        metric.assortmentStatus = "ASSORTMENT_VERIFIED_HIGH";
      } else if (metric.forecastPercentile >= input.assortmentMidPercentile) {
        metric.assortmentStatus = "ASSORTMENT_VERIFIED_MID";
      } else {
        metric.assortmentStatus = "ASSORTMENT_LOW";
      }
      metric.sourceHighPerformance = metric.assortmentStatus === "ASSORTMENT_VERIFIED_HIGH"
        && metric.qualityStatus !== "blocked";
      metric.evidence = {
        ...metric.evidence,
        sourcePredictedDailySales: metric.sourcePredictedDailySales,
        assortmentPercentile: metric.assortmentPercentile,
        assortmentStatus: metric.assortmentStatus,
        assortmentRank: metric.forecastRank,
        assortmentComparisonScope: metric.forecastComparisonScope,
        assortmentComparisonSampleSize: metric.forecastComparisonSampleSize,
        inventoryPercentile: metric.inventoryPercentile,
        comparisonScope: metric.comparisonScope,
        comparisonSampleSize: metric.comparisonSampleSize,
        assortmentHighThreshold: input.assortmentHighPercentile,
        assortmentMidThreshold: input.assortmentMidPercentile,
      };
    }
  }

  return { globalMetrics, countryMetrics, warehouseMetrics };
}

function buildSkuSignals(metrics, input) {
  const signals = [];
  for (const metric of metrics) {
    const evidence = {
      ...metric.evidence,
      normalizedSourceSku: metric.sku,
      productStatus: metric.productStatus,
      availableQuantity: metric.availableQuantity,
      inTransitQuantity: metric.inTransitQuantity,
      sourceVisibleSales7d: metric.sourceVisibleSales7d,
      sourceVisibleSales28d: metric.sourceVisibleSales28d,
      sourceVisibleSales42d: metric.sourceVisibleSales42d,
      sourcePredictedDailySales: metric.sourcePredictedDailySales,
      forecastPercentile: metric.forecastPercentile,
      forecastRank: metric.forecastRank,
      assortmentStatus: metric.assortmentStatus,
      warehouseSupplySummary: metric.warehouseSupplySummary,
      categoryL1: metric.categoryL1,
      categoryL2: metric.categoryL2,
    };
    const common = {
      ruleVersion: input.metricsVersion,
      subjectType: "sku",
      countryCode: metric.countryCode,
      sku: metric.sku,
      detectedAt: input.calculatedAt,
      evidence,
    };
    if (metric.qualityStatus === "blocked") {
      signals.push(signal({
        ...common,
        signalType: "data_quality",
        ruleCode: "METRIC_DATA_BLOCKED",
        severity: "high",
        reasonCode: metric.reasonCode,
        recommendedActionCode: "review_source_data",
        availabilityStatus: "unavailable",
        qualityStatus: "blocked",
      }));
      continue;
    }
    if (metric.sourceHighPerformance) {
      signals.push(signal({
        ...common,
        signalType: "highlight",
        ruleCode: "ASSORTMENT_VERIFIED_HIGH",
        severity: "information",
        reasonCode: "ASSORTMENT_P80",
        recommendedActionCode: "review_country_category_priority",
        qualityStatus: metric.qualityStatus,
        availabilityStatus: metric.availabilityStatus,
      }));
    }
    if (metric.isNew
      && metric.newAgeDays <= input.newDays
      && metric.availableQuantity > 0
      && metric.sourceVisibleSales7d > 0) {
      signals.push(signal({
        ...common,
        signalType: "opportunity",
        ruleCode: "NEW_PRODUCT_OPPORTUNITY",
        severity: "information",
        recommendedActionCode: "review_new_product_promotion",
        qualityStatus: metric.qualityStatus,
        availabilityStatus: metric.availabilityStatus,
      }));
    }
    if (metric.productStatus === "DISCONTINUED" && metric.availableQuantity > 0) {
      signals.push(signal({
        ...common,
        signalType: "risk",
        ruleCode: "DISCONTINUED_WITH_STOCK",
        severity: "critical",
        recommendedActionCode: "review_discontinued_stock",
      }));
      continue;
    }
    if (!ACTIVE_STATUSES.has(metric.productStatus)) continue;
  }
  return signals;
}

function buildWarehouseSignals(metrics, input) {
  const signals = [];
  for (const metric of metrics) {
    const common = {
      ruleVersion: input.metricsVersion,
      subjectType: "warehouse_sku",
      countryCode: metric.countryCode,
      sourceWarehouseName: metric.sourceWarehouseName,
      normalizedWarehouseName: metric.normalizedWarehouseName,
      sku: metric.sku,
      detectedAt: input.calculatedAt,
      availabilityStatus: metric.availabilityStatus,
      qualityStatus: metric.qualityStatus,
      evidence: {
        ...metric.evidence,
        normalizedSourceSku: metric.sku,
        sourceSku: metric.sourceSku,
        productName: metric.productName,
        productStatus: metric.productStatus,
        categoryL1: metric.categoryL1,
        categoryL2: metric.categoryL2,
        supplyStatus: metric.supplyStatus,
        slowMovingStatus: metric.slowMovingStatus,
        availableQuantity: metric.availableQuantity,
        inTransitQuantity: metric.inTransitQuantity,
        sourceCurrentSellableDays: metric.sourceCurrentSellableDays,
      },
    };
    if (metric.supplyStatus === "SUPPLY_DATA_CONFLICT"
      || metric.supplyStatus === "SUPPLY_DATA_INSUFFICIENT") {
      signals.push(signal({
        ...common,
        signalType: "data_quality",
        ruleCode: metric.supplyStatus,
        severity: metric.supplyStatus === "SUPPLY_DATA_CONFLICT" ? "high" : "warning",
        reasonCode: metric.reasonCode,
        recommendedActionCode: "review_warehouse_source_data",
      }));
      continue;
    }
    const supplyDefinition = {
      OUT_OF_STOCK: ["critical", "review_replenishment"],
      IN_TRANSIT_ONLY: ["warning", "evaluate_after_arrival"],
      SUPPLY_CRITICAL: ["high", "review_replenishment"],
      SUPPLY_WARNING: ["warning", "review_supply_plan"],
    }[metric.supplyStatus];
    if (supplyDefinition) {
      signals.push(signal({
        ...common,
        signalType: "risk",
        ruleCode: metric.supplyStatus,
        severity: supplyDefinition[0],
        recommendedActionCode: supplyDefinition[1],
      }));
    }
    const slowDefinition = {
      SLOW_MOVING_WATCH: ["warning", "review_purchase_pause"],
      SLOW_MOVING_RISK: ["high", "review_purchase_pause"],
      SLOW_MOVING_SEVERE: ["critical", "review_clearance"],
    }[metric.slowMovingStatus];
    if (slowDefinition) {
      signals.push(signal({
        ...common,
        signalType: "risk",
        ruleCode: metric.slowMovingStatus,
        severity: metric.productStatus === "CLEARANCE"
          ? severityUp(slowDefinition[0])
          : slowDefinition[0],
        recommendedActionCode: metric.productStatus === "CLEARANCE"
          ? "review_clearance"
          : slowDefinition[1],
      }));
    }
  }
  return signals;
}

function windowBounds(analysisDate, days) {
  const endExclusive = new Date(`${analysisDate}T00:00:00+08:00`);
  endExclusive.setDate(endExclusive.getDate() + 1);
  const start = new Date(endExclusive.getTime() - days * DAY_MS);
  return { start: start.getTime(), endExclusive: endExclusive.getTime() };
}

function inWindow(value, bounds) {
  const time = new Date(value).getTime();
  return Number.isFinite(time) && time >= bounds.start && time < bounds.endExclusive;
}

function aggregateShopSales(orderRows, analysisDate) {
  const bounds7 = windowBounds(analysisDate, 7);
  const previousBounds7 = {
    start: bounds7.start - (7 * DAY_MS),
    endExclusive: bounds7.start,
  };
  const bounds28 = windowBounds(analysisDate, 28);
  const shops = new Map();
  for (const row of orderRows) {
    if (!inWindow(row.paid_at, bounds28)) continue;
    const shopId = row.internal_shop_id;
    const sku = row.normalized_source_sku;
    if (!shopId || !sku) continue;
    if (!shops.has(shopId)) shops.set(shopId, new Map());
    const bySku = shops.get(shopId);
    if (!bySku.has(sku)) {
      bySku.set(sku, {
        quantity7: 0,
        quantityPrevious7: 0,
        quantity28: 0,
        orders7: new Set(),
        ordersPrevious7: new Set(),
        orders28: new Set(),
        lastSoldAt: null,
        productName: row.product_name || null,
      });
    }
    const aggregate = bySku.get(sku);
    const quantity = Number(row.quantity || 0);
    aggregate.quantity28 += quantity;
    aggregate.orders28.add(row.order_header_id);
    if (inWindow(row.paid_at, bounds7)) {
      aggregate.quantity7 += quantity;
      aggregate.orders7.add(row.order_header_id);
    }
    if (inWindow(row.paid_at, previousBounds7)) {
      aggregate.quantityPrevious7 += quantity;
      aggregate.ordersPrevious7.add(row.order_header_id);
    }
    if (!aggregate.productName && row.product_name) aggregate.productName = row.product_name;
    if (!aggregate.lastSoldAt || row.paid_at > aggregate.lastSoldAt) aggregate.lastSoldAt = row.paid_at;
  }
  return shops;
}

function categoryAllowed(metric, scope) {
  const categories = Array.isArray(scope) ? scope.filter(Boolean).map(String) : [];
  if (!categories.length) return true;
  return categories.includes(metric.categoryL2) || categories.includes(metric.categoryL1);
}

function assignShopSalesPercentiles(items) {
  const sold = items.filter((item) => item.ownSalesQuantity28d > 0);
  const byL2 = groupsBy(sold.filter((item) => item.categoryL2), (item) => item.categoryL2);
  const allRanks = percentileRanks(sold, (item) => item.ownSalesQuantity28d);
  for (const item of sold) {
    const category = item.categoryL2 ? byL2.get(item.categoryL2) || [] : [];
    const ranks = category.length >= 10
      ? percentileRanks(category, (candidate) => candidate.ownSalesQuantity28d)
      : allRanks;
    item.shopSalesPercentile28d = ranks.get(item) ?? null;
  }
}

function assignShopRatioPercentiles(items, minimumComparisonSize) {
  const valid = items.filter((item) => item.shopToSourceVisibleRatio28d !== null);
  const byL2 = groupsBy(valid.filter((item) => item.categoryL2), (item) => item.categoryL2);
  const byL1 = groupsBy(valid.filter((item) => item.categoryL1), (item) => item.categoryL1);
  for (const item of valid) {
    let candidates = item.categoryL2 ? byL2.get(item.categoryL2) || [] : [];
    if (candidates.length < minimumComparisonSize) {
      candidates = item.categoryL1 ? byL1.get(item.categoryL1) || [] : [];
    }
    if (candidates.length < minimumComparisonSize) continue;
    item.shopToSourceVisibleRatioPercentile28d = percentileRanks(
      candidates,
      (candidate) => candidate.shopToSourceVisibleRatio28d,
    ).get(item);
  }
}

function operationalDirection({
  sourceHighPerformance,
  availableQuantity,
  supplyRiskWarehouseCount,
  ownSalesQuantity28d,
  ownCaptureRatio28d,
  lowCaptureThreshold,
}) {
  if (!sourceHighPerformance) return null;
  if (availableQuantity <= 0 || supplyRiskWarehouseCount > 0) {
    return "SUPPLY_CONSTRAINED";
  }
  if (ownSalesQuantity28d === 0) return "QUIET_ENTRY";
  if (ownCaptureRatio28d !== null && ownCaptureRatio28d < lowCaptureThreshold) {
    return "PRIORITY_GROWTH";
  }
  return "DEFEND_WINNER";
}

function directionSignal(directionCode, input) {
  const definitions = {
    QUIET_ENTRY: {
      signalType: "opportunity",
      ruleCode: input.shopId ? "STORE_QUIET_ENTRY" : "QUIET_ENTRY_OPPORTUNITY",
      severity: "high",
      reasonCode: "FORECAST_HIGH_OWN_SALES_ZERO",
      recommendedActionCode: "review_quiet_entry",
    },
    PRIORITY_GROWTH: {
      signalType: "opportunity",
      ruleCode: input.shopId ? "STORE_PRIORITY_GROWTH" : "PRIORITY_GROWTH_DIRECTION",
      severity: "high",
      reasonCode: "FORECAST_HIGH_OWN_CAPTURE_LOW",
      recommendedActionCode: "prioritize_store_growth",
    },
    DEFEND_WINNER: {
      signalType: "highlight",
      ruleCode: input.shopId ? "STORE_DEFEND_WINNER" : "DEFEND_WINNER_DIRECTION",
      severity: "information",
      reasonCode: "FORECAST_HIGH_OWN_CAPTURE_ESTABLISHED",
      recommendedActionCode: "protect_winner",
    },
    SUPPLY_CONSTRAINED: {
      signalType: "risk",
      ruleCode: input.shopId ? "STORE_SUPPLY_CONSTRAINED" : "SUPPLY_CONSTRAINED_DIRECTION",
      severity: "critical",
      reasonCode: "FORECAST_HIGH_SUPPLY_CONSTRAINED",
      recommendedActionCode: "resolve_supply_before_growth",
    },
  };
  return signal({
    ...input,
    ...definitions[directionCode],
  });
}

function buildShopMetrics(input, skuLayer) {
  const salesByShop = aggregateShopSales(input.orderRows, input.analysisDate);
  const globalBySku = new Map(skuLayer.globalMetrics.map((metric) => [metric.sku, metric]));
  const countryByKey = new Map(skuLayer.countryMetrics.map((metric) => [`${metric.countryCode}\u0000${metric.sku}`, metric]));
  const shopMetrics = [];
  const shopSkuMetrics = [];
  const signals = [];
  const countrySignals = groupsBy(
    buildSkuSignals(skuLayer.countryMetrics, input),
    (entry) => entry.countryCode || "UNMAPPED",
  );

  for (const shop of input.shops) {
    const shopSales = salesByShop.get(shop.id) || new Map();
    const countryConfirmed = shop.country_code && shop.country_code !== "ZZ";
    const countryMetrics = countryConfirmed
      ? skuLayer.countryMetrics.filter((metric) => metric.countryCode === shop.country_code)
      : [];
    const scope = parseJson(shop.primary_category_scope_json, []);
    const eligible = countryMetrics.filter((metric) => ACTIVE_STATUSES.has(metric.productStatus)
      && metric.availableQuantity > 0
      && metric.qualityStatus !== "blocked"
      && categoryAllowed(metric, scope));
    const highPerformance = eligible.filter((metric) => metric.sourceHighPerformance);
    const candidateSkus = new Set(shopSales.keys());
    highPerformance.forEach((metric) => candidateSkus.add(metric.sku));
    const items = [];

    for (const sku of candidateSkus) {
      const own = shopSales.get(sku) || {
        quantity7: 0,
        quantityPrevious7: 0,
        quantity28: 0,
        orders7: new Set(),
        ordersPrevious7: new Set(),
        orders28: new Set(),
        lastSoldAt: null,
      };
      const countryMetric = countryByKey.get(`${shop.country_code}\u0000${sku}`) || null;
      const metric = countryMetric || globalBySku.get(sku) || null;
      if (!metric) continue;
      const ratio = countryMetric?.sourcePredictedDailySales > 0
        ? (own.quantity28 / 28) / countryMetric.sourcePredictedDailySales
        : null;
      const directionCode = operationalDirection({
        sourceHighPerformance: Boolean(countryMetric?.sourceHighPerformance),
        availableQuantity: countryMetric?.availableQuantity ?? null,
        supplyRiskWarehouseCount: countryMetric?.supplyRiskWarehouseCount ?? 0,
        ownSalesQuantity28d: own.quantity28,
        ownCaptureRatio28d: ratio,
        lowCaptureThreshold: input.storeLowRatioPercentile,
      });
      items.push({
        analysisDate: input.analysisDate,
        shopId: shop.id,
        countryCode: shop.country_code || "ZZ",
        sku,
        sourceSku: metric.sourceSku,
        productName: metric.productName || own.productName || null,
        categoryL1: metric.categoryL1,
        categoryL2: metric.categoryL2,
        mappedProductId: metric.mappedProductId,
        ownSalesQuantity7d: own.quantity7,
        ownSalesQuantity28d: own.quantity28,
        validOrderCount7d: own.orders7.size,
        validOrderCount28d: own.orders28.size,
        lastSoldAt: own.lastSoldAt,
        sourceVisibleSales7d: countryMetric?.sourceVisibleSales7d ?? null,
        sourceVisibleSales28d: countryMetric?.sourceVisibleSales28d ?? null,
        sourceVisibleSales42d: countryMetric?.sourceVisibleSales42d ?? null,
        shopToSourceVisibleRatio28d: ratio,
        ownCaptureRatio28d: ratio,
        shopToSourceVisibleRatioPercentile28d: null,
        shopSalesPercentile28d: null,
        eligibleSaleable: Boolean(countryMetric && eligible.includes(countryMetric)),
        eligibleHighPerformance: Boolean(countryMetric?.sourceHighPerformance && eligible.includes(countryMetric)),
        keyPerformer: false,
        growthFocusCandidate: false,
        availableQuantity: countryMetric?.availableQuantity ?? null,
        sourcePredictedDailySales: countryMetric?.sourcePredictedDailySales ?? null,
        forecastPercentile: countryMetric?.forecastPercentile ?? null,
        forecastRank: countryMetric?.forecastRank ?? null,
        supplyRiskWarehouseCount: countryMetric?.supplyRiskWarehouseCount ?? 0,
        directionCode,
        availabilityStatus: countryMetric ? "available" : "degraded",
        qualityStatus: countryMetric ? countryMetric.qualityStatus : "degraded",
        reasonCode: countryMetric ? "METRIC_AVAILABLE" : "COUNTRY_MAPPING_UNAVAILABLE",
        metricsVersion: input.metricsVersion,
        evidence: {
          inventoryBatchId: input.inventoryBatchId,
          orderWatermarkAt: input.orderWatermarkAt,
          ownSalesWindowDays: [7, 28],
          ownSalesQuantityPrevious7d: own.quantityPrevious7,
          validOrderCountPrevious7d: own.ordersPrevious7.size,
          sourceVisibleSales28d: countryMetric?.sourceVisibleSales28d ?? null,
          sourcePredictedDailySales: countryMetric?.sourcePredictedDailySales ?? null,
          forecastPercentile: countryMetric?.forecastPercentile ?? null,
          forecastRank: countryMetric?.forecastRank ?? null,
          supplyRiskWarehouseCount: countryMetric?.supplyRiskWarehouseCount ?? 0,
          ownCaptureRatio28d: ratio,
          directionCode,
          shopCountryCode: shop.country_code,
          countryMappingAvailable: Boolean(countryMetric),
        },
        calculatedAt: input.calculatedAt,
      });
    }

    assignShopSalesPercentiles(items);
    assignShopRatioPercentiles(items, input.minimumComparisonSize);
    for (const item of items) {
      item.keyPerformer = item.ownSalesQuantity28d > 0
        && item.ownSalesQuantity7d > 0
        && item.shopSalesPercentile28d !== null
        && item.shopSalesPercentile28d >= 0.8;
      item.growthFocusCandidate = item.directionCode === "QUIET_ENTRY"
        || item.directionCode === "PRIORITY_GROWTH";
      item.evidence = {
        ...item.evidence,
        ownSalesQuantity7d: item.ownSalesQuantity7d,
        ownSalesQuantity28d: item.ownSalesQuantity28d,
        shopSalesPercentile28d: item.shopSalesPercentile28d,
        shopToSourceVisibleRatio28d: item.shopToSourceVisibleRatio28d,
        shopToSourceVisibleRatioPercentile28d: item.shopToSourceVisibleRatioPercentile28d,
        ownCaptureRatio28d: item.ownCaptureRatio28d,
        directionCode: item.directionCode,
      };
      if (item.keyPerformer) {
        signals.push(signal({
          signalType: "highlight",
          ruleCode: "STORE_KEY_PERFORMER",
          ruleVersion: input.metricsVersion,
          subjectType: "shop_sku",
          countryCode: countryConfirmed ? shop.country_code : null,
          sku: item.sku,
          shopId: shop.id,
          severity: "information",
          reasonCode: "SHOP_SALES_PERCENTILE_P80",
          recommendedActionCode: "monitor",
          availabilityStatus: "available",
          qualityStatus: "confirmed",
          evidence: item.evidence,
          detectedAt: input.calculatedAt,
        }));
      }
      if (item.growthFocusCandidate) {
        const noSales = item.ownSalesQuantity28d === 0;
        signals.push(signal({
          signalType: "opportunity",
          ruleCode: "STORE_GROWTH_FOCUS_SKU",
          ruleVersion: input.metricsVersion,
          subjectType: "shop_sku",
          countryCode: shop.country_code,
          sku: item.sku,
          shopId: shop.id,
          severity: "warning",
          reasonCode: noSales ? "NO_RECENT_SALES" : "LOW_RELATIVE_SALES",
          recommendedActionCode: "review_store_promotion",
          evidence: item.evidence,
          detectedAt: input.calculatedAt,
        }));
        if (noSales) {
          signals.push(signal({
            signalType: "opportunity",
            ruleCode: "STORE_HIGH_SKU_SALES_GAP",
            ruleVersion: input.metricsVersion,
            subjectType: "shop_sku",
            countryCode: shop.country_code,
            sku: item.sku,
            shopId: shop.id,
            severity: "warning",
            reasonCode: "NO_RECENT_SALES",
            recommendedActionCode: "review_store_promotion",
            evidence: item.evidence,
            detectedAt: input.calculatedAt,
          }));
        }
      }
      if (item.directionCode) {
        signals.push(directionSignal(item.directionCode, {
          ruleVersion: input.metricsVersion,
          subjectType: "shop_sku",
          countryCode: shop.country_code,
          sku: item.sku,
          shopId: shop.id,
          availabilityStatus: item.availabilityStatus,
          qualityStatus: item.qualityStatus,
          evidence: item.evidence,
          detectedAt: input.calculatedAt,
        }));
      }
    }

    const soldEligible = eligible.filter((metric) => (shopSales.get(metric.sku)?.quantity28 || 0) > 0);
    const soldHigh = highPerformance.filter((metric) => (shopSales.get(metric.sku)?.quantity28 || 0) > 0);
    const eligibleSkus = new Set(eligible.map((metric) => metric.sku));
    const applicableCountrySignals = (countrySignals.get(shop.country_code) || [])
      .filter((entry) => eligibleSkus.has(entry.sku));
    const crossSourceAvailable = countryConfirmed && countryMetrics.length > 0;
    shopMetrics.push({
      analysisDate: input.analysisDate,
      shopId: shop.id,
      displayName: shop.display_name,
      platform: shop.platform,
      ownerUserId: shop.owner_user_id || null,
      countryCode: shop.country_code || "ZZ",
        ownSalesQuantity7d: [...shopSales.values()].reduce((sum, value) => sum + value.quantity7, 0),
        ownSalesQuantity28d: [...shopSales.values()].reduce((sum, value) => sum + value.quantity28, 0),
      validOrderCount7d: new Set(input.orderRows
        .filter((row) => row.internal_shop_id === shop.id && inWindow(row.paid_at, windowBounds(input.analysisDate, 7)))
        .map((row) => row.order_header_id)).size,
      validOrderCount28d: new Set(input.orderRows
        .filter((row) => row.internal_shop_id === shop.id && inWindow(row.paid_at, windowBounds(input.analysisDate, 28)))
        .map((row) => row.order_header_id)).size,
      eligibleSaleableSkuCount: crossSourceAvailable ? eligible.length : null,
      soldEligibleSkuCount28d: crossSourceAvailable ? soldEligible.length : null,
      saleableCoverageRate28d: crossSourceAvailable && eligible.length ? soldEligible.length / eligible.length : null,
      eligibleHighPerformanceSkuCount: crossSourceAvailable ? highPerformance.length : null,
      soldHighPerformanceSkuCount28d: crossSourceAvailable ? soldHigh.length : null,
      highPerformanceCoverageRate28d: crossSourceAvailable && highPerformance.length
        ? soldHigh.length / highPerformance.length
        : null,
      keyPerformerCount: items.filter((item) => item.keyPerformer).length,
      growthFocusCount: items.filter((item) => item.growthFocusCandidate).length,
      newOpportunityCount: applicableCountrySignals
        .filter((entry) => entry.ruleCode === "NEW_PRODUCT_OPPORTUNITY").length,
      slowRiskCount: applicableCountrySignals
        .filter((entry) => entry.ruleCode.startsWith("SLOW_")).length
        + eligible.filter((metric) => (
          (metric.warehouseSupplySummary?.slowWatchCount || 0)
          + (metric.warehouseSupplySummary?.slowRiskCount || 0)
          + (metric.warehouseSupplySummary?.slowSevereCount || 0)
        ) > 0).length,
      lowStockRiskCount: eligible.filter((metric) => metric.supplyRiskWarehouseCount > 0).length,
      availabilityStatus: crossSourceAvailable ? "available" : "degraded",
      qualityStatus: crossSourceAvailable ? "confirmed" : "degraded",
      reasonCode: crossSourceAvailable ? "METRIC_AVAILABLE" : "COUNTRY_MAPPING_UNAVAILABLE",
      metricsVersion: input.metricsVersion,
      countryMappingSetId: input.countryMappingSetId,
        evidence: {
          inventoryBatchId: input.inventoryBatchId,
          orderWatermarkAt: input.orderWatermarkAt,
          ownSalesQuantityPrevious7d: [...shopSales.values()]
            .reduce((sum, value) => sum + value.quantityPrevious7, 0),
          validOrderCountPrevious7d: new Set(input.orderRows
            .filter((row) => (
              row.internal_shop_id === shop.id
              && inWindow(row.paid_at, {
                start: windowBounds(input.analysisDate, 7).start - (7 * DAY_MS),
                endExclusive: windowBounds(input.analysisDate, 7).start,
              })
            ))
            .map((row) => row.order_header_id)).size,
          coverageSemantic: "historical_sales_coverage",
        countryMappingAvailable: crossSourceAvailable,
        categoryScope: scope,
      },
      calculatedAt: input.calculatedAt,
    });
    shopSkuMetrics.push(...items);
  }
  return { shopMetrics, shopSkuMetrics, signals };
}

function buildCountryDirectionSignals(input, skuLayer, shopLayer) {
  const shopsByCountry = groupsBy(
    shopLayer.shopMetrics.filter((shop) => shop.countryCode && shop.countryCode !== "ZZ"),
    (shop) => shop.countryCode,
  );
  const ownSalesByCountrySku = new Map();
  for (const item of shopLayer.shopSkuMetrics) {
    const key = `${item.countryCode}\u0000${item.sku}`;
    if (!ownSalesByCountrySku.has(key)) {
      ownSalesByCountrySku.set(key, {
        quantity28: 0,
        sellingShops: 0,
        shopCount: (shopsByCountry.get(item.countryCode) || []).length,
      });
    }
    const aggregate = ownSalesByCountrySku.get(key);
    aggregate.quantity28 += item.ownSalesQuantity28d;
    if (item.ownSalesQuantity28d > 0) aggregate.sellingShops += 1;
  }

  const signals = [];
  for (const metric of skuLayer.countryMetrics) {
    const countryShops = shopsByCountry.get(metric.countryCode) || [];
    if (!countryShops.length || !metric.sourceHighPerformance) continue;
    const own = ownSalesByCountrySku.get(`${metric.countryCode}\u0000${metric.sku}`) || {
      quantity28: 0,
      sellingShops: 0,
      shopCount: countryShops.length,
    };
    const ownCaptureRatio28d = metric.sourcePredictedDailySales > 0
      ? (own.quantity28 / 28) / metric.sourcePredictedDailySales
      : null;
    const directionCode = operationalDirection({
      sourceHighPerformance: metric.sourceHighPerformance,
      availableQuantity: metric.availableQuantity,
      supplyRiskWarehouseCount: metric.supplyRiskWarehouseCount,
      ownSalesQuantity28d: own.quantity28,
      ownCaptureRatio28d,
      lowCaptureThreshold: input.storeLowRatioPercentile,
    });
    if (!directionCode) continue;
    signals.push(directionSignal(directionCode, {
      ruleVersion: input.metricsVersion,
      subjectType: "sku",
      countryCode: metric.countryCode,
      sku: metric.sku,
      availabilityStatus: metric.availabilityStatus,
      qualityStatus: metric.qualityStatus,
      evidence: {
        ...metric.evidence,
        normalizedSourceSku: metric.sku,
        productName: metric.productName,
        productStatus: metric.productStatus,
        categoryL1: metric.categoryL1,
        categoryL2: metric.categoryL2,
        sourcePredictedDailySales: metric.sourcePredictedDailySales,
        forecastPercentile: metric.forecastPercentile,
        forecastRank: metric.forecastRank,
        supplyRiskWarehouseCount: metric.supplyRiskWarehouseCount,
        availableQuantity: metric.availableQuantity,
        inTransitQuantity: metric.inTransitQuantity,
        ownSalesQuantity28d: own.quantity28,
        ownDailySales28d: own.quantity28 / 28,
        ownCaptureRatio28d,
        confirmedShopCount: countryShops.length,
        sellingShopCount: own.sellingShops,
        directionCode,
        ownCaptureFormula: "(sum_confirmed_shop_shipped_quantity_28d / 28) / source_predicted_daily_sales",
      },
      detectedAt: input.calculatedAt,
    }));
  }
  return signals;
}

export class GrowthRadarV2Engine {
  compute(input) {
    const parameters = input.ruleSet?.parameters || {};
    const metricsVersion = input.ruleSet?.metrics_contract_version
      || parameters.metricsContractVersion
      || DEFAULT_METRICS_VERSION;
    if (metricsVersion !== DEFAULT_METRICS_VERSION) {
      const error = new Error(`Growth Radar V2 requires ${DEFAULT_METRICS_VERSION}.`);
      error.code = "GROWTH_RADAR_V2_RULE_SET_VERSION_MISMATCH";
      throw error;
    }
    const requiredNumber = (value, key) => {
      const result = numberOrNull(value);
      if (result === null) {
        const error = new Error(`Growth Radar V2 rule configuration is missing ${key}.`);
        error.code = "GROWTH_RADAR_V2_RULE_CONFIG_INCOMPLETE";
        throw error;
      }
      return result;
    };
    const thresholds = parameters.thresholds || {};
    const prepared = {
      ...input,
      metricsVersion,
      assortmentHighPercentile: requiredNumber(
        thresholds.assortment?.highPercentile,
        "thresholds.assortment.highPercentile",
      ),
      assortmentMidPercentile: requiredNumber(
        thresholds.assortment?.midPercentile,
        "thresholds.assortment.midPercentile",
      ),
      storeLowRatioPercentile: requiredNumber(
        thresholds.capture?.lowRatio,
        "thresholds.capture.lowRatio",
      ),
      minimumComparisonSize: requiredNumber(
        thresholds.assortment?.minimumSampleSize,
        "thresholds.assortment.minimumSampleSize",
      ),
      outOfStockDays: requiredNumber(
        thresholds.supply?.outOfStockDays,
        "thresholds.supply.outOfStockDays",
      ),
      supplyCriticalDays: requiredNumber(
        thresholds.supply?.criticalDays,
        "thresholds.supply.criticalDays",
      ),
      supplyWarningDays: requiredNumber(
        thresholds.supply?.warningDays,
        "thresholds.supply.warningDays",
      ),
      slowWatchDays: requiredNumber(
        thresholds.slowMoving?.watchDays,
        "thresholds.slowMoving.watchDays",
      ),
      slowRiskDays: requiredNumber(
        thresholds.slowMoving?.riskDays,
        "thresholds.slowMoving.riskDays",
      ),
      slowSevereDays: requiredNumber(
        thresholds.slowMoving?.severeDays,
        "thresholds.slowMoving.severeDays",
      ),
      newDays: requiredNumber(
        thresholds.newProduct?.observationDays,
        "thresholds.newProduct.observationDays",
      ),
      hasCountryMappings: input.warehouseMappings.some((mapping) => mapping.mapping_status === "confirmed"),
    };
    if (!prepared.inventoryRows.length) {
      const error = new Error("No applied inventory rows are available for Growth Radar V2.");
      error.code = "GROWTH_RADAR_V2_INVENTORY_EMPTY";
      throw error;
    }
    const skuLayer = buildSkuMetrics(prepared);
    const globalSignals = buildSkuSignals(skuLayer.globalMetrics, prepared);
    const countrySignals = buildSkuSignals(skuLayer.countryMetrics, prepared);
    const warehouseSignals = buildWarehouseSignals(skuLayer.warehouseMetrics, prepared);
    const shopLayer = buildShopMetrics(prepared, skuLayer);
    const directionSignals = buildCountryDirectionSignals(prepared, skuLayer, shopLayer);
    const blockedSkuCount = skuLayer.globalMetrics.filter((metric) => metric.qualityStatus === "blocked").length;
    const blockedWarehouseSkuCount = skuLayer.warehouseMetrics
      .filter((metric) => metric.qualityStatus === "blocked").length;
    const qualityStatus = blockedSkuCount > 0
      || blockedWarehouseSkuCount > 0
      || !prepared.hasCountryMappings
      ? "degraded"
      : "confirmed";
    return {
      skuMetrics: [...skuLayer.globalMetrics, ...skuLayer.countryMetrics],
      skuWarehouseMetrics: skuLayer.warehouseMetrics,
      shopMetrics: shopLayer.shopMetrics,
      shopSkuMetrics: shopLayer.shopSkuMetrics,
      signals: [
        ...globalSignals,
        ...countrySignals,
        ...warehouseSignals,
        ...directionSignals,
        ...shopLayer.signals,
      ],
      qualityStatus,
      qualitySummary: {
        metricsVersion: prepared.metricsVersion,
        inventoryRows: prepared.inventoryRows.length,
        globalSkuCount: skuLayer.globalMetrics.length,
        countrySkuCount: skuLayer.countryMetrics.length,
        warehouseSkuCount: skuLayer.warehouseMetrics.length,
        confirmedCountryMappings: prepared.warehouseMappings
          .filter((mapping) => mapping.mapping_status === "confirmed").length,
        blockedSkuCount,
        blockedWarehouseSkuCount,
        countryAnalysisAvailable: prepared.hasCountryMappings,
        storeCrossSourceAnalysisAvailable: prepared.hasCountryMappings
          && input.shops.some((shop) => shop.country_code && shop.country_code !== "ZZ"),
      },
      counts: {
        globalSkuCount: skuLayer.globalMetrics.length,
        countrySkuCount: skuLayer.countryMetrics.length,
        warehouseSkuCount: skuLayer.warehouseMetrics.length,
        shopCount: shopLayer.shopMetrics.length,
        shopSkuCount: shopLayer.shopSkuMetrics.length,
        signalCount: globalSignals.length + countrySignals.length + warehouseSignals.length
          + directionSignals.length + shopLayer.signals.length,
      },
    };
  }
}

export const growthRadarV2Internals = Object.freeze({
  normalizedStatus,
  consistentNumber,
  percentileRanks,
  descendingRanks,
  categoryComparison,
  daysOfSupply,
  coverageFromDailyForecast,
  warehouseSupplyStatus,
  warehouseSlowMovingStatus,
  operationalDirection,
  windowBounds,
});
