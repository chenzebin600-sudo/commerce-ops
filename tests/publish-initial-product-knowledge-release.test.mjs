import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  applyInitialProductKnowledgeRelease,
  INITIAL_RELEASE_CONFIRMATION,
  INITIAL_RELEASE_KEY,
  planInitialProductKnowledgeRelease,
} from "../scripts/publish-initial-product-knowledge-release.mjs";

const packageDir = path.resolve("outputs/shared-product-knowledge-20260808-001");
const planPromise = planInitialProductKnowledgeRelease(packageDir);
const expectedAssetIds = [
  "claim_01363fdcc945dc1ab8fa665c",
  "claim_042baa7ed70f65f5c22aab86",
  "claim_301ea9240c5d94dac039da20",
  "claim_62cbce3e966d45743d772278",
  "claim_6474d139f7d8a98bb62acd2d",
  "claim_6c015a25d7613417bff993be",
  "claim_77f3f8018f19faba688d5219",
  "claim_8c0c47ad4a9150db5d672b6f",
  "claim_99c15445309f6d37c2bdccab",
  "claim_9cf6d36eea33e2991b65d8a5",
  "claim_a4d99e0ef638607a14e3cab9",
  "claim_b67b188b8defdb12d7e788d2",
  "claim_ba293d3b588fc53a61f53819",
  "claim_ba76a2b2cf7d45b77f518ba5",
  "claim_bcd816eac71f53dcbdb05ab7",
  "claim_c2f9472c1e168196baa287ca",
  "claim_c5341980f2a866d198f24b2d",
  "claim_c9b79db87d6d11ed32869333",
  "claim_db2971f55d582364b1d66f4a",
  "claim_dc3d1d3dd156c7939039d37a",
  "claim_e362b8640df59aaf698ee4f1",
  "claim_f34c143d1caad264839f2981",
  "claim_fa9dd914912837fd5ce52750",
];

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function apiCandidate(candidate) {
  return {
    id: candidate.candidateId,
    assetId: candidate.assetId,
    assetType: "PRODUCT_KNOWLEDGE_CLAIM_CANDIDATE",
    targetDomain: "PRODUCT_KNOWLEDGE",
    status: "REVIEW_REQUIRED",
    mappingStatus: "EXACT_STOCK_SKU_TO_MODEL",
    riskLevel: "NORMAL",
    productModelId: candidate.productModelId,
    sourceSku: candidate.sourceSku,
    contentDigest: candidate.contentDigest,
    scopeType: "COUNTRY_OVERRIDE",
    countries: ["MY"],
    consumerScopes: ["CUSTOMER_SERVICE"],
    scope: { visibility: "CUSTOMER_VISIBLE" },
    content: { claim_type: "INSTALLATION", text: candidate.text },
  };
}

