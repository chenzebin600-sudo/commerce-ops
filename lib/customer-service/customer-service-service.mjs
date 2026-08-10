import { createHash, randomUUID } from "node:crypto";
import {
  buildCustomerServiceAccountRollout,
  evaluateCustomerServiceAutomationTransition,
} from "./customer-service-rollout.mjs";
import { decryptSecret, encryptSecret } from "../mabang-scheduler/crypto.mjs";
import { buildFillDraftPayload, parseDraftRoute } from "./customer-service-draft-command.mjs";
import { evaluateCustomerServiceReply } from "./customer-service-reply-quality-gate.mjs";
import {
  measureCustomerServiceReviewEdit,
  normalizeCustomerServiceReviewReason,
} from "./customer-service-review-quality.mjs";

const WORKER_STATUSES = new Set(["ONLINE", "DEGRADED"]);
const DIRECTIONS = new Set(["INBOUND", "OUTBOUND", "SYSTEM"]);
const PRIORITIES = new Set(["LOW", "NORMAL", "HIGH", "URGENT"]);
const AUTOMATION_MODES = new Set(["OBSERVE_ONLY", "SUGGEST_ONLY", "DRAFT_FILL"]);
const REVIEW_ACTIONS = new Set(["ACCEPT", "EDIT", "REJECT"]);
const QUALITY_DIMENSIONS = new Set(["country", "category", "intent", "risk", "account", "shop", "model"]);
const ROLLOUT_ERROR_MESSAGES = Object.freeze({
  CS_AUTOMATION_TRANSITION_INVALID: "Account automation must be enabled one stage at a time",
  CS_REPLY_AGENT_NOT_CONFIGURED: "Customer-service Reply Agent is not configured",
  CS_AI_ROLLOUT_DISABLED: "Global customer-service AI generation is disabled",
  CS_PRODUCT_KNOWLEDGE_NOT_READY: "Product Knowledge migration is not ready",
  CS_SUPPORT_KNOWLEDGE_RELEASE_REQUIRED: "Publish at least one reviewed SUPPORT Knowledge Release before enabling suggestions",
  CS_ACCOUNT_ACTIVE_REQUIRED: "The LiaoLiao account must be active before automation is enabled",
  CS_ACCOUNT_OBSERVATION_REQUIRED: "Observe at least one inbound message on an active account before enabling AI suggestions",
  CS_DRAFT_FILL_DISABLED: "Global customer-service Draft Fill is disabled",
  CS_SUGGESTION_GENERATION_REQUIRED: "Generate at least one suggestion before enabling Draft Fill",
  CS_SUGGESTION_REVIEW_REQUIRED: "Accept or edit at least one generated suggestion before enabling Draft Fill",
});

function serviceError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function requiredText(value, name, maxLength = 500) {
  const text = String(value ?? "").trim();
  if (!text) throw serviceError("CS_INPUT_REQUIRED", `${name} is required`);
  if (text.length > maxLength) throw serviceError("CS_INPUT_TOO_LONG", `${name} is too long`);
  return text;
}

function optionalText(value, maxLength = 500) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (text.length > maxLength) throw serviceError("CS_INPUT_TOO_LONG", "Input is too long");
  return text;
}

function normalizedIso(value, name) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw serviceError("CS_TIMESTAMP_INVALID", `${name} is invalid`);
  return parsed.toISOString();
}

function plainObject(value, name) {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw serviceError("CS_INPUT_INVALID", `${name} must be an object`);
  }
  return value;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function limitedArray(value, max = 50) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, max).map((item) => String(item || "").trim().slice(0, 100)).filter(Boolean);
}

function uniqueFlags(values) {
  return [...new Set(values.map((item) => String(item || "").trim().toUpperCase()).filter(Boolean))].slice(0, 50);
}

function publicError(error) {
  if (String(error?.code || "").startsWith("CS_")) return error;
  return serviceError("CS_OPERATION_FAILED", "Customer-service operation failed", 500);
}

