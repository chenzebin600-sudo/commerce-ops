import { createHash } from "node:crypto";
import { decimalToScaled, scaledToDecimal } from "./profit-money.mjs";

export const LAZADA_EXPENSE_RULE_VERSION = "LAZADA-EXPENSE-1.1.0";
export const SHOPEE_EXPENSE_RULE_VERSION = "SHOPEE-NORMAL-EXPENSE-1.0.0";

export const LAZADA_EXPENSE_FEE_NAMES = new Set([
  "Sponsored Affiliates",
  "Sponsored Affiliates Refund",
  "Product 360 Boost",
  "Product 360 Boost Refund",
  "Marketing Solutions / Social Media Ads",
  "Strategic Seller Program Participation Fee",
  "Sponsored Max fee",
  "Sponsored Max fee refund",
  "Free Shipping Max Fee",
  "Reversal of Free Shipping Max Fee",
  "Sponsored Solutions Top-up",
  "Marketing solution /social media advertising",
]);

const MONTHS = Object.freeze({
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
});

const SHOPEE_ADS_SUMMARY_COMPONENTS = Object.freeze([
  "SUMMARY_ADS_ESCROW_TOP_UP",
  "SUMMARY_ADS_CREDIT_TOP_UP_ESCROW",
  "SUMMARY_ADS_SALES_TOP_UP",
]);

function text(value) {
  return value === undefined || value === null ? "" : String(value).normalize("NFKC").trim();
}

function upper(value) {
  return text(value).toUpperCase();
}

export function expenseTransactionDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  }
  const normalized = text(value);
  const iso = normalized.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const lazada = normalized.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/);
  if (lazada && MONTHS[lazada[2].toLowerCase()]) {
    return `${lazada[3]}-${MONTHS[lazada[2].toLowerCase()]}-${lazada[1].padStart(2, "0")}`;
  }
  const javascriptDate = normalized.match(/^[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4})\b/);
  if (javascriptDate && MONTHS[javascriptDate[1].toLowerCase()]) {
    return `${javascriptDate[3]}-${MONTHS[javascriptDate[1].toLowerCase()]}-${javascriptDate[2].padStart(2, "0")}`;
  }
  throw new TypeError(`Expense transaction date is invalid: ${normalized.slice(0, 80)}`);
}

function addDays(value, amount = 1) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function datesInRange(dateFrom, dateTo) {
  const dates = [];
  for (let date = dateFrom; date <= dateTo; date = addDays(date)) dates.push(date);
  return dates;
}

function amountOf(row) {
  return decimalToScaled(row.amount ?? "0");
}

function sourceWindowOf(row) {
  return text(row.source_window || row.sourceWindow) || "single";
}

function valueOf(row, snake, camel) {
  return row[snake] ?? row[camel] ?? null;
}

function exactIdentity(row, kind) {
  const common = [expenseTransactionDate(valueOf(row, "transaction_date", "transactionDate")), String(row.amount ?? "")];
  const fields = kind === "ADVERTISING"
    ? [
        valueOf(row, "transaction_type", "transactionType") ?? row.type,
        valueOf(row, "transaction_subtype", "transactionSubtype") ?? row.subType,
        valueOf(row, "transaction_number", "transactionNumber"),
        row.remarks,
      ]
    : [
        valueOf(row, "transaction_type", "transactionType"),
        valueOf(row, "fee_name_raw", "feeNameRaw") ?? row.feeName,
        valueOf(row, "statement_number", "statementNumber"),
        valueOf(row, "transaction_number", "transactionNumber"),
        valueOf(row, "order_no", "orderNo"), valueOf(row, "order_item_no", "orderItemNo"),
        valueOf(row, "seller_sku", "sellerSku"), valueOf(row, "lazada_sku", "lazadaSku"),
        valueOf(row, "paid_status", "paidStatus"), valueOf(row, "order_status", "orderStatus"),
      ];
  return JSON.stringify([...common, ...fields.map(text)]);
}

