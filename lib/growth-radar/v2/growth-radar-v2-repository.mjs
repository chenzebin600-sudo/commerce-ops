import { randomUUID } from "node:crypto";
import { DATABASE_DIALECTS, assertDatabaseProvider } from "../../data/database-provider.mjs";

function parseJson(value, fallback = {}) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function int(value) {
  const result = finite(value);
  return result === null ? 0 : Math.trunc(result);
}

function bool(value) {
  return Number(value) === 1;
}

const FORMAL_VALID_ORDER_STATUSES = Object.freeze([
  "已发货",
  "待处理",
  "配货中",
  "已完成",
]);

function runRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    analysisDate: row.analysis_date,
    inventoryBatchId: row.inventory_batch_id,
    orderWatermarkAt: row.order_watermark_at,
    ruleSetId: row.rule_set_id,
    countryMappingSetId: row.country_mapping_set_id,
    shopScopeFingerprint: row.shop_scope_fingerprint,
    inputFingerprint: row.input_fingerprint,
    status: row.status,
    qualityStatus: row.quality_status,
    qualitySummary: parseJson(row.quality_summary_json, {}),
    globalSkuCount: int(row.global_sku_count),
    countrySkuCount: int(row.country_sku_count),
    shopCount: int(row.shop_count),
    shopSkuCount: int(row.shop_sku_count),
    signalCount: int(row.signal_count),
    startedAt: row.started_at || null,
    validatedAt: row.validated_at || null,
    publishedAt: row.published_at || null,
    finishedAt: row.finished_at || null,
    errorCode: row.error_code || null,
    errorSummary: row.error_summary || null,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function skuMetricRow(row) {
  if (!row) return null;
  const evidence = parseJson(row.evidence_json, {});
  return {
    id: row.id,
    analysisRunId: row.analysis_run_id,
    analysisDate: row.analysis_date,
    scopeType: row.scope_type,
    scopeKey: row.scope_key,
    countryCode: row.country_code || null,
    sku: row.normalized_source_sku,
    sourceSku: row.source_sku,
    productName: row.product_name || null,
    productStatus: row.product_status,
    categoryL1: row.category_l1 || null,
    categoryL2: row.category_l2 || null,
    mappedProductId: row.mapped_product_id || null,
    mappingStatus: row.mapping_status,
    warehouseCount: int(row.warehouse_count),
    availableQuantity: finite(row.available_quantity),
    inTransitQuantity: finite(row.in_transit_quantity),
    sourceVisibleSales7d: finite(row.source_visible_sales_7d),
    sourceVisibleSales28d: finite(row.source_visible_sales_28d),
    sourceVisibleSales42d: finite(row.source_visible_sales_42d),
    sourcePredictedDailySales: finite(row.source_predicted_daily_sales_country_sku)
      ?? finite(evidence.sourcePredictedDailySales),
    forecastPercentile: finite(row.assortment_percentile)
      ?? finite(evidence.forecastPercentile),
    forecastRank: (evidence.assortmentRank ?? evidence.forecastRank) === null
      || (evidence.assortmentRank ?? evidence.forecastRank) === undefined
      ? null : int(evidence.assortmentRank ?? evidence.forecastRank),
    forecastCoverageDays: finite(evidence.forecastCoverageDays),
    forecastComparisonScope: evidence.assortmentComparisonScope
      || evidence.forecastComparisonScope
      || null,
    forecastComparisonSampleSize:
      (evidence.assortmentComparisonSampleSize ?? evidence.forecastComparisonSampleSize) === null
      || (evidence.assortmentComparisonSampleSize ?? evidence.forecastComparisonSampleSize) === undefined
        ? null
        : int(evidence.assortmentComparisonSampleSize ?? evidence.forecastComparisonSampleSize),
    effectiveDailySales28d: finite(row.effective_daily_sales_28d),
    computedDaysOfSupply: finite(row.computed_days_of_supply),
    daysOfSupplyStatus: row.days_of_supply_status,
    demandPercentile28d: finite(row.demand_percentile_28d),
    assortmentPercentile: finite(row.assortment_percentile),
    assortmentStatus: row.assortment_status || null,
    inventoryPercentile: finite(row.inventory_percentile),
    comparisonScope: row.comparison_scope || null,
    comparisonSampleSize: row.comparison_sample_size === null ? null : int(row.comparison_sample_size),
    warehouseSupplySummary: parseJson(row.warehouse_supply_summary_json, {}),
    supplyRiskWarehouseCount: int(row.supply_risk_warehouse_count),
    supplyCriticalWarehouseCount: int(row.supply_critical_warehouse_count),
    supplyWarningWarehouseCount: int(row.supply_warning_warehouse_count),
    supplyDataIssueWarehouseCount: int(row.supply_data_issue_warehouse_count),
    sourceHighPerformance: row.assortment_status
      ? row.assortment_status === "ASSORTMENT_VERIFIED_HIGH"
      : bool(row.is_source_high_performance),
    isNew: bool(row.is_new),
    newAgeDays: row.new_age_days === null ? null : int(row.new_age_days),
    availabilityStatus: row.availability_status,
    qualityStatus: row.quality_status,
    reasonCode: row.reason_code,
    metricsVersion: row.metrics_version,
    evidence,
    calculatedAt: row.calculated_at,
  };
}

function skuWarehouseMetricRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    analysisRunId: row.analysis_run_id,
    analysisDate: row.analysis_date,
    countryCode: row.country_code,
    sourceWarehouseName: row.source_warehouse_name,
    normalizedWarehouseName: row.normalized_warehouse_name,
    sku: row.normalized_source_sku,
    sourceSku: row.source_sku,
    productName: row.product_name || null,
    productStatus: row.product_status,
    categoryL1: row.category_l1 || null,
    categoryL2: row.category_l2 || null,
    mappedProductId: row.mapped_product_id || null,
    mappingStatus: row.mapping_status,
    availableQuantity: finite(row.available_quantity),
    inTransitQuantity: finite(row.in_transit_quantity),
    sourceCurrentSellableDays: finite(row.source_current_sellable_days),
    sourcePredictedDailySales: finite(row.source_predicted_daily_sales),
    sourceVisibleSales7d: finite(row.source_visible_sales_7d),
    sourceVisibleSales28d: finite(row.source_visible_sales_28d),
    sourceVisibleSales42d: finite(row.source_visible_sales_42d),
    supplyStatus: row.supply_status,
    slowMovingStatus: row.slow_moving_status,
    availabilityStatus: row.availability_status,
    qualityStatus: row.quality_status,
    reasonCode: row.reason_code,
    metricsVersion: row.metrics_version,
    evidence: parseJson(row.evidence_json, {}),
    calculatedAt: row.calculated_at,
  };
}

function shopMetricRow(row) {
  if (!row) return null;
  const evidence = parseJson(row.evidence_json, {});
  return {
    id: row.id,
    analysisRunId: row.analysis_run_id,
    analysisDate: row.analysis_date,
    shopId: row.internal_shop_id,
    displayName: row.display_name,
    platform: row.platform,
    ownerUserId: row.owner_user_id || null,
    countryCode: row.country_code,
    ownSalesQuantity7d: finite(row.own_sales_quantity_7d) ?? 0,
    ownSalesQuantityPrevious7d: finite(evidence.ownSalesQuantityPrevious7d) ?? 0,
    ownSalesQuantity28d: finite(row.own_sales_quantity_28d) ?? 0,
    validOrderCount7d: int(row.valid_order_count_7d),
    validOrderCount28d: int(row.valid_order_count_28d),
    eligibleSaleableSkuCount: row.eligible_saleable_sku_count === null ? null : int(row.eligible_saleable_sku_count),
    soldEligibleSkuCount28d: row.sold_eligible_sku_count_28d === null ? null : int(row.sold_eligible_sku_count_28d),
    saleableCoverageRate28d: finite(row.saleable_coverage_rate_28d),
    eligibleHighPerformanceSkuCount: row.eligible_high_performance_sku_count === null
      ? null : int(row.eligible_high_performance_sku_count),
    soldHighPerformanceSkuCount28d: row.sold_high_performance_sku_count_28d === null
      ? null : int(row.sold_high_performance_sku_count_28d),
    highPerformanceCoverageRate28d: finite(row.high_performance_coverage_rate_28d),
    keyPerformerCount: int(row.key_performer_count),
    growthFocusCount: int(row.growth_focus_count),
    newOpportunityCount: int(row.new_opportunity_count),
    slowRiskCount: int(row.slow_risk_count),
    lowStockRiskCount: int(row.low_stock_risk_count),
    availabilityStatus: row.availability_status,
    qualityStatus: row.quality_status,
    reasonCode: row.reason_code,
    metricsVersion: row.metrics_version,
    evidence,
    calculatedAt: row.calculated_at,
  };
}

function shopSkuMetricRow(row) {
  if (!row) return null;
  const evidence = parseJson(row.evidence_json, {});
  return {
    id: row.id,
    analysisRunId: row.analysis_run_id,
    analysisDate: row.analysis_date,
    shopId: row.internal_shop_id,
    countryCode: row.country_code,
    sku: row.normalized_source_sku,
    sourceSku: row.source_sku,
    productName: row.product_name || null,
    categoryL1: row.category_l1 || null,
    categoryL2: row.category_l2 || null,
    mappedProductId: row.mapped_product_id || null,
    ownSalesQuantity7d: finite(row.own_sales_quantity_7d) ?? 0,
    ownSalesQuantityPrevious7d: finite(evidence.ownSalesQuantityPrevious7d) ?? 0,
    ownSalesQuantity28d: finite(row.own_sales_quantity_28d) ?? 0,
    validOrderCount7d: int(row.valid_order_count_7d),
    validOrderCount28d: int(row.valid_order_count_28d),
    lastSoldAt: row.last_sold_at || null,
    sourceVisibleSales7d: finite(row.source_visible_sales_7d),
    sourceVisibleSales28d: finite(row.source_visible_sales_28d),
    sourceVisibleSales42d: finite(row.source_visible_sales_42d),
    sourcePredictedDailySales: finite(evidence.sourcePredictedDailySales),
    forecastPercentile: finite(evidence.forecastPercentile),
    forecastRank: evidence.forecastRank === null || evidence.forecastRank === undefined
      ? null : int(evidence.forecastRank),
    forecastCoverageDays: finite(evidence.forecastCoverageDays),
    shopToSourceVisibleRatio28d: finite(row.shop_to_source_visible_ratio_28d),
    ownCaptureRatio28d: finite(evidence.ownCaptureRatio28d),
    shopToSourceVisibleRatioPercentile28d: finite(row.shop_to_source_visible_ratio_percentile_28d),
    shopSalesPercentile28d: finite(row.shop_sales_percentile_28d),
    eligibleSaleable: bool(row.eligible_saleable),
    eligibleHighPerformance: bool(row.eligible_high_performance),
    keyPerformer: bool(row.is_key_performer),
    growthFocusCandidate: bool(row.is_growth_focus_candidate),
    directionCode: evidence.directionCode || null,
    availableQuantity: finite(row.available_quantity),
    availabilityStatus: row.availability_status,
    qualityStatus: row.quality_status,
    reasonCode: row.reason_code,
    metricsVersion: row.metrics_version,
    evidence,
    calculatedAt: row.calculated_at,
  };
}

function signalRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    analysisRunId: row.analysis_run_id,
    dedupeKey: row.dedupe_key,
    signalType: row.signal_type,
    ruleCode: row.rule_code,
    ruleVersion: row.rule_version,
    subjectType: row.subject_type,
    countryCode: row.country_code || null,
    sourceWarehouseName: row.source_warehouse_name || null,
    normalizedWarehouseName: row.normalized_warehouse_name || null,
    sku: row.normalized_source_sku || null,
    shopId: row.internal_shop_id || null,
    severity: row.severity,
    reasonCode: row.reason_code,
    recommendedActionCode: row.recommended_action_code,
    availabilityStatus: row.availability_status,
    qualityStatus: row.quality_status,
    evidence: parseJson(row.evidence_json, {}),
    detectedAt: row.detected_at,
  };
}

const ACTIVE_FOCUS_STATUSES = Object.freeze([
  "NEW",
  "ACKNOWLEDGED",
  "IN_PROGRESS",
  "MONITORING",
  "BLOCKED",
  "REOPENED",
]);

