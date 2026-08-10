import { createHash } from "node:crypto";
import {
  decimalToScaled,
  multiplyDecimals,
  percentageString,
  scaledToDecimal,
} from "./profit-money.mjs";
import { SITE_CURRENCIES } from "./lazada-profit-adapter.mjs";

export const SHOPEE_PROFIT_RULE_SET_VERSION = "SHOPEE-PROFIT-1.0.0";

export const SHOPEE_COUNTRY_RULES = Object.freeze({
  MY: Object.freeze({
    version: "SHOPEE-MY-PROFIT-1.0.0",
    listComponents: ["PRODUCT_PRICE", "REFUND_AMOUNT", "REBATE_SHOPEE", "VOUCHER_SELLER", "COFUND_VOUCHER_SELLER", "COIN_CASHBACK_SELLER", "COFUND_COIN_CASHBACK_SELLER"],
    receivedTerms: [["INCOME_TOTAL_RELEASED", 1], ["ADJUSTMENT_TOTAL", 1], ["INCOME_AMS_COMMISSION", -1], ["INCOME_ADS_ESCROW_TOP_UP", -1]],
  }),
  VN: Object.freeze({
    version: "SHOPEE-VN-PROFIT-1.0.0",
    listComponents: ["PRODUCT_PRICE", "REFUND_AMOUNT", "REBATE_SHOPEE", "VOUCHER_SELLER", "COFUND_VOUCHER_SELLER", "COIN_CASHBACK_SELLER", "COFUND_COIN_CASHBACK_SELLER"],
    receivedTerms: [["INCOME_TOTAL_RELEASED", 1], ["ADJUSTMENT_TOTAL", 1], ["INCOME_AMS_COMMISSION", -1], ["INCOME_ADS_ESCROW_TOP_UP", -1]],
  }),
  TH: Object.freeze({
    version: "SHOPEE-TH-PROFIT-1.0.0",
    listComponents: ["ORIGINAL_PRODUCT_PRICE", "SELLER_PRODUCT_PROMOTION", "REFUND_AMOUNT", "REBATE_SHOPEE", "VOUCHER_SELLER", "COFUND_VOUCHER_SELLER", "COIN_CASHBACK_SELLER", "COFUND_COIN_CASHBACK_SELLER"],
    receivedTerms: [["SUMMARY_TOTAL_RELEASED", 1], ["SUMMARY_AMS_COMMISSION", 1], ["SUMMARY_ADS_CREDIT_TOP_UP_ESCROW", 1], ["ADJUSTMENT_TOTAL", 1]],
  }),
  ID: Object.freeze({
    version: "SHOPEE-ID-PROFIT-1.0.0",
    listComponents: ["ORIGINAL_PRODUCT_PRICE", "SELLER_PRODUCT_PROMOTION", "REFUND_AMOUNT", "REBATE_SHOPEE", "VOUCHER_SELLER", "COFUND_VOUCHER_SELLER", "COIN_CASHBACK_SELLER", "COFUND_COIN_CASHBACK_SELLER"],
    receivedTerms: [["SUMMARY_TOTAL_RELEASED", 1], ["SUMMARY_AMS_COMMISSION", 1], ["SUMMARY_ADS_ESCROW_TOP_UP", 1]],
    deduplicatedOrderComponent: "SELLER_ADJUSTMENT_1",
  }),
  PH: Object.freeze({
    version: "SHOPEE-PH-PROFIT-1.0.0",
    listComponents: ["ORIGINAL_PRODUCT_PRICE", "SELLER_PRODUCT_PROMOTION", "REFUND_AMOUNT", "REBATE_SHOPEE", "VOUCHER_SELLER", "COFUND_VOUCHER_SELLER", "COIN_CASHBACK_SELLER", "COFUND_COIN_CASHBACK_SELLER"],
    receivedTerms: [["SUMMARY_TOTAL_RELEASED", 1], ["SUMMARY_AMS_COMMISSION", 1], ["SUMMARY_ADS_SALES_TOP_UP", 1], ["ADJUSTMENT_TOTAL", 1]],
  }),
});

function normalizedKey(value) {
  return String(value || "").normalize("NFKC").trim().toUpperCase();
}

function distinct(values) {
  return [...new Set(values)];
}

