import { SOURCE_SYSTEM_VALUES } from "./unified-data-contracts.mjs";

const CORE_RELATIONS = Object.freeze([
  "app.growth_order_headers",
  "app.growth_order_lines",
  "app.growth_inventory_snapshots",
  "app.product_identity_mappings",
  "app.product_package_rows",
  "app.product_skus",
  "app.product_sku_current_prices",
  "app.commerce_shop_registry",
  "app.commerce_shop_account_bindings",
  "app.foundation_identity_links",
  "app.platform_api_application_profiles",
  "app.shop_external_identities",
]);

function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function countFields(row = {}) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, number(value)]));
}

function gap({ severity, code, relation, count = 0, message, nextAction }) {
  return Object.freeze({ severity, code, relation, count: number(count), message, nextAction });
}

async function one(provider, sql, parameters = []) {
  const result = await provider.query(sql, parameters);
  return result.rows[0] || {};
}

async function relationStatus(provider) {
  const values = CORE_RELATIONS.map((relation) => `('${relation}')`).join(",");
  const result = await provider.query(`
    /* unified-data-audit:relations */
    SELECT candidate.relation_name, to_regclass(candidate.relation_name)::text AS resolved_name
    FROM (VALUES ${values}) AS candidate(relation_name)
    ORDER BY candidate.relation_name
  `);
  return Object.fromEntries(result.rows.map((row) => [row.relation_name, Boolean(row.resolved_name)]));
}

function available(relations, ...names) {
  return names.every((name) => relations[name]);
}

