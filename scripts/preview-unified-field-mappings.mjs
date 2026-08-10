import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadLocalEnv } from "../lib/env.mjs";
import { PostgresqlProvider } from "../lib/data/postgresql/postgresql-provider.mjs";
import { loadPostgresqlF1Config } from "../lib/postgresql/f1-config.mjs";
import {
  SOURCE_FIELD_CONTRACTS,
  unifiedFieldMappingSummary,
} from "../lib/data-foundation/unified-field-mappings.mjs";
import { DATA_SOURCE_CODES } from "../lib/data-foundation/unified-data-contracts.mjs";
import { normalizeCanonicalShopName } from "../lib/data-foundation/unified-normalizers.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");

function count(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function countRow(row = {}) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, /^\d+$/.test(String(value ?? "")) ? count(value) : value]));
}

function normalizePlatform(value) {
  const key = String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return ({ lazada: "LAZADA", shopee: "SHOPEE", tiktok: "TIKTOK", tiktokshop: "TIKTOK" })[key]
    || String(value || "").trim().toUpperCase();
}

function normalizeName(value) {
  return normalizeCanonicalShopName(value);
}

async function one(provider, sql, parameters = []) {
  return countRow((await provider.query(sql, parameters)).rows[0] || {});
}

async function fieldCoverage(provider, relation, jsonColumn, expectedFields) {
  const [totalResult, result] = await Promise.all([
    provider.query(`SELECT count(*) AS total_rows FROM app.${relation}`),
    provider.query(`
    SELECT field.key AS source_field,
           count(*) AS present_rows,
           count(*) FILTER (
             WHERE field.value = 'null'::jsonb
                 OR btrim(COALESCE(field.value #>> '{}','')) = ''
           ) AS present_but_empty_rows
    FROM app.${relation} source
    CROSS JOIN LATERAL jsonb_each(source.${jsonColumn}::jsonb) field
    GROUP BY field.key
    ORDER BY field.key
  `),
  ]);
  const totalRows = count(totalResult.rows[0]?.total_rows);
  const observed = new Map(result.rows.map((row) => [row.source_field, countRow(row)]));
  const rows = expectedFields.map((sourceField) => {
    const item = observed.get(sourceField) || {};
    const presentRows = count(item.present_rows);
    const missingRows = totalRows - presentRows + count(item.present_but_empty_rows);
    return {
      source_field: sourceField,
      source_rows: totalRows,
      present_rows: presentRows,
      missing_rows: missingRows,
    };
  });
  return { totalRows, rows };
}

