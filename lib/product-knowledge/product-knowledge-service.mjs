import { createHash, randomUUID } from "node:crypto";
import { stableKnowledgeJson } from "./shared-knowledge-package.mjs";

const CANDIDATE_STATUSES = new Set([
  "DRAFT", "REVIEW_REQUIRED", "MAPPING_REQUIRED", "SOURCE_READ_REQUIRED", "CONFLICT", "APPROVED", "REJECTED",
]);
const TARGET_DOMAINS = new Set([
  "PRODUCT_CORE", "PRODUCT_KNOWLEDGE", "PRODUCT_MEDIA", "CUSTOMER_SERVICE_POLICY",
  "CUSTOMER_SERVICE_PLAYBOOK", "CUSTOMER_SERVICE_OPERATIONS", "GOVERNANCE",
]);
const REVIEW_ACTIONS = new Set([
  "APPROVE", "REJECT", "RETURN_FOR_MAPPING", "RETURN_FOR_SOURCE", "RETURN_FOR_CONFLICT",
]);
const CONSUMER_SCOPES = new Set(["CUSTOMER_SERVICE", "LISTING", "MARKETING", "INTERNAL"]);
const RELEASE_STATUSES = new Set(["DRAFT", "PUBLISHED", "RETIRED"]);
const VISIBILITIES = new Set([
  "CUSTOMER_VISIBLE", "CUSTOMER_VISIBLE_AFTER_POLICY_VALIDATION", "INTERNAL_ONLY",
]);
const APPROVABLE_ASSET_TYPES = new Set([
  "PRODUCT_KNOWLEDGE_CLAIM_CANDIDATE", "PRODUCT_ACCESSORY_RELATION_CANDIDATE",
  "SUPPORT_POLICY_CANDIDATE", "SUPPORT_PLAYBOOK_CANDIDATE",
]);

function serviceError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function enumValue(value, allowed, name) {
  const normalized = String(value || "").trim().toUpperCase();
  if (normalized && !allowed.has(normalized)) throw serviceError("PK_FILTER_INVALID", `${name} is invalid`);
  return normalized || null;
}

function optionalText(value, max = 300) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (text.length > max) throw serviceError("PK_INPUT_TOO_LONG", "Input is too long");
  return text;
}

function requiredText(value, name, max = 500) {
  const text = optionalText(value, max);
  if (!text) throw serviceError("PK_INPUT_REQUIRED", `${name} is required`);
  return text;
}

function uniqueStrings(value, { max = 50, upper = false } = {}) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean)
    .map((item) => upper ? item.toUpperCase() : item))].slice(0, max);
}

function digest(value) {
  return createHash("sha256").update(stableKnowledgeJson(value), "utf8").digest("hex");
}

function generatedId(prefix, createId) {
  return `${prefix}_${String(createId()).replaceAll("-", "")}`;
}

function setFrom(value) {
  return value instanceof Set ? value : new Set(uniqueStrings(value));
}

export function countPublishedCustomerServiceKnowledgeReleases(releases) {
  if (!Array.isArray(releases)) return 0;
  return releases
    .filter((item) => item?.status === "PUBLISHED" && item?.consumerScope === "CUSTOMER_SERVICE")
    .reduce((total, item) => total + Math.max(0, Number(item.total) || 0), 0);
}

function checkedTimestamp(value, name) {
  const text = optionalText(value, 60);
  if (text && !Number.isFinite(Date.parse(text))) throw serviceError("PK_EFFECTIVE_WINDOW_INVALID", `${name} is invalid`);
  return text;
}

export class ProductKnowledgeService {
  constructor({ repository, now = () => new Date(), createId = randomUUID, governance = {} } = {}) {
    if (!repository) throw new TypeError("Product-knowledge repository is required");
    this.repository = repository;
    this.now = now;
    this.createId = createId;
    this.governance = Object.freeze({
      enabled: governance.enabled === true,
      reviewerIds: setFrom(governance.reviewerIds),
      publisherIds: setFrom(governance.publisherIds),
    });
  }

