import assert from "node:assert/strict";
import test from "node:test";
import {
  detectMarketplacePlatform,
  normalizeMarketplaceLink,
  normalizeMarketplaceUrl,
} from "../lib/marketplace-url.mjs";

test("marketplace links accept URLs with and without an explicit protocol", () => {
  assert.equal(detectMarketplacePlatform("shopee.ph/product/1/2"), "shopee");
  assert.equal(detectMarketplacePlatform("https://www.lazada.com.ph/products/item-i1.html"), "lazada");
  assert.equal(detectMarketplacePlatform("https://shop.tiktok.com/ph/pdp/item/123"), "tiktok");
});

test("marketplace links are extracted from platform share text", () => {
  const lazada = normalizeMarketplaceLink("Look at this item https://s.lazada.com.ph/s.example?dsource=share now");
  const shopee = normalizeMarketplaceLink("推荐商品：https://shopee.ph/product/123/456，复制链接打开");
  const tiktok = normalizeMarketplaceLink("https://vt.tiktok.com/ZSexample/ shared via TikTok");
  assert.equal(lazada.platform, "lazada");
  assert.equal(shopee.platform, "shopee");
  assert.equal(tiktok.platform, "tiktok");
  assert.equal(shopee.url, "https://shopee.ph/product/123/456");
});

test("marketplace links are extracted from share text containing a bare domain", () => {
  const result = normalizeMarketplaceLink("推荐商品：shopee.co.th/product/123/456，复制后打开");
  assert.equal(result.platform, "shopee");
  assert.equal(result.url, "https://shopee.co.th/product/123/456");
});

test("marketplace recognition uses exact domain boundaries", () => {
  assert.equal(detectMarketplacePlatform("https://shopee.ph.attacker.example/product/1/2"), "unknown");
  assert.equal(detectMarketplacePlatform("javascript:alert(1)"), "unknown");
  assert.throws(() => normalizeMarketplaceLink("https://example.com/product/1"));
});

test("marketplace URL normalization removes fragments and trailing share punctuation", () => {
  assert.equal(
    normalizeMarketplaceUrl("https://www.lazada.vn/products/item-i1.html#reviews。"),
    "https://www.lazada.vn/products/item-i1.html",
  );
});
