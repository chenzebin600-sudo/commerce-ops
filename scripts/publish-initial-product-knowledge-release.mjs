import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "../lib/env.mjs";
import {
  planSharedKnowledgePackage,
  readSharedKnowledgeCandidates,
  stableKnowledgeJson,
} from "../lib/product-knowledge/shared-knowledge-package.mjs";

export const INITIAL_RELEASE_CONTRACT = "PK_INITIAL_SUPPORT_RELEASE_SELECTION_V1";
export const INITIAL_RELEASE_KEY = "customer-service-knowledge";
export const INITIAL_RELEASE_CONSUMER_SCOPE = "CUSTOMER_SERVICE";
export const INITIAL_RELEASE_CONFIRMATION = "PUBLISH_CUSTOMER_SERVICE_KNOWLEDGE_23";
export const INITIAL_RELEASE_SELECTION_COUNT = 23;

const ALLOWED_INSTALLATION_TEXTS = new Set([
  "仅外部螺丝,不需要视频",
  "整装,无需安装",
]);
const URL_OR_MARKUP = /(?:https?:\/\/|www\.|youtu(?:\.be|be\.com)|<\/?[a-z]|\b[a-z0-9-]+\.(?:com|cn|net|org|co|io|me)(?:\b|\/))/i;
const ACTOR_ID = /^[A-Za-z0-9._:@-]{1,120}$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function controlledError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function arrayEquals(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((item, index) => item === right[index]);
}

function normalizedRiskFlags(candidate) {
  return Array.isArray(candidate?.governance?.risk_flags)
    ? candidate.governance.risk_flags.map(String).filter(Boolean)
    : [];
}

function isForbiddenUrlOrMarkup(value) {
  return URL_OR_MARKUP.test(String(value || ""));
}

function isInitialInstallationClaim(candidate, excludedSkus) {
  const text = String(candidate?.content?.text || "").trim();
  const rawRisk = String(candidate?.governance?.risk_level || "").trim().toUpperCase();
  return candidate?.assetType === "PRODUCT_KNOWLEDGE_CLAIM_CANDIDATE"
    && candidate?.targetDomain === "PRODUCT_KNOWLEDGE"
    && candidate?.candidateStatus === "REVIEW_REQUIRED"
    && String(candidate?.governance?.status || "").trim().toUpperCase() === "REVIEW_REQUIRED"
    && candidate?.riskLevel === "NORMAL"
    && rawRisk === "NORMAL"
    && normalizedRiskFlags(candidate).length === 0
    && candidate?.mappingStatus === "EXACT_STOCK_SKU_TO_MODEL"
    && Boolean(candidate?.productModelId)
    && Boolean(candidate?.sourceSku)
    && !excludedSkus.has(candidate.sourceSku)
    && candidate?.scopeType === "COUNTRY_OVERRIDE"
    && arrayEquals(candidate?.countries, ["MY"])
    && Array.isArray(candidate?.consumers)
    && candidate.consumers.includes("CUSTOMER_SERVICE")
    && Array.isArray(candidate?.scope?.consumer_scopes)
    && candidate.scope.consumer_scopes.includes("CUSTOMER_SERVICE")
    && String(candidate?.scope?.visibility || "").toUpperCase() === "CUSTOMER_VISIBLE"
    && String(candidate?.content?.claim_type || "").toUpperCase() === "INSTALLATION"
    && ALLOWED_INSTALLATION_TEXTS.has(text)
    && !isForbiddenUrlOrMarkup(text)
    && candidate?.sourceSheet === "马来";
}

function selectionRecord(candidate) {
  return Object.freeze({
    candidateId: candidate.id,
    assetId: candidate.assetId,
    contentDigest: candidate.contentDigest,
    sourceSku: candidate.sourceSku,
    productModelId: candidate.productModelId,
    productSkuId: candidate.productSkuId || null,
    canonicalCategoryName: candidate.canonicalCategoryName,
    claimType: "INSTALLATION",
    text: String(candidate.content.text).trim(),
    countryCode: "MY",
    languageCode: candidate.languageCode || "zh-CN",
    sourceId: candidate.sourceId,
    sourceSha256: candidate.sourceSha256,
    sourceSheet: candidate.sourceSheet,
    sourceLocation: candidate.sourceLocation,
  });
}

