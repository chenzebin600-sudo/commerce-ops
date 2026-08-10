import { createHash } from "node:crypto";

export const LAZADA_PROFIT_RULE_VERSION = "LAZADA-PROFIT-1.0.0";

const SITE_TIMEZONE_OFFSETS = Object.freeze({
  ID: "+07:00", MY: "+08:00", PH: "+08:00", SG: "+08:00", TH: "+07:00", VN: "+07:00",
});

export const SITE_CURRENCIES = Object.freeze({
  ID: "IDR", MY: "MYR", PH: "PHP", SG: "SGD", TH: "THB", VN: "VND",
});

const FEE_NAME_MAP = Object.freeze({
  "Item Price Credit": "货款",
  "Reversal Item Price": "冲销商品价格",
});
const MONTHS = Object.freeze({
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
});

export const LAZADA_LIST_REVENUE_FEES = new Set([
  "Item Price Credit", "Reversal Item Price",
  "Seller Voucher Credit", "Reverse - Seller Voucher Credit",
  "Seller Voucher Credit - Co-Funded Price Cut", "Reverse Seller Voucher Credit - Co-Funded Price Cut",
  "Price Cut Discount", "Reversal Price Cut Discount", "Lost Claim",
  "货款", "冲销商品价格", "金币折扣", "金币折扣的返还", "卖家优惠券", "冲销卖家优惠券",
  "多件多折优惠", "冲销多件多折优惠",
]);

export const LAZADA_RECEIVED_EXCLUDED_FEES = new Set([
  "战略卖家计划参与费", "Sponsored Affiliates", "Sponsored Affiliates Refund", "Product 360 Boost",
]);

export function normalizeLazadaFeeName(value) {
  const raw = String(value || "").trim();
  return FEE_NAME_MAP[raw] || raw;
}

export function isLazadaGoodsPaymentFee(row) {
  return row.fee_name_raw === "Item Price Credit" || row.fee_name_normalized === "货款";
}

export function lazadaTransactionWindow(countryCode, dateFrom, dateTo) {
  const country = String(countryCode || "").trim().toUpperCase();
  const offset = SITE_TIMEZONE_OFFSETS[country];
  if (!offset) throw new TypeError(`Unsupported Lazada country: ${country}`);
  return {
    startTime: `${dateFrom}T00:00:00${offset}`,
    endTime: `${dateTo}T23:59:59${offset}`,
  };
}

function normalizedTransactionDate(value) {
  const text = String(value || "").trim();
  const direct = text.match(/^(\d{4}-\d{2}-\d{2})/);
  if (direct) return direct[1];
  const sellerDate = text.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/);
  if (sellerDate && MONTHS[sellerDate[2].toLowerCase()]) {
    return `${sellerDate[3]}-${MONTHS[sellerDate[2].toLowerCase()]}-${sellerDate[1].padStart(2, "0")}`;
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) throw new TypeError("Lazada transaction_date is invalid");
  return parsed.toISOString().slice(0, 10);
}

function normalizedTransactionTime(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  if (/^\d{1,2}\s+[A-Za-z]{3}\s+\d{4}$/.test(text) || /^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function prepareLazadaFinanceRows({ records, shop, fetchedAt, providerRequestId = null }) {
  const countryCode = String(shop.country || "").trim().toUpperCase();
  const currency = SITE_CURRENCIES[countryCode];
  if (!currency) throw new TypeError(`Lazada site currency is unavailable for ${countryCode}`);
  const occurrences = new Map();
  return (records || []).map((row) => {
    const feeNameRaw = String(row.feeName || "").trim();
    const normalized = {
      canonicalShopId: shop.directoryShopId || null,
      countryCode,
      currency,
      transactionDate: normalizedTransactionDate(row.transactionDate),
      transactionTime: normalizedTransactionTime(row.transactionDate),
      transactionType: row.transactionType || null,
      feeNameRaw,
      feeNameNormalized: normalizeLazadaFeeName(feeNameRaw),
      amount: String(row.amount),
      statementNumber: row.statementNumber || null,
      transactionNumber: row.transactionNumber || null,
      orderNo: row.orderNo || null,
      orderItemNo: row.orderItemNo || null,
      sellerSku: row.sellerSku || null,
      lazadaSku: row.lazadaSku || null,
      paidStatus: row.paidStatus || null,
      orderStatus: row.orderStatus || null,
      providerRequestId,
      fetchedAt,
    };
    const fingerprint = JSON.stringify([
      normalized.transactionDate, normalized.transactionType, normalized.feeNameRaw, normalized.amount,
      normalized.statementNumber, normalized.transactionNumber, normalized.orderNo, normalized.orderItemNo,
      normalized.sellerSku, normalized.lazadaSku, normalized.paidStatus, normalized.orderStatus,
    ]);
    const occurrence = (occurrences.get(fingerprint) || 0) + 1;
    occurrences.set(fingerprint, occurrence);
    normalized.sourceKey = createHash("sha256").update(`${fingerprint}\u001f${occurrence}`).digest("hex");
    return normalized;
  });
}