export function dedupeExpenseRowsAcrossWindows(rows, kind) {
  const groups = new Map();
  for (const row of rows || []) {
    const identity = exactIdentity(row, kind);
    const sourceWindow = sourceWindowOf(row);
    if (!groups.has(identity)) groups.set(identity, new Map());
    const windows = groups.get(identity);
    if (!windows.has(sourceWindow)) windows.set(sourceWindow, []);
    windows.get(sourceWindow).push(row);
  }
  const records = [];
  const duplicateDates = new Map();
  let duplicateGroupCount = 0;
  let duplicateRemovedCount = 0;
  for (const windows of groups.values()) {
    const entries = [...windows.entries()];
    if (entries.length === 1) {
      records.push(...entries[0][1]);
      continue;
    }
    entries.sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]));
    const kept = entries[0][1];
    const removed = entries.reduce((total, [, values]) => total + values.length, 0) - kept.length;
    const date = expenseTransactionDate(valueOf(kept[0], "transaction_date", "transactionDate"));
    const daily = duplicateDates.get(date) || { groups: 0, removed: 0 };
    daily.groups += 1;
    daily.removed += removed;
    duplicateDates.set(date, daily);
    records.push(...kept);
    duplicateGroupCount += 1;
    duplicateRemovedCount += removed;
  }
  return { records, duplicateGroupCount, duplicateRemovedCount, duplicateDates };
}

function classification(signed) {
  return signed <= 0n ? "EXPENSE" : "NET_CREDIT";
}

function dailyFactBase({ platform, shop, transactionDate, ruleVersion, calculatedAt }) {
  return {
    platform,
    canonicalShopId: shop.directoryShopId || shop.canonicalShopId || null,
    connectorShopId: shop.id || shop.connectorShopId,
    countryCode: upper(shop.country || shop.countryCode),
    currency: upper(shop.currency),
    transactionDate,
    ruleVersion,
    calculatedAt,
  };
}

function aggregateFacts(facts, issues, ruleVersion) {
  const complete = facts.length > 0 && facts.every((fact) => fact.dataStatus === "COMPLETE");
  const sum = (field) => scaledToDecimal(facts.reduce((total, fact) => total + decimalToScaled(fact[field] ?? "0"), 0n));
  const signed = complete ? facts.reduce((total, fact) => total + decimalToScaled(fact.sourceSignedTotal), 0n) : null;
  return {
    dataStatus: complete ? "COMPLETE" : "PARTIAL",
    ruleVersion,
    advertisingExpenseSigned: sum("advertisingExpenseSigned"),
    billingExpenseSigned: sum("billingExpenseSigned"),
    sourceSignedTotal: signed === null ? null : scaledToDecimal(signed),
    expenseValue: signed === null ? null : scaledToDecimal(-signed),
    classification: signed === null ? null : classification(signed),
    expenseDayCount: facts.length,
    completeExpenseDayCount: facts.filter((fact) => fact.dataStatus === "COMPLETE").length,
    advertisingRowCount: facts.reduce((total, fact) => total + fact.advertisingRowCount, 0),
    billingRowCount: facts.reduce((total, fact) => total + fact.billingRowCount, 0),
    duplicateGroupCount: facts.reduce((total, fact) => total + fact.duplicateGroupCount, 0),
    duplicateRemovedCount: facts.reduce((total, fact) => total + fact.duplicateRemovedCount, 0),
    issues: [...new Set(issues)],
  };
}

