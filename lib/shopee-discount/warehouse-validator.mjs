const MAX_AGE_MS = 35 * 24 * 60 * 60 * 1000;
const TIER_FIELDS = {
  DAILY: ["dailyMinor", "dailyApprovedAt"],
  EVENT: ["eventMinor", "eventApprovedAt"],
  MEGA: ["megaMinor", "megaApprovedAt"],
};
const BLOCK_CODES = new Set([
  "WAREHOUSE_UNAVAILABLE",
  "WAREHOUSE_SCHEMA_INVALID",
  "WAREHOUSE_PAGINATION_INCOMPLETE",
  "WAREHOUSE_WATERMARK_CHANGED",
  "WAREHOUSE_WATERMARK_STALE",
  "WAREHOUSE_EMPTY_ANOMALY",
  "WAREHOUSE_DUPLICATE_SKU",
  "WAREHOUSE_SCOPE_MISMATCH",
]);

function result(status, { code, rows = [], warnings = [], evidence = {} } = {}) {
  return { status, ...(code ? { code } : {}), rows, warnings, evidence };
}

function block(code, rows, warnings, evidence) {
  return result("BLOCKED", { code, rows, warnings, evidence });
}

function isCanonicalMinor(value) {
  return value == null || (typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value));
}

function time(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? Date.parse(value) : null;
}

function isCanonicalTimestampOrNull(value) {
  if (value == null) return true;
  const parsed = time(value);
  return parsed != null && new Date(parsed).toISOString() === value;
}

function rowKey(row) {
  return `${row.country}\u001f${row.sku}\u001f${row.platform}`;
}

function baselineKeys(baseline, scope) {
  if (!baseline || !Array.isArray(baseline.rows)) return new Set();
  const requestedSkus = new Set(scope.skus);
  return new Set(baseline.rows.filter((row) => row && typeof row === "object"
    && row.country === scope.country
    && row.platform === "SHOPEE"
    && (scope.category == null || row.category === scope.category)
    && requestedSkus.has(row.sku)).map(rowKey));
}

export function validateWarehouseSnapshot(snapshot, baseline, policy = {}, { now = new Date() } = {}) {
  const evidence = { ...(snapshot?.evidence ?? {}) };
  if (!snapshot || typeof snapshot !== "object" || snapshot.status !== "READY" || !Array.isArray(snapshot.rows)) {
    return block(BLOCK_CODES.has(snapshot?.code) ? snapshot.code : "WAREHOUSE_UNAVAILABLE", [], [], evidence);
  }
  if (!TIER_FIELDS[policy.tier]) return block("WAREHOUSE_SCHEMA_INVALID", snapshot.rows, [], evidence);
  const nowMs = now instanceof Date ? now.getTime() : NaN;
  if (Number.isNaN(nowMs)) return block("WAREHOUSE_SCHEMA_INVALID", snapshot.rows, [], evidence);
  const watermarkMs = time(evidence.watermark);
  if (watermarkMs == null) return block("WAREHOUSE_SCHEMA_INVALID", snapshot.rows, [], evidence);
  if (nowMs - watermarkMs > MAX_AGE_MS) return block("WAREHOUSE_WATERMARK_STALE", snapshot.rows, [], evidence);

  const scope = evidence.scope;
  if (!scope || typeof scope !== "object" || typeof scope.country !== "string" || !Array.isArray(scope.skus)) {
    return block("WAREHOUSE_SCHEMA_INVALID", snapshot.rows, [], evidence);
  }
  const seen = new Set();
  for (const row of snapshot.rows) {
    if (!row || typeof row !== "object" || typeof row.sku !== "string" || typeof row.country !== "string"
      || typeof row.category !== "string" || row.platform !== "SHOPEE" || typeof row.status !== "string"
      || row.watermark !== evidence.watermark || ![row.dailyMinor, row.eventMinor, row.megaMinor].every(isCanonicalMinor)
      || ![row.dailyApprovedAt, row.eventApprovedAt, row.megaApprovedAt].every(isCanonicalTimestampOrNull)) {
      return block("WAREHOUSE_SCHEMA_INVALID", snapshot.rows, [], evidence);
    }
    if (row.country !== scope.country || (scope.category != null && row.category !== scope.category) || !scope.skus.includes(row.sku)) {
      return block("WAREHOUSE_SCOPE_MISMATCH", snapshot.rows, [], evidence);
    }
    const key = rowKey(row);
    if (seen.has(key)) return block("WAREHOUSE_DUPLICATE_SKU", snapshot.rows, [], evidence);
    seen.add(key);
  }

  const prior = baselineKeys(baseline, scope);
  const missingCount = [...prior].filter((key) => !seen.has(key)).length;
  const maxMissingCount = policy.maxMissingCount ?? 0;
  const maxMissingRatio = policy.maxMissingRatio ?? 0;
  if (!Number.isSafeInteger(maxMissingCount) || maxMissingCount < 0 || typeof maxMissingRatio !== "number"
    || !Number.isFinite(maxMissingRatio) || maxMissingRatio < 0 || maxMissingRatio > 1) {
    return block("WAREHOUSE_SCHEMA_INVALID", snapshot.rows, [], evidence);
  }
  const missingRatio = prior.size === 0 ? 0 : missingCount / prior.size;
  evidence.baselineRowCount = prior.size;
  evidence.missingCount = missingCount;
  evidence.missingRatio = missingRatio;
  if ((prior.size > 0 && snapshot.rows.length === 0) || missingCount > maxMissingCount || missingRatio > maxMissingRatio) {
    return block("WAREHOUSE_EMPTY_ANOMALY", snapshot.rows, [], evidence);
  }

  const [priceField, approvedAtField] = TIER_FIELDS[policy.tier];
  const warnings = [];
  let staleApprovalCount = 0;
  let selectedPriceCount = 0;
  const rows = snapshot.rows.map((row) => {
    const selectedMinor = row[priceField];
    if (selectedMinor == null || selectedMinor === "0") {
      return { ...row, selectedMinor: null, warehouseResult: "VALIDATED_MISSING" };
    }
    selectedPriceCount += 1;
    const approvedAtMs = time(row[approvedAtField]);
    if (approvedAtMs == null) {
      return { ...row, selectedMinor, warehouseResult: "FOUND" };
    }
    if (nowMs - approvedAtMs > MAX_AGE_MS) {
      staleApprovalCount += 1;
      warnings.push({ code: "WAREHOUSE_APPROVAL_STALE", sku: row.sku, tier: policy.tier });
    }
    return { ...row, selectedMinor, warehouseResult: "FOUND" };
  });
  if (selectedPriceCount > 0 && staleApprovalCount / selectedPriceCount > 0.2) {
    warnings.push({ code: "WAREHOUSE_APPROVAL_STALE_RATIO", staleCount: staleApprovalCount, rowCount: selectedPriceCount });
  }
  evidence.staleApprovalCount = staleApprovalCount;
  evidence.selectedPriceCount = selectedPriceCount;
  return result("READY", { rows, warnings, evidence });
}