  async status() {
    if (!await this.repository.isReady()) {
      return {
        ready: false,
        phase: "MIGRATION_REQUIRED",
        runtimeReadsPublishedOnly: true,
        offlineCandidatesTrustedForGeneration: false,
        governance: { enabled: false, reviewerAllowlistConfigured: false, publisherAllowlistConfigured: false },
        batches: [], candidates: [], releases: [],
      };
    }
    return {
      ready: true,
      phase: "CANDIDATE_REGISTRY_READY",
      runtimeReadsPublishedOnly: true,
      offlineCandidatesTrustedForGeneration: false,
      governance: {
        enabled: this.governance.enabled,
        reviewerAllowlistConfigured: this.governance.reviewerIds.size > 0,
        publisherAllowlistConfigured: this.governance.publisherIds.size > 0,
      },
      ...(await this.repository.statusSnapshot()),
    };
  }

  async listCandidates(filters = {}) {
    if (!await this.repository.isReady()) return [];
    return this.repository.listCandidates({
      status: enumValue(filters.status, CANDIDATE_STATUSES, "status"),
      targetDomain: enumValue(filters.targetDomain, TARGET_DOMAINS, "targetDomain"),
      riskLevel: enumValue(filters.riskLevel, new Set(["NORMAL", "SENSITIVE", "HIGH"]), "riskLevel"),
      limit: Math.min(200, Math.max(1, Number(filters.limit || 100))),
      offset: Math.max(0, Number(filters.offset || 0)),
    });
  }

  async resolveSupportKnowledge(input = {}) {
    if (!await this.repository.isReady()) return [];
    const countryCode = optionalText(input.countryCode, 12)?.toUpperCase() || null;
    return this.repository.searchPublished({
      productModelId: optionalText(input.productModelId, 120),
      productSkuId: optionalText(input.productSkuId, 120),
      categoryId: optionalText(input.categoryId, 120),
      countryCode,
      languageCode: optionalText(input.languageCode, 30),
      consumerScope: "CUSTOMER_SERVICE",
      keyword: optionalText(input.keyword, 500),
      now: this.now().toISOString(),
      limit: Math.min(50, Math.max(1, Number(input.limit || 20))),
    });
  }

  async resolveSupportBundle(input = {}) {
    if (!await this.repository.isReady()) {
      return { claims: [], accessories: [], policies: [], playbooks: [] };
    }
    const productModelId = optionalText(input.productModelId, 120);
    const productSkuId = optionalText(input.productSkuId, 120);
    const countryCode = optionalText(input.countryCode, 12)?.toUpperCase() || null;
    const now = this.now().toISOString();
    const limit = Math.min(50, Math.max(1, Number(input.limit || 20)));
    const [claims, accessories, policies, playbooks] = await Promise.all([
      this.repository.searchPublished({
        productModelId,
        productSkuId,
        categoryId: optionalText(input.categoryId, 120),
        countryCode,
        languageCode: optionalText(input.languageCode, 30),
        consumerScope: "CUSTOMER_SERVICE",
        keyword: optionalText(input.keyword, 500),
        now,
        limit,
      }),
      this.repository.searchPublishedAccessories({ productModelId, productSkuId, countryCode, now, limit }),
      this.repository.searchPublishedPolicies({
        categoryName: optionalText(input.categoryName, 300), countryCode, now, limit,
      }),
      this.repository.searchPublishedPlaybooks({ productModelId, countryCode, now, limit }),
    ]);
    return { claims, accessories, policies, playbooks };
  }

  ensureActor(actorId, capability) {
    if (!this.governance.enabled) {
      throw serviceError("PK_GOVERNANCE_DISABLED", "Knowledge governance writes are disabled", 403);
    }
    const actor = requiredText(actorId, "actorId", 120);
    const allowlist = capability === "publish" ? this.governance.publisherIds : this.governance.reviewerIds;
    if (!allowlist.size || !allowlist.has(actor)) {
      throw serviceError("PK_GOVERNANCE_ACTOR_FORBIDDEN", `Actor is not allowed to ${capability} knowledge`, 403);
    }
    return actor;
  }