export class CustomerServiceService {
  constructor({
    repository,
    encryptText = encryptSecret,
    decryptText = decryptSecret,
    identityPepper = process.env.CUSTOMER_SERVICE_IDENTITY_PEPPER || process.env.APP_ENCRYPTION_KEY || "",
    now = () => new Date(),
    createId = () => randomUUID(),
    commerceShopFacade = null,
    accountLeaseTtlMs = 90_000,
  } = {}) {
    if (!repository) throw new TypeError("Customer-service repository is required");
    if (typeof encryptText !== "function" || typeof decryptText !== "function") {
      throw new TypeError("Customer-service encryption functions are required");
    }
    this.repository = repository;
    this.encryptText = encryptText;
    this.decryptText = decryptText;
    this.identityPepper = String(identityPepper || "");
    this.now = now;
    this.createId = createId;
    this.commerceShopFacade = commerceShopFacade;
    this.accountLeaseTtlMs = Math.min(5 * 60_000, Math.max(30_000, Number(accountLeaseTtlMs) || 90_000));
    this.replyAutomationStatus = () => ({ enabled: false, configured: false, draftFillEnabled: false });
    this.knowledgeReadinessProvider = async () => ({ ready: false, publishedSupportReleaseTotal: 0 });
  }

  configureReplyAutomation(statusProvider) {
    if (typeof statusProvider !== "function") throw new TypeError("Reply automation status provider is required");
    this.replyAutomationStatus = statusProvider;
  }

  configureKnowledgeReadiness(statusProvider) {
    if (typeof statusProvider !== "function") throw new TypeError("Product Knowledge readiness provider is required");
    this.knowledgeReadinessProvider = statusProvider;
  }

  async rolloutContext() {
    const knowledge = await this.knowledgeReadinessProvider();
    return {
      ...this.replyAutomationStatus(),
      knowledge: {
        ready: knowledge?.ready === true,
        publishedSupportReleaseTotal: Math.max(0, Number(knowledge?.publishedSupportReleaseTotal || 0)),
      },
    };
  }

  timestamp() {
    return this.now().toISOString();
  }

  digest(scope, value) {
    if (!this.identityPepper) {
      throw serviceError(
        "CS_IDENTITY_PEPPER_REQUIRED",
        "Customer-service identity protection is not configured",
        503,
      );
    }
    const text = String(value ?? "");
    return createHash("sha256")
      .update(`${this.identityPepper}\n${scope}\n${text}`, "utf8")
      .digest("hex");
  }

  async status() {
    const ready = await this.repository.isReady();
    const replyAutomation = this.replyAutomationStatus();
    const rolloutContext = await this.rolloutContext();
    if (!ready) {
      return {
        ready: false,
        phase: "MIGRATION_REQUIRED",
        humanConfirmationRequired: true,
        automaticSendEnabled: false,
        identityProtectionConfigured: Boolean(this.identityPepper),
        accounts: {},
        workers: [],
        conversations: {},
        suggestions: {},
        commands: {},
        accountLeases: [],
        quality: {
          generatedTotal: 0,
          averageConfidence: null,
          belowThresholdTotal: 0,
          minimumAutoFillConfidence: Number(replyAutomation.minimumAutoFillConfidence || 0.72),
          reviewedTotal: 0,
          reviews: {},
          reviewReasons: {},
          averageEditRatio: null,
          majorEditTotal: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          observedOutboundTotal: 0,
          matchedAiDraftSendTotal: 0,
          exactAiDraftShare: null,
          firstResponseSampleTotal: 0,
          firstResponseP50Ms: null,
          firstResponseP95Ms: null,
          explicitHandledTotal: 0,
          explicitHandledRate: null,
          handlingSampleTotal: 0,
          handlingP50Ms: null,
          handlingP95Ms: null,
        },
        replyAutomation,
        dependencies: { productKnowledge: rolloutContext.knowledge },
      };
    }
    const snapshot = await this.repository.statusSnapshot({
      minimumConfidence: replyAutomation.minimumAutoFillConfidence,
    });
    const nowMs = this.now().getTime();
    return {
      ready: true,
      phase: "CONTROL_PLANE_READY",
      humanConfirmationRequired: true,
      automaticSendEnabled: false,
      identityProtectionConfigured: Boolean(this.identityPepper),
      replyAutomation,
      dependencies: { productKnowledge: rolloutContext.knowledge },
      ...snapshot,
      workers: snapshot.workers.map((worker) => {
        const heartbeat = Date.parse(worker.lastHeartbeatAt || "");
        const online = Number.isFinite(heartbeat) && nowMs - heartbeat <= 90_000
          && WORKER_STATUSES.has(worker.status);
        return { ...worker, online };
      }),
    };
  }