function focusItemRow(row) {
  if (!row) return null;
  const snapshot = parseJson(row.evidence_snapshot_json, {});
  return {
    ...snapshot,
    id: row.id,
    taskKey: row.task_key,
    type: row.task_type,
    persisted: true,
    revision: int(row.revision),
    status: row.status,
    priority: row.priority,
    managerId: row.owner_user_id || null,
    storeId: row.internal_shop_id || null,
    countryCode: row.country_code || null,
    sourceWarehouseName: row.source_warehouse_name || null,
    normalizedWarehouseName: row.normalized_warehouse_name || null,
    platform: row.platform || null,
    category: row.category_l2 || row.category_l1 || snapshot.category || null,
    sku: row.normalized_source_sku || null,
    reasonCode: row.reason_code,
    recommendedActionCode: row.recommended_action_code,
    firstDetectedAt: row.first_detected_at,
    lastDetectedAt: row.last_detected_at,
    consecutiveHitCount: int(row.consecutive_hit_count),
    hitInLatestRun: bool(row.is_hit_in_latest_run),
    dueAt: row.due_at || null,
    snoozedUntil: row.snoozed_until || null,
    blockedReasonCode: row.blocked_reason_code || null,
    resolutionCode: row.resolution_code || null,
    resolutionNote: row.resolution_note || null,
    resolvedAt: row.resolved_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function focusItemEventRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    focusItemId: row.focus_item_id,
    eventType: row.event_type,
    taskRevision: int(row.task_revision),
    fromStatus: row.from_status || null,
    toStatus: row.to_status,
    actorUserId: row.actor_user_id,
    actorType: row.actor_type,
    reasonCode: row.reason_code || null,
    note: row.note || null,
    signalId: row.signal_id || null,
    analysisRunId: row.analysis_run_id || null,
    evidence: parseJson(row.evidence_snapshot_json, {}),
    idempotencyKey: row.idempotency_key,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
  };
}

function focusRecommendedActionCode(candidate) {
  return ({
    DATA_BLOCKED: "RESOLVE_DATA_CONFIGURATION",
    STORE_WATCH: "VERIFY_STORE_FACTS",
    INVENTORY_RISK: "REVIEW_SUPPLY_PLAN",
    GROWTH_OPPORTUNITY: "RUN_LOW_RISK_GROWTH_TEST",
    BLUE_OCEAN: "VERIFY_ONLINE_THEN_LOW_RISK_TEST",
    CROSS_COUNTRY_CANDIDATE: "VERIFY_ONLINE_THEN_LOW_RISK_TEST",
  })[candidate.type] || "REVIEW_EVIDENCE";
}

function focusSubjectType(candidate) {
  if (candidate.type === "DATA_BLOCKED") return "data_configuration";
  if (candidate.normalizedWarehouseName && candidate.sku) return "warehouse_sku";
  if (candidate.storeId && candidate.sku) return "shop_sku";
  if (candidate.storeId && candidate.category) return "shop_category";
  if (candidate.storeId) return "shop";
  if (candidate.sku) return "sku";
  if (candidate.countryCode && candidate.category) return "country_category";
  return "data_configuration";
}

const DIRECTION_RULE_CODES = Object.freeze([
  "QUIET_ENTRY_OPPORTUNITY",
  "PRIORITY_GROWTH_DIRECTION",
  "DEFEND_WINNER_DIRECTION",
  "SUPPLY_CONSTRAINED_DIRECTION",
  "STORE_QUIET_ENTRY",
  "STORE_PRIORITY_GROWTH",
  "STORE_DEFEND_WINNER",
  "STORE_SUPPLY_CONSTRAINED",
]);

function directionCodeFromSignal(entry) {
  if (entry.evidence?.directionCode) return entry.evidence.directionCode;
  if (entry.ruleCode.includes("QUIET_ENTRY")) return "QUIET_ENTRY";
  if (entry.ruleCode.includes("PRIORITY_GROWTH")) return "PRIORITY_GROWTH";
  if (entry.ruleCode.includes("DEFEND_WINNER")) return "DEFEND_WINNER";
  if (entry.ruleCode.includes("SUPPLY_CONSTRAINED")) return "SUPPLY_CONSTRAINED";
  return null;
}

function categoryName(metric) {
  return metric.categoryL2 || metric.categoryL1 || "未分类";
}

function directionPriority(code) {
  return ({
    QUIET_ENTRY: 4,
    PRIORITY_GROWTH: 3,
    SUPPLY_CONSTRAINED: 2,
    DEFEND_WINNER: 1,
  })[code] || 0;
}

function warehouseRiskPriority(metric) {
  const supply = ({
    SUPPLY_DATA_CONFLICT: 7,
    OUT_OF_STOCK: 6,
    SUPPLY_CRITICAL: 5,
    IN_TRANSIT_ONLY: 4,
    SUPPLY_WARNING: 3,
    SUPPLY_DATA_INSUFFICIENT: 2,
    SUPPLY_HEALTHY: 0,
  })[metric.supplyStatus] || 0;
  const slow = ({
    SLOW_MOVING_SEVERE: 6,
    SLOW_MOVING_RISK: 4,
    SLOW_MOVING_WATCH: 2,
  })[metric.slowMovingStatus] || 0;
  return Math.max(supply, slow);
}

function countryMappingSetRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    description: row.description,
    contentSha256: row.content_sha256,
    createdBy: row.created_by,
    createdAt: row.created_at,
    activatedBy: row.activated_by || null,
    activatedAt: row.activated_at || null,
    retiredBy: row.retired_by || null,
    retiredAt: row.retired_at || null,
  };
}

function warehouseMappingRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    mappingSetId: row.mapping_set_id,
    sourceSystem: row.source_system,
    sourceWarehouseName: row.source_warehouse_name,
    normalizedWarehouseName: row.normalized_warehouse_name,
    countryCode: row.country_code,
    countryName: row.country_name,
    mappingStatus: row.mapping_status,
    exclusionReason: row.exclusion_reason || null,
    evidence: parseJson(row.evidence_json, {}),
    confirmedBy: row.confirmed_by,
    confirmedAt: row.confirmed_at,
    createdAt: row.created_at,
  };
}

function ruleSetRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    metricsContractVersion: row.metrics_contract_version,
    parameters: parseJson(row.parameters_json, {}),
    contentSha256: row.content_sha256,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to || null,
    createdBy: row.created_by,
    createdAt: row.created_at,
    activatedBy: row.activated_by || null,
    activatedAt: row.activated_at || null,
  };
}

