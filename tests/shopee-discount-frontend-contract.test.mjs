import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, root), "utf8");
const clientUrl = new URL("frontend/commerce-ops-vue/src/services/shopee-discount.ts", root);

function installBrowserDoubles(responses) {
  const calls = [];
  globalThis.sessionStorage = {
    getItem() { return null; },
    setItem() {},
    removeItem() {},
  };
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), method: init.method || "GET", headers: new Headers(init.headers), body: init.body });
    const next = responses.shift();
    assert.ok(next, `unexpected request ${String(input)}`);
    return new Response(JSON.stringify(next.body), {
      status: next.status || 200,
      headers: { "content-type": "application/json" },
    });
  };
  return calls;
}

function previewInput(overrides = {}) {
  return {
    country: "TH", shopIds: [], useDefaultShops: true, workflow: "NEXT_RENEWAL", defaultTier: "DAILY",
    shopOverrides: [], linkOverrides: [], activitySelection: [], category: "家具",
    renewal: { requestedStartAt: "2026-08-15T00:00:00.000Z", durationDays: 30 },
    ...overrides,
  };
}

test("typed client executes only fixed first-party URLs, methods and exact request bodies", async () => {
  const client = await import(clientUrl.href);
  const preview = { id: "plan-1", country: "TH", state: "PREVIEWED", merkleRoot: "root", policyHash: "policy", itemCount: 1, confirmationText: "确认", summary: {} };
  const calls = installBrowserDoubles([
    { body: { ok: true, data: { enabled: true } } }, { body: { ok: true, data: [] } },
    { body: { ok: true, data: preview } }, { body: { ok: true, data: preview } },
    { body: { ok: true, data: { items: [], nextCursor: null } } }, { body: { ok: true, data: preview } },
    { body: { ok: true, data: { id: "job-1" } } }, { body: { ok: true, data: [] } },
    { body: { ok: true, data: [] } }, { body: { ok: true, data: [] } },
    { body: { ok: true, data: { id: "scan-1" } } },
  ]);
  const input = previewInput();
  await client.loadDiscountStatus();
  await client.loadDiscountShops();
  await client.createDiscountPreview(input);
  await client.loadDiscountPreview("plan 1");
  await client.loadDiscountPreviewItems("plan/1", { cursor: 2, pageSize: 25, shopId: "9", status: "UNKNOWN", code: "AUTH" });
  await client.approveDiscountPreview({ planId: "plan-1", merkleRoot: "root", operatorName: "运营", confirmationText: "确认" });
  await client.executeDiscountPreview({ planId: "plan-1", merkleRoot: "root" });
  await client.loadDiscountRuns({ status: "RUNNING", planId: "plan-1", limit: 10 });
  await client.loadDiscountActivities({ shopId: "9", status: "ACTIVE", limit: 20 });
  await client.loadDiscountIssues({ planId: "plan-1", code: "UNKNOWN", limit: 30 });
  await client.requestDiscountScan("TH", ["9"]);

  assert.deepEqual(calls.map(({ url, method }) => [url, method]), [
    ["/api/shopee-discount/status", "GET"], ["/api/shopee-discount/shops", "GET"],
    ["/api/shopee-discount/previews", "POST"], ["/api/shopee-discount/previews/plan%201", "GET"],
    ["/api/shopee-discount/previews/plan%2F1/items?cursor=2&pageSize=25&shopId=9&status=UNKNOWN&code=AUTH", "GET"],
    ["/api/shopee-discount/previews/plan-1/approve", "POST"], ["/api/shopee-discount/previews/plan-1/execute", "POST"],
    ["/api/shopee-discount/runs?status=RUNNING&planId=plan-1&limit=10", "GET"],
    ["/api/shopee-discount/activities?shopId=9&status=ACTIVE&limit=20", "GET"],
    ["/api/shopee-discount/issues?planId=plan-1&code=UNKNOWN&limit=30", "GET"], ["/api/shopee-discount/scans", "POST"],
  ]);
  assert.deepEqual(JSON.parse(calls[2].body), input);
  assert.deepEqual(JSON.parse(calls[5].body), { planId: "plan-1", merkleRoot: "root", operatorName: "运营", confirmationText: "确认" });
  assert.deepEqual(JSON.parse(calls[6].body), { planId: "plan-1", merkleRoot: "root" });
  assert.deepEqual(JSON.parse(calls[10].body), { country: "TH", shopIds: ["9"] });
  assert.ok(calls.filter(({ method }) => method === "POST").every(({ headers }) => headers.get("content-type") === "application/json"));
});