export function calculateLazadaDailyExpenses({
  shop, dateFrom, dateTo, advertisingRows = [], financeRows = [],
  advertisingSourceComplete = true, financeSourceComplete = true, calculatedAt = new Date().toISOString(),
} = {}) {
  const currency = upper(shop?.currency);
  const issues = [];
  const inRange = (row) => {
    const date = expenseTransactionDate(valueOf(row, "transaction_date", "transactionDate"));
    return date >= dateFrom && date <= dateTo;
  };
  const advertising = (advertisingRows || []).filter(inRange);
  const finance = (financeRows || []).filter(inRange);
  for (const row of advertising) {
    const type = upper(valueOf(row, "transaction_type", "transactionType") ?? row.type);
    const subtype = upper(valueOf(row, "transaction_subtype", "transactionSubtype") ?? row.subType);
    if (type !== "PAYMENT") issues.push("LAZADA_ADVERTISING_TYPE_UNEXPECTED");
    if (subtype !== "SPONSORED SOLUTIONS TOP-UP") issues.push("LAZADA_ADVERTISING_SUBTYPE_UNEXPECTED");
    const rowCurrency = upper(row.currency);
    if (rowCurrency && currency && rowCurrency !== currency) issues.push("LAZADA_ADVERTISING_CURRENCY_MISMATCH");
  }
  const advertisingDedupe = dedupeExpenseRowsAcrossWindows(advertising, "ADVERTISING");
  const financeDedupe = dedupeExpenseRowsAcrossWindows(finance, "BILLING");
  const billing = financeDedupe.records.filter((row) => LAZADA_EXPENSE_FEE_NAMES.has(text(
    valueOf(row, "fee_name_raw", "feeNameRaw") ?? row.feeName,
  )));
  if (!advertisingSourceComplete) issues.push("LAZADA_ADVERTISING_SOURCE_INCOMPLETE");
  if (!financeSourceComplete) issues.push("LAZADA_FINANCE_SOURCE_INCOMPLETE");
  const sourceComplete = issues.length === 0;
  const facts = datesInRange(dateFrom, dateTo).map((transactionDate) => {
    const dailyAdvertising = advertisingDedupe.records.filter((row) => expenseTransactionDate(valueOf(row, "transaction_date", "transactionDate")) === transactionDate);
    const dailyBilling = billing.filter((row) => expenseTransactionDate(valueOf(row, "transaction_date", "transactionDate")) === transactionDate);
    const advertisingSigned = dailyAdvertising.reduce((total, row) => total + amountOf(row), 0n);
    const billingSigned = dailyBilling.reduce((total, row) => total + amountOf(row), 0n);
    const signed = advertisingSigned + billingSigned;
    const duplicate = {
      groups: (advertisingDedupe.duplicateDates.get(transactionDate)?.groups || 0) + (financeDedupe.duplicateDates.get(transactionDate)?.groups || 0),
      removed: (advertisingDedupe.duplicateDates.get(transactionDate)?.removed || 0) + (financeDedupe.duplicateDates.get(transactionDate)?.removed || 0),
    };
    return {
      ...dailyFactBase({ platform: "LAZADA", shop, transactionDate, ruleVersion: LAZADA_EXPENSE_RULE_VERSION, calculatedAt }),
      dataStatus: sourceComplete ? "COMPLETE" : "PARTIAL",
      advertisingExpenseSigned: scaledToDecimal(advertisingSigned),
      billingExpenseSigned: scaledToDecimal(billingSigned),
      sourceSignedTotal: sourceComplete ? scaledToDecimal(signed) : null,
      expenseValue: sourceComplete ? scaledToDecimal(-signed) : null,
      classification: sourceComplete ? classification(signed) : null,
      advertisingRowCount: dailyAdvertising.length,
      billingRowCount: dailyBilling.length,
      sourceWindowCount: new Set([...dailyAdvertising, ...dailyBilling].map(sourceWindowOf)).size,
      duplicateGroupCount: duplicate.groups,
      duplicateRemovedCount: duplicate.removed,
      sourceComplete,
      issues: [...new Set(issues)],
    };
  });
  return { facts, aggregate: aggregateFacts(facts, issues, LAZADA_EXPENSE_RULE_VERSION) };
}

