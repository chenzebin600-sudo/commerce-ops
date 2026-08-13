import assert from "node:assert/strict";
import test from "node:test";

import {
  formatMinorUnits,
  normalizeSku,
  parseMinorUnits,
  resolvePriceTier,
} from "../lib/shopee-discount/contracts.mjs";
import { decideVariantPrice } from "../lib/shopee-discount/pricing-engine.mjs";

function site({ minMinor = "1", maxMinor = "100000", stepMinor = "1" } = {}) {
  return { minMinor, maxMinor, stepMinor };
}

function decision(input = {}) {
  return decideVariantPrice({
    originalMinor: "1000",
    currentDiscountMinor: "900",
    warehouseTargetMinor: "900",
    warehouseResult: "FOUND",
    site: site(),
    ...input,
  });
}

test("decimal minor-unit conversion preserves scale-zero and scale-two values", () => {
  assert.equal(parseMinorUnits("42", 0), 42n);
  assert.equal(formatMinorUnits(42n, 0), "42");
  assert.equal(parseMinorUnits("42.5", 2), 4250n);
  assert.equal(parseMinorUnits("000.05", 2), 5n);
  assert.equal(formatMinorUnits(5n, 2), "0.05");
  assert.equal(formatMinorUnits(4250n, 2), "42.50");
});

test("decimal minor-unit conversion rejects lossy and non-decimal money inputs", () => {
  for (const value of ["", " ", "1e3", "-1", "1.234", "1.", 9007199254740992, 1]) {
    assert.throws(() => parseMinorUnits(value, 2));
  }
  assert.throws(() => formatMinorUnits(-1n, 2));
  assert.throws(() => formatMinorUnits(100, 2));
});

test("SKU normalization trims only Unicode edge whitespace", () => {
  assert.equal(normalizeSku("\u00A0\u3000 00Ab-C_+ \u202F\uFEFF"), "00Ab-C_+");
  assert.equal(normalizeSku("A\t B\u200B C"), "A\t B\u200B C");
  assert.equal(normalizeSku("000aBc-_$"), "000aBc-_$");
  assert.throws(() => normalizeSku(123));
});

test("price tier resolves link then shop then country and rejects invalid selected tiers", () => {
  assert.equal(resolvePriceTier({ countryTier: "DAILY", shopTier: "EVENT", linkTier: "MEGA" }), "MEGA");
  assert.equal(resolvePriceTier({ countryTier: "DAILY", shopTier: "EVENT", linkTier: undefined }), "EVENT");
  assert.equal(resolvePriceTier({ countryTier: "DAILY", shopTier: null, linkTier: undefined }), "DAILY");
  assert.throws(() => resolvePriceTier({ countryTier: "WEEKLY" }));
});

test("price tier rejects invalid values even when a higher-priority tier is selected", () => {
  assert.throws(() => resolvePriceTier({ countryTier: "WEEKLY", shopTier: "EVENT" }));
  assert.throws(() => resolvePriceTier({ countryTier: "DAILY", shopTier: "WEEKLY", linkTier: "MEGA" }));
});

test("literal warehouse target is ready and compares current discount in exact minor units", () => {
  assert.deepEqual(decision(), {
    status: "READY",
    targetMinor: "900",
    source: "WAREHOUSE",
    matchesCurrent: true,
  });
  assert.deepEqual(decision({ currentDiscountMinor: "899" }), {
    status: "READY",
    targetMinor: "900",
    source: "WAREHOUSE",
    matchesCurrent: false,
  });
});

test("a validated missing warehouse price falls back via integer one-percent and site-step floors", () => {
  assert.deepEqual(decision({
    originalMinor: "1000",
    currentDiscountMinor: "975",
    warehouseTargetMinor: "0",
    warehouseResult: "VALIDATED_MISSING",
    site: site({ minMinor: "1", maxMinor: "2000", stepMinor: "25" }),
  }), {
    status: "READY",
    targetMinor: "975",
    source: "ORIGINAL_1_PERCENT_OFF",
    matchesCurrent: true,
  });
});

test("invalid fallback results skip only the affected variant with stable codes", () => {
  assert.equal(decision({
    originalMinor: "1",
    warehouseTargetMinor: "0",
    warehouseResult: "VALIDATED_MISSING",
  }).code, "FALLBACK_OUT_OF_RANGE");
  assert.equal(decision({
    originalMinor: "100",
    warehouseTargetMinor: "0",
    warehouseResult: "VALIDATED_MISSING",
    site: site({ minMinor: "100", maxMinor: "1000", stepMinor: "1" }),
  }).code, "FALLBACK_OUT_OF_RANGE");
  assert.equal(decision({
    originalMinor: "100",
    warehouseTargetMinor: "0",
    warehouseResult: "VALIDATED_MISSING",
    site: site({ minMinor: "1", maxMinor: "98", stepMinor: "1" }),
  }).code, "FALLBACK_OUT_OF_RANGE");
  assert.equal(decision({
    warehouseTargetMinor: "0",
    warehouseResult: "VALIDATED_MISSING",
    site: site({ stepMinor: "0" }),
  }).code, "FALLBACK_STEP_INVALID");
});

test("a non-positive validated-missing fallback is out of range before baseline comparison", () => {
  assert.equal(decision({
    originalMinor: "0",
    warehouseTargetMinor: "0",
    warehouseResult: "VALIDATED_MISSING",
  }).code, "FALLBACK_OUT_OF_RANGE");
});

test("a warehouse target at or above the Shopee original is isolated with a rebuild reminder", () => {
  const result = decision({ warehouseTargetMinor: "1000" });
  assert.equal(result.status, "SKIPPED");
  assert.equal(result.code, "TARGET_NOT_BELOW_ORIGINAL");
  assert.match(result.message, /original-price baseline must be rebuilt manually/i);
  assert.equal(decision({ warehouseResult: "UNVALIDATED" }).code, "WAREHOUSE_RESULT_NOT_EXECUTABLE");
});
