import assert from "node:assert/strict";
import test from "node:test";

test("production preview capabilities cover every connected Shopee country with site minor-unit precision", async () => {
  const { resolveShopeeDiscountSiteCapabilities } = await import("../lib/shopee-discount/site-capabilities.mjs");
  const capabilities = resolveShopeeDiscountSiteCapabilities();

  assert.deepEqual(Object.keys(capabilities).sort(), ["ID", "MY", "PH", "SG", "TH", "TW", "VN"]);
  assert.deepEqual(capabilities.ID, { currency: "IDR", scale: 0, minMinor: "1", maxMinor: "999999999", stepMinor: "1" });
  assert.deepEqual(capabilities.TH, { currency: "THB", scale: 2, minMinor: "1", maxMinor: "999999999", stepMinor: "1" });
  assert.deepEqual(capabilities.VN, { currency: "VND", scale: 0, minMinor: "1", maxMinor: "999999999", stepMinor: "1" });
});
