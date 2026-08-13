function parseCanonicalMinor(value, name) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new TypeError(`${name} must be a canonical non-negative minor-unit string`);
  }
  return BigInt(value);
}

function skipped(code, message) {
  return { status: "SKIPPED", code, message };
}

function parseSite(site) {
  if (!site || typeof site !== "object") {
    throw new TypeError("site is required");
  }
  const min = parseCanonicalMinor(site.minMinor, "site.minMinor");
  const max = parseCanonicalMinor(site.maxMinor, "site.maxMinor");
  const step = parseCanonicalMinor(site.stepMinor, "site.stepMinor");
  if (min > max) throw new RangeError("site minimum cannot exceed maximum");
  return { min, max, step };
}

function validateTarget(target, original, site, { fallback }) {
  if (target >= original) {
    return skipped(
      "TARGET_NOT_BELOW_ORIGINAL",
      "Warehouse target is not below the Shopee original; original-price baseline must be rebuilt manually.",
    );
  }
  if (target <= 0n || target < site.min || target > site.max) {
    return skipped(
      fallback ? "FALLBACK_OUT_OF_RANGE" : "WAREHOUSE_TARGET_OUT_OF_RANGE",
      fallback ? "The normalized fallback target is outside the permitted site range." : "The warehouse target is outside the permitted site range.",
    );
  }
  if (site.step <= 0n || target % site.step !== 0n) {
    return skipped(
      fallback ? "FALLBACK_STEP_INVALID" : "WAREHOUSE_TARGET_STEP_INVALID",
      fallback ? "The normalized fallback target violates the site price step." : "The warehouse target violates the site price step.",
    );
  }
  return null;
}

export function decideVariantPrice(input) {
  if (!input || typeof input !== "object") {
    throw new TypeError("price decision input is required");
  }
  const original = parseCanonicalMinor(input.originalMinor, "originalMinor");
  const current = parseCanonicalMinor(input.currentDiscountMinor, "currentDiscountMinor");
  const warehouseTarget = parseCanonicalMinor(input.warehouseTargetMinor, "warehouseTargetMinor");
  const site = parseSite(input.site);

  if (input.warehouseResult === "FOUND") {
    const invalid = validateTarget(warehouseTarget, original, site, { fallback: false });
    if (invalid) return invalid;
    return {
      status: "READY",
      targetMinor: warehouseTarget.toString(),
      source: "WAREHOUSE",
      matchesCurrent: warehouseTarget === current,
    };
  }
  if (input.warehouseResult !== "VALIDATED_MISSING") {
    return skipped(
      "WAREHOUSE_RESULT_NOT_EXECUTABLE",
      "Warehouse lookup result is not a validated executable result.",
    );
  }
  if (site.step <= 0n) {
    return skipped("FALLBACK_STEP_INVALID", "The normalized fallback target violates the site price step.");
  }
  const target = ((original * 99n) / 100n / site.step) * site.step;
  const invalid = validateTarget(target, original, site, { fallback: true });
  if (invalid) return invalid;
  return {
    status: "READY",
    targetMinor: target.toString(),
    source: "ORIGINAL_1_PERCENT_OFF",
    matchesCurrent: target === current,
  };
}
