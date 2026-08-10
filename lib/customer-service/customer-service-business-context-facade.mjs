import { createPortableRepositoryExecutor } from "../data/portable-repository-executor.mjs";
import {
  normalizeCanonicalShopName,
  normalizeCanonicalWarehouse,
} from "../data-foundation/unified-normalizers.mjs";

function parseJson(value, fallback) {
  if (value !== null && typeof value === "object") return value;
  try { return JSON.parse(String(value || "")); } catch { return fallback; }
}

function shopRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    platform: row.platform,
    providerShopId: row.provider_shop_id,
    shopCode: row.shop_code || null,
    shopName: row.shop_name,
    countryCode: row.source_country_code,
    currency: row.currency || null,
    categoryName: row.category_name || null,
    growthShopId: row.growth_shop_id || null,
    platformShopId: row.platform_shop_id || null,
    platformConnectorShopId: row.platform_connector_shop_id || null,
    identityStatus: row.identity_status,
    status: row.status,
    revisionObservedAt: row.updated_at,
  };
}

function boundedText(value, maximum = 300) {
  const normalized = String(value ?? "").normalize("NFKC").trim();
  return normalized ? normalized.slice(0, maximum) : null;
}

function safeGatewayErrorCode(error) {
  const code = String(error?.code || "").trim().toUpperCase();
  return /^[A-Z0-9_]{1,120}$/.test(code) ? code : "PLATFORM_GATEWAY_READ_FAILED";
}

function normalizedLogisticsRecord(record) {
  return {
    id: boundedText(record?.id, 200),
    orderId: boundedText(record?.orderId, 200),
    status: boundedText(record?.status, 100),
    packageId: boundedText(record?.packageId, 200),
    trackingCode: boundedText(record?.trackingCode, 200),
    shipmentProvider: boundedText(record?.shipmentProvider, 200),
    shippingType: boundedText(record?.shippingType, 120),
    warehouseCode: boundedText(record?.warehouseCode, 120),
    sellerSku: boundedText(record?.sellerSku, 300),
    productId: boundedText(record?.productId, 200),
    modelId: boundedText(record?.modelId, 200),
    name: boundedText(record?.name, 500),
    quantity: Number.isFinite(Number(record?.quantity)) ? Number(record.quantity) : null,
  };
}

export class CustomerServiceBusinessContextFacade {
  constructor({
    provider,
    platformGatewayService = null,
    logisticsCacheTtlMs = 60_000,
    now = () => new Date(),
  }) {
    if (!provider) throw new TypeError("Database provider is required");
    this.provider = createPortableRepositoryExecutor(provider);
    this.platformGateway = platformGatewayService;
    this.logisticsCacheTtlMs = Math.max(0, Number(logisticsCacheTtlMs) || 0);
    this.now = now;
    this.logisticsCache = new Map();
    this.logisticsLocks = new Map();
  }

  async getCommerceShop(id) {
    return shopRow((await this.provider.query(
      "SELECT * FROM commerce_shop_registry WHERE id=? LIMIT 1",
      [String(id || "")],
    )).rows[0]);
  }

  async resolveShopCandidates({ observedName, countryCode = null } = {}) {
    const normalized = normalizeCanonicalShopName(observedName);
    if (!normalized) return { status: "NAME_MISSING", normalizedName: null, candidates: [] };
    const parameters = [normalized];
    let country = "";
    if (countryCode) {
      country = String(countryCode).trim().toUpperCase();
      parameters.push(country);
    }
    const result = await this.provider.query(
      `SELECT * FROM commerce_shop_registry
       WHERE normalized_shop_name=${this.provider.placeholder(1)}
         ${country ? `AND source_country_code=${this.provider.placeholder(2)}` : ""}
         AND status='ACTIVE'
       ORDER BY identity_status,id`,
      parameters,
    );
    const candidates = result.rows.map(shopRow);
    if (!candidates.length) return { status: "NOT_FOUND", normalizedName: normalized, candidates: [] };
    if (candidates.length > 1) return { status: "AMBIGUOUS", normalizedName: normalized, candidates };
    if (candidates[0].identityStatus !== "CONFIRMED") {
      return { status: "REVIEW_REQUIRED", normalizedName: normalized, candidates };
    }
    return { status: "EXACT_UNIQUE_CANDIDATE", normalizedName: normalized, shop: candidates[0], candidates };
  }