  async qualityBreakdown(filters = {}) {
    if (!await this.repository.isReady()) {
      throw serviceError("CS_SCHEMA_NOT_READY", "Customer-service database migration is not applied", 503);
    }
    const dimension = String(filters.dimension || "intent").trim().toLowerCase();
    if (!QUALITY_DIMENSIONS.has(dimension)) {
      throw serviceError("CS_QUALITY_DIMENSION_INVALID", "Quality dimension must be country, category, intent, risk, account, shop or model");
    }
    const automation = this.replyAutomationStatus();
    return {
      dimension,
      minimumAutoFillConfidence: Number(automation.minimumAutoFillConfidence || 0.72),
      rows: await this.repository.qualityBreakdown({
        dimension,
        accountId: optionalText(filters.accountId, 120),
        minimumConfidence: automation.minimumAutoFillConfidence,
        limit: Math.min(100, Math.max(1, Number(filters.limit || 20))),
      }),
    };
  }

  async createAccount(raw) {
    if (!await this.repository.isReady()) {
      throw serviceError("CS_SCHEMA_NOT_READY", "Customer-service database migration is not applied", 503);
    }
    const input = plainObject(raw, "account");
    const displayName = requiredText(input.displayName, "displayName", 120);
    const externalAccountKey = optionalText(input.externalAccountKey, 500);
    const now = this.timestamp();
    const account = await this.repository.createAccount({
      id: this.createId(),
      channel: String(input.channel || "LIAOLIAO").trim().toUpperCase(),
      displayName,
      externalAccountKeyDigest: externalAccountKey ? this.digest("account", externalAccountKey) : null,
      status: "SETUP_REQUIRED",
      settings: {
        countryCodes: limitedArray(input.countryCodes, 20).map((item) => item.toUpperCase()),
        languageCodes: limitedArray(input.languageCodes, 20),
        automationMode: "OBSERVE_ONLY",
      },
      now,
    });
    const readiness = await this.repository.accountRolloutReadiness(account.id);
    return this.accountWithRollout(readiness, await this.rolloutContext());
  }

  async listAccounts() {
    if (!await this.repository.isReady()) return [];
    const [readiness, rolloutContext] = await Promise.all([
      this.repository.listAccountRolloutReadiness(),
      this.rolloutContext(),
    ]);
    return readiness.map((item) => this.accountWithRollout(item, rolloutContext));
  }

  accountWithRollout(readiness, rolloutContext) {
    if (!readiness?.account) return null;
    return {
      ...readiness.account,
      rollout: buildCustomerServiceAccountRollout(readiness, rolloutContext),
    };
  }

  async updateAccountAutomation(accountId, raw, actorId) {
    if (!await this.repository.isReady()) {
      throw serviceError("CS_SCHEMA_NOT_READY", "Customer-service database migration is not applied", 503);
    }
    const input = plainObject(raw, "account automation");
    const mode = requiredText(input.mode, "mode", 40).toUpperCase();
    if (!AUTOMATION_MODES.has(mode)) {
      throw serviceError("CS_AUTOMATION_MODE_INVALID", "Automation mode must be OBSERVE_ONLY, SUGGEST_ONLY or DRAFT_FILL");
    }
    const id = requiredText(accountId, "accountId", 120);
    const readiness = await this.repository.accountRolloutReadiness(id);
    if (!readiness) return null;
    const storedMode = String(readiness.account.settings?.automationMode || "OBSERVE_ONLY").toUpperCase();
    const currentMode = AUTOMATION_MODES.has(storedMode) ? storedMode : "OBSERVE_ONLY";
    const rolloutContext = await this.rolloutContext();
    if (mode === currentMode) return this.accountWithRollout(readiness, rolloutContext);
    const transition = evaluateCustomerServiceAutomationTransition({
      readiness,
      automation: rolloutContext,
      targetMode: mode,
    });
    if (!transition.allowed) {
      const code = transition.blockers[0];
      throw serviceError(code, ROLLOUT_ERROR_MESSAGES[code] || "Account automation rollout is not ready", 409);
    }
    await this.repository.updateAccountAutomation({
      id,
      mode,
      actorId: requiredText(actorId || "local-user", "actorId", 120),
      now: this.timestamp(),
    });
    return this.accountWithRollout(await this.repository.accountRolloutReadiness(id), rolloutContext);
  }

  async registerWorker(workerId, raw) {
    const input = plainObject(raw, "worker");
    return this.repository.registerWorker({
      id: requiredText(workerId, "workerId", 120),
      displayName: requiredText(input.displayName || workerId, "displayName", 120),
      version: optionalText(input.version, 80),
      capabilities: limitedArray(input.capabilities, 30),
      metadata: {
        os: optionalText(input.metadata?.os, 80),
        browser: optionalText(input.metadata?.browser, 80),
        integration: "liaoliao-playwright",
      },
      now: this.timestamp(),
    });
  }

