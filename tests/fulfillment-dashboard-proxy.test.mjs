import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createFulfillmentDashboardProxy } from "../lib/fulfillment-dashboard-proxy.mjs";

function request(payload) {
  const req = Readable.from([JSON.stringify(payload)]);
  req.method = "POST";
  req.headers = {};
  return req;
}

function response() {
  return { status: 0, body: "", writeHead(status) { this.status = status; }, end(body) { this.body = body; } };
}

test("SKU replacement plan proxy forwards only the normalized target warehouse", async () => {
  const calls = [];
  const proxy = createFulfillmentDashboardProxy({ fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({ success: true, data: {} }), { status: 201 });
  } });
  const req = request({ orderReference: "ORDER_10001", itemId: "123", replacementSku: "sku-small",
    targetWarehouse: " 允许仓A ", unexpected: "drop" });

  assert.equal(await proxy(req, response(), new URL("http://localhost/api/fulfillment-dashboard/sku-replacements/plan")), true);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    orderReference: "ORDER_10001", itemId: "123", replacementSku: "sku-small", targetWarehouse: "允许仓A",
  });
});

test("SKU replacement batch proxy retains targets and rejects control characters", async () => {
  const calls = [];
  const proxy = createFulfillmentDashboardProxy({ fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({ success: true, data: {} }), { status: 201 });
  } });
  const req = request({ selections: [
    { orderReference: "ORDER_10001", itemId: "123", replacementSku: "SKU-A", targetWarehouse: "允许仓A" },
    { orderReference: "ORDER_10002", itemId: "456", replacementSku: "SKU-B" },
  ] });

  assert.equal(await proxy(req, response(), new URL("http://localhost/api/fulfillment-dashboard/sku-replacements/batch-plan")), true);
  assert.deepEqual(JSON.parse(calls[0].options.body), { selections: [
    { orderReference: "ORDER_10001", itemId: "123", replacementSku: "SKU-A", targetWarehouse: "允许仓A" },
    { orderReference: "ORDER_10002", itemId: "456", replacementSku: "SKU-B" },
  ] });

  const invalidResponse = response();
  const invalid = request({ selections: [
    { orderReference: "ORDER_10003", itemId: "789", replacementSku: "SKU-C", targetWarehouse: "允许仓\nA" },
  ] });
  assert.equal(await proxy(invalid, invalidResponse, new URL("http://localhost/api/fulfillment-dashboard/sku-replacements/batch-plan")), true);
  assert.equal(invalidResponse.status, 400);
  assert.equal(calls.length, 1);
});

test("SKU replacement execution proxy never accepts a target warehouse", async () => {
  const calls = [];
  const proxy = createFulfillmentDashboardProxy({ fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({ success: true, data: {} }), { status: 200 });
  } });
  const req = request({ planHash: "a".repeat(64), approvalText: "确认更换", targetWarehouse: "任意仓" });

  assert.equal(await proxy(req, response(), new URL("http://localhost/api/fulfillment-dashboard/sku-replacements/execute")), true);
  assert.deepEqual(JSON.parse(calls[0].options.body), { planHash: "a".repeat(64), approvalText: "确认更换" });
});