function digestSelection({ packageDigest, candidates }) {
  return sha256(stableKnowledgeJson({
    contractVersion: INITIAL_RELEASE_CONTRACT,
    packageDigest,
    releaseKey: INITIAL_RELEASE_KEY,
    consumerScope: INITIAL_RELEASE_CONSUMER_SCOPE,
    candidates,
  }));
}

function assertUniqueSelection(candidates) {
  for (const field of ["candidateId", "assetId", "sourceSku", "productModelId"]) {
    const values = candidates.map((candidate) => candidate[field]);
    if (new Set(values).size !== values.length) {
      throw controlledError("PK_INITIAL_SELECTION_DUPLICATE", `Initial selection contains duplicate ${field}`);
    }
  }
}

function assertSafeSelectionRecord(candidate) {
  if (!candidate?.candidateId?.startsWith("pkc_") || !candidate?.assetId?.startsWith("claim_")) {
    throw controlledError("PK_INITIAL_SELECTION_INVALID", "Initial selection contains an invalid claim identity");
  }
  if (!candidate.productModelId || !candidate.sourceSku || candidate.claimType !== "INSTALLATION") {
    throw controlledError("PK_INITIAL_SELECTION_INVALID", "Initial selection requires an exact product-bound installation claim");
  }
  if (!/^[a-f0-9]{64}$/.test(String(candidate.contentDigest || ""))
    || !/^[a-fA-F0-9]{64}$/.test(String(candidate.sourceSha256 || ""))) {
    throw controlledError("PK_INITIAL_SELECTION_INVALID", "Initial selection requires immutable content and source digests");
  }
  if (candidate.countryCode !== "MY" || !ALLOWED_INSTALLATION_TEXTS.has(candidate.text)
    || isForbiddenUrlOrMarkup(candidate.text)) {
    throw controlledError("PK_INITIAL_SELECTION_FORBIDDEN_CONTENT", "Initial selection contains non-MY, URL, markup, or unapproved text");
  }
}

export async function planInitialProductKnowledgeRelease(packageDir) {
  const packagePlan = await planSharedKnowledgePackage(packageDir);
  const claims = [];
  const excludedSkus = new Set();
  for await (const candidate of readSharedKnowledgeCandidates(packagePlan, { now: "1970-01-01T00:00:00.000Z" })) {
    if (["PRODUCT_FACT_CONFLICT_CANDIDATE", "COUNTRY_DIFFERENCE_CANDIDATE"].includes(candidate.assetType)
      && candidate.sourceSku) {
      excludedSkus.add(candidate.sourceSku);
    }
    if (candidate.assetType === "PRODUCT_KNOWLEDGE_CLAIM_CANDIDATE") claims.push(candidate);
  }
  const candidates = claims
    .filter((candidate) => isInitialInstallationClaim(candidate, excludedSkus))
    .map(selectionRecord)
    .sort((left, right) => left.assetId.localeCompare(right.assetId));
  if (candidates.length !== INITIAL_RELEASE_SELECTION_COUNT) {
    throw controlledError(
      "PK_INITIAL_SELECTION_COUNT_MISMATCH",
      `Controlled initial selection requires exactly ${INITIAL_RELEASE_SELECTION_COUNT} claims; found ${candidates.length}`,
    );
  }
  assertUniqueSelection(candidates);
  candidates.forEach(assertSafeSelectionRecord);
  const selectionDigest = digestSelection({ packageDigest: packagePlan.packageDigest, candidates });
  return Object.freeze({
    mode: "PLAN_ONLY",
    contractVersion: INITIAL_RELEASE_CONTRACT,
    package: packagePlan.packageName,
    packageRoot: packagePlan.root,
    packageDigest: packagePlan.packageDigest,
    selectionDigest,
    selectionCount: candidates.length,
    releaseKey: INITIAL_RELEASE_KEY,
    consumerScope: INITIAL_RELEASE_CONSUMER_SCOPE,
    selectionPolicy: Object.freeze({
      assetType: "PRODUCT_KNOWLEDGE_CLAIM_CANDIDATE",
      claimType: "INSTALLATION",
      countryCode: "MY",
      riskLevel: "NORMAL",
      mappingStatus: "EXACT_STOCK_SKU_TO_MODEL",
      requiresSingleProductModel: true,
      excludedConflictAndCountryDifferenceSkus: true,
      allowedTexts: [...ALLOWED_INSTALLATION_TEXTS],
      urlsMarkupPoliciesPlaybooksAccessoriesSellingPointsAllowed: false,
    }),
    candidates,
    productionMutationPerformed: false,
  });
}