  async heartbeatWorker(workerId, raw) {
    const input = plainObject(raw, "heartbeat");
    const requestedStatus = String(input.status || "ONLINE").trim().toUpperCase();
    if (!WORKER_STATUSES.has(requestedStatus)) {
      throw serviceError("CS_WORKER_STATUS_INVALID", "Worker status must be ONLINE or DEGRADED");
    }
    return this.repository.heartbeatWorker({
      id: requiredText(workerId, "workerId", 120),
      status: requestedStatus,
      version: optionalText(input.version, 80),
      capabilities: Array.isArray(input.capabilities) ? limitedArray(input.capabilities, 30) : null,
      lastErrorCode: optionalText(input.lastErrorCode, 120),
      metadata: input.metadata ? {
        activeAccounts: Number(input.metadata.activeAccounts || 0),
        openPages: Number(input.metadata.openPages || 0),
        queueDepth: Number(input.metadata.queueDepth || 0),
      } : null,
      now: this.timestamp(),
    });
  }

  async acquireAccountLease(workerId, accountId, raw = {}) {
    const input = plainObject(raw, "account lease");
    const normalizedWorkerId = requiredText(workerId, "workerId", 120);
    const normalizedAccountId = requiredText(accountId, "accountId", 120);
    const presentedToken = optionalText(input.leaseToken, 500);
    const leaseToken = presentedToken || this.createId();
    const now = this.now();
    const result = await this.repository.acquireAccountLease({
      accountId: normalizedAccountId,
      workerId: normalizedWorkerId,
      presentedTokenDigest: presentedToken ? this.digest("account-lease", presentedToken) : null,
      leaseTokenDigest: this.digest("account-lease", leaseToken),
      now: now.toISOString(),
      leasedUntil: new Date(now.getTime() + this.accountLeaseTtlMs).toISOString(),
    });
    if (!result.acquired) {
      const error = serviceError(
        "CS_ACCOUNT_LEASE_CONFLICT",
        "Another browser worker currently owns this LiaoLiao account lease",
        409,
      );
      error.retryAfter = result.leasedUntil || null;
      throw error;
    }
    return { ...result.lease, renewed: result.renewed === true, leaseToken };
  }

  async assertAccountLease(workerId, accountId, leaseToken) {
    const normalizedWorkerId = requiredText(workerId, "workerId", 120);
    const normalizedAccountId = requiredText(accountId, "accountId", 120);
    const normalizedToken = requiredText(leaseToken, "leaseToken", 500);
    const lease = await this.repository.validateAccountLease({
      accountId: normalizedAccountId,
      workerId: normalizedWorkerId,
      leaseTokenDigest: this.digest("account-lease", normalizedToken),
      now: this.timestamp(),
    });
    if (!lease) {
      throw serviceError("CS_ACCOUNT_LEASE_INVALID", "Browser account lease is missing, expired or invalid", 409);
    }
    return lease;
  }

  async releaseAccountLease(workerId, accountId, leaseToken) {
    const normalizedWorkerId = requiredText(workerId, "workerId", 120);
    const normalizedAccountId = requiredText(accountId, "accountId", 120);
    const normalizedToken = requiredText(leaseToken, "leaseToken", 500);
    return this.repository.releaseAccountLease({
      accountId: normalizedAccountId,
      workerId: normalizedWorkerId,
      leaseTokenDigest: this.digest("account-lease", normalizedToken),
      now: this.timestamp(),
    });
  }