export function calculateShopeeDailyExpense({
  shop, dateFrom, dateTo, walletRows = [], statement, walletSourceComplete = true,
  calculatedAt = new Date().toISOString(),
} = {}) {
  const issues = [];
  if (dateFrom !== dateTo || statement?.dateFrom !== dateFrom || statement?.dateTo !== dateTo) {
    issues.push("SHOPEE_EXPENSE_REQUIRES_DAILY_STATEMENT");
    return { facts: [], aggregate: aggregateFacts([], issues, SHOPEE_EXPENSE_RULE_VERSION) };
  }
  const currency = upper(shop?.currency);
  const dailyWallet = (walletRows || []).filter((row) => expenseTransactionDate(valueOf(row, "transaction_date", "transactionDate")) === dateFrom);
  for (const row of dailyWallet) {
    if (upper(valueOf(row, "transaction_tab_type", "transactionTabType")) !== "WALLET_WALLET_PAYMENT") {
      issues.push("SHOPEE_WALLET_TAB_UNEXPECTED");
    }
    if (upper(valueOf(row, "money_flow", "moneyFlow")) !== "MONEY_OUT") issues.push("SHOPEE_WALLET_FLOW_UNEXPECTED");
    if (amountOf(row) > 0n) issues.push("SHOPEE_WALLET_AMOUNT_SIGN_UNEXPECTED");
    const rowCurrency = upper(row.currency);
    if (rowCurrency && currency && rowCurrency !== currency) issues.push("SHOPEE_WALLET_CURRENCY_MISMATCH");
  }
  if (!walletSourceComplete) issues.push("SHOPEE_WALLET_SOURCE_INCOMPLETE");
  const summary = statement?.summary || {};
  const affiliateRaw = summary.SUMMARY_AMS_COMMISSION;
  const adsEntries = SHOPEE_ADS_SUMMARY_COMPONENTS.filter((key) => Object.hasOwn(summary, key));
  if (affiliateRaw === undefined || affiliateRaw === null || affiliateRaw === "") issues.push("SHOPEE_AFFILIATE_SUMMARY_MISSING");
  if (adsEntries.length !== 1) issues.push(adsEntries.length ? "SHOPEE_ADS_ESCROW_SUMMARY_AMBIGUOUS" : "SHOPEE_ADS_ESCROW_SUMMARY_MISSING");
  const advertisingSigned = dailyWallet.reduce((total, row) => total + amountOf(row), 0n);
  const affiliateSigned = affiliateRaw === undefined || affiliateRaw === null || affiliateRaw === "" ? 0n : decimalToScaled(affiliateRaw);
  const adsEscrowSigned = adsEntries.length === 1 ? decimalToScaled(summary[adsEntries[0]]) : 0n;
  const billingSigned = affiliateSigned + adsEscrowSigned;
  const signed = advertisingSigned + billingSigned;
  const sourceComplete = issues.length === 0;
  const fact = {
    ...dailyFactBase({ platform: "SHOPEE", shop, transactionDate: dateFrom, ruleVersion: SHOPEE_EXPENSE_RULE_VERSION, calculatedAt }),
    dataStatus: sourceComplete ? "COMPLETE" : "PARTIAL",
    advertisingExpenseSigned: scaledToDecimal(advertisingSigned),
    billingExpenseSigned: scaledToDecimal(billingSigned),
    affiliateExpenseSigned: scaledToDecimal(affiliateSigned),
    adsEscrowExpenseSigned: scaledToDecimal(adsEscrowSigned),
    sourceSignedTotal: sourceComplete ? scaledToDecimal(signed) : null,
    expenseValue: sourceComplete ? scaledToDecimal(-signed) : null,
    classification: sourceComplete ? classification(signed) : null,
    advertisingRowCount: dailyWallet.length,
    billingRowCount: Number(affiliateRaw !== undefined && affiliateRaw !== null && affiliateRaw !== "") + Number(adsEntries.length === 1),
    sourceWindowCount: new Set(dailyWallet.map(sourceWindowOf)).size,
    duplicateGroupCount: 0,
    duplicateRemovedCount: 0,
    sourceComplete,
    issues: [...new Set(issues)],
  };
  return { facts: [fact], aggregate: aggregateFacts([fact], issues, SHOPEE_EXPENSE_RULE_VERSION) };
}

export function expenseSourceKey(row) {
  const fingerprint = JSON.stringify([
    row.platform, row.connectorShopId, row.transactionDate, row.transactionType,
    row.transactionSubtype, row.amount, row.transactionNumber, row.remarks,
  ].map(text));
  return createHash("sha256").update(fingerprint).digest("hex");
}
