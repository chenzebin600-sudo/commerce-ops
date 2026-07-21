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
const CONFIRMED_MAPPING_STATUSES = new Set(["matched", "manually_confirmed"]);

const PUBLIC_ERROR_MESSAGES = Object.freeze({
  GROWTH_RADAR_PREVIEW_NOT_FOUND: "导入预览不存在或已过期，请重新预览。",
  GROWTH_RADAR_PREVIEW_DOMAIN_MISMATCH: "导入预览类型不匹配。",
  GROWTH_RADAR_IDEMPOTENCY_KEY_INVALID: "幂等键格式无效。",
  GROWTH_RADAR_SHOP_INVALID: "店铺主数据不完整或格式无效。",
  GROWTH_RADAR_SHOP_NOT_FOUND: "内部店铺不存在。",
  GROWTH_RADAR_SHOP_MAPPING_NOT_FOUND: "店铺来源映射不存在。",
  GROWTH_RADAR_SHOP_PLATFORM_CONFLICT: "来源平台与内部店铺平台不一致。",
  GROWTH_RADAR_PRODUCT_MAPPING_NOT_FOUND: "SKU 映射不存在。",
  GROWTH_RADAR_PRODUCT_MAPPING_CONFLICT: "所选产品不是该国家与 SKU 的精确候选。",
  GROWTH_RADAR_SOURCE_EMPTY: "来源文件没有可处理的数据行。",
});

export class GrowthRadarError extends Error {
  constructor(code, status = 400) {
    super(PUBLIC_ERROR_MESSAGES[code] || "增长雷达数据操作失败。");
    this.name = "GrowthRadarError";
    this.code = code || "GROWTH_RADAR_FAILED";
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
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const allowed = ["platform", "countryCode", "queryType", "dateFrom", "dateTo", "warehouseScope"];
  return Object.fromEntries(allowed.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
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
    redactedHeaders: preview.parsed.redactedHeaders,
    summary: preview.summary,
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
        quantity: row.normalized.quantity,
        lineAmountStatus: row.normalized.lineAmountStatus,
      } : {
        sourceSku: row.normalized.sourceSku,
        warehouseName: row.normalized.warehouseName,
        availableQuantity: row.normalized.availableQuantity,
        sellableQuantityStatus: row.normalized.sellableQuantityStatus,
        daysOfSupplyStatus: row.normalized.daysOfSupplyStatus,
      },
    })),
    expiresAt: preview.expiresAt,
  };
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

