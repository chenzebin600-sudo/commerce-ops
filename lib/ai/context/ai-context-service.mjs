import {
  assertAiContextSubjectId,
  assertAiContextType,
  aiContextNotFound,
  buildAiContextEnvelope,
} from "./ai-context-contracts.mjs";
import { AiContextRegistry } from "./ai-context-registry.mjs";

const ENTITY_CONTEXT_TYPES = Object.freeze(["shop", "product", "sku"]);

const ENTITY_INPUT_SCHEMA = Object.freeze({
  type: "object",
  required: ["subjectId"],
  additionalProperties: false,
  properties: { subjectId: { type: "string", minLength: 1, maxLength: 200 } },
});

const METRIC_INPUT_SCHEMA = Object.freeze({
  type: "object",
  required: ["subjectType", "subjectId"],
  additionalProperties: false,
  properties: {
    subjectType: { enum: ENTITY_CONTEXT_TYPES },
    subjectId: { type: "string", minLength: 1, maxLength: 200 },
  },
});

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function json(value, fallback = {}) {
  if (value && typeof value === "object") return value;
  try { return JSON.parse(value || ""); } catch { return fallback; }
}

function addDays(day, amount) {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function sum(rows, key) {
  return rows.reduce((total, row) => total + number(row[key]), 0);
}

function normalizeSignals(rows) {
  return rows.map((row) => ({
    id: row.id,
    type: row.signal_type,
    severity: row.severity,
    ruleCode: row.rule_code,
    ruleVersion: row.rule_version,
    reasonCode: row.reason_code,
    recommendedActionCode: row.recommended_action_code,
    countryCode: row.country_code || null,
    warehouse: row.source_warehouse_name || null,
    sku: row.normalized_source_sku || null,
    evidence: json(row.evidence_json),
    detectedAt: row.detected_at,
  }));
}

function normalizeTasks(groups) {
  const foundation = Array.isArray(groups) ? groups : groups?.foundation || [];
  const growth = Array.isArray(groups) ? [] : groups?.growth || [];
  return [
    ...foundation.map((row) => ({
      id: row.id,
      source: "foundation",
      type: row.task_kind,
      status: row.state,
      priority: row.priority,
      evidence: json(row.evidence_json),
      updatedAt: row.updated_at,
    })),
    ...growth.map((row) => ({
      id: row.id,
      source: "growth_radar",
      type: row.task_type,
      status: row.status,
      priority: row.priority,
      reasonCode: row.reason_code,
      recommendedActionCode: row.recommended_action_code,
      evidence: json(row.evidence_json ?? row.evidence_snapshot_json),
      updatedAt: row.updated_at,
    })),
  ];
}

function freshnessPayload(value) {
  return {
    order: value.sourceBatches.find((row) => row.source_type === "mabang_order") || null,
    inventory: value.sourceBatches.find((row) => row.source_type === "mabang_inventory") || null,
    publishedAnalysis: value.publishedAnalysis || null,
  };
}

function recentTotals(rows, latestDay) {
  if (!latestDay) return { latestDay: null, current7d: 0, previous7d: 0, current28d: 0 };
  const current7Start = addDays(latestDay, -6);
  const previous7Start = addDays(latestDay, -13);
  const previous7End = addDays(latestDay, -7);
  const current28Start = addDays(latestDay, -27);
  const value = (row) => number(row.sales_quantity);
  return {
    latestDay,
    current7d: rows.filter((row) => row.day >= current7Start && row.day <= latestDay).reduce((a, row) => a + value(row), 0),
    previous7d: rows.filter((row) => row.day >= previous7Start && row.day <= previous7End).reduce((a, row) => a + value(row), 0),
    current28d: rows.filter((row) => row.day >= current28Start && row.day <= latestDay).reduce((a, row) => a + value(row), 0),
    windows: {
      current7d: { from: current7Start, to: latestDay },
      previous7d: { from: previous7Start, to: previous7End },
    },
  };
}

function listingRows(rows) {
  return rows.map((row) => ({
    id: row.id,
    skuId: row.product_sku_id,
    platform: row.platform,
    country: row.country,
    shopId: row.shop_id || null,
    shopName: row.shop_name || null,
    status: row.status,
    pricing: json(row.pricing_json),
    revision: number(row.revision),
    updatedAt: row.updated_at,
  }));
}

export class AiContextService {
  constructor({ repository, now = () => new Date(), registry = new AiContextRegistry() }) {
    if (!repository) throw new TypeError("AI context repository is required");
    this.repository = repository;
    this.now = now;
    this.registry = registry;
    this.registerDefaults();
  }

  registerDefaults() {
    const register = (definition) => {
      if (!this.registry.get(definition.type)) this.registry.register(definition);
    };
    register({
      type: "shop",
      version: "1.0.0",
      description: "Shop profile, sales, inventory, risks, and open tasks from structured facts.",
      inputSchema: ENTITY_INPUT_SCHEMA,
      resolve: ({ subjectId }) => this.shop(assertAiContextSubjectId(subjectId)),
    });
    register({
      type: "product",
      version: "1.0.0",
      description: "Product profile, SKU, sales, inventory, listing, risk, and task context.",
      inputSchema: ENTITY_INPUT_SCHEMA,
      resolve: ({ subjectId }) => this.product(assertAiContextSubjectId(subjectId)),
    });
    register({
      type: "sku",
      version: "1.0.0",
      description: "SKU profile, sales, warehouse inventory, prices, listing, risks, and tasks.",
      inputSchema: ENTITY_INPUT_SCHEMA,
      resolve: ({ subjectId }) => this.sku(assertAiContextSubjectId(subjectId)),
    });
    register({
      type: "sales",
      version: "1.0.0",
      description: "Sales projection for one registered Shop, Product, or SKU context.",
      inputSchema: METRIC_INPUT_SCHEMA,
      resolve: (input) => this.metricProjection("sales", input),
    });
    register({
      type: "inventory",
      version: "1.0.0",
      description: "Inventory projection for one registered Shop, Product, or SKU context.",
      inputSchema: METRIC_INPUT_SCHEMA,
      resolve: (input) => this.metricProjection("inventory", input),
    });
  }

  async get(typeValue, subjectValue, options = {}) {
    const type = assertAiContextType(typeValue);
    const id = assertAiContextSubjectId(subjectValue);
    if (type === "daily_report") throw Object.assign(
      new Error("Daily report context is created by the scheduled report runtime."),
      { code: "AI_CONTEXT_RUNTIME_ONLY", contextType: type, subjectId: id },
    );
    return this.registry.resolve(type, type === "sales" || type === "inventory"
      ? { subjectType: options.subjectType, subjectId: id }
      : { subjectId: id });
  }

  list() {
    return this.registry.list();
  }

  async metricProjection(type, input) {
    const subjectType = String(input.subjectType || "").trim().toLowerCase();
    if (!ENTITY_CONTEXT_TYPES.includes(subjectType)) {
      throw Object.assign(new TypeError("Metric context subject type is invalid"), {
        code: "AI_CONTEXT_SUBJECT_TYPE_INVALID",
      });
    }
    const subjectId = assertAiContextSubjectId(input.subjectId);
    const base = await this.registry.resolve(subjectType, { subjectId });
    return buildAiContextEnvelope({
      type,
      id: subjectId,
      generatedAt: this.now(),
      freshness: base.freshness,
      quality: base.quality,
      data: {
        scope: { type: subjectType, id: subjectId },
        metrics: base.data[type] || {},
      },
    });
  }

  async shop(id) {
    const [master, freshness, publishedMetric, publishedHistory, latestOrderDay, signals, tasks] = await Promise.all([
      this.repository.shopMaster(id),
      this.repository.freshness(),
      this.repository.shopPublishedMetric(id),
      this.repository.shopPublishedHistory(id),
      this.repository.latestValidOrderDay(),
      this.repository.shopSignals(id),
      this.repository.shopTasks(id),
    ]);
    if (!master) throw aiContextNotFound("shop", id);
    const factFrom = latestOrderDay ? addDays(latestOrderDay, -27) : "0000-01-01";
    const [factTrend, factInventory] = await Promise.all([
      this.repository.shopFactTrend(id, factFrom),
      this.repository.shopFactInventory(id),
    ]);
    const published = Boolean(publishedMetric);
    const limitations = [];
    if (!published) limitations.push("NO_PUBLISHED_ANALYSIS_USING_STRUCTURED_FACTS");
    if (!signals.length) limitations.push("NO_PUBLISHED_RISK_SIGNALS");
    const factTotals = recentTotals(factTrend, latestOrderDay);
    const sales = published ? {
      current7d: number(publishedMetric.own_sales_quantity_7d),
      current28d: number(publishedMetric.own_sales_quantity_28d),
      orderCount7d: number(publishedMetric.valid_order_count_7d),
      orderCount28d: number(publishedMetric.valid_order_count_28d),
      saleableCoverageRate28d: nullableNumber(publishedMetric.saleable_coverage_rate_28d),
      highPerformanceCoverageRate28d: nullableNumber(publishedMetric.high_performance_coverage_rate_28d),
      history: publishedHistory,
    } : { ...factTotals, history: factTrend };
    const inventory = published ? {
      lowStockRiskCount: number(publishedMetric.low_stock_risk_count),
      slowRiskCount: number(publishedMetric.slow_risk_count),
      eligibleSaleableSkuCount: nullableNumber(publishedMetric.eligible_saleable_sku_count),
    } : {
      skuCount: number(factInventory?.sku_count),
      availableQuantity: number(factInventory?.available_quantity),
      inTransitQuantity: number(factInventory?.in_transit_quantity),
      minimumDaysOfSupply: nullableNumber(factInventory?.minimum_days_of_supply),
      outOfStockRows: number(factInventory?.out_of_stock_rows),
    };
    return buildAiContextEnvelope({
      type: "shop",
      id,
      generatedAt: this.now(),
      freshness: freshnessPayload(freshness),
      quality: { status: published ? publishedMetric.quality_status : "degraded", evidenceSource: published ? "published_analysis" : "structured_facts", limitations },
      data: {
        profile: {
          id: master.id,
          code: master.internal_shop_code,
          name: master.display_name,
          platform: master.platform,
          countryCode: master.country_code,
          countryName: master.country_name,
          ownerId: master.owner_user_id || null,
          status: master.status,
        },
        sales,
        inventory,
        risks: normalizeSignals(signals),
        currentTasks: normalizeTasks(tasks),
      },
    });
  }

  async product(id) {
    const [master, skus, freshness, publishedMetrics, latestOrderDay, inventoryRows, listings, signals, tasks] = await Promise.all([
      this.repository.productMaster(id),
      this.repository.productSkus(id),
      this.repository.freshness(),
      this.repository.productPublishedMetrics(id),
      this.repository.latestValidOrderDay(),
      this.repository.productFactInventory(id),
      this.repository.productListings(id),
      this.repository.productSignals(id),
      this.repository.productTasks(id),
    ]);
    if (!master) throw aiContextNotFound("product", id);
    const factSales = await this.repository.productFactSales(id, latestOrderDay ? addDays(latestOrderDay, -27) : "0000-01-01");
    const published = publishedMetrics.length > 0;
    const limitations = [];
    if (!published) limitations.push("NO_PUBLISHED_ANALYSIS_USING_STRUCTURED_FACTS");
    if (!signals.length) limitations.push("NO_PUBLISHED_RISK_SIGNALS");
    return buildAiContextEnvelope({
      type: "product",
      id,
      generatedAt: this.now(),
      freshness: freshnessPayload(freshness),
      quality: { status: published ? "available" : "degraded", evidenceSource: published ? "published_analysis" : "structured_facts", limitations },
      data: {
        profile: {
          id: master.id,
          mainSku: master.source_main_sku,
          name: master.canonical_name,
          categoryId: master.category_id || null,
          identityStatus: master.identity_status,
          lifecycleStatus: master.inactive_at ? "inactive" : "active",
        },
        skus: skus.map((row) => ({ id: row.id, sku: row.source_sku, normalizedSku: row.normalized_sku, status: row.lifecycle_status, salesSpec: row.source_sales_spec || null })),
        sales: published ? { source: "published_analysis", metrics: publishedMetrics } : { source: "structured_facts", ...recentTotals(factSales, latestOrderDay), history: factSales },
        inventory: {
          availableQuantity: sum(inventoryRows, "available_quantity"),
          inTransitQuantity: sum(inventoryRows, "in_transit_quantity"),
          warehouses: inventoryRows.map((row) => ({ sku: row.source_sku, warehouse: row.warehouse_name, availableQuantity: nullableNumber(row.available_quantity), inTransitQuantity: nullableNumber(row.in_transit_quantity), daysOfSupply: nullableNumber(row.days_of_supply) })),
        },
        listingStatus: listingRows(listings),
        risks: normalizeSignals(signals),
        currentTasks: normalizeTasks(tasks),
      },
    });
  }

  async sku(id) {
    const [master, freshness, publishedMetrics, warehouseMetrics, latestOrderDay, inventoryRows, listings, prices, signals, tasks] = await Promise.all([
      this.repository.skuMaster(id),
      this.repository.freshness(),
      this.repository.skuPublishedMetrics(id),
      this.repository.skuPublishedWarehouseMetrics(id),
      this.repository.latestValidOrderDay(),
      this.repository.skuFactInventory(id),
      this.repository.skuListings(id),
      this.repository.skuPriceHistory(id),
      this.repository.skuSignals(id),
      this.repository.skuTasks(id),
    ]);
    if (!master) throw aiContextNotFound("sku", id);
    const factSales = await this.repository.skuFactSales(id, latestOrderDay ? addDays(latestOrderDay, -27) : "0000-01-01");
    const published = publishedMetrics.length > 0;
    const supplyRows = warehouseMetrics.length ? warehouseMetrics : inventoryRows;
    const limitations = [];
    if (!published) limitations.push("NO_PUBLISHED_ANALYSIS_USING_STRUCTURED_FACTS");
    if (!signals.length) limitations.push("NO_PUBLISHED_RISK_SIGNALS");
    return buildAiContextEnvelope({
      type: "sku",
      id,
      generatedAt: this.now(),
      freshness: freshnessPayload(freshness),
      quality: { status: published ? "available" : "degraded", evidenceSource: published ? "published_analysis" : "structured_facts", limitations },
      data: {
        profile: {
          id: master.id,
          sku: master.source_sku,
          normalizedSku: master.normalized_sku,
          productId: master.model_id,
          productName: master.source_product_name,
          mainSku: master.source_main_sku || null,
          styleName: master.source_style_name || null,
          salesSpec: master.source_sales_spec || null,
          lifecycleStatus: master.lifecycle_status,
        },
        sales: published ? { source: "published_analysis", metrics: publishedMetrics } : { source: "structured_facts", ...recentTotals(factSales, latestOrderDay), history: factSales },
        inventory: {
          availableQuantity: sum(supplyRows, "available_quantity"),
          inTransitQuantity: sum(supplyRows, "in_transit_quantity"),
          minimumDaysOfSupply: supplyRows.map((row) => nullableNumber(row.source_current_sellable_days ?? row.days_of_supply)).filter((value) => value !== null).sort((a, b) => a - b)[0] ?? null,
          warehouses: supplyRows.map((row) => ({
            countryCode: row.country_code || null,
            warehouse: row.source_warehouse_name || row.warehouse_name || null,
            availableQuantity: nullableNumber(row.available_quantity),
            inTransitQuantity: nullableNumber(row.in_transit_quantity),
            daysOfSupply: nullableNumber(row.source_current_sellable_days ?? row.days_of_supply),
            supplyStatus: row.supply_status || null,
          })),
        },
        priceChanges: prices.map((row) => ({
          country: row.country_raw || null,
          standardPriceTier45: nullableNumber(row.price_tier_45),
          costCny: nullableNumber(row.cost_cny),
          exchangeRate: nullableNumber(row.exchange_rate),
          capturedAt: row.created_at,
          source: "product_cost_snapshot",
        })),
        listingStatus: listingRows(listings),
        risks: normalizeSignals(signals),
        currentTasks: normalizeTasks(tasks),
      },
    });
  }
}
