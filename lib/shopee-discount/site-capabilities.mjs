const DEFAULTS = Object.freeze({
  TH: Object.freeze({ currency: "THB", scale: 2, minMinor: "1", maxMinor: "999999999", stepMinor: "1" }),
  PH: Object.freeze({ currency: "PHP", scale: 2, minMinor: "1", maxMinor: "999999999", stepMinor: "1" }),
  MY: Object.freeze({ currency: "MYR", scale: 2, minMinor: "1", maxMinor: "999999999", stepMinor: "1" }),
  SG: Object.freeze({ currency: "SGD", scale: 2, minMinor: "1", maxMinor: "999999999", stepMinor: "1" }),
  TW: Object.freeze({ currency: "TWD", scale: 0, minMinor: "1", maxMinor: "999999999", stepMinor: "1" }),
  VN: Object.freeze({ currency: "VND", scale: 0, minMinor: "1", maxMinor: "999999999", stepMinor: "1" }),
  ID: Object.freeze({ currency: "IDR", scale: 0, minMinor: "1", maxMinor: "999999999", stepMinor: "1" }),
});

export function resolveShopeeDiscountSiteCapabilities(env = {}) {
  const sites = { ...DEFAULTS };
  const country = String(env.SHOPEE_DISCOUNT_COUNTRY || "").trim().toUpperCase();
  if (country && env.SHOPEE_DISCOUNT_CURRENCY) {
    sites[country] = Object.freeze({
      currency: String(env.SHOPEE_DISCOUNT_CURRENCY).trim().toUpperCase(),
      scale: Number(env.SHOPEE_DISCOUNT_PRICE_SCALE ?? sites[country]?.scale ?? 2),
      minMinor: String(env.SHOPEE_DISCOUNT_MIN_PRICE_MINOR || sites[country]?.minMinor || "1"),
      maxMinor: String(env.SHOPEE_DISCOUNT_MAX_PRICE_MINOR || sites[country]?.maxMinor || "999999999"),
      stepMinor: String(env.SHOPEE_DISCOUNT_PRICE_STEP_MINOR || sites[country]?.stepMinor || "1"),
    });
  }
  return Object.freeze(sites);
}
