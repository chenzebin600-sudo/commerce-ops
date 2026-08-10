import {
  isLazadaGoodsPaymentFee,
  LAZADA_LIST_REVENUE_FEES,
  LAZADA_RECEIVED_EXCLUDED_FEES,
} from "./lazada-profit-adapter.mjs";
import {
  decimalToScaled,
  multiplyDecimals,
  percentageString,
  scaledToDecimal,
} from "./profit-money.mjs";

function normalizedKey(value) {
  return String(value || "").normalize("NFKC").trim().toUpperCase();
}

function isEvaluation(value) {
  const normalized = String(value ?? "").normalize("NFKC").trim().toLowerCase();
  return ["是", "y", "yes", "true", "1", "测评", "評測"].includes(normalized);
}

function distinct(values) {
  return [...new Set(values)];
}

function resolveUnitCost(line, costRowsBySku) {
  const rows = costRowsBySku.get(normalizedKey(line.normalizedSourceSku || line.sourceSku)) || [];
  const usable = rows.filter((row) => row.unitCost !== null && row.unitCost !== undefined && row.unitCost !== "");
  if (!usable.length) return { status: "MISSING", unitCost: null };
  const warehouse = normalizedKey(line.normalizedSourceWarehouseName || line.sourceWarehouseName);
  const exact = warehouse ? usable.filter((row) => normalizedKey(row.warehouse) === warehouse) : [];
  if (exact.length) {
    const costs = distinct(exact.map((row) => String(row.unitCost)));
    return costs.length === 1 ? { status: "MATCHED", unitCost: costs[0] } : { status: "AMBIGUOUS", unitCost: null };
  }
  const countryCosts = distinct(usable.map((row) => String(row.unitCost)));
  return countryCosts.length === 1
    ? { status: "MATCHED_COUNTRY_UNIQUE", unitCost: countryCosts[0] }
    : { status: "AMBIGUOUS", unitCost: null };
}

export function selectedLazadaOrderNumbers(financeRows) {
  return distinct((financeRows || [])
    .filter(isLazadaGoodsPaymentFee)
    .map((row) => String(row.order_no || "").trim())
    .filter(Boolean));
}

export function calculateLazadaShopProfit({ financeRows, orderLines, productCostRows }) {
  const selectedOrders = selectedLazadaOrderNumbers(financeRows);
  const selectedSet = new Set(selectedOrders);
  const scopedFinance = financeRows.filter((row) => selectedSet.has(String(row.order_no || "").trim()));
  const scopedLines = orderLines.filter((line) => selectedSet.has(String(line.transactionId || "").trim()));
  const linkedOrders = new Set(scopedLines.map((line) => line.transactionId));
  const evaluationOrders = new Set(scopedLines
    .filter((line) => isEvaluation(line.raw?.["是否测评"]))
    .map((line) => line.transactionId));
  const missingOrders = selectedOrders.filter((orderNo) => !linkedOrders.has(orderNo));
  const publishableRevenue = missingOrders.length === 0;

  let listRevenue = 0n;
  let receivedRevenue = 0n;
  for (const row of scopedFinance) {
    const orderNo = String(row.order_no || "").trim();
    if (evaluationOrders.has(orderNo)) continue;
    const feeRaw = String(row.fee_name_raw || "").trim();
    const feeNormalized = String(row.fee_name_normalized || "").trim();
    const value = decimalToScaled(row.amount);
    if (LAZADA_LIST_REVENUE_FEES.has(feeRaw) || LAZADA_LIST_REVENUE_FEES.has(feeNormalized)) listRevenue += value;
    if (!LAZADA_RECEIVED_EXCLUDED_FEES.has(feeRaw) && !LAZADA_RECEIVED_EXCLUDED_FEES.has(feeNormalized)) {
      receivedRevenue += value;
    }
  }

  const costsBySku = new Map();
  for (const row of productCostRows) {
    const key = normalizedKey(row.sku);
    if (!costsBySku.has(key)) costsBySku.set(key, []);
    costsBySku.get(key).push(row);
  }
  let knownCost = 0n;
  let matchedCostLineCount = 0;
  let missingCostLineCount = 0;
  let ambiguousCostLineCount = 0;
  const chargeableLines = scopedLines.filter((line) => !evaluationOrders.has(line.transactionId));
  for (const line of chargeableLines) {
    const resolution = resolveUnitCost(line, costsBySku);
    if (resolution.status === "MISSING") {
      missingCostLineCount += 1;
      continue;
    }
    if (resolution.status === "AMBIGUOUS") {
      ambiguousCostLineCount += 1;
      continue;
    }
    matchedCostLineCount += 1;
    knownCost += multiplyDecimals(resolution.unitCost, line.quantity);
  }
  const costComplete = publishableRevenue && missingCostLineCount === 0 && ambiguousCostLineCount === 0;
  const totalCost = costComplete ? knownCost : null;
  const publishedListRevenue = publishableRevenue ? listRevenue : null;
  const publishedReceivedRevenue = publishableRevenue ? receivedRevenue : null;
  const listProfitMargin = totalCost === null || publishedListRevenue === null
    ? null : percentageString(publishedListRevenue - totalCost, publishedListRevenue);
  const receivedProfitMargin = totalCost === null || publishedReceivedRevenue === null
    ? null : percentageString(publishedReceivedRevenue - totalCost, publishedReceivedRevenue);
  const listToReceivedProfitMargin = totalCost === null || publishedListRevenue === null || publishedReceivedRevenue === null
    ? null : percentageString(publishedReceivedRevenue - totalCost, publishedListRevenue);
  const warnings = [];
  if (missingOrders.length) warnings.push({ code: "MABANG_ORDERS_MISSING", count: missingOrders.length });
  if (missingCostLineCount) warnings.push({ code: "PRODUCT_COST_MISSING", count: missingCostLineCount });
  if (ambiguousCostLineCount) warnings.push({ code: "PRODUCT_COST_AMBIGUOUS", count: ambiguousCostLineCount });

  return {
    dataStatus: warnings.length ? "PARTIAL" : "COMPLETE",
    listRevenue: publishedListRevenue === null ? null : scaledToDecimal(publishedListRevenue),
    receivedRevenue: publishedReceivedRevenue === null ? null : scaledToDecimal(publishedReceivedRevenue),
    totalCost: totalCost === null ? null : scaledToDecimal(totalCost),
    knownTotalCost: scaledToDecimal(knownCost),
    listProfitMargin,
    receivedProfitMargin,
    listToReceivedProfitMargin,
    financeRowCount: financeRows.length,
    selectedOrderCount: selectedOrders.length,
    linkedOrderCount: linkedOrders.size,
    evaluationOrderCount: evaluationOrders.size,
    costLineCount: chargeableLines.length,
    matchedCostLineCount,
    missingOrderCount: missingOrders.length,
    missingCostLineCount,
    ambiguousCostLineCount,
    selectedOrders,
    warnings,
  };
}
