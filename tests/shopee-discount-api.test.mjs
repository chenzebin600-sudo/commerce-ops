import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { createShopeeDiscountApi } from "../lib/shopee-discount/api.mjs";

function request(method, body = undefined, auditOverrides = {}) {
  const raw = body === undefined ? "" : (typeof body === "string" ? body : JSON.stringify(body));
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  req.method = method;
  req.headers = {};
  req.auditContext = {
    requestId: "api-request-1",
    actorType: "user",
    annotations: {},
    annotate(values) { Object.assign(this.annotations, values); },
    ...auditOverrides,
  };
  return req;
}

function response() {
  return {
    statusCode: null,
    headers: null,
    body: "",
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
    end(chunk = "") { this.body += chunk; },
    json() { return this.body ? JSON.parse(this.body) : null; },
  };
}

function serviceDouble() {
  const calls = [];
  const service = {};
  for (const name of ["status", "listShops", "createPreview", "getPreview", "listPreviewItems", "approvePreview", "requestExecution", "listRuns", "listActivities", "listIssues", "requestManualScan"]) {
    service[name] = async (...args) => {
      calls.push({ name, args });
      if (name === "createPreview") return { id: "plan-1", merkleRoot: "root-1", summary: { counts: { ready: 2 } } };
      if (name === "approvePreview") return { id: "plan-1", state: "APPROVED", itemCount: 2 };
      if (name === "requestExecution") return { id: "job-1", planId: "plan-1", status: "PENDING", reused: false };
      if (name === "listPreviewItems") return { items: [{ id: "item-1" }], nextCursor: null };
      if (name.startsWith("list")) return [];
      return { ok: true };
    };
  }
  return { service, calls };
}

async function invoke(handler, method, path, body, auditOverrides) {
  const req = request(method, body, auditOverrides);
  const res = response();
  const handled = await handler(req, res, new URL(path, "http://localhost"));
  return { req, res, handled, payload: res.json() };
}

test("API exposes only fixed Shopee Discount routes and returns false outside the module", async () => {
  const { service, calls } = serviceDouble();
  const handler = createShopeeDiscountApi({ service, maxBodyBytes: 1024 });
  assert.equal((await invoke(handler, "GET", "/api/other/status")).handled, false);
  const routes = [
    ["GET", "/api/shopee-discount/status", "status"],
    ["GET", "/api/shopee-discount/shops", "listShops"],
    ["POST", "/api/shopee-discount/previews", "createPreview", {}],
    ["GET", "/api/shopee-discount/previews/plan-1", "getPreview"],
    ["GET", "/api/shopee-discount/previews/plan-1/items?pageSize=25&cursor=2&status=PENDING", "listPreviewItems"],
    ["POST", "/api/shopee-discount/previews/plan-1/approve", "approvePreview", { planId: "plan-1", merkleRoot: "root-1", operatorName: "Alice", confirmationText: "confirm" }],
    ["POST", "/api/shopee-discount/previews/plan-1/execute", "requestExecution", { planId: "plan-1", merkleRoot: "root-1" }],
    ["GET", "/api/shopee-discount/runs?status=PENDING", "listRuns"],
    ["GET", "/api/shopee-discount/activities?shopId=1", "listActivities"],
    ["GET", "/api/shopee-discount/issues?code=BLOCKED", "listIssues"],
    ["POST", "/api/shopee-discount/scans", "requestManualScan", { country: "TH", shopIds: ["1"] }],
  ];
  for (const [method, path, expected, body] of routes) {
    const result = await invoke(handler, method, path, body);
    assert.equal(result.handled, true, path);
    assert.equal(result.res.statusCode, 200, path);
    assert.equal(calls.at(-1).name, expected, path);
  }
  const arbitrary = await invoke(handler, "POST", "/api/shopee-discount/proxy", { apiPath: "/api/v2/discount/add_discount" });
  assert.equal(arbitrary.handled, true);
  assert.equal(arbitrary.res.statusCode, 404);
  assert.equal(calls.some(({ args }) => JSON.stringify(args).includes("add_discount")), false);
});

