import fs from "node:fs";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import {
  PRODUCT_PACKAGE_FIELDS,
  PRODUCT_PACKAGE_FIELD_BY_HEADER,
  buildFieldMapping,
  buildProductKey,
  buildSourceRowBaseKey,
  mapLifecycleStatus,
  normalizeCategory,
  normalizeCountry,
  normalizeFieldValue,
  normalizeHeader,
  normalizeSku,
  normalizeWarehouse,
  resolveExchangeDirection,
  sha256,
  stableJson,
} from "./product-package-contract.mjs";

const COST_FIELDS = new Set(["cost_cny", "exchange_rate", "cost_local"]);

function issue({ code, severity, sourceRowNumber = null, fieldCode = null, currentValue = null, message, suggestion = null }) {
  return {
    id: randomUUID(), code, severity, sourceRowNumber, fieldCode, currentValue,
    suggestedValue: null, message, suggestion,
  };
}

function mappedHeaders(mapping) {
  return new Set(mapping.mapping.filter((item) => item.status === "mapped").map((item) => item.systemField));
}

function payloadFromValues(headers, values, fallbackFactory) {
  const result = {};
  const occurrences = new Map();
  headers.forEach((header, index) => {
    const source = normalizeHeader(header) || `__empty_column_${index + 1}`;
    const count = (occurrences.get(source) || 0) + 1;
    occurrences.set(source, count);
    result[count === 1 ? source : `${source}__duplicate_${count}`] = values[index] ?? fallbackFactory(index);
  });
  return result;
}

export function rawPayloadFromValues(headers, values) {
  return payloadFromValues(headers, values, () => null);
}

export function rawTypePayloadFromValues(headers, types) {
  return payloadFromValues(headers, types, () => "null");
}

function normalizedRow(rawPayload) {
  const result = {};
  for (const [header, value] of Object.entries(rawPayload || {})) {
    const contract = PRODUCT_PACKAGE_FIELD_BY_HEADER.get(normalizeHeader(header));
    if (contract) result[contract.systemField] = normalizeFieldValue(contract, value);
  }
  result.sku_code = normalizeSku(result.sku_code);
  result.main_sku_code = normalizeSku(result.main_sku_code) || null;
  result.country_raw = normalizeCountry(result.country_raw);
  result.warehouse_raw = normalizeWarehouse(result.warehouse_raw) || null;
  result.planned_warehouse_raw = normalizeWarehouse(result.planned_warehouse_raw) || null;
  result.category_l1 = normalizeCategory(result.category_l1);
  result.category_l2 = normalizeCategory(result.category_l2);
  result.exchange_direction = resolveExchangeDirection({
    costCny: result.cost_cny,
    exchangeRate: result.exchange_rate,
    costLocal: result.cost_local,
  });
  const lifecycle = mapLifecycleStatus(result.source_status, { missingMainSku: !result.main_sku_code });
  result.lifecycle_status = lifecycle?.status || null;
  result.lifecycle_reason_code = lifecycle?.reasonCode || null;
  result.product_key = buildProductKey(result.country_raw, result.sku_code);
  return result;
}

function normalizedText(value) {
  return String(value).normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("zh-CN");
}