  async findExactOrder({ commerceShopId, orderRef } = {}) {
    const shop = await this.getCommerceShop(commerceShopId);
    const normalizedRef = String(orderRef || "").normalize("NFKC").trim();
    if (!shop || !normalizedRef || !shop.growthShopId) {
      return { status: !shop ? "SHOP_NOT_FOUND" : !normalizedRef ? "ORDER_REF_MISSING" : "SHOP_ORDER_LINK_MISSING", shop, candidates: [] };
    }
    const headers = (await this.provider.query(
      `SELECT * FROM growth_order_headers
       WHERE internal_shop_id=? AND source_order_id=?
       ORDER BY updated_at DESC,id`,
      [shop.growthShopId, normalizedRef],
    )).rows;
    if (!headers.length) return { status: "NOT_FOUND", shop, candidates: [] };
    const businessKeys = new Set(headers.map((row) => row.business_key));
    if (businessKeys.size > 1) {
      return { status: "AMBIGUOUS", shop, candidates: headers.map((row) => ({ id: row.id, orderRef: row.source_order_id })) };
    }
    const header = headers[0];
    const lines = (await this.provider.query(
      `SELECT id,source_sku,normalized_source_sku,platform_sku,mapped_product_id,mapped_country,
         quantity,line_amount,line_amount_status,product_name,mapping_status,effective_status,revision,updated_at
       FROM growth_order_lines
       WHERE order_header_id=? AND is_current=1
       ORDER BY source_row_number,line_occurrence,id`,
      [header.id],
    )).rows;
    return {
      status: "RESOLVED",
      shop,
      order: {
        id: header.id,
        orderRef: header.source_order_id,
        platform: header.platform,
        status: header.order_status,
        effectiveStatus: header.effective_status,
        qualityStatus: header.source_quality_status,
        paidAt: header.paid_at || null,
        cancelledAt: header.cancelled_at || null,
        currency: header.order_currency || null,
        amount: header.order_amount === null ? null : Number(header.order_amount),
        revision: Number(header.revision || 0),
        sourceBatchId: header.source_batch_id,
        lastSeenAt: header.last_seen_at,
        lines: lines.map((line) => ({
          id: line.id,
          sourceSku: line.source_sku,
          normalizedSourceSku: line.normalized_source_sku,
          platformSku: line.platform_sku || null,
          productSkuId: line.mapped_product_id || null,
          countryCode: line.mapped_country || null,
          quantity: line.quantity === null ? null : Number(line.quantity),
          lineAmount: line.line_amount === null ? null : Number(line.line_amount),
          lineAmountStatus: line.line_amount_status,
          productName: line.product_name || null,
          mappingStatus: line.mapping_status,
          effectiveStatus: line.effective_status,
          revision: Number(line.revision || 0),
          updatedAt: line.updated_at,
        })),
      },
    };
  }