  normalizeEvent(workerId, raw) {
    const event = plainObject(raw, "event");
    const eventKeySource = requiredText(event.eventId || event.eventKey, "eventId", 300);
    const sequenceNo = Number(event.sequenceNo);
    if (!Number.isSafeInteger(sequenceNo) || sequenceNo < 0) {
      throw serviceError("CS_SEQUENCE_INVALID", "sequenceNo must be a non-negative integer");
    }
    const observedAt = normalizedIso(event.observedAt || this.timestamp(), "observedAt");
    const accountId = requiredText(event.accountId, "accountId", 120);
    const conversation = plainObject(event.conversation, "conversation");
    const message = plainObject(event.message, "message");
    const externalConversationId = requiredText(conversation.externalId, "conversation.externalId", 500);
    const customerExternalId = requiredText(
      conversation.customerExternalId || conversation.customerDisplayName,
      "conversation.customerExternalId",
      500,
    );
    const customerDisplayName = requiredText(
      conversation.customerDisplayName || "Unknown customer",
      "conversation.customerDisplayName",
      300,
    );
    const direction = String(message.direction || "INBOUND").trim().toUpperCase();
    if (!DIRECTIONS.has(direction)) throw serviceError("CS_MESSAGE_DIRECTION_INVALID", "Message direction is invalid");
    const content = String(message.content ?? "").trim();
    if (!content && String(message.contentType || "TEXT").toUpperCase() === "TEXT") {
      throw serviceError("CS_MESSAGE_CONTENT_REQUIRED", "Text message content is required");
    }
    if (content.length > 100_000) throw serviceError("CS_MESSAGE_TOO_LARGE", "Message content is too large", 413);
    const sentAt = normalizedIso(message.sentAt || observedAt, "message.sentAt");
    const externalMessageId = optionalText(message.externalId, 500)
      || `${externalConversationId}\n${direction}\n${sentAt}\n${content}`;
    const priority = String(conversation.priority || "NORMAL").trim().toUpperCase();
    if (!PRIORITIES.has(priority)) throw serviceError("CS_PRIORITY_INVALID", "Conversation priority is invalid");
    const shop = event.shop && typeof event.shop === "object" ? event.shop : null;
    const panel = event.panelSnapshot && typeof event.panelSnapshot === "object" ? event.panelSnapshot : null;
    const payloadDigest = this.digest("event-payload", stableJson(event));
    return {
      now: this.timestamp(),
      event: {
        id: this.createId(),
        eventKey: this.digest("event-key", `${workerId}\n${eventKeySource}`),
        workerId,
        accountId,
        sequenceNo,
        eventType: String(event.eventType || "MESSAGE_OBSERVED").trim().toUpperCase(),
        payloadDigest,
        observedAt,
      },
      conversation: {
        id: this.createId(),
        externalConversationDigest: this.digest("conversation", `${accountId}\n${externalConversationId}`),
        routingCiphertext: this.encryptText(stableJson({
          externalConversationId,
          customerExternalId,
          customerDisplayName,
          shopExternalId: shop ? requiredText(shop.externalId || shop.name, "shop.externalId", 500) : null,
          shopName: shop ? requiredText(shop.name, "shop.name", 200) : null,
        })),
        customerExternalDigest: this.digest("customer", `${accountId}\n${customerExternalId}`),
        customerDisplayCiphertext: this.encryptText(customerDisplayName),
        priority,
      },
      message: {
        id: this.createId(),
        externalMessageDigest: this.digest("message", `${accountId}\n${externalMessageId}`),
        routingCiphertext: this.encryptText(stableJson({ externalMessageId })),
        direction,
        contentType: String(message.contentType || "TEXT").trim().toUpperCase().slice(0, 40),
        contentCiphertext: this.encryptText(content),
        contentDigest: this.digest("message-content", content),
        sentAt,
      },
      shop: shop ? {
        id: this.createId(),
        externalShopKeyDigest: this.digest(
          "shop",
          `${accountId}\n${requiredText(shop.externalId || shop.name, "shop.externalId", 500)}`,
        ),
        shopName: requiredText(shop.name, "shop.name", 200),
        countryCode: optionalText(shop.countryCode, 12)?.toUpperCase() || null,
      } : null,
      observationId: this.createId(),
      observation: {
        source: "PLAYWRIGHT",
        unread: Boolean(event.observation?.unread),
        domVersion: optionalText(event.observation?.domVersion, 80),
      },
      panel: panel ? {
        id: this.createId(),
        snapshotCiphertext: this.encryptText(stableJson(panel)),
        snapshotDigest: this.digest("panel", stableJson(panel)),
        completeness: {
          order: Boolean(panel.order),
          logistics: Boolean(panel.logistics),
          product: Boolean(panel.product),
        },
      } : null,
      suggestionId: direction === "INBOUND" ? this.createId() : null,
    };
  }

