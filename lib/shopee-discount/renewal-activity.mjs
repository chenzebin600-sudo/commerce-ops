import { createHash } from "node:crypto";

const TIERS = new Set(["DAILY", "EVENT", "MEGA"]);

function required(value, name) {
  const output = String(value ?? "").trim();
  if (!output) throw new TypeError(`${name} is required`);
  return output;
}

function timestamp(value, name) {
  const output = required(value, name);
  if (new Date(output).toISOString() !== output) throw new TypeError(`${name} must be a canonical timestamp`);
  return output;
}

export function buildRenewalActivityIdentity({ planId, country, shopId, priceTier, targetStartsAt, targetEndsAt }) {
  const input = {
    version: "SHOPEE_DISCOUNT_RENEWAL_V1",
    planId: required(planId, "planId"),
    country: required(country, "country"),
    shopId: required(shopId, "shopId"),
    priceTier: required(priceTier, "priceTier"),
    targetStartsAt: timestamp(targetStartsAt, "targetStartsAt"),
    targetEndsAt: timestamp(targetEndsAt, "targetEndsAt"),
  };
  if (!/^[A-Z]{2,3}$/.test(input.country) || !TIERS.has(input.priceTier) || input.targetEndsAt <= input.targetStartsAt) {
    throw new TypeError("Renewal activity identity is invalid");
  }
  const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const discountName = `PM-${input.country}-${input.priceTier}-${input.targetStartsAt.slice(0, 10)}-${fingerprint.slice(0, 8).toUpperCase()}`;
  return Object.freeze({
    workflow: "NEXT_RENEWAL",
    priceTier: input.priceTier,
    fingerprint,
    marker: discountName,
    discountName,
  });
}