function validateActor(value, name) {
  const actor = String(value || "").trim();
  if (!ACTOR_ID.test(actor)) {
    throw controlledError("PK_INITIAL_ACTOR_INVALID", `${name} must be a non-empty safe actor identifier`);
  }
  return actor;
}

function localBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value || "http://127.0.0.1:3101"));
  } catch {
    throw controlledError("PK_INITIAL_API_URL_INVALID", "Local Product Knowledge API URL is invalid");
  }
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname) || url.username || url.password
    || url.search || url.hash || !["", "/"].includes(url.pathname)) {
    throw controlledError("PK_INITIAL_API_URL_FORBIDDEN", "Apply is restricted to a loopback HTTP API base URL");
  }
  return url.toString().replace(/\/$/, "");
}

function assertPlanIntegrity(plan) {
  if (plan?.contractVersion !== INITIAL_RELEASE_CONTRACT
    || plan?.releaseKey !== INITIAL_RELEASE_KEY
    || plan?.consumerScope !== INITIAL_RELEASE_CONSUMER_SCOPE
    || plan?.selectionCount !== INITIAL_RELEASE_SELECTION_COUNT
    || !Array.isArray(plan?.candidates) || plan.candidates.length !== INITIAL_RELEASE_SELECTION_COUNT) {
    throw controlledError("PK_INITIAL_PLAN_INVALID", "Initial release plan does not match the controlled contract");
  }
  assertUniqueSelection(plan.candidates);
  plan.candidates.forEach(assertSafeSelectionRecord);
  for (const candidate of plan.candidates) {
    const expectedCandidateId = `pkc_${sha256(`${plan.packageDigest}\n${candidate.assetId}`).slice(0, 40)}`;
    if (candidate.candidateId !== expectedCandidateId) {
      throw controlledError("PK_INITIAL_CANDIDATE_ID_INVALID", "Candidate identity does not match the confirmed package digest");
    }
  }
  const expected = digestSelection({ packageDigest: plan.packageDigest, candidates: plan.candidates });
  if (expected !== plan.selectionDigest) {
    throw controlledError("PK_INITIAL_SELECTION_DIGEST_INVALID", "Initial release plan selection digest is invalid");
  }
}

async function responseJson(response, pathname) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.ok === false) {
    throw controlledError(
      String(body?.code || "PK_INITIAL_API_REQUEST_FAILED"),
      `${pathname} returned HTTP ${response.status}: ${String(body?.error || "request failed").slice(0, 500)}`,
    );
  }
  return body;
}

