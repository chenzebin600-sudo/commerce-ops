import { randomUUID } from "node:crypto";
import {
  PRODUCT_PACKAGE_FIELDS,
  PRODUCT_PACKAGE_FIELD_BY_HEADER,
  buildFieldMapping,
  mapLifecycleStatus,
  normalizeCategory,
  normalizeFieldValue,
  normalizeHeader,
  normalizeSku,
  resolveExchangeDirection,
  sha256,
  stableJson,
} from "./product-package-contract.mjs";

function issue({ code, severity, sourceRowNumber = null, fieldCode = null, currentValue = null, message, suggestion = null }) {
  return {
    id: randomUUID(),
    code,
    severity,
    sourceRowNumber,
    fieldCode,
    currentValue,
    suggestedValue: null,
    message,
    suggestion,
  };
}

function blank(value) {
  return value === null || value === undefined || String(value).trim() === "";
}

function normalizedRow(rawPayload) {
  const result = {};
  for (const [header, value] of Object.entries(rawPayload || {})) {
    const contract = PRODUCT_PACKAGE_FIELD_BY_HEADER.get(normalizeHeader(header));
    if (contract) result[contract.systemField] = normalizeFieldValue(contract, value);
  }
  result.sku_code = normalizeSku(result.sku_code);
  result.main_sku_code = normalizeSku(result.main_sku_code) || null;
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
  return result;
}

function headerIssues(mapping) {
  const issues = [];
  for (const header of mapping.missingFields) {
    issues.push(issue({
      code: "MISSING_REQUIRED_FIELD",
      severity: "blocker",
      fieldCode: PRODUCT_PACKAGE_FIELD_BY_HEADER.get(header)?.systemField || null,
      currentValue: header,
      message: `缺少固定字段：${header}`,
      suggestion: "请从公司商品中台重新导出固定 34 字段产品包。",
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
      suggestion: "该字段会保留在原始行中，但确认前需要人工知悉。",
    }));
  }
  return issues;
}

function rowIssues(row, normalized, duplicateSkus) {
  const issues = [];
  const rowNumber = row.sourceRowNumber;
  for (const formulaField of row.formulaFields || []) {
    issues.push(issue({
      code: "FORMULA_CELL_NOT_ALLOWED",
      severity: "blocker",
      sourceRowNumber: rowNumber,
      fieldCode: PRODUCT_PACKAGE_FIELD_BY_HEADER.get(formulaField)?.systemField || null,
      message: `第 ${rowNumber} 行包含公式单元格。`,
      suggestion: "请从中台导出静态值后重新上传。",
    }));
  }
  if (!normalized.sku_code) {
    issues.push(issue({
      code: "SKU_REQUIRED",
      severity: "blocker",
      sourceRowNumber: rowNumber,
      fieldCode: "sku_code",
      message: `第 ${rowNumber} 行 SKU 为空。`,
      suggestion: "SKU 是产品包的主要唯一匹配依据，必须由中台补齐。",
    }));
  } else if (duplicateSkus.has(normalized.sku_code)) {
    issues.push(issue({
      code: "DUPLICATE_SKU",
      severity: "blocker",
      sourceRowNumber: rowNumber,
      fieldCode: "sku_code",
      currentValue: normalized.sku_code,
      message: `SKU ${normalized.sku_code} 在当前批次重复。`,
      suggestion: "请核对重复行并保留唯一中台记录。",
    }));
  }
  if (!normalized.product_name) {
    issues.push(issue({ code: "PRODUCT_NAME_REQUIRED", severity: "blocker", sourceRowNumber: rowNumber, fieldCode: "product_name", message: `第 ${rowNumber} 行商品名称为空。` }));
  }
  if (!normalized.category_l1 || !normalized.category_l2) {
    issues.push(issue({
      code: "CATEGORY_REQUIRED",
      severity: "blocker",
      sourceRowNumber: rowNumber,
      fieldCode: !normalized.category_l1 ? "category_l1" : "category_l2",
      message: `第 ${rowNumber} 行产品分类无法归属。`,
      suggestion: "请在公司商品中台补齐一级和二级类目。",
    }));
  }
  if (normalized.cost_cny === null || normalized.cost_cny === undefined || normalized.cost_cny < 0) {
    issues.push(issue({
      code: "COST_REQUIRED",
      severity: "blocker",
      sourceRowNumber: rowNumber,
      fieldCode: "cost_cny",
      message: `第 ${rowNumber} 行销售成本人民币缺失或无效。`,
      suggestion: "请确认成本口径并从中台重新导出。",
    }));
  }
  if (!Number.isFinite(normalized.exchange_rate) || normalized.exchange_rate <= 0
    || !Number.isFinite(normalized.cost_local) || normalized.cost_local < 0
    || !normalized.exchange_direction) {
    issues.push(issue({
      code: "EXCHANGE_RATE_MISMATCH",
      severity: "blocker",
      sourceRowNumber: rowNumber,
      fieldCode: "exchange_rate",
      message: `第 ${rowNumber} 行汇率方向或本地币成本无法核对。`,
      suggestion: "请核对人民币成本、国家汇率与国家币成本三者口径。",
    }));
  }
  if (!normalized.lifecycle_status) {
    issues.push(issue({
      code: "LIFECYCLE_STATUS_UNKNOWN",
      severity: "blocker",
      sourceRowNumber: rowNumber,
      fieldCode: "source_status",
      currentValue: normalized.source_status,
      message: `第 ${rowNumber} 行 SKU 状态无法映射到冻结生命周期。`,
      suggestion: "请确认中台状态映射后再导入。",
    }));
  }
  if (!normalized.main_sku_code) {
    issues.push(issue({
      code: "DISCONTINUED_WITHOUT_MAIN_SKU",
      severity: "reminder",
      sourceRowNumber: rowNumber,
      fieldCode: "main_sku_code",
      currentValue: normalized.sku_code,
      message: `第 ${rowNumber} 行主 SKU 缺失，按已确认的灭款规则保留。`,
      suggestion: "保存为 DISCONTINUED，仅供历史查询，不创建虚假主 SKU，也不进入运营池。",
    }));
  }
  if (!normalized.sales_spec || !normalized.item_dimensions_raw || !Number.isFinite(normalized.item_net_weight_g)) {
    issues.push(issue({
      code: "SOURCE_ATTRIBUTE_INCOMPLETE",
      severity: "reminder",
      sourceRowNumber: rowNumber,
      fieldCode: !normalized.sales_spec ? "sales_spec" : !normalized.item_dimensions_raw ? "item_dimensions_raw" : "item_net_weight_g",
      message: `第 ${rowNumber} 行规格或包装资料不完整。`,
      suggestion: "不阻断产品身份入库，后续进入资料完整度治理。",
    }));
  }
  return issues;
}