export function summarizeUnifiedDataAudit({ relations, metrics, connector = null, auditedAt = new Date().toISOString() }) {
  const gaps = [];
  for (const [relation, exists] of Object.entries(relations)) {
    if (!exists && !new Set([
      "app.platform_api_application_profiles",
      "app.shop_external_identities",
    ]).has(relation)) {
      gaps.push(gap({
        severity: "BLOCKER",
        code: "CORE_RELATION_MISSING",
        relation,
        message: "统一数据合同依赖的核心关系不存在。",
        nextAction: "先完成结构迁移，再发布对应数据集。",
      }));
    }
  }

  const orderHeaders = metrics.orderHeaders || {};
  const orderLines = metrics.orderLines || {};
  if (number(orderHeaders.missing_shop) > 0) gaps.push(gap({
    severity: "BLOCKER", code: "ORDER_SHOP_IDENTITY_MISSING", relation: "app.growth_order_headers",
    count: orderHeaders.missing_shop, message: "订单尚未映射到统一店铺。", nextAction: "确认店铺外部身份后回填 canonical shop。",
  }));
  if (number(orderLines.missing_product) > 0) gaps.push(gap({
    severity: "BLOCKER", code: "ORDER_PRODUCT_IDENTITY_MISSING", relation: "app.growth_order_lines",
    count: orderLines.missing_product, message: "当前订单行尚未映射到统一产品。", nextAction: "重建 country + SKU 产品身份映射。",
  }));
  if (number(orderLines.missing_line_amount) > 0) gaps.push(gap({
    severity: "ERROR", code: "ORDER_LINE_AMOUNT_MISSING", relation: "app.growth_order_lines",
    count: orderLines.missing_line_amount, message: "订单行金额缺失，不能用不存在的产品包价格静默替代。", nextAction: "补采订单行金额或批准可审计的订单头分摊规则。",
  }));
  if (number(orderLines.unconfirmed_line_amount) > 0) gaps.push(gap({
    severity: "ERROR", code: "ORDER_LINE_AMOUNT_UNCONFIRMED", relation: "app.growth_order_lines",
    count: orderLines.unconfirmed_line_amount, message: "订单行金额已有源值，但币种或金额口径尚未确认，不能发布为正式 GMV。", nextAction: "确认商品总金额的币种与行级语义后，再把状态升级为 confirmed。",
  }));

  const inventory = metrics.inventory || {};
  if (number(inventory.missing_product) > 0) gaps.push(gap({
    severity: "BLOCKER", code: "INVENTORY_PRODUCT_IDENTITY_MISSING", relation: "app.growth_inventory_snapshots",
    count: inventory.missing_product, message: "马帮库存尚未映射到统一产品。", nextAction: "使用同一产品身份桥回填库存。",
  }));
  if (number(inventory.missing_sellable) > 0 || number(inventory.missing_days_of_supply) > 0) gaps.push(gap({
    severity: "WARNING", code: "INVENTORY_DERIVED_FIELDS_MISSING", relation: "app.growth_inventory_snapshots",
    count: Math.max(number(inventory.missing_sellable), number(inventory.missing_days_of_supply)),
    message: "可售量或可售天数缺失，源字段与派生字段语义尚未分开。",
    nextAction: "登记公式版本，并把源缺失与不可计算分开标记。",
  }));
  if (number(inventory.unconfirmed_days_of_supply) > 0) gaps.push(gap({
    severity: "WARNING", code: "INVENTORY_DAYS_OF_SUPPLY_UNCONFIRMED", relation: "app.growth_inventory_snapshots",
    count: inventory.unconfirmed_days_of_supply,
    message: "可售天数已有来源值，但语义状态尚未确认。",
    nextAction: "核对来源字段定义和快照粒度后，再把可售天数状态升级为 confirmed。",
  }));

  const identity = metrics.productIdentity || {};
  if (number(identity.mapping_rows) === 0) gaps.push(gap({
    severity: "BLOCKER", code: "PRODUCT_IDENTITY_BRIDGE_EMPTY", relation: "app.product_identity_mappings",
    message: "产品身份桥为空，是订单和库存无法关联产品包的直接原因。", nextAction: "按新产品包源重建映射并通过冲突队列确认。",
  }));
  if (number(identity.new_foundation_sku_links) < number(identity.new_product_skus)) gaps.push(gap({
    severity: "BLOCKER", code: "FOUNDATION_PRODUCT_IDENTITY_STALE", relation: "app.foundation_identity_links",
    count: number(identity.new_product_skus) - number(identity.new_foundation_sku_links),
    message: "Foundation 产品身份仍落在旧 source_system。", nextAction: "注册新来源并重建 Foundation identity links。",
  }));

  const shops = metrics.shops || {};
  if (number(shops.missing_connector) > 0) gaps.push(gap({
    severity: "BLOCKER", code: "SHOP_CONNECTOR_IDENTITY_MISSING", relation: "app.commerce_shop_registry",
    count: shops.missing_connector, message: "店铺明细没有 Connector 外部身份。", nextAction: "写入候选身份桥，唯一候选仍需确认后才能绑定授权。",
  }));
  if (number(shops.missing_currency) > 0 || number(shops.unknown_control_type) > 0) gaps.push(gap({
    severity: "ERROR", code: "SHOP_CONTROL_SCOPE_INCOMPLETE", relation: "app.commerce_shop_registry",
    count: Math.max(number(shops.missing_currency), number(shops.unknown_control_type)),
    message: "币种或控价店铺类型缺失，控价无法可靠落到店铺。", nextAction: "建立 provider_shop_type 代码映射并补齐币种。",
  }));
  if (number(shops.country_conflicts) > 0) gaps.push(gap({
    severity: "BLOCKER", code: "SHOP_COUNTRY_CONFLICT", relation: "app.commerce_shop_registry",
    count: shops.country_conflicts, message: "店铺明细国家与 Growth 店铺国家冲突。", nextAction: "以店铺明细为主数据，Growth 仅保留模块投影。",
  }));

  const price = metrics.priceCoverage || {};
  if (number(price.unmatched_price_rows) > 0) gaps.push(gap({
    severity: "ERROR", code: "PRICE_PRODUCT_IDENTITY_MISSING", relation: "app.product_sku_current_prices",
    count: price.unmatched_price_rows, message: "控价 country + SKU 无法关联当前产品主数据。", nextAction: "进入产品映射队列，不以名称临时拼接。",
  }));

  const timezone = metrics.timezone || {};
  if (number(timezone.product_package_checked_after_finish) > 0 || number(timezone.price_checked_after_finish) > 0) gaps.push(gap({
    severity: "ERROR", code: "SYNC_TIMESTAMP_TIMEZONE_DRIFT", relation: "app.product_package_sync_runs, app.price_control_sync_runs",
    count: number(timezone.product_package_checked_after_finish) + number(timezone.price_checked_after_finish),
    message: "源检查时间晚于任务结束，存在本地时间被当 UTC 的约八小时偏移。", nextAction: "入口显式解析 Asia/Shanghai 后统一写 UTC。",
  }));

  if (!relations["app.platform_api_application_profiles"]) gaps.push(gap({
    severity: "BLOCKER", code: "PLATFORM_API_CONFIG_RELATION_MISSING", relation: "app.platform_api_application_profiles",
    message: "平台 API 应用仍是环境变量和 authorization.application_id 自由文本。", nextAction: "应用候选迁移并建立 account -> profile -> shop binding。",
  }));
  if (!relations["app.shop_external_identities"]) gaps.push(gap({
    severity: "BLOCKER", code: "SHOP_EXTERNAL_IDENTITY_RELATION_MISSING", relation: "app.shop_external_identities",
    message: "跨 PostgreSQL/Connector 的店铺身份没有受约束桥表。", nextAction: "建立外部身份候选、人工确认和强校验绑定。",
  }));

  if (connector) {
    if (number(connector.active_without_authorization) > 0) gaps.push(gap({
      severity: "ERROR", code: "ACTIVE_SHOP_WITHOUT_AUTHORIZATION", relation: "connector_shop_authorizations",
      count: connector.active_without_authorization, message: "活跃 Connector 店铺没有授权。", nextAction: "补授权或将店铺标记为不可执行。",
    }));
    if (number(connector.expired_marked_active) > 0) gaps.push(gap({
      severity: "ERROR", code: "CONNECTOR_TOKEN_STATUS_STALE", relation: "connector_shop_authorizations",
      count: connector.expired_marked_active, message: "授权实际过期但状态仍为 active。", nextAction: "以过期时间派生健康状态并同步回控制面。",
    }));
    if (!connector.application_table_present) gaps.push(gap({
      severity: "BLOCKER", code: "CONNECTOR_APPLICATION_TABLE_MISSING", relation: "connector_applications",
      message: "Connector 缺少应用配置表，application_id 无外键。", nextAction: "建立非秘密应用目录并约束 authorization.application_id。",
    }));
    if (number(connector.legacy_lazada_token_duplicates) > 0) gaps.push(gap({
      severity: "WARNING", code: "LEGACY_TOKEN_DUPLICATION", relation: "lazada_store_tokens",
      count: connector.legacy_lazada_token_duplicates, message: "Legacy Token 与新授权表重复保存。", nextAction: "确认读路径后受控归档旧敏感表。",
    }));
  }

  const rank = { BLOCKER: 0, ERROR: 1, WARNING: 2, INFO: 3 };
  gaps.sort((left, right) => rank[left.severity] - rank[right.severity] || right.count - left.count || left.code.localeCompare(right.code));
  return Object.freeze({
    auditedAt,
    readOnly: true,
    relations,
    metrics,
    connector,
    summary: {
      blockerCount: gaps.filter((item) => item.severity === "BLOCKER").length,
      errorCount: gaps.filter((item) => item.severity === "ERROR").length,
      warningCount: gaps.filter((item) => item.severity === "WARNING").length,
    },
    gaps,
  });
}