function connectorPreview(databasePath, registryRows) {
  if (!fs.existsSync(databasePath)) return null;
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const connectorRows = database.prepare(`
      SELECT shop.id,shop.platform_id,shop.shop_name,shop.seller_id,shop.country,shop.status,
             authorization.shop_id AS authorization_shop_id,
             authorization.expires_at,authorization.token_status
      FROM connector_shops shop
      LEFT JOIN connector_shop_authorizations authorization ON authorization.shop_id=shop.id
    `).all();
    const exact = new Map();
    const byName = new Map();
    const byId = new Map();
    for (const shop of connectorRows) {
      byId.set(String(shop.id), shop);
      const platform = normalizePlatform(shop.platform_id);
      const country = String(shop.country || "").trim().toUpperCase();
      const sellerKey = `${platform}\u0000${country}\u0000${String(shop.seller_id || "").trim()}`;
      if (!exact.has(sellerKey)) exact.set(sellerKey, []);
      exact.get(sellerKey).push(shop);
      const nameKey = `${platform}\u0000${country}\u0000${normalizeName(shop.shop_name)}`;
      if (!byName.has(nameKey)) byName.set(nameKey, []);
      byName.get(nameKey).push(shop);
    }
    let externalIdMatchesIncludingStored = 0;
    let nameOnlyUnique = 0;
    let unmatched = 0;
    let platformIdMismatch = 0;
    let validStoredBindings = 0;
    let invalidStoredBindings = 0;
    let missingWithExternalIdCandidate = 0;
    const usedConnectorIds = new Set();
    for (const shop of registryRows) {
      const platform = normalizePlatform(shop.platform);
      const country = String(shop.source_country_code || "").toUpperCase();
      const platformShopId = String(shop.platform_shop_id || "").trim();
      const exactMatches = platformShopId ? exact.get(`${platform}\u0000${country}\u0000${platformShopId}`) || [] : [];
      const storedConnectorId = String(shop.platform_connector_shop_id || "").trim();
      if (storedConnectorId) {
        const stored = byId.get(storedConnectorId);
        const storedValid = stored
          && normalizePlatform(stored.platform_id) === platform
          && String(stored.country || "").trim().toUpperCase() === country
          && (!platformShopId || String(stored.seller_id || "").trim() === platformShopId);
        if (storedValid) {
          validStoredBindings += 1;
          usedConnectorIds.add(storedConnectorId);
        } else {
          invalidStoredBindings += 1;
        }
      }
      if (exactMatches.length === 1) {
        externalIdMatchesIncludingStored += 1;
        if (!storedConnectorId) missingWithExternalIdCandidate += 1;
        continue;
      }
      const names = byName.get(`${platform}\u0000${country}\u0000${normalizeName(shop.shop_name)}`) || [];
      if (names.length === 1) nameOnlyUnique += 1;
      else unmatched += 1;
      if (platformShopId && exactMatches.length === 0) platformIdMismatch += 1;
    }
    const now = Date.now();
    const connectorApplicationsRelation = Boolean(database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='connector_applications'",
    ).get());
    const legacyTokenRelation = Boolean(database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='lazada_store_tokens'",
    ).get());
    return {
      connectorShops: connectorRows.length,
      registryShops: registryRows.length,
      externalIdMatchesIncludingStored,
      validStoredBindings,
      invalidStoredBindings,
      missingStoredBindings: registryRows.filter((row) => !String(row.platform_connector_shop_id || "").trim()).length,
      missingWithExternalIdCandidate,
      nameOnlyReviewCandidates: nameOnlyUnique,
      registryWithoutCandidate: unmatched,
      reverseUnboundConnectorShops: connectorRows.filter((row) => !usedConnectorIds.has(String(row.id))).length,
      platformIdMismatch,
      activeWithoutAuthorization: connectorRows.filter((row) => row.status === "active" && !row.authorization_shop_id).length,
      expiredMarkedActive: connectorRows.filter((row) => row.token_status === "active"
        && Number.isFinite(Date.parse(row.expires_at || "")) && Date.parse(row.expires_at) <= now).length,
      connectorApplicationsRelation,
      legacyTokenRows: legacyTokenRelation
        ? count(database.prepare("SELECT count(*) AS total FROM lazada_store_tokens").get().total)
        : 0,
    };
  } finally {
    database.close();
  }
}