  reviewScope(candidate, input = {}) {
    const scopeType = String(input.scopeType || candidate.scopeType || "").trim().toUpperCase();
    if (!new Set(["COMMON", "COUNTRY_OVERRIDE"]).has(scopeType)) {
      throw serviceError("PK_SCOPE_UNVERIFIED", "A reviewed COMMON or COUNTRY_OVERRIDE scope is required");
    }
    const countries = uniqueStrings(input.countries ?? candidate.countries, { upper: true, max: 20 });
    if (scopeType === "COMMON" && countries.length) {
      throw serviceError("PK_SCOPE_INVALID", "COMMON knowledge cannot include country overrides");
    }
    if (scopeType === "COUNTRY_OVERRIDE" && !countries.length) {
      throw serviceError("PK_SCOPE_INVALID", "COUNTRY_OVERRIDE knowledge requires at least one country");
    }
    const languageCode = optionalText(input.languageCode || candidate.languageCode || "zh-CN", 30) || "zh-CN";
    const consumers = uniqueStrings(input.consumerScopes ?? candidate.consumerScopes, { upper: true, max: 4 });
    const effectiveConsumers = candidate.assetType.startsWith("SUPPORT_") ? ["CUSTOMER_SERVICE"] : consumers;
    if (!effectiveConsumers.length || effectiveConsumers.some((value) => !CONSUMER_SCOPES.has(value))) {
      throw serviceError("PK_CONSUMER_SCOPE_INVALID", "At least one valid consumer scope is required");
    }
    const visibility = String(input.visibility || candidate.scope?.visibility || "").trim().toUpperCase();
    if (!VISIBILITIES.has(visibility)) throw serviceError("PK_VISIBILITY_INVALID", "Reviewed visibility is required");
    const effectiveFrom = checkedTimestamp(input.effectiveFrom, "effectiveFrom");
    const effectiveUntil = checkedTimestamp(input.effectiveUntil, "effectiveUntil");
    if (effectiveFrom && effectiveUntil && Date.parse(effectiveFrom) >= Date.parse(effectiveUntil)) {
      throw serviceError("PK_EFFECTIVE_WINDOW_INVALID", "effectiveUntil must be after effectiveFrom");
    }
    const countryValues = scopeType === "COMMON" ? [null] : countries;
    return {
      scopeType,
      countries,
      languageCode,
      consumerScopes: effectiveConsumers,
      visibility,
      effectiveFrom,
      effectiveUntil,
      scopes: countryValues.flatMap((countryCode) => effectiveConsumers.map((consumerScope) => ({
        scopeType, countryCode, languageCode, consumerScope, visibility, effectiveFrom, effectiveUntil,
      }))),
    };
  }