function controlledApi(plan, { failReviewAt = null, mismatchCandidate = false } = {}) {
  const calls = [];
  const state = { reviews: 0, draft: null, published: false };
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method || "GET";
    const actor = init.headers?.["x-user-id"] || null;
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, pathname: url.pathname, search: url.search, actor, body });

    if (method === "GET" && url.pathname === "/api/product-knowledge/status") {
      return jsonResponse({ ok: true, status: { ready: true, governance: {
        enabled: true, reviewerAllowlistConfigured: true, publisherAllowlistConfigured: true,
      } } });
    }
    if (method === "GET" && url.pathname === "/api/product-knowledge/candidates") {
      const offset = Number(url.searchParams.get("offset") || 0);
      if (offset) return jsonResponse({ ok: true, candidates: [] });
      const candidates = plan.candidates.map(apiCandidate);
      if (mismatchCandidate) candidates[0] = { ...candidates[0], contentDigest: "changed-after-plan" };
      return jsonResponse({ ok: true, candidates });
    }
    if (method === "GET" && url.pathname === "/api/product-knowledge/releases") {
      const requestedStatus = url.searchParams.get("status");
      if (!state.draft || (requestedStatus && requestedStatus !== (state.published ? "PUBLISHED" : "DRAFT"))) {
        return jsonResponse({ ok: true, releases: [] });
      }
      return jsonResponse({ ok: true, releases: [{
        ...state.draft,
        status: state.published ? "PUBLISHED" : "DRAFT",
        publishedBy: state.published ? "publisher-two" : null,
        counts: { claims: 23, accessories: 0, policies: 0, playbooks: 0 },
      }] });
    }
    const reviewMatch = url.pathname.match(/^\/api\/product-knowledge\/candidates\/([^/]+)\/reviews$/);
    if (method === "POST" && reviewMatch) {
      state.reviews += 1;
      if (failReviewAt === state.reviews) {
        return jsonResponse({ ok: false, code: "PK_TEST_REVIEW_FAILED", error: "fixture failure" }, 409);
      }
      assert.equal(actor, "reviewer-one");
      assert.equal(body.action, "APPROVE");
      assert.deepEqual(body.scope, {
        scopeType: "COUNTRY_OVERRIDE",
        countries: ["MY"],
        languageCode: "zh-CN",
        consumerScopes: ["CUSTOMER_SERVICE"],
        visibility: "CUSTOMER_VISIBLE",
      });
      return jsonResponse({ ok: true, candidate: { status: "APPROVED" },
        reviewId: `review-${state.reviews}`, approvedEntity: { type: "CLAIM" } });
    }
    if (method === "POST" && url.pathname === "/api/product-knowledge/releases") {
      assert.equal(actor, "reviewer-one");
      assert.equal(body.releaseKey, INITIAL_RELEASE_KEY);
      assert.equal(body.consumerScope, "CUSTOMER_SERVICE");
      assert.deepEqual(body.candidateIds, plan.candidates.map((candidate) => candidate.candidateId));
      state.draft = {
        id: "release-initial-1",
        key: INITIAL_RELEASE_KEY,
        consumerScope: "CUSTOMER_SERVICE",
        status: "DRAFT",
        contentDigest: "release-content-digest",
        createdBy: "reviewer-one",
        publishedBy: null,
      };
      return jsonResponse({ ok: true, duplicate: false, release: state.draft }, 201);
    }
    if (method === "POST" && url.pathname === "/api/product-knowledge/releases/release-initial-1/publish") {
      assert.equal(actor, "publisher-two");
      assert.deepEqual(body, { expectedContentDigest: "release-content-digest", acknowledgeHumanReview: true });
      state.published = true;
      return jsonResponse({ ok: true, release: {
        ...state.draft, status: "PUBLISHED", publishedBy: "publisher-two",
      } });
    }
    return jsonResponse({ ok: false, code: "PK_TEST_ROUTE_MISSING", error: `${method} ${url.pathname}` }, 404);
  };
  return { calls, state, fetchImpl };
}

function applyOptions(plan, overrides = {}) {
  return {
    confirmPackageDigest: plan.packageDigest,
    confirmSelectionDigest: plan.selectionDigest,
    confirmRelease: INITIAL_RELEASE_CONFIRMATION,
    reviewer: "reviewer-one",
    publisher: "publisher-two",
    baseUrl: "http://127.0.0.1:3101",
    ...overrides,
  };
}

test("plan-only deterministically selects exactly the 23 approved-shape MY text installation claims", async () => {
  const plan = await planPromise;
  assert.equal(plan.packageDigest, "1bc094f8f9458a978c2c9102bb36ce9ed5f119b16743ccbc176140bc5003881c");
  assert.equal(plan.selectionDigest, "f30c9c02f103e8ac661d2d1f435f33a94da832b798ec5c094b134e0e4a72c262");
  assert.equal(plan.selectionCount, 23);
  assert.equal(plan.productionMutationPerformed, false);
  assert.deepEqual(plan.candidates.map((candidate) => candidate.assetId), expectedAssetIds);
  assert.equal(new Set(plan.candidates.map((candidate) => candidate.candidateId)).size, 23);
  for (const candidate of plan.candidates) {
    assert.match(candidate.candidateId, /^pkc_[a-f0-9]{40}$/);
    assert.match(candidate.assetId, /^claim_/);
    assert.equal(candidate.claimType, "INSTALLATION");
    assert.equal(candidate.countryCode, "MY");
    assert.ok(["仅外部螺丝,不需要视频", "整装,无需安装"].includes(candidate.text));
    assert.doesNotMatch(candidate.text, /https?:|www\.|youtu|<\/?[a-z]/i);
  }
  assert.equal(plan.selectionPolicy.urlsMarkupPoliciesPlaybooksAccessoriesSellingPointsAllowed, false);
});