export function validateParsedProductPackage(parsed, { existingRowHashes = new Map() } = {}) {
  const mapping = buildFieldMapping(parsed.headers || []);
  const issues = headerIssues(mapping);
  const normalizedCandidates = (parsed.rows || []).map((row) => ({ row, normalized: normalizedRow(row.rawPayload) }));
  const skuCounts = new Map();
  for (const { normalized } of normalizedCandidates) {
    if (normalized.sku_code) skuCounts.set(normalized.sku_code, (skuCounts.get(normalized.sku_code) || 0) + 1);
  }
  const duplicateSkus = new Set([...skuCounts].filter(([, count]) => count > 1).map(([sku]) => sku));
  const rows = normalizedCandidates.map(({ row, normalized }) => {
    const validationIssues = rowIssues(row, normalized, duplicateSkus);
    issues.push(...validationIssues);
    const validationCodes = validationIssues.map((item) => item.code);
    const rowHash = sha256(stableJson(normalized));
    const hasBlocker = validationIssues.some((item) => item.severity === "blocker");
    const previousHash = normalized.sku_code ? existingRowHashes.get(normalized.sku_code) : null;
    const outcome = hasBlocker ? "exception" : previousHash ? previousHash === rowHash ? "unchanged" : "updated" : "new";
    return {
      id: randomUUID(),
      sourceRowNumber: row.sourceRowNumber,
      sourceSku: normalized.sku_code || null,
      rawPayload: row.rawPayload,
      normalizedPayload: normalized,
      rowHash,
      validationCodes,
      outcome,
    };
  });
  if (!parsed.rows?.length) {
    issues.push(issue({
      code: "NO_DATA_ROWS",
      severity: "blocker",
      message: "产品包没有可导入的数据行。",
      suggestion: "请检查工作表和表头后重新导出。",
    }));
  }
  issues.push(issue({
    code: "IMAGE_DATA_NOT_SUPPLIED",
    severity: "information",
    fieldCode: "image_assets",
    message: "固定 34 字段产品包不包含图片素材字段，本批次不评估逐 SKU 图片缺失。",
    suggestion: "图片素材将在 G1B 素材中心接入后单独治理。",
  }));
  const counts = {
    rowCount: rows.length,
    newCount: rows.filter((row) => row.outcome === "new").length,
    updatedCount: rows.filter((row) => row.outcome === "updated").length,
    unchangedCount: rows.filter((row) => row.outcome === "unchanged").length,
    conflictCount: rows.filter((row) => row.outcome === "conflict").length,
    exceptionCount: rows.filter((row) => row.outcome === "exception").length,
    blockerCount: issues.filter((item) => item.severity === "blocker").length,
    reminderCount: issues.filter((item) => item.severity === "reminder").length,
    informationCount: issues.filter((item) => item.severity === "information").length,
  };
  const categories = new Set(rows.filter((row) => row.normalizedPayload.category_l1 && row.normalizedPayload.category_l2)
    .map((row) => `${row.normalizedPayload.category_l1}\u0000${row.normalizedPayload.category_l2}`));
  const countries = new Set(rows.map((row) => row.normalizedPayload.country_raw).filter(Boolean));
  const periods = [...new Set(rows.map((row) => row.normalizedPayload.source_period).filter(Boolean))];
  return {
    mapping: mapping.mapping,
    unknownFields: mapping.unknownFields,
    headerFingerprint: mapping.headerFingerprint,
    rows,
    issues,
    counts,
    summary: {
      sheetName: parsed.sheetName || "",
      categoryCount: categories.size,
      skuCount: skuCounts.size,
      countryCount: countries.size,
      sourcePeriod: periods.length === 1 ? periods[0] : null,
      sourceCountryRaw: countries.size === 1 ? [...countries][0] : null,
      formulaCellCount: Number(parsed.formulaCellCount || 0),
    },
    canApply: counts.blockerCount === 0,
  };
}

export function requiredProductPackageHeaders() {
  return PRODUCT_PACKAGE_FIELDS.map((item) => item.sourceHeader);
}