test("typed client preserves the backend shop, activity and issue response contract", async () => {
  const client = await import(clientUrl.href);
  installBrowserDoubles([
    { body: { ok: true, data: [{ shopId: "9", country: "TH", name: "Bangkok Home", healthy: true }] } },
    { body: { ok: true, data: [{ id: "a1", planId: "p1", shopId: "9", activityType: "NEXT_RENEWAL", platformActivityId: "88", startsAt: "2026-08-01T00:00:00.000Z", endsAt: "2026-08-15T00:00:00.000Z", status: "ACTIVE", metadata: {} }] } },
    { body: { ok: true, data: [{ id: "e1", planId: "p1", jobId: "j1", eventType: "EXECUTION_ISSUE", code: "SHOPEE_AUTH_ERROR", evidence: {}, occurredAt: "2026-08-14T00:00:00.000Z" }] } },
  ]);
  const [shops, activities, issues] = await Promise.all([
    client.loadDiscountShops(), client.loadDiscountActivities(), client.loadDiscountIssues(),
  ]);
  assert.equal(shops[0].name, "Bangkok Home");
  assert.equal(activities[0].startsAt, "2026-08-01T00:00:00.000Z");
  assert.equal(activities[0].endsAt, "2026-08-15T00:00:00.000Z");
  assert.equal(issues[0].occurredAt, "2026-08-14T00:00:00.000Z");
});

test("client surfaces safe API failures", async () => {
  const client = await import(clientUrl.href);
  installBrowserDoubles([{ status: 409, body: { ok: false, code: "SHOPEE_DISCOUNT_APPROVAL_CHANGED", error: "方案已经改变" } }]);
  await assert.rejects(client.loadDiscountStatus(), (error) => {
    assert.equal(error.name, "ApiError");
    assert.equal(error.status, 409);
    assert.equal(error.message, "方案已经改变");
    return true;
  });
});

test("preview input key changes for every request field that can affect scope, hash or renewal window", async () => {
  const { discountPreviewInputKey } = await import(clientUrl.href);
  const base = previewInput();
  const variants = [
    { ...base, country: "SG" }, { ...base, shopIds: ["9"], useDefaultShops: false },
    { ...base, workflow: "CURRENT_CORRECTION", renewal: undefined }, { ...base, defaultTier: "EVENT" },
    { ...base, shopOverrides: [{ shopId: "9", priceTier: "MEGA" }] },
    { ...base, linkOverrides: [{ shopId: "9", itemId: "88", priceTier: "EVENT" }] },
    { ...base, activitySelection: [{ shopId: "9", discountId: "77", priceTier: "DAILY" }] },
    { ...base, category: "灯具" },
    { ...base, renewal: { requestedStartAt: "2026-08-16T00:00:00.000Z", durationDays: 30 } },
  ];
  for (const variant of variants) assert.notEqual(discountPreviewInputKey(variant), discountPreviewInputKey(base));
});

test("page uses backend field names, one request fingerprint and accessible fail-closed controls", () => {
  const page = read("frontend/commerce-ops-vue/src/pages/ShopeeDiscountPage.vue");
  const router = read("frontend/commerce-ops-vue/src/router/index.ts");
  const sidebar = read("frontend/commerce-ops-vue/src/components/OpsSidebar.vue");
  assert.match(router, /path: "\/shopee-discount"/);
  assert.match(sidebar, /path: "\/shopee-discount", label: "折扣控价"/);
  for (const text of ["discountPreviewInputKey", ".name", ".endsAt", ".occurredAt", "输入完整确认语句", "异常与 UNKNOWN 协调", "续期提醒"]) assert.ok(page.includes(text), `missing ${text}`);
  assert.match(page, /watch\(previewRequestKey, resetPlan\)/);
  assert.match(page, /:disabled="!canApprove"/);
  assert.match(page, /:disabled="!canExecute"/);
  assert.match(page, /aria-live="polite"/);
  assert.match(page, /role="alert"/);
  assert.match(page, /@media \(max-width:/);
});