function issueSeverity(code) {
  return /MISSING|INVALID/.test(code) ? "blocker" : "warning";
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
    this.fileStorageConfig = fileStorageConfig;
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
    const sourceSha256 = input.sourceSha256 || hashFileBuffer(await readFile(input.filename));
    const summary = domain === "order" ? await this.orderPreviewSummary(parsed) : this.inventoryPreviewSummary(parsed);
    this.cleanupPreviews();
    const createdAt = this.now();
    const preview = {
      id: randomUUID(),
      sourceType,
      sourceFilename: path.basename(input.sourceFilename || input.filename),
      sourceSha256,
      sourceFileId: input.sourceFileId || null,
      sourceAccountId: input.sourceAccountId || null,
      sourceScope: safeScope(input.sourceScope),
      collectedAt: input.collectedAt ? iso(input.collectedAt) : null,
      parsed,
      summary,
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
    for (const rows of groups.values()) {
      if (rows.length > 1) multiLineOrders += 1;
      maxLinesPerOrder = Math.max(maxLinesPerOrder, rows.length);
      if (rows[0]?.effectiveStatus === "invalid_cancelled") cancelledOrders += 1;
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
    return {
      rawRowCount: parsed.rowCount,
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
      lineAmountStatus: "unavailable",
      refundDataStatus: "unavailable",
      currentOnlineStatus: "not_implemented",
    };
  }

  inventoryPreviewSummary(parsed) {
    const validRows = parsed.rows.filter((row) => row.parseStatus !== "rejected");
    return {
      rawRowCount: parsed.rowCount,
      snapshotCandidateCount: validRows.length,
      rejectedRowCount: parsed.rowCount - validRows.length,
      sellableQuantityStatus: "unconfirmed",
      daysOfSupplyStatus: "unavailable",
      productionSampleValidated: false,
    };
  }

  getPreview(previewId, sourceType) {
    this.cleanupPreviews();
    const preview = this.previews.get(String(previewId || ""));
    if (!preview) throw new GrowthRadarError("GROWTH_RADAR_PREVIEW_NOT_FOUND", 404);
    if (preview.sourceType !== sourceType) throw new GrowthRadarError("GROWTH_RADAR_PREVIEW_DOMAIN_MISMATCH");
    return preview;
  }

  async applyPreview(sourceType, input, audit = {}) {
    const preview = this.getPreview(input.previewId, sourceType);
    const idempotencyKey = validIdempotency(input.idempotencyKey, preview.sourceSha256);
    const existing = await this.repository.getBatchByIdempotency(sourceType, idempotencyKey);
    if (existing) return { batch: existing, reused: true, summary: await this.repository.summary() };
    const at = this.now().toISOString();
    const batchId = randomUUID();
    try {
      const batch = await this.repository.provider.transaction(async (tx) => {
        const duplicate = await this.repository.getBatchByIdempotency(sourceType, idempotencyKey, tx);
        if (duplicate) return duplicate;
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
          sourceHeaders: preview.parsed.headers,
          redactedHeaders: preview.parsed.redactedHeaders,
          rowCount: preview.parsed.rowCount,
          status: "applying",
          errorCode: null,
          createdBy: audit.actorLabel || "local_session",
          createdAt: at,
          updatedAt: at,
        }, tx);
        if (sourceType === "mabang_order") await this.applyOrderRows(preview, batchId, at, tx);
        else await this.applyInventoryRows(preview, batchId, at, tx);
        return this.repository.updateBatch(batchId, { status: "applied", importedAt: at, errorCode: null, updatedAt: at }, tx);
      });
      return { batch, reused: false, summary: await this.repository.summary() };
    } catch (error) {
      throw error;
    }
  }

  async applyOrderRows(preview, batchId, at, tx) {
    const rowIds = new Map();
    for (const row of preview.parsed.rows) {
      const rawId = await this.repository.insertOrderRaw({
        batchId,
        sheetName: preview.parsed.sheetName,
        sourceRowNumber: row.sourceRowNumber,
        rawValues: row.rawPayload,
        rawTypes: row.rawTypes,
        redactedFields: row.redactedFields,
        rowHash: row.rowHash,
        parseStatus: row.parseStatus,
        createdAt: at,
      }, tx);
      rowIds.set(row.sourceRowNumber, rawId);
      for (const code of row.issueCodes || []) {
        await this.repository.upsertQualityIssue({
          issueKey: sha({ batchId, row: row.sourceRowNumber, code }),
          batchId,
          entityType: "order_raw_row",
          entityId: rawId,
          issueCode: code,
          severity: issueSeverity(code),
          message: code === "FORMULA_CELL_REDACTED" ? "公式单元格未作为业务值导入。" : "订单来源行缺少必填值或类型无效。",
          sourceContext: { sourceRowNumber: row.sourceRowNumber, fields: row.formulaFields || [] },
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
      }, tx);
      const shopConfirmed = CONFIRMED_MAPPING_STATUSES.has(shopMapping.mappingStatus) && shopMapping.shop?.status === "active";
      const amounts = [...new Set(rows.map((row) => row.normalized.orderAmount).filter((value) => value !== null && value !== undefined).map(String))];
      const statuses = [...new Set(rows.map((row) => row.normalized.orderStatus))];
      const headerQuality = amounts.length > 1 || statuses.length > 1 ? "review_required" : "confirmed";
      const orderAmount = amounts.length === 1 ? Number(amounts[0]) : null;
      let header = await this.repository.getOrderHeaderByKey(ORDER_KEY_VERSION, businessKey, tx);
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
          continue;
        }
        line = line
          ? await this.repository.updateOrderLine(lineInput, tx)
          : await this.repository.insertOrderLine(lineInput, tx);
        const observationIdentity = `${platform}|${normalizedSourceShopName}|${line.normalizedSourceSku}`;
        observationIdentities.set(observationIdentity, { platform, normalizedSourceShopName, normalizedSourceSku: line.normalizedSourceSku });
      }
    }
    for (const identity of observationIdentities.values()) await this.refreshObservation(identity, at, tx);
  }

  async ensureShopMapping(input, tx) {
    const existing = await this.repository.getShopMapping(input.sourceSystem, input.platform, input.normalizedSourceShopName, tx);
    if (existing) {
      return this.repository.upsertShopMapping({
        ...existing,
        sourceShopName: normalizeText(input.sourceShopName),
        firstSourceBatchId: existing.firstSourceBatchId || input.batchId,
        lastSourceBatchId: input.batchId,
        updatedAt: input.at,
      }, tx);
    }
    const mapping = await this.repository.upsertShopMapping({
      sourceSystem: input.sourceSystem,
      sourceShopName: normalizeText(input.sourceShopName),
      normalizedSourceShopName: input.normalizedSourceShopName,
      internalShopId: null,
      platform: input.platform,
      countryCode: null,
      mappingStatus: "unmatched",
      mappingSource: "unresolved",
      firstSourceBatchId: input.batchId,
      lastSourceBatchId: input.batchId,
      confirmedBy: null,
      confirmedAt: null,
      createdAt: input.at,
      updatedAt: input.at,
    }, tx);
    await this.repository.upsertMappingIssue({
      issueKey: sha({ batchId: input.batchId, issue: "shop_unmatched", platform: input.platform, shop: input.normalizedSourceShopName }),
      issueType: "shop_unmatched", sourceBatchId: input.batchId, sourceRowId: input.sourceRowId,
      sourceValue: normalizeText(input.sourceShopName), candidateValues: [], reason: "来源店铺尚未映射到稳定内部店铺。",
      status: "open", createdAt: input.at, updatedAt: input.at,
    }, tx);
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
    const countryCode = normalizeText(preview.sourceScope.countryCode).toUpperCase() || null;
    const platform = normalizePlatform(preview.sourceScope.platform || "mabang");
    for (const row of preview.parsed.rows) {
      const rawId = await this.repository.insertInventoryRaw({
        batchId, sheetName: preview.parsed.sheetName, sourceRowNumber: row.sourceRowNumber,
        rawValues: row.rawPayload, rawTypes: row.rawTypes, redactedFields: row.redactedFields,
        rowHash: row.rowHash, parseStatus: row.parseStatus, createdAt: at,
      }, tx);
      for (const code of row.issueCodes || []) {
        await this.repository.upsertQualityIssue({
          issueKey: sha({ batchId, row: row.sourceRowNumber, code }), batchId, entityType: "inventory_raw_row",
          entityId: rawId, issueCode: code, severity: issueSeverity(code), message: "库存来源行缺少必填值或类型无效。",
          sourceContext: { sourceRowNumber: row.sourceRowNumber, fields: row.formulaFields || [] }, status: "open", createdAt: at,
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
        availableQuantity: normalized.availableQuantity, physicalQuantity: normalized.physicalQuantity,
        lockedQuantity: normalized.lockedQuantity, inTransitQuantity: normalized.inTransitQuantity,
        pendingShipmentQuantity: normalized.pendingShipmentQuantity,
        sourcePredictedDailySales: normalized.sourcePredictedDailySales,
        predictedDailySalesSemanticStatus: normalized.sourcePredictedDailySales === null ? "unavailable" : "unconfirmed",
        snapshotAt: normalized.snapshotAt || preview.collectedAt, mappingStatus,
        qualityStatus: "unconfirmed", createdAt: at,
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
      status: input.status === "inactive" ? "inactive" : "active", identityStatus: "confirmed", createdAt: at, updatedAt: at });
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
    return this.repository.updateShop({ id, displayName: normalizeText(next.displayName), platform, countryCode,
      countryName: normalizeText(next.countryName), ownerUserId: normalizeText(next.ownerUserId) || null,
      primaryCategoryScope: Array.isArray(next.primaryCategoryScope) ? next.primaryCategoryScope : [],
      status: next.status === "inactive" ? "inactive" : "active", identityStatus: "confirmed", updatedAt: this.now().toISOString() });
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
    const confirmed = CONFIRMED_MAPPING_STATUSES.has(mapping.mappingStatus);
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
  listShopMappings(filters) { return this.repository.listShopMappings(filters); }
  listProductMappings(filters) { return this.repository.listProductMappings(filters); }
  listMappingIssues(filters) { return this.repository.listMappingIssues(filters); }
  listQualityIssues(filters) { return this.repository.listQualityIssues(filters); }
  mappingHistory(type, id) { return this.repository.mappingEvents(type, id); }
  summary() { return this.repository.summary(); }
  freshness() { return this.repository.freshness(); }
}