test("apply fails before HTTP without matching package, selection, release, and separated actors", async () => {
  const plan = await planPromise;
  const noHttp = async () => { throw new Error("HTTP must not be called"); };
  await assert.rejects(
    applyInitialProductKnowledgeRelease(plan, applyOptions(plan, { confirmPackageDigest: "wrong" }), { fetchImpl: noHttp }),
    (error) => error.code === "PK_INITIAL_PACKAGE_CONFIRMATION_REQUIRED",
  );
  await assert.rejects(
    applyInitialProductKnowledgeRelease(plan, applyOptions(plan, { confirmSelectionDigest: "wrong" }), { fetchImpl: noHttp }),
    (error) => error.code === "PK_INITIAL_SELECTION_CONFIRMATION_REQUIRED",
  );
  await assert.rejects(
    applyInitialProductKnowledgeRelease(plan, applyOptions(plan, { confirmRelease: "yes" }), { fetchImpl: noHttp }),
    (error) => error.code === "PK_INITIAL_RELEASE_CONFIRMATION_REQUIRED",
  );
  await assert.rejects(
    applyInitialProductKnowledgeRelease(plan, applyOptions(plan, { publisher: "reviewer-one" }), { fetchImpl: noHttp }),
    (error) => error.code === "PK_INITIAL_ACTOR_SEPARATION_REQUIRED",
  );
  await assert.rejects(
    applyInitialProductKnowledgeRelease(plan, applyOptions(plan, { baseUrl: "https://example.com" }), { fetchImpl: noHttp }),
    (error) => error.code === "PK_INITIAL_API_URL_FORBIDDEN",
  );
});

test("apply reviews all 23 over HTTP, creates only a CUSTOMER_SERVICE claim release, and publishes as another actor", async () => {
  const plan = await planPromise;
  const fixture = controlledApi(plan);
  const result = await applyInitialProductKnowledgeRelease(
    plan,
    applyOptions(plan),
    { fetchImpl: fixture.fetchImpl, timeoutMs: 2_000 },
  );
  assert.equal(result.productionMutationPerformed, true);
  assert.equal(result.reviews.length, 23);
  assert.equal(result.release.status, "PUBLISHED");
  assert.equal(result.release.key, INITIAL_RELEASE_KEY);
  assert.deepEqual(result.release.counts, { claims: 23, accessories: 0, policies: 0, playbooks: 0 });
  assert.equal(fixture.calls.filter((call) => call.pathname.endsWith("/reviews")).length, 23);
  assert.equal(fixture.calls.filter((call) => call.pathname === "/api/product-knowledge/releases" && call.method === "POST").length, 1);
  assert.equal(fixture.calls.filter((call) => call.pathname.endsWith("/publish")).length, 1);
});

test("candidate drift fails closed before any review or release write", async () => {
  const plan = await planPromise;
  const fixture = controlledApi(plan, { mismatchCandidate: true });
  await assert.rejects(
    applyInitialProductKnowledgeRelease(plan, applyOptions(plan), { fetchImpl: fixture.fetchImpl }),
    (error) => error.code === "PK_INITIAL_API_CANDIDATE_MISMATCH",
  );
  assert.equal(fixture.calls.some((call) => call.method === "POST"), false);
});

test("a review failure never creates or publishes a release and reports partial audit writes", async () => {
  const plan = await planPromise;
  const fixture = controlledApi(plan, { failReviewAt: 4 });
  await assert.rejects(
    applyInitialProductKnowledgeRelease(plan, applyOptions(plan), { fetchImpl: fixture.fetchImpl }),
    (error) => {
      assert.equal(error.code, "PK_TEST_REVIEW_FAILED");
      assert.equal(error.productionMutationPerformed, true);
      assert.equal(error.productionMutationMayHaveOccurred, true);
      assert.equal(error.completedReviewCount, 3);
      return true;
    },
  );
  assert.equal(fixture.calls.some((call) => call.pathname === "/api/product-knowledge/releases" && call.method === "POST"), false);
  assert.equal(fixture.calls.some((call) => call.pathname.endsWith("/publish")), false);
});
