import { createHash } from "node:crypto";
import { PRICE_CONTROL_SOURCE_SYSTEM } from "../data-foundation/unified-data-contracts.mjs";

export { PRICE_CONTROL_SOURCE_SYSTEM };
export const PRICE_CONTROL_ACCOUNT_ID = "foundation:account:ai_project_a:environment";
export const APPROVED_STATUS = "CA";

export function nextAlignedAutomationRunAt(now, intervalMinutes) {
  const current = now instanceof Date ? now : new Date(now);
  const intervalMs = Math.max(1, Number(intervalMinutes) || 60) * 60_000;
  const nextTimestamp = (Math.floor(current.getTime() / intervalMs) + 1) * intervalMs;
  return new Date(nextTimestamp);
}

export const PRICE_FIELDS = Object.freeze([
  { source: "lazada_rc_price", platform: "LAZADA", shopType: "STANDARD", priceType: "REGULAR" },
  { source: "lazada_hd_price", platform: "LAZADA", shopType: "STANDARD", priceType: "CAMPAIGN" },
  { source: "lazada_dc_price", platform: "LAZADA", shopType: "STANDARD", priceType: "MEGA_CAMPAIGN" },
  { source: "lazada_mall_rc_price", platform: "LAZADA", shopType: "MALL", priceType: "REGULAR" },
  { source: "lazada_mall_hd_price", platform: "LAZADA", shopType: "MALL", priceType: "CAMPAIGN" },
  { source: "lazada_mall_dc_price", platform: "LAZADA", shopType: "MALL", priceType: "MEGA_CAMPAIGN" },
  { source: "shopee_rc_price", platform: "SHOPEE", shopType: "STANDARD", priceType: "REGULAR" },
  { source: "shopee_hd_price", platform: "SHOPEE", shopType: "STANDARD", priceType: "CAMPAIGN" },
  { source: "shopee_dc_price", platform: "SHOPEE", shopType: "STANDARD", priceType: "MEGA_CAMPAIGN" },
  { source: "shopee_mall_rc_price", platform: "SHOPEE", shopType: "MALL", priceType: "REGULAR" },
  { source: "shopee_mall_hd_price", platform: "SHOPEE", shopType: "MALL", priceType: "CAMPAIGN" },
  { source: "shopee_mall_dc_price", platform: "SHOPEE", shopType: "MALL", priceType: "MEGA_CAMPAIGN" },
  { source: "tiktok_rc_price", platform: "TIKTOK", shopType: "STANDARD", priceType: "REGULAR" },
  { source: "tiktok_hd_price", platform: "TIKTOK", shopType: "STANDARD", priceType: "CAMPAIGN" },
  { source: "tiktok_dc_price", platform: "TIKTOK", shopType: "STANDARD", priceType: "MEGA_CAMPAIGN" },
]);

const PLATFORM_LABELS = Object.freeze({ LAZADA: "Lazada", SHOPEE: "Shopee", TIKTOK: "TikTok Shop" });
const SHOP_TYPE_LABELS = Object.freeze({ STANDARD: "标准店", MALL: "Mall 店" });
const PRICE_TYPE_LABELS = Object.freeze({ REGULAR: "日常价", CAMPAIGN: "活动价", MEGA_CAMPAIGN: "大促价" });

function clean(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

export function stableHash(...values) {
  return createHash("sha256")
    .update(values.map((value) => clean(value)).join("\u001f"))
    .digest("hex");
}

const PRICE_CHANGE_PLATFORM_ORDER = Object.freeze(["LAZADA", "SHOPEE", "TIKTOK"]);

export function selectRepresentativePriceChanges(changes, limit = 30) {
  const safeChanges = Array.isArray(changes) ? changes : [];
  const safeLimit = Math.max(0, Math.min(Number.parseInt(limit, 10) || 0, safeChanges.length));
  if (!safeLimit) return [];
  const platformRank = new Map(PRICE_CHANGE_PLATFORM_ORDER.map((platform, index) => [platform, index]));
  const buckets = new Map();
  for (const change of safeChanges) {
    const platform = clean(change?.platform).toUpperCase() || "UNKNOWN";
    if (!buckets.has(platform)) buckets.set(platform, []);
    buckets.get(platform).push(change);
  }
  const orderedBuckets = [...buckets.entries()].sort(([left], [right]) => {
    const leftRank = platformRank.get(left) ?? PRICE_CHANGE_PLATFORM_ORDER.length;
    const rightRank = platformRank.get(right) ?? PRICE_CHANGE_PLATFORM_ORDER.length;
    return leftRank - rightRank || left.localeCompare(right);
  }).map(([, items]) => items);
  const selected = [];
  let offset = 0;
  while (selected.length < safeLimit) {
    let added = false;
    for (const items of orderedBuckets) {
      if (offset >= items.length) continue;
      selected.push(items[offset]);
      added = true;
      if (selected.length >= safeLimit) break;
    }
    if (!added) break;
    offset += 1;
  }
  return selected;
}

export function priceKey(input) {
  return [input.countryCode, input.sku, input.platform, input.shopType, input.priceType]
    .map((value) => clean(value).toUpperCase())
    .join("|");
}

export function parsePriceToCents(value) {
  const text = clean(value);
  if (!text) return null;
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(text)) {
    throw Object.assign(new TypeError(`Invalid price value: ${text}`), { code: "PRICE_CONTROL_INVALID_PRICE" });
  }
  const negative = text.startsWith("-");
  const unsigned = negative ? text.slice(1) : text;
  const [whole, fraction = ""] = unsigned.split(".");
  const cents = (BigInt(whole) * 100n) + BigInt(fraction.padEnd(2, "0"));
  return negative ? -cents : cents;
}

