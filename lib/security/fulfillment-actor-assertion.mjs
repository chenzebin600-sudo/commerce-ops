import { createHmac, timingSafeEqual } from "node:crypto";

export const FULFILLMENT_ACTOR_ASSERTION_HEADER = "x-commerce-actor-assertion";

function bounded(value, name, maxLength) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new TypeError(`${name} is invalid`);
  }
  return normalized;
}
function assertionSecret(value) {
  const secret = String(value || "");
  if (Buffer.byteLength(secret, "utf8") < 32) throw new TypeError("Fulfillment actor assertion secret is too short");
  return secret;
}

function signature(payload, secret) {
  return createHmac("sha256", assertionSecret(secret)).update(payload).digest("base64url");
}

export function normalizeFulfillmentActor(input, { requireHuman = false } = {}) {
  if (!input || typeof input !== "object") throw new TypeError("Fulfillment actor is required");
  const actorType = bounded(input.actorType, "Fulfillment actor type", 20);
  if (!new Set(["human", "service", "system"]).has(actorType)) throw new TypeError("Fulfillment actor type is invalid");
  if (requireHuman && actorType !== "human") throw new TypeError("Manual fulfillment approval requires a human actor");
  return Object.freeze({
    actorType,
    authSource: bounded(input.authSource, "Fulfillment authentication source", 80),
    externalSubject: bounded(input.externalSubject, "Fulfillment actor subject", 200),
    displayName: bounded(input.displayName, "Fulfillment actor display name", 120),
  });
}

export function createFulfillmentActorAssertion(actorInput, {
  secret,
  requestId,
  issuedAt = Date.now(),
} = {}) {
  const actor = normalizeFulfillmentActor(actorInput);
  const normalizedIssuedAt = Math.trunc(Number(issuedAt));
  if (!Number.isSafeInteger(normalizedIssuedAt) || normalizedIssuedAt <= 0) {
    throw new TypeError("Fulfillment assertion issued time is invalid");
  }
  const payload = Buffer.from(JSON.stringify({
    version: 1,
    ...actor,
    requestId: bounded(requestId, "Fulfillment assertion request ID", 160),
    issuedAt: normalizedIssuedAt,
  }), "utf8").toString("base64url");
  return `v1.${payload}.${signature(payload, secret)}`;
}

export function verifyFulfillmentActorAssertion(value, {
  secret,
  now = Date.now(),
  maxAgeMs = 60_000,
  futureSkewMs = 5_000,
} = {}) {
  const parts = String(value || "").split(".");
  if (parts.length !== 3 || parts[0] !== "v1") throw new TypeError("Fulfillment actor assertion is invalid");
  const expected = Buffer.from(signature(parts[1], secret), "utf8");
  const received = Buffer.from(parts[2], "utf8");
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    throw new TypeError("Fulfillment actor assertion signature is invalid");
  }
  let decoded;
  try { decoded = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")); }
  catch { throw new TypeError("Fulfillment actor assertion payload is invalid"); }
  if (decoded?.version !== 1 || !Number.isSafeInteger(decoded.issuedAt)) {
    throw new TypeError("Fulfillment actor assertion payload is invalid");
  }
  const current = Math.trunc(Number(now));
  if (!Number.isSafeInteger(current) || decoded.issuedAt > current + futureSkewMs || current - decoded.issuedAt > maxAgeMs) {
    throw new TypeError("Fulfillment actor assertion has expired");
  }
  return Object.freeze({
    ...normalizeFulfillmentActor(decoded),
    requestId: bounded(decoded.requestId, "Fulfillment assertion request ID", 160),
    issuedAt: decoded.issuedAt,
  });
}