function componentOf(row) {
  return normalizedKey(row.fee_name_normalized || row.feeNameNormalized || row.component);
}

function amountOf(row) {
  return decimalToScaled(row.amount ?? "0");
}

function orderNoOf(row) {
  return String(row.order_no || row.orderNo || "").trim();
}

function sumComponents(rows, names) {
  const selected = new Set(names);
  return rows.reduce((total, row) => selected.has(componentOf(row)) ? total + amountOf(row) : total, 0n);
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

export function selectedShopeeOrderNumbers(financeRows) {
  return distinct((financeRows || []).map(orderNoOf).filter(Boolean));
}

export function calculateShopeeShopProfit({ countryCode, financeRows = [], orderLines = [], productCostRows = [] }) {
  const country = normalizedKey(countryCode);
  const rule = SHOPEE_COUNTRY_RULES[country];
  if (!rule) throw new TypeError(`Unsupported Shopee profit country: ${country}`);
  const selectedOrders = selectedShopeeOrderNumbers(financeRows);
  const selectedSet = new Set(selectedOrders);
  const scopedLines = orderLines.filter((line) => selectedSet.has(String(line.transactionId || "").trim()));
  const linkedOrders = new Set(scopedLines.map((line) => String(line.transactionId || "").trim()).filter(Boolean));
  const missingOrders = selectedOrders.filter((orderNo) => !linkedOrders.has(orderNo));

  const presentComponents = new Set(financeRows.map(componentOf));
  const requiredComponents = [...rule.listComponents, ...rule.receivedTerms.map(([name]) => name)];
  if (rule.deduplicatedOrderComponent) requiredComponents.push(rule.deduplicatedOrderComponent);
  const missingStatementComponents = distinct(requiredComponents).filter((component) => !presentComponents.has(component));
  const statementComplete = missingStatementComponents.length === 0;

  const listRevenueValue = sumComponents(financeRows, rule.listComponents);
  let receivedRevenueValue = rule.receivedTerms.reduce((total, [component, sign]) => (
    total + BigInt(sign) * sumComponents(financeRows, [component])
  ), 0n);
  if (rule.deduplicatedOrderComponent) {
    const seenOrders = new Set();
    for (const row of financeRows) {
      if (componentOf(row) !== rule.deduplicatedOrderComponent) continue;
      const orderNo = orderNoOf(row);
      if (!orderNo || seenOrders.has(orderNo)) continue;
      seenOrders.add(orderNo);
      receivedRevenueValue += amountOf(row);
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
  let nonPositiveQuantityLineCount = 0;
  for (const line of scopedLines) {
    const quantity = decimalToScaled(line.quantity);
    if (quantity <= 0n) {
      nonPositiveQuantityLineCount += 1;
      continue;
    }
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
  const costComplete = missingOrders.length === 0 && missingCostLineCount === 0
    && ambiguousCostLineCount === 0 && nonPositiveQuantityLineCount === 0;
  const totalCost = costComplete ? knownCost : null;
  const listRevenue = statementComplete ? listRevenueValue : null;
  const receivedRevenue = statementComplete ? receivedRevenueValue : null;
  const warnings = [];
  if (missingStatementComponents.length) warnings.push({ code: "SHOPEE_STATEMENT_COMPONENT_MISSING", fields: missingStatementComponents });
  if (missingOrders.length) warnings.push({ code: "MABANG_ORDERS_MISSING", count: missingOrders.length });
  if (missingCostLineCount) warnings.push({ code: "PRODUCT_COST_MISSING", count: missingCostLineCount });
  if (ambiguousCostLineCount) warnings.push({ code: "PRODUCT_COST_AMBIGUOUS", count: ambiguousCostLineCount });
  if (nonPositiveQuantityLineCount) warnings.push({ code: "MABANG_QUANTITY_INVALID", count: nonPositiveQuantityLineCount });

  return {
    dataStatus: statementComplete && costComplete ? "COMPLETE" : "PARTIAL",
    ruleVersion: rule.version,
    listRevenue: listRevenue === null ? null : scaledToDecimal(listRevenue),
    receivedRevenue: receivedRevenue === null ? null : scaledToDecimal(receivedRevenue),
    totalCost: totalCost === null ? null : scaledToDecimal(totalCost),
    knownTotalCost: scaledToDecimal(knownCost),
    listProfitMargin: totalCost === null || listRevenue === null ? null : percentageString(listRevenue - totalCost, listRevenue),
    receivedProfitMargin: totalCost === null || receivedRevenue === null ? null : percentageString(receivedRevenue - totalCost, receivedRevenue),
    listToReceivedProfitMargin: totalCost === null || listRevenue === null || receivedRevenue === null
      ? null : percentageString(receivedRevenue - totalCost, listRevenue),
    financeRowCount: financeRows.length,
    selectedOrderCount: selectedOrders.length,
    linkedOrderCount: linkedOrders.size,
    evaluationOrderCount: 0,
    costLineCount: scopedLines.length,
    matchedCostLineCount,
    missingOrderCount: missingOrders.length,
    missingCostLineCount,
    ambiguousCostLineCount,
    missingStatementComponents,
    selectedOrders,
    warnings,
  };
}

function sourceKey(statement, section, component, orderNo, occurrence) {
  return createHash("sha256").update([
    statement.sourceHash || statement.reportId || "statement",
    section,
    component,
    orderNo || "",
    occurrence,
  ].join("\u001f")).digest("hex");
}

export function prepareShopeeFinanceRows({ statement, shop, fetchedAt, providerRequestId = null }) {
  const countryCode = normalizedKey(statement.countryCode || shop.country);
  const currency = SITE_CURRENCIES[countryCode];
  const rule = SHOPEE_COUNTRY_RULES[countryCode];
  if (!currency || !rule) throw new TypeError(`Shopee statement country is unsupported: ${countryCode}`);
  const rows = [];
  let occurrence = 0;
  const push = ({ section, component, amount, orderNo = null, transactionDate = null }) => {
    occurrence += 1;
    rows.push({
      countryCode,
      currency,
      transactionDate: transactionDate || statement.dateTo,
      transactionType: section,
      feeNameRaw: component,
      feeNameNormalized: component,
      amount: String(amount ?? "0"),
      orderNo,
      sourceKey: sourceKey(statement, section, component, orderNo, occurrence),
      providerRequestId,
      fetchedAt,
    });
  };
  for (const [component, amount] of Object.entries(statement.summary || {})) {
    push({ section: "SUMMARY", component, amount });
  }
  push({ section: "ADJUSTMENT", component: "ADJUSTMENT_TOTAL", amount: statement.adjustment?.totalAmount ?? "0" });
  for (const order of statement.income?.orderRows || []) {
    const transactionDate = order.payoutCompletedDate || statement.dateTo;
    for (const [component, amount] of Object.entries(order.components || {})) {
      push({ section: "INCOME", component, amount, orderNo: String(order.orderId || "").trim(), transactionDate });
    }
  }
  if (statement.income?.emptyReport === true) {
    const zeroComponents = new Set([
      ...rule.listComponents,
      ...rule.receivedTerms.map(([component]) => component),
      ...(rule.deduplicatedOrderComponent ? [rule.deduplicatedOrderComponent] : []),
    ]);
    for (const component of zeroComponents) {
      push({ section: "EMPTY_REPORT", component, amount: "0", transactionDate: statement.dateTo });
    }
  }
  return rows;
}

export function shopeeRevenuePreview(statement) {
  const shop = { country: statement.countryCode };
  const rows = prepareShopeeFinanceRows({ statement, shop, fetchedAt: statement.fetchedAt || new Date().toISOString() });
  const selectedOrders = selectedShopeeOrderNumbers(rows);
  const dummyLines = selectedOrders.map((transactionId) => ({ transactionId, sourceSku: "PREVIEW", quantity: "1" }));
  const result = calculateShopeeShopProfit({
    countryCode: statement.countryCode,
    financeRows: rows,
    orderLines: dummyLines,
    productCostRows: [{ sku: "PREVIEW", warehouse: null, unitCost: "0" }],
  });
  return {
    ruleVersion: result.ruleVersion,
    listRevenue: result.listRevenue,
    receivedRevenue: result.receivedRevenue,
    selectedOrderCount: result.selectedOrderCount,
    missingStatementComponents: result.missingStatementComponents,
    dataStatus: result.missingStatementComponents.length ? "PARTIAL" : "COMPLETE",
  };
}