  async authoritativeLogistics({ commerceShopId, orderRef } = {}) {
    const shop = await this.getCommerceShop(commerceShopId);
    const normalizedRef = boundedText(orderRef, 200);
    if (!shop) return { status: "SHOP_NOT_FOUND", authoritative: false, records: [] };
    if (!normalizedRef) return { status: "ORDER_REF_MISSING", authoritative: false, shop, records: [] };
    if (shop.status !== "ACTIVE" || shop.identityStatus !== "CONFIRMED") {
      return { status: "SHOP_IDENTITY_NOT_CONFIRMED", authoritative: false, shop, orderRef: normalizedRef, records: [] };
    }
    if (!shop.platformConnectorShopId) {
      return { status: "PLATFORM_SHOP_LINK_MISSING", authoritative: false, shop, orderRef: normalizedRef, records: [] };
    }
    if (!this.platformGateway || typeof this.platformGateway.getOrderItems !== "function") {
      return { status: "PLATFORM_GATEWAY_UNAVAILABLE", authoritative: false, shop, orderRef: normalizedRef, records: [] };
    }

    const cacheKey = `${shop.platform}\u001f${shop.platformConnectorShopId}\u001f${normalizedRef}`;
    const nowMs = this.now().getTime();
    const cached = this.logisticsCache.get(cacheKey);
    if (cached && cached.expiresAt > nowMs) return { ...cached.value, cacheHit: true };
    if (this.logisticsLocks.has(cacheKey)) return this.logisticsLocks.get(cacheKey);

    const read = (async () => {
      try {
        const response = await this.platformGateway.getOrderItems({
          platform: String(shop.platform).toLowerCase(),
          shopId: shop.platformConnectorShopId,
          input: { orderId: normalizedRef },
        });
        const rawRecords = response?.data?.records;
        if (!Array.isArray(rawRecords) || rawRecords.length > 500) {
          return {
            status: "PROVIDER_RESPONSE_INVALID",
            authoritative: false,
            shop,
            orderRef: normalizedRef,
            records: [],
          };
        }
        const records = rawRecords.map(normalizedLogisticsRecord);
        if (records.some((record) => record.orderId && record.orderId !== normalizedRef)) {
          return {
            status: "PROVIDER_RESPONSE_MISMATCH",
            authoritative: false,
            shop,
            orderRef: normalizedRef,
            records: [],
          };
        }
        const value = {
          status: records.length ? "RESOLVED" : "NOT_FOUND",
          authoritative: true,
          source: "PLATFORM_GATEWAY_ORDER_ITEMS",
          shop,
          orderRef: normalizedRef,
          providerRequestId: boundedText(response?.data?.providerRequestId, 200),
          fetchedAt: this.now().toISOString(),
          trackingAssigned: records.some((record) => Boolean(record.trackingCode)),
          records,
        };
        if (this.logisticsCacheTtlMs > 0) {
          if (this.logisticsCache.size >= 1_000) {
            const oldestKey = this.logisticsCache.keys().next().value;
            if (oldestKey) this.logisticsCache.delete(oldestKey);
          }
          this.logisticsCache.set(cacheKey, {
            expiresAt: this.now().getTime() + this.logisticsCacheTtlMs,
            value,
          });
        }
        return value;
      } catch (error) {
        return {
          status: "PLATFORM_GATEWAY_ERROR",
          authoritative: false,
          errorCode: safeGatewayErrorCode(error),
          shop,
          orderRef: normalizedRef,
          records: [],
        };
      }
    })().finally(() => this.logisticsLocks.delete(cacheKey));
    this.logisticsLocks.set(cacheKey, read);
    return read;
  }