  async reviewCandidate(candidateId, input = {}, { actorId } = {}) {
    const actor = this.ensureActor(actorId, "review");
    const candidate = await this.repository.getCandidate(requiredText(candidateId, "candidateId", 160));
    if (!candidate) throw serviceError("PK_CANDIDATE_NOT_FOUND", "Candidate was not found", 404);
    const action = String(input.action || "").trim().toUpperCase();
    if (!REVIEW_ACTIONS.has(action)) throw serviceError("PK_REVIEW_ACTION_INVALID", "Review action is invalid");
    const expectedContentDigest = requiredText(input.expectedContentDigest, "expectedContentDigest", 128);
    if (action === "APPROVE" && candidate.status !== "REVIEW_REQUIRED") {
      throw serviceError("PK_CANDIDATE_NOT_APPROVABLE", "Only REVIEW_REQUIRED candidates can be approved");
    }
    if (action === "APPROVE" && !APPROVABLE_ASSET_TYPES.has(candidate.assetType)) {
      throw serviceError("PK_CANDIDATE_DOMAIN_HANDOFF_REQUIRED", "This candidate must be reviewed in its owning domain");
    }
    const reviewerRoles = uniqueStrings(input.reviewerRoles, { upper: true, max: 20 });
    if (action === "APPROVE" && candidate.riskLevel !== "NORMAL"
      && (input.acknowledgeRisk !== true || !reviewerRoles.includes("COMPLIANCE_REVIEWER"))) {
      throw serviceError("PK_RISK_ACKNOWLEDGEMENT_REQUIRED", "Sensitive knowledge requires compliance acknowledgement");
    }
    const reviewedScope = action === "APPROVE" ? this.reviewScope(candidate, input.scope || {}) : { scopes: [] };
    const needsProduct = action === "APPROVE" && [
      "PRODUCT_KNOWLEDGE_CLAIM_CANDIDATE", "PRODUCT_ACCESSORY_RELATION_CANDIDATE", "SUPPORT_PLAYBOOK_CANDIDATE",
    ].includes(candidate.assetType);
    const identity = needsProduct ? await this.repository.getProductIdentity(candidate) : null;
    if (needsProduct && !identity?.productModelId && !identity?.productSkuId) {
      throw serviceError("PK_PRODUCT_MAPPING_REQUIRED", "An exact Product Core model or SKU mapping is required");
    }
    if (action === "APPROVE"
      && ["PRODUCT_ACCESSORY_RELATION_CANDIDATE", "SUPPORT_POLICY_CANDIDATE", "SUPPORT_PLAYBOOK_CANDIDATE"].includes(candidate.assetType)
      && reviewedScope.scopeType === "COUNTRY_OVERRIDE" && reviewedScope.countries.length !== 1) {
      throw serviceError("PK_SCOPE_CARDINALITY_INVALID", "This knowledge type requires exactly one reviewed country override");
    }
    const content = candidate.content || {};
    const subjectKey = identity?.productSkuId || identity?.productModelId || candidate.canonicalCategoryName || "unmapped";
    const countryKey = reviewedScope.scopeType === "COMMON" ? "COMMON" : reviewedScope.countries.join("+");
    const reviewId = generatedId("pkrv", this.createId);
    const entityId = generatedId("pke", this.createId);
    let entity = { reviewId };
    if (action === "APPROVE" && candidate.assetType === "PRODUCT_KNOWLEDGE_CLAIM_CANDIDATE") {
      const claimType = requiredText(content.claim_type, "claim_type", 80).toUpperCase();
      entity = {
        reviewId,
        id: entityId,
        key: `claim_${digest([subjectKey, claimType, content.title || "", countryKey]).slice(0, 40)}`,
        claimType,
        title: optionalText(content.title, 500),
        text: requiredText(content.text, "claim text", 20_000),
        structured: content.structured && typeof content.structured === "object" ? content.structured : {},
        productModelId: identity.productModelId,
        productSkuId: identity.productSkuId,
        categoryId: identity.categoryId,
      };
    } else if (action === "APPROVE" && candidate.assetType === "PRODUCT_ACCESSORY_RELATION_CANDIDATE") {
      const accessorySkuCode = requiredText(content.accessory_sku, "accessory_sku", 300);
      entity = {
        reviewId,
        id: entityId,
        key: `accessory_${digest([subjectKey, accessorySkuCode, countryKey]).slice(0, 40)}`,
        productModelId: identity.productModelId,
        productSkuId: identity.productSkuId,
        accessorySkuCode,
        accessoryProductSkuId: null,
        countryCode: reviewedScope.countries[0] || null,
        payload: { ...content, reviewedScope },
      };
    } else if (action === "APPROVE" && candidate.assetType === "SUPPORT_POLICY_CANDIDATE") {
      entity = {
        reviewId,
        id: entityId,
        key: `policy_${digest([candidate.canonicalCategoryName, content.issue_category, content.issue, countryKey]).slice(0, 40)}`,
        countryCode: reviewedScope.countries[0] || null,
        categoryName: optionalText(input.scope?.categoryName, 300) || candidate.canonicalCategoryName,
        payload: { ...content, reviewedScope, riskLevel: candidate.riskLevel },
        effectiveFrom: reviewedScope.effectiveFrom,
        effectiveUntil: reviewedScope.effectiveUntil,
      };
    } else if (action === "APPROVE" && candidate.assetType === "SUPPORT_PLAYBOOK_CANDIDATE") {
      entity = {
        reviewId,
        id: entityId,
        key: `playbook_${digest([subjectKey, content.intent, content.question, countryKey]).slice(0, 40)}`,
        intentCode: optionalText(content.intent, 120),
        countryCode: reviewedScope.countries[0] || null,
        productModelId: identity.productModelId,
        payload: { ...content, reviewedScope, riskLevel: candidate.riskLevel },
        effectiveFrom: reviewedScope.effectiveFrom,
        effectiveUntil: reviewedScope.effectiveUntil,
      };
    }
    return this.repository.reviewCandidate({
      candidateId: candidate.id,
      action,
      reviewerId: actor,
      reviewerRoles,
      reasonCode: optionalText(input.reasonCode, 120),
      comment: optionalText(input.comment, 2000),
      expectedContentDigest,
      reviewedScope,
      entity,
      now: this.now().toISOString(),
    });
  }