async function main() {
  loadLocalEnv(rootDir);
  const config = loadPostgresqlF1Config({ rootDir, env: process.env });
  if (config.database !== "commerce_ops") throw new Error("Field mapping preview is restricted to commerce_ops");
  const provider = new PostgresqlProvider({
    config: { ...config, schema: "app", statementTimeoutMs: 180_000 },
    database: config.database,
    user: config.appUser,
    password: config.appPassword,
    readOnly: true,
  });
  try {
    const [
      orderFields,
      inventoryFields,
      productPackageFields,
      orderShop,
      orderProduct,
      orderAmount,
      inventoryProduct,
      inventoryDerived,
      productPackageGrain,
      priceProduct,
      priceShop,
      shops,
      platformApi,
      foundationIdentity,
      registry,
    ] = await Promise.all([
      fieldCoverage(provider, "growth_order_raw_rows", "raw_values_json", SOURCE_FIELD_CONTRACTS[DATA_SOURCE_CODES.MABANG_ORDERS]),
      fieldCoverage(provider, "growth_inventory_raw_rows", "raw_values_json", SOURCE_FIELD_CONTRACTS[DATA_SOURCE_CODES.MABANG_INVENTORY]),
      fieldCoverage(provider, "product_package_rows", "raw_payload_json", SOURCE_FIELD_CONTRACTS[DATA_SOURCE_CODES.PRODUCT_PACKAGE_DB]),
      one(provider, `
        WITH registry_keys AS (
          SELECT upper(platform) platform,
                 lower(btrim(regexp_replace(shop_name,'[[:space:]._-]+',' ','g'))) normalized_shop_name,
                 count(*) candidate_count,min(source_country_code) country_code,
                 count(*) FILTER (WHERE growth_shop_id IS NOT NULL) growth_link_count
          FROM app.commerce_shop_registry WHERE status='ACTIVE'
          GROUP BY upper(platform),lower(btrim(regexp_replace(shop_name,'[[:space:]._-]+',' ','g')))
        ), source_keys AS (
          SELECT CASE regexp_replace(lower(platform),'[^a-z0-9]+','','g')
                   WHEN 'lazada' THEN 'LAZADA' WHEN 'shopee' THEN 'SHOPEE'
                   WHEN 'tiktok' THEN 'TIKTOK' WHEN 'tiktokshop' THEN 'TIKTOK'
                   ELSE upper(btrim(platform)) END platform,
                 lower(btrim(regexp_replace(normalized_source_shop_name,'[[:space:]._-]+',' ','g'))) normalized_shop_name,
                 count(*) header_count
          FROM app.growth_order_headers GROUP BY 1,2
        )
        SELECT count(*) AS source_shop_keys,
               count(*) FILTER (WHERE registry_keys.candidate_count=1) AS unique_candidate_keys,
               count(*) FILTER (WHERE registry_keys.candidate_count=1 AND registry_keys.growth_link_count=1) AS confirmed_existing_link_keys,
               count(*) FILTER (WHERE registry_keys.candidate_count=1 AND registry_keys.growth_link_count=0) AS name_only_review_keys,
               count(*) FILTER (WHERE registry_keys.candidate_count>1) AS ambiguous_candidate_keys,
               count(*) FILTER (WHERE registry_keys.candidate_count IS NULL) AS unmatched_keys,
               COALESCE(sum(source_keys.header_count),0) AS order_headers,
               COALESCE(sum(source_keys.header_count) FILTER (WHERE registry_keys.candidate_count=1),0) AS unique_candidate_headers,
               COALESCE(sum(source_keys.header_count) FILTER (WHERE registry_keys.candidate_count=1 AND registry_keys.growth_link_count=1),0) AS confirmed_existing_link_headers,
               COALESCE(sum(source_keys.header_count) FILTER (WHERE registry_keys.candidate_count=1 AND registry_keys.growth_link_count=0),0) AS name_only_review_headers,
               COALESCE(sum(source_keys.header_count) FILTER (WHERE registry_keys.candidate_count IS NULL),0) AS unmatched_headers
        FROM source_keys LEFT JOIN registry_keys USING(platform,normalized_shop_name)
      `),
      one(provider, `
        WITH registry_keys AS (
          SELECT upper(platform) platform,
                 lower(btrim(regexp_replace(shop_name,'[[:space:]._-]+',' ','g'))) normalized_shop_name,
                 min(source_country_code) country_code,count(*) candidate_count
          FROM app.commerce_shop_registry WHERE status='ACTIVE' GROUP BY 1,2
        ), products AS (
          SELECT upper(btrim(country_raw)) country_code,upper(btrim(sku_code_normalized)) sku,
                 count(*) candidate_count
          FROM app.product_skus
          WHERE source_system='ai_project_a_product_package' AND archived_at IS NULL AND deleted_at IS NULL
          GROUP BY 1,2
        ), candidate_lines AS (
          SELECT line.id,registry_keys.candidate_count shop_candidates,products.candidate_count product_candidates
          FROM app.growth_order_lines line
          JOIN app.growth_order_headers header ON header.id=line.order_header_id
          LEFT JOIN registry_keys
            ON registry_keys.platform=CASE regexp_replace(lower(header.platform),'[^a-z0-9]+','','g')
                 WHEN 'lazada' THEN 'LAZADA' WHEN 'shopee' THEN 'SHOPEE'
                 WHEN 'tiktok' THEN 'TIKTOK' WHEN 'tiktokshop' THEN 'TIKTOK'
                 ELSE upper(btrim(header.platform)) END
           AND registry_keys.normalized_shop_name=lower(btrim(regexp_replace(header.normalized_source_shop_name,'[[:space:]._-]+',' ','g')))
          LEFT JOIN products ON products.country_code=registry_keys.country_code
                            AND products.sku=upper(btrim(line.normalized_source_sku))
          WHERE line.is_current=1
        )
        SELECT count(*) AS current_lines,
               count(*) FILTER (WHERE shop_candidates=1 AND product_candidates=1) AS unique_country_sku_lines,
               count(*) FILTER (WHERE shop_candidates=1 AND product_candidates IS NULL) AS shop_resolved_product_unmatched_lines,
               count(*) FILTER (WHERE shop_candidates IS DISTINCT FROM 1) AS shop_unresolved_lines
        FROM candidate_lines
      `),
      Promise.resolve({}),
      Promise.resolve({}),
      Promise.resolve({}),
      Promise.resolve({}),
      Promise.resolve({}),
      Promise.resolve({}),
      Promise.resolve({}),
      Promise.resolve({}),
      Promise.resolve({}),
      provider.query(`SELECT id,platform,shop_name,source_country_code,platform_shop_id,platform_connector_shop_id FROM app.commerce_shop_registry`)
        .then((result) => result.rows),
    ]);

    // The heavier aggregate queries stay sequential so production receives at
    // most one long scan at a time after the three field-coverage scans above.
    const numeric = (expression) => `CASE WHEN replace(btrim(COALESCE(${expression},'')),',','') ~ '^-?[0-9]+([.][0-9]+)?$' THEN replace(btrim(${expression}),',','')::numeric END`;
    Object.assign(orderAmount, await one(provider, `
      SELECT count(*) FILTER (WHERE line.is_current=1 AND line.line_amount IS NULL) AS missing_line_amount,
             count(*) FILTER (WHERE line.is_current=1 AND line.line_amount IS NULL
               AND ${numeric("raw.raw_values_json::jsonb->>'商品总金额'")} IS NOT NULL) AS direct_recoverable,
             count(*) FILTER (WHERE line.is_current=1 AND line.line_amount IS NULL
               AND ${numeric("raw.raw_values_json::jsonb->>'商品销售单价'")} IS NOT NULL
               AND line.quantity > 0) AS estimate_possible_review_required
      FROM app.growth_order_lines line
      LEFT JOIN app.growth_order_raw_rows raw
        ON raw.batch_id=line.source_batch_id AND raw.source_row_number=line.source_row_number
    `));

    Object.assign(inventoryProduct, await one(provider, `
      WITH latest_batch AS (
        SELECT id FROM app.growth_source_batches
        WHERE source_type='mabang_inventory' AND status='applied'
        ORDER BY COALESCE(collected_at,imported_at,created_at) DESC,id DESC LIMIT 1
      ), package_keys AS (
        SELECT lower(btrim(warehouse_normalized)) warehouse,upper(btrim(sku_normalized)) sku,
               count(DISTINCT product_key) candidate_count
        FROM app.product_package_rows
        WHERE source_system='ai_project_a_product_package'
        GROUP BY 1,2
      )
      SELECT count(*) AS latest_rows,
             count(*) FILTER (WHERE package_keys.candidate_count=1) AS unique_product_candidates,
             count(*) FILTER (WHERE package_keys.candidate_count>1) AS ambiguous_product_candidates,
             count(*) FILTER (WHERE package_keys.candidate_count IS NULL) AS unmatched_product_candidates
      FROM app.growth_inventory_snapshots inventory
      JOIN latest_batch ON latest_batch.id=inventory.batch_id
      LEFT JOIN package_keys ON package_keys.warehouse=lower(btrim(inventory.normalized_warehouse_name))
                            AND package_keys.sku=upper(btrim(inventory.normalized_source_sku))
    `));

    Object.assign(inventoryDerived, await one(provider, `
      SELECT count(*) AS snapshot_rows,
             count(*) FILTER (WHERE inventory.days_of_supply IS NULL) AS missing_days_of_supply,
             count(*) FILTER (WHERE inventory.days_of_supply IS NULL
               AND ${numeric("raw.raw_values_json::jsonb->>'当前可售天数'")} IS NOT NULL) AS direct_days_recoverable,
             count(*) FILTER (WHERE inventory.days_of_supply IS NULL
               AND ${numeric("raw.raw_values_json::jsonb->>'当前可售天数'")} IS NULL) AS source_days_missing,
             count(*) FILTER (WHERE inventory.locked_quantity IS NULL) AS missing_locked_quantity,
             count(*) FILTER (WHERE inventory.sellable_quantity IS NULL) AS missing_sellable_quantity
      FROM app.growth_inventory_snapshots inventory
      LEFT JOIN app.growth_inventory_raw_rows raw
        ON raw.batch_id=inventory.batch_id AND raw.source_row_number=inventory.source_row_number
    `));

    Object.assign(productPackageGrain, await one(provider, `
      WITH product_grouped AS (
        SELECT country_normalized,sku_normalized,count(*) row_count,
               count(DISTINCT warehouse_normalized) warehouses,
               count(DISTINCT ${numeric("raw_payload_json::jsonb->>'sales_cost'")})
                 FILTER (WHERE ${numeric("raw_payload_json::jsonb->>'sales_cost'")} IS NOT NULL) cost_values
        FROM app.product_package_rows
        WHERE source_system='ai_project_a_product_package'
        GROUP BY country_normalized,sku_normalized
      ), warehouse_grouped AS (
        SELECT country_normalized,sku_normalized,warehouse_normalized,
               count(DISTINCT ${numeric("raw_payload_json::jsonb->>'sales_cost'")})
                 FILTER (WHERE ${numeric("raw_payload_json::jsonb->>'sales_cost'")} IS NOT NULL) cost_values
        FROM app.product_package_rows
        WHERE source_system='ai_project_a_product_package'
        GROUP BY country_normalized,sku_normalized,warehouse_normalized
      ), same_warehouse_conflicts AS (
        SELECT country_normalized,sku_normalized,count(*) FILTER (WHERE cost_values>1) conflicting_warehouses
        FROM warehouse_grouped GROUP BY country_normalized,sku_normalized
      )
      SELECT count(*) AS product_keys,
             count(*) FILTER (WHERE row_count>1) AS multi_row_product_keys,
             count(*) FILTER (WHERE warehouses>1) AS multi_warehouse_product_keys,
             count(*) FILTER (WHERE warehouses>1 AND cost_values>1) AS cross_warehouse_cost_variant_products,
             count(*) FILTER (WHERE same_warehouse_conflicts.conflicting_warehouses>0) AS same_warehouse_cost_conflict_product_keys,
             max(row_count) AS max_rows_per_product
      FROM product_grouped
      LEFT JOIN same_warehouse_conflicts USING(country_normalized,sku_normalized)
    `));

    Object.assign(priceProduct, await one(provider, `
      WITH products AS (
        SELECT upper(btrim(country_raw)) country_code,upper(btrim(sku_code_normalized)) sku,count(*) candidate_count
        FROM app.product_skus
        WHERE source_system='ai_project_a_product_package' AND archived_at IS NULL AND deleted_at IS NULL
        GROUP BY 1,2
      ), price_keys AS (
        SELECT upper(btrim(country_code)) country_code,upper(btrim(sku)) sku,count(*) price_rows
        FROM app.product_sku_current_prices GROUP BY 1,2
      )
      SELECT count(*) AS price_product_keys,
             count(*) FILTER (WHERE products.candidate_count=1) AS unique_product_keys,
             count(*) FILTER (WHERE products.candidate_count>1) AS ambiguous_product_keys,
             count(*) FILTER (WHERE products.candidate_count IS NULL) AS unmatched_product_keys,
             COALESCE(sum(price_keys.price_rows) FILTER (WHERE products.candidate_count=1),0) AS unique_product_price_rows,
             COALESCE(sum(price_keys.price_rows) FILTER (WHERE products.candidate_count IS NULL),0) AS unmatched_product_price_rows
      FROM price_keys LEFT JOIN products USING(country_code,sku)
    `));

    Object.assign(priceShop, await one(provider, `
      WITH classified_shops AS (
        SELECT id,platform,source_country_code country_code,control_shop_type,platform_connector_shop_id
        FROM app.commerce_shop_registry
        WHERE status='ACTIVE' AND control_shop_type IN ('STANDARD','MALL','ALL')
      ), prices AS (
        SELECT price.*,EXISTS(
          SELECT 1 FROM classified_shops shop
          WHERE shop.platform=price.platform AND shop.country_code=price.country_code
            AND shop.control_shop_type IN (price.shop_type,'ALL')
        ) has_shop
        FROM app.product_sku_current_prices price
      ), assignments AS (
        SELECT price.price_key,shop.id AS shop_id,shop.platform_connector_shop_id
        FROM app.product_sku_current_prices price
        JOIN classified_shops shop
          ON shop.platform=price.platform AND shop.country_code=price.country_code
         AND shop.control_shop_type IN (price.shop_type,'ALL')
      )
      SELECT count(*) AS price_rows,
             count(*) FILTER (WHERE has_shop) AS price_rows_with_shop_scope,
             count(*) FILTER (WHERE NOT has_shop) AS price_rows_without_shop_scope,
             (SELECT count(*) FROM assignments) AS price_shop_assignments,
             (SELECT count(*) FROM assignments WHERE platform_connector_shop_id IS NOT NULL) AS assignments_with_legacy_connector,
             (SELECT count(*) FROM assignments WHERE platform_connector_shop_id IS NULL) AS assignments_without_legacy_connector
      FROM prices
    `));

    Object.assign(shops, await one(provider, `
      SELECT count(*) AS shops,
             count(*) FILTER (WHERE status='ACTIVE') AS active_shops,
             count(*) FILTER (WHERE currency IS NULL OR btrim(currency)='') AS missing_currency,
             count(*) FILTER (WHERE control_shop_type='UNKNOWN') AS unknown_control_shop_type,
             count(*) FILTER (WHERE platform_connector_shop_id IS NULL OR btrim(platform_connector_shop_id)='') AS missing_connector_id,
             count(*) FILTER (WHERE platform_shop_id IS NULL OR btrim(platform_shop_id)='') AS missing_platform_shop_id,
             count(*) FILTER (WHERE identity_status='REVIEW_REQUIRED') AS review_required
      FROM app.commerce_shop_registry
    `));

    Object.assign(platformApi, await one(provider, `
      SELECT
        (to_regclass('app.platform_api_application_profiles') IS NOT NULL)::int AS api_profiles_relation,
        (to_regclass('app.shop_external_identities') IS NOT NULL)::int AS shop_external_identities_relation,
        (to_regclass('app.data_field_mappings') IS NOT NULL)::int AS field_mapping_relation,
        (SELECT count(*) FROM app.commerce_shop_account_bindings WHERE source_system='platform_gateway') AS platform_gateway_bindings,
        (SELECT count(*) FROM app.commerce_shop_account_bindings WHERE source_system='mabang') AS mabang_bindings
    `));

    Object.assign(foundationIdentity, await one(provider, `
      SELECT
        (SELECT count(*) FROM app.product_identity_mappings) AS product_identity_mappings,
        (SELECT count(*) FROM app.foundation_identity_links
          WHERE entity_type='sku' AND source_system_code='ai_project_a_product_package') AS current_product_sku_links,
        (SELECT count(*) FROM app.foundation_identity_links
          WHERE entity_type='sku' AND source_system_code='company_product_center') AS legacy_product_sku_links
    `));

    const connector = connectorPreview(path.join(rootDir, "storage", "lazada-oauth.sqlite"), registry);
    priceShop.formal_api_executable_assignments = platformApi.platform_gateway_bindings > 0
      ? null
      : 0;
    const allEmpty = (coverage) => coverage.rows.filter((row) => row.missing_rows === row.source_rows)
      .map((row) => row.source_field);
    const partial = (coverage) => coverage.rows.filter((row) => row.missing_rows > 0 && row.missing_rows < row.source_rows)
      .sort((a, b) => b.missing_rows - a.missing_rows);

    return {
      generatedAt: new Date().toISOString(),
      database: config.database,
      readOnly: true,
      productionWrites: 0,
      snapshotConsistency: "BEST_EFFORT_MULTI_QUERY",
      catalog: unifiedFieldMappingSummary(),
      sourceFieldCoverage: {
        auditScope: "ROW_VALUE_COVERAGE_ONLY_FOR_JSON_EVIDENCE_RELATIONS",
        contractOnlySources: ["PRICE_CONTROL_DB", "SHOP_MASTER", "PLATFORM_CONNECTOR"],
        order: {
          sourceRows: orderFields.totalRows,
          contractFieldCount: orderFields.rows.length,
          observedFieldCount: orderFields.rows.filter((row) => row.present_rows > 0).length,
          allEmptyFields: allEmpty(orderFields),
          partialMissingFields: partial(orderFields),
        },
        inventory: {
          sourceRows: inventoryFields.totalRows,
          contractFieldCount: inventoryFields.rows.length,
          observedFieldCount: inventoryFields.rows.filter((row) => row.present_rows > 0).length,
          allEmptyFields: allEmpty(inventoryFields),
          partialMissingFields: partial(inventoryFields),
        },
        productPackage: {
          sourceRows: productPackageFields.totalRows,
          contractFieldCount: productPackageFields.rows.length,
          observedFieldCount: productPackageFields.rows.filter((row) => row.present_rows > 0).length,
          allEmptyFields: allEmpty(productPackageFields),
          partialMissingFields: partial(productPackageFields),
        },
      },
      identityCoverage: { orderShop, orderProduct, inventoryProduct, priceProduct, foundationIdentity },
      factGaps: { orderAmount, inventoryDerived, productPackageGrain, priceShop, shops },
      platformApi,
      connector,
      policy: {
        autoEligible: [
          "库存 raw.当前可售天数 -> days_of_supply（源值直接映射）",
          "最新库存 warehouse+SKU -> 唯一产品包 country+product 候选",
          "控价 country+SKU -> 唯一产品候选",
        ],
        reviewRequired: [
          "订单 platform+店名 -> 店铺候选",
          "Connector 仅名称+国家候选",
          "订单商品销售单价×数量只能作为估算，不能回填 line_amount",
        ],
        neverInfer: ["locked_quantity", "sellable_quantity", "买家PII", "Connector token/secret"],
      },
    };
  } finally {
    await provider.close();
  }
}

main()
  .then((report) => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`))
  .catch((error) => {
    process.stderr.write(`Unified field mapping preview failed: ${String(error?.message || error).split(/\r?\n/)[0].slice(0, 600)}\n`);
    process.exitCode = 1;
  });
