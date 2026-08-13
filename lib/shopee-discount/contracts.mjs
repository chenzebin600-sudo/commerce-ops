const PRICE_TIERS = new Set(["DAILY", "EVENT", "MEGA"]);

function assertScale(scale) {
  if (!Number.isSafeInteger(scale) || scale < 0) {
    throw new TypeError("scale must be a non-negative safe integer");
  }
}

export function parseMinorUnits(text, scale) {
  assertScale(scale);
  if (typeof text !== "string" || !/^(?:0|[0-9]+)(?:\.[0-9]+)?$/.test(text)) {
    throw new TypeError("money must be a non-negative decimal string");
  }
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > scale) {
    throw new RangeError("money has more fractional digits than the scale");
  }
  return BigInt(whole) * (10n ** BigInt(scale))
    + BigInt((fraction + "0".repeat(scale)).slice(0, scale) || "0");
}

export function formatMinorUnits(value, scale) {
  assertScale(scale);
  if (typeof value !== "bigint" || value < 0n) {
    throw new TypeError("minor units must be a non-negative bigint");
  }
  if (scale === 0) return value.toString();
  const divisor = 10n ** BigInt(scale);
  const whole = value / divisor;
  const fraction = (value % divisor).toString().padStart(scale, "0");
  return `${whole}.${fraction}`;
}

export function normalizeSku(value) {
  if (typeof value !== "string") {
    throw new TypeError("SKU must be a string");
  }
  return value.trim();
}

export function resolvePriceTier({ countryTier, shopTier, linkTier } = {}) {
  const tier = linkTier ?? shopTier ?? countryTier;
  if (!PRICE_TIERS.has(tier)) {
    throw new RangeError("price tier must be DAILY, EVENT, or MEGA");
  }
  return tier;
}
