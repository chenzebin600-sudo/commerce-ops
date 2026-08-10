import { randomUUID } from "node:crypto";
import { DATABASE_DIALECTS, assertDatabaseProvider } from "../database-provider.mjs";
import { PRODUCT_PACKAGE_SOURCE_SYSTEM } from "../../data-foundation/unified-data-contracts.mjs";

const COUNTRY_ALIASES = Object.freeze({
  TH: ["TH", "泰国", "THAILAND"],
  PH: ["PH", "菲律宾", "PHILIPPINES"],
  MY: ["MY", "马来", "马来西亚", "MALAYSIA"],
  ID: ["ID", "印尼", "印度尼西亚", "INDONESIA"],
  VN: ["VN", "越南", "VIETNAM"],
});
const COUNTRY_BY_ALIAS = new Map(Object.entries(COUNTRY_ALIASES)
  .flatMap(([code, aliases]) => aliases.map((alias) => [alias.toLocaleUpperCase("en-US"), code])));

function canonicalCountry(value) {
  const normalized = String(value || "").normalize("NFKC").trim().toLocaleUpperCase("en-US");
  return COUNTRY_BY_ALIAS.get(normalized) || normalized;
}

function json(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function number(value) {
  return value === null || value === undefined || value === "" ? null : Number(value);
}

function page(input, fallback = 1) {
  return Math.max(1, Math.floor(Number(input) || fallback));
}

function pageSize(input, fallback = 30, max = 200) {
  return Math.min(max, Math.max(1, Math.floor(Number(input) || fallback)));
}

function batchRow(row) {
  if (!row) return null;
  const sourceScope = json(row.source_scope_json, {});
  const confirmed = (row.source_scope_status || "unconfirmed") === "confirmed" && row.status === "applied";
  return {
    id: row.id,
    sourceType: row.source_type,
    sourceModule: row.source_module,
    sourceFileId: row.source_file_id || null,
    sourceFilename: row.source_filename || null,
    sourceSha256: row.source_sha256,
    sourceAccountId: row.source_account_id || null,
    idempotencyKey: row.idempotency_key,
    queryStartedAt: row.query_started_at || null,
    queryEndedAt: row.query_ended_at || null,
    collectedAt: row.collected_at || null,
    importedAt: row.imported_at || null,
    sourceSystem: String(row.source_module || "").startsWith("mabang_") ? "mabang" : row.source_module,
    sourceFile: row.source_filename || null,
    sourceBatch: row.id,
    snapshotAt: row.source_type === "mabang_inventory" ? row.collected_at || null : null,
    dataWindowStart: row.query_started_at || null,
    dataWindowEnd: row.query_ended_at || null,
    shopScope: sourceScope.shopScope || [],
    countryScope: sourceScope.countryScope || (sourceScope.countryCode ? [sourceScope.countryCode] : []),
    warehouseScope: sourceScope.warehouseScope || [],
    semanticScope: sourceScope.semanticScope || [],
    sourceScope,
    sourceScopeStatus: row.source_scope_status || "unconfirmed",
    confirmationStatus: confirmed ? "confirmed" : "unconfirmed",
    confirmedBy: confirmed ? row.created_by : null,
    confirmedAt: confirmed ? row.imported_at || row.updated_at : null,
    sourceHeaders: json(row.source_headers_json, []),
    redactedHeaders: json(row.redacted_headers_json, []),
    piiFilteredFieldCount: Number(row.pii_filtered_field_count || 0),
    rowCount: Number(row.row_count || 0),
    status: row.status,
    errorCode: row.error_code || null,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function shopRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    internalShopCode: row.internal_shop_code,
    displayName: row.display_name,
    platform: row.platform,
    countryCode: row.country_code,
    countryName: row.country_name,
    ownerUserId: row.owner_user_id || null,
    primaryCategoryScope: json(row.primary_category_scope_json, []),
    status: row.status,
    identityStatus: row.identity_status,
    confirmationStatus: row.identity_status === "confirmed" ? "confirmed" : "pending",
    revision: Number(row.revision || 1),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function shopMappingRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    sourceSystem: row.source_system,
    sourceShopName: row.source_shop_name,
    normalizedSourceShopName: row.normalized_source_shop_name,
    internalShopId: row.internal_shop_id || null,
    platform: row.platform,
    countryCode: row.country_code || null,
    mappingStatus: row.mapping_status,
    mappingSource: row.mapping_source,
    confirmationStatus: row.shop_identity_status === "confirmed"
      && ["matched", "manually_confirmed"].includes(row.mapping_status) ? "confirmed" : "pending",
    firstSourceBatchId: row.first_source_batch_id || null,
    lastSourceBatchId: row.last_source_batch_id || null,
    confirmedBy: row.confirmed_by || null,
    confirmedAt: row.confirmed_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    shop: row.shop_id ? {
      id: row.shop_id,
      internalShopCode: row.internal_shop_code,
      displayName: row.display_name,
      platform: row.shop_platform,
      countryCode: row.shop_country_code,
      countryName: row.country_name,
      ownerUserId: row.owner_user_id || null,
      status: row.shop_status,
      identityStatus: row.shop_identity_status,
      confirmationStatus: row.shop_identity_status === "confirmed" ? "confirmed" : "pending",
    } : null,
  };
}

function qualityIssueRow(row) {
  if (!row) return null;
  const context = json(row.source_context_json, {});
  return {
    id: row.id,
    batchId: row.batch_id,
    entityType: row.entity_type,
    entityId: row.entity_id || null,
    issueCode: row.issue_code,
    code: row.issue_code,
    severity: row.severity,
    affectedCount: Number(context.affectedCount || 1),
    sampleRows: Array.isArray(context.sampleRows) ? context.sampleRows.slice(0, 5) : [],
    blocking: context.blocking === true || row.severity === "blocker",
    recommendedAction: context.recommendedAction || "review_source_data",
    message: row.message,
    sourceContext: context,
    status: row.status,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at || null,
  };
}

function productMappingRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    sourceSystem: row.source_system,
    sourceSku: row.source_sku,
    normalizedSourceSku: row.normalized_source_sku,
    platform: row.platform,
    countryCode: row.country_code,
    internalProductId: row.internal_product_id || null,
    internalSku: row.internal_sku || null,
    mainSku: row.main_sku || null,
    mappingStatus: row.mapping_status,
    mappingSource: row.mapping_source,
    confidence: number(row.confidence),
    firstSourceBatchId: row.first_source_batch_id || null,
    lastSourceBatchId: row.last_source_batch_id || null,
    confirmedBy: row.confirmed_by || null,
    confirmedAt: row.confirmed_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function orderHeaderRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    businessKey: row.business_key,
    businessKeyVersion: row.business_key_version,
    platform: row.platform,
    sourceShopName: row.source_shop_name,
    normalizedSourceShopName: row.normalized_source_shop_name,
    internalShopId: row.internal_shop_id || null,
    mappedCountry: row.mapped_country || null,
    sourceOrderId: row.source_order_id,
    orderStatus: row.order_status,
    paidAt: row.paid_at || null,
    cancelledAt: row.cancelled_at || null,
    orderCurrency: row.order_currency || null,
    orderAmount: number(row.order_amount),
    orderAmountSourceField: row.order_amount_source_field || null,
    originalProductAmountLocal: row.original_product_amount_local === null || row.original_product_amount_local === undefined
      ? null : String(row.original_product_amount_local),
    discountAmountLocal: row.discount_amount_local === null || row.discount_amount_local === undefined
      ? null : String(row.discount_amount_local),
    gmvSourceStatus: row.gmv_source_status || "MISSING",
    gmvSourceRuleVersion: row.gmv_source_rule_version || null,
    effectiveStatus: row.effective_status,
    firstSourceBatchId: row.first_source_batch_id,
    sourceBatchId: row.source_batch_id,
    sourceQualityStatus: row.source_quality_status,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    revision: Number(row.revision || 1),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function orderLineRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    orderHeaderId: row.order_header_id,
    firstSourceBatchId: row.first_source_batch_id,
    sourceBatchId: row.source_batch_id,
    sourceRowNumber: Number(row.source_row_number),
    sourceLineKey: row.source_line_key,
    sourceLineKeyVersion: row.source_line_key_version,
    lineOccurrence: Number(row.line_occurrence),
    dedupeConfidence: row.dedupe_confidence,
    sourceSku: row.source_sku,
    normalizedSourceSku: row.normalized_source_sku,
    platformSku: row.platform_sku || null,
    sourceWarehouseName: row.source_warehouse_name || null,
    normalizedSourceWarehouseName: row.normalized_source_warehouse_name || null,
    mappedProductId: row.mapped_product_id || null,
    mappedCountry: row.mapped_country || null,
    quantity: number(row.quantity),
    lineAmount: number(row.line_amount),
    lineAmountStatus: row.line_amount_status,
    productName: row.product_name || null,
    mappingStatus: row.mapping_status,
    effectiveStatus: row.effective_status,
    isCurrent: Boolean(row.is_current),
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    revision: Number(row.revision || 1),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function issueRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    issueKey: row.issue_key,
    issueType: row.issue_type,
    sourceBatchId: row.source_batch_id,
    sourceRowId: row.source_row_id || null,
    sourceValue: row.source_value,
    candidateValues: json(row.candidate_values_json, []),
    reason: row.reason,
    status: row.status,
    resolvedValue: row.resolved_value || null,
    resolvedBy: row.resolved_by || null,
    resolvedAt: row.resolved_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class GrowthRadarRepository {
  constructor({ provider }) {
    this.provider = assertDatabaseProvider(provider);
    this.prefix = provider.dialect === DATABASE_DIALECTS.POSTGRESQL ? "app." : "";
  }

  table(name) { return `${this.prefix}${name}`; }

  async getBatch(id, client = this.provider) {
    const row = (await client.query(`SELECT * FROM ${this.table("growth_source_batches")} WHERE id=${client.placeholder(1)}`, [id])).rows[0];
    return batchRow(row);
  }

  async getBatchByIdempotency(sourceType, idempotencyKey, client = this.provider) {
    const rows = await client.query(`SELECT * FROM ${this.table("growth_source_batches")}
      WHERE source_type=${client.placeholder(1)} AND idempotency_key=${client.placeholder(2)} LIMIT 1`, [sourceType, idempotencyKey]);
    return batchRow(rows.rows[0]);
  }

  async latestAppliedBatch(sourceType, client = this.provider) {
    const rows = await client.query(`SELECT * FROM ${this.table("growth_source_batches")}
      WHERE source_type=${client.placeholder(1)} AND status='applied'
      ORDER BY COALESCE(imported_at,collected_at,created_at) DESC,id DESC LIMIT 1`, [sourceType]);
    return batchRow(rows.rows[0]);
  }

  async currentOrderBatch(client = this.provider) {
    const rows = await client.query(`SELECT b.* FROM ${this.table("growth_source_batches")} b
      JOIN ${this.table("growth_order_lines")} l ON l.source_batch_id=b.id AND l.is_current=1
      WHERE b.source_type='mabang_order' AND b.status='applied'
      GROUP BY b.id ORDER BY COALESCE(b.imported_at,b.created_at) DESC,COUNT(l.id) DESC,b.id DESC LIMIT 1`);
    return batchRow(rows.rows[0]);
  }

  async createBatch(input, client = this.provider) {
    const values = [
      input.id, input.sourceType, input.sourceModule, input.sourceFileId, input.sourceFilename,
      input.sourceSha256, input.sourceAccountId, input.idempotencyKey, input.queryStartedAt,
      input.queryEndedAt, input.collectedAt, input.importedAt, JSON.stringify(input.sourceScope || {}),
      input.sourceScopeStatus || "unconfirmed", JSON.stringify(input.sourceHeaders || []), JSON.stringify(input.redactedHeaders || []),
      input.piiFilteredFieldCount || 0,
      input.rowCount, input.status, input.errorCode, input.createdBy, input.createdAt, input.updatedAt,
    ];
    const placeholders = values.map((_, index) => client.placeholder(index + 1));
    await client.execute(`INSERT INTO ${this.table("growth_source_batches")} (
      id,source_type,source_module,source_file_id,source_filename,source_sha256,source_account_id,idempotency_key,
      query_started_at,query_ended_at,collected_at,imported_at,source_scope_json,source_scope_status,source_headers_json,
      redacted_headers_json,pii_filtered_field_count,row_count,status,error_code,created_by,created_at,updated_at
    ) VALUES (${placeholders.join(",")})`, values);
    return this.getBatch(input.id, client);
  }

  async updateBatch(id, input, client = this.provider) {
    await client.execute(`UPDATE ${this.table("growth_source_batches")} SET status=${client.placeholder(1)},
      imported_at=${client.placeholder(2)},error_code=${client.placeholder(3)},source_scope_status=${client.placeholder(4)},
      updated_at=${client.placeholder(5)} WHERE id=${client.placeholder(6)}`,
    [input.status, input.importedAt, input.errorCode, input.sourceScopeStatus || "unconfirmed", input.updatedAt, id]);
    return this.getBatch(id, client);
  }

  async insertOrderRaw(input, client = this.provider) {
    const id = input.id || randomUUID();
    await client.execute(`INSERT INTO ${this.table("growth_order_raw_rows")} (
      id,batch_id,sheet_name,source_row_number,raw_values_json,raw_types_json,redacted_fields_json,row_hash,parse_status,created_at
    ) VALUES (${Array.from({ length: 10 }, (_, index) => client.placeholder(index + 1)).join(",")})`, [
      id, input.batchId, input.sheetName, input.sourceRowNumber, JSON.stringify(input.rawValues),
      JSON.stringify(input.rawTypes), JSON.stringify(input.redactedFields || []), input.rowHash, input.parseStatus, input.createdAt,
    ]);
    return id;
  }

  async insertInventoryRaw(input, client = this.provider) {
    const id = input.id || randomUUID();
    await client.execute(`INSERT INTO ${this.table("growth_inventory_raw_rows")} (
      id,batch_id,sheet_name,source_row_number,raw_values_json,raw_types_json,redacted_fields_json,row_hash,parse_status,created_at
    ) VALUES (${Array.from({ length: 10 }, (_, index) => client.placeholder(index + 1)).join(",")})`, [
      id, input.batchId, input.sheetName, input.sourceRowNumber, JSON.stringify(input.rawValues),
      JSON.stringify(input.rawTypes), JSON.stringify(input.redactedFields || []), input.rowHash, input.parseStatus, input.createdAt,
    ]);
    return id;
  }

  async getOrderHeaderByKey(version, businessKey, client = this.provider) {
    const rows = await client.query(`SELECT * FROM ${this.table("growth_order_headers")}
      WHERE business_key_version=${client.placeholder(1)} AND business_key=${client.placeholder(2)} LIMIT 1`, [version, businessKey]);
    return orderHeaderRow(rows.rows[0]);
  }

  async insertOrderHeader(input, client = this.provider) {
    const values = [
      input.id, input.businessKey, input.businessKeyVersion, input.platform, input.sourceShopName,
      input.normalizedSourceShopName, input.internalShopId, input.mappedCountry, input.sourceOrderId,
      input.orderStatus, input.paidAt, input.cancelledAt, input.orderCurrency, input.orderAmount,
      input.orderAmountSourceField, input.originalProductAmountLocal, input.discountAmountLocal,
      input.gmvSourceStatus, input.gmvSourceRuleVersion, input.effectiveStatus, input.firstSourceBatchId, input.sourceBatchId,
      input.sourceQualityStatus, input.firstSeenAt, input.lastSeenAt, input.createdAt, input.updatedAt,
    ];
    await client.execute(`INSERT INTO ${this.table("growth_order_headers")} (
      id,business_key,business_key_version,platform,source_shop_name,normalized_source_shop_name,
      internal_shop_id,mapped_country,source_order_id,order_status,paid_at,cancelled_at,order_currency,
      order_amount,order_amount_source_field,original_product_amount_local,discount_amount_local,
      gmv_source_status,gmv_source_rule_version,effective_status,first_source_batch_id,source_batch_id,
      source_quality_status,first_seen_at,last_seen_at,created_at,updated_at
    ) VALUES (${values.map((_, index) => client.placeholder(index + 1)).join(",")})`, values);
    return this.getOrderHeaderByKey(input.businessKeyVersion, input.businessKey, client);
  }

  async updateOrderHeader(input, client = this.provider) {
    const values = [
      input.internalShopId, input.mappedCountry, input.orderStatus, input.paidAt, input.cancelledAt,
      input.orderCurrency, input.orderAmount, input.orderAmountSourceField, input.originalProductAmountLocal,
      input.discountAmountLocal, input.gmvSourceStatus, input.gmvSourceRuleVersion, input.effectiveStatus,
      input.sourceBatchId, input.sourceQualityStatus, input.lastSeenAt, input.updatedAt, input.id,
    ];
    await client.execute(`UPDATE ${this.table("growth_order_headers")} SET
      internal_shop_id=${client.placeholder(1)},mapped_country=${client.placeholder(2)},order_status=${client.placeholder(3)},
      paid_at=${client.placeholder(4)},cancelled_at=${client.placeholder(5)},order_currency=${client.placeholder(6)},
      order_amount=${client.placeholder(7)},order_amount_source_field=${client.placeholder(8)},
      original_product_amount_local=${client.placeholder(9)},discount_amount_local=${client.placeholder(10)},
      gmv_source_status=${client.placeholder(11)},gmv_source_rule_version=${client.placeholder(12)},effective_status=${client.placeholder(13)},
      source_batch_id=${client.placeholder(14)},source_quality_status=${client.placeholder(15)},last_seen_at=${client.placeholder(16)},
      updated_at=${client.placeholder(17)},revision=revision+1 WHERE id=${client.placeholder(18)}`, values);
    return this.getOrderHeaderByKey(input.businessKeyVersion, input.businessKey, client);
  }

  async setOrderLinesNotCurrent(orderHeaderId, client = this.provider) {
    return client.execute(`UPDATE ${this.table("growth_order_lines")} SET is_current=0
      WHERE order_header_id=${client.placeholder(1)} AND is_current=1`, [orderHeaderId]);
  }

  async getOrderLineByKey(version, sourceLineKey, client = this.provider) {
    const rows = await client.query(`SELECT * FROM ${this.table("growth_order_lines")}
      WHERE source_line_key_version=${client.placeholder(1)} AND source_line_key=${client.placeholder(2)} LIMIT 1`, [version, sourceLineKey]);
    return orderLineRow(rows.rows[0]);
  }

  async insertOrderLine(input, client = this.provider) {
    const values = [
      input.id, input.orderHeaderId, input.firstSourceBatchId, input.sourceBatchId, input.sourceRowNumber,
      input.sourceLineKey, input.sourceLineKeyVersion, input.lineOccurrence, input.dedupeConfidence,
      input.sourceSku, input.normalizedSourceSku, input.platformSku, input.sourceWarehouseName,
      input.normalizedSourceWarehouseName, input.mappedProductId, input.mappedCountry,
      input.quantity, input.lineAmount, input.lineAmountStatus, input.productName, input.mappingStatus,
      input.effectiveStatus, 1, input.firstSeenAt, input.lastSeenAt, input.createdAt, input.updatedAt,
    ];
    await client.execute(`INSERT INTO ${this.table("growth_order_lines")} (
      id,order_header_id,first_source_batch_id,source_batch_id,source_row_number,source_line_key,source_line_key_version,
      line_occurrence,dedupe_confidence,source_sku,normalized_source_sku,platform_sku,source_warehouse_name,
      normalized_source_warehouse_name,mapped_product_id,mapped_country,
      quantity,line_amount,line_amount_status,product_name,mapping_status,effective_status,is_current,
      first_seen_at,last_seen_at,created_at,updated_at
    ) VALUES (${values.map((_, index) => client.placeholder(index + 1)).join(",")})`, values);
    return this.getOrderLineByKey(input.sourceLineKeyVersion, input.sourceLineKey, client);
  }

  async updateOrderLine(input, client = this.provider) {
    const values = [
      input.sourceBatchId, input.sourceRowNumber, input.sourceWarehouseName, input.normalizedSourceWarehouseName,
      input.mappedProductId, input.mappedCountry, input.quantity,
      input.lineAmount, input.lineAmountStatus, input.productName, input.mappingStatus, input.effectiveStatus,
      input.lastSeenAt, input.updatedAt, input.id,
    ];
    await client.execute(`UPDATE ${this.table("growth_order_lines")} SET
      source_batch_id=${client.placeholder(1)},source_row_number=${client.placeholder(2)},
      source_warehouse_name=${client.placeholder(3)},normalized_source_warehouse_name=${client.placeholder(4)},
      mapped_product_id=${client.placeholder(5)},mapped_country=${client.placeholder(6)},quantity=${client.placeholder(7)},
      line_amount=${client.placeholder(8)},line_amount_status=${client.placeholder(9)},product_name=${client.placeholder(10)},
      mapping_status=${client.placeholder(11)},effective_status=${client.placeholder(12)},is_current=1,
      last_seen_at=${client.placeholder(13)},updated_at=${client.placeholder(14)},revision=revision+1
      WHERE id=${client.placeholder(15)}`, values);
    return this.getOrderLineByKey(input.sourceLineKeyVersion, input.sourceLineKey, client);
  }

  async productCandidates(normalizedSku, countryCode = null, client = this.provider) {
    const parameters = [normalizedSku];
    const sourcePlaceholder = client.placeholder(2);
    parameters.push(PRODUCT_PACKAGE_SOURCE_SYSTEM);
    let where = `UPPER(TRIM(sku_code_normalized))=${client.placeholder(1)}
      AND source_system=${sourcePlaceholder} AND archived_at IS NULL AND deleted_at IS NULL`;
    if (countryCode) {
      const canonical = canonicalCountry(countryCode);
      const aliases = COUNTRY_ALIASES[canonical] || [canonical];
      const placeholders = aliases.map((alias) => {
        parameters.push(alias.toLocaleUpperCase("en-US"));
        return client.placeholder(parameters.length);
      });
      where += ` AND UPPER(TRIM(country_raw)) IN (${placeholders.join(",")})`;
    }
    const rows = await client.query(`SELECT id,source_sku,sku_code_normalized,country_raw,source_main_sku,source_product_name
      FROM ${this.table("product_skus")} WHERE ${where} ORDER BY country_raw,id`, parameters);
    return rows.rows.map((row) => ({
      id: row.id,
      sku: row.source_sku,
      normalizedSku: row.sku_code_normalized,
      countryCode: canonicalCountry(row.country_raw),
      mainSku: row.source_main_sku || null,
      productName: row.source_product_name,
    }));
  }

  async productCandidateSummaries(normalizedSkus, client = this.provider) {
    const skus = [...new Set((normalizedSkus || [])
      .map((value) => String(value || "").trim().toLocaleUpperCase("en-US"))
      .filter(Boolean))];
    const summaries = [];
    for (let offset = 0; offset < skus.length; offset += 500) {
      const chunk = skus.slice(offset, offset + 500);
      const parameters = [PRODUCT_PACKAGE_SOURCE_SYSTEM, ...chunk];
      const skuPlaceholders = chunk.map((_, index) => client.placeholder(index + 2));
      const result = await client.query(`SELECT UPPER(TRIM(sku_code_normalized)) normalized_sku,
        COUNT(*) candidate_count,COUNT(DISTINCT UPPER(TRIM(country_raw))) country_count
        FROM ${this.table("product_skus")}
        WHERE source_system=${client.placeholder(1)} AND archived_at IS NULL AND deleted_at IS NULL
          AND UPPER(TRIM(sku_code_normalized)) IN (${skuPlaceholders.join(",")})
        GROUP BY UPPER(TRIM(sku_code_normalized))`, parameters);
      summaries.push(...result.rows.map((row) => ({
        normalizedSku: row.normalized_sku,
        candidateCount: Number(row.candidate_count || 0),
        countryCount: Number(row.country_count || 0),
      })));
    }
    return summaries;
  }

  async getShop(id, client = this.provider) {
    const row = (await client.query(`SELECT * FROM ${this.table("growth_shops")} WHERE id=${client.placeholder(1)}`, [id])).rows[0];
    return shopRow(row);
  }

  async getShopByCode(internalShopCode, client = this.provider) {
    const row = (await client.query(`SELECT * FROM ${this.table("growth_shops")}
      WHERE internal_shop_code=${client.placeholder(1)} LIMIT 1`, [internalShopCode])).rows[0];
    return shopRow(row);
  }

  async createShop(input, client = this.provider) {
    const values = [input.id, input.internalShopCode, input.displayName, input.platform, input.countryCode,
      input.countryName, input.ownerUserId, JSON.stringify(input.primaryCategoryScope || []), input.status,
      input.identityStatus, input.createdAt, input.updatedAt];
    await client.execute(`INSERT INTO ${this.table("growth_shops")} (
      id,internal_shop_code,display_name,platform,country_code,country_name,owner_user_id,
      primary_category_scope_json,status,identity_status,created_at,updated_at
    ) VALUES (${values.map((_, index) => client.placeholder(index + 1)).join(",")})`, values);
    return this.getShop(input.id, client);
  }

  async updateShop(input, client = this.provider) {
    await client.execute(`UPDATE ${this.table("growth_shops")} SET display_name=${client.placeholder(1)},
      platform=${client.placeholder(2)},country_code=${client.placeholder(3)},country_name=${client.placeholder(4)},
      owner_user_id=${client.placeholder(5)},primary_category_scope_json=${client.placeholder(6)},status=${client.placeholder(7)},
      identity_status=${client.placeholder(8)},updated_at=${client.placeholder(9)},revision=revision+1
      WHERE id=${client.placeholder(10)}`, [input.displayName, input.platform, input.countryCode, input.countryName,
      input.ownerUserId, JSON.stringify(input.primaryCategoryScope || []), input.status, input.identityStatus, input.updatedAt, input.id]);
    return this.getShop(input.id, client);
  }

  async getShopMapping(sourceSystem, platform, normalizedSourceShopName, client = this.provider) {
    const rows = await client.query(`SELECT m.*,s.id AS shop_id,s.internal_shop_code,s.display_name,s.platform AS shop_platform,
      s.country_code AS shop_country_code,s.country_name,s.owner_user_id,s.status AS shop_status,
      s.identity_status AS shop_identity_status
      FROM ${this.table("growth_shop_source_mappings")} m
      LEFT JOIN ${this.table("growth_shops")} s ON s.id=m.internal_shop_id
      WHERE m.source_system=${client.placeholder(1)} AND m.platform=${client.placeholder(2)}
        AND m.normalized_source_shop_name=${client.placeholder(3)} LIMIT 1`, [sourceSystem, platform, normalizedSourceShopName]);
    return shopMappingRow(rows.rows[0]);
  }

  async getShopMappingById(id, client = this.provider) {
    const rows = await client.query(`SELECT m.*,s.id AS shop_id,s.internal_shop_code,s.display_name,s.platform AS shop_platform,
      s.country_code AS shop_country_code,s.country_name,s.owner_user_id,s.status AS shop_status,
      s.identity_status AS shop_identity_status
      FROM ${this.table("growth_shop_source_mappings")} m
      LEFT JOIN ${this.table("growth_shops")} s ON s.id=m.internal_shop_id
      WHERE m.id=${client.placeholder(1)} LIMIT 1`, [id]);
    return shopMappingRow(rows.rows[0]);
  }

  async shopMappingsForShop(shopId, client = this.provider) {
    const rows = await client.query(`SELECT m.*,s.id AS shop_id,s.internal_shop_code,s.display_name,s.platform AS shop_platform,
      s.country_code AS shop_country_code,s.country_name,s.owner_user_id,s.status AS shop_status,
      s.identity_status AS shop_identity_status
      FROM ${this.table("growth_shop_source_mappings")} m
      JOIN ${this.table("growth_shops")} s ON s.id=m.internal_shop_id
      WHERE m.internal_shop_id=${client.placeholder(1)} ORDER BY m.created_at,m.id`, [shopId]);
    return rows.rows.map(shopMappingRow);
  }

  async updatePendingShopMappingScope(shopId, input, client = this.provider) {
    await client.execute(`UPDATE ${this.table("growth_shop_source_mappings")} SET platform=${client.placeholder(1)},
      country_code=${client.placeholder(2)},updated_at=${client.placeholder(3)}
      WHERE internal_shop_id=${client.placeholder(4)} AND mapping_status NOT IN ('matched','manually_confirmed')`,
    [input.platform, input.countryCode, input.updatedAt, shopId]);
  }

  async upsertShopMapping(input, client = this.provider) {
    const existing = await this.getShopMapping(input.sourceSystem, input.platform, input.normalizedSourceShopName, client);
    if (existing) {
      await client.execute(`UPDATE ${this.table("growth_shop_source_mappings")} SET source_shop_name=${client.placeholder(1)},
        internal_shop_id=${client.placeholder(2)},country_code=${client.placeholder(3)},mapping_status=${client.placeholder(4)},
        mapping_source=${client.placeholder(5)},last_source_batch_id=${client.placeholder(6)},confirmed_by=${client.placeholder(7)},
        confirmed_at=${client.placeholder(8)},updated_at=${client.placeholder(9)} WHERE id=${client.placeholder(10)}`,
      [input.sourceShopName, input.internalShopId, input.countryCode, input.mappingStatus, input.mappingSource,
        input.lastSourceBatchId, input.confirmedBy, input.confirmedAt, input.updatedAt, existing.id]);
      return this.getShopMappingById(existing.id, client);
    }
    const id = input.id || randomUUID();
    const values = [id, input.sourceSystem, input.sourceShopName, input.normalizedSourceShopName, input.internalShopId,
      input.platform, input.countryCode, input.mappingStatus, input.mappingSource, input.firstSourceBatchId,
      input.lastSourceBatchId, input.confirmedBy, input.confirmedAt, input.createdAt, input.updatedAt];
    await client.execute(`INSERT INTO ${this.table("growth_shop_source_mappings")} (
      id,source_system,source_shop_name,normalized_source_shop_name,internal_shop_id,platform,country_code,
      mapping_status,mapping_source,first_source_batch_id,last_source_batch_id,confirmed_by,confirmed_at,created_at,updated_at
    ) VALUES (${values.map((_, index) => client.placeholder(index + 1)).join(",")})`, values);
    return this.getShopMappingById(id, client);
  }

  async getProductMapping(sourceSystem, platform, countryCode, normalizedSourceSku, client = this.provider) {
    const rows = await client.query(`SELECT * FROM ${this.table("product_identity_mappings")}
      WHERE source_system=${client.placeholder(1)} AND platform=${client.placeholder(2)}
        AND country_code=${client.placeholder(3)} AND normalized_source_sku=${client.placeholder(4)} LIMIT 1`,
    [sourceSystem, platform, countryCode, normalizedSourceSku]);
    return productMappingRow(rows.rows[0]);
  }

  async getProductMappingById(id, client = this.provider) {
    const row = (await client.query(`SELECT * FROM ${this.table("product_identity_mappings")} WHERE id=${client.placeholder(1)}`, [id])).rows[0];
    return productMappingRow(row);
  }

  async upsertProductMapping(input, client = this.provider) {
    const existing = await this.getProductMapping(input.sourceSystem, input.platform, input.countryCode, input.normalizedSourceSku, client);
    if (existing) {
      await client.execute(`UPDATE ${this.table("product_identity_mappings")} SET source_sku=${client.placeholder(1)},
        internal_product_id=${client.placeholder(2)},internal_sku=${client.placeholder(3)},main_sku=${client.placeholder(4)},
        mapping_status=${client.placeholder(5)},mapping_source=${client.placeholder(6)},confidence=${client.placeholder(7)},
        last_source_batch_id=${client.placeholder(8)},confirmed_by=${client.placeholder(9)},confirmed_at=${client.placeholder(10)},
        updated_at=${client.placeholder(11)} WHERE id=${client.placeholder(12)}`, [input.sourceSku, input.internalProductId,
        input.internalSku, input.mainSku, input.mappingStatus, input.mappingSource, input.confidence, input.lastSourceBatchId,
        input.confirmedBy, input.confirmedAt, input.updatedAt, existing.id]);
      return this.getProductMappingById(existing.id, client);
    }
    const id = input.id || randomUUID();
    const values = [id, input.sourceSystem, input.sourceSku, input.normalizedSourceSku, input.platform, input.countryCode,
      input.internalProductId, input.internalSku, input.mainSku, input.mappingStatus, input.mappingSource, input.confidence,
      input.firstSourceBatchId, input.lastSourceBatchId, input.confirmedBy, input.confirmedAt, input.createdAt, input.updatedAt];
    await client.execute(`INSERT INTO ${this.table("product_identity_mappings")} (
      id,source_system,source_sku,normalized_source_sku,platform,country_code,internal_product_id,internal_sku,main_sku,
      mapping_status,mapping_source,confidence,first_source_batch_id,last_source_batch_id,confirmed_by,confirmed_at,created_at,updated_at
    ) VALUES (${values.map((_, index) => client.placeholder(index + 1)).join(",")})`, values);
    return this.getProductMappingById(id, client);
  }

  async updateLineIdentity(id, input, client = this.provider) {
    await client.execute(`UPDATE ${this.table("growth_order_lines")} SET mapped_product_id=${client.placeholder(1)},
      mapped_country=${client.placeholder(2)},mapping_status=${client.placeholder(3)},updated_at=${client.placeholder(4)},revision=revision+1
      WHERE id=${client.placeholder(5)}`, [input.mappedProductId, input.mappedCountry, input.mappingStatus, input.updatedAt, id]);
  }

  async updateOrderShop(id, input, client = this.provider) {
    await client.execute(`UPDATE ${this.table("growth_order_headers")} SET internal_shop_id=${client.placeholder(1)},
      mapped_country=${client.placeholder(2)},updated_at=${client.placeholder(3)},revision=revision+1
      WHERE id=${client.placeholder(4)}`, [input.internalShopId, input.mappedCountry, input.updatedAt, id]);
  }

  async ordersForSourceShop(platform, normalizedSourceShopName, client = this.provider) {
    const rows = await client.query(`SELECT * FROM ${this.table("growth_order_headers")}
      WHERE platform=${client.placeholder(1)} AND normalized_source_shop_name=${client.placeholder(2)}`, [platform, normalizedSourceShopName]);
    return rows.rows.map(orderHeaderRow);
  }

  async currentLinesForOrder(orderHeaderId, client = this.provider) {
    const rows = await client.query(`SELECT * FROM ${this.table("growth_order_lines")}
      WHERE order_header_id=${client.placeholder(1)} AND is_current=1 ORDER BY source_row_number`, [orderHeaderId]);
    return rows.rows.map(orderLineRow);
  }

  async currentLinesForIdentity(platform, countryCode, normalizedSourceSku, client = this.provider) {
    const rows = await client.query(`SELECT l.* FROM ${this.table("growth_order_lines")} l
      JOIN ${this.table("growth_order_headers")} h ON h.id=l.order_header_id
      WHERE h.platform=${client.placeholder(1)} AND h.mapped_country=${client.placeholder(2)}
        AND l.normalized_source_sku=${client.placeholder(3)} AND l.is_current=1`, [platform, countryCode, normalizedSourceSku]);
    return rows.rows.map(orderLineRow);
  }

  async unresolvedProductLineCount(normalizedSourceSku, client = this.provider) {
    const row = (await client.query(`SELECT COUNT(*) AS total FROM ${this.table("growth_order_lines")}
      WHERE normalized_source_sku=${client.placeholder(1)} AND is_current=1
        AND mapping_status NOT IN ('matched','manually_confirmed')`, [normalizedSourceSku])).rows[0];
    return Number(row?.total || 0);
  }

  async unresolvedShopMappingCount(normalizedSourceShopName, client = this.provider) {
    const row = (await client.query(`SELECT COUNT(*) AS total FROM ${this.table("growth_shop_source_mappings")}
      WHERE normalized_source_shop_name=${client.placeholder(1)}
        AND mapping_status NOT IN ('matched','manually_confirmed')`, [normalizedSourceShopName])).rows[0];
    return Number(row?.total || 0);
  }

  async upsertMappingIssue(input, client = this.provider) {
    const existing = (await client.query(`SELECT id FROM ${this.table("growth_mapping_issues")}
      WHERE issue_key=${client.placeholder(1)} LIMIT 1`, [input.issueKey])).rows[0];
    if (existing) {
      await client.execute(`UPDATE ${this.table("growth_mapping_issues")} SET candidate_values_json=${client.placeholder(1)},
        reason=${client.placeholder(2)},status=${client.placeholder(3)},resolved_value=${client.placeholder(4)},
        resolved_by=${client.placeholder(5)},resolved_at=${client.placeholder(6)},updated_at=${client.placeholder(7)}
        WHERE id=${client.placeholder(8)}`, [JSON.stringify(input.candidateValues || []), input.reason, input.status,
        input.resolvedValue ?? null, input.resolvedBy ?? null, input.resolvedAt ?? null, input.updatedAt, existing.id]);
      return existing.id;
    }
    const id = input.id || randomUUID();
    const values = [id, input.issueKey, input.issueType, input.sourceBatchId, input.sourceRowId ?? null, input.sourceValue,
      JSON.stringify(input.candidateValues || []), input.reason, input.status || "open", input.resolvedValue,
      input.resolvedBy, input.resolvedAt, input.createdAt, input.updatedAt].map((value) => value ?? null);
    await client.execute(`INSERT INTO ${this.table("growth_mapping_issues")} (
      id,issue_key,issue_type,source_batch_id,source_row_id,source_value,candidate_values_json,reason,status,
      resolved_value,resolved_by,resolved_at,created_at,updated_at
    ) VALUES (${values.map((_, index) => client.placeholder(index + 1)).join(",")})`, values);
    return id;
  }

  async resolveMappingIssues(issueTypes, sourceValue, resolvedValue, actor, at, client = this.provider) {
    if (!issueTypes.length) return;
    const typePlaceholders = issueTypes.map((_, index) => client.placeholder(index + 1));
    const values = [...issueTypes, sourceValue, resolvedValue, actor, at, at];
    await client.execute(`UPDATE ${this.table("growth_mapping_issues")} SET status='resolved',
      resolved_value=${client.placeholder(issueTypes.length + 2)},resolved_by=${client.placeholder(issueTypes.length + 3)},
      resolved_at=${client.placeholder(issueTypes.length + 4)},updated_at=${client.placeholder(issueTypes.length + 5)}
      WHERE issue_type IN (${typePlaceholders.join(",")})
        AND UPPER(TRIM(source_value))=UPPER(TRIM(${client.placeholder(issueTypes.length + 1)})) AND status='open'`, values);
  }

  async upsertQualityIssue(input, client = this.provider) {
    const existing = (await client.query(`SELECT id FROM ${this.table("growth_data_quality_issues")}
      WHERE issue_key=${client.placeholder(1)} LIMIT 1`, [input.issueKey])).rows[0];
    if (existing) return existing.id;
    const id = input.id || randomUUID();
    const values = [id, input.issueKey, input.batchId, input.entityType, input.entityId, input.issueCode,
      input.severity, input.message, JSON.stringify(input.sourceContext || {}), input.status || "open", input.createdAt];
    await client.execute(`INSERT INTO ${this.table("growth_data_quality_issues")} (
      id,issue_key,batch_id,entity_type,entity_id,issue_code,severity,message,source_context_json,status,created_at
    ) VALUES (${values.map((_, index) => client.placeholder(index + 1)).join(",")})`, values);
    return id;
  }

  async insertInventorySnapshot(input, client = this.provider) {
    const id = input.id || randomUUID();
    const values = [id, input.batchId, input.sourceRowNumber, input.sourceSku, input.normalizedSourceSku,
      input.mappedProductId, input.warehouseName, input.availableQuantity, input.physicalQuantity, input.lockedQuantity,
      input.inTransitQuantity, input.pendingShipmentQuantity, input.transferPendingShipmentQuantity,
      input.sellableQuantity ?? null,
      input.sellableQuantityStatus || "unconfirmed", input.sourcePredictedDailySales,
      input.predictedDailySalesSemanticStatus, input.daysOfSupply ?? null,
      input.daysOfSupplyStatus || "unavailable", input.snapshotAt, input.mappingStatus,
      input.qualityStatus, input.createdAt, input.normalizedWarehouseName, input.productStatus,
      input.categoryLevel1, input.categoryLevel2, input.categoryLevel3, input.sourceVisibleSales7d,
      input.sourceVisibleSales28d, input.sourceVisibleSales42d, input.sourceScopeStatus || "unconfirmed"];
    await client.execute(`INSERT INTO ${this.table("growth_inventory_snapshots")} (
      id,batch_id,source_row_number,source_sku,normalized_source_sku,mapped_product_id,warehouse_name,
      available_quantity,physical_quantity,locked_quantity,in_transit_quantity,pending_shipment_quantity,
      transfer_pending_shipment_quantity,
      sellable_quantity,sellable_quantity_status,source_predicted_daily_sales,predicted_daily_sales_semantic_status,
      days_of_supply,days_of_supply_status,snapshot_at,mapping_status,quality_status,created_at,
      normalized_warehouse_name,product_status,category_level_1,category_level_2,category_level_3,
      source_visible_sales_7d,source_visible_sales_28d,source_visible_sales_42d,source_scope_status
    ) VALUES (${values.map((_, index) => client.placeholder(index + 1)).join(",")})`, values);
    return id;
  }

  async inventorySnapshotsForBatch(batchId, client = this.provider) {
    const rows = await client.query(`SELECT * FROM ${this.table("growth_inventory_snapshots")}
      WHERE batch_id=${client.placeholder(1)} ORDER BY source_row_number,id`, [batchId]);
    return rows.rows;
  }

  async currentOrderLinesForLinkage(client = this.provider) {
    const rows = await client.query(`SELECT l.id AS order_line_id,l.source_batch_id AS order_source_batch_id,
      l.normalized_source_sku,l.normalized_source_warehouse_name,l.effective_status AS order_effective_status,
      h.id AS order_header_id,h.order_status,h.paid_at
      FROM ${this.table("growth_order_lines")} l
      JOIN ${this.table("growth_order_headers")} h ON h.id=l.order_header_id
      WHERE l.is_current=1 ORDER BY l.id`);
    return rows.rows;
  }

  async orderSalesRowsForBatch(batchId, client = this.provider) {
    const rows = await client.query(`SELECT l.id AS order_line_id,l.normalized_source_sku,
      l.normalized_source_warehouse_name,l.quantity,h.id AS order_header_id,h.paid_at
      FROM ${this.table("growth_order_lines")} l
      JOIN ${this.table("growth_order_headers")} h ON h.id=l.order_header_id
      WHERE l.is_current=1 AND l.source_batch_id=${client.placeholder(1)}
        AND h.effective_status='valid' AND l.effective_status='valid' ORDER BY l.id`, [batchId]);
    return rows.rows;
  }

  async setInventoryLinksNotCurrent(inventoryBatchId, client = this.provider) {
    await client.execute(`UPDATE ${this.table("growth_order_inventory_links")} SET is_current=0
      WHERE inventory_source_batch_id=${client.placeholder(1)} AND is_current=1`, [inventoryBatchId]);
  }

  async upsertOrderInventoryLink(input, client = this.provider) {
    const existing = (await client.query(`SELECT id FROM ${this.table("growth_order_inventory_links")}
      WHERE order_line_id=${client.placeholder(1)} AND inventory_source_batch_id=${client.placeholder(2)} LIMIT 1`,
    [input.orderLineId, input.inventorySourceBatchId])).rows[0];
    if (existing) {
      const values = [input.orderSourceBatchId, input.inventorySnapshotId, input.normalizedSourceSku,
        input.normalizedSourceWarehouseName, input.matchStatus, input.unmatchedReason, input.orderEffectiveStatus,
        input.updatedAt, existing.id];
      await client.execute(`UPDATE ${this.table("growth_order_inventory_links")} SET
        order_source_batch_id=${client.placeholder(1)},inventory_snapshot_id=${client.placeholder(2)},
        normalized_source_sku=${client.placeholder(3)},normalized_source_warehouse_name=${client.placeholder(4)},
        match_status=${client.placeholder(5)},unmatched_reason=${client.placeholder(6)},
        order_effective_status=${client.placeholder(7)},is_current=1,updated_at=${client.placeholder(8)}
        WHERE id=${client.placeholder(9)}`, values);
      return existing.id;
    }
    const id = input.id || randomUUID();
    const values = [id, input.orderLineId, input.orderSourceBatchId, input.inventorySnapshotId,
      input.inventorySourceBatchId, input.matchKeyVersion, input.normalizedSourceSku,
      input.normalizedSourceWarehouseName, input.matchStatus, input.unmatchedReason,
      input.orderEffectiveStatus, 1, input.createdAt, input.updatedAt];
    await client.execute(`INSERT INTO ${this.table("growth_order_inventory_links")} (
      id,order_line_id,order_source_batch_id,inventory_snapshot_id,inventory_source_batch_id,match_key_version,
      normalized_source_sku,normalized_source_warehouse_name,match_status,unmatched_reason,order_effective_status,
      is_current,created_at,updated_at
    ) VALUES (${values.map((_, index) => client.placeholder(index + 1)).join(",")})`, values);
    return id;
  }

  async upsertSkuWarehouseSalesMetric(input, client = this.provider) {
    const existing = (await client.query(`SELECT id FROM ${this.table("growth_sku_warehouse_sales_metrics")}
      WHERE inventory_snapshot_id=${client.placeholder(1)} LIMIT 1`, [input.inventorySnapshotId])).rows[0];
    const mutableValues = [input.orderSourceBatchId, input.ownSalesQuantity7d, input.ownSalesOrderCount7d,
      input.ownSalesEffectiveLineCount7d, input.ownSalesWindowStartedAt, input.ownSalesWindowEndedAt,
      input.ownSalesQuantity7dStatus, input.sourceVisibleSales7d, input.sourceVisibleSales28d,
      input.sourceVisibleSales42d, input.sourcePredictedDailySales, input.sourcePredictedDailySalesStatus,
      input.sourceScopeStatus];
    if (existing) {
      await client.execute(`UPDATE ${this.table("growth_sku_warehouse_sales_metrics")} SET
        order_source_batch_id=${client.placeholder(1)},own_sales_quantity_7d=${client.placeholder(2)},
        own_sales_order_count_7d=${client.placeholder(3)},own_sales_effective_line_count_7d=${client.placeholder(4)},
        own_sales_window_started_at=${client.placeholder(5)},own_sales_window_ended_at=${client.placeholder(6)},
        own_sales_quantity_7d_status=${client.placeholder(7)},source_visible_sales_7d=${client.placeholder(8)},
        source_visible_sales_28d=${client.placeholder(9)},source_visible_sales_42d=${client.placeholder(10)},
        source_predicted_daily_sales=${client.placeholder(11)},source_predicted_daily_sales_status=${client.placeholder(12)},
        source_scope_status=${client.placeholder(13)} WHERE id=${client.placeholder(14)}`,
      [...mutableValues, existing.id]);
      return existing.id;
    }
    const id = input.id || randomUUID();
    const values = [id, input.inventorySnapshotId, input.inventorySourceBatchId, ...mutableValues.slice(0, 1),
      input.snapshotAt, input.normalizedSourceSku, input.normalizedSourceWarehouseName, ...mutableValues.slice(1), input.createdAt];
    await client.execute(`INSERT INTO ${this.table("growth_sku_warehouse_sales_metrics")} (
      id,inventory_snapshot_id,inventory_source_batch_id,order_source_batch_id,snapshot_at,
      normalized_source_sku,normalized_source_warehouse_name,own_sales_quantity_7d,own_sales_order_count_7d,
      own_sales_effective_line_count_7d,own_sales_window_started_at,own_sales_window_ended_at,
      own_sales_quantity_7d_status,source_visible_sales_7d,source_visible_sales_28d,source_visible_sales_42d,
      source_predicted_daily_sales,source_predicted_daily_sales_status,source_scope_status,created_at
    ) VALUES (${values.map((_, index) => client.placeholder(index + 1)).join(",")})`, values);
    return id;
  }

  async insertMappingEvent(input, client = this.provider) {
    await client.execute(`INSERT INTO ${this.table("growth_mapping_events")} (
      id,mapping_type,mapping_id,action,before_json,after_json,actor_label,request_id,occurred_at
    ) VALUES (${Array.from({ length: 9 }, (_, index) => client.placeholder(index + 1)).join(",")})`, [
      input.id || randomUUID(), input.mappingType, input.mappingId, input.action, JSON.stringify(input.before || {}),
      JSON.stringify(input.after || {}), input.actorLabel, input.requestId, input.occurredAt,
    ]);
  }

  async upsertObservation(input, client = this.provider) {
    const existing = (await client.query(`SELECT id FROM ${this.table("growth_shop_sku_observations")}
      WHERE observation_key=${client.placeholder(1)} LIMIT 1`, [input.observationKey])).rows[0];
    if (existing) {
      await client.execute(`UPDATE ${this.table("growth_shop_sku_observations")} SET internal_shop_id=${client.placeholder(1)},
        mapped_product_id=${client.placeholder(2)},first_observed_at=${client.placeholder(3)},last_observed_at=${client.placeholder(4)},
        observed_order_count=${client.placeholder(5)},observed_line_count=${client.placeholder(6)},observed_quantity=${client.placeholder(7)},
        last_source_batch_id=${client.placeholder(8)},updated_at=${client.placeholder(9)} WHERE id=${client.placeholder(10)}`,
      [input.internalShopId, input.mappedProductId, input.firstObservedAt, input.lastObservedAt, input.observedOrderCount,
        input.observedLineCount, input.observedQuantity, input.lastSourceBatchId, input.updatedAt, existing.id]);
      return existing.id;
    }
    const id = input.id || randomUUID();
    const values = [id, input.observationKey, "historical_observed", input.platform, input.sourceShopName,
      input.normalizedSourceShopName, input.internalShopId, input.sourceSku, input.normalizedSourceSku,
      input.mappedProductId, input.firstObservedAt, input.lastObservedAt, input.observedOrderCount,
      input.observedLineCount, input.observedQuantity, input.firstSourceBatchId, input.lastSourceBatchId,
      input.createdAt, input.updatedAt];
    await client.execute(`INSERT INTO ${this.table("growth_shop_sku_observations")} (
      id,observation_key,coverage_semantic,platform,source_shop_name,normalized_source_shop_name,internal_shop_id,
      source_sku,normalized_source_sku,mapped_product_id,first_observed_at,last_observed_at,observed_order_count,
      observed_line_count,observed_quantity,first_source_batch_id,last_source_batch_id,created_at,updated_at
    ) VALUES (${values.map((_, index) => client.placeholder(index + 1)).join(",")})`, values);
    return id;
  }

  async observationAggregate(platform, normalizedSourceShopName, normalizedSourceSku, client = this.provider) {
    const rows = await client.query(`SELECT
      MIN(h.paid_at) AS first_observed_at,MAX(h.paid_at) AS last_observed_at,
      COUNT(DISTINCT h.id) AS observed_order_count,COUNT(l.id) AS observed_line_count,
      COALESCE(SUM(l.quantity),0) AS observed_quantity,
      MIN(h.source_shop_name) AS source_shop_name,MIN(l.source_sku) AS source_sku,
      MIN(h.first_source_batch_id) AS first_source_batch_id,MAX(h.source_batch_id) AS last_source_batch_id,
      MIN(h.internal_shop_id) AS internal_shop_id,MIN(l.mapped_product_id) AS mapped_product_id
      FROM ${this.table("growth_order_lines")} l
      JOIN ${this.table("growth_order_headers")} h ON h.id=l.order_header_id
      WHERE h.platform=${client.placeholder(1)} AND h.normalized_source_shop_name=${client.placeholder(2)}
        AND l.normalized_source_sku=${client.placeholder(3)} AND l.is_current=1
        AND h.effective_status='valid' AND l.effective_status='valid'`,
    [platform, normalizedSourceShopName, normalizedSourceSku]);
    const row = rows.rows[0];
    if (!row || !Number(row.observed_line_count || 0)) return null;
    return {
      platform,
      normalizedSourceShopName,
      normalizedSourceSku,
      sourceShopName: row.source_shop_name,
      sourceSku: row.source_sku,
      firstObservedAt: row.first_observed_at || null,
      lastObservedAt: row.last_observed_at || null,
      observedOrderCount: Number(row.observed_order_count || 0),
      observedLineCount: Number(row.observed_line_count || 0),
      observedQuantity: number(row.observed_quantity) || 0,
      firstSourceBatchId: row.first_source_batch_id,
      lastSourceBatchId: row.last_source_batch_id,
      internalShopId: row.internal_shop_id || null,
      mappedProductId: row.mapped_product_id || null,
    };
  }

  async identitiesForSourceShop(platform, normalizedSourceShopName, client = this.provider) {
    const rows = await client.query(`SELECT DISTINCT l.normalized_source_sku FROM ${this.table("growth_order_lines")} l
      JOIN ${this.table("growth_order_headers")} h ON h.id=l.order_header_id
      WHERE h.platform=${client.placeholder(1)} AND h.normalized_source_shop_name=${client.placeholder(2)} AND l.is_current=1
      ORDER BY l.normalized_source_sku`, [platform, normalizedSourceShopName]);
    return rows.rows.map((row) => row.normalized_source_sku);
  }

  async listBatches(filters = {}) {
    const currentPage = page(filters.page);
    const size = pageSize(filters.pageSize);
    const parameters = [];
    const where = [];
    if (filters.sourceType) {
      parameters.push(filters.sourceType);
      where.push(`source_type=${this.provider.placeholder(parameters.length)}`);
    }
    if (filters.confirmationStatus) {
      parameters.push(filters.confirmationStatus === "confirmed" ? "confirmed" : "unconfirmed");
      where.push(`source_scope_status=${this.provider.placeholder(parameters.length)}`);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = Number((await this.provider.query(`SELECT COUNT(*) AS total FROM ${this.table("growth_source_batches")} ${clause}`, parameters)).rows[0]?.total || 0);
    const queryParameters = [...parameters, size, (currentPage - 1) * size];
    const rows = await this.provider.query(`SELECT * FROM ${this.table("growth_source_batches")} ${clause}
      ORDER BY created_at DESC,id LIMIT ${this.provider.placeholder(queryParameters.length - 1)} OFFSET ${this.provider.placeholder(queryParameters.length)}`, queryParameters);
    return { batches: rows.rows.map(batchRow), page: currentPage, pageSize: size, total, totalPages: Math.max(1, Math.ceil(total / size)) };
  }

  async batchDetail(id) {
    const batch = await this.getBatch(id);
    if (!batch) return null;
    const metrics = {};
    for (const [name, { table, column }] of Object.entries({
      orderRawRows: { table: "growth_order_raw_rows", column: "batch_id" },
      inventoryRawRows: { table: "growth_inventory_raw_rows", column: "batch_id" },
      orderHeaders: { table: "growth_order_headers", column: "source_batch_id" },
      orderLines: { table: "growth_order_lines", column: "source_batch_id" },
      inventorySnapshots: { table: "growth_inventory_snapshots", column: "batch_id" },
      orderInventoryLinks: { table: "growth_order_inventory_links", column: "inventory_source_batch_id" },
      salesMetrics: { table: "growth_sku_warehouse_sales_metrics", column: "inventory_source_batch_id" },
      mappingIssues: { table: "growth_mapping_issues", column: "source_batch_id" },
      qualityIssues: { table: "growth_data_quality_issues", column: "batch_id" },
    })) {
      metrics[name] = Number((await this.provider.query(`SELECT COUNT(*) AS total FROM ${this.table(table)} WHERE ${column}=${this.provider.placeholder(1)}`, [id])).rows[0]?.total || 0);
    }
    return { batch, metrics };
  }

  async listShops(filters = {}) {
    const currentPage = page(filters.page);
    const size = pageSize(filters.pageSize);
    const parameters = [];
    const where = [];
    if (filters.platform) { parameters.push(filters.platform); where.push(`platform=${this.provider.placeholder(parameters.length)}`); }
    if (filters.status) { parameters.push(filters.status); where.push(`status=${this.provider.placeholder(parameters.length)}`); }
    if (filters.confirmationStatus) {
      parameters.push(filters.confirmationStatus === "confirmed" ? "confirmed" : "review_required");
      where.push(`identity_status=${this.provider.placeholder(parameters.length)}`);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = Number((await this.provider.query(`SELECT COUNT(*) AS total FROM ${this.table("growth_shops")} ${clause}`, parameters)).rows[0]?.total || 0);
    const queryParameters = [...parameters, size, (currentPage - 1) * size];
    const rows = await this.provider.query(`SELECT * FROM ${this.table("growth_shops")} ${clause} ORDER BY display_name,id
      LIMIT ${this.provider.placeholder(queryParameters.length - 1)} OFFSET ${this.provider.placeholder(queryParameters.length)}`, queryParameters);
    return { shops: rows.rows.map(shopRow), page: currentPage, pageSize: size, total, totalPages: Math.max(1, Math.ceil(total / size)) };
  }

  async listShopMappings(filters = {}) {
    const currentPage = page(filters.page);
    const size = pageSize(filters.pageSize);
    const parameters = [];
    const where = [];
    if (filters.unresolved) where.push("m.mapping_status IN ('unmatched','ambiguous','revoked')");
    if (filters.status) { parameters.push(filters.status); where.push(`m.mapping_status=${this.provider.placeholder(parameters.length)}`); }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const from = `FROM ${this.table("growth_shop_source_mappings")} m LEFT JOIN ${this.table("growth_shops")} s ON s.id=m.internal_shop_id`;
    const total = Number((await this.provider.query(`SELECT COUNT(*) AS total ${from} ${clause}`, parameters)).rows[0]?.total || 0);
    const queryParameters = [...parameters, size, (currentPage - 1) * size];
    const rows = await this.provider.query(`SELECT m.*,s.id AS shop_id,s.internal_shop_code,s.display_name,s.platform AS shop_platform,
      s.country_code AS shop_country_code,s.country_name,s.owner_user_id,s.status AS shop_status,
      s.identity_status AS shop_identity_status ${from} ${clause}
      ORDER BY m.updated_at DESC,m.id LIMIT ${this.provider.placeholder(queryParameters.length - 1)} OFFSET ${this.provider.placeholder(queryParameters.length)}`, queryParameters);
    return { mappings: rows.rows.map(shopMappingRow), page: currentPage, pageSize: size, total, totalPages: Math.max(1, Math.ceil(total / size)) };
  }

  async listProductMappings(filters = {}) {
    const currentPage = page(filters.page);
    const size = pageSize(filters.pageSize);
    const parameters = [];
    const where = [];
    if (filters.unresolved) where.push("mapping_status IN ('unmatched','ambiguous','revoked')");
    if (filters.status) { parameters.push(filters.status); where.push(`mapping_status=${this.provider.placeholder(parameters.length)}`); }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = Number((await this.provider.query(`SELECT COUNT(*) AS total FROM ${this.table("product_identity_mappings")} ${clause}`, parameters)).rows[0]?.total || 0);
    const queryParameters = [...parameters, size, (currentPage - 1) * size];
    const rows = await this.provider.query(`SELECT * FROM ${this.table("product_identity_mappings")} ${clause}
      ORDER BY updated_at DESC,id LIMIT ${this.provider.placeholder(queryParameters.length - 1)} OFFSET ${this.provider.placeholder(queryParameters.length)}`, queryParameters);
    return { mappings: rows.rows.map(productMappingRow), page: currentPage, pageSize: size, total, totalPages: Math.max(1, Math.ceil(total / size)) };
  }

  async listMappingIssues(filters = {}) {
    const currentPage = page(filters.page);
    const size = pageSize(filters.pageSize);
    const parameters = [];
    const where = [];
    if (filters.issueTypes?.length) {
      const placeholders = filters.issueTypes.map((value) => { parameters.push(value); return this.provider.placeholder(parameters.length); });
      where.push(`issue_type IN (${placeholders.join(",")})`);
    }
    if (filters.status) { parameters.push(filters.status); where.push(`status=${this.provider.placeholder(parameters.length)}`); }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = Number((await this.provider.query(`SELECT COUNT(*) AS total FROM ${this.table("growth_mapping_issues")} ${clause}`, parameters)).rows[0]?.total || 0);
    const queryParameters = [...parameters, size, (currentPage - 1) * size];
    const rows = await this.provider.query(`SELECT * FROM ${this.table("growth_mapping_issues")} ${clause}
      ORDER BY created_at DESC,id LIMIT ${this.provider.placeholder(queryParameters.length - 1)} OFFSET ${this.provider.placeholder(queryParameters.length)}`, queryParameters);
    return { issues: rows.rows.map(issueRow), page: currentPage, pageSize: size, total, totalPages: Math.max(1, Math.ceil(total / size)) };
  }

  async listQualityIssues(filters = {}) {
    const currentPage = page(filters.page);
    const size = pageSize(filters.pageSize);
    const parameters = [];
    const where = [];
    if (filters.batchId) { parameters.push(filters.batchId); where.push(`batch_id=${this.provider.placeholder(parameters.length)}`); }
    if (filters.status) { parameters.push(filters.status); where.push(`status=${this.provider.placeholder(parameters.length)}`); }
    if (filters.severity) { parameters.push(filters.severity); where.push(`severity=${this.provider.placeholder(parameters.length)}`); }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = Number((await this.provider.query(`SELECT COUNT(*) AS total FROM ${this.table("growth_data_quality_issues")} ${clause}`, parameters)).rows[0]?.total || 0);
    const queryParameters = [...parameters, size, (currentPage - 1) * size];
    const rows = await this.provider.query(`SELECT * FROM ${this.table("growth_data_quality_issues")} ${clause}
      ORDER BY created_at DESC,id LIMIT ${this.provider.placeholder(queryParameters.length - 1)} OFFSET ${this.provider.placeholder(queryParameters.length)}`, queryParameters);
    return {
      issues: rows.rows.map(qualityIssueRow),
      page: currentPage, pageSize: size, total, totalPages: Math.max(1, Math.ceil(total / size)),
    };
  }

  async mappingEvents(mappingType, mappingId, client = this.provider) {
    const rows = await client.query(`SELECT * FROM ${this.table("growth_mapping_events")}
      WHERE mapping_type=${client.placeholder(1)} AND mapping_id=${client.placeholder(2)}
      ORDER BY occurred_at DESC,id`, [mappingType, mappingId]);
    return rows.rows.map((row) => ({ id: row.id, mappingType: row.mapping_type, mappingId: row.mapping_id,
      action: row.action, before: json(row.before_json, {}), after: json(row.after_json, {}), actorLabel: row.actor_label,
      requestId: row.request_id || null, occurredAt: row.occurred_at }));
  }

  async shopConfirmationHistory(shopId, client = this.provider) {
    const rows = await client.query(`SELECT e.* FROM ${this.table("growth_mapping_events")} e
      JOIN ${this.table("growth_shop_source_mappings")} m ON m.id=e.mapping_id
      WHERE e.mapping_type='shop' AND m.internal_shop_id=${client.placeholder(1)}
      ORDER BY e.occurred_at DESC,e.id`, [shopId]);
    return rows.rows.map((row) => ({ id: row.id, action: row.action, actorLabel: row.actor_label,
      requestId: row.request_id || null, occurredAt: row.occurred_at, before: json(row.before_json, {}), after: json(row.after_json, {}) }));
  }

  async listObservations(filters = {}) {
    const currentPage = page(filters.page);
    const size = pageSize(filters.pageSize);
    const parameters = [];
    const where = ["o.coverage_semantic='historical_observed'"];
    if (filters.platform) { parameters.push(filters.platform); where.push(`o.platform=${this.provider.placeholder(parameters.length)}`); }
    if (filters.internalShopId) { parameters.push(filters.internalShopId); where.push(`o.internal_shop_id=${this.provider.placeholder(parameters.length)}`); }
    if (filters.formalScopeOnly) where.push("s.identity_status='confirmed' AND s.status='active'");
    const clause = `WHERE ${where.join(" AND ")}`;
    const from = `FROM ${this.table("growth_shop_sku_observations")} o LEFT JOIN ${this.table("growth_shops")} s ON s.id=o.internal_shop_id`;
    const total = Number((await this.provider.query(`SELECT COUNT(*) AS total ${from} ${clause}`, parameters)).rows[0]?.total || 0);
    const queryParameters = [...parameters, size, (currentPage - 1) * size];
    const rows = await this.provider.query(`SELECT o.*,s.identity_status AS shop_identity_status,s.status AS shop_status ${from} ${clause}
      ORDER BY o.last_observed_at DESC,o.id LIMIT ${this.provider.placeholder(queryParameters.length - 1)}
      OFFSET ${this.provider.placeholder(queryParameters.length)}`, queryParameters);
    return {
      observations: rows.rows.map((row) => ({
        id: row.id,
        semanticType: "historical_observed",
        value: number(row.observed_quantity) || 0,
        source: "mabang_order",
        observedAt: row.last_observed_at || null,
        snapshotAt: null,
        confirmationStatus: row.shop_identity_status === "confirmed" ? "confirmed" : "pending",
        availabilityStatus: "available",
        platform: row.platform,
        sourceShopName: row.source_shop_name,
        internalShopId: row.internal_shop_id || null,
        sourceSku: row.source_sku,
        mappedProductId: row.mapped_product_id || null,
        observedOrderCount: Number(row.observed_order_count || 0),
        observedLineCount: Number(row.observed_line_count || 0),
      })),
      page: currentPage,
      pageSize: size,
      total,
      totalPages: Math.max(1, Math.ceil(total / size)),
    };
  }

  async semanticMetrics(at = new Date().toISOString()) {
    const latest = async (sourceType) => (await this.provider.query(`SELECT * FROM ${this.table("growth_source_batches")}
      WHERE source_type=${this.provider.placeholder(1)} AND status='applied'
      ORDER BY COALESCE(imported_at,collected_at,created_at) DESC,id DESC LIMIT 1`, [sourceType])).rows[0] || null;
    const aggregate = async (sql, parameters = []) => (await this.provider.query(sql, parameters)).rows[0] || {};
    const [orderBatch, inventoryBatch, historical, eligible, own, visible, prediction, currentOnline] = await Promise.all([
      latest("mabang_order"),
      latest("mabang_inventory"),
      aggregate(`SELECT COUNT(*) AS row_count,COALESCE(SUM(observed_quantity),0) AS value,MAX(last_observed_at) AS observed_at
        FROM ${this.table("growth_shop_sku_observations")} WHERE coverage_semantic='historical_observed'`),
      aggregate(`SELECT COUNT(*) AS row_count,COALESCE(SUM(o.observed_quantity),0) AS value
        FROM ${this.table("growth_shop_sku_observations")} o JOIN ${this.table("growth_shops")} s ON s.id=o.internal_shop_id
        WHERE s.identity_status='confirmed' AND s.status='active'`),
      aggregate(`SELECT COUNT(l.id) AS row_count,COALESCE(SUM(l.quantity),0) AS value,MAX(h.paid_at) AS observed_at
        FROM ${this.table("growth_order_lines")} l JOIN ${this.table("growth_order_headers")} h ON h.id=l.order_header_id
        WHERE l.is_current=1 AND l.effective_status='valid' AND h.effective_status='valid'`),
      aggregate(`SELECT COUNT(*) AS row_count,COALESCE(SUM(source_visible_sales_7d),0) AS value_7d,
        COALESCE(SUM(source_visible_sales_28d),0) AS value_28d,COALESCE(SUM(source_visible_sales_42d),0) AS value_42d,
        MAX(snapshot_at) AS snapshot_at FROM ${this.table("growth_sku_warehouse_sales_metrics")}
        WHERE source_visible_sales_7d IS NOT NULL OR source_visible_sales_28d IS NOT NULL OR source_visible_sales_42d IS NOT NULL`),
      aggregate(`SELECT COUNT(*) AS row_count,COALESCE(SUM(source_predicted_daily_sales),0) AS value,MAX(snapshot_at) AS snapshot_at
        FROM ${this.table("growth_sku_warehouse_sales_metrics")} WHERE source_predicted_daily_sales_status='source_prediction_not_actual'`),
      aggregate(`SELECT COUNT(*) AS row_count,MAX(observed_at) AS observed_at
        FROM ${this.table("growth_shop_sku_coverage_snapshots")}
        WHERE expires_at>${this.provider.placeholder(1)}`, [at]),
    ]);
    return {
      orderBatch: batchRow(orderBatch),
      inventoryBatch: batchRow(inventoryBatch),
      historical: { rowCount: Number(historical.row_count || 0), value: number(historical.value) || 0, observedAt: historical.observed_at || null },
      eligible: { rowCount: Number(eligible.row_count || 0), value: number(eligible.value) || 0 },
      own: { rowCount: Number(own.row_count || 0), value: number(own.value) || 0, observedAt: own.observed_at || null },
      visible: { rowCount: Number(visible.row_count || 0), value7d: number(visible.value_7d) || 0,
        value28d: number(visible.value_28d) || 0, value42d: number(visible.value_42d) || 0, snapshotAt: visible.snapshot_at || null },
      prediction: { rowCount: Number(prediction.row_count || 0), value: number(prediction.value) || 0, snapshotAt: prediction.snapshot_at || null },
      currentOnline: { rowCount: Number(currentOnline.row_count || 0), observedAt: currentOnline.observed_at || null },
    };
  }

  async summary() {
    const scalar = async (sql) => Number((await this.provider.query(sql)).rows[0]?.value || 0);
    return {
      batches: await scalar(`SELECT COUNT(*) AS value FROM ${this.table("growth_source_batches")}`),
      orderRawRows: await scalar(`SELECT COUNT(*) AS value FROM ${this.table("growth_order_raw_rows")}`),
      orderHeaders: await scalar(`SELECT COUNT(*) AS value FROM ${this.table("growth_order_headers")}`),
      orderLines: await scalar(`SELECT COUNT(*) AS value FROM ${this.table("growth_order_lines")} WHERE is_current=1`),
      cancelledOrders: await scalar(`SELECT COUNT(*) AS value FROM ${this.table("growth_order_headers")} WHERE effective_status='invalid_cancelled'`),
      sourceShops: await scalar(`SELECT COUNT(*) AS value FROM ${this.table("growth_shop_source_mappings")}`),
      confirmedShopMappings: await scalar(`SELECT COUNT(*) AS value FROM ${this.table("growth_shop_source_mappings")} WHERE mapping_status IN ('matched','manually_confirmed')`),
      unresolvedShopMappings: await scalar(`SELECT COUNT(*) AS value FROM ${this.table("growth_shop_source_mappings")} WHERE mapping_status NOT IN ('matched','manually_confirmed')`),
      automaticProductMappings: await scalar(`SELECT COUNT(*) AS value FROM ${this.table("product_identity_mappings")} WHERE mapping_status='matched' AND mapping_source='exact_country_sku'`),
      ambiguousProductIssues: await scalar(`SELECT COUNT(*) AS value FROM ${this.table("growth_mapping_issues")} WHERE issue_type='sku_ambiguous' AND status='open'`),
      unmatchedProductIssues: await scalar(`SELECT COUNT(*) AS value FROM ${this.table("growth_mapping_issues")} WHERE issue_type='sku_unmatched' AND status='open'`),
      inventoryRawRows: await scalar(`SELECT COUNT(*) AS value FROM ${this.table("growth_inventory_raw_rows")}`),
      inventorySnapshots: await scalar(`SELECT COUNT(*) AS value FROM ${this.table("growth_inventory_snapshots")}`),
      matchedOrderInventoryLinks: await scalar(`SELECT COUNT(*) AS value FROM ${this.table("growth_order_inventory_links")} WHERE is_current=1 AND match_status='matched'`),
      unmatchedOrderInventoryLinks: await scalar(`SELECT COUNT(*) AS value FROM ${this.table("growth_order_inventory_links")} WHERE is_current=1 AND match_status='unmatched'`),
      salesMetricRows: await scalar(`SELECT COUNT(*) AS value FROM ${this.table("growth_sku_warehouse_sales_metrics")}`),
      multiWarehouseSkus: await scalar(`SELECT COUNT(*) AS value FROM (
        SELECT normalized_source_sku FROM ${this.table("growth_inventory_snapshots")}
        WHERE batch_id=(SELECT id FROM ${this.table("growth_source_batches")} WHERE source_type='mabang_inventory' AND status='applied'
          ORDER BY COALESCE(imported_at,collected_at,created_at) DESC,id DESC LIMIT 1)
        GROUP BY normalized_source_sku HAVING COUNT(DISTINCT normalized_warehouse_name)>1
      ) multi_warehouse`),
      sourceScopeUnconfirmedBatches: await scalar(`SELECT COUNT(*) AS value FROM ${this.table("growth_source_batches")} WHERE source_scope_status='unconfirmed'`),
      historicalObserved: await scalar(`SELECT COUNT(*) AS value FROM ${this.table("growth_shop_sku_observations")} WHERE coverage_semantic='historical_observed'`),
      currentOnline: await scalar(`SELECT COUNT(*) AS value FROM ${this.table("growth_shop_sku_coverage_snapshots")}`),
      openQualityIssues: await scalar(`SELECT COUNT(*) AS value FROM ${this.table("growth_data_quality_issues")} WHERE status='open'`),
    };
  }

  async freshness() {
    const rows = await this.provider.query(`SELECT source_type,MAX(COALESCE(imported_at,collected_at,created_at)) AS latest_at,
      COUNT(*) AS batch_count FROM ${this.table("growth_source_batches")} GROUP BY source_type ORDER BY source_type`);
    return rows.rows.map((row) => ({ sourceType: row.source_type, latestAt: row.latest_at || null, batchCount: Number(row.batch_count || 0) }));
  }
}