  async ingestBatch(workerId, raw, scope = {}) {
    const input = plainObject(raw, "batch");
    if (!Array.isArray(input.events) || !input.events.length) {
      throw serviceError("CS_EVENTS_REQUIRED", "events must contain at least one item");
    }
    if (input.events.length > 200) throw serviceError("CS_BATCH_TOO_LARGE", "A batch can contain at most 200 events", 413);
    const expectedAccountId = optionalText(scope.accountId, 120);
    if (expectedAccountId && input.events.some((event) => String(event?.accountId || "").trim() !== expectedAccountId)) {
      throw serviceError("CS_ACCOUNT_LEASE_SCOPE_MISMATCH", "Every event must belong to the leased LiaoLiao account", 403);
    }
    const results = [];
    for (let index = 0; index < input.events.length; index += 1) {
      try {
        const normalized = this.normalizeEvent(workerId, input.events[index]);
        results.push({ index, ok: true, ...(await this.repository.ingestObservation(normalized)) });
      } catch (error) {
        const safe = publicError(error);
        results.push({ index, ok: false, code: safe.code, error: safe.message, status: safe.status });
      }
    }
    return {
      accepted: results.filter((item) => item.ok).length,
      rejected: results.filter((item) => !item.ok).length,
      results,
    };
  }

  decryptOptional(value) {
    return value ? this.decryptText(value) : null;
  }

  async listInbox(filters = {}) {
    if (!await this.repository.isReady()) return [];
    const status = String(filters.status || "OPEN").trim().toUpperCase();
    if (!new Set(["OPEN", "HANDLED", "ARCHIVED", "ALL"]).has(status)) {
      throw serviceError("CS_INBOX_STATUS_INVALID", "Inbox status is invalid");
    }
    const limit = Math.min(200, Math.max(1, Number(filters.limit || 100)));
    const rows = await this.repository.listInbox({
      accountId: optionalText(filters.accountId, 120),
      status,
      limit,
    });
    return rows.map((row) => ({
      ...row,
      customerDisplayName: this.decryptOptional(row.customerDisplayCiphertext),
      customerDisplayCiphertext: undefined,
      latestMessage: row.latestContentCiphertext ? {
        content: this.decryptOptional(row.latestContentCiphertext),
        contentType: row.latestContentType,
      } : null,
      latestContentCiphertext: undefined,
      latestContentType: undefined,
      suggestion: row.suggestion ? {
        ...row.suggestion,
        draft: this.decryptOptional(row.suggestion.draftCiphertext),
        draftCiphertext: undefined,
      } : null,
    }));
  }

  async getConversation(id) {
    if (!await this.repository.isReady()) return null;
    const result = await this.repository.getConversation(requiredText(id, "conversationId", 120));
    if (!result) return null;
    const conversation = {
      ...result.conversation,
      customerDisplayName: this.decryptOptional(result.conversation.customerDisplayCiphertext),
      customerDisplayCiphertext: undefined,
    };
    const messages = result.messages.map((message) => ({
      ...message,
      content: this.decryptOptional(message.contentCiphertext),
      contentCiphertext: undefined,
    }));
    const suggestions = result.suggestions.map((suggestion) => ({
      ...suggestion,
      draft: this.decryptOptional(suggestion.draftCiphertext),
      draftCiphertext: undefined,
    }));
    const evidence = result.evidence.map((item) => ({
      ...item,
      excerpt: this.decryptOptional(item.excerptCiphertext),
      excerptCiphertext: undefined,
    }));
    return { conversation, messages, suggestions, evidence, sendActions: result.sendActions || [] };
  }

  async markHandled(conversationId, actorId) {
    return this.repository.markHandled({
      conversationId: requiredText(conversationId, "conversationId", 120),
      actorId: requiredText(actorId || "local-user", "actorId", 120),
      actionId: this.createId(),
      now: this.timestamp(),
    });
  }

  async queueReply(conversationId, actorId) {
    return this.repository.queueReplySuggestion({
      id: this.createId(),
      conversationId: requiredText(conversationId, "conversationId", 120),
      actorId: requiredText(actorId || "local-user", "actorId", 120),
      now: this.timestamp(),
    });
  }