test("API rejects method mismatches, unknown query parameters, malformed JSON, and oversized bodies", async () => {
  const { service, calls } = serviceDouble();
  const handler = createShopeeDiscountApi({ service, maxBodyBytes: 64 });
  assert.equal((await invoke(handler, "DELETE", "/api/shopee-discount/status")).res.statusCode, 405);
  assert.equal((await invoke(handler, "GET", "/api/shopee-discount/status?secret=x")).res.statusCode, 400);
  assert.equal((await invoke(handler, "POST", "/api/shopee-discount/previews", "{")).res.statusCode, 400);
  assert.equal((await invoke(handler, "POST", "/api/shopee-discount/previews", "x".repeat(65))).res.statusCode, 413);
  assert.equal(calls.length, 0);
});

test("route plan ID must match the exact approval and execution body binding", async () => {
  const { service, calls } = serviceDouble();
  const handler = createShopeeDiscountApi({ service, maxBodyBytes: 1024 });
  const approval = await invoke(handler, "POST", "/api/shopee-discount/previews/plan-1/approve", { planId: "plan-2", merkleRoot: "root", operatorName: "Alice", confirmationText: "confirm" });
  const execution = await invoke(handler, "POST", "/api/shopee-discount/previews/plan-1/execute", { planId: "plan-2", merkleRoot: "root" });
  assert.equal(approval.res.statusCode, 400);
  assert.equal(execution.res.statusCode, 400);
  assert.equal(calls.length, 0);
});

test("trusted actor and privileged identity come only from audit context, never body or headers", async () => {
  const { service, calls } = serviceDouble();
  const handler = createShopeeDiscountApi({ service, maxBodyBytes: 1024 });
  const body = {
    planId: "plan-1",
    merkleRoot: "root-1",
    operatorName: "Declared label",
    confirmationText: "confirm",
    privilegedApproval: { planId: "plan-1", merkleRoot: "root-1", policyHash: "policy", expiresAt: "2026-08-13T11:00:00.000Z" },
  };
  const result = await invoke(handler, "POST", "/api/shopee-discount/previews/plan-1/approve", body, {
    actorIdentifier: "trusted-user-1",
    privilegedIdentity: "privileged_execute_identity",
  });
  assert.equal(result.res.statusCode, 200);
  const context = calls.at(-1).args[1];
  assert.equal(context.actorId, "trusted-user-1");
  assert.equal(context.privilegedIdentity, "privileged_execute_identity");
  assert.equal(Object.hasOwn(context, "operatorName"), false);
});

test("API maps stable safe errors and audit annotations contain IDs and counts without raw internals", async () => {
  const { service } = serviceDouble();
  service.createPreview = async () => {
    const error = new Error("SQLITE_ERROR: SELECT encrypted_secret FROM internal_table");
    error.code = "ERR_SQLITE_ERROR";
    throw error;
  };
  const handler = createShopeeDiscountApi({ service, maxBodyBytes: 1024 });
  const failed = await invoke(handler, "POST", "/api/shopee-discount/previews", {});
  assert.equal(failed.res.statusCode, 500);
  assert.deepEqual(failed.payload, { ok: false, code: "SHOPEE_DISCOUNT_INTERNAL_ERROR", error: "Shopee Discount request failed" });
  assert.equal(JSON.stringify(failed).includes("encrypted_secret"), false);

  const double = serviceDouble();
  const successful = await invoke(createShopeeDiscountApi({ service: double.service, maxBodyBytes: 1024 }), "POST", "/api/shopee-discount/previews", {});
  assert.equal(successful.req.auditContext.annotations.planId, "plan-1");
  assert.deepEqual(successful.req.auditContext.annotations.metadata, { readyCount: 2 });
  assert.equal(JSON.stringify(successful.req.auditContext.annotations).includes("merkleRoot"), false);
});
