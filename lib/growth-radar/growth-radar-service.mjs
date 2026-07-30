import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createTemporaryFilePath,
  hashFileBuffer,
  removeFileInsideRoot,
  validateXlsxUpload,
} from "../security/file-policy.mjs";
import { parseGrowthRadarWorkbook } from "./growth-radar-parser.mjs";

const ORDER_KEY_VERSION = "mabang_order_v1";
const LINE_KEY_VERSION = "mabang_order_line_occurrence_v1";
const OBSERVATION_KEY_VERSION = "historical_observed_v1";
const INVENTORY_LINK_KEY_VERSION = "source_sku_warehouse_v1";
const CONFIRMED_MAPPING_STATUSES = new Set(["matched", "manually_confirmed"]);

const PUBLIC_ERROR_MESSAGES = Object.freeze({
  GROWTH_RADAR_PREVIEW_NOT_FOUND: "导入预览不存在或已过期，请重新预览。",
  GROWTH_RADAR_PREVIEW_DOMAIN_MISMATCH: "导入预览类型不匹配。",
  GROWTH_RADAR_PREVIEW_STALE: "导入预览已过期，请重新预览。",
  GROWTH_RADAR_PREVIEW_NOT_CONFIRMED: "导入预览尚未经过服务端确认流程。",
  GROWTH_RADAR_PREVIEW_BLOCKED: "导入预览包含阻断问题，不能应用。",
  GROWTH_RADAR_IDEMPOTENCY_KEY_INVALID: "幂等键格式无效。",
  GROWTH_RADAR_SHOP_INVALID: "店铺主数据不完整或格式无效。",
  GROWTH_RADAR_SHOP_NOT_FOUND: "内部店铺不存在。",
  GROWTH_RADAR_SHOP_MAPPING_NOT_FOUND: "店铺来源映射不存在。",
  GROWTH_RADAR_SHOP_PLATFORM_CONFLICT: "来源平台与内部店铺平台不一致。",
  GROWTH_RADAR_SHOP_CONFIRMATION_INVALID: "店铺国家、平台或来源映射尚未完整，不能确认进入范围。",
  GROWTH_RADAR_SHOP_REVOCATION_REASON_REQUIRED: "取消店铺确认必须填写原因。",
  GROWTH_RADAR_PRODUCT_MAPPING_NOT_FOUND: "SKU 映射不存在。",
  GROWTH_RADAR_PRODUCT_MAPPING_CONFLICT: "所选产品不是该国家与 SKU 的精确候选。",
  GROWTH_RADAR_SOURCE_EMPTY: "来源文件没有可处理的数据行。",
});

const PUBLIC_ISSUE_CODES = Object.freeze({
  GROWTH_RADAR_PREVIEW_STALE: "stale_preview",
  GROWTH_RADAR_PREVIEW_NOT_CONFIRMED: "source_scope_unconfirmed",
});

export class GrowthRadarError extends Error {
  constructor(code, status = 400) {
    super(PUBLIC_ERROR_MESSAGES[code] || "增长雷达数据操作失败。");
    this.name = "GrowthRadarError";
    this.code = code || "GROWTH_RADAR_FAILED";
    this.issueCode = PUBLIC_ISSUE_CODES[this.code] || this.code;
    this.status = status;
  }
}

