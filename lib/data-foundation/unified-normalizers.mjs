const ZERO_WIDTH = /[\u200b-\u200d\ufeff]/g;
const WHITESPACE = /[\s\u00a0]+/g;
const SHOP_SEPARATORS = /[.\-_]+/g;

export const NORMALIZER_VERSIONS = Object.freeze({
  text: "unicode_nfkc_text_v1",
  shopName: "shop_name_nfkc_lower_v1",
  sku: "sku_nfkc_upper_v1",
  warehouse: "warehouse_nfkc_upper_v1",
});

export function normalizeCanonicalText(value) {
  return String(value ?? "").normalize("NFKC").replace(ZERO_WIDTH, "")
    .replace(WHITESPACE, " ").trim();
}

export function normalizeCanonicalShopName(value) {
  return normalizeCanonicalText(value).replace(SHOP_SEPARATORS, " ")
    .replace(WHITESPACE, " ").trim().toLocaleLowerCase("en-US");
}

export function normalizeCanonicalSku(value) {
  return normalizeCanonicalText(value).toLocaleUpperCase("en-US");
}

export function normalizeCanonicalWarehouse(value) {
  return normalizeCanonicalText(value).toLocaleUpperCase("en-US");
}

export const NORMALIZER_GOLDEN_VECTORS = Object.freeze([
  Object.freeze({ input: "  ＡＢＣ－０１\u200B  ", shopName: "abc 01", sku: "ABC-01", warehouse: "ABC-01" }),
  Object.freeze({ input: "My.Shop__TH", shopName: "my shop th", sku: "MY.SHOP__TH", warehouse: "MY.SHOP__TH" }),
  Object.freeze({ input: " 仓库\u00a0 A ", shopName: "仓库 a", sku: "仓库 A", warehouse: "仓库 A" }),
]);