  async reviewSuggestion(suggestionId, raw, actorId) {
    const input = plainObject(raw, "suggestion review");
    let action = requiredText(input.action, "action", 20).toUpperCase();
    if (!REVIEW_ACTIONS.has(action)) {
      throw serviceError("CS_REVIEW_ACTION_INVALID", "Review action must be ACCEPT, EDIT or REJECT");
    }
    const suggestion = await this.repository.getSuggestionForReview(requiredText(suggestionId, "suggestionId", 120));
    if (!suggestion) return null;
    if (!new Set(["READY", "ACCEPTED", "EDITED"]).has(suggestion.status)) {
      throw serviceError("CS_SUGGESTION_NOT_REVIEWABLE", "Suggestion is not ready for review", 409);
    }
    if (suggestion.triggerMessageId !== suggestion.currentInboundMessageId) {
      throw serviceError("CS_SUGGESTION_STALE", "A newer inbound message has replaced this suggestion", 409);
    }
    const currentDraft = this.decryptOptional(suggestion.draftCiphertext) || "";
    const suppliedText = input.finalText === undefined || input.finalText === null
      ? null
      : String(input.finalText).trim();
    if (suppliedText !== null && suppliedText.length > 8_000) {
      throw serviceError("CS_INPUT_TOO_LONG", "Reviewed reply is too long");
    }
    if (action === "EDIT" && !suppliedText) {
      throw serviceError("CS_REVIEW_TEXT_REQUIRED", "Edited reply text is required");
    }
    if (action === "ACCEPT" && suppliedText && suppliedText !== currentDraft) action = "EDIT";
    const finalText = action === "EDIT" ? suppliedText : currentDraft;
    let reasonCode;
    try {
      reasonCode = normalizeCustomerServiceReviewReason(action, input.reasonCode);
    } catch (error) {
      throw serviceError(error.code || "CS_REVIEW_REASON_INVALID", error.message, 400);
    }
    const editMetric = action === "EDIT"
      ? measureCustomerServiceReviewEdit(currentDraft, finalText)
      : null;
    const queueFill = input.queueFill === true;
    if (action === "REJECT" && queueFill) {
      throw serviceError("CS_REJECTED_DRAFT_NOT_FILLABLE", "A rejected suggestion cannot be filled");
    }
    let reviewContext = {};
    if (suggestion.contextCiphertext) {
      try { reviewContext = JSON.parse(this.decryptText(suggestion.contextCiphertext)); } catch { reviewContext = {}; }
    }
    const existingHighRisk = suggestion.qualityFlags.some((item) => /HIGH_RISK|MONEY|COMPENSATION|COMPLIANCE|SAFETY/.test(String(item)));
    const reviewedQuality = evaluateCustomerServiceReply({
      output: {
        draftReply: finalText,
        confidence: suggestion.confidence ?? 1,
        riskLevel: existingHighRisk ? "HIGH" : "LOW",
        usedEvidenceIds: [],
      },
      context: reviewContext,
      evidence: [],
      minimumAutoFillConfidence: 0,
      enforceMinimumConfidence: false,
    });
    const highRisk = reviewedQuality.effectiveRiskLevel === "HIGH";
    if (queueFill && highRisk && input.acknowledgeRisk !== true) {
      throw serviceError("CS_HIGH_RISK_ACK_REQUIRED", "High-risk draft fill requires explicit acknowledgement", 409);
    }
    const automation = this.replyAutomationStatus();
    if (queueFill && automation.draftFillEnabled !== true) {
      throw serviceError("CS_DRAFT_FILL_DISABLED", "Draft fill is disabled by the system rollout gate", 409);
    }
    if (queueFill && suggestion.accountStatus !== "ACTIVE") {
      throw serviceError("CS_ACCOUNT_ACTIVE_REQUIRED", "The LiaoLiao account must be active before a draft can be filled", 409);
    }
    if (queueFill && suggestion.automationMode !== "DRAFT_FILL") {
      throw serviceError("CS_ACCOUNT_DRAFT_FILL_DISABLED", "The LiaoLiao account is not enabled for Draft Fill", 409);
    }
    const reviewId = this.createId();
    let command = null;
    if (queueFill) {
      if (!suggestion.workerId) {
        throw serviceError("CS_WORKER_ROUTE_UNAVAILABLE", "No browser worker route is available for this message", 409);
      }
      const conversationRoute = parseDraftRoute(this.decryptText, suggestion.conversationRoutingCiphertext, "Conversation");
      const messageRoute = parseDraftRoute(this.decryptText, suggestion.messageRoutingCiphertext, "Message");
      command = {
        id: this.createId(),
        idempotencyKey: `fill-draft:review:${reviewId}`,
        workerId: suggestion.workerId,
        accountId: suggestion.accountId,
        conversationId: suggestion.conversationId,
        triggerMessageId: suggestion.triggerMessageId,
        payloadCiphertext: this.encryptText(JSON.stringify(buildFillDraftPayload({
          conversationRoute,
          messageRoute,
          draft: finalText,
          draftContentDigest: this.digest("message-content", finalText),
          triggerMessageId: suggestion.triggerMessageId,
          contextDigest: suggestion.contextDigest,
        }))),
      };
    }
    const reviewFlags = uniqueFlags([
      ...suggestion.qualityFlags,
      ...reviewedQuality.qualityFlags,
      `HUMAN_REVIEW_${action}`,
      ...(queueFill ? ["HUMAN_REVIEW_FILL_REQUESTED", "HUMAN_CONFIRMATION_REQUIRED"] : []),
    ]);
    return this.repository.reviewSuggestion({
      suggestionId: suggestion.id,
      reviewId,
      reviewerId: requiredText(actorId || "local-user", "actorId", 120),
      action,
      status: action === "REJECT" ? "REJECTED" : action === "EDIT" ? "EDITED" : "ACCEPTED",
      finalTextCiphertext: action === "EDIT" ? this.encryptText(finalText) : null,
      reasonCode,
      commentCiphertext: input.comment ? this.encryptText(String(input.comment).trim().slice(0, 2_000)) : null,
      editMetric,
      qualityFlags: reviewFlags,
      command,
      draftFillEnabled: automation.draftFillEnabled === true,
      now: this.timestamp(),
    });
  }