  async listReleases(filters = {}) {
    if (!await this.repository.isReady()) return [];
    return this.repository.listReleases({
      consumerScope: enumValue(filters.consumerScope, CONSUMER_SCOPES, "consumerScope"),
      status: enumValue(filters.status, RELEASE_STATUSES, "status"),
      limit: Math.min(200, Math.max(1, Number(filters.limit || 100))),
    });
  }

  async createRelease(input = {}, { actorId } = {}) {
    const actor = this.ensureActor(actorId, "review");
    const consumerScope = enumValue(input.consumerScope, CONSUMER_SCOPES, "consumerScope");
    if (!consumerScope) throw serviceError("PK_CONSUMER_SCOPE_INVALID", "consumerScope is required");
    const candidateIds = uniqueStrings(input.candidateIds, { max: 500 });
    if (!candidateIds.length) throw serviceError("PK_RELEASE_EMPTY", "At least one approved candidate is required");
    const items = [];
    for (const candidateId of candidateIds) {
      const entity = await this.repository.getApprovedEntityForCandidate(candidateId);
      if (!entity) throw serviceError("PK_RELEASE_CANDIDATE_INVALID", `Candidate ${candidateId} is not approved`);
      if (consumerScope !== "CUSTOMER_SERVICE" && ["POLICY", "PLAYBOOK"].includes(entity.type)) {
        throw serviceError("PK_RELEASE_SCOPE_MISMATCH", "Support policy and playbook can only enter CUSTOMER_SERVICE releases");
      }
      items.push(entity);
    }
    const contentDigest = digest({ consumerScope, items: items.map((item) => [item.type, item.id, item.contentDigest]) });
    const releaseKey = optionalText(input.releaseKey, 160) || `${consumerScope.toLowerCase()}-knowledge`;
    const now = this.now().toISOString();
    const effectiveFrom = checkedTimestamp(input.effectiveFrom, "effectiveFrom");
    const effectiveUntil = checkedTimestamp(input.effectiveUntil, "effectiveUntil");
    if (effectiveFrom && effectiveUntil && Date.parse(effectiveFrom) >= Date.parse(effectiveUntil)) {
      throw serviceError("PK_EFFECTIVE_WINDOW_INVALID", "effectiveUntil must be after effectiveFrom");
    }
    return this.repository.createRelease({
      release: {
        id: generatedId("pkrel", this.createId),
        key: releaseKey,
        consumerScope,
        contentDigest,
        notes: optionalText(input.notes, 2000),
        createdBy: actor,
        createdAt: now,
        effectiveFrom,
        effectiveUntil,
      },
      items,
    });
  }

  async publishRelease(releaseId, input = {}, { actorId } = {}) {
    const actor = this.ensureActor(actorId, "publish");
    if (input.acknowledgeHumanReview !== true) {
      throw serviceError("PK_RELEASE_CONFIRMATION_REQUIRED", "Explicit human review confirmation is required");
    }
    const release = await this.repository.publishRelease({
      id: requiredText(releaseId, "releaseId", 160),
      expectedContentDigest: requiredText(input.expectedContentDigest, "expectedContentDigest", 128),
      publishedBy: actor,
      now: this.now().toISOString(),
    });
    if (!release) throw serviceError("PK_RELEASE_NOT_FOUND", "Release was not found", 404);
    return release;
  }
}