function apiClient({ baseUrl, accessToken = "", fetchImpl = fetch, timeoutMs = 30_000 }) {
  const token = String(accessToken || "").trim();
  return async function api(pathname, { method = "GET", actor = null, body = null } = {}) {
    const headers = { accept: "application/json" };
    if (actor) headers["x-user-id"] = actor;
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== null) headers["content-type"] = "application/json";
    const response = await fetchImpl(`${baseUrl}${pathname}`, {
      method,
      headers,
      body: body === null ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return responseJson(response, pathname);
  };
}

function apiCandidateMatches(candidate, expected) {
  return candidate?.id === expected.candidateId
    && candidate?.assetId === expected.assetId
    && candidate?.assetType === "PRODUCT_KNOWLEDGE_CLAIM_CANDIDATE"
    && candidate?.targetDomain === "PRODUCT_KNOWLEDGE"
    && candidate?.status === "REVIEW_REQUIRED"
    && candidate?.mappingStatus === "EXACT_STOCK_SKU_TO_MODEL"
    && candidate?.riskLevel === "NORMAL"
    && candidate?.productModelId === expected.productModelId
    && candidate?.sourceSku === expected.sourceSku
    && candidate?.contentDigest === expected.contentDigest
    && candidate?.scopeType === "COUNTRY_OVERRIDE"
    && arrayEquals(candidate?.countries, ["MY"])
    && Array.isArray(candidate?.consumerScopes)
    && candidate.consumerScopes.includes("CUSTOMER_SERVICE")
    && String(candidate?.scope?.visibility || "").toUpperCase() === "CUSTOMER_VISIBLE"
    && String(candidate?.content?.claim_type || "").toUpperCase() === "INSTALLATION"
    && String(candidate?.content?.text || "").trim() === expected.text
    && ALLOWED_INSTALLATION_TEXTS.has(expected.text)
    && !isForbiddenUrlOrMarkup(expected.text);
}

async function preflightCandidates(api, plan) {
  const found = new Map();
  const pageSize = 200;
  for (let offset = 0; offset < 100_000; offset += pageSize) {
    const query = new URLSearchParams({
      status: "REVIEW_REQUIRED",
      target_domain: "PRODUCT_KNOWLEDGE",
      risk_level: "NORMAL",
      limit: String(pageSize),
      offset: String(offset),
    });
    const response = await api(`/api/product-knowledge/candidates?${query}`);
    const page = Array.isArray(response.candidates) ? response.candidates : [];
    for (const candidate of page) {
      if (found.has(candidate.id)) {
        throw controlledError("PK_INITIAL_API_CANDIDATE_DUPLICATE", "Candidate pagination returned a duplicate identity");
      }
      found.set(candidate.id, candidate);
    }
    if (page.length < pageSize) break;
    if (offset + pageSize >= 100_000) {
      throw controlledError("PK_INITIAL_API_CANDIDATE_LIMIT", "Candidate preflight exceeded the bounded pagination limit");
    }
  }
  for (const expected of plan.candidates) {
    const candidate = found.get(expected.candidateId);
    if (!candidate || !apiCandidateMatches(candidate, expected)) {
      throw controlledError(
        "PK_INITIAL_API_CANDIDATE_MISMATCH",
        `Imported candidate does not match the reviewed package plan: ${expected.candidateId}`,
      );
    }
  }
}

function verifyReleaseIdentity(release, { expectedStatus, reviewer = null, publisher = null }) {
  if (!release?.id || release.key !== INITIAL_RELEASE_KEY
    || release.consumerScope !== INITIAL_RELEASE_CONSUMER_SCOPE
    || release.status !== expectedStatus
    || !release.contentDigest
    || (reviewer && release.createdBy !== reviewer)
    || (publisher && release.publishedBy !== publisher)) {
    throw controlledError("PK_INITIAL_RELEASE_RESPONSE_INVALID", `API returned an invalid ${expectedStatus} initial release`);
  }
}

function verifyReleaseCounts(release, { expectedStatus, releaseId }) {
  verifyReleaseIdentity(release, { expectedStatus });
  if (release.id !== releaseId
    || Number(release.counts?.claims) !== INITIAL_RELEASE_SELECTION_COUNT
    || Number(release.counts?.accessories || 0) !== 0
    || Number(release.counts?.policies || 0) !== 0
    || Number(release.counts?.playbooks || 0) !== 0) {
    throw controlledError("PK_INITIAL_RELEASE_MEMBERSHIP_INVALID", "Initial release membership is not exactly 23 claims");
  }
}

async function loadReleaseWithCounts(api, { releaseId, status }) {
  const response = await api(
    `/api/product-knowledge/releases?consumer_scope=CUSTOMER_SERVICE&status=${encodeURIComponent(status)}&limit=200`,
  );
  const releases = Array.isArray(response.releases) ? response.releases : [];
  const release = releases.find((item) => item.id === releaseId);
  if (!release) throw controlledError("PK_INITIAL_RELEASE_NOT_OBSERVABLE", `Created release is not visible as ${status}`);
  verifyReleaseCounts(release, { expectedStatus: status, releaseId });
  return release;
}

export async function applyInitialProductKnowledgeRelease(plan, options = {}, dependencies = {}) {
  assertPlanIntegrity(plan);
  if (String(options.confirmPackageDigest || "") !== plan.packageDigest) {
    throw controlledError("PK_INITIAL_PACKAGE_CONFIRMATION_REQUIRED", `Apply requires --confirm-package-digest=${plan.packageDigest}`);
  }
  if (String(options.confirmSelectionDigest || "") !== plan.selectionDigest) {
    throw controlledError("PK_INITIAL_SELECTION_CONFIRMATION_REQUIRED", `Apply requires --confirm-selection-digest=${plan.selectionDigest}`);
  }
  if (String(options.confirmRelease || "") !== INITIAL_RELEASE_CONFIRMATION) {
    throw controlledError("PK_INITIAL_RELEASE_CONFIRMATION_REQUIRED", `Apply requires --confirm-release=${INITIAL_RELEASE_CONFIRMATION}`);
  }
  const reviewer = validateActor(options.reviewer, "reviewer");
  const publisher = validateActor(options.publisher, "publisher");
  if (reviewer.toLowerCase() === publisher.toLowerCase()) {
    throw controlledError("PK_INITIAL_ACTOR_SEPARATION_REQUIRED", "Reviewer and publisher must be different identities");
  }
  const baseUrl = localBaseUrl(options.baseUrl);
  const api = apiClient({
    baseUrl,
    accessToken: options.accessToken,
    fetchImpl: dependencies.fetchImpl,
    timeoutMs: dependencies.timeoutMs,
  });

  const statusResponse = await api("/api/product-knowledge/status");
  const status = statusResponse.status || {};
  if (status.ready !== true || status.governance?.enabled !== true
    || status.governance?.reviewerAllowlistConfigured !== true
    || status.governance?.publisherAllowlistConfigured !== true) {
    throw controlledError("PK_INITIAL_GOVERNANCE_NOT_READY", "Product Knowledge migration and separated governance allowlists must be ready");
  }
  await preflightCandidates(api, plan);
  const releasesResponse = await api("/api/product-knowledge/releases?consumer_scope=CUSTOMER_SERVICE&limit=200");
  if ((releasesResponse.releases || []).length >= 200) {
    throw controlledError("PK_INITIAL_RELEASE_PREFLIGHT_INCOMPLETE", "Release preflight reached its bounded result limit");
  }
  if ((releasesResponse.releases || []).some((release) => release.key === INITIAL_RELEASE_KEY)) {
    throw controlledError("PK_INITIAL_RELEASE_ALREADY_EXISTS", `Release key ${INITIAL_RELEASE_KEY} already exists`);
  }

  const reviews = [];
  let releaseId = null;
  let mutationMayHaveOccurred = false;
  try {
    for (const candidate of plan.candidates) {
      mutationMayHaveOccurred = true;
      const response = await api(
        `/api/product-knowledge/candidates/${encodeURIComponent(candidate.candidateId)}/reviews`,
        {
          method: "POST",
          actor: reviewer,
          body: {
            action: "APPROVE",
            expectedContentDigest: candidate.contentDigest,
            reviewerRoles: ["PRODUCT_KNOWLEDGE_REVIEWER"],
            reasonCode: "INITIAL_SUPPORT_INSTALLATION_CLAIM",
            comment: `Controlled initial selection ${plan.selectionDigest}`,
            scope: {
              scopeType: "COUNTRY_OVERRIDE",
              countries: ["MY"],
              languageCode: candidate.languageCode,
              consumerScopes: ["CUSTOMER_SERVICE"],
              visibility: "CUSTOMER_VISIBLE",
            },
          },
        },
      );
      if (response.candidate?.status !== "APPROVED" || response.approvedEntity?.type !== "CLAIM"
        || !response.reviewId) {
        throw controlledError("PK_INITIAL_REVIEW_RESPONSE_INVALID", `Candidate review was not durably approved: ${candidate.candidateId}`);
      }
      reviews.push({ candidateId: candidate.candidateId, reviewId: response.reviewId });
    }

    const createResponse = await api("/api/product-knowledge/releases", {
      method: "POST",
      actor: reviewer,
      body: {
        consumerScope: INITIAL_RELEASE_CONSUMER_SCOPE,
        releaseKey: INITIAL_RELEASE_KEY,
        candidateIds: plan.candidates.map((candidate) => candidate.candidateId),
        notes: `Controlled initial MY installation claims; package=${plan.packageDigest}; selection=${plan.selectionDigest}`,
      },
    });
    if (createResponse.duplicate === true) {
      throw controlledError("PK_INITIAL_RELEASE_DUPLICATE", "Initial release creation unexpectedly returned a duplicate");
    }
    verifyReleaseIdentity(createResponse.release, { expectedStatus: "DRAFT", reviewer });
    releaseId = createResponse.release.id;
    await loadReleaseWithCounts(api, { releaseId, status: "DRAFT" });

    mutationMayHaveOccurred = true;
    const publishResponse = await api(
      `/api/product-knowledge/releases/${encodeURIComponent(createResponse.release.id)}/publish`,
      {
        method: "POST",
        actor: publisher,
        body: {
          expectedContentDigest: createResponse.release.contentDigest,
          acknowledgeHumanReview: true,
        },
      },
    );
    verifyReleaseIdentity(publishResponse.release, { expectedStatus: "PUBLISHED", reviewer, publisher });
    const publishedRelease = await loadReleaseWithCounts(api, { releaseId, status: "PUBLISHED" });
    return {
      ...plan,
      mode: "APPLY",
      baseUrl,
      reviewer,
      publisher,
      reviews,
      release: publishedRelease,
      productionMutationPerformed: true,
    };
  } catch (error) {
    error.productionMutationPerformed = reviews.length > 0 || Boolean(releaseId);
    error.productionMutationMayHaveOccurred = mutationMayHaveOccurred;
    error.completedReviewCount = reviews.length;
    error.releaseId = releaseId;
    throw error;
  }
}

function parseArguments(argv) {
  const allowedValues = new Set([
    "package", "url", "reviewer", "publisher", "confirm-package-digest",
    "confirm-selection-digest", "confirm-release",
  ]);
  const values = new Map();
  let apply = false;
  for (const argument of argv) {
    if (argument === "--apply") {
      if (apply) throw controlledError("PK_INITIAL_ARGUMENT_DUPLICATE", "--apply was provided more than once");
      apply = true;
      continue;
    }
    const match = argument.match(/^--([^=]+)=(.*)$/s);
    if (!match || !allowedValues.has(match[1])) {
      throw controlledError("PK_INITIAL_ARGUMENT_INVALID", `Unsupported argument: ${argument}`);
    }
    if (values.has(match[1])) throw controlledError("PK_INITIAL_ARGUMENT_DUPLICATE", `--${match[1]} was provided more than once`);
    values.set(match[1], match[2]);
  }
  const packageDir = String(values.get("package") || "").trim();
  if (!packageDir) {
    throw controlledError(
      "PK_INITIAL_PACKAGE_REQUIRED",
      "Usage: node scripts/publish-initial-product-knowledge-release.mjs --package=<directory> [--apply ...]",
    );
  }
  return {
    apply,
    packageDir,
    baseUrl: values.get("url") || "http://127.0.0.1:3101",
    reviewer: values.get("reviewer"),
    publisher: values.get("publisher"),
    confirmPackageDigest: values.get("confirm-package-digest"),
    confirmSelectionDigest: values.get("confirm-selection-digest"),
    confirmRelease: values.get("confirm-release"),
  };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArguments(argv);
  const plan = await planInitialProductKnowledgeRelease(options.packageDir);
  if (!options.apply) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return plan;
  }
  const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  loadLocalEnv(rootDir);
  const result = await applyInitialProductKnowledgeRelease(plan, {
    ...options,
    accessToken: env.APP_ACCESS_TOKEN || process.env.APP_ACCESS_TOKEN || "",
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: error?.code || "PK_INITIAL_RELEASE_FAILED",
      error: error instanceof Error ? error.message : String(error),
      productionMutationPerformed: error?.productionMutationPerformed === true,
      productionMutationMayHaveOccurred: error?.productionMutationMayHaveOccurred === true,
      completedReviewCount: Number(error?.completedReviewCount || 0),
      releaseId: error?.releaseId || null,
    }, null, 2)}\n`);
    process.exitCode = 1;
  });
}
