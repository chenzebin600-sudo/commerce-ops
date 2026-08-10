const MAX_PRODUCTS_PER_BATCH = 100;
const MAX_VARIANTS_PER_BATCH = 500;
const MAX_STOCK = 9_999_999;

function text(value) {
  return String(value ?? "").normalize("NFKC").replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
}

export function normalizeLazadaSyncName(value) {
  return text(value).toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, "");
}

export function normalizeLazadaSyncSku(value) {
  return text(value).replace(/\s+/g, "").toLocaleUpperCase("en-US");
}

function quantity(value) {
  const parsed = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

function unique(values) {
  return [...new Set(values.map(text).filter(Boolean))];
}

export function resolveLazadaShopMappings(configuredShops, visibleShops, warehouseCatalog = []) {
  const shopsByName = new Map();
  for (const shop of visibleShops || []) {
    const key = normalizeLazadaSyncName(shop?.name ?? shop?.shop_name);
    if (!key) continue;
    const rows = shopsByName.get(key) || [];
    rows.push(shop);
    shopsByName.set(key, rows);
  }
  const catalogByName = new Map();
  for (const warehouse of warehouseCatalog || []) {
    const name = text(warehouse?.name ?? warehouse);
    const key = normalizeLazadaSyncName(name);
    if (!key) continue;
    const rows = catalogByName.get(key) || [];
    rows.push(name);
    catalogByName.set(key, rows);
  }

  const resolved = [];
  const errors = [];
  const usedShopIds = new Set();
  for (const row of configuredShops || []) {
    const shopName = text(row?.shopName);
    const candidates = shopsByName.get(normalizeLazadaSyncName(shopName)) || [];
    if (candidates.length !== 1) {
      errors.push({ shopName, code: candidates.length ? "SHOP_AMBIGUOUS" : "SHOP_NOT_FOUND" });
      continue;
    }
    const shop = candidates[0];
    const shopId = text(shop.id ?? shop.shop_id);
    if (!shopId || usedShopIds.has(shopId)) {
      errors.push({ shopName, code: shopId ? "SHOP_DUPLICATE" : "SHOP_ID_MISSING" });
      continue;
    }
    const warehouseNames = [];
    for (const configuredName of unique(row?.warehouseNames || [])) {
      const matches = catalogByName.get(normalizeLazadaSyncName(configuredName)) || [];
      if (matches.length !== 1) {
        errors.push({ shopName, warehouseName: configuredName, code: matches.length ? "WAREHOUSE_AMBIGUOUS" : "WAREHOUSE_NOT_FOUND" });
      } else {
        warehouseNames.push(matches[0]);
      }
    }
    if (!warehouseNames.length) {
      errors.push({ shopName, code: "WAREHOUSE_REQUIRED" });
      continue;
    }
    usedShopIds.add(shopId);
    resolved.push({ shopId, shopName: text(shop.name ?? shop.shop_name), site: text(shop.site), warehouseNames });
  }
  return { mappings: resolved, errors };
}

function inventoryForWarehouses(records, warehouseNames) {
  const selected = new Set(warehouseNames.map(normalizeLazadaSyncName));
  const bySku = new Map();
  for (const record of records || []) {
    if (!selected.has(normalizeLazadaSyncName(record?.["仓库"]))) continue;
    const sourceSku = text(record?.["库存SKU编号"]);
    const sku = normalizeLazadaSyncSku(sourceSku);
    if (!sku) continue;
    const current = bySku.get(sku) || { sourceSku, availableQuantity: 0 };
    current.availableQuantity += quantity(record?.["可用库存量"]);
    bySku.set(sku, current);
  }
  return bySku;
}

function listingShopId(listing) {
  return text(listing?.shop_id ?? listing?.shop?.id);
}

function listingShopName(listing, fallback) {
  return text(listing?.shop_name ?? listing?.shop?.name ?? fallback);
}

function itemIdentity(item) {
  return [item.shop_id, item.internal_id, item.variation_id, item.seller_sku].join("\u0000");
}

export function buildLazadaInventoryPlan({ mappings, listings, inventoryRecords, safetyStock = 50, multiWarehouseMode = "block" }) {
  const safeStock = Math.max(0, quantity(safetyStock));
  const listingRowsByShop = new Map();
  for (const listing of listings || []) {
    const shopId = listingShopId(listing);
    if (!shopId) continue;
    const rows = listingRowsByShop.get(shopId) || [];
    for (const variant of listing.variants || []) {
      rows.push({
        platform: "lazada",
        shop_id: shopId,
        shop_name: listingShopName(listing, ""),
        internal_id: text(listing.internal_id ?? listing.id),
        product_id: text(listing.product_id),
        variation_id: text(variant.variant_id ?? variant.sku_id ?? variant.id ?? variant.sku),
        title: text(listing.title),
        seller_sku: text(variant.sku),
        stock_sku: text(variant.stock_sku ?? variant.sku),
        current_stock: quantity(variant.stock),
        multi_warehouse_mode: multiWarehouseMode,
      });
    }
    listingRowsByShop.set(shopId, rows);
  }

  const items = [];
  for (const mapping of mappings || []) {
    const inventory = inventoryForWarehouses(inventoryRecords, mapping.warehouseNames);
    const grouped = new Map();
    for (const row of listingRowsByShop.get(mapping.shopId) || []) {
      const sku = normalizeLazadaSyncSku(row.stock_sku || row.seller_sku);
      if (!row.seller_sku || !row.internal_id || !row.variation_id) {
        items.push({ ...row, warehouse_names: mapping.warehouseNames, status: "BLOCKED", reason_code: "LISTING_IDENTITY_MISSING", target_stock: null });
        continue;
      }
      const stock = inventory.get(sku);
      if (!stock) {
        items.push({ ...row, warehouse_names: mapping.warehouseNames, status: "BLOCKED", reason_code: "INVENTORY_SKU_NOT_FOUND", target_stock: null });
        continue;
      }
      const group = grouped.get(sku) || { stock, rows: [] };
      group.rows.push(row);
      grouped.set(sku, group);
    }

    for (const group of grouped.values()) {
      group.rows.sort((left, right) => itemIdentity(left).localeCompare(itemIdentity(right)));
      const distributable = Math.max(0, group.stock.availableQuantity - safeStock);
      const base = Math.floor(distributable / group.rows.length);
      let remainder = distributable % group.rows.length;
      for (const row of group.rows) {
        const target = Math.min(MAX_STOCK, base + (remainder > 0 ? 1 : 0));
        if (remainder > 0) remainder -= 1;
        items.push({
          ...row,
          warehouse_names: mapping.warehouseNames,
          inventory_available: group.stock.availableQuantity,
          safety_stock: safeStock,
          shared_target_count: group.rows.length,
          target_stock: target,
          status: row.current_stock === target ? "UNCHANGED" : "READY",
          reason_code: row.current_stock === target ? "ALREADY_MATCHED" : "SAFE_STOCK_EQUAL_SHARE",
        });
      }
    }
  }
  items.sort((left, right) => itemIdentity(left).localeCompare(itemIdentity(right)));
  const ready = items.filter((item) => item.status === "READY");
  return {
    generatedAt: new Date().toISOString(),
    platform: "lazada",
    safetyStock: safeStock,
    mappings,
    items,
    summary: {
      shopCount: mappings.length,
      listingCount: (listings || []).length,
      variantCount: items.length,
      readyCount: ready.length,
      unchangedCount: items.filter((item) => item.status === "UNCHANGED").length,
      blockedCount: items.filter((item) => item.status === "BLOCKED").length,
      productCount: new Set(items.map((item) => `${item.shop_id}\u0000${item.internal_id}`)).size,
    },
  };
}

export function chunkLazadaInventoryItems(items, { maxProducts = MAX_PRODUCTS_PER_BATCH, maxVariants = MAX_VARIANTS_PER_BATCH } = {}) {
  const products = new Map();
  for (const item of items || []) {
    const key = `${item.shop_id}\u0000${item.internal_id}`;
    const rows = products.get(key) || [];
    rows.push(item);
    products.set(key, rows);
  }
  const batches = [];
  let current = [];
  let productCount = 0;
  for (const rows of products.values()) {
    if (rows.length > maxVariants) throw new Error(`单个 Lazada 商品包含 ${rows.length} 个待写变体，超过安全上限 ${maxVariants}。`);
    if (current.length && (productCount >= maxProducts || current.length + rows.length > maxVariants)) {
      batches.push(current);
      current = [];
      productCount = 0;
    }
    current.push(...rows);
    productCount += 1;
  }
  if (current.length) batches.push(current);
  return batches;
}

export async function executeLazadaInventoryPlan({ plan, listingClient, onProgress = () => {} }) {
  const ready = (plan?.items || []).filter((item) => item.status === "READY");
  const batches = chunkLazadaInventoryItems(ready);
  const results = [];
  const failures = [];
  let attemptedBatchCount = 0;
  let successfulProducts = 0;
  let failedProducts = 0;

  const productGroups = (batch) => {
    const grouped = new Map();
    for (const item of batch) {
      const key = `${item.shop_id}\u0000${item.internal_id}`;
      const rows = grouped.get(key) || [];
      rows.push(item);
      grouped.set(key, rows);
    }
    return [...grouped.values()];
  };
  const failureRecord = (batch, stage, error, extra = {}) => ({
    stage,
    shopId: batch[0]?.shop_id || "",
    shopName: batch[0]?.shop_name || "",
    internalId: batch[0]?.internal_id || "",
    productId: batch[0]?.product_id || "",
    title: batch[0]?.title || "",
    sellerSkus: [...new Set(batch.map((item) => item.seller_sku).filter(Boolean))],
    variationIds: [...new Set(batch.map((item) => item.variation_id).filter(Boolean))],
    message: String(error?.message || error || "未知错误").slice(0, 1000),
    ...extra,
  });

  const executeBatch = async (batch, label) => {
    attemptedBatchCount += 1;
    onProgress({ stage: "PREVIEW", batch: label, batchCount: batches.length, itemCount: batch.length });
    let preview;
    try {
      preview = await listingClient.inventoryPreview(batch);
      const changeIds = (preview.changes || []).map((change) => change.change_id);
      if (changeIds.length !== batch.length || new Set(changeIds).size !== changeIds.length) {
        throw new Error(`预检数量不一致：计划 ${batch.length}，预检 ${changeIds.length}。`);
      }
    } catch (error) {
      const groups = productGroups(batch);
      if (groups.length > 1) {
        const middle = Math.ceil(groups.length / 2);
        await executeBatch(groups.slice(0, middle).flat(), `${label}.1`);
        await executeBatch(groups.slice(middle).flat(), `${label}.2`);
      } else {
        failures.push(failureRecord(batch, "PREVIEW", error));
        failedProducts += 1;
        onProgress({ stage: "ITEM_FAILED", batch: label, failure: failures.at(-1) });
      }
      return;
    }

    const changeIds = (preview.changes || []).map((change) => change.change_id);
    try {
      const submitted = await listingClient.executePreview(preview.preview_token, changeIds);
      const job = await listingClient.waitForJob(submitted.job_id, {
        onProgress: (current) => onProgress({ stage: "PROCESSING", batch: label, batchCount: batches.length, job: current }),
      });
      results.push(job);
      successfulProducts += Number(job.successful_products || 0);
      failedProducts += Number(job.failed_products || 0);
      for (const result of job.results || []) {
        if (result.status !== "failed") continue;
        const productItems = batch.filter((item) => String(item.internal_id) === String(result.internal_id));
        failures.push(failureRecord(productItems.length ? productItems : batch, "EXECUTION", result.message, {
          jobId: job.job_id || submitted.job_id,
          mabangStatus: result.mabang_status || "",
          verificationStatus: result.verification_status || "",
        }));
        onProgress({ stage: "ITEM_FAILED", batch: label, failure: failures.at(-1) });
      }
    } catch (error) {
      const groups = productGroups(batch);
      failedProducts += groups.length;
      for (const group of groups) failures.push(failureRecord(group, "SUBMISSION_OR_READBACK", error));
      results.push({ state: "unknown", message: String(error?.message || error), itemCount: batch.length });
      onProgress({ stage: "BATCH_FAILED", batch: label, error: String(error?.message || error), itemCount: batch.length });
    }
  };

  for (const [index, batch] of batches.entries()) await executeBatch(batch, String(index + 1));
  return {
    plannedBatchCount: batches.length,
    attemptedBatchCount,
    successfulProducts,
    failedProducts,
    failureCount: failures.length,
    failures,
    results,
  };
}