function sha(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

function normalizeText(value) {
  return String(value || "").normalize("NFKC").trim().replace(/\s+/g, " ");
}

function normalizeShop(value) {
  return normalizeText(value).toLocaleLowerCase("zh-CN");
}

function normalizeSku(value) {
  return normalizeText(value).toUpperCase();
}

function normalizeWarehouse(value) {
  return normalizeText(value).toLocaleUpperCase("en-US");
}

function normalizePlatform(value) {
  const normalized = normalizeText(value).toLocaleLowerCase("en-US").replace(/[\s-]+/g, "_");
  return ({ tiktok: "tiktok_shop", tiktokshop: "tiktok_shop" })[normalized] || normalized;
}

function iso(value = null) {
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function maskIdentifier(value) {
  const text = String(value || "");
  if (!text) return null;
  return `••••${text.slice(-4)}`;
}

function safeScope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { shopScope: [], countryScope: [], warehouseScope: [], semanticScope: [] };
  }
  const allowed = ["platform", "countryCode", "queryType", "dateFrom", "dateTo", "snapshotAt"];
  const result = Object.fromEntries(allowed.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
  for (const key of ["shopScope", "countryScope", "warehouseScope", "semanticScope"]) {
    const values = Array.isArray(value[key]) ? value[key] : (value[key] ? [value[key]] : []);
    result[key] = [...new Set(values.map(normalizeText).filter(Boolean))].slice(0, 500);
  }
  return result;
}

function safePreview(preview) {
  return {
    previewId: preview.id,
    sourceType: preview.sourceType,
    sourceFilename: preview.sourceFilename,
    sourceSha256: preview.sourceSha256,
    sheetName: preview.parsed.sheetName,
    rowCount: preview.parsed.rowCount,
    formulaCellCount: preview.parsed.formulaCellCount,
    redactedHeaders: (preview.parsed.redactedHeaders || [])
      .filter((header) => !(preview.parsed.piiFilteredHeaders || []).includes(header)),
    piiFilteredFieldCount: (preview.parsed.piiFilteredHeaders || []).length,
    sourceScopeStatus: preview.sourceScopeStatus,
    status: preview.status,
    confirmationStatus: preview.confirmationStatus,
    summary: preview.summary,
    issues: preview.issues,
    canApply: preview.summary.canApply,
    sampleRows: preview.parsed.rows.slice(0, 8).map((row) => ({
      sourceRowNumber: row.sourceRowNumber,
      parseStatus: row.parseStatus,
      issueCodes: row.issueCodes,
      normalized: preview.sourceType === "mabang_order" ? {
        orderHint: maskIdentifier(row.normalized.sourceOrderId),
        platform: normalizePlatform(row.normalized.platform),
        sourceShopName: row.normalized.sourceShopName,
        orderStatus: row.normalized.orderStatus,
        sourceSku: row.normalized.sourceSku,
        warehouseName: row.normalized.warehouseName,
        quantity: row.normalized.quantity,
        lineAmountStatus: row.normalized.lineAmountStatus,
      } : {
        sourceSku: row.normalized.sourceSku,
        warehouseName: row.normalized.warehouseName,
        availableQuantity: row.normalized.availableQuantity,
        sourceVisibleSales7d: row.normalized.sourceVisibleSales7d,
        sourceVisibleSales28d: row.normalized.sourceVisibleSales28d,
        sourceVisibleSales42d: row.normalized.sourceVisibleSales42d,
        sourcePredictedDailySales: row.normalized.sourcePredictedDailySales,
        sellableQuantityStatus: row.normalized.sellableQuantityStatus,
        daysOfSupplyStatus: row.normalized.daysOfSupplyStatus,
      },
    })),
    expiresAt: preview.expiresAt,
  };
}

const ISSUE_DETAILS = Object.freeze({
  missing_shop_mapping: ["warning", false, "map_or_confirm_shop"],
  pending_shop_confirmation: ["warning", false, "confirm_shop_scope"],
  missing_sku: ["warning", false, "map_product_sku"],
  empty_source_sku: ["warning", false, "provide_source_sku"],
  empty_source_warehouse: ["warning", false, "provide_source_warehouse"],
  duplicate_source_row: ["warning", false, "remove_duplicate_rows"],
  invalid_order_status: ["warning", false, "use_supported_order_status"],
  pii_field_filtered: ["information", false, "keep_pii_out_of_growth_radar"],
  formula_injection_risk: ["warning", false, "replace_formula_with_plain_value"],
  inventory_key_not_visible_in_source_scope: ["warning", false, "review_sku_warehouse_scope"],
  current_online_source_unavailable: ["information", false, "connect_authoritative_current_online_source"],
  company_sales_source_unavailable: ["information", false, "connect_authoritative_company_sales_source"],
  prediction_not_actual: ["information", false, "keep_prediction_out_of_actual_sales"],
  stale_preview: ["blocker", true, "create_new_preview"],
  source_scope_unconfirmed: ["warning", false, "confirm_preview_application"],
  order_amount_conflict: ["blocker", true, "resolve_order_amount_conflict"],
});

function issue(code, affectedCount, sampleRows = []) {
  const [severity, blocking, recommendedAction] = ISSUE_DETAILS[code] || ["warning", false, "review_source_data"];
  return { issueCode: code, severity, affectedCount: Number(affectedCount || 0),
    sampleRows: sampleRows.slice(0, 5).map((row) => ({ sourceRowNumber: Number(row.sourceRowNumber || row) })),
    blocking, recommendedAction };
}

function canonicalRowIssue(code, sourceType) {
  if (code === "FORMULA_CELL_REDACTED") return "formula_injection_risk";
  if (code === "DUPLICATE_SOURCE_ROW") return "duplicate_source_row";
  if (code === "INVALID_ORDER_STATUS") return "invalid_order_status";
  if (sourceType === "mabang_order" && /SKU.*MISSING|MISSING.*SKU/.test(code)) return "missing_sku";
  if (sourceType === "mabang_inventory" && /SKU.*MISSING|MISSING.*SKU/.test(code)) return "empty_source_sku";
  if (sourceType === "mabang_inventory" && /WAREHOUSE.*MISSING|MISSING.*WAREHOUSE/.test(code)) return "empty_source_warehouse";
  return null;
}

function classifyPreviewRows(sourceType, parsed) {
  const seenRows = new Set();
  const seenInventoryGrains = new Set();
  for (const row of parsed.rows) {
    row.issueCodes ||= [];
    if (sourceType === "mabang_order" && row.parseStatus !== "rejected" && row.normalized?.effectiveStatus === "unconfirmed") {
      row.issueCodes.push("INVALID_ORDER_STATUS");
      row.parseStatus = "rejected";
    }
    let duplicate = seenRows.has(row.rowHash);
    seenRows.add(row.rowHash);
    if (sourceType === "mabang_inventory" && row.parseStatus !== "rejected") {
      const grain = `${normalizeSku(row.normalized?.sourceSku)}\u0000${normalizeWarehouse(row.normalized?.warehouseName)}\u0000${normalizeText(row.normalized?.snapshotAt || parsed.collectionMetadata?.inventorySnapshotAt)}`;
      duplicate ||= seenInventoryGrains.has(grain);
      seenInventoryGrains.add(grain);
    }
    if (duplicate) {
      if (!row.issueCodes.includes("DUPLICATE_SOURCE_ROW")) row.issueCodes.push("DUPLICATE_SOURCE_ROW");
      row.parseStatus = "rejected";
    }
  }
}

function calendarDay(value) {
  const text = normalizeText(value);
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function shiftCalendarDay(value, days) {
  const day = calendarDay(value);
  if (!day) return null;
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function salesWindow(snapshotAt) {
  const endedAt = calendarDay(snapshotAt);
  return endedAt ? { startedAt: shiftCalendarDay(endedAt, -6), endedAt } : null;
}

function batchCoversWindow(batch, window) {
  if (!batch || !window) return false;
  const startedAt = calendarDay(batch.queryStartedAt);
  const endedAt = calendarDay(batch.queryEndedAt);
  return Boolean(startedAt && endedAt && startedAt <= window.startedAt && endedAt >= window.endedAt);
}

function validIdempotency(value, fallback) {
  const result = normalizeText(value || fallback);
  if (!/^[A-Za-z0-9._:-]{8,160}$/.test(result)) throw new GrowthRadarError("GROWTH_RADAR_IDEMPOTENCY_KEY_INVALID");
  return result;
}

function lineSignature(row) {
  return sha({
    sourceSku: normalizeSku(row.sourceSku),
    platformSku: normalizeText(row.platformSku),
    warehouseName: normalizeText(row.warehouseName),
    skuDetail: normalizeText(row.skuDetail),
    productName: normalizeText(row.productName),
    quantity: row.quantity,
    unitSalePrice: row.unitSalePrice,
  });
}

function orderBusinessKey(row) {
  return sha({
    version: ORDER_KEY_VERSION,
    platform: normalizePlatform(row.platform),
    sourceShopName: normalizeShop(row.sourceShopName),
    sourceOrderId: normalizeText(row.sourceOrderId),
  });
}

export class GrowthRadarService {
  constructor({
    repository,
    pythonExecutable,
    parserScript,
    fileStorageConfig,
    parseWorkbook = parseGrowthRadarWorkbook,
    maxRows = 200000,
    parseTimeoutMs = 600000,
    previewTtlMs = 15 * 60 * 1000,
    maxPreviews = 12,
    now = () => new Date(),
  }) {
    this.repository = repository;
    this.pythonExecutable = pythonExecutable;
    this.parserScript = parserScript;
    const workbookLimits = fileStorageConfig?.workbookLimits || {};
    this.fileStorageConfig = Object.freeze({
      ...fileStorageConfig,
      workbookLimits: Object.freeze({
        ...workbookLimits,
        maxEntryBytes: Math.max(
          Number(workbookLimits.maxEntryBytes) || 0,
          128 * 1024 * 1024,
        ),
      }),
    });
    this.parseWorkbook = parseWorkbook;
    this.maxRows = maxRows;
    this.parseTimeoutMs = parseTimeoutMs;
    this.previewTtlMs = previewTtlMs;
    this.maxPreviews = maxPreviews;
    this.now = now;
    this.previews = new Map();
  }

  cleanupPreviews() {
    const current = this.now().getTime();
    for (const [id, preview] of this.previews) {
      if (new Date(preview.expiresAt).getTime() <= current) this.previews.delete(id);
    }
    while (this.previews.size >= this.maxPreviews) this.previews.delete(this.previews.keys().next().value);
  }

  async previewBuffer(sourceType, input) {
    const domain = sourceType === "mabang_order" ? "order" : "inventory";
    const upload = validateXlsxUpload({
      filename: input.filename,
      mimeType: input.mimeType || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: input.buffer,
      config: this.fileStorageConfig,
    });
    const temporary = await createTemporaryFilePath(this.fileStorageConfig.tempRoot, { prefix: `growth-${domain}`, extension: ".xlsx" });
    try {
      await writeFile(temporary.path, input.buffer, { flag: "wx" });
      return await this.previewFile(sourceType, {
        filename: temporary.path,
        sourceFilename: upload.originalFilename,
        sourceSha256: upload.fileHash,
        sourceIdempotencyKey: input.sourceIdempotencyKey || null,
        sourceFileId: input.sourceFileId || null,
        sourceAccountId: input.sourceAccountId || null,
        sourceScope: input.sourceScope,
        collectedAt: input.collectedAt,
      });
    } finally {
      await removeFileInsideRoot(this.fileStorageConfig.tempRoot, temporary.path).catch(() => {});
    }
  }

  async previewFile(sourceType, input) {
    const domain = sourceType === "mabang_order" ? "order" : "inventory";
    if (!new Set(["mabang_order", "mabang_inventory"]).has(sourceType)) throw new TypeError("Growth radar source type is invalid");
    const parsed = await this.parseWorkbook({
      pythonExecutable: this.pythonExecutable,
      parserScript: this.parserScript,
      filename: input.filename,
      domain,
      maxRows: this.maxRows,
      timeoutMs: this.parseTimeoutMs,
    });
    if (!parsed.rowCount) throw new GrowthRadarError("GROWTH_RADAR_SOURCE_EMPTY");
    classifyPreviewRows(sourceType, parsed);
    const sourceSha256 = input.sourceSha256 || hashFileBuffer(await readFile(input.filename));
    const summary = domain === "order" ? await this.orderPreviewSummary(parsed) : await this.inventoryPreviewSummary(parsed);
    this.cleanupPreviews();
    const createdAt = this.now();
    const sourceScope = safeScope(input.sourceScope);
    if (domain === "order") {
      sourceScope.dateFrom ||= summary.orderDateFrom;
      sourceScope.dateTo ||= summary.orderDateTo;
      sourceScope.shopScope = summary.shopScope;
      if (!sourceScope.countryScope.length && sourceScope.countryCode) sourceScope.countryScope = [sourceScope.countryCode];
      sourceScope.semanticScope = ["historical_observed", "own_sales"];
    } else {
      sourceScope.snapshotAt ||= summary.snapshotAt;
      sourceScope.warehouseScope = summary.warehouseScope;
      if (!sourceScope.countryScope.length && sourceScope.countryCode) sourceScope.countryScope = [sourceScope.countryCode];
      sourceScope.semanticScope = ["inventory_snapshot", "source_visible_sales", "source_predicted_daily_sales"];
    }
    const issues = this.previewIssues(sourceType, parsed, summary);
    const preview = {
      id: randomUUID(),
      sourceType,
      sourceFilename: path.basename(input.sourceFilename || input.filename),
      sourceSha256,
      sourceIdempotencyKey: input.sourceIdempotencyKey || sourceSha256,
      sourceFileId: input.sourceFileId || null,
      sourceAccountId: input.sourceAccountId || null,
      sourceScope,
      sourceScopeStatus: "unconfirmed",
      status: "preview_ready",
      confirmationStatus: "pending",
      collectedAt: input.collectedAt ? iso(input.collectedAt) : normalizeText(
        domain === "inventory"
          ? (parsed.collectionMetadata?.inventorySnapshotAt || parsed.collectionMetadata?.exportedAt)
          : parsed.collectionMetadata?.exportedAt,
      ) || (domain === "inventory" ? createdAt.toISOString() : null),
      parsed,
      summary,
      issues,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + this.previewTtlMs).toISOString(),
    };
    this.previews.set(preview.id, preview);
    return safePreview(preview);
  }

  async orderPreviewSummary(parsed) {
    const validRows = parsed.rows.filter((row) => row.parseStatus !== "rejected");
    const groups = new Map();
    const shops = new Set();
    const skus = new Set();
    for (const row of validRows) {
      const normalized = row.normalized;
      const key = orderBusinessKey(normalized);
      groups.set(key, [...(groups.get(key) || []), normalized]);
      shops.add(`${normalizePlatform(normalized.platform)}|${normalizeShop(normalized.sourceShopName)}`);
      skus.add(normalizeSku(normalized.sourceSku));
    }
    let multiLineOrders = 0;
    let maxLinesPerOrder = 0;
    let cancelledOrders = 0;
    let orderAmountConflictCount = 0;
    for (const rows of groups.values()) {
      if (rows.length > 1) multiLineOrders += 1;
      maxLinesPerOrder = Math.max(maxLinesPerOrder, rows.length);
      if (rows[0]?.effectiveStatus === "invalid_cancelled") cancelledOrders += 1;
      if (new Set(rows.map((row) => row.orderAmount).filter((value) => value !== null && value !== undefined).map(String)).size > 1) {
        orderAmountConflictCount += 1;
      }
    }
    let crossCountryAmbiguousSkus = 0;
    let unmatchedSkus = 0;
    let countryUnresolvedSingleCandidateSkus = 0;
    for (const sku of skus) {
      const candidates = await this.repository.productCandidates(sku);
      if (!candidates.length) unmatchedSkus += 1;
      else if (new Set(candidates.map((item) => normalizeText(item.countryCode).toUpperCase())).size > 1 || candidates.length > 1) crossCountryAmbiguousSkus += 1;
      else countryUnresolvedSingleCandidateSkus += 1;
    }
    const orderDays = validRows.map((row) => calendarDay(row.normalized.paidAt)).filter(Boolean).sort();
    const metadataDateFrom = calendarDay(parsed.collectionMetadata?.dateFrom);
    const metadataDateTo = calendarDay(parsed.collectionMetadata?.dateTo);
    let unmatchedShopCount = 0;
    for (const key of shops) {
      const [platform, shop] = key.split("|");
      const mapping = await this.repository.getShopMapping("mabang", platform, shop);
      if (!mapping || !CONFIRMED_MAPPING_STATUSES.has(mapping.mappingStatus) || mapping.shop?.identityStatus !== "confirmed") unmatchedShopCount += 1;
    }
    const duplicateRowCount = parsed.rows.filter((row) => row.issueCodes?.includes("DUPLICATE_SOURCE_ROW")).length;
    const invalidStatusCount = parsed.rows.filter((row) => row.issueCodes?.includes("INVALID_ORDER_STATUS")).length;
    const canApply = validRows.length > 0;
    return {
      rawRowCount: parsed.rowCount,
      validRowCount: validRows.length,
      invalidRowCount: parsed.rowCount - validRows.length,
      duplicateRowCount,
      unmatchedShopCount,
      unmatchedSkuCount: unmatchedSkus,
      excludedStatusCount: cancelledOrders + invalidStatusCount,
      orderAmountConflictCount,
      piiFieldCount: (parsed.piiFilteredHeaders || []).length,
      standardOrderCount: groups.size,
      standardLineCount: validRows.length,
      rejectedRowCount: parsed.rowCount - validRows.length,
      multiLineOrders,
      maxLinesPerOrder,
      cancelledOrders,
      sourceShopCount: shops.size,
      uniqueSkuCount: skus.size,
      crossCountryAmbiguousSkus,
      unmatchedSkus,
      countryUnresolvedSingleCandidateSkus,
      orderDateFrom: metadataDateFrom || orderDays[0] || null,
      orderDateTo: metadataDateTo || orderDays.at(-1) || null,
      dataWindow: { start: metadataDateFrom || orderDays[0] || null, end: metadataDateTo || orderDays.at(-1) || null },
      shopScope: [...shops].map((item) => item.split("|").slice(1).join("|")),
      canApply,
      blockingReasons: canApply ? [] : ["no_valid_order_rows"],
      lineAmountStatus: "unavailable",
      refundDataStatus: "unavailable",
      currentOnlineStatus: "unavailable",
    };
  }

  async inventoryPreviewSummary(parsed) {
    const validRows = parsed.rows.filter((row) => row.parseStatus !== "rejected");
    const skus = new Set();
    const warehouses = new Set();
    const warehousesBySku = new Map();
    const inventoryKeys = new Set();
    for (const row of validRows) {
      const sku = normalizeSku(row.normalized.sourceSku);
      const warehouse = normalizeWarehouse(row.normalized.warehouseName);
      skus.add(sku);
      warehouses.add(warehouse);
      inventoryKeys.add(`${sku}\u0000${warehouse}`);
      warehousesBySku.set(sku, new Set([...(warehousesBySku.get(sku) || []), warehouse]));
    }
    const orderLines = await this.repository.currentOrderLinesForLinkage();
    const matchedOrderLines = orderLines.filter((line) => inventoryKeys.has(
      `${normalizeSku(line.normalized_source_sku)}\u0000${normalizeWarehouse(line.normalized_source_warehouse_name)}`,
    ));
    const duplicateRecordCount = parsed.rows.filter((row) => row.issueCodes?.includes("DUPLICATE_SOURCE_ROW")).length;
    const emptySkuCount = parsed.rows.filter((row) => canonicalRowIssue((row.issueCodes || []).find((code) => /SKU.*MISSING|MISSING.*SKU/.test(code)), "mabang_inventory") === "empty_source_sku").length;
    const emptyWarehouseCount = parsed.rows.filter((row) => canonicalRowIssue((row.issueCodes || []).find((code) => /WAREHOUSE.*MISSING|MISSING.*WAREHOUSE/.test(code)), "mabang_inventory") === "empty_source_warehouse").length;
    let unmatchedSkuCount = 0;
    for (const sku of skus) if (!(await this.repository.productCandidates(sku)).length) unmatchedSkuCount += 1;
    const canApply = validRows.length > 0;
    return {
      rawRowCount: parsed.rowCount,
      validSnapshotCount: validRows.length,
      emptySkuCount,
      emptyWarehouseCount,
      duplicateRecordCount,
      unmatchedSkuCount,
      snapshotCandidateCount: validRows.length,
      rejectedRowCount: parsed.rowCount - validRows.length,
      uniqueSkuCount: skus.size,
      warehouseCount: warehouses.size,
      multiWarehouseSkuCount: [...warehousesBySku.values()].filter((items) => items.size > 1).length,
      matchedOrderLineCount: matchedOrderLines.length,
      unmatchedOrderLineCount: orderLines.length - matchedOrderLines.length,
      sourceScopeStatus: "unconfirmed",
      sourceVisibleSalesStatus: validRows.every((row) => row.normalized.sourceVisibleSalesStatus === "confirmed") ? "confirmed" : "review_required",
      predictedDailySalesStatus: validRows.some((row) => row.normalized.sourcePredictedDailySales !== null)
        ? "source_prediction_not_actual" : "unavailable",
      snapshotAt: parsed.collectionMetadata?.inventorySnapshotAt || parsed.collectionMetadata?.exportedAt || null,
      warehouseScope: [...warehouses].filter(Boolean),
      canApply,
      blockingReasons: canApply ? [] : ["no_valid_inventory_rows"],
      sellableQuantityStatus: "unconfirmed",
      daysOfSupplyStatus: "unavailable",
    };
  }

  previewIssues(sourceType, parsed, summary) {
    const grouped = new Map();
    for (const row of parsed.rows) {
      for (const rawCode of row.issueCodes || []) {
        const code = canonicalRowIssue(rawCode, sourceType);
        if (!code) continue;
        const entry = grouped.get(code) || [];
        entry.push(row);
        grouped.set(code, entry);
      }
    }
    const results = [...grouped].map(([code, rows]) => issue(code, rows.length, rows));
    if ((parsed.piiFilteredHeaders || []).length) results.push(issue("pii_field_filtered", parsed.piiFilteredHeaders.length));
    if (sourceType === "mabang_order") {
      if (summary.unmatchedShopCount) results.push(issue("missing_shop_mapping", summary.unmatchedShopCount));
      if (summary.unmatchedShopCount) results.push(issue("pending_shop_confirmation", summary.unmatchedShopCount));
      if (summary.unmatchedSkuCount) results.push(issue("missing_sku", summary.unmatchedSkuCount));
      if (summary.orderAmountConflictCount) results.push(issue("order_amount_conflict", summary.orderAmountConflictCount));
    } else {
      if (summary.predictedDailySalesStatus === "source_prediction_not_actual") {
        results.push(issue("prediction_not_actual", summary.validSnapshotCount));
      }
      if (summary.unmatchedOrderLineCount) {
        results.push(issue("inventory_key_not_visible_in_source_scope", summary.unmatchedOrderLineCount));
      }
    }
    results.push(issue("current_online_source_unavailable", 1));
    results.push(issue("company_sales_source_unavailable", 1));
    results.push(issue("source_scope_unconfirmed", 1));
    return results;
  }

  getPreview(previewId, sourceType) {
    const preview = this.previews.get(String(previewId || ""));
    if (!preview) throw new GrowthRadarError("GROWTH_RADAR_PREVIEW_NOT_FOUND", 404);
    if (new Date(preview.expiresAt).getTime() <= this.now().getTime()) {
      this.previews.delete(preview.id);
      throw new GrowthRadarError("GROWTH_RADAR_PREVIEW_STALE", 409);
    }
    this.cleanupPreviews();
    if (preview.sourceType !== sourceType) throw new GrowthRadarError("GROWTH_RADAR_PREVIEW_DOMAIN_MISMATCH");
    if (!["preview_ready", "applied"].includes(preview.status)) throw new GrowthRadarError("GROWTH_RADAR_PREVIEW_NOT_CONFIRMED", 409);
    return preview;
  }

  async applyPreview(sourceType, input, audit = {}) {
    if (audit.confirmationGranted !== true) throw new GrowthRadarError("GROWTH_RADAR_PREVIEW_NOT_CONFIRMED", 409);
    const preview = this.getPreview(input.previewId, sourceType);
    if (!preview.summary.canApply || preview.issues.some((item) => item.blocking)) throw new GrowthRadarError("GROWTH_RADAR_PREVIEW_BLOCKED", 409);
    const idempotencyKey = validIdempotency(preview.sourceIdempotencyKey, preview.sourceSha256);
    const existing = await this.repository.getBatchByIdempotency(sourceType, idempotencyKey);
    if (existing) return { batch: existing, reused: true,
      applicationResult: { createdCount: 0, updatedCount: 0, ignoredCount: preview.parsed.rowCount },
      summary: await this.repository.summary() };
    const at = this.now().toISOString();
    const batchId = randomUUID();
    try {
      const applied = await this.repository.provider.transaction(async (tx) => {
        const duplicate = await this.repository.getBatchByIdempotency(sourceType, idempotencyKey, tx);
        if (duplicate) return { batch: duplicate, reused: true,
          applicationResult: { createdCount: 0, updatedCount: 0, ignoredCount: preview.parsed.rowCount } };
        await this.repository.createBatch({
          id: batchId,
          sourceType,
          sourceModule: sourceType === "mabang_order" ? "mabang_orders" : "mabang_inventory",
          sourceFileId: preview.sourceFileId,
          sourceFilename: preview.sourceFilename,
          sourceSha256: preview.sourceSha256,
          sourceAccountId: preview.sourceAccountId,
          idempotencyKey,
          queryStartedAt: preview.sourceScope.dateFrom || null,
          queryEndedAt: preview.sourceScope.dateTo || null,
          collectedAt: preview.collectedAt,
          importedAt: null,
          sourceScope: preview.sourceScope,
          sourceScopeStatus: "confirmed",
          sourceHeaders: preview.parsed.headers.filter((header) => !(preview.parsed.piiFilteredHeaders || []).includes(header)),
          redactedHeaders: preview.parsed.redactedHeaders.filter((header) => !(preview.parsed.piiFilteredHeaders || []).includes(header)),
          piiFilteredFieldCount: (preview.parsed.piiFilteredHeaders || []).length,
          rowCount: preview.parsed.rowCount,
          status: "applying",
          errorCode: null,
          createdBy: audit.actorLabel || "local_session",
          createdAt: at,
          updatedAt: at,
        }, tx);
        for (const previewIssue of preview.issues.filter((item) => item.issueCode !== "source_scope_unconfirmed")) {
          await this.repository.upsertQualityIssue({
            issueKey: sha({ batchId, previewIssue: previewIssue.issueCode }), batchId, entityType: "batch", entityId: batchId,
            issueCode: previewIssue.issueCode, severity: previewIssue.severity,
            message: `来源批次检测到数据质量分类：${previewIssue.issueCode}。`,
            sourceContext: { affectedCount: previewIssue.affectedCount, sampleRows: previewIssue.sampleRows,
              blocking: previewIssue.blocking, recommendedAction: previewIssue.recommendedAction },
            status: "open", createdAt: at,
          }, tx);
        }
        let applicationResult;
        if (sourceType === "mabang_order") {
          applicationResult = await this.applyOrderRows(preview, batchId, at, tx);
          const inventoryBatch = await this.repository.latestAppliedBatch("mabang_inventory", tx);
          if (inventoryBatch) await this.refreshInventoryDerivedFacts(inventoryBatch.id, at, tx, batchId);
        } else {
          applicationResult = await this.applyInventoryRows(preview, batchId, at, tx);
          await this.refreshInventoryDerivedFacts(batchId, at, tx);
        }
        const batch = await this.repository.updateBatch(batchId, { status: "applied", importedAt: at, errorCode: null,
          sourceScopeStatus: "confirmed", updatedAt: at }, tx);
        return { batch, reused: false, applicationResult };
      });
      preview.status = "applied";
      preview.confirmationStatus = "confirmed";
      return { ...applied, summary: await this.repository.summary() };
    } catch (error) {
      throw error;
    }
  }

  async applyOrderRows(preview, batchId, at, tx) {
    const applicationResult = { createdCount: 0, updatedCount: 0,
      ignoredCount: preview.parsed.rows.filter((row) => row.parseStatus === "rejected").length };
    const rowIds = new Map();
    for (const row of preview.parsed.rows) {
      const rawId = await this.repository.insertOrderRaw({
        batchId,
        sheetName: preview.parsed.sheetName,
        sourceRowNumber: row.sourceRowNumber,
        rawValues: row.rawPayload,
        rawTypes: row.rawTypes,
        redactedFields: row.redactedFields.filter((field) => !(preview.parsed.piiFilteredHeaders || []).includes(field)),
        rowHash: row.rowHash,
        parseStatus: row.parseStatus,
        createdAt: at,
      }, tx);
      rowIds.set(row.sourceRowNumber, rawId);
      for (const code of row.issueCodes || []) {
        const issueCode = canonicalRowIssue(code, "mabang_order") || String(code).toLocaleLowerCase("en-US");
        const issueDetail = issue(issueCode, 1, [row]);
        await this.repository.upsertQualityIssue({
          issueKey: sha({ batchId, row: row.sourceRowNumber, code }),
          batchId,
          entityType: "order_raw_row",
          entityId: rawId,
          issueCode,
          severity: issueDetail.severity,
          message: issueCode === "formula_injection_risk" ? "公式单元格未作为业务值导入。" : "订单来源行已按数据质量规则处理。",
          sourceContext: { sourceRowNumber: row.sourceRowNumber, fields: row.formulaFields || [], affectedCount: 1,
            sampleRows: issueDetail.sampleRows, blocking: issueDetail.blocking, recommendedAction: issueDetail.recommendedAction },
          status: "open",
          createdAt: at,
        }, tx);
      }
    }

    const usableRows = preview.parsed.rows.filter((row) => row.parseStatus !== "rejected");
    const groups = new Map();
    const orderIdKeys = new Map();
    for (const row of usableRows) {
      const key = orderBusinessKey(row.normalized);
      groups.set(key, [...(groups.get(key) || []), row]);
      const sourceOrderId = normalizeText(row.normalized.sourceOrderId);
      orderIdKeys.set(sourceOrderId, new Set([...(orderIdKeys.get(sourceOrderId) || []), key]));
    }
    for (const [sourceOrderId, keys] of orderIdKeys) {
      if (keys.size <= 1) continue;
      await this.repository.upsertMappingIssue({
        issueKey: sha({ batchId, issue: "duplicate_order_key", sourceOrderId }),
        issueType: "duplicate_order_key",
        sourceBatchId: batchId,
        sourceRowId: null,
        sourceValue: sourceOrderId,
        candidateValues: [...keys],
        reason: "同一来源订单号出现在多个平台或店铺业务键中。",
        status: "open",
        createdAt: at,
        updatedAt: at,
      }, tx);
    }

    const observationIdentities = new Map();
    for (const [businessKey, rows] of groups) {
      const first = rows[0].normalized;
      const platform = normalizePlatform(first.platform);
      const normalizedSourceShopName = normalizeShop(first.sourceShopName);
      const shopMapping = await this.ensureShopMapping({
        sourceSystem: "mabang",
        platform,
        sourceShopName: first.sourceShopName,
        normalizedSourceShopName,
        batchId,
        at,
        sourceRowId: rowIds.get(rows[0].sourceRowNumber),
        countryCode: preview.sourceScope.countryCode || null,
      }, tx);
      const shopConfirmed = CONFIRMED_MAPPING_STATUSES.has(shopMapping.mappingStatus)
        && shopMapping.shop?.status === "active" && shopMapping.shop?.identityStatus === "confirmed";
      const amounts = [...new Set(rows.map((row) => row.normalized.orderAmount).filter((value) => value !== null && value !== undefined).map(String))];
      const statuses = [...new Set(rows.map((row) => row.normalized.orderStatus))];
      const headerQuality = amounts.length > 1 || statuses.length > 1 ? "review_required" : "confirmed";
      const orderAmount = amounts.length === 1 ? Number(amounts[0]) : null;
      let header = await this.repository.getOrderHeaderByKey(ORDER_KEY_VERSION, businessKey, tx);
      const headerExisted = Boolean(header);
      const headerInput = {
        id: header?.id || randomUUID(),
        businessKey,
        businessKeyVersion: ORDER_KEY_VERSION,
        platform,
        sourceShopName: normalizeText(first.sourceShopName),
        normalizedSourceShopName,
        internalShopId: shopConfirmed ? shopMapping.internalShopId : null,
        mappedCountry: shopConfirmed ? shopMapping.countryCode : null,
        sourceOrderId: normalizeText(first.sourceOrderId),
        orderStatus: normalizeText(first.orderStatus),
        paidAt: first.paidAt || null,
        cancelledAt: first.cancelledAt || null,
        orderCurrency: orderAmount === null ? null : first.orderCurrency,
        orderAmount,
        orderAmountSourceField: orderAmount === null ? null : first.orderAmountSourceField,
        effectiveStatus: first.effectiveStatus,
        firstSourceBatchId: header?.firstSourceBatchId || batchId,
        sourceBatchId: batchId,
        sourceQualityStatus: headerQuality,
        firstSeenAt: header?.firstSeenAt || at,
        lastSeenAt: at,
        createdAt: header?.createdAt || at,
        updatedAt: at,
      };
      header = header
        ? await this.repository.updateOrderHeader(headerInput, tx)
        : await this.repository.insertOrderHeader(headerInput, tx);
      applicationResult[headerExisted ? "updatedCount" : "createdCount"] += 1;
      if (amounts.length > 1) {
        await this.repository.upsertQualityIssue({
          issueKey: sha({ batchId, businessKey, issue: "ORDER_AMOUNT_CONFLICT" }),
          batchId, entityType: "order_header", entityId: header.id, issueCode: "ORDER_AMOUNT_CONFLICT",
          severity: "blocker", message: "同一订单的订单级金额在来源行中不一致，标准金额保持为空。",
          sourceContext: { sourceRowNumbers: rows.map((row) => row.sourceRowNumber) }, status: "open", createdAt: at,
        }, tx);
      }
      const expectedTotals = [...new Set(rows.map((row) => row.normalized.orderSkuTotal).filter((value) => value !== null && value !== undefined).map(Number))];
      const quantityTotal = rows.reduce((sum, row) => sum + Number(row.normalized.quantity || 0), 0);
      if (expectedTotals.length === 1 && expectedTotals[0] !== quantityTotal) {
        await this.repository.upsertQualityIssue({
          issueKey: sha({ batchId, businessKey, issue: "ORDER_QUANTITY_TOTAL_MISMATCH" }),
          batchId, entityType: "order_header", entityId: header.id, issueCode: "ORDER_QUANTITY_TOTAL_MISMATCH",
          severity: "warning", message: "来源订单 SKU 总数量与商品行数量合计不一致。",
          sourceContext: { expectedQuantity: expectedTotals[0], lineQuantity: quantityTotal }, status: "open", createdAt: at,
        }, tx);
      }
      await this.repository.setOrderLinesNotCurrent(header.id, tx);
      const occurrenceBySignature = new Map();
      for (const row of rows) {
        const normalized = row.normalized;
        const signature = lineSignature(normalized);
        const occurrence = (occurrenceBySignature.get(signature) || 0) + 1;
        occurrenceBySignature.set(signature, occurrence);
        const sourceLineKey = sha({ version: LINE_KEY_VERSION, businessKey, signature, occurrence });
        const identity = await this.resolveProductIdentity({
          sourceSystem: "mabang",
          platform,
          countryCode: shopConfirmed ? shopMapping.countryCode : null,
          sourceSku: normalized.sourceSku,
          normalizedSourceSku: normalizeSku(normalized.sourceSku),
          batchId,
          sourceRowId: rowIds.get(row.sourceRowNumber),
          at,
        }, tx);
        let line = await this.repository.getOrderLineByKey(LINE_KEY_VERSION, sourceLineKey, tx);
        const lineExisted = Boolean(line);
        const lineInput = {
          id: line?.id || randomUUID(),
          orderHeaderId: header.id,
          firstSourceBatchId: line?.firstSourceBatchId || batchId,
          sourceBatchId: batchId,
          sourceRowNumber: row.sourceRowNumber,
          sourceLineKey,
          sourceLineKeyVersion: LINE_KEY_VERSION,
          lineOccurrence: occurrence,
          dedupeConfidence: "technical_occurrence",
          sourceSku: normalizeText(normalized.sourceSku),
          normalizedSourceSku: normalizeSku(normalized.sourceSku),
          platformSku: normalizeText(normalized.platformSku) || null,
          sourceWarehouseName: normalizeText(normalized.warehouseName) || null,
          normalizedSourceWarehouseName: normalizeWarehouse(normalized.warehouseName) || null,
          mappedProductId: identity.mappedProductId,
          mappedCountry: identity.mappedCountry,
          quantity: normalized.quantity,
          lineAmount: null,
          lineAmountStatus: "unavailable",
          productName: normalizeText(normalized.productName) || null,
          mappingStatus: identity.mappingStatus,
          effectiveStatus: normalized.effectiveStatus,
          firstSeenAt: line?.firstSeenAt || at,
          lastSeenAt: at,
          createdAt: line?.createdAt || at,
          updatedAt: at,
        };
        if (line && line.orderHeaderId !== header.id) {
          await this.repository.upsertMappingIssue({
            issueKey: sha({ batchId, issue: "duplicate_line_key", sourceLineKey }), issueType: "duplicate_line_key",
            sourceBatchId: batchId, sourceRowId: rowIds.get(row.sourceRowNumber), sourceValue: sourceLineKey,
            candidateValues: [line.orderHeaderId, header.id], reason: "技术明细键关联到多个订单头。", status: "open",
            createdAt: at, updatedAt: at,
          }, tx);
          applicationResult.ignoredCount += 1;
          continue;
        }
        line = line
          ? await this.repository.updateOrderLine(lineInput, tx)
          : await this.repository.insertOrderLine(lineInput, tx);
        applicationResult[lineExisted ? "updatedCount" : "createdCount"] += 1;
        const observationIdentity = `${platform}|${normalizedSourceShopName}|${line.normalizedSourceSku}`;
        observationIdentities.set(observationIdentity, { platform, normalizedSourceShopName, normalizedSourceSku: line.normalizedSourceSku });
      }
    }
    for (const identity of observationIdentities.values()) await this.refreshObservation(identity, at, tx);
    return applicationResult;
  }

  async ensureShopMapping(input, tx) {
    const existing = await this.repository.getShopMapping(input.sourceSystem, input.platform, input.normalizedSourceShopName, tx);
    let shop = existing?.shop || null;
    if (!shop) {
      const internalShopCode = `DISCOVERED-${sha({ platform: input.platform, shop: input.normalizedSourceShopName }).slice(0, 16).toUpperCase()}`;
      shop = await this.repository.getShopByCode(internalShopCode, tx);
      if (!shop) {
        const countryCode = normalizeText(input.countryCode).toUpperCase() || "ZZ";
        shop = await this.repository.createShop({
          id: randomUUID(), internalShopCode, displayName: normalizeText(input.sourceShopName), platform: input.platform,
          countryCode, countryName: countryCode === "ZZ" ? "待确认" : countryCode, ownerUserId: null,
          primaryCategoryScope: [], status: "active", identityStatus: "review_required",
          createdAt: input.at, updatedAt: input.at,
        }, tx);
      }
    }
    const mapping = await this.repository.upsertShopMapping({
      ...(existing || {}),
      sourceSystem: input.sourceSystem,
      sourceShopName: normalizeText(input.sourceShopName),
      normalizedSourceShopName: input.normalizedSourceShopName,
      internalShopId: shop.id,
      platform: input.platform,
      countryCode: shop.countryCode === "ZZ" ? null : shop.countryCode,
      mappingStatus: existing?.mappingStatus || "unmatched",
      mappingSource: existing?.mappingSource || "unresolved",
      firstSourceBatchId: existing?.firstSourceBatchId || input.batchId,
      lastSourceBatchId: input.batchId,
      confirmedBy: existing?.confirmedBy || null,
      confirmedAt: existing?.confirmedAt || null,
      createdAt: input.at,
      updatedAt: input.at,
    }, tx);
    if (!CONFIRMED_MAPPING_STATUSES.has(mapping.mappingStatus) || mapping.shop?.identityStatus !== "confirmed") {
      await this.repository.upsertMappingIssue({
        issueKey: sha({ batchId: input.batchId, issue: "shop_unmatched", platform: input.platform, shop: input.normalizedSourceShopName }),
        issueType: "shop_unmatched", sourceBatchId: input.batchId, sourceRowId: input.sourceRowId,
        sourceValue: normalizeText(input.sourceShopName), candidateValues: [{ shopId: shop.id, confirmationStatus: "pending" }],
        reason: "来源店铺已创建待确认主数据，但尚未进入 Growth Radar 正式范围。",
        status: "open", createdAt: input.at, updatedAt: input.at,
      }, tx);
    }
    return mapping;
  }

  async resolveProductIdentity(input, tx) {
    if (!input.countryCode) {
      const candidates = await this.repository.productCandidates(input.normalizedSourceSku, null, tx);
      const countries = new Set(candidates.map((item) => normalizeText(item.countryCode).toUpperCase()));
      const issueType = candidates.length === 0 ? "sku_unmatched" : (candidates.length > 1 || countries.size > 1 ? "sku_ambiguous" : "country_unresolved");
      const mappingStatus = issueType === "sku_unmatched" ? "unmatched" : (issueType === "sku_ambiguous" ? "ambiguous" : "country_unresolved");
      await this.repository.upsertMappingIssue({
        issueKey: sha({ batchId: input.batchId, issueType, platform: input.platform, sku: input.normalizedSourceSku }),
        issueType, sourceBatchId: input.batchId, sourceRowId: input.sourceRowId,
        sourceValue: input.sourceSku, candidateValues: candidates.map((item) => ({ id: item.id, countryCode: item.countryCode, sku: item.sku })),
        reason: issueType === "country_unresolved" ? "店铺国家未确认，不能自动确认唯一的跨域候选。" : (
          issueType === "sku_ambiguous" ? "同一 SKU 在多个国家存在候选，不能随机选择。" : "产品中心没有该 SKU 候选。"
        ), status: "open", createdAt: input.at, updatedAt: input.at,
      }, tx);
      return { mappedProductId: null, mappedCountry: null, mappingStatus };
    }
    const countryCode = normalizeText(input.countryCode).toUpperCase();
    const existing = await this.repository.getProductMapping(input.sourceSystem, input.platform, countryCode, input.normalizedSourceSku, tx);
    if (existing && CONFIRMED_MAPPING_STATUSES.has(existing.mappingStatus)) {
      return { mappedProductId: existing.internalProductId, mappedCountry: countryCode, mappingStatus: existing.mappingStatus };
    }
    if (existing?.mappingStatus === "revoked") {
      return { mappedProductId: null, mappedCountry: countryCode, mappingStatus: "revoked" };
    }
    const candidates = await this.repository.productCandidates(input.normalizedSourceSku, countryCode, tx);
    const mappingStatus = candidates.length === 1 ? "matched" : (candidates.length ? "ambiguous" : "unmatched");
    const mapping = await this.repository.upsertProductMapping({
      sourceSystem: input.sourceSystem, sourceSku: input.sourceSku, normalizedSourceSku: input.normalizedSourceSku,
      platform: input.platform, countryCode, internalProductId: candidates.length === 1 ? candidates[0].id : null,
      internalSku: candidates.length === 1 ? candidates[0].sku : null, mainSku: candidates.length === 1 ? candidates[0].mainSku : null,
      mappingStatus, mappingSource: candidates.length === 1 ? "exact_country_sku" : "unresolved",
      confidence: candidates.length === 1 ? 1 : null, firstSourceBatchId: existing?.firstSourceBatchId || input.batchId,
      lastSourceBatchId: input.batchId, confirmedBy: null, confirmedAt: null, createdAt: input.at, updatedAt: input.at,
    }, tx);
    if (mappingStatus !== "matched") {
      const issueType = mappingStatus === "ambiguous" ? "sku_ambiguous" : "sku_unmatched";
      await this.repository.upsertMappingIssue({
        issueKey: sha({ batchId: input.batchId, issueType, platform: input.platform, countryCode, sku: input.normalizedSourceSku }),
        issueType, sourceBatchId: input.batchId, sourceRowId: input.sourceRowId, sourceValue: input.sourceSku,
        candidateValues: candidates.map((item) => ({ id: item.id, countryCode: item.countryCode, sku: item.sku })),
        reason: mappingStatus === "ambiguous" ? "国家与 SKU 仍命中多个产品。" : "该国家下没有匹配的产品 SKU。",
        status: "open", createdAt: input.at, updatedAt: input.at,
      }, tx);
    }
    return { mappedProductId: mapping.internalProductId, mappedCountry: countryCode, mappingStatus: mapping.mappingStatus };
  }

  async refreshObservation(identity, at, tx) {
    const aggregate = await this.repository.observationAggregate(identity.platform, identity.normalizedSourceShopName, identity.normalizedSourceSku, tx);
    if (!aggregate) return;
    await this.repository.upsertObservation({
      ...aggregate,
      observationKey: sha({ version: OBSERVATION_KEY_VERSION, platform: identity.platform,
        sourceShopName: identity.normalizedSourceShopName, sourceSku: identity.normalizedSourceSku }),
      createdAt: at,
      updatedAt: at,
    }, tx);
  }

  async applyInventoryRows(preview, batchId, at, tx) {
    const applicationResult = { createdCount: 0, updatedCount: 0,
      ignoredCount: preview.parsed.rows.filter((row) => row.parseStatus === "rejected").length };
    const countryCode = normalizeText(preview.sourceScope.countryCode).toUpperCase() || null;
    const platform = normalizePlatform(preview.sourceScope.platform || "mabang");
    for (const row of preview.parsed.rows) {
      const rawId = await this.repository.insertInventoryRaw({
        batchId, sheetName: preview.parsed.sheetName, sourceRowNumber: row.sourceRowNumber,
        rawValues: row.rawPayload, rawTypes: row.rawTypes,
        redactedFields: (row.redactedFields || []).filter((field) => !(preview.parsed.piiFilteredHeaders || []).includes(field)),
        rowHash: row.rowHash, parseStatus: row.parseStatus, createdAt: at,
      }, tx);
      for (const code of row.issueCodes || []) {
        const issueCode = canonicalRowIssue(code, "mabang_inventory") || String(code).toLocaleLowerCase("en-US");
        const issueDetail = issue(issueCode, 1, [row]);
        await this.repository.upsertQualityIssue({
          issueKey: sha({ batchId, row: row.sourceRowNumber, code }), batchId, entityType: "inventory_raw_row",
          entityId: rawId, issueCode, severity: issueDetail.severity, message: "库存来源行已按数据质量规则处理。",
          sourceContext: { sourceRowNumber: row.sourceRowNumber, fields: row.formulaFields || [], affectedCount: 1,
            sampleRows: issueDetail.sampleRows, blocking: issueDetail.blocking, recommendedAction: issueDetail.recommendedAction },
          status: "open", createdAt: at,
        }, tx);
      }
      if (row.parseStatus === "rejected") continue;
      const normalized = row.normalized;
      const normalizedSourceSku = normalizeSku(normalized.sourceSku);
      let mappedProductId = null;
      let mappingStatus = "country_unresolved";
      if (countryCode) {
        const identity = await this.resolveProductIdentity({ sourceSystem: "mabang", platform, countryCode,
          sourceSku: normalized.sourceSku, normalizedSourceSku, batchId, sourceRowId: null, at }, tx);
        mappedProductId = identity.mappedProductId;
        mappingStatus = CONFIRMED_MAPPING_STATUSES.has(identity.mappingStatus) ? "matched"
          : (identity.mappingStatus === "revoked" ? "unmatched" : identity.mappingStatus);
      }
      await this.repository.insertInventorySnapshot({
        batchId, sourceRowNumber: row.sourceRowNumber, sourceSku: normalizeText(normalized.sourceSku), normalizedSourceSku,
        mappedProductId, warehouseName: normalizeText(normalized.warehouseName) || null,
        normalizedWarehouseName: normalizeWarehouse(normalized.warehouseName),
        productStatus: normalizeText(normalized.productStatus) || null,
        categoryLevel1: normalizeText(normalized.categoryLevel1) || null,
        categoryLevel2: normalizeText(normalized.categoryLevel2) || null,
        categoryLevel3: normalizeText(normalized.categoryLevel3) || null,
        availableQuantity: normalized.availableQuantity, physicalQuantity: normalized.physicalQuantity,
        lockedQuantity: normalized.lockedQuantity, inTransitQuantity: normalized.inTransitQuantity,
        pendingShipmentQuantity: normalized.pendingShipmentQuantity,
        sourceVisibleSales7d: normalized.sourceVisibleSales7d ?? null,
        sourceVisibleSales28d: normalized.sourceVisibleSales28d ?? null,
        sourceVisibleSales42d: normalized.sourceVisibleSales42d ?? null,
        sourcePredictedDailySales: normalized.sourcePredictedDailySales ?? null,
        predictedDailySalesSemanticStatus: normalized.sourcePredictedDailySales == null ? "unavailable" : "unconfirmed",
        snapshotAt: normalized.snapshotAt || preview.collectedAt || at, mappingStatus,
        sourceScopeStatus: "confirmed",
        qualityStatus: normalized.sourceVisibleSalesStatus === "confirmed" ? "confirmed" : "unconfirmed", createdAt: at,
      }, tx);
      applicationResult.createdCount += 1;
    }
    return applicationResult;
  }

  async refreshInventoryDerivedFacts(inventoryBatchId, at, tx, orderBatchId = null) {
    const snapshots = await this.repository.inventorySnapshotsForBatch(inventoryBatchId, tx);
    if (!snapshots.length) return;

    const snapshotByKey = new Map(snapshots.map((snapshot) => [
      `${normalizeSku(snapshot.normalized_source_sku)}\u0000${normalizeWarehouse(snapshot.normalized_warehouse_name)}`,
      snapshot,
    ]));
    const orderLines = await this.repository.currentOrderLinesForLinkage(tx);
    await this.repository.setInventoryLinksNotCurrent(inventoryBatchId, tx);
    for (const line of orderLines) {
      const sku = normalizeSku(line.normalized_source_sku);
      const warehouse = normalizeWarehouse(line.normalized_source_warehouse_name);
      const snapshot = snapshotByKey.get(`${sku}\u0000${warehouse}`) || null;
      const unmatchedReason = snapshot ? null : (!sku ? "order_sku_missing" : (
        !warehouse ? "order_warehouse_missing" : "inventory_key_not_visible_in_source_scope"
      ));
      await this.repository.upsertOrderInventoryLink({
        orderLineId: line.order_line_id,
        orderSourceBatchId: line.order_source_batch_id,
        inventorySnapshotId: snapshot?.id || null,
        inventorySourceBatchId: inventoryBatchId,
        matchKeyVersion: INVENTORY_LINK_KEY_VERSION,
        normalizedSourceSku: sku,
        normalizedSourceWarehouseName: warehouse,
        matchStatus: snapshot ? "matched" : "unmatched",
        unmatchedReason,
        orderEffectiveStatus: line.order_effective_status,
        createdAt: at,
        updatedAt: at,
      }, tx);
    }

    const orderBatch = orderBatchId
      ? await this.repository.getBatch(orderBatchId, tx)
      : await this.repository.currentOrderBatch(tx);
    const orderSalesRows = orderBatch ? await this.repository.orderSalesRowsForBatch(orderBatch.id, tx) : [];
    const aggregateCache = new Map();
    for (const snapshot of snapshots) {
      const window = salesWindow(snapshot.snapshot_at);
      const cacheKey = window ? `${window.startedAt}|${window.endedAt}` : "unavailable";
      if (!aggregateCache.has(cacheKey)) {
        const confirmed = batchCoversWindow(orderBatch, window);
        const aggregates = new Map();
        if (confirmed) {
          for (const row of orderSalesRows) {
            const paidDay = calendarDay(row.paid_at);
            if (!paidDay || paidDay < window.startedAt || paidDay > window.endedAt) continue;
            const key = `${normalizeSku(row.normalized_source_sku)}\u0000${normalizeWarehouse(row.normalized_source_warehouse_name)}`;
            const aggregate = aggregates.get(key) || { quantity: 0, lineCount: 0, orders: new Set() };
            aggregate.quantity += Number(row.quantity || 0);
            aggregate.lineCount += 1;
            aggregate.orders.add(row.order_header_id);
            aggregates.set(key, aggregate);
          }
        }
        aggregateCache.set(cacheKey, { confirmed, aggregates, window });
      }
      const layer = aggregateCache.get(cacheKey);
      const key = `${normalizeSku(snapshot.normalized_source_sku)}\u0000${normalizeWarehouse(snapshot.normalized_warehouse_name)}`;
      const own = layer.aggregates.get(key);
      await this.repository.upsertSkuWarehouseSalesMetric({
        inventorySnapshotId: snapshot.id,
        inventorySourceBatchId: inventoryBatchId,
        orderSourceBatchId: layer.confirmed ? orderBatch?.id || null : null,
        snapshotAt: snapshot.snapshot_at,
        normalizedSourceSku: normalizeSku(snapshot.normalized_source_sku),
        normalizedSourceWarehouseName: normalizeWarehouse(snapshot.normalized_warehouse_name),
        ownSalesQuantity7d: layer.confirmed ? Number(own?.quantity || 0) : null,
        ownSalesOrderCount7d: layer.confirmed ? Number(own?.orders.size || 0) : null,
        ownSalesEffectiveLineCount7d: layer.confirmed ? Number(own?.lineCount || 0) : null,
        ownSalesWindowStartedAt: layer.window?.startedAt || null,
        ownSalesWindowEndedAt: layer.window?.endedAt || null,
        ownSalesQuantity7dStatus: layer.confirmed ? "confirmed" : "unavailable",
        sourceVisibleSales7d: snapshot.source_visible_sales_7d,
        sourceVisibleSales28d: snapshot.source_visible_sales_28d,
        sourceVisibleSales42d: snapshot.source_visible_sales_42d,
        sourcePredictedDailySales: snapshot.source_predicted_daily_sales,
        sourcePredictedDailySalesStatus: snapshot.source_predicted_daily_sales === null
          ? "unavailable" : "source_prediction_not_actual",
        sourceScopeStatus: snapshot.source_scope_status || "unconfirmed",
        createdAt: at,
      }, tx);
    }
  }

  async createShop(input) {
    const internalShopCode = normalizeText(input.internalShopCode).toUpperCase();
    const displayName = normalizeText(input.displayName);
    const platform = normalizePlatform(input.platform);
    const countryCode = normalizeText(input.countryCode).toUpperCase();
    const countryName = normalizeText(input.countryName);
    if (!/^[A-Z0-9][A-Z0-9._-]{2,63}$/.test(internalShopCode) || !displayName || !platform || !/^[A-Z0-9-]{2,8}$/.test(countryCode) || !countryName) {
      throw new GrowthRadarError("GROWTH_RADAR_SHOP_INVALID");
    }
    const at = this.now().toISOString();
    return this.repository.createShop({ id: randomUUID(), internalShopCode, displayName, platform, countryCode, countryName,
      ownerUserId: normalizeText(input.ownerUserId) || null, primaryCategoryScope: Array.isArray(input.primaryCategoryScope) ? input.primaryCategoryScope : [],
      status: input.status === "inactive" ? "inactive" : "active", identityStatus: "review_required", createdAt: at, updatedAt: at });
  }

  async updateShop(id, input) {
    const current = await this.repository.getShop(id);
    if (!current) throw new GrowthRadarError("GROWTH_RADAR_SHOP_NOT_FOUND", 404);
    const next = { ...current, ...input, id };
    const platform = normalizePlatform(next.platform);
    const countryCode = normalizeText(next.countryCode).toUpperCase();
    if (!normalizeText(next.displayName) || !platform || !/^[A-Z0-9-]{2,8}$/.test(countryCode) || !normalizeText(next.countryName)) {
      throw new GrowthRadarError("GROWTH_RADAR_SHOP_INVALID");
    }
    const at = this.now().toISOString();
    return this.repository.provider.transaction(async (tx) => {
      const shop = await this.repository.updateShop({ id, displayName: normalizeText(next.displayName), platform, countryCode,
        countryName: normalizeText(next.countryName), ownerUserId: normalizeText(next.ownerUserId) || null,
        primaryCategoryScope: Array.isArray(next.primaryCategoryScope) ? next.primaryCategoryScope : [],
        status: next.status === "inactive" ? "inactive" : "active", identityStatus: current.identityStatus, updatedAt: at }, tx);
      if (current.identityStatus !== "confirmed") {
        await this.repository.updatePendingShopMappingScope(id, { platform, countryCode: countryCode === "ZZ" ? null : countryCode, updatedAt: at }, tx);
      }
      return shop;
    });
  }

  async confirmShopScope(id, audit = {}) {
    const actor = audit.actorLabel || "local_session";
    const at = this.now().toISOString();
    return this.repository.provider.transaction(async (tx) => {
      const current = await this.repository.getShop(id, tx);
      if (!current) throw new GrowthRadarError("GROWTH_RADAR_SHOP_NOT_FOUND", 404);
      const mappings = await this.repository.shopMappingsForShop(id, tx);
      if (!mappings.length || current.status !== "active" || current.countryCode === "ZZ"
        || mappings.some((mapping) => normalizePlatform(mapping.platform) !== normalizePlatform(current.platform))) {
        throw new GrowthRadarError("GROWTH_RADAR_SHOP_CONFIRMATION_INVALID", 409);
      }
      if (current.identityStatus === "confirmed" && mappings.every((mapping) => CONFIRMED_MAPPING_STATUSES.has(mapping.mappingStatus))) {
        return { shop: current, mappings, history: await this.repository.shopConfirmationHistory(id, tx), reused: true,
          confirmedBy: mappings[0].confirmedBy, confirmedAt: mappings[0].confirmedAt };
      }
      const shop = await this.repository.updateShop({ ...current, identityStatus: "confirmed", updatedAt: at }, tx);
      const confirmedMappings = [];
      for (const before of mappings) {
        const mapping = await this.repository.upsertShopMapping({ ...before, internalShopId: id, countryCode: shop.countryCode,
          mappingStatus: "manually_confirmed", mappingSource: "manual", confirmedBy: actor, confirmedAt: at, updatedAt: at }, tx);
        await this.repository.insertMappingEvent({ mappingType: "shop", mappingId: mapping.id, action: "confirmed",
          before, after: { ...mapping, shopConfirmationStatus: "confirmed", changedFields: ["identityStatus", "mappingStatus", "countryCode"] },
          actorLabel: actor, requestId: audit.requestId || null, occurredAt: at }, tx);
        await this.reprocessShopMapping(mapping, at, tx);
        confirmedMappings.push(mapping);
      }
      await this.repository.resolveMappingIssues(["shop_unmatched", "shop_ambiguous"], mappings[0].sourceShopName, id, actor, at, tx);
      return { shop, mappings: confirmedMappings, history: await this.repository.shopConfirmationHistory(id, tx), reused: false,
        confirmedBy: actor, confirmedAt: at };
    });
  }

  async revokeShopScope(id, input = {}, audit = {}) {
    const reason = normalizeText(input.reason).slice(0, 500);
    if (!reason) throw new GrowthRadarError("GROWTH_RADAR_SHOP_REVOCATION_REASON_REQUIRED");
    const actor = audit.actorLabel || "local_session";
    const at = this.now().toISOString();
    return this.repository.provider.transaction(async (tx) => {
      const current = await this.repository.getShop(id, tx);
      if (!current) throw new GrowthRadarError("GROWTH_RADAR_SHOP_NOT_FOUND", 404);
      const mappings = await this.repository.shopMappingsForShop(id, tx);
      if (current.identityStatus !== "confirmed" && mappings.every((mapping) => mapping.mappingStatus === "revoked")) {
        return { shop: current, mappings, history: await this.repository.shopConfirmationHistory(id, tx), reused: true };
      }
      const shop = await this.repository.updateShop({ ...current, identityStatus: "review_required", updatedAt: at }, tx);
      const revokedMappings = [];
      for (const before of mappings) {
        const mapping = await this.repository.upsertShopMapping({ ...before, internalShopId: id, mappingStatus: "revoked",
          mappingSource: "revoked", confirmedBy: null, confirmedAt: null, updatedAt: at }, tx);
        await this.repository.insertMappingEvent({ mappingType: "shop", mappingId: mapping.id, action: "revoked",
          before, after: { ...mapping, shopConfirmationStatus: "pending", reason, changedFields: ["identityStatus", "mappingStatus"] },
          actorLabel: actor, requestId: audit.requestId || null, occurredAt: at }, tx);
        await this.reprocessShopMapping(mapping, at, tx);
        if (mapping.lastSourceBatchId) {
          await this.repository.upsertMappingIssue({ issueKey: sha({ issue: "shop_unmatched", mappingId: mapping.id, at }),
            issueType: "shop_unmatched", sourceBatchId: mapping.lastSourceBatchId, sourceRowId: null,
            sourceValue: mapping.sourceShopName, candidateValues: [{ shopId: id }], reason: "店铺范围确认已取消。",
            status: "open", createdAt: at, updatedAt: at }, tx);
        }
        revokedMappings.push(mapping);
      }
      return { shop, mappings: revokedMappings, history: await this.repository.shopConfirmationHistory(id, tx), reused: false,
        revokedBy: actor, revokedAt: at, reason };
    });
  }

  async confirmShopMapping(input, audit = {}) {
    const current = await this.repository.getShopMappingById(input.mappingId);
    if (!current) throw new GrowthRadarError("GROWTH_RADAR_SHOP_MAPPING_NOT_FOUND", 404);
    const shop = await this.repository.getShop(input.internalShopId);
    if (!shop) throw new GrowthRadarError("GROWTH_RADAR_SHOP_NOT_FOUND", 404);
    if (normalizePlatform(shop.platform) !== normalizePlatform(current.platform)) throw new GrowthRadarError("GROWTH_RADAR_SHOP_PLATFORM_CONFLICT", 409);
    const at = this.now().toISOString();
    return this.repository.provider.transaction(async (tx) => {
      const mapping = await this.repository.upsertShopMapping({ ...current, internalShopId: shop.id,
        countryCode: shop.countryCode, mappingStatus: "manually_confirmed", mappingSource: "manual",
        confirmedBy: audit.actorLabel || "local_session", confirmedAt: at, updatedAt: at }, tx);
      await this.repository.insertMappingEvent({ mappingType: "shop", mappingId: mapping.id, action: "confirmed",
        before: current, after: mapping, actorLabel: audit.actorLabel || "local_session", requestId: audit.requestId || null, occurredAt: at }, tx);
      await this.reprocessShopMapping(mapping, at, tx);
      if (await this.repository.unresolvedShopMappingCount(mapping.normalizedSourceShopName, tx) === 0) {
        await this.repository.resolveMappingIssues(["shop_unmatched", "shop_ambiguous"], current.sourceShopName, shop.id,
          audit.actorLabel || "local_session", at, tx);
      }
      return { mapping, history: await this.repository.mappingEvents("shop", mapping.id, tx) };
    });
  }

  async revokeShopMapping(input, audit = {}) {
    const current = await this.repository.getShopMappingById(input.mappingId);
    if (!current) throw new GrowthRadarError("GROWTH_RADAR_SHOP_MAPPING_NOT_FOUND", 404);
    const at = this.now().toISOString();
    return this.repository.provider.transaction(async (tx) => {
      const mapping = await this.repository.upsertShopMapping({ ...current, internalShopId: null, countryCode: null,
        mappingStatus: "revoked", mappingSource: "revoked", confirmedBy: null, confirmedAt: null, updatedAt: at }, tx);
      await this.repository.insertMappingEvent({ mappingType: "shop", mappingId: mapping.id, action: "revoked",
        before: current, after: mapping, actorLabel: audit.actorLabel || "local_session", requestId: audit.requestId || null, occurredAt: at }, tx);
      await this.reprocessShopMapping(mapping, at, tx);
      await this.repository.upsertMappingIssue({ issueKey: sha({ issue: "shop_unmatched", mappingId: mapping.id, at }),
        issueType: "shop_unmatched", sourceBatchId: mapping.lastSourceBatchId, sourceRowId: null,
        sourceValue: mapping.sourceShopName, candidateValues: [], reason: "店铺来源映射已被人工撤销。",
        status: "open", createdAt: at, updatedAt: at }, tx);
      return { mapping, history: await this.repository.mappingEvents("shop", mapping.id, tx) };
    });
  }

  async reprocessShopMapping(mapping, at, tx) {
    const confirmed = CONFIRMED_MAPPING_STATUSES.has(mapping.mappingStatus)
      && mapping.shop?.identityStatus === "confirmed" && mapping.shop?.status === "active";
    const orders = await this.repository.ordersForSourceShop(mapping.platform, mapping.normalizedSourceShopName, tx);
    for (const order of orders) {
      await this.repository.updateOrderShop(order.id, { internalShopId: confirmed ? mapping.internalShopId : null,
        mappedCountry: confirmed ? mapping.countryCode : null, updatedAt: at }, tx);
      const lines = await this.repository.currentLinesForOrder(order.id, tx);
      for (const line of lines) {
        const identity = await this.resolveProductIdentity({ sourceSystem: "mabang", platform: mapping.platform,
          countryCode: confirmed ? mapping.countryCode : null, sourceSku: line.sourceSku,
          normalizedSourceSku: line.normalizedSourceSku, batchId: line.sourceBatchId, sourceRowId: null, at }, tx);
        await this.repository.updateLineIdentity(line.id, { mappedProductId: identity.mappedProductId,
          mappedCountry: identity.mappedCountry, mappingStatus: identity.mappingStatus, updatedAt: at }, tx);
      }
    }
    for (const sku of await this.repository.identitiesForSourceShop(mapping.platform, mapping.normalizedSourceShopName, tx)) {
      await this.refreshObservation({ platform: mapping.platform, normalizedSourceShopName: mapping.normalizedSourceShopName,
        normalizedSourceSku: sku }, at, tx);
      if (await this.repository.unresolvedProductLineCount(sku, tx) === 0) {
        await this.repository.resolveMappingIssues(["country_unresolved", "sku_unmatched", "sku_ambiguous", "product_country_conflict"],
          sku, "deterministic_country_sku", mapping.confirmedBy || "system_reprocess", at, tx);
      }
    }
  }

  async confirmProductMapping(input, audit = {}) {
    const current = await this.repository.getProductMappingById(input.mappingId);
    if (!current) throw new GrowthRadarError("GROWTH_RADAR_PRODUCT_MAPPING_NOT_FOUND", 404);
    const candidates = await this.repository.productCandidates(current.normalizedSourceSku, current.countryCode);
    const product = candidates.find((item) => item.id === input.internalProductId);
    if (!product) throw new GrowthRadarError("GROWTH_RADAR_PRODUCT_MAPPING_CONFLICT", 409);
    const at = this.now().toISOString();
    return this.repository.provider.transaction(async (tx) => {
      const mapping = await this.repository.upsertProductMapping({ ...current, internalProductId: product.id,
        internalSku: product.sku, mainSku: product.mainSku, mappingStatus: "manually_confirmed", mappingSource: "manual",
        confidence: 1, confirmedBy: audit.actorLabel || "local_session", confirmedAt: at, updatedAt: at }, tx);
      await this.repository.insertMappingEvent({ mappingType: "product", mappingId: mapping.id, action: "confirmed",
        before: current, after: mapping, actorLabel: audit.actorLabel || "local_session", requestId: audit.requestId || null, occurredAt: at }, tx);
      for (const line of await this.repository.currentLinesForIdentity(mapping.platform, mapping.countryCode, mapping.normalizedSourceSku, tx)) {
        await this.repository.updateLineIdentity(line.id, { mappedProductId: product.id, mappedCountry: mapping.countryCode,
          mappingStatus: "manually_confirmed", updatedAt: at }, tx);
      }
      if (await this.repository.unresolvedProductLineCount(mapping.normalizedSourceSku, tx) === 0) {
        await this.repository.resolveMappingIssues(["country_unresolved", "sku_unmatched", "sku_ambiguous", "product_country_conflict"],
          mapping.sourceSku, product.id, audit.actorLabel || "local_session", at, tx);
      }
      return { mapping, history: await this.repository.mappingEvents("product", mapping.id, tx) };
    });
  }

  async revokeProductMapping(input, audit = {}) {
    const current = await this.repository.getProductMappingById(input.mappingId);
    if (!current) throw new GrowthRadarError("GROWTH_RADAR_PRODUCT_MAPPING_NOT_FOUND", 404);
    const at = this.now().toISOString();
    return this.repository.provider.transaction(async (tx) => {
      const mapping = await this.repository.upsertProductMapping({ ...current, internalProductId: null, internalSku: null,
        mainSku: null, mappingStatus: "revoked", mappingSource: "revoked", confidence: null,
        confirmedBy: null, confirmedAt: null, updatedAt: at }, tx);
      await this.repository.insertMappingEvent({ mappingType: "product", mappingId: mapping.id, action: "revoked",
        before: current, after: mapping, actorLabel: audit.actorLabel || "local_session", requestId: audit.requestId || null, occurredAt: at }, tx);
      for (const line of await this.repository.currentLinesForIdentity(mapping.platform, mapping.countryCode, mapping.normalizedSourceSku, tx)) {
        await this.repository.updateLineIdentity(line.id, { mappedProductId: null, mappedCountry: mapping.countryCode,
          mappingStatus: "revoked", updatedAt: at }, tx);
      }
      await this.repository.upsertMappingIssue({ issueKey: sha({ issue: "sku_unmatched", mappingId: mapping.id, at }),
        issueType: "sku_unmatched", sourceBatchId: mapping.lastSourceBatchId, sourceRowId: null, sourceValue: mapping.sourceSku,
        candidateValues: [], reason: "SKU 映射已被人工撤销。", status: "open", createdAt: at, updatedAt: at }, tx);
      return { mapping, history: await this.repository.mappingEvents("product", mapping.id, tx) };
    });
  }

  listBatches(filters) { return this.repository.listBatches(filters); }
  batchDetail(id) { return this.repository.batchDetail(id); }
  listShops(filters) { return this.repository.listShops(filters); }
  async shopDetail(id) {
    const shop = await this.repository.getShop(id);
    if (!shop) throw new GrowthRadarError("GROWTH_RADAR_SHOP_NOT_FOUND", 404);
    return { shop, mappings: await this.repository.shopMappingsForShop(id), history: await this.repository.shopConfirmationHistory(id) };
  }
  listShopMappings(filters) { return this.repository.listShopMappings(filters); }
  listProductMappings(filters) { return this.repository.listProductMappings(filters); }
  listMappingIssues(filters) { return this.repository.listMappingIssues(filters); }
  listQualityIssues(filters) { return this.repository.listQualityIssues(filters); }
  listObservations(filters) { return this.repository.listObservations(filters); }
  mappingHistory(type, id) { return this.repository.mappingEvents(type, id); }
  shopConfirmationHistory(id) { return this.repository.shopConfirmationHistory(id); }
  summary() { return this.repository.summary(); }
  freshness() { return this.repository.freshness(); }

  async semanticStatus() {
    const metrics = await this.repository.semanticMetrics(this.now().toISOString());
    const semantic = ({ value, semanticType, source, observedAt = null, snapshotAt = null,
      confirmationStatus = "unconfirmed", availabilityStatus = "unavailable" }) => ({
      value, semantic_type: semanticType, source, observed_at: observedAt, snapshot_at: snapshotAt,
      confirmation_status: confirmationStatus, availability_status: availabilityStatus,
    });
    const orderAvailable = Boolean(metrics.orderBatch);
    const inventoryAvailable = Boolean(metrics.inventoryBatch);
    return {
      source_types: {
        mabang_order: { source_system: "mabang", availability_status: orderAvailable ? "available" : "unavailable" },
        mabang_inventory: { source_system: "mabang", availability_status: inventoryAvailable ? "available" : "unavailable" },
        current_online: { source_system: null, availability_status: metrics.currentOnline.rowCount ? "available" : "unavailable" },
        company_sales: { source_system: null, availability_status: "unavailable" },
        manual_mapping: { source_system: "growth_mapping_events", availability_status: "available" },
      },
      historical_observed: semantic({ value: orderAvailable ? metrics.historical.value : null,
        semanticType: "historical_observed", source: orderAvailable ? "mabang_order" : null,
        observedAt: metrics.historical.observedAt, confirmationStatus: metrics.orderBatch?.confirmationStatus || "unconfirmed",
        availabilityStatus: orderAvailable ? "available" : "unavailable" }),
      current_online: semantic({ value: metrics.currentOnline.rowCount ? metrics.currentOnline.rowCount : null,
        semanticType: "current_online", source: metrics.currentOnline.rowCount ? "current_online" : null,
        observedAt: metrics.currentOnline.observedAt, confirmationStatus: metrics.currentOnline.rowCount ? "confirmed" : "unconfirmed",
        availabilityStatus: metrics.currentOnline.rowCount ? "available" : "unavailable" }),
      own_sales: semantic({ value: orderAvailable ? metrics.own.value : null, semanticType: "own_sales",
        source: orderAvailable ? "mabang_order" : null, observedAt: metrics.own.observedAt,
        confirmationStatus: metrics.orderBatch?.confirmationStatus || "unconfirmed",
        availabilityStatus: orderAvailable ? "available" : "unavailable" }),
      company_sales: semantic({ value: null, semanticType: "company_sales", source: null,
        confirmationStatus: "unconfirmed", availabilityStatus: "unavailable" }),
      source_visible_sales: semantic({ value: inventoryAvailable ? { days7: metrics.visible.value7d,
        days28: metrics.visible.value28d, days42: metrics.visible.value42d } : null,
        semanticType: "source_visible_sales", source: inventoryAvailable ? "mabang_inventory" : null,
        snapshotAt: metrics.visible.snapshotAt, confirmationStatus: metrics.inventoryBatch?.confirmationStatus || "unconfirmed",
        availabilityStatus: metrics.visible.rowCount ? "available" : "unavailable" }),
      source_predicted_daily_sales: semantic({ value: metrics.prediction.rowCount ? metrics.prediction.value : null,
        semanticType: "source_predicted_daily_sales", source: inventoryAvailable ? "mabang_inventory" : null,
        snapshotAt: metrics.prediction.snapshotAt, confirmationStatus: metrics.inventoryBatch?.confirmationStatus || "unconfirmed",
        availabilityStatus: metrics.prediction.rowCount ? "source_prediction_not_actual" : "unavailable" }),
      opportunity_scope: {
        confirmed_observation_count: metrics.eligible.rowCount,
        historical_only: true,
        current_online_available: metrics.currentOnline.rowCount > 0,
      },
    };
  }
}
