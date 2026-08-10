import test from "node:test";
import assert from "node:assert/strict";

import { MabangListingInternalClient } from "../lib/inventory-sync/mabang-listing-client.mjs";

function jsonResponse(payload) {
  return new Response(JSON.stringify({ success: true, ...payload }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("fresh Shopee listing reads refresh every page and report exact progress", async () => {
  const urls = [];
  const progress = [];
  const client = new MabangListingInternalClient({
    baseUrl: "http://listing.local",
    internalToken: "test-token",
    fetchImpl: async (url) => {
      urls.push(String(url));
      const page = Number(new URL(url).searchParams.get("page"));
      return jsonResponse({
        items: page === 1 ? [{ internal_id: "1" }, { internal_id: "2" }] : [{ internal_id: "3" }],
        total: 3,
      });
    },
  });

  const rows = await client.shopeeListings(["shop-2", "shop-1", "shop-1"], {
    refresh: true,
    pageSize: 2,
    onProgress: (value) => progress.push(value),
  });

  assert.equal(rows.length, 3);
  assert.equal(urls.length, 2);
  assert.ok(urls.every((url) => new URL(url).searchParams.get("refresh") === "1"));
  assert.ok(urls.every((url) => new URL(url).searchParams.get("shop_id") === "shop-1,shop-2"));
  assert.deepEqual(progress.map((item) => item.fetched), [2, 3]);
  assert.deepEqual(rows.readMetrics, {
    shopCount: 2,
    pageCount: 2,
    listingCount: 3,
    durationMs: rows.readMetrics.durationMs,
    fresh: true,
  });
});

test("Shopee listing reads use the service maximum page size by default", async () => {
  let requestedPageSize = null;
  const client = new MabangListingInternalClient({
    baseUrl: "http://listing.local",
    internalToken: "test-token",
    fetchImpl: async (url) => {
      requestedPageSize = Number(new URL(url).searchParams.get("page_size"));
      return jsonResponse({ items: [{ internal_id: "1" }], total: 1 });
    },
  });

  const rows = await client.shopeeListings(["shop-1"]);

  assert.equal(rows.length, 1);
  assert.equal(requestedPageSize, 500);
});

test("Shopee listing page failures retry the same page", async () => {
  let secondPageAttempts = 0;
  const progress = [];
  const client = new MabangListingInternalClient({
    baseUrl: "http://listing.local",
    internalToken: "test-token",
    listingPageRetries: 1,
    fetchImpl: async (url) => {
      const page = Number(new URL(url).searchParams.get("page"));
      if (page === 2 && secondPageAttempts++ === 0) throw new Error("temporary network failure");
      return jsonResponse({ items: page === 1 ? [{ internal_id: "1" }] : [{ internal_id: "2" }], total: 2 });
    },
  });

  const rows = await client.shopeeListings(["shop-1"], { pageSize: 1, onProgress: (value) => progress.push(value) });
  assert.equal(rows.length, 2);
  assert.equal(secondPageAttempts, 2);
  assert.ok(progress.some((item) => item.stage === "RETRYING" && item.page === 2));
});

test("Shopee listing read fails closed when page totals drift", async () => {
  let secondPageAttempts = 0;
  const client = new MabangListingInternalClient({
    baseUrl: "http://listing.local",
    internalToken: "test-token",
    fetchImpl: async (url) => {
      const page = Number(new URL(url).searchParams.get("page"));
      if (page === 2) secondPageAttempts += 1;
      return jsonResponse({ items: [{ internal_id: String(page) }], total: page === 1 ? 2 : 3 });
    },
  });

  await assert.rejects(
    () => client.shopeeListings(["shop-1"], { pageSize: 1 }),
    (error) => error.code === "INVENTORY_SYNC_LISTING_COUNT_DRIFT",
  );
  assert.equal(secondPageAttempts, 3);
});

test("Shopee listing retries a transient empty page with a zero total", async () => {
  let secondPageAttempts = 0;
  const progress = [];
  const client = new MabangListingInternalClient({
    baseUrl: "http://listing.local",
    internalToken: "test-token",
    listingPageRetries: 2,
    fetchImpl: async (url) => {
      const page = Number(new URL(url).searchParams.get("page"));
      if (page === 2 && secondPageAttempts++ === 0) return jsonResponse({ items: [], total: 0 });
      return jsonResponse({ items: [{ internal_id: String(page) }], total: 2 });
    },
  });

  const rows = await client.shopeeListings(["shop-1"], { pageSize: 1, onProgress: (value) => progress.push(value) });
  assert.equal(rows.length, 2);
  assert.equal(secondPageAttempts, 2);
  assert.ok(progress.some((item) => item.stage === "RETRYING" && item.page === 2));
});