function pagination(filters = {}, max = 500) {
  const page = Math.max(1, Math.floor(Number(filters.page) || 1));
  const pageSize = Math.min(max, Math.max(1, Math.floor(Number(filters.pageSize) || 50)));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export class GrowthRadarV2Repository {
  constructor({ provider }) {
    this.provider = assertDatabaseProvider(provider);
    this.prefix = provider.dialect === DATABASE_DIALECTS.POSTGRESQL ? "app." : "";
  }

  table(name) {
    return `${this.prefix}${name}`;
  }

  async insert(table, columns, values, client = this.provider) {
    const placeholders = values.map((_, index) => client.placeholder(index + 1)).join(",");
    await client.execute(
      `INSERT INTO ${this.table(table)} (${columns.join(",")}) VALUES (${placeholders})`,
      values,
    );
  }

  async latestSourceBatch(sourceType, client = this.provider) {
    const row = (await client.query(`SELECT *
      FROM ${this.table("growth_source_batches")}
      WHERE source_type=${client.placeholder(1)} AND status='applied'
      ORDER BY COALESCE(collected_at,imported_at,created_at) DESC, id DESC
      LIMIT 1`, [sourceType])).rows[0];
    return row || null;
  }

  async latestInventoryBatch(client = this.provider) {
    return this.latestSourceBatch("mabang_inventory", client);
  }

  async latestOrderBatch(client = this.provider) {
    return this.latestSourceBatch("mabang_order", client);
  }

  async assistantReadiness(client = this.provider) {
    const migrationRows = (await client.query(`SELECT version
      FROM ${this.table("schema_migrations")}
      ORDER BY version`)).rows;
    const migrationVersions = migrationRows.map((row) => row.version);
    const analysisSchemaReady = migrationVersions.includes("019_growth_radar_v2_analysis.sql")
      && migrationVersions.includes("020_growth_radar_direction_contract.sql");
    const taskPersistenceReady = migrationVersions.includes("021_growth_radar_task_lifecycle.sql");
    const [inventoryBatch, orderBatch] = await Promise.all([
      this.latestInventoryBatch(client),
      this.latestOrderBatch(client),
    ]);
    const shopReadiness = (await client.query(`SELECT
        COUNT(*) AS source_shop_count,
        SUM(CASE WHEN mapping.mapping_status IN ('matched','manually_confirmed')
          AND mapping.internal_shop_id IS NOT NULL THEN 1 ELSE 0 END) AS mapped_shop_count,
        SUM(CASE WHEN mapping.mapping_status IN ('matched','manually_confirmed')
          AND shop.owner_user_id IS NOT NULL AND shop.owner_user_id<>'' THEN 1 ELSE 0 END)
          AS manager_configured_shop_count,
        SUM(CASE WHEN mapping.mapping_status IN ('matched','manually_confirmed')
          AND shop.country_code IS NOT NULL AND shop.country_code<>''
          AND shop.country_code<>'ZZ' THEN 1 ELSE 0 END) AS country_configured_shop_count
      FROM ${this.table("growth_shop_source_mappings")} mapping
      LEFT JOIN ${this.table("growth_shops")} shop
        ON shop.id=mapping.internal_shop_id
      WHERE mapping.source_system IN ('mabang','mabang_order')`)).rows[0] || {};
    const historyPlaceholders = FORMAL_VALID_ORDER_STATUSES
      .map((_, index) => client.placeholder(index + 1))
      .join(",");
    const paidDayExpression = this.provider.dialect === DATABASE_DIALECTS.POSTGRESQL
      ? "TO_CHAR(paid_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD')"
      : `CASE
          WHEN substr(paid_at, -1) = 'Z' OR substr(paid_at, -6, 1) IN ('+', '-')
            THEN strftime('%Y-%m-%d', paid_at, '+8 hours')
          ELSE substr(paid_at, 1, 10)
        END`;
    const paidAtNotBlank = this.provider.dialect === DATABASE_DIALECTS.POSTGRESQL
      ? ""
      : "AND paid_at<>''";
    const history = (await client.query(`SELECT
        COUNT(DISTINCT ${paidDayExpression}) AS history_days,
        MIN(${paidDayExpression}) AS history_start,
        MAX(${paidDayExpression}) AS history_end
      FROM ${this.table("growth_order_headers")}
      WHERE effective_status='valid'
        AND order_status IN (${historyPlaceholders})
        AND paid_at IS NOT NULL
        ${paidAtNotBlank}`, FORMAL_VALID_ORDER_STATUSES)).rows[0] || {};
    const inventory = inventoryBatch
      ? ((await client.query(`SELECT
          COUNT(*) AS row_count,
          COUNT(DISTINCT normalized_source_sku) AS sku_count,
          COUNT(DISTINCT normalized_warehouse_name) AS warehouse_count,
          SUM(CASE WHEN predicted_daily_sales_semantic_status='confirmed'
            THEN 1 ELSE 0 END) AS confirmed_prediction_rows,
          SUM(CASE WHEN predicted_daily_sales_semantic_status='unconfirmed'
            THEN 1 ELSE 0 END) AS unconfirmed_prediction_rows
        FROM ${this.table("growth_inventory_snapshots")}
        WHERE batch_id=${client.placeholder(1)}`, [inventoryBatch.id])).rows[0] || {})
      : {};

    let mappedWarehouseCount = 0;
    let latestPublishedRunCount = 0;
    if (analysisSchemaReady) {
      mappedWarehouseCount = int((await client.query(`SELECT COUNT(DISTINCT mapping.normalized_warehouse_name) AS count
        FROM ${this.table("growth_warehouse_country_mappings")} mapping
        JOIN ${this.table("growth_country_mapping_sets")} mapping_set
          ON mapping_set.id=mapping.mapping_set_id
        WHERE mapping_set.status='active'
          AND mapping.mapping_status IN ('confirmed','excluded')`)).rows[0]?.count);
      latestPublishedRunCount = int((await client.query(`SELECT COUNT(*) AS count
        FROM ${this.table("growth_analysis_runs")}
        WHERE status='published'`)).rows[0]?.count);
    }

    const sourceShopCount = int(shopReadiness.source_shop_count);
    const mappedShopCount = int(shopReadiness.mapped_shop_count);
    const managerConfiguredShopCount = int(shopReadiness.manager_configured_shop_count);
    const countryConfiguredShopCount = int(shopReadiness.country_configured_shop_count);
    const warehouseCount = int(inventory.warehouse_count);
    const historyDays = int(history.history_days);
    const confirmedPredictionRows = int(inventory.confirmed_prediction_rows);
    const inventoryRowCount = int(inventory.row_count);
    const blockers = [];
    if (!analysisSchemaReady) blockers.push("ANALYSIS_SCHEMA_NOT_APPROVED");
    if (!taskPersistenceReady) blockers.push("TASK_PERSISTENCE_SCHEMA_NOT_APPROVED");
    if (!latestPublishedRunCount) blockers.push("NO_PUBLISHED_ANALYSIS");
    if (mappedShopCount < sourceShopCount) blockers.push("SHOP_IDENTITY_MAPPING_INCOMPLETE");
    if (managerConfiguredShopCount < sourceShopCount) blockers.push("STORE_MANAGER_MAPPING_INCOMPLETE");
    if (countryConfiguredShopCount < sourceShopCount) blockers.push("STORE_COUNTRY_MAPPING_INCOMPLETE");
    if (mappedWarehouseCount < warehouseCount) blockers.push("WAREHOUSE_COUNTRY_MAPPING_INCOMPLETE");
    if (historyDays < 14) blockers.push("INSUFFICIENT_HISTORY");
    if (!inventoryRowCount || confirmedPredictionRows < inventoryRowCount) {
      blockers.push("PREDICTED_DAILY_SALES_SEMANTICS_UNCONFIRMED");
    }

    return {
      latestMigration: migrationVersions.at(-1) || null,
      analysisSchemaReady,
      taskPersistenceReady,
      publishedAnalysisAvailable: latestPublishedRunCount > 0,
      inventoryBatch: inventoryBatch ? {
        id: inventoryBatch.id,
        sourceFilename: inventoryBatch.source_filename || null,
        collectedAt: inventoryBatch.collected_at || null,
        importedAt: inventoryBatch.imported_at || null,
        rowCount: int(inventoryBatch.row_count),
      } : null,
      orderBatch: orderBatch ? {
        id: orderBatch.id,
        sourceFilename: orderBatch.source_filename || null,
        collectedAt: orderBatch.collected_at || null,
        importedAt: orderBatch.imported_at || null,
        rowCount: int(orderBatch.row_count),
      } : null,
      inventoryRowCount,
      inventorySkuCount: int(inventory.sku_count),
      warehouseCount,
      mappedWarehouseCount,
      unmappedWarehouseCount: Math.max(0, warehouseCount - mappedWarehouseCount),
      sourceShopCount,
      mappedShopCount,
      unmappedShopCount: Math.max(0, sourceShopCount - mappedShopCount),
      managerConfiguredShopCount,
      unownedShopCount: Math.max(0, sourceShopCount - managerConfiguredShopCount),
      countryConfiguredShopCount,
      countryUnresolvedShopCount: Math.max(0, sourceShopCount - countryConfiguredShopCount),
      historyDays,
      historyStart: history.history_start || null,
      historyEnd: history.history_end || null,
      requiredHistoryDays: 14,
      confirmedPredictionRows,
      unconfirmedPredictionRows: int(inventory.unconfirmed_prediction_rows),
      operationTasksPublishable: blockers.length === 0,
      blockers,
    };
  }

  async assistantConfiguration(client = this.provider) {
    const readiness = await this.assistantReadiness(client);
    const shopMappings = (await client.query(`SELECT
        mapping.id AS mapping_id,
        mapping.source_system,
        mapping.source_shop_name,
        mapping.normalized_source_shop_name,
        mapping.platform,
        mapping.country_code AS source_country_code,
        mapping.mapping_status,
        mapping.mapping_source,
        mapping.updated_at AS mapping_updated_at,
        shop.id AS internal_shop_id,
        shop.internal_shop_code,
        shop.display_name,
        shop.country_code AS shop_country_code,
        shop.country_name,
        shop.owner_user_id,
        shop.identity_status
      FROM ${this.table("growth_shop_source_mappings")} mapping
      LEFT JOIN ${this.table("growth_shops")} shop
        ON shop.id=mapping.internal_shop_id
      WHERE mapping.source_system IN ('mabang','mabang_order')
      ORDER BY mapping.source_shop_name,mapping.id`)).rows;

    const warehouseRows = readiness.inventoryBatch
      ? (await client.query(`SELECT
          MIN(warehouse_name) AS source_warehouse_name,
          normalized_warehouse_name,
          COUNT(*) AS row_count
        FROM ${this.table("growth_inventory_snapshots")}
        WHERE batch_id=${client.placeholder(1)}
          AND normalized_warehouse_name IS NOT NULL
          AND normalized_warehouse_name<>''
        GROUP BY normalized_warehouse_name
        ORDER BY normalized_warehouse_name`, [readiness.inventoryBatch.id])).rows
      : [];

    let activeCountryMappingSet = null;
    let publishedWarehouseMappings = [];
    if (readiness.analysisSchemaReady) {
      activeCountryMappingSet = await this.activeCountryMappingSet(client);
      publishedWarehouseMappings = activeCountryMappingSet
        ? await this.warehouseCountryMappings(activeCountryMappingSet.id, client)
        : [];
    }
    const warehouseMappingByName = new Map(
      publishedWarehouseMappings.map((row) => [row.normalized_warehouse_name, row]),
    );

    return {
      readiness,
      writeGate: {
        enabled: false,
        approvalRequired: true,
        reasons: [
          ...(!readiness.analysisSchemaReady ? ["ANALYSIS_SCHEMA_NOT_APPROVED"] : []),
          "FORMAL_CONFIGURATION_WRITE_NOT_APPROVED",
        ],
      },
      dataSources: [
        {
          key: "orders",
          taskType: "order_export",
          sourceType: "mabang_order",
          label: "订单信息",
          latestBatch: readiness.orderBatch,
        },
        {
          key: "inventory",
          taskType: "inventory_export",
          sourceType: "mabang_inventory",
          label: "库存信息",
          latestBatch: readiness.inventoryBatch,
        },
      ],
      countryMappingSet: countryMappingSetRow(activeCountryMappingSet),
      countryMappings: warehouseRows.map((row) => {
        const mapping = warehouseMappingByName.get(row.normalized_warehouse_name);
        return {
          key: row.normalized_warehouse_name,
          sourceWarehouseName: row.source_warehouse_name,
          normalizedWarehouseName: row.normalized_warehouse_name,
          rowCount: int(row.row_count),
          countryCode: mapping?.country_code || null,
          countryName: mapping?.country_name || null,
          mappingStatus: mapping?.mapping_status || "unmapped",
          lastUpdated: mapping?.confirmed_at || null,
        };
      }),
      shopMappings: shopMappings.map((row) => {
        const identityMapped = ["matched", "manually_confirmed"].includes(row.mapping_status)
          && Boolean(row.internal_shop_id);
        const countryConfirmed = Boolean(
          row.shop_country_code
          && row.shop_country_code !== "ZZ"
          && row.shop_country_code !== "XX",
        );
        const managerConfirmed = Boolean(row.owner_user_id);
        return {
          key: row.mapping_id,
          mappingId: row.mapping_id,
          sourceSystem: row.source_system,
          sourceShopName: row.source_shop_name,
          normalizedSourceShopName: row.normalized_source_shop_name,
          platform: row.platform || null,
          sourceCountryCode: row.source_country_code || null,
          mappingStatus: row.mapping_status,
          mappingSource: row.mapping_source,
          internalShopId: row.internal_shop_id || null,
          internalShopCode: row.internal_shop_code || null,
          internalShopName: row.display_name || null,
          countryCode: row.shop_country_code || null,
          countryName: row.country_name || null,
          managerUserId: row.owner_user_id || null,
          identityStatus: row.identity_status || "review_required",
          readinessStatus: identityMapped && countryConfirmed && managerConfirmed
            ? "confirmed"
            : "unmapped",
          missingFields: [
            ...(!identityMapped ? ["shop_identity"] : []),
            ...(!countryConfirmed ? ["country"] : []),
            ...(!managerConfirmed ? ["manager"] : []),
          ],
          lastUpdated: row.mapping_updated_at || null,
        };
      }),
    };
  }

  async insertFocusItemEvent(input, client = this.provider) {
    const id = input.id || randomUUID();
    await this.insert("growth_focus_item_events", [
      "id", "focus_item_id", "event_type", "task_revision", "from_status", "to_status",
      "actor_user_id", "actor_type", "reason_code", "note", "signal_id",
      "analysis_run_id", "evidence_snapshot_json", "idempotency_key",
      "occurred_at", "created_at",
    ], [
      id, input.focusItemId, input.eventType, input.taskRevision, input.fromStatus, input.toStatus,
      input.actorUserId, input.actorType, input.reasonCode, input.note, input.signalId,
      input.analysisRunId, JSON.stringify(input.evidence || {}), input.idempotencyKey,
      input.occurredAt, input.createdAt,
    ], client);
    return id;
  }

  async syncFocusItems(runId, candidates, { actor = "system", at } = {}) {
    const detectedAt = at || new Date().toISOString();
    const normalizedCandidates = [...candidates]
      .filter((candidate) => candidate?.id && candidate?.type)
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));
    return this.provider.transaction(async (client) => {
      const candidateKeys = new Set(normalizedCandidates.map((candidate) => String(candidate.id)));
      const activeRows = (await client.query(`SELECT *
        FROM ${this.table("growth_focus_items")}
        WHERE status IN (${ACTIVE_FOCUS_STATUSES.map((_, index) => client.placeholder(index + 1)).join(",")})
        ORDER BY task_key,id`, ACTIVE_FOCUS_STATUSES)).rows;

      for (const candidate of normalizedCandidates) {
        const taskKeyValue = String(candidate.id);
        const existing = (await client.query(`SELECT *
          FROM ${this.table("growth_focus_items")}
          WHERE task_key=${client.placeholder(1)}
          ORDER BY CASE
            WHEN status IN (${ACTIVE_FOCUS_STATUSES.map((_, index) => client.placeholder(index + 2)).join(",")})
              THEN 0 ELSE 1 END,
            updated_at DESC,id DESC
          LIMIT 1`, [taskKeyValue, ...ACTIVE_FOCUS_STATUSES])).rows[0] || null;
        if (
          existing
          && existing.last_analysis_run_id === runId
          && bool(existing.is_hit_in_latest_run)
        ) {
          continue;
        }
        const snapshot = {
          ...candidate,
          id: undefined,
          persisted: undefined,
        };
        const reasonCode = String(candidate.evidence?.reasonCode || candidate.type);
        const actionCode = focusRecommendedActionCode(candidate);
        const subjectType = focusSubjectType(candidate);

        if (!existing) {
          const id = randomUUID();
          await this.insert("growth_focus_items", [
            "id", "task_key", "task_type", "current_signal_id", "first_analysis_run_id",
            "last_analysis_run_id", "owner_user_id", "internal_shop_id", "country_code",
            "source_warehouse_name", "normalized_warehouse_name", "platform",
            "category_l1", "category_l2", "subject_type",
            "normalized_source_sku", "priority", "status", "reason_code",
            "recommended_action_code", "evidence_snapshot_json", "consecutive_hit_count",
            "is_hit_in_latest_run", "first_detected_at", "last_detected_at",
            "revision", "created_at", "updated_at",
          ], [
            id, taskKeyValue, candidate.type, null, runId, runId,
            candidate.managerId || null, candidate.storeId || null, candidate.countryCode || null,
            candidate.sourceWarehouseName || null, candidate.normalizedWarehouseName || null,
            candidate.platform || null, null, candidate.category || null, subjectType,
            candidate.sku || null, candidate.priority || "P3", "NEW", reasonCode,
            actionCode, JSON.stringify(snapshot), 1, 1, detectedAt, detectedAt,
            1, detectedAt, detectedAt,
          ], client);
          await this.insertFocusItemEvent({
            focusItemId: id,
            eventType: "CREATED",
            taskRevision: 1,
            fromStatus: null,
            toStatus: "NEW",
            actorUserId: actor,
            actorType: "system",
            reasonCode,
            note: null,
            signalId: null,
            analysisRunId: runId,
            evidence: candidate.evidence || {},
            idempotencyKey: `${runId}:CREATED`,
            occurredAt: detectedAt,
            createdAt: detectedAt,
          }, client);
          continue;
        }

        const wasActive = ACTIVE_FOCUS_STATUSES.includes(existing.status);
        const nextStatus = wasActive ? existing.status : "REOPENED";
        const consecutiveHitCount = bool(existing.is_hit_in_latest_run)
          ? int(existing.consecutive_hit_count) + 1
          : 1;
        await client.execute(`UPDATE ${this.table("growth_focus_items")}
          SET task_type=${client.placeholder(1)},
            last_analysis_run_id=${client.placeholder(2)},
            owner_user_id=${client.placeholder(3)},
            internal_shop_id=${client.placeholder(4)},
            country_code=${client.placeholder(5)},
            source_warehouse_name=${client.placeholder(6)},
            normalized_warehouse_name=${client.placeholder(7)},
            platform=${client.placeholder(8)},
            category_l2=${client.placeholder(9)},
            subject_type=${client.placeholder(10)},
            normalized_source_sku=${client.placeholder(11)},
            priority=${client.placeholder(12)},
            status=${client.placeholder(13)},
            reason_code=${client.placeholder(14)},
            recommended_action_code=${client.placeholder(15)},
            evidence_snapshot_json=${client.placeholder(16)},
            consecutive_hit_count=${client.placeholder(17)},
            is_hit_in_latest_run=1,
            last_detected_at=${client.placeholder(18)},
            blocked_reason_code=${client.placeholder(19)},
            resolution_code=${client.placeholder(20)},
            resolution_note=${client.placeholder(21)},
            resolved_at=${client.placeholder(22)},
            revision=revision+1,
            updated_at=${client.placeholder(23)}
          WHERE id=${client.placeholder(24)}`, [
          candidate.type,
          runId,
          candidate.managerId || null,
          candidate.storeId || null,
          candidate.countryCode || null,
          candidate.sourceWarehouseName || null,
          candidate.normalizedWarehouseName || null,
          candidate.platform || null,
          candidate.category || null,
          subjectType,
          candidate.sku || null,
          candidate.priority || "P3",
          nextStatus,
          reasonCode,
          actionCode,
          JSON.stringify(snapshot),
          consecutiveHitCount,
          detectedAt,
          wasActive ? existing.blocked_reason_code : null,
          wasActive ? existing.resolution_code : null,
          wasActive ? existing.resolution_note : null,
          wasActive ? existing.resolved_at : null,
          detectedAt,
          existing.id,
        ]);
        await this.insertFocusItemEvent({
          focusItemId: existing.id,
          eventType: wasActive ? "SIGNAL_REFRESHED" : "REOPENED",
          taskRevision: int(existing.revision) + 1,
          fromStatus: existing.status,
          toStatus: nextStatus,
          actorUserId: actor,
          actorType: "system",
          reasonCode,
          note: null,
          signalId: null,
          analysisRunId: runId,
          evidence: candidate.evidence || {},
          idempotencyKey: `${runId}:${wasActive ? "SIGNAL_REFRESHED" : "REOPENED"}`,
          occurredAt: detectedAt,
          createdAt: detectedAt,
        }, client);
      }

      for (const existing of activeRows) {
        if (candidateKeys.has(existing.task_key) || !bool(existing.is_hit_in_latest_run)) continue;
        await client.execute(`UPDATE ${this.table("growth_focus_items")}
          SET is_hit_in_latest_run=0,revision=revision+1,updated_at=${client.placeholder(1)}
          WHERE id=${client.placeholder(2)}`, [detectedAt, existing.id]);
        await this.insertFocusItemEvent({
          focusItemId: existing.id,
          eventType: "NOT_HIT_IN_LATEST_RUN",
          taskRevision: int(existing.revision) + 1,
          fromStatus: existing.status,
          toStatus: existing.status,
          actorUserId: actor,
          actorType: "system",
          reasonCode: "NOT_HIT_IN_LATEST_RUN",
          note: null,
          signalId: null,
          analysisRunId: runId,
          evidence: {},
          idempotencyKey: `${runId}:NOT_HIT_IN_LATEST_RUN`,
          occurredAt: detectedAt,
          createdAt: detectedAt,
        }, client);
      }

      return this.listFocusItems({ activeOnly: true, page: 1, pageSize: 500 }, client);
    });
  }

  async listFocusItems(filters = {}, client = this.provider) {
    const { page, pageSize, offset } = pagination(filters, 500);
    const where = [];
    const values = [];
    const add = (column, value) => {
      values.push(value);
      where.push(`${column}=${client.placeholder(values.length)}`);
    };
    if (filters.ownerUserId) add("owner_user_id", filters.ownerUserId);
    if (filters.shopId) add("internal_shop_id", filters.shopId);
    if (filters.taskType) add("task_type", filters.taskType);
    if (filters.priority) add("priority", filters.priority);
    if (filters.status) add("status", filters.status);
    if (filters.activeOnly) {
      where.push(`status IN (${ACTIVE_FOCUS_STATUSES.map((status) => {
        values.push(status);
        return client.placeholder(values.length);
      }).join(",")})`);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = int((await client.query(`SELECT COUNT(*) AS count
      FROM ${this.table("growth_focus_items")}
      ${clause}`, values)).rows[0]?.count);
    const pageValues = [...values, pageSize, offset];
    const rows = (await client.query(`SELECT *
      FROM ${this.table("growth_focus_items")}
      ${clause}
      ORDER BY CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END,
        is_hit_in_latest_run DESC,last_detected_at DESC,id
      LIMIT ${client.placeholder(values.length + 1)}
      OFFSET ${client.placeholder(values.length + 2)}`, pageValues)).rows;
    return {
      total,
      page,
      pageSize,
      items: rows.map(focusItemRow),
    };
  }

  async focusItemById(id, client = this.provider) {
    const row = (await client.query(`SELECT *
      FROM ${this.table("growth_focus_items")}
      WHERE id=${client.placeholder(1)}
      LIMIT 1`, [id])).rows[0];
    return focusItemRow(row);
  }

  async focusItemEvents(id, client = this.provider) {
    return (await client.query(`SELECT *
      FROM ${this.table("growth_focus_item_events")}
      WHERE focus_item_id=${client.placeholder(1)}
      ORDER BY task_revision`, [id])).rows.map(focusItemEventRow);
  }

  async transitionFocusItem(input) {
    return this.provider.transaction(async (client) => {
      const duplicate = (await client.query(`SELECT *
        FROM ${this.table("growth_focus_item_events")}
        WHERE focus_item_id=${client.placeholder(1)}
          AND idempotency_key=${client.placeholder(2)}
        LIMIT 1`, [input.id, input.idempotencyKey])).rows[0] || null;
      if (duplicate) {
        return {
          item: await this.focusItemById(input.id, client),
          event: focusItemEventRow(duplicate),
          replayed: true,
        };
      }
      const current = (await client.query(`SELECT *
        FROM ${this.table("growth_focus_items")}
        WHERE id=${client.placeholder(1)}
        LIMIT 1`, [input.id])).rows[0] || null;
      if (!current) return { notFound: true };
      if (int(current.revision) !== input.expectedRevision) {
        return { conflict: true, item: focusItemRow(current) };
      }
      if (!input.allowedFrom.includes(current.status)) {
        return { invalidTransition: true, item: focusItemRow(current) };
      }

      const terminal = ["RESOLVED", "DISMISSED"].includes(input.toStatus);
      const reopened = input.toStatus === "REOPENED";
      const acknowledgedAt = input.toStatus === "ACKNOWLEDGED"
        ? input.at
        : current.acknowledged_at;
      const startedAt = input.toStatus === "IN_PROGRESS"
        ? (current.started_at || input.at)
        : current.started_at;
      const dueAt = input.toStatus === "MONITORING"
        ? (input.dueAt || current.due_at)
        : current.due_at;
      const snoozedUntil = input.toStatus === "MONITORING"
        ? (input.snoozedUntil || current.snoozed_until)
        : current.snoozed_until;
      const blockedReasonCode = input.toStatus === "BLOCKED"
        ? input.reasonCode
        : (reopened || input.toStatus === "IN_PROGRESS" ? null : current.blocked_reason_code);
      const resolutionCode = terminal ? input.reasonCode : (reopened ? null : current.resolution_code);
      const resolutionNote = terminal ? input.note : (reopened ? null : current.resolution_note);
      const resolvedAt = terminal ? input.at : (reopened ? null : current.resolved_at);

      await client.execute(`UPDATE ${this.table("growth_focus_items")}
        SET status=${client.placeholder(1)},
          acknowledged_at=${client.placeholder(2)},
          started_at=${client.placeholder(3)},
          due_at=${client.placeholder(4)},
          snoozed_until=${client.placeholder(5)},
          blocked_reason_code=${client.placeholder(6)},
          resolution_code=${client.placeholder(7)},
          resolution_note=${client.placeholder(8)},
          resolved_at=${client.placeholder(9)},
          revision=revision+1,
          updated_at=${client.placeholder(10)}
        WHERE id=${client.placeholder(11)}
          AND revision=${client.placeholder(12)}`, [
        input.toStatus,
        acknowledgedAt,
        startedAt,
        dueAt,
        snoozedUntil,
        blockedReasonCode,
        resolutionCode,
        resolutionNote,
        resolvedAt,
        input.at,
        input.id,
        input.expectedRevision,
      ]);
      const item = await this.focusItemById(input.id, client);
      if (!item || item.revision !== input.expectedRevision + 1) {
        return { conflict: true, item };
      }
      const eventId = await this.insertFocusItemEvent({
        focusItemId: input.id,
        eventType: input.eventType,
        taskRevision: input.expectedRevision + 1,
        fromStatus: current.status,
        toStatus: input.toStatus,
        actorUserId: input.actor,
        actorType: "user",
        reasonCode: input.reasonCode,
        note: input.note,
        signalId: current.current_signal_id,
        analysisRunId: current.last_analysis_run_id,
        evidence: input.evidence || {},
        idempotencyKey: input.idempotencyKey,
        occurredAt: input.at,
        createdAt: input.at,
      }, client);
      const event = (await client.query(`SELECT *
        FROM ${this.table("growth_focus_item_events")}
        WHERE id=${client.placeholder(1)}`, [eventId])).rows[0];
      return { item, event: focusItemEventRow(event), replayed: false };
    });
  }

  async assignFocusItem(input) {
    return this.provider.transaction(async (client) => {
      const duplicate = (await client.query(`SELECT *
        FROM ${this.table("growth_focus_item_events")}
        WHERE focus_item_id=${client.placeholder(1)}
          AND idempotency_key=${client.placeholder(2)}
        LIMIT 1`, [input.id, input.idempotencyKey])).rows[0] || null;
      if (duplicate) {
        return {
          item: await this.focusItemById(input.id, client),
          event: focusItemEventRow(duplicate),
          replayed: true,
        };
      }
      const current = (await client.query(`SELECT *
        FROM ${this.table("growth_focus_items")}
        WHERE id=${client.placeholder(1)}
        LIMIT 1`, [input.id])).rows[0] || null;
      if (!current) return { notFound: true };
      if (int(current.revision) !== input.expectedRevision) {
        return { conflict: true, item: focusItemRow(current) };
      }
      await client.execute(`UPDATE ${this.table("growth_focus_items")}
        SET owner_user_id=${client.placeholder(1)},revision=revision+1,
          updated_at=${client.placeholder(2)}
        WHERE id=${client.placeholder(3)}
          AND revision=${client.placeholder(4)}`, [
        input.ownerUserId,
        input.at,
        input.id,
        input.expectedRevision,
      ]);
      const item = await this.focusItemById(input.id, client);
      if (!item || item.revision !== input.expectedRevision + 1) {
        return { conflict: true, item };
      }
      const eventId = await this.insertFocusItemEvent({
        focusItemId: input.id,
        eventType: "ASSIGNED",
        taskRevision: input.expectedRevision + 1,
        fromStatus: current.status,
        toStatus: current.status,
        actorUserId: input.actor,
        actorType: "user",
        reasonCode: input.reasonCode,
        note: input.note,
        signalId: current.current_signal_id,
        analysisRunId: current.last_analysis_run_id,
        evidence: { ownerUserId: input.ownerUserId },
        idempotencyKey: input.idempotencyKey,
        occurredAt: input.at,
        createdAt: input.at,
      }, client);
      const event = (await client.query(`SELECT *
        FROM ${this.table("growth_focus_item_events")}
        WHERE id=${client.placeholder(1)}`, [eventId])).rows[0];
      return { item, event: focusItemEventRow(event), replayed: false };
    });
  }

  async scheduleFocusItem(input) {
    return this.provider.transaction(async (client) => {
      const duplicate = (await client.query(`SELECT *
        FROM ${this.table("growth_focus_item_events")}
        WHERE focus_item_id=${client.placeholder(1)}
          AND idempotency_key=${client.placeholder(2)}
        LIMIT 1`, [input.id, input.idempotencyKey])).rows[0] || null;
      if (duplicate) {
        return {
          item: await this.focusItemById(input.id, client),
          event: focusItemEventRow(duplicate),
          replayed: true,
        };
      }
      const current = (await client.query(`SELECT *
        FROM ${this.table("growth_focus_items")}
        WHERE id=${client.placeholder(1)}
        LIMIT 1`, [input.id])).rows[0] || null;
      if (!current) return { notFound: true };
      if (int(current.revision) !== input.expectedRevision) {
        return { conflict: true, item: focusItemRow(current) };
      }
      await client.execute(`UPDATE ${this.table("growth_focus_items")}
        SET due_at=${client.placeholder(1)},snoozed_until=${client.placeholder(2)},
          revision=revision+1,updated_at=${client.placeholder(3)}
        WHERE id=${client.placeholder(4)}
          AND revision=${client.placeholder(5)}`, [
        input.dueAt,
        input.snoozedUntil,
        input.at,
        input.id,
        input.expectedRevision,
      ]);
      const item = await this.focusItemById(input.id, client);
      if (!item || item.revision !== input.expectedRevision + 1) {
        return { conflict: true, item };
      }
      const eventId = await this.insertFocusItemEvent({
        focusItemId: input.id,
        eventType: "SCHEDULED",
        taskRevision: input.expectedRevision + 1,
        fromStatus: current.status,
        toStatus: current.status,
        actorUserId: input.actor,
        actorType: "user",
        reasonCode: input.reasonCode,
        note: input.note,
        signalId: current.current_signal_id,
        analysisRunId: current.last_analysis_run_id,
        evidence: {
          dueAt: input.dueAt,
          snoozedUntil: input.snoozedUntil,
        },
        idempotencyKey: input.idempotencyKey,
        occurredAt: input.at,
        createdAt: input.at,
      }, client);
      const event = (await client.query(`SELECT *
        FROM ${this.table("growth_focus_item_events")}
        WHERE id=${client.placeholder(1)}`, [eventId])).rows[0];
      return { item, event: focusItemEventRow(event), replayed: false };
    });
  }

  async activeRuleSet(client = this.provider) {
    const row = (await client.query(`SELECT *
      FROM ${this.table("growth_rule_sets")}
      WHERE status='active'
      ORDER BY effective_from DESC, id DESC
      LIMIT 1`)).rows[0];
    if (!row) return null;
    return { ...row, parameters: parseJson(row.parameters_json, {}) };
  }

  async activeCountryMappingSet(client = this.provider) {
    return (await client.query(`SELECT *
      FROM ${this.table("growth_country_mapping_sets")}
      WHERE status='active'
      ORDER BY activated_at DESC, id DESC
      LIMIT 1`)).rows[0] || null;
  }

  async warehouseCountryMappings(mappingSetId, client = this.provider) {
    return (await client.query(`SELECT *
      FROM ${this.table("growth_warehouse_country_mappings")}
      WHERE mapping_set_id=${client.placeholder(1)}
      ORDER BY normalized_warehouse_name,id`, [mappingSetId])).rows;
  }

  async configurationSnapshot(client = this.provider) {
    const [inventoryBatch, activeCountrySet, activeRuleSet, countrySets, ruleSets] = await Promise.all([
      this.latestInventoryBatch(client),
      this.activeCountryMappingSet(client),
      this.activeRuleSet(client),
      client.query(`SELECT * FROM ${this.table("growth_country_mapping_sets")}
        ORDER BY created_at DESC,id DESC LIMIT 12`),
      client.query(`SELECT * FROM ${this.table("growth_rule_sets")}
        ORDER BY created_at DESC,id DESC LIMIT 12`),
    ]);
    const [mappings, warehouses] = await Promise.all([
      activeCountrySet ? this.warehouseCountryMappings(activeCountrySet.id, client) : [],
      inventoryBatch
        ? client.query(`SELECT
            MIN(warehouse_name) AS source_warehouse_name,
            normalized_warehouse_name,
            COUNT(*) AS row_count
          FROM ${this.table("growth_inventory_snapshots")}
          WHERE batch_id=${client.placeholder(1)}
            AND normalized_warehouse_name IS NOT NULL
            AND normalized_warehouse_name<>''
          GROUP BY normalized_warehouse_name
          ORDER BY normalized_warehouse_name`, [inventoryBatch.id])
        : { rows: [] },
    ]);
    return {
      latestInventoryBatch: inventoryBatch ? {
        id: inventoryBatch.id,
        collectedAt: inventoryBatch.collected_at || null,
        importedAt: inventoryBatch.imported_at || null,
        rowCount: int(inventoryBatch.row_count),
      } : null,
      activeCountryMappingSet: countryMappingSetRow(activeCountrySet),
      countryMappings: mappings.map(warehouseMappingRow),
      knownWarehouses: warehouses.rows.map((row) => ({
        sourceWarehouseName: row.source_warehouse_name,
        normalizedWarehouseName: row.normalized_warehouse_name,
        rowCount: int(row.row_count),
      })),
      activeRuleSet: ruleSetRow(activeRuleSet),
      countryMappingHistory: countrySets.rows.map(countryMappingSetRow),
      ruleSetHistory: ruleSets.rows.map(ruleSetRow),
    };
  }

  async saveCountryMappingSet(input) {
    return this.provider.transaction(async (client) => {
      const existing = (await client.query(`SELECT *
        FROM ${this.table("growth_country_mapping_sets")}
        WHERE content_sha256=${client.placeholder(1)}
        LIMIT 1`, [input.contentSha256])).rows[0] || null;
      const id = existing?.id || input.id || randomUUID();
      await client.execute(`UPDATE ${this.table("growth_country_mapping_sets")}
        SET status='retired',retired_by=${client.placeholder(1)},retired_at=${client.placeholder(2)}
        WHERE status='active' AND id<>${client.placeholder(3)}`, [input.actor, input.at, id]);
      if (existing) {
        await client.execute(`UPDATE ${this.table("growth_country_mapping_sets")}
          SET status='active',activated_by=${client.placeholder(1)},activated_at=${client.placeholder(2)},
            retired_by=NULL,retired_at=NULL
          WHERE id=${client.placeholder(3)}`, [input.actor, input.at, id]);
      } else {
        await this.insert("growth_country_mapping_sets", [
          "id", "version", "status", "description", "content_sha256", "created_by", "created_at",
          "activated_by", "activated_at",
        ], [
          id, input.version, "active", input.description, input.contentSha256, input.actor, input.at,
          input.actor, input.at,
        ], client);
        for (const mapping of input.mappings) {
          await this.insert("growth_warehouse_country_mappings", [
            "id", "mapping_set_id", "source_system", "source_warehouse_name",
            "normalized_warehouse_name", "country_code", "country_name", "mapping_status",
            "exclusion_reason", "evidence_json", "confirmed_by", "confirmed_at", "created_at",
          ], [
            randomUUID(), id, "mabang_inventory", mapping.sourceWarehouseName,
            mapping.normalizedWarehouseName, mapping.countryCode, mapping.countryName,
            mapping.mappingStatus, mapping.exclusionReason, JSON.stringify(mapping.evidence || {}),
            input.actor, input.at, input.at,
          ], client);
        }
      }
      const set = (await client.query(`SELECT * FROM ${this.table("growth_country_mapping_sets")}
        WHERE id=${client.placeholder(1)} LIMIT 1`, [id])).rows[0];
      const mappings = await this.warehouseCountryMappings(id, client);
      return {
        set: countryMappingSetRow(set),
        mappings: mappings.map(warehouseMappingRow),
        reused: Boolean(existing),
      };
    });
  }

  async saveRuleSet(input) {
    return this.provider.transaction(async (client) => {
      const existing = (await client.query(`SELECT *
        FROM ${this.table("growth_rule_sets")}
        WHERE content_sha256=${client.placeholder(1)}
        LIMIT 1`, [input.contentSha256])).rows[0] || null;
      const id = existing?.id || input.id || randomUUID();
      await client.execute(`UPDATE ${this.table("growth_rule_sets")}
        SET status='retired',effective_to=${client.placeholder(1)}
        WHERE status='active' AND id<>${client.placeholder(2)}`, [input.at, id]);
      if (existing) {
        await client.execute(`UPDATE ${this.table("growth_rule_sets")}
          SET status='active',effective_to=NULL,activated_by=${client.placeholder(1)},
            activated_at=${client.placeholder(2)}
          WHERE id=${client.placeholder(3)}`, [input.actor, input.at, id]);
      } else {
        await this.insert("growth_rule_sets", [
          "id", "version", "status", "metrics_contract_version", "parameters_json",
          "content_sha256", "effective_from", "effective_to", "created_by", "created_at",
          "activated_by", "activated_at",
        ], [
          id, input.version, "active", input.metricsContractVersion, JSON.stringify(input.parameters),
          input.contentSha256, input.at, null, input.actor, input.at, input.actor, input.at,
        ], client);
      }
      const row = (await client.query(`SELECT * FROM ${this.table("growth_rule_sets")}
        WHERE id=${client.placeholder(1)} LIMIT 1`, [id])).rows[0];
      return { ruleSet: ruleSetRow(row), reused: Boolean(existing) };
    });
  }

  async confirmedShops(client = this.provider) {
    return (await client.query(`SELECT shop.*
      FROM ${this.table("growth_shops")} shop
      WHERE shop.status='active'
        AND shop.identity_status='confirmed'
        AND EXISTS (
          SELECT 1
          FROM ${this.table("growth_shop_source_mappings")} mapping
          WHERE mapping.internal_shop_id=shop.id
            AND mapping.mapping_status IN ('matched','manually_confirmed')
        )
      ORDER BY shop.display_name,shop.id`)).rows;
  }

  async inventoryRowsForBatch(batchId, client = this.provider) {
    return (await client.query(`SELECT snapshot.*,
        raw.raw_values_json,
        product.source_product_name AS mapped_product_name,
        lifecycle.status_code AS lifecycle_status,
        lifecycle.effective_at AS lifecycle_effective_at,
        (
          SELECT MIN(event.occurred_at)
          FROM ${this.table("product_sku_lifecycle_events")} event
          WHERE event.sku_id=snapshot.mapped_product_id
            AND event.to_status_code='NEW'
        ) AS new_started_at
      FROM ${this.table("growth_inventory_snapshots")} snapshot
      LEFT JOIN ${this.table("growth_inventory_raw_rows")} raw
        ON raw.batch_id=snapshot.batch_id
       AND raw.source_row_number=snapshot.source_row_number
      LEFT JOIN ${this.table("product_skus")} product
        ON product.id=snapshot.mapped_product_id
      LEFT JOIN ${this.table("product_sku_lifecycle")} lifecycle
        ON lifecycle.sku_id=snapshot.mapped_product_id
      WHERE snapshot.batch_id=${client.placeholder(1)}
      ORDER BY snapshot.normalized_source_sku,snapshot.normalized_warehouse_name,snapshot.id`, [batchId])).rows;
  }

  async validOrderRows(orderWatermarkAt, validOrderStatuses, client = this.provider) {
    const statuses = [...new Set(
      (Array.isArray(validOrderStatuses) ? validOrderStatuses : [])
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    )];
    if (!statuses.length) {
      const error = new Error("Growth Radar V2 requires at least one valid order status.");
      error.code = "GROWTH_RADAR_V2_ORDER_STATUS_CONFIG_EMPTY";
      throw error;
    }
    const statusPlaceholders = statuses
      .map((_, index) => client.placeholder(index + 1))
      .join(",");
    const watermarkPlaceholder = client.placeholder(statuses.length + 1);
    return (await client.query(`SELECT
        header.id AS order_header_id,
        header.internal_shop_id,
        header.platform,
        header.paid_at,
        line.id AS order_line_id,
        line.normalized_source_sku,
        line.source_sku,
        line.quantity,
        line.product_name,
        line.mapped_product_id
      FROM ${this.table("growth_order_headers")} header
      JOIN ${this.table("growth_order_lines")} line
        ON line.order_header_id=header.id
      JOIN ${this.table("growth_shops")} shop
        ON shop.id=header.internal_shop_id
      WHERE header.effective_status='valid'
        AND header.order_status IN (${statusPlaceholders})
        AND header.paid_at IS NOT NULL
        AND header.paid_at<=${watermarkPlaceholder}
        AND line.effective_status='valid'
        AND line.is_current=1
        AND line.quantity>0
        AND shop.status='active'
        AND shop.identity_status='confirmed'
        AND EXISTS (
          SELECT 1
          FROM ${this.table("growth_shop_source_mappings")} mapping
          WHERE mapping.internal_shop_id=shop.id
            AND mapping.mapping_status IN ('matched','manually_confirmed')
        )
      ORDER BY header.internal_shop_id,line.normalized_source_sku,header.paid_at,line.id`,
    [...statuses, orderWatermarkAt])).rows;
  }

  async latestOrderWatermark(client = this.provider) {
    const row = (await client.query(`SELECT MAX(paid_at) AS watermark
      FROM ${this.table("growth_order_headers")}
      WHERE paid_at IS NOT NULL`)).rows[0];
    return row?.watermark || null;
  }

  async runByFingerprint(inputFingerprint, client = this.provider) {
    const row = (await client.query(`SELECT *
      FROM ${this.table("growth_analysis_runs")}
      WHERE input_fingerprint=${client.placeholder(1)}
      LIMIT 1`, [inputFingerprint])).rows[0];
    return runRow(row);
  }

  async createRun(input, client = this.provider) {
    const id = input.id || randomUUID();
    await this.insert("growth_analysis_runs", [
      "id", "analysis_date", "inventory_batch_id", "order_watermark_at", "rule_set_id",
      "country_mapping_set_id", "shop_scope_fingerprint", "input_fingerprint", "status",
      "quality_status", "quality_summary_json", "created_by", "created_at", "updated_at",
    ], [
      id, input.analysisDate, input.inventoryBatchId, input.orderWatermarkAt, input.ruleSetId,
      input.countryMappingSetId, input.shopScopeFingerprint, input.inputFingerprint,
      input.status || "pending", input.qualityStatus || "degraded",
      JSON.stringify(input.qualitySummary || {}), input.createdBy, input.createdAt, input.updatedAt,
    ], client);
    return this.runById(id, client);
  }

  async runById(id, client = this.provider) {
    const row = (await client.query(`SELECT *
      FROM ${this.table("growth_analysis_runs")}
      WHERE id=${client.placeholder(1)}
      LIMIT 1`, [id])).rows[0];
    return runRow(row);
  }

  async updateRun(id, input, client = this.provider) {
    const entries = Object.entries({
      status: input.status,
      quality_status: input.qualityStatus,
      quality_summary_json: input.qualitySummary === undefined ? undefined : JSON.stringify(input.qualitySummary),
      global_sku_count: input.globalSkuCount,
      country_sku_count: input.countrySkuCount,
      shop_count: input.shopCount,
      shop_sku_count: input.shopSkuCount,
      signal_count: input.signalCount,
      started_at: input.startedAt,
      validated_at: input.validatedAt,
      published_at: input.publishedAt,
      finished_at: input.finishedAt,
      error_code: input.errorCode,
      error_summary: input.errorSummary,
      updated_at: input.updatedAt,
    }).filter(([, value]) => value !== undefined);
    if (!entries.length) return this.runById(id, client);
    const values = entries.map(([, value]) => value);
    values.push(id);
    await client.execute(`UPDATE ${this.table("growth_analysis_runs")}
      SET ${entries.map(([column], index) => `${column}=${client.placeholder(index + 1)}`).join(",")}
      WHERE id=${client.placeholder(values.length)}`, values);
    return this.runById(id, client);
  }

  async insertSkuMetric(input, client = this.provider) {
    const id = input.id || randomUUID();
    await this.insert("growth_sku_daily_metrics", [
      "id", "analysis_run_id", "analysis_date", "scope_type", "scope_key", "country_code",
      "normalized_source_sku", "source_sku", "product_name", "product_status", "category_l1",
      "category_l2", "mapped_product_id", "mapping_status", "warehouse_count",
      "available_quantity", "in_transit_quantity", "source_predicted_daily_sales_country_sku",
      "source_visible_sales_7d",
      "source_visible_sales_28d", "source_visible_sales_42d", "effective_daily_sales_28d",
      "computed_days_of_supply", "days_of_supply_status", "demand_percentile_28d",
      "assortment_percentile", "inventory_percentile", "comparison_scope", "comparison_sample_size",
      "assortment_status", "warehouse_supply_summary_json", "supply_risk_warehouse_count",
      "supply_critical_warehouse_count", "supply_warning_warehouse_count",
      "supply_data_issue_warehouse_count",
      "is_source_high_performance", "is_new", "new_age_days", "availability_status",
      "quality_status", "reason_code", "metrics_version", "evidence_json", "calculated_at",
    ], [
      id, input.analysisRunId, input.analysisDate, input.scopeType, input.scopeKey, input.countryCode,
      input.sku, input.sourceSku, input.productName, input.productStatus, input.categoryL1,
      input.categoryL2, input.mappedProductId, input.mappingStatus, input.warehouseCount,
      input.availableQuantity, input.inTransitQuantity, input.sourcePredictedDailySales,
      input.sourceVisibleSales7d,
      input.sourceVisibleSales28d, input.sourceVisibleSales42d, input.effectiveDailySales28d,
      input.computedDaysOfSupply, input.daysOfSupplyStatus, input.demandPercentile28d,
      input.assortmentPercentile, input.inventoryPercentile, input.comparisonScope,
      input.comparisonSampleSize, input.assortmentStatus,
      JSON.stringify(input.warehouseSupplySummary || {}),
      input.supplyRiskWarehouseCount || 0, input.supplyCriticalWarehouseCount || 0,
      input.supplyWarningWarehouseCount || 0, input.supplyDataIssueWarehouseCount || 0,
      input.sourceHighPerformance ? 1 : 0, input.isNew ? 1 : 0, input.newAgeDays,
      input.availabilityStatus, input.qualityStatus, input.reasonCode, input.metricsVersion,
      JSON.stringify(input.evidence || {}), input.calculatedAt,
    ], client);
    return id;
  }

  async insertSkuWarehouseMetric(input, client = this.provider) {
    const id = input.id || randomUUID();
    await this.insert("growth_sku_warehouse_daily_metrics", [
      "id", "analysis_run_id", "analysis_date", "country_code", "source_warehouse_name",
      "normalized_warehouse_name", "normalized_source_sku", "source_sku", "product_name",
      "product_status", "category_l1", "category_l2", "mapped_product_id", "mapping_status",
      "available_quantity", "in_transit_quantity", "source_current_sellable_days",
      "source_predicted_daily_sales", "source_visible_sales_7d", "source_visible_sales_28d",
      "source_visible_sales_42d", "supply_status", "slow_moving_status",
      "availability_status", "quality_status", "reason_code", "metrics_version",
      "evidence_json", "calculated_at",
    ], [
      id, input.analysisRunId, input.analysisDate, input.countryCode, input.sourceWarehouseName,
      input.normalizedWarehouseName, input.sku, input.sourceSku, input.productName,
      input.productStatus, input.categoryL1, input.categoryL2, input.mappedProductId,
      input.mappingStatus, input.availableQuantity, input.inTransitQuantity,
      input.sourceCurrentSellableDays, input.sourcePredictedDailySales,
      input.sourceVisibleSales7d, input.sourceVisibleSales28d, input.sourceVisibleSales42d,
      input.supplyStatus, input.slowMovingStatus, input.availabilityStatus,
      input.qualityStatus, input.reasonCode, input.metricsVersion,
      JSON.stringify(input.evidence || {}), input.calculatedAt,
    ], client);
    return id;
  }

  async insertShopMetric(input, client = this.provider) {
    const id = input.id || randomUUID();
    await this.insert("growth_shop_daily_metrics", [
      "id", "analysis_run_id", "analysis_date", "internal_shop_id", "display_name", "platform",
      "owner_user_id", "country_code", "own_sales_quantity_7d", "own_sales_quantity_28d",
      "valid_order_count_7d", "valid_order_count_28d", "eligible_saleable_sku_count",
      "sold_eligible_sku_count_28d", "saleable_coverage_rate_28d",
      "eligible_high_performance_sku_count", "sold_high_performance_sku_count_28d",
      "high_performance_coverage_rate_28d", "key_performer_count", "growth_focus_count",
      "new_opportunity_count", "slow_risk_count", "low_stock_risk_count",
      "availability_status", "quality_status", "reason_code", "metrics_version",
      "country_mapping_set_id", "evidence_json", "calculated_at",
    ], [
      id, input.analysisRunId, input.analysisDate, input.shopId, input.displayName, input.platform,
      input.ownerUserId, input.countryCode, input.ownSalesQuantity7d, input.ownSalesQuantity28d,
      input.validOrderCount7d, input.validOrderCount28d, input.eligibleSaleableSkuCount,
      input.soldEligibleSkuCount28d, input.saleableCoverageRate28d,
      input.eligibleHighPerformanceSkuCount, input.soldHighPerformanceSkuCount28d,
      input.highPerformanceCoverageRate28d, input.keyPerformerCount, input.growthFocusCount,
      input.newOpportunityCount, input.slowRiskCount, input.lowStockRiskCount,
      input.availabilityStatus, input.qualityStatus, input.reasonCode, input.metricsVersion,
      input.countryMappingSetId, JSON.stringify(input.evidence || {}), input.calculatedAt,
    ], client);
    return id;
  }

  async insertShopSkuMetric(input, client = this.provider) {
    const id = input.id || randomUUID();
    await this.insert("growth_shop_sku_daily_metrics", [
      "id", "analysis_run_id", "analysis_date", "internal_shop_id", "country_code",
      "normalized_source_sku", "source_sku", "product_name", "category_l1", "category_l2",
      "mapped_product_id", "own_sales_quantity_7d", "own_sales_quantity_28d",
      "valid_order_count_7d", "valid_order_count_28d", "last_sold_at",
      "source_visible_sales_7d", "source_visible_sales_28d", "source_visible_sales_42d",
      "shop_to_source_visible_ratio_28d", "shop_to_source_visible_ratio_percentile_28d",
      "shop_sales_percentile_28d", "eligible_saleable", "eligible_high_performance",
      "is_key_performer", "is_growth_focus_candidate", "available_quantity",
      "availability_status", "quality_status", "reason_code", "metrics_version",
      "evidence_json", "calculated_at",
    ], [
      id, input.analysisRunId, input.analysisDate, input.shopId, input.countryCode,
      input.sku, input.sourceSku, input.productName, input.categoryL1, input.categoryL2,
      input.mappedProductId, input.ownSalesQuantity7d, input.ownSalesQuantity28d,
      input.validOrderCount7d, input.validOrderCount28d, input.lastSoldAt,
      input.sourceVisibleSales7d, input.sourceVisibleSales28d, input.sourceVisibleSales42d,
      input.shopToSourceVisibleRatio28d, input.shopToSourceVisibleRatioPercentile28d,
      input.shopSalesPercentile28d, input.eligibleSaleable ? 1 : 0,
      input.eligibleHighPerformance ? 1 : 0, input.keyPerformer ? 1 : 0,
      input.growthFocusCandidate ? 1 : 0, input.availableQuantity,
      input.availabilityStatus, input.qualityStatus, input.reasonCode, input.metricsVersion,
      JSON.stringify(input.evidence || {}), input.calculatedAt,
    ], client);
    return id;
  }

  async insertSignal(input, client = this.provider) {
    const id = input.id || randomUUID();
    await this.insert("growth_signals", [
      "id", "analysis_run_id", "dedupe_key", "signal_type", "rule_code", "rule_version",
      "subject_type", "country_code", "source_warehouse_name", "normalized_warehouse_name",
      "normalized_source_sku", "internal_shop_id",
      "severity", "reason_code", "recommended_action_code", "availability_status",
      "quality_status", "evidence_json", "detected_at",
    ], [
      id, input.analysisRunId, input.dedupeKey, input.signalType, input.ruleCode,
      input.ruleVersion, input.subjectType, input.countryCode, input.sourceWarehouseName,
      input.normalizedWarehouseName, input.sku, input.shopId,
      input.severity, input.reasonCode, input.recommendedActionCode,
      input.availabilityStatus, input.qualityStatus, JSON.stringify(input.evidence || {}),
      input.detectedAt,
    ], client);
    return id;
  }

  async writeProjection(runId, projection, { chunkSize = 500 } = {}) {
    const groups = [
      [projection.skuMetrics, (row, client) => this.insertSkuMetric(row, client)],
      [projection.skuWarehouseMetrics, (row, client) => this.insertSkuWarehouseMetric(row, client)],
      [projection.shopMetrics, (row, client) => this.insertShopMetric(row, client)],
      [projection.shopSkuMetrics, (row, client) => this.insertShopSkuMetric(row, client)],
      [projection.signals, (row, client) => this.insertSignal(row, client)],
    ];
    for (const [rows, insert] of groups) {
      for (let offset = 0; offset < rows.length; offset += chunkSize) {
        const chunk = rows.slice(offset, offset + chunkSize);
        await this.provider.transaction(async (client) => {
          for (const row of chunk) await insert({ ...row, analysisRunId: runId }, client);
        });
      }
    }
  }

  async publishRun(id, counts, input) {
    return this.provider.transaction(async (client) => {
      const actual = {};
      for (const [key, table] of [
        ["sku", "growth_sku_daily_metrics"],
        ["skuWarehouse", "growth_sku_warehouse_daily_metrics"],
        ["shop", "growth_shop_daily_metrics"],
        ["shopSku", "growth_shop_sku_daily_metrics"],
        ["signal", "growth_signals"],
      ]) {
        actual[key] = int((await client.query(`SELECT COUNT(*) AS count
          FROM ${this.table(table)}
          WHERE analysis_run_id=${client.placeholder(1)}`, [id])).rows[0]?.count);
      }
      if (actual.sku !== counts.globalSkuCount + counts.countrySkuCount
        || actual.skuWarehouse !== counts.warehouseSkuCount
        || actual.shop !== counts.shopCount
        || actual.shopSku !== counts.shopSkuCount
        || actual.signal !== counts.signalCount) {
        const error = new Error("Growth Radar V2 projection counts do not match the validated result.");
        error.code = "GROWTH_RADAR_V2_COUNT_MISMATCH";
        error.details = { expected: counts, actual };
        throw error;
      }
      return this.updateRun(id, {
        status: "published",
        qualityStatus: input.qualityStatus,
        qualitySummary: input.qualitySummary,
        ...counts,
        validatedAt: input.at,
        publishedAt: input.at,
        finishedAt: input.at,
        updatedAt: input.at,
      }, client);
    });
  }

  async latestPublishedRun(client = this.provider) {
    const row = (await client.query(`SELECT *
      FROM ${this.table("growth_latest_published_run_v")}
      LIMIT 1`)).rows[0];
    return runRow(row);
  }

  async latestAttempt(client = this.provider) {
    const row = (await client.query(`SELECT *
      FROM ${this.table("growth_analysis_runs")}
      ORDER BY created_at DESC,id DESC
      LIMIT 1`)).rows[0];
    return runRow(row);
  }

  async overview(runId, client = this.provider) {
    const signalRows = (await client.query(`SELECT signal_type,rule_code,severity,COUNT(*) AS count
      FROM ${this.table("growth_signals")}
      WHERE analysis_run_id=${client.placeholder(1)}
      GROUP BY signal_type,rule_code,severity
      ORDER BY signal_type,rule_code,severity`, [runId])).rows;
    const inventory = (await client.query(`SELECT
        COUNT(*) AS sku_count,
        SUM(CASE WHEN is_new=1 THEN 1 ELSE 0 END) AS new_sku_count,
        SUM(CASE WHEN quality_status='blocked' THEN 1 ELSE 0 END) AS blocked_sku_count
      FROM ${this.table("growth_sku_daily_metrics")}
      WHERE analysis_run_id=${client.placeholder(1)}
        AND scope_type='global'`, [runId])).rows[0] || {};
    const countryPerformance = (await client.query(`SELECT
        COUNT(*) AS country_sku_count,
        SUM(CASE WHEN assortment_status='ASSORTMENT_VERIFIED_HIGH' THEN 1 ELSE 0 END)
          AS high_performance_count
      FROM ${this.table("growth_sku_daily_metrics")}
      WHERE analysis_run_id=${client.placeholder(1)}
        AND scope_type='country'`, [runId])).rows[0] || {};
    const stores = (await client.query(`SELECT
        COUNT(*) AS shop_count,
        SUM(key_performer_count) AS key_performer_count,
        SUM(growth_focus_count) AS growth_focus_count
      FROM ${this.table("growth_shop_daily_metrics")}
      WHERE analysis_run_id=${client.placeholder(1)}`, [runId])).rows[0] || {};
    const supplyBands = (await client.query(`SELECT
        supply_status AS band,
        COUNT(*) AS count
      FROM ${this.table("growth_sku_warehouse_daily_metrics")}
      WHERE analysis_run_id=${client.placeholder(1)}
      GROUP BY supply_status
      ORDER BY supply_status`, [runId])).rows;
    const categoryPerformance = (await client.query(`SELECT
        COALESCE(NULLIF(category_l2,''),NULLIF(category_l1,''),'未分类') AS category_name,
        COUNT(*) AS sku_count,
        SUM(CASE WHEN is_source_high_performance=1 THEN 1 ELSE 0 END) AS high_performance_count,
        SUM(COALESCE(source_visible_sales_28d,0)) AS source_visible_sales_28d
      FROM ${this.table("growth_sku_daily_metrics")}
      WHERE analysis_run_id=${client.placeholder(1)}
        AND scope_type='global'
      GROUP BY COALESCE(NULLIF(category_l2,''),NULLIF(category_l1,''),'未分类')
      ORDER BY source_visible_sales_28d DESC,high_performance_count DESC,category_name
      LIMIT 8`, [runId])).rows;
    return {
      skuCount: int(inventory.sku_count),
      highPerformanceCount: int(countryPerformance.high_performance_count),
      newSkuCount: int(inventory.new_sku_count),
      blockedSkuCount: int(inventory.blocked_sku_count),
      shopCount: int(stores.shop_count),
      keyPerformerCount: int(stores.key_performer_count),
      growthFocusCount: int(stores.growth_focus_count),
      supplyBands: supplyBands.map((row) => ({ band: row.band, count: int(row.count) })),
      categoryPerformance: categoryPerformance.map((row) => ({
        category: row.category_name,
        skuCount: int(row.sku_count),
        highPerformanceCount: int(row.high_performance_count),
        sourceVisibleSales28d: finite(row.source_visible_sales_28d) ?? 0,
      })),
      signalBreakdown: signalRows.map((row) => ({
        signalType: row.signal_type,
        ruleCode: row.rule_code,
        severity: row.severity,
        count: int(row.count),
      })),
    };
  }

  async directionSummary(runId, client = this.provider) {
    const [
      skuRows,
      warehouseRows,
      shopRows,
      shopSkuRows,
      signalRows,
      countryRows,
      readinessRow,
    ] = await Promise.all([
      client.query(`SELECT *
        FROM ${this.table("growth_sku_daily_metrics")}
        WHERE analysis_run_id=${client.placeholder(1)}
          AND scope_type='country'`, [runId]),
      client.query(`SELECT *
        FROM ${this.table("growth_sku_warehouse_daily_metrics")}
        WHERE analysis_run_id=${client.placeholder(1)}
        ORDER BY country_code,normalized_warehouse_name,normalized_source_sku`, [runId]),
      client.query(`SELECT *
        FROM ${this.table("growth_shop_daily_metrics")}
        WHERE analysis_run_id=${client.placeholder(1)}`, [runId]),
      client.query(`SELECT *
        FROM ${this.table("growth_shop_sku_daily_metrics")}
        WHERE analysis_run_id=${client.placeholder(1)}`, [runId]),
      client.query(`SELECT *
        FROM ${this.table("growth_signals")}
        WHERE analysis_run_id=${client.placeholder(1)}
          AND rule_code IN (${DIRECTION_RULE_CODES.map((_, index) => client.placeholder(index + 2)).join(",")})`,
      [runId, ...DIRECTION_RULE_CODES]),
      client.query(`SELECT DISTINCT mapping.country_code,mapping.country_name
        FROM ${this.table("growth_warehouse_country_mappings")} mapping
        JOIN ${this.table("growth_analysis_runs")} run
          ON run.country_mapping_set_id=mapping.mapping_set_id
        WHERE run.id=${client.placeholder(1)}
          AND mapping.mapping_status='confirmed'
        ORDER BY mapping.country_code`, [runId]),
      client.query(`SELECT
          COUNT(*) AS active_shop_count,
          SUM(CASE WHEN identity_status='confirmed' THEN 1 ELSE 0 END) AS confirmed_shop_count,
          SUM(CASE WHEN identity_status='confirmed'
            AND owner_user_id IS NOT NULL AND owner_user_id<>'' THEN 1 ELSE 0 END) AS manager_configured_shop_count
        FROM ${this.table("growth_shops")}
        WHERE status='active'`),
    ]);
    const metrics = skuRows.rows.map(skuMetricRow);
    const warehouseMetrics = warehouseRows.rows.map(skuWarehouseMetricRow);
    const stores = shopRows.rows.map(shopMetricRow);
    const shopSkuMetrics = shopSkuRows.rows.map(shopSkuMetricRow);
    const signals = signalRows.rows.map(signalRow);
    const countryNames = new Map(countryRows.rows.map((row) => [row.country_code, row.country_name]));

    const ownByCountrySku = new Map();
    for (const item of shopSkuMetrics) {
      const key = `${item.countryCode}\u0000${item.sku}`;
      if (!ownByCountrySku.has(key)) {
        ownByCountrySku.set(key, {
          quantity7: 0,
          quantityPrevious7: 0,
          quantity28: 0,
          sellingShopCount: 0,
        });
      }
      const aggregate = ownByCountrySku.get(key);
      aggregate.quantity7 += item.ownSalesQuantity7d;
      aggregate.quantityPrevious7 += item.ownSalesQuantityPrevious7d;
      aggregate.quantity28 += item.ownSalesQuantity28d;
      if (item.ownSalesQuantity28d > 0) aggregate.sellingShopCount += 1;
    }

    const countryDirectionBySku = new Map();
    const shopDirectionCounts = new Map();
    for (const entry of signals) {
      const code = directionCodeFromSignal(entry);
      if (!code) continue;
      if (entry.shopId) {
        if (!shopDirectionCounts.has(entry.shopId)) shopDirectionCounts.set(entry.shopId, {});
        const counts = shopDirectionCounts.get(entry.shopId);
        counts[code] = (counts[code] || 0) + 1;
      } else if (entry.countryCode && entry.sku) {
        countryDirectionBySku.set(`${entry.countryCode}\u0000${entry.sku}`, {
          code,
          signal: entry,
        });
      }
    }

    const categoryCountry = new Map();
    const skuDirections = metrics.map((metric) => {
      const own = ownByCountrySku.get(`${metric.countryCode}\u0000${metric.sku}`) || {
        quantity7: 0,
        quantityPrevious7: 0,
        quantity28: 0,
        sellingShopCount: 0,
      };
      const direction = countryDirectionBySku.get(`${metric.countryCode}\u0000${metric.sku}`) || null;
      const category = categoryName(metric);
      const groupKey = `${metric.countryCode}\u0000${category}`;
      if (!categoryCountry.has(groupKey)) {
        categoryCountry.set(groupKey, {
          countryCode: metric.countryCode,
          countryName: countryNames.get(metric.countryCode) || metric.countryCode,
          category,
          skuCount: 0,
          verifiedSkuCount: 0,
          forecastDailySales: 0,
          ownSalesQuantity28d: 0,
          quietEntryCount: 0,
          priorityGrowthCount: 0,
          defendWinnerCount: 0,
          supplyConstrainedCount: 0,
        });
      }
      const group = categoryCountry.get(groupKey);
      group.skuCount += 1;
      if (metric.sourcePredictedDailySales > 0) {
        group.verifiedSkuCount += 1;
        group.forecastDailySales += metric.sourcePredictedDailySales;
      }
      group.ownSalesQuantity28d += own.quantity28;
      if (direction?.code === "QUIET_ENTRY") group.quietEntryCount += 1;
      if (direction?.code === "PRIORITY_GROWTH") group.priorityGrowthCount += 1;
      if (direction?.code === "DEFEND_WINNER") group.defendWinnerCount += 1;
      if (direction?.code === "SUPPLY_CONSTRAINED") group.supplyConstrainedCount += 1;
      return {
        countryCode: metric.countryCode,
        countryName: countryNames.get(metric.countryCode) || metric.countryCode,
        category,
        sku: metric.sku,
        sourceSku: metric.sourceSku,
        productName: metric.productName,
        productStatus: metric.productStatus,
        sourcePredictedDailySales: metric.sourcePredictedDailySales,
        forecastPercentile: metric.forecastPercentile,
        forecastRank: metric.forecastRank,
        forecastComparisonSampleSize: metric.forecastComparisonSampleSize,
        availableQuantity: metric.availableQuantity,
        inTransitQuantity: metric.inTransitQuantity,
        forecastCoverageDays: metric.forecastCoverageDays,
        supplyRiskWarehouseCount: metric.supplyRiskWarehouseCount,
        warehouseSupplySummary: metric.warehouseSupplySummary,
        ownSalesQuantity7d: own.quantity7,
        ownSalesQuantityPrevious7d: own.quantityPrevious7,
        ownSalesQuantity28d: own.quantity28,
        ownDailySales28d: own.quantity28 / 28,
        ownCaptureRatio28d: metric.sourcePredictedDailySales > 0
          ? (own.quantity28 / 28) / metric.sourcePredictedDailySales
          : null,
        sellingShopCount: own.sellingShopCount,
        directionCode: direction?.code || null,
        reasonCode: direction?.signal.reasonCode || null,
        recommendedActionCode: direction?.signal.recommendedActionCode || null,
        qualityStatus: metric.qualityStatus,
        evidence: metric.evidence,
      };
    });

    const categoryCountryRows = [...categoryCountry.values()].map((row) => ({
      ...row,
      ownDailySales28d: row.ownSalesQuantity28d / 28,
      ownCaptureRatio28d: row.forecastDailySales > 0
        ? (row.ownSalesQuantity28d / 28) / row.forecastDailySales
        : null,
      actionCount: row.quietEntryCount + row.priorityGrowthCount + row.supplyConstrainedCount,
    })).sort((left, right) => (
      right.actionCount - left.actionCount
      || right.forecastDailySales - left.forecastDailySales
      || left.countryCode.localeCompare(right.countryCode)
      || left.category.localeCompare(right.category)
    ));

    const directionCounts = {
      quietEntry: 0,
      priorityGrowth: 0,
      defendWinner: 0,
      supplyConstrained: 0,
    };
    for (const item of skuDirections) {
      if (item.directionCode === "QUIET_ENTRY") directionCounts.quietEntry += 1;
      if (item.directionCode === "PRIORITY_GROWTH") directionCounts.priorityGrowth += 1;
      if (item.directionCode === "DEFEND_WINNER") directionCounts.defendWinner += 1;
      if (item.directionCode === "SUPPLY_CONSTRAINED") directionCounts.supplyConstrained += 1;
    }

    const shopComparisons = stores.map((store) => {
      const counts = shopDirectionCounts.get(store.shopId) || {};
      return {
        ...store,
        quietEntryCount: counts.QUIET_ENTRY || 0,
        priorityGrowthCount: counts.PRIORITY_GROWTH || 0,
        defendWinnerCount: counts.DEFEND_WINNER || 0,
        supplyConstrainedCount: counts.SUPPLY_CONSTRAINED || 0,
        anomalyCode: store.ownSalesQuantity28d === 0
          ? "NO_VALID_SALES_28D"
          : ((counts.QUIET_ENTRY || 0) + (counts.PRIORITY_GROWTH || 0) > 0
            ? "ATTENTION_GAP"
            : "STABLE"),
      };
    }).sort((left, right) => (
      right.quietEntryCount - left.quietEntryCount
      || right.priorityGrowthCount - left.priorityGrowthCount
      || right.ownSalesQuantity28d - left.ownSalesQuantity28d
    ));

    const managerMap = new Map();
    for (const store of shopComparisons) {
      const manager = store.ownerUserId || "未配置负责人";
      if (!managerMap.has(manager)) {
        managerMap.set(manager, {
          manager,
          shopCount: 0,
          ownSalesQuantity28d: 0,
          quietEntryCount: 0,
          priorityGrowthCount: 0,
          defendWinnerCount: 0,
          supplyConstrainedCount: 0,
        });
      }
      const aggregate = managerMap.get(manager);
      aggregate.shopCount += 1;
      aggregate.ownSalesQuantity28d += store.ownSalesQuantity28d;
      aggregate.quietEntryCount += store.quietEntryCount;
      aggregate.priorityGrowthCount += store.priorityGrowthCount;
      aggregate.defendWinnerCount += store.defendWinnerCount;
      aggregate.supplyConstrainedCount += store.supplyConstrainedCount;
    }

    const readiness = readinessRow.rows[0] || {};
    return {
      directionCounts,
      countries: [...new Set(metrics.map((metric) => metric.countryCode).filter(Boolean))]
        .sort()
        .map((code) => ({ code, name: countryNames.get(code) || code })),
      categories: [...new Set(metrics.map(categoryName))].sort((left, right) => left.localeCompare(right)),
      categoryCountry: categoryCountryRows,
      warehouseRisks: warehouseMetrics
        .filter((metric) => (
          metric.supplyStatus !== "SUPPLY_HEALTHY"
          || !["NORMAL", "NOT_APPLICABLE"].includes(metric.slowMovingStatus)
        ))
        .sort((left, right) => (
          warehouseRiskPriority(right) - warehouseRiskPriority(left)
          || left.countryCode.localeCompare(right.countryCode)
          || left.normalizedWarehouseName.localeCompare(right.normalizedWarehouseName)
          || left.sku.localeCompare(right.sku)
        ))
        .slice(0, 500),
      skuDirections: skuDirections.sort((left, right) => (
        directionPriority(right.directionCode) - directionPriority(left.directionCode)
        || (right.forecastPercentile ?? -1) - (left.forecastPercentile ?? -1)
        || (right.sourcePredictedDailySales ?? -1) - (left.sourcePredictedDailySales ?? -1)
        || left.sku.localeCompare(right.sku)
      )).slice(0, 300),
      shopComparisons,
      managerComparisons: [...managerMap.values()].sort((left, right) => (
        right.quietEntryCount - left.quietEntryCount
        || right.priorityGrowthCount - left.priorityGrowthCount
        || right.ownSalesQuantity28d - left.ownSalesQuantity28d
      )),
      readiness: {
        activeShopCount: int(readiness.active_shop_count),
        confirmedShopCount: int(readiness.confirmed_shop_count),
        managerConfiguredShopCount: int(readiness.manager_configured_shop_count),
        pendingShopCount: Math.max(0, int(readiness.active_shop_count) - int(readiness.confirmed_shop_count)),
        shopComparisonAvailable: stores.length > 0,
      },
    };
  }

  async listSignals(runId, filters = {}, client = this.provider) {
    const { page, pageSize, offset } = pagination(filters);
    const where = [`analysis_run_id=${client.placeholder(1)}`];
    const values = [runId];
    const add = (sql, value) => {
      values.push(value);
      where.push(sql.replace("$P", client.placeholder(values.length)));
    };
    if (filters.signalType) add("signal_type=$P", filters.signalType);
    if (filters.ruleCode) add("rule_code=$P", filters.ruleCode);
    if (filters.severity) add("severity=$P", filters.severity);
    if (filters.shopId) add("internal_shop_id=$P", filters.shopId);
    if (filters.sku) add("normalized_source_sku=$P", filters.sku);
    if (filters.countryCode) add("country_code=$P", filters.countryCode);
    const count = int((await client.query(`SELECT COUNT(*) AS count
      FROM ${this.table("growth_signals")}
      WHERE ${where.join(" AND ")}`, values)).rows[0]?.count);
    const pageValues = [...values, pageSize, offset];
    const rows = (await client.query(`SELECT *
      FROM ${this.table("growth_signals")}
      WHERE ${where.join(" AND ")}
      ORDER BY
        CASE severity WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'warning' THEN 2 ELSE 1 END DESC,
        detected_at DESC,id
      LIMIT ${client.placeholder(values.length + 1)}
      OFFSET ${client.placeholder(values.length + 2)}`, pageValues)).rows;
    return { signals: rows.map(signalRow), total: count, page, pageSize };
  }

  async listAssortment(runId, filters = {}, client = this.provider) {
    const { page, pageSize, offset } = pagination(filters);
    const values = [runId];
    const where = [
      `metric.analysis_run_id=${client.placeholder(1)}`,
      filters.countryCode ? "metric.scope_type='country'" : "metric.scope_type='global'",
    ];
    const add = (sql, value) => {
      values.push(value);
      where.push(sql.replace("$P", client.placeholder(values.length)));
    };
    if (filters.categoryL1) add("metric.category_l1=$P", filters.categoryL1);
    if (filters.categoryL2) add("metric.category_l2=$P", filters.categoryL2);
    if (filters.countryCode) add("metric.country_code=$P", filters.countryCode);
    if (filters.productStatus) add("metric.product_status=$P", filters.productStatus);
    if (filters.qualityStatus) add("metric.quality_status=$P", filters.qualityStatus);
    if (filters.search) {
      const search = `%${filters.search}%`;
      values.push(search, search);
      where.push(`(metric.normalized_source_sku LIKE ${client.placeholder(values.length - 1)}
        OR metric.product_name LIKE ${client.placeholder(values.length)})`);
    }
    if (filters.ruleCode) {
      add(`EXISTS (
        SELECT 1 FROM ${this.table("growth_signals")} signal
        WHERE signal.analysis_run_id=metric.analysis_run_id
          AND signal.normalized_source_sku=metric.normalized_source_sku
          AND signal.internal_shop_id IS NULL
          AND signal.rule_code=$P
      )`, filters.ruleCode);
    }
    const count = int((await client.query(`SELECT COUNT(*) AS count
      FROM ${this.table("growth_sku_daily_metrics")} metric
      WHERE ${where.join(" AND ")}`, values)).rows[0]?.count);
    const rows = (await client.query(`SELECT metric.*
      FROM ${this.table("growth_sku_daily_metrics")} metric
      WHERE ${where.join(" AND ")}
      ORDER BY
        metric.is_source_high_performance DESC,
        metric.demand_percentile_28d DESC,
        metric.source_visible_sales_28d DESC,
        metric.normalized_source_sku
      LIMIT ${client.placeholder(values.length + 1)}
      OFFSET ${client.placeholder(values.length + 2)}`,
    [...values, pageSize, offset])).rows;
    const metrics = rows.map(skuMetricRow);
    const skus = metrics.map((metric) => metric.sku);
    let signals = [];
    if (skus.length) {
      const signalValues = [runId, ...skus];
      const countryWhere = filters.countryCode
        ? ` AND country_code=${client.placeholder(signalValues.length + 1)}`
        : "";
      if (filters.countryCode) signalValues.push(filters.countryCode);
      signals = (await client.query(`SELECT *
        FROM ${this.table("growth_signals")}
        WHERE analysis_run_id=${client.placeholder(1)}
          AND internal_shop_id IS NULL
          AND normalized_source_sku IN (${skus.map((_, index) => client.placeholder(index + 2)).join(",")})
          ${countryWhere}
        ORDER BY normalized_source_sku,rule_code`, signalValues)).rows.map(signalRow);
    }
    const signalsBySku = Map.groupBy ? Map.groupBy(signals, (signal) => signal.sku) : signals.reduce((map, signal) => {
      if (!map.has(signal.sku)) map.set(signal.sku, []);
      map.get(signal.sku).push(signal);
      return map;
    }, new Map());
    return {
      items: metrics.map((metric) => ({ ...metric, signals: signalsBySku.get(metric.sku) || [] })),
      total: count,
      page,
      pageSize,
    };
  }

  async listStores(runId, filters = {}, client = this.provider) {
    const { page, pageSize, offset } = pagination(filters, 250);
    const values = [runId];
    const where = [`analysis_run_id=${client.placeholder(1)}`];
    const add = (column, value) => {
      values.push(value);
      where.push(`${column}=${client.placeholder(values.length)}`);
    };
    if (filters.platform) add("platform", filters.platform);
    if (filters.countryCode) add("country_code", filters.countryCode);
    if (filters.ownerUserId) add("owner_user_id", filters.ownerUserId);
    const count = int((await client.query(`SELECT COUNT(*) AS count
      FROM ${this.table("growth_shop_daily_metrics")}
      WHERE ${where.join(" AND ")}`, values)).rows[0]?.count);
    const rows = (await client.query(`SELECT *
      FROM ${this.table("growth_shop_daily_metrics")}
      WHERE ${where.join(" AND ")}
      ORDER BY growth_focus_count DESC,key_performer_count DESC,own_sales_quantity_28d DESC,display_name
      LIMIT ${client.placeholder(values.length + 1)}
      OFFSET ${client.placeholder(values.length + 2)}`,
    [...values, pageSize, offset])).rows;
    return { stores: rows.map(shopMetricRow), total: count, page, pageSize };
  }

  async storeDetail(runId, shopId, filters = {}, client = this.provider) {
    const store = shopMetricRow((await client.query(`SELECT *
      FROM ${this.table("growth_shop_daily_metrics")}
      WHERE analysis_run_id=${client.placeholder(1)}
        AND internal_shop_id=${client.placeholder(2)}
      LIMIT 1`, [runId, shopId])).rows[0]);
    if (!store) return null;
    const { page, pageSize, offset } = pagination(filters);
    const count = int((await client.query(`SELECT COUNT(*) AS count
      FROM ${this.table("growth_shop_sku_daily_metrics")}
      WHERE analysis_run_id=${client.placeholder(1)}
        AND internal_shop_id=${client.placeholder(2)}`, [runId, shopId])).rows[0]?.count);
    const rows = (await client.query(`SELECT *
      FROM ${this.table("growth_shop_sku_daily_metrics")}
      WHERE analysis_run_id=${client.placeholder(1)}
        AND internal_shop_id=${client.placeholder(2)}
      ORDER BY is_growth_focus_candidate DESC,is_key_performer DESC,own_sales_quantity_28d DESC,normalized_source_sku
      LIMIT ${client.placeholder(3)} OFFSET ${client.placeholder(4)}`,
    [runId, shopId, pageSize, offset])).rows;
    return {
      store,
      items: rows.map(shopSkuMetricRow),
      total: count,
      page,
      pageSize,
    };
  }

  async skuDetail(runId, sku, client = this.provider) {
    const metric = skuMetricRow((await client.query(`SELECT *
      FROM ${this.table("growth_sku_daily_metrics")}
      WHERE analysis_run_id=${client.placeholder(1)}
        AND scope_type='global'
        AND normalized_source_sku=${client.placeholder(2)}
      LIMIT 1`, [runId, sku])).rows[0]);
    if (!metric) return null;
    const countries = (await client.query(`SELECT *
      FROM ${this.table("growth_sku_daily_metrics")}
      WHERE analysis_run_id=${client.placeholder(1)}
        AND scope_type='country'
        AND normalized_source_sku=${client.placeholder(2)}
      ORDER BY source_predicted_daily_sales_country_sku DESC,country_code`,
    [runId, sku])).rows.map(skuMetricRow);
    const warehouses = (await client.query(`SELECT *
      FROM ${this.table("growth_sku_warehouse_daily_metrics")}
      WHERE analysis_run_id=${client.placeholder(1)}
        AND normalized_source_sku=${client.placeholder(2)}
      ORDER BY country_code,normalized_warehouse_name`,
    [runId, sku])).rows.map(skuWarehouseMetricRow);
    const signals = (await client.query(`SELECT *
      FROM ${this.table("growth_signals")}
      WHERE analysis_run_id=${client.placeholder(1)}
        AND normalized_source_sku=${client.placeholder(2)}
      ORDER BY internal_shop_id,rule_code`, [runId, sku])).rows.map(signalRow);
    const stores = (await client.query(`SELECT *
      FROM ${this.table("growth_shop_sku_daily_metrics")}
      WHERE analysis_run_id=${client.placeholder(1)}
        AND normalized_source_sku=${client.placeholder(2)}
      ORDER BY is_growth_focus_candidate DESC,is_key_performer DESC,own_sales_quantity_28d DESC`,
    [runId, sku])).rows.map(shopSkuMetricRow);
    return { metric, countries, warehouses, signals, stores };
  }
}