  async confirmShopBinding(bindingId, commerceShopId, actorId) {
    if (!this.commerceShopFacade) {
      throw serviceError("CS_SHOP_FACADE_NOT_CONFIGURED", "Commerce Shop facade is not configured", 503);
    }
    const binding = await this.repository.getShopBinding(requiredText(bindingId, "bindingId", 120));
    if (!binding) return null;
    const shop = await this.commerceShopFacade.getCommerceShop(requiredText(commerceShopId, "commerceShopId", 160));
    if (!shop || shop.status !== "ACTIVE" || shop.identityStatus !== "CONFIRMED") {
      throw serviceError("CS_COMMERCE_SHOP_NOT_CONFIRMABLE", "Commerce Shop is missing, inactive or not identity-confirmed", 409);
    }
    if (binding.countryCode && binding.countryCode !== shop.countryCode) {
      throw serviceError("CS_SHOP_COUNTRY_CONFLICT", "Observed LiaoLiao country conflicts with the selected Commerce Shop", 409);
    }
    return this.repository.confirmShopBinding({
      id: binding.id,
      commerceShopId: shop.id,
      actorId: requiredText(actorId || "local-user", "actorId", 120),
      evidence: {
        method: "HUMAN_CONFIRMED_CANONICAL_SHOP",
        observedShopName: binding.shopName,
        observedCountryCode: binding.countryCode,
        canonicalShopName: shop.shopName,
        canonicalCountryCode: shop.countryCode,
        canonicalPlatform: shop.platform,
      },
      now: this.timestamp(),
    });
  }

  async pullCommands(workerId, filters = {}) {
    const limit = Math.min(20, Math.max(1, Number(filters.limit || 10)));
    const accountId = requiredText(filters.accountId, "accountId", 120);
    const account = await this.repository.getAccount(accountId);
    const automation = this.replyAutomationStatus();
    const serviceAllowsDraftFill = automation.draftFillEnabled === true
      && account?.status === "ACTIVE"
      && String(account?.settings?.automationMode || "OBSERVE_ONLY").trim().toUpperCase() === "DRAFT_FILL";
    const now = this.now();
    const commands = await this.repository.pullCommands({
      workerId: requiredText(workerId, "workerId", 120),
      accountId,
      draftFillEnabled: automation.draftFillEnabled === true,
      now: now.toISOString(),
      leasedUntil: new Date(now.getTime() + 30_000).toISOString(),
      limit,
    });
    return commands.filter((command) => command.commandType !== "FILL_DRAFT" || serviceAllowsDraftFill).map((command) => ({
      ...command,
      payload: JSON.parse(this.decryptText(command.payloadCiphertext)),
      payloadCiphertext: undefined,
    }));
  }

  async completeCommand(workerId, accountId, commandId, raw) {
    const input = plainObject(raw, "command result");
    const succeeded = input.succeeded === true;
    return this.repository.completeCommand({
      workerId: requiredText(workerId, "workerId", 120),
      accountId: requiredText(accountId, "accountId", 120),
      commandId: requiredText(commandId, "commandId", 120),
      status: succeeded ? "SUCCEEDED" : "FAILED",
      resultCode: optionalText(input.resultCode, 120) || (succeeded ? "OK" : "WORKER_FAILED"),
      result: {
        editorMatched: Boolean(input.result?.editorMatched),
        conversationMatched: Boolean(input.result?.conversationMatched),
        draftContentDigest: /^[a-f0-9]{64}$/i.test(String(input.result?.draftContentDigest || "").trim())
          ? String(input.result.draftContentDigest).trim().toLowerCase()
          : null,
      },
      now: this.timestamp(),
    });
  }
}
