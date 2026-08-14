const FIELD_RULES = Object.freeze({
  warehouseKeyVerifiedAt: { kind: "timestamp" },
  warehouseKeyVerifiedFingerprint: { kind: "hash" },
  warehouseKeyMask: { kind: "mask" },
  catalogPermissionVerifiedAt: { kind: "timestamp" },
});

const MASK_PATTERN = /^[A-Za-z0-9._:-]{0,16}(?:…|\*{3,})[A-Za-z0-9._:-]{0,8}$/u;

function invalid(message) {
  return Object.assign(new TypeError(message), { code: "SHOPEE_DISCOUNT_SETTINGS_METADATA_INVALID" });
}

function normalizeField(key, value) {
  const rule = FIELD_RULES[key];
  if (typeof value !== "string") throw invalid(`settings metadata ${key} must be a string`);
  if (rule.kind === "timestamp") {
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime())) throw invalid(`settings metadata ${key} must be a valid date/time`);
    return parsed.toISOString();
  }
  if (rule.kind === "hash" && !/^[a-f0-9]{64}$/.test(value)) throw invalid(`settings metadata ${key} must be a SHA-256 hash`);
  if (rule.kind === "mask" && !MASK_PATTERN.test(value)) {
    throw invalid(`settings metadata ${key} must contain a bounded masking marker`);
  }
  return value;
}

export function normalizeShopeeDiscountSettingsMetadata(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid("settings metadata must be an allowlisted object");
  }
  const normalized = {};
  for (const [key, fieldValue] of Object.entries(value)) {
    if (!Object.hasOwn(FIELD_RULES, key)) throw invalid(`settings metadata field is not allowed: ${key}`);
    normalized[key] = normalizeField(key, fieldValue);
  }
  return normalized;
}

export function sanitizeShopeeDiscountSettingsMetadata(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const sanitized = {};
  for (const key of Object.keys(FIELD_RULES)) {
    if (!Object.hasOwn(value, key)) continue;
    try {
      sanitized[key] = normalizeField(key, value[key]);
    } catch {
      // Historical malformed values are omitted at the read boundary.
    }
  }
  return sanitized;
}