function isEmptyValue(value) {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

function numericValue(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value ?? "").trim().replaceAll(",", "").replace(/%$/, "");
  if (!text || !/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function dateValue(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const timestamp = Date.parse(text);
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

export function semanticCellValue(value, { contract = null, rawType = null } = {}) {
  if (isEmptyValue(value)) return { kind: "empty", value: null };
  const type = String(rawType || "").toLowerCase();
  if (contract?.type === "number" || contract?.type === "integer" || new Set(["number", "integer", "float"]).has(type)) {
    const parsed = numericValue(value);
    if (parsed !== null) return { kind: "number", value: parsed };
  }
  if (contract?.type === "date" || new Set(["date", "datetime", "time"]).has(type)) {
    const parsed = dateValue(value);
    if (parsed !== null) return { kind: "date", value: parsed };
  }
  if (typeof value === "boolean") return { kind: "boolean", value };
  return { kind: "text", value: normalizedText(value) };
}

export function semanticCellEqual(oldValue, newValue, options = {}) {
  const numericTypes = new Set(["number", "integer", "float"]);
  const dateTypes = new Set(["date", "datetime", "time"]);
  const oldType = String(options.oldType || "").toLowerCase();
  const newType = String(options.newType || "").toLowerCase();
  const sharedType = options.contract?.type === "number" || options.contract?.type === "integer" || numericTypes.has(oldType) || numericTypes.has(newType)
    ? "number"
    : options.contract?.type === "date" || dateTypes.has(oldType) || dateTypes.has(newType) ? "date" : null;
  const before = semanticCellValue(oldValue, { contract: options.contract, rawType: sharedType || oldType });
  const after = semanticCellValue(newValue, { contract: options.contract, rawType: sharedType || newType });
  return before.kind === after.kind && before.value === after.value;
}

function semanticRowPayload(rawPayload, rawTypes) {
  return Object.fromEntries(Object.keys(rawPayload || {}).sort().map((header) => {
    const contract = PRODUCT_PACKAGE_FIELD_BY_HEADER.get(normalizeHeader(header));
    return [header, semanticCellValue(rawPayload[header], { contract, rawType: rawTypes?.[header] })];
  }));
}

function headerIssues(mapping) {
  const issues = [];
  for (const header of mapping.missingFields) {
    issues.push(issue({
      code: "MISSING_REQUIRED_FIELD",
      severity: "blocker",
      fieldCode: PRODUCT_PACKAGE_FIELD_BY_HEADER.get(header)?.systemField || null,
      currentValue: header,
      message: `缺少产品包必需表头：${header}`,
      suggestion: "请确认上传的是公司商品中台产品包，并保留冻结字段表头。",
    }));
  }
  for (const header of new Set(mapping.duplicateFields)) {
    issues.push(issue({
      code: "DUPLICATE_HEADER",
      severity: "blocker",
      currentValue: header,
      message: `Excel 表头重复：${header}`,
      suggestion: "重复表头无法稳定映射，请保留一个字段列后重新上传。",
    }));
  }
  for (const header of mapping.unknownFields) {
    issues.push(issue({
      code: "UNKNOWN_FIELD",
      severity: "information",
      currentValue: header,
      message: `发现未映射字段：${header}`,
      suggestion: "该字段和值会完整保存在源行事实中，不会静默丢弃。",
    }));
  }
  return issues;
}

function rowIssues(row, fieldSet) {
  const { normalized, sourceRowNumber } = row;
  const issues = [];
  for (const formulaField of row.formulaFields) {
    issues.push(issue({
      code: "FORMULA_CELL_PRESERVED", severity: "information", sourceRowNumber,
      fieldCode: PRODUCT_PACKAGE_FIELD_BY_HEADER.get(formulaField)?.systemField || formulaField || null,
      message: `第 ${sourceRowNumber} 行包含公式单元格，公式文本和类型已作为源数据保留。`,
      suggestion: "公式不会被执行；后续导出仍会经过 Excel 公式注入防护。",
    }));
  }
  if (!normalized.sku_code) {
    issues.push(issue({
      code: "SKU_REQUIRED", severity: "blocker", sourceRowNumber, fieldCode: "sku_code",
      message: `第 ${sourceRowNumber} 行 SKU 为空。`, suggestion: "SKU 是源行身份的必需字段。",
    }));
  }
  if (!normalized.country_raw) {
    issues.push(issue({
      code: "COUNTRY_REQUIRED", severity: "blocker", sourceRowNumber, fieldCode: "country_raw",
      message: `第 ${sourceRowNumber} 行国家为空。`, suggestion: "国家是源行身份的必需字段。",
    }));
  }
  if (!normalized.product_name) {
    issues.push(issue({
      code: "PRODUCT_NAME_MISSING", severity: "information", sourceRowNumber, fieldCode: "product_name",
      message: `第 ${sourceRowNumber} 行商品名称为空，源行仍会保留。`,
      suggestion: "该问题进入后续数据治理，不阻断源行落库。",
    }));
  }
  if (!normalized.category_l1 || !normalized.category_l2) {
    issues.push(issue({
      code: "CATEGORY_INCOMPLETE", severity: "information", sourceRowNumber,
      fieldCode: !normalized.category_l1 ? "category_l1" : "category_l2",
      message: `第 ${sourceRowNumber} 行产品分类不完整，源行仍会保留。`,
      suggestion: "完整分类补齐前，该行可能不会进入产品查询投影。",
    }));
  }
  if (!normalized.lifecycle_status) {
    issues.push(issue({
      code: "LIFECYCLE_STATUS_UNMAPPED", severity: "information", sourceRowNumber, fieldCode: "source_status",
      currentValue: normalized.source_status, message: `第 ${sourceRowNumber} 行 SKU 状态暂未映射到冻结生命周期。`,
      suggestion: "原始状态按事实保存，不阻断导入；映射完善后可重新生成查询投影。",
    }));
  }
  const hasAnyCostField = [...COST_FIELDS].some((field) => fieldSet.has(field));
  if (hasAnyCostField && (
    !Number.isFinite(normalized.cost_cny) || normalized.cost_cny < 0
    || !Number.isFinite(normalized.exchange_rate) || normalized.exchange_rate <= 0
    || !Number.isFinite(normalized.cost_local) || normalized.cost_local < 0
    || !normalized.exchange_direction
  )) {
    issues.push(issue({
      code: "EXCHANGE_RATE_REVIEW", severity: "information", sourceRowNumber, fieldCode: "exchange_rate",
      message: `第 ${sourceRowNumber} 行成本或汇率口径无法自动核对，原值仍会保存。`,
      suggestion: "该问题进入数据治理，不据此合并、改写或阻断源行。",
    }));
  }
  if (row.rowOccurrence > 1) {
    issues.push(issue({
      code: "REPEATED_COUNTRY_SKU_WAREHOUSE", severity: "information", sourceRowNumber, fieldCode: "warehouse_raw",
      currentValue: row.sourceRowBaseKey,
      message: `第 ${sourceRowNumber} 行与前序行具有相同国家、SKU 和仓库，已按第 ${row.rowOccurrence} 次出现独立保存。`,
      suggestion: "这是合法源数据，不会合并或阻断。",
    }));
  }
  if (!normalized.main_sku_code) {
    const discontinued = normalized.lifecycle_status === "DISCONTINUED";
    issues.push(issue({
      code: discontinued ? "DISCONTINUED_WITHOUT_MAIN_SKU" : "MAIN_SKU_NOT_SUPPLIED",
      severity: discontinued ? "reminder" : "information",
      sourceRowNumber,
      fieldCode: "main_sku_code",
      currentValue: normalized.sku_code,
      message: discontinued
        ? `第 ${sourceRowNumber} 行为中台灭款且主 SKU 缺失，按原状态保留。`
        : `第 ${sourceRowNumber} 行主 SKU 为空，按中台原值保留。`,
      suggestion: discontinued
        ? "保存为 DISCONTINUED，仅供历史查询，不创建虚假主 SKU。"
        : "不阻断导入，不凭空生成主 SKU。",
    }));
  }
  if (!normalized.sales_spec || !normalized.item_dimensions_raw || !Number.isFinite(normalized.item_net_weight_g)) {
    issues.push(issue({
      code: "SOURCE_ATTRIBUTE_INCOMPLETE", severity: "information", sourceRowNumber,
      fieldCode: !normalized.sales_spec ? "sales_spec" : !normalized.item_dimensions_raw ? "item_dimensions_raw" : "item_net_weight_g",
      message: `第 ${sourceRowNumber} 行规格或包装资料不完整。`,
      suggestion: "不阻断源行入库，后续进入资料完整度治理。",
    }));
  }
  return issues;
}

function createAggregation(headers, formulaCellCount = 0) {
  const mapping = buildFieldMapping(headers || []);
  return {
    headers: headers || [], mapping, fieldSet: mappedHeaders(mapping), rows: [], occurrences: new Map(),
    sourceRowCount: 0, formulaCellCount: Number(formulaCellCount || 0),
  };
}

function addRow(aggregation, source) {
  aggregation.sourceRowCount += 1;
  const rawPayload = source.rawPayload || rawPayloadFromValues(aggregation.headers, source.values || []);
  const rawTypes = source.rawTypes || rawTypePayloadFromValues(aggregation.headers, source.valueTypes || []);
  const formulaFields = source.formulaFields || (source.formulaIndexes || []).map((index) => aggregation.headers[index]).filter(Boolean);
  const normalized = normalizedRow(rawPayload);
  const sourceRowBaseKey = buildSourceRowBaseKey(normalized.country_raw, normalized.sku_code, normalized.warehouse_raw);
  const rowOccurrence = sourceRowBaseKey ? (aggregation.occurrences.get(sourceRowBaseKey) || 0) + 1 : 1;
  if (sourceRowBaseKey) aggregation.occurrences.set(sourceRowBaseKey, rowOccurrence);
  const sourceRowKey = sourceRowBaseKey ? `${sourceRowBaseKey}|${rowOccurrence}` : `__INVALID__|${source.sourceRowNumber}`;
  aggregation.rows.push({
    id: randomUUID(),
    sourceRowNumber: source.sourceRowNumber,
    sourceSku: normalized.sku_code || null,
    sourceCountryRaw: normalized.country_raw || null,
    sourceWarehouseRaw: normalized.warehouse_raw || null,
    sourceRowBaseKey,
    sourceRowKey,
    rowOccurrence,
    productKey: normalized.product_key || null,
    rawPayload,
    rawTypes,
    normalized,
    formulaFields: new Set(formulaFields),
    sourceRowHash: sha256(stableJson({ rawPayload, rawTypes })),
    semanticRowHash: sha256(stableJson(semanticRowPayload(rawPayload, rawTypes))),
  });
}

function previousSourceRow(existingSourceRows, row) {
  const previous = existingSourceRows.get(row.sourceRowKey);
  if (!previous) return null;
  if (typeof previous === "string") return { semanticRowHash: previous, rawPayload: {}, rawTypes: {}, overrideFields: new Set() };
  return previous;
}

function buildFieldChanges(row, previous) {
  if (!previous) return [];
  const headers = [...new Set([...Object.keys(previous.rawPayload || {}), ...Object.keys(row.rawPayload || {})])].sort();
  return headers.flatMap((header) => {
    const contract = PRODUCT_PACKAGE_FIELD_BY_HEADER.get(normalizeHeader(header));
    const oldValue = previous.rawPayload?.[header] ?? null;
    const newValue = row.rawPayload?.[header] ?? null;
    const oldType = previous.rawTypes?.[header] || null;
    const newType = row.rawTypes?.[header] || null;
    if (semanticCellEqual(oldValue, newValue, { contract, oldType, newType })) return [];
    const fieldCode = contract?.systemField || header;
    return [{
      id: randomUUID(),
      importRowId: row.id,
      productPackageRowId: previous.id || null,
      sourceRowNumber: row.sourceRowNumber,
      sourceHeader: header,
      fieldCode,
      country: row.sourceCountryRaw,
      sku: row.sourceSku,
      warehouse: row.sourceWarehouseRaw,
      productName: row.normalized.product_name || null,
      oldValue,
      newValue,
      oldType,
      newType,
      hasManualOverride: Boolean(previous.overrideFields?.has?.(fieldCode)),
    }];
  });
}

function finalizeAggregation(aggregation, existingSourceRows = new Map(), { sheetName = "" } = {}) {
  const issues = headerIssues(aggregation.mapping);
  const rows = [];
  const fieldChanges = [];
  const outcomes = { new: 0, updated: 0, unchanged: 0, conflict: 0, exception: 0 };
  let unmatchedCount = 0;
  for (const row of aggregation.rows) {
    const validationIssues = rowIssues(row, aggregation.fieldSet);
    issues.push(...validationIssues);
    const hasBlocker = validationIssues.some((item) => item.severity === "blocker");
    const previous = previousSourceRow(existingSourceRows, row);
    const changes = buildFieldChanges(row, previous);
    fieldChanges.push(...changes);
    const outcome = hasBlocker ? "exception" : !previous ? "new" : changes.length ? "updated" : "unchanged";
    outcomes[outcome] += 1;
    if (!row.sourceRowBaseKey) unmatchedCount += 1;
    rows.push({
      id: row.id,
      sourceRowNumber: row.sourceRowNumber,
      sourceSku: row.sourceSku,
      sourceCountryRaw: row.sourceCountryRaw,
      sourceWarehouseRaw: row.sourceWarehouseRaw,
      sourceRowKey: row.sourceRowKey,
      rowOccurrence: row.rowOccurrence,
      productKey: row.productKey,
      packageRowId: previous?.id || null,
      rawPayload: row.rawPayload,
      rawTypes: row.rawTypes,
      normalizedPayload: {
        ...row.normalized,
        source_row_count: 1,
        inventories: [{
          source_row_number: row.sourceRowNumber,
          warehouse_raw: row.normalized.warehouse_raw || "未指定",
          warehouse_stock: row.normalized.warehouse_stock ?? null,
          planned_warehouse_raw: row.normalized.planned_warehouse_raw || null,
        }],
      },
      rowHash: row.sourceRowHash,
      productHash: row.semanticRowHash,
      validationCodes: validationIssues.map((item) => item.code),
      outcome,
    });
  }
  if (!aggregation.sourceRowCount) {
    issues.push(issue({ code: "NO_DATA_ROWS", severity: "blocker", message: "产品包没有可导入的数据行。", suggestion: "请检查工作表和表头。" }));
  }
  issues.push(issue({
    code: "IMAGE_DATA_NOT_SUPPLIED", severity: "information", fieldCode: "image_assets",
    message: "当前产品包没有图片素材字段，本批次不据此阻断入库。",
    suggestion: "产品图片和人工维护字段独立保存，后续同步不会覆盖。",
  }));
  const counts = {
    rowCount: rows.length,
    newCount: outcomes.new,
    updatedCount: outcomes.updated,
    unchangedCount: outcomes.unchanged,
    conflictCount: 0,
    exceptionCount: outcomes.exception,
    unmatchedCount,
    willWriteCount: rows.length - outcomes.exception,
    blockerCount: issues.filter((item) => item.severity === "blocker").length,
    reminderCount: issues.filter((item) => item.severity === "reminder").length,
    informationCount: issues.filter((item) => item.severity === "information").length,
  };
  const categories = new Set(rows.filter((row) => row.normalizedPayload.category_l1 && row.normalizedPayload.category_l2)
    .map((row) => `${row.normalizedPayload.category_l1}\u0000${row.normalizedPayload.category_l2}`));
  const countries = new Set(rows.map((row) => row.normalizedPayload.country_raw).filter(Boolean));
  const periods = [...new Set(rows.map((row) => row.normalizedPayload.source_period).filter(Boolean))];
  return {
    mapping: aggregation.mapping.mapping,
    unknownFields: aggregation.mapping.unknownFields,
    headerFingerprint: aggregation.mapping.headerFingerprint,
    rows,
    fieldChanges,
    issues,
    counts,
    summary: {
      sheetName,
      categoryCount: categories.size,
      skuCount: new Set(rows.map((row) => row.productKey).filter(Boolean)).size,
      sourceRowCount: aggregation.sourceRowCount,
      inventoryRowCount: aggregation.sourceRowCount,
      fieldChangeCount: fieldChanges.length,
      countryCount: countries.size,
      sourcePeriod: periods.length === 1 ? periods[0] : null,
      sourceCountryRaw: countries.size === 1 ? [...countries][0] : null,
      formulaCellCount: aggregation.formulaCellCount,
      losslessSourceRows: true,
    },
    canApply: counts.blockerCount === 0,
  };
}

export function validateParsedProductPackage(parsed, { existingSourceRows = new Map(), existingRowHashes = null } = {}) {
  const aggregation = createAggregation(parsed.headers || [], parsed.formulaCellCount);
  for (const row of parsed.rows || []) addRow(aggregation, row);
  return finalizeAggregation(aggregation, existingSourceRows.size ? existingSourceRows : existingRowHashes || new Map(), { sheetName: parsed.sheetName || "" });
}

export async function validateStagedProductPackage(parsed, { loadExistingSourceRows } = {}) {
  const aggregation = createAggregation(parsed.headers || [], parsed.formulaCellCount);
  const input = fs.createReadStream(parsed.stagingPath, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    addRow(aggregation, JSON.parse(line));
  }
  const keys = aggregation.rows.map((row) => row.sourceRowKey).filter((key) => !key.startsWith("__INVALID__"));
  const existing = loadExistingSourceRows ? await loadExistingSourceRows(keys) : new Map();
  return finalizeAggregation(aggregation, existing, { sheetName: parsed.sheetName || "" });
}

export function requiredProductPackageHeaders() {
  return PRODUCT_PACKAGE_FIELDS.filter((item) => item.requiredHeader).map((item) => item.sourceHeader);
}