  async currentInventory({ productSkuId, countryCode } = {}) {
    if (!productSkuId) return { status: "PRODUCT_REQUIRED", snapshots: [] };
    const batch = (await this.provider.query(
      `SELECT id,collected_at,source_sha256,row_count
       FROM growth_source_batches
       WHERE source_type='mabang_inventory' AND status='applied'
       ORDER BY COALESCE(collected_at,imported_at,created_at) DESC,id DESC LIMIT 1`,
    )).rows[0];
    if (!batch) return { status: "INVENTORY_BATCH_MISSING", snapshots: [] };
    const mappings = countryCode ? (await this.provider.query(
      `SELECT mapping.normalized_warehouse_name,mapping.country_code,mapping.country_name
       FROM growth_warehouse_country_mappings mapping
       JOIN growth_country_mapping_sets set_row ON set_row.id=mapping.mapping_set_id
       WHERE set_row.status='active' AND mapping.mapping_status='confirmed' AND mapping.country_code=?`,
      [String(countryCode).toUpperCase()],
    )).rows : [];
    const allowedWarehouses = new Map(mappings.map((row) => [row.normalized_warehouse_name, row]));
    const raw = (await this.provider.query(
      `SELECT id,source_sku,normalized_source_sku,warehouse_name,available_quantity,physical_quantity,
         locked_quantity,in_transit_quantity,pending_shipment_quantity,transfer_pending_shipment_quantity,
         sellable_quantity,sellable_quantity_status,source_predicted_daily_sales,
         predicted_daily_sales_semantic_status,days_of_supply,days_of_supply_status,snapshot_at,
         mapping_status,quality_status,created_at
       FROM growth_inventory_snapshots
       WHERE batch_id=? AND mapped_product_id=?
       ORDER BY warehouse_name,id`,
      [batch.id, productSkuId],
    )).rows;
    const filtered = countryCode && allowedWarehouses.size
      ? raw.filter((row) => allowedWarehouses.has(normalizeCanonicalWarehouse(row.warehouse_name)))
      : countryCode ? [] : raw;
    return {
      status: filtered.length ? "RESOLVED" : raw.length && countryCode ? "COUNTRY_WAREHOUSE_MAPPING_MISSING" : "NOT_FOUND",
      source: {
        dataset: "MABANG_INVENTORY",
        batchId: batch.id,
        sourceSha256: batch.source_sha256,
        collectedAt: batch.collected_at || null,
        rowCount: Number(batch.row_count || 0),
      },
      snapshots: filtered.map((row) => ({
        id: row.id,
        sourceSku: row.source_sku,
        normalizedSourceSku: row.normalized_source_sku,
        warehouseName: row.warehouse_name || null,
        countryCode: allowedWarehouses.get(normalizeCanonicalWarehouse(row.warehouse_name))?.country_code || null,
        availableQuantity: row.available_quantity === null ? null : Number(row.available_quantity),
        physicalQuantity: row.physical_quantity === null ? null : Number(row.physical_quantity),
        lockedQuantity: row.locked_quantity === null ? null : Number(row.locked_quantity),
        inTransitQuantity: row.in_transit_quantity === null ? null : Number(row.in_transit_quantity),
        pendingShipmentQuantity: row.pending_shipment_quantity === null ? null : Number(row.pending_shipment_quantity),
        transferPendingShipmentQuantity: row.transfer_pending_shipment_quantity === null ? null : Number(row.transfer_pending_shipment_quantity),
        sellableQuantity: row.sellable_quantity === null ? null : Number(row.sellable_quantity),
        sellableQuantityStatus: row.sellable_quantity_status,
        sourcePredictedDailySales: row.source_predicted_daily_sales === null ? null : Number(row.source_predicted_daily_sales),
        predictedDailySalesStatus: row.predicted_daily_sales_semantic_status,
        daysOfSupply: row.days_of_supply === null ? null : Number(row.days_of_supply),
        daysOfSupplyStatus: row.days_of_supply_status,
        snapshotAt: row.snapshot_at || row.created_at,
        mappingStatus: row.mapping_status,
        qualityStatus: row.quality_status,
      })),
    };
  }

  async productPackageSnapshot(productSkuId) {
    if (!productSkuId) return null;
    const row = (await this.provider.query(
      `SELECT package.id,package.semantic_row_sha256 row_hash,package.raw_payload_json,package.import_batch_id,package.updated_at
       FROM product_skus sku
       JOIN product_package_rows package ON package.latest_import_row_id=sku.current_source_row_id
       WHERE sku.id=? LIMIT 1`,
      [productSkuId],
    )).rows[0];
    return row ? {
      id: row.id,
      rowHash: row.row_hash,
      importBatchId: row.import_batch_id,
      updatedAt: row.updated_at,
      facts: parseJson(row.raw_payload_json, {}),
    } : null;
  }
}