export function formatPrice(value) {
  const cents = typeof value === "bigint" ? value : parsePriceToCents(value);
  if (cents === null) return null;
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  return `${negative ? "-" : ""}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
}

export function expandSourcePriceRow(row) {
  const countryCode = clean(row.country_code || row.countryCode).toUpperCase();
  const categoryName = clean(row.categrory || row.categoryName) || null;
  const sku = clean(row.sku).toUpperCase();
  const applyNo = clean(row.apply_no || row.applyNo);
  const sourceId = clean(row.id || row.sourceId);
  if (!countryCode || !sku || !applyNo) {
    throw Object.assign(new TypeError("Price control row is missing country, SKU, or apply number."), {
      code: "PRICE_CONTROL_SOURCE_ROW_INVALID",
    });
  }
  const base = {
    applyNo,
    sourceRowKey: stableHash(applyNo, sourceId, countryCode, sku, clean(row.seq)),
    countryCode,
    categoryName,
    sku,
    productNameCn: clean(row.product_name_cn || row.productNameCn) || null,
    skuStatus: clean(row.sku_status || row.skuStatus) || null,
  };
  return PRICE_FIELDS.map((definition) => {
    const raw = row[definition.source];
    const cents = parsePriceToCents(raw);
    const point = { ...base, ...definition, priceValue: cents === null ? null : formatPrice(cents) };
    return { ...point, priceKey: priceKey(point) };
  });
}

export function calculateChange(oldPrice, newPrice) {
  const oldCents = parsePriceToCents(oldPrice);
  const newCents = parsePriceToCents(newPrice);
  if (oldCents === null && newCents === null) return null;
  if (oldCents === newCents) return null;
  const direction = oldCents === null ? "NEW" : newCents === null ? "REMOVED" : newCents > oldCents ? "UP" : "DOWN";
  const delta = oldCents === null || newCents === null ? null : newCents - oldCents;
  const percent = delta === null || oldCents === 0n ? null : Number(delta * 10000n / oldCents) / 100;
  return {
    direction,
    oldPrice: oldCents === null ? null : formatPrice(oldCents),
    newPrice: newCents === null ? null : formatPrice(newCents),
    deltaValue: delta === null ? null : formatPrice(delta),
    deltaPercent: percent,
  };
}

export function buildChangeText(input) {
  const country = clean(input.countryCode) || "未知";
  const category = clean(input.categoryName) || "未匹配类目";
  const sku = clean(input.sku) || "未知 SKU";
  const name = clean(input.productNameCn) || "未匹配中文名";
  const platform = PLATFORM_LABELS[input.platform] || clean(input.platform);
  const shopType = SHOP_TYPE_LABELS[input.shopType] || clean(input.shopType);
  const priceType = PRICE_TYPE_LABELS[input.priceType] || clean(input.priceType);
  const oldText = input.oldPrice === null || input.oldPrice === undefined ? "无价格" : input.oldPrice;
  const newText = input.newPrice === null || input.newPrice === undefined ? "无价格" : input.newPrice;
  const direction = input.direction === "UP" ? "上涨"
    : input.direction === "DOWN" ? "下调"
      : input.direction === "NEW" ? "新增"
        : "移除";
  const magnitude = input.deltaValue === null || input.deltaValue === undefined
    ? ""
    : ` ${formatPrice(parsePriceToCents(input.deltaValue) < 0n ? -parsePriceToCents(input.deltaValue) : parsePriceToCents(input.deltaValue))}`;
  const percent = input.deltaPercent === null || input.deltaPercent === undefined
    ? ""
    : `（${Math.abs(Number(input.deltaPercent)).toFixed(2)}%）`;
  return `国家：${country}；类目：${category}；SKU：${sku}；商品中文名：${name}；平台：${platform}；店铺类型：${shopType}；价格类型：${priceType}；从原价 ${oldText} 变更到现价 ${newText}，${direction}${magnitude}${percent}。`;
}

export function batchEffectiveAt(batch) {
  return clean(batch.approvedAt || batch.approve_time || batch.submittedAt || batch.submit_time
    || batch.applyCreatedAt || batch.apply_create_time) || new Date(0).toISOString();
}