export async function auditUnifiedDataFoundation({ provider, connector = null, auditedAt = new Date().toISOString() } = {}) {
  if (!provider || typeof provider.query !== "function") throw new TypeError("database provider is required");
  const relations = await relationStatus(provider);
  const metrics = {};

  if (available(relations, "app.growth_order_headers")) {
    metrics.orderHeaders = countFields(await one(provider, `
      /* unified-data-audit:order-headers */
      SELECT count(*) AS total,
             count(*) FILTER (WHERE internal_shop_id IS NULL) AS missing_shop,
             count(*) FILTER (WHERE mapped_country IS NULL OR btrim(mapped_country) = '') AS missing_country
      FROM app.growth_order_headers
    `));
  }
  if (available(relations, "app.growth_order_lines")) {
    metrics.orderLines = countFields(await one(provider, `
      /* unified-data-audit:order-lines */
      SELECT count(*) FILTER (WHERE is_current = 1) AS current_rows,
             count(*) FILTER (WHERE is_current = 1 AND mapped_product_id IS NULL) AS missing_product,
             count(*) FILTER (WHERE is_current = 1 AND mapped_country IS NULL) AS missing_country,
             count(*) FILTER (WHERE is_current = 1 AND (
               line_amount IS NULL OR line_amount_status = 'unavailable'
             )) AS missing_line_amount,
             count(*) FILTER (WHERE is_current = 1 AND line_amount IS NOT NULL
               AND line_amount_status = 'unconfirmed') AS unconfirmed_line_amount,
             count(*) FILTER (WHERE is_current = 1 AND line_amount IS NOT NULL
               AND line_amount_status = 'confirmed') AS confirmed_line_amount
      FROM app.growth_order_lines
    `));
  }
  if (available(relations, "app.growth_inventory_snapshots")) {
    metrics.inventory = countFields(await one(provider, `
      /* unified-data-audit:inventory */
      SELECT count(*) AS total,
             count(*) FILTER (WHERE mapped_product_id IS NULL) AS missing_product,
             count(*) FILTER (WHERE available_quantity IS NULL) AS missing_available,
             count(*) FILTER (WHERE sellable_quantity IS NULL) AS missing_sellable,
             count(*) FILTER (WHERE days_of_supply IS NULL
               OR days_of_supply_status = 'unavailable') AS missing_days_of_supply,
             count(*) FILTER (WHERE days_of_supply IS NOT NULL
               AND days_of_supply_status = 'unconfirmed') AS unconfirmed_days_of_supply,
             count(*) FILTER (WHERE days_of_supply IS NOT NULL
               AND days_of_supply_status = 'confirmed') AS confirmed_days_of_supply,
             count(*) FILTER (WHERE snapshot_at IS NULL) AS missing_snapshot_at
      FROM app.growth_inventory_snapshots
    `));
  }
  if (available(relations, "app.product_identity_mappings", "app.product_skus", "app.foundation_identity_links")) {
    metrics.productIdentity = countFields(await one(provider, `
      /* unified-data-audit:product-identity */
      SELECT
        (SELECT count(*) FROM app.product_identity_mappings) AS mapping_rows,
        (SELECT count(*) FROM app.product_skus WHERE source_system = '${SOURCE_SYSTEM_VALUES.PRODUCT_PACKAGE}' AND deleted_at IS NULL) AS new_product_skus,
        (SELECT count(*) FROM app.foundation_identity_links WHERE source_system_code = '${SOURCE_SYSTEM_VALUES.PRODUCT_PACKAGE}' AND entity_type = 'sku') AS new_foundation_sku_links,
        (SELECT count(*) FROM app.foundation_identity_links WHERE source_system_code = 'company_product_center' AND entity_type = 'sku') AS legacy_foundation_sku_links
    `));
  }
  if (available(relations, "app.product_package_rows")) {
    metrics.productPackage = countFields(await one(provider, `
      /* unified-data-audit:product-package */
      SELECT count(*) AS total,
             count(*) FILTER (WHERE source_system = '${SOURCE_SYSTEM_VALUES.PRODUCT_PACKAGE}') AS authoritative_rows,
             count(*) FILTER (WHERE source_system = 'company_product_center') AS legacy_rows,
             count(*) FILTER (WHERE btrim(source_row_key) = '') AS missing_source_row_key,
             count(*) FILTER (WHERE btrim(product_key) = '') AS missing_product_key,
             count(*) FILTER (WHERE btrim(country_normalized) = '') AS missing_country,
             count(*) FILTER (WHERE btrim(sku_normalized) = '') AS missing_sku
      FROM app.product_package_rows
    `));
  }
  if (available(relations, "app.commerce_shop_registry")) {
    metrics.shops = countFields(await one(provider, `
      /* unified-data-audit:shops */
      SELECT count(*) AS total,
             count(*) FILTER (WHERE growth_shop_id IS NULL) AS missing_growth,
             count(*) FILTER (WHERE platform_connector_shop_id IS NULL OR btrim(platform_connector_shop_id) = '') AS missing_connector,
             count(*) FILTER (WHERE currency IS NULL OR btrim(currency) = '') AS missing_currency,
             count(*) FILTER (WHERE control_shop_type = 'UNKNOWN') AS unknown_control_type,
             count(*) FILTER (WHERE growth_shop_id IS NOT NULL AND EXISTS (
               SELECT 1 FROM app.growth_shops growth
               WHERE growth.id = commerce_shop_registry.growth_shop_id
                 AND growth.country_code <> commerce_shop_registry.source_country_code
             )) AS country_conflicts
      FROM app.commerce_shop_registry
    `));
  }
  if (available(relations, "app.product_sku_current_prices", "app.product_skus")) {
    metrics.priceCoverage = countFields(await one(provider, `
      /* unified-data-audit:price-product-coverage */
      WITH price AS (
        SELECT country_code, upper(btrim(sku)) AS sku, count(*) AS price_rows
        FROM app.product_sku_current_prices
        GROUP BY country_code, upper(btrim(sku))
      ), product AS (
        SELECT DISTINCT country_raw AS country_code, upper(btrim(source_sku)) AS sku
        FROM app.product_skus
        WHERE source_system = '${SOURCE_SYSTEM_VALUES.PRODUCT_PACKAGE}'
          AND archived_at IS NULL AND deleted_at IS NULL
      )
      SELECT count(*) AS price_sku_keys,
             count(*) FILTER (WHERE product.sku IS NULL) AS unmatched_sku_keys,
             COALESCE(sum(price.price_rows) FILTER (WHERE product.sku IS NULL), 0) AS unmatched_price_rows
      FROM price LEFT JOIN product USING (country_code, sku)
    `));
  }
  if (available(relations, "app.product_package_rows", "app.product_sku_current_prices")) {
    metrics.timezone = countFields(await one(provider, `
      /* unified-data-audit:timezone */
      SELECT
        (SELECT count(*) FROM app.product_package_sync_runs WHERE source_checked_at IS NOT NULL AND finished_at IS NOT NULL AND source_checked_at > finished_at) AS product_package_checked_after_finish,
        (SELECT count(*) FROM app.price_control_sync_runs WHERE source_checked_at IS NOT NULL AND finished_at IS NOT NULL AND source_checked_at > finished_at) AS price_checked_after_finish
    `));
  }

  return summarizeUnifiedDataAudit({ relations, metrics, connector, auditedAt });
}
