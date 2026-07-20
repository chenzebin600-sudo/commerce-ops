import fs from "node:fs";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import {
  PRODUCT_PACKAGE_FIELDS,
  PRODUCT_PACKAGE_FIELD_BY_HEADER,
  buildFieldMapping,
  buildProductKey,
  mapLifecycleStatus,
  normalizeCategory,
  normalizeCountry,
  normalizeFieldValue,
  normalizeHeader,
  normalizeSku,
  resolveExchangeDirection,
  sha256,
  stableJson,
} from "./product-package-contract.mjs";

const INVENTORY_FIELDS = new Set(["warehouse_raw", "warehouse_stock", "planned_warehouse_raw"]);
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

export function rawPayloadFromValues(headers, values) {
  const result = {};
  const occurrences = new Map();
  headers.forEach((header, index) => {
    const source = normalizeHeader(header) || `__empty_column_${index + 1}`;
    const count = (occurrences.get(source) || 0) + 1;
    occurrences.set(source, count);
    result[count === 1 ? source : `${source}__duplicate_${count}`] = values[index] ?? null;
  });
  return result;
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

function productFactPayload(normalized) {
  return Object.fromEntries(Object.entries(normalized).filter(([key]) => !INVENTORY_FIELDS.has(key) && key !== "inventories"));
}

function headerIssues(mapping) {
  const issues = [];
  for (const header of mapping.missingFields) {
    issues.push(issue({
      code: "MISSING_REQUIRED_FIELD",
      severity: "blocker",
      fieldCode: PRODUCT_PACKAGE_FIELD_BY_HEADER.get(header)?.systemField || null,
      currentValue: header,
      message: `缺少产品身份必填字段：${header}`,
      suggestion: "请确认上传的是公司商品中台产品包，并保留国家、SKU、名称、类目和状态字段。",
    }));
  }
  for (const header of new Set(mapping.duplicateFields)) {
    issues.push(issue({
      code: "DUPLICATE_HEADER",
      severity: "blocker",
      currentValue: header,
      message: `Excel 表头重复：${header}`,
      suggestion: "请保留一个字段列后重新上传。",
    }));
  }
  for (const header of mapping.unknownFields) {
    issues.push(issue({
      code: "UNKNOWN_FIELD",
      severity: "information",
      currentValue: header,
      message: `发现未映射字段：${header}`,
      suggestion: "字段和值会保留在导入证据中；确认字段口径后可加入正式映射。",
    }));
  }
  return issues;
}

function rowIssues(group, fieldSet) {
  const { normalized, sourceRowNumber } = group;
  const issues = [];
  for (const formulaField of group.formulaFields) {
    issues.push(issue({
      code: "FORMULA_CELL_NOT_ALLOWED", severity: "blocker", sourceRowNumber,
      fieldCode: PRODUCT_PACKAGE_FIELD_BY_HEADER.get(formulaField)?.systemField || null,
      message: `第 ${sourceRowNumber} 行包含公式单元格。`,
      suggestion: "请从中台导出静态值后重新上传。",
    }));
  }
  if (!normalized.sku_code) {
    issues.push(issue({
      code: "SKU_REQUIRED", severity: "blocker", sourceRowNumber, fieldCode: "sku_code",
      message: `第 ${sourceRowNumber} 行 SKU 为空。`, suggestion: "SKU 必须由中台补齐。",
    }));
  }
  if (!normalized.country_raw) {
    issues.push(issue({
      code: "COUNTRY_REQUIRED", severity: "blocker", sourceRowNumber, fieldCode: "country_raw",
      message: `第 ${sourceRowNumber} 行国家为空。`, suggestion: "国家与 SKU 共同构成产品唯一值。",
    }));
  }
  if (!normalized.product_name) {
    issues.push(issue({ code: "PRODUCT_NAME_REQUIRED", severity: "blocker", sourceRowNumber, fieldCode: "product_name", message: `第 ${sourceRowNumber} 行商品名称为空。` }));
  }
  if (!normalized.category_l1 || !normalized.category_l2) {
    issues.push(issue({
      code: "CATEGORY_REQUIRED", severity: "blocker", sourceRowNumber,
      fieldCode: !normalized.category_l1 ? "category_l1" : "category_l2",
      message: `第 ${sourceRowNumber} 行产品分类无法归属。`, suggestion: "请在商品中台补齐一级和二级类目。",
    }));
  }
  if (!normalized.lifecycle_status) {
    issues.push(issue({
      code: "LIFECYCLE_STATUS_UNKNOWN", severity: "blocker", sourceRowNumber, fieldCode: "source_status",
      currentValue: normalized.source_status, message: `第 ${sourceRowNumber} 行 SKU 状态无法映射到生命周期。`,
      suggestion: "请确认中台状态映射后再导入。",
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
      code: "EXCHANGE_RATE_MISMATCH", severity: "blocker", sourceRowNumber, fieldCode: "exchange_rate",
      message: `第 ${sourceRowNumber} 行成本或汇率口径无法核对。`,
      suggestion: "当前模板包含成本字段时，人民币成本、汇率和国家币成本必须同时有效。",
    }));
  }
  if (group.productFactConflict) {
    issues.push(issue({
      code: "COUNTRY_SKU_FACT_CONFLICT", severity: "blocker", sourceRowNumber, fieldCode: "product_key",
      currentValue: group.productKey, message: `${group.productKey} 的多仓库行包含不一致的产品事实。`,
      suggestion: "同一国家与 SKU 可以有多个仓库，但商品名称、类目、规格和状态必须一致。",
    }));
  }
  if (group.duplicateInventoryKey) {
    issues.push(issue({
      code: "DUPLICATE_COUNTRY_SKU_WAREHOUSE", severity: "blocker", sourceRowNumber, fieldCode: "warehouse_raw",
      currentValue: group.duplicateInventoryKey, message: `${group.productKey} 的同一仓库在产品包中重复。`,
      suggestion: "国家 + SKU + 仓库只能保留一条库存快照。",
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
        : `第 ${sourceRowNumber} 行主 SKU 为空，保留中台生命周期状态。`,
      suggestion: discontinued
        ? "保存为 DISCONTINUED，仅供历史查询，不创建虚假主 SKU。"
        : "不阻断导入，不凭空生成主 SKU；后续由中台同步补充。",
    }));
  }
  if (!normalized.sales_spec || !normalized.item_dimensions_raw || !Number.isFinite(normalized.item_net_weight_g)) {
    issues.push(issue({
      code: "SOURCE_ATTRIBUTE_INCOMPLETE", severity: "information", sourceRowNumber,
      fieldCode: !normalized.sales_spec ? "sales_spec" : !normalized.item_dimensions_raw ? "item_dimensions_raw" : "item_net_weight_g",
      message: `第 ${sourceRowNumber} 行规格或包装资料不完整。`,
      suggestion: "不阻断产品身份入库，后续进入资料完整度治理。",
    }));
  }
  return issues;
}

function createAggregation(headers, formulaCellCount = 0) {
  const mapping = buildFieldMapping(headers || []);
  return {
    headers: headers || [], mapping, fieldSet: mappedHeaders(mapping), groups: new Map(),
    sourceRowCount: 0, formulaCellCount: Number(formulaCellCount || 0),
  };
}

function addRow(aggregation, row) {
  aggregation.sourceRowCount += 1;
  const rawPayload = row.rawPayload || rawPayloadFromValues(aggregation.headers, row.values || []);
  const formulaFields = row.formulaFields || (row.formulaIndexes || []).map((index) => aggregation.headers[index]).filter(Boolean);
  const normalized = normalizedRow(rawPayload);
  const fallbackKey = `__invalid__${row.sourceRowNumber}`;
  const productKey = normalized.product_key || fallbackKey;
  const productHash = sha256(stableJson(productFactPayload(normalized)));
  const inventoryKey = `${normalizeCountry(normalized.warehouse_raw) || "未指定"}`;
  let group = aggregation.groups.get(productKey);
  if (!group) {
    const unknownPayload = Object.fromEntries(Object.entries(rawPayload).filter(([header]) => !PRODUCT_PACKAGE_FIELD_BY_HEADER.has(normalizeHeader(header))));
    group = {
      id: randomUUID(), productKey, sourceRowNumber: row.sourceRowNumber, sourceSku: normalized.sku_code || null,
      sourceCountryRaw: normalized.country_raw || null, normalized, productHash, rawPayload: unknownPayload,
      formulaFields: new Set(formulaFields), inventories: [], inventoryKeys: new Set(),
      productFactConflict: false, duplicateInventoryKey: null,
    };
    aggregation.groups.set(productKey, group);
  } else {
    if (group.productHash !== productHash) group.productFactConflict = true;
    for (const name of formulaFields) group.formulaFields.add(name);
  }
  if (group.inventoryKeys.has(inventoryKey)) group.duplicateInventoryKey = inventoryKey;
  group.inventoryKeys.add(inventoryKey);
  group.inventories.push({
    source_row_number: row.sourceRowNumber,
    warehouse_raw: normalized.warehouse_raw || "未指定",
    warehouse_stock: normalized.warehouse_stock ?? null,
    planned_warehouse_raw: normalized.planned_warehouse_raw || null,
  });
}

function finalizeAggregation(aggregation, existingProductHashes = new Map(), { sheetName = "" } = {}) {
  const issues = headerIssues(aggregation.mapping);
  const rows = [];
  const productOutcomes = { new: 0, updated: 0, unchanged: 0, conflict: 0, exception: 0 };
  for (const group of aggregation.groups.values()) {
    const validationIssues = rowIssues(group, aggregation.fieldSet);
    issues.push(...validationIssues);
    const hasBlocker = validationIssues.some((item) => item.severity === "blocker");
    const previousHash = existingProductHashes.get(group.productKey) || existingProductHashes.get(group.sourceSku);
    let outcome = hasBlocker ? (group.productFactConflict ? "conflict" : "exception")
      : previousHash ? (previousHash === group.productHash ? "unchanged" : "updated") : "new";
    productOutcomes[outcome] += 1;
    const normalizedPayload = {
      ...group.normalized,
      inventories: group.inventories,
      source_row_count: group.inventories.length,
    };
    rows.push({
      id: group.id,
      sourceRowNumber: group.sourceRowNumber,
      sourceSku: group.sourceSku,
      sourceCountryRaw: group.sourceCountryRaw,
      productKey: group.productKey,
      rawPayload: group.rawPayload,
      normalizedPayload,
      rowHash: sha256(stableJson(normalizedPayload)),
      productHash: group.productHash,
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
    suggestion: "产品图片可在产品编辑中人工上传，后续也可由中台同步。",
  }));
  const counts = {
    rowCount: rows.length,
    newCount: productOutcomes.new,
    updatedCount: productOutcomes.updated,
    unchangedCount: productOutcomes.unchanged,
    conflictCount: productOutcomes.conflict,
    exceptionCount: productOutcomes.exception,
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
    issues,
    counts,
    summary: {
      sheetName,
      categoryCount: categories.size,
      skuCount: rows.length,
      sourceRowCount: aggregation.sourceRowCount,
      inventoryRowCount: aggregation.sourceRowCount,
      countryCount: countries.size,
      sourcePeriod: periods.length === 1 ? periods[0] : null,
      sourceCountryRaw: countries.size === 1 ? [...countries][0] : null,
      formulaCellCount: aggregation.formulaCellCount,
    },
    canApply: counts.blockerCount === 0,
  };
}

export function validateParsedProductPackage(parsed, { existingRowHashes = new Map(), existingProductHashes = existingRowHashes } = {}) {
  const aggregation = createAggregation(parsed.headers || [], parsed.formulaCellCount);
  for (const row of parsed.rows || []) addRow(aggregation, row);
  return finalizeAggregation(aggregation, existingProductHashes, { sheetName: parsed.sheetName || "" });
}

export async function validateStagedProductPackage(parsed, { loadExistingProductHashes } = {}) {
  const aggregation = createAggregation(parsed.headers || [], parsed.formulaCellCount);
  const input = fs.createReadStream(parsed.stagingPath, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    addRow(aggregation, JSON.parse(line));
  }
  const keys = [...aggregation.groups.keys()].filter((key) => !key.startsWith("__invalid__"));
  const hashes = loadExistingProductHashes ? await loadExistingProductHashes(keys) : new Map();
  return finalizeAggregation(aggregation, hashes, { sheetName: parsed.sheetName || "" });
}

export function requiredProductPackageHeaders() {
  return PRODUCT_PACKAGE_FIELDS.filter((item) => item.requiredHeader).map((item) => item.sourceHeader);
}
