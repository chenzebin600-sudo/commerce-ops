import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SqliteProvider } from "../lib/data/sqlite/sqlite-provider.mjs";
import { CustomerServiceRepository } from "../lib/customer-service/customer-service-repository.mjs";
import { CustomerServiceService } from "../lib/customer-service/customer-service-service.mjs";
import { createCustomerServiceWorkerAuth } from "../lib/customer-service/customer-service-worker-auth.mjs";
import { CustomerServiceContextService } from "../lib/customer-service/customer-service-context-service.mjs";
import { registerCustomerServiceContext } from "../lib/ai/context/customer-service-context-registration.mjs";
import { AiContextRegistry } from "../lib/ai/context/ai-context-registry.mjs";
import { AgentRuntime } from "../lib/ai/agent/agent-runtime.mjs";
import { AgentToolRegistry } from "../lib/ai/tools/agent-tool-registry.mjs";
import {
  CustomerServiceReplyAgent,
  CUSTOMER_SERVICE_REPLY_AGENT_DEFINITION,
  CUSTOMER_SERVICE_REPLY_OUTPUT_VALIDATOR,
} from "../lib/customer-service/customer-service-reply-agent.mjs";
import { CustomerServiceReplyOrchestrator } from "../lib/customer-service/customer-service-reply-orchestrator.mjs";
import { CustomerServiceBusinessContextFacade } from "../lib/customer-service/customer-service-business-context-facade.mjs";
import { evaluateCustomerServiceReply } from "../lib/customer-service/customer-service-reply-quality-gate.mjs";
import { createCustomerServiceApi } from "../lib/customer-service/customer-service-api.mjs";
import {
  measureCustomerServiceReviewEdit,
  normalizeCustomerServiceReviewReason,
} from "../lib/customer-service/customer-service-review-quality.mjs";

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(fs.readFileSync(new URL("../migrations/033_customer_service_control_plane.sql", import.meta.url), "utf8"));
  const provider = new SqliteProvider({ connection: db });
  const repository = new CustomerServiceRepository({ provider });
  let id = 0;
  const encryptText = (value) => `encrypted:${Buffer.from(String(value), "utf8").toString("base64url")}`;
  const decryptText = (value) => Buffer.from(String(value).split(":")[1], "base64url").toString("utf8");
  const service = new CustomerServiceService({
    repository,
    encryptText,
    decryptText,
    identityPepper: "test-pepper",
    now: () => new Date("2026-08-08T12:00:00.000Z"),
    createId: () => `cs-test-${String(++id).padStart(4, "0")}`,
  });
  service.configureKnowledgeReadiness(async () => ({ ready: true, publishedSupportReleaseTotal: 1 }));
  return { db, provider, repository, service, encryptText };
}

function inboundEvent({
  eventId = "event-1",
  sequenceNo = 1,
  accountId,
  conversationId = "conversation-a",
  customerId = "customer-a",
  customerName = "Buyer A",
  messageId = "message-1",
  content = "Where is my order?",
  sentAt = "2026-08-08T11:59:00.000Z",
} = {}) {
  return {
    eventId,
    sequenceNo,
    accountId,
    observedAt: "2026-08-08T12:00:00.000Z",
    eventType: "MESSAGE_OBSERVED",
    shop: { externalId: "shop-th-1", name: "Thailand Home", countryCode: "TH" },
    conversation: {
      externalId: conversationId,
      customerExternalId: customerId,
      customerDisplayName: customerName,
    },
    message: {
      externalId: messageId,
      direction: "INBOUND",
      contentType: "TEXT",
      content,
      sentAt,
    },
    observation: { unread: true, domVersion: "liaoliao-web-v1" },
    panelSnapshot: {
      order: { orderNo: "ORDER-1001", status: "SHIPPED" },
      logistics: { status: "IN_TRANSIT" },
      product: { sellerSku: "SKU-RED-1" },
    },
  };
}

async function initializedFixture() {
  const result = fixture();
  const account = await result.service.createAccount({
    displayName: "LiaoLiao Thailand 01",
    externalAccountKey: "seller-secret-account-id",
    countryCodes: ["TH"],
    automationMode: "DRAFT_FILL",
  });
  await result.service.registerWorker("worker-a", {
    displayName: "客服电脑 A",
    version: "0.1.0",
    capabilities: ["observe_messages", "fill_draft"],
  });
  const settings = { ...account.settings, automationMode: "DRAFT_FILL" };
  result.db.prepare("UPDATE cs_channel_accounts SET settings_json=? WHERE id=?")
    .run(JSON.stringify(settings), account.id);
  account.settings = settings;
  return { ...result, account };
}

async function replyFixture(modelOutput) {
  const base = await initializedFixture();
  let sequence = 10_000;
  const now = () => new Date("2026-08-08T12:00:00.000Z");
  const contextService = new CustomerServiceContextService({
    customerServiceRepository: base.repository,
    productCoreFacade: {
      resolveExactSku: async () => ({ status: "NOT_FOUND", product: null }),
    },
    productKnowledgeService: {
      resolveSupportKnowledge: async () => [],
    },
    encryptText: base.service.encryptText,
    decryptText: base.service.decryptText,
    digestText: (value) => base.service.digest("context", value),
    createId: () => `context-${++sequence}`,
    now,
  });
  const contextRegistry = new AiContextRegistry();
  registerCustomerServiceContext({ registry: contextRegistry, contextService });
  const gatewayCalls = [];
  const runtime = new AgentRuntime({
    taskService: {
      create: async () => { throw new Error("Foundation task creation is not expected for recommendation-only Reply Agent"); },
      transition: async () => null,
      acquireLease: async () => null,
      releaseLease: async () => false,
    },
    contextRegistry,
    toolRegistry: new AgentToolRegistry(),
    gateway: {
      complete: async (input) => {
        gatewayCalls.push(input);
        return {
          success: true,
          resultStatus: "succeeded",
          requestId: input.requestId,
          provider: "fake",
          model: input.model,
          attempts: 1,
          durationMs: 5,
          validatedOutput: modelOutput,
          outputSchemaId: CUSTOMER_SERVICE_REPLY_OUTPUT_VALIDATOR.schemaId,
          outputValid: true,
          usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140 },
        };
      },
    },
    auditService: { recordSafely: async () => null },
    clock: now,
  });
  const agent = runtime.createAgent({
    definition: CUSTOMER_SERVICE_REPLY_AGENT_DEFINITION,
    Agent: CustomerServiceReplyAgent,
    options: { configured: true, model: "fake-model" },
    outputValidator: CUSTOMER_SERVICE_REPLY_OUTPUT_VALIDATOR,
  });
  const orchestrator = new CustomerServiceReplyOrchestrator({
    repository: base.repository,
    contextService,
    replyAgent: agent,
    encryptText: base.service.encryptText,
    decryptText: base.service.decryptText,
    digestText: (value) => base.service.digest("message-content", String(value || "").trim()),
    createId: () => `reply-${++sequence}`,
    audit: { recordSafely: async () => null },
    draftFillEnabled: true,
    contextSettleMs: 0,
    now,
  });
  base.service.configureReplyAutomation(() => ({
    configured: true,
    enabled: true,
    draftFillEnabled: true,
  }));
  return { ...base, contextService, gatewayCalls, orchestrator };
}

test("new accounts are observe-only until an operator enables AI", async (t) => {
  const { provider, service } = fixture();
  t.after(() => provider.close());
  const account = await service.createAccount({
    displayName: "Safe staged account",
    externalAccountKey: "safe-staged-account",
    countryCodes: ["TH"],
    automationMode: "DRAFT_FILL",
  });
  service.configureReplyAutomation(() => ({ configured: true, enabled: true, draftFillEnabled: true }));
  await service.registerWorker("worker-a", {
    displayName: "客服电脑 A",
    version: "0.1.0",
    capabilities: ["observe_messages", "fill_draft"],
  });
  await assert.rejects(
    service.updateAccountAutomation(account.id, { mode: "SUGGEST_ONLY" }, "operator-1"),
    (error) => error.code === "CS_ACCOUNT_ACTIVE_REQUIRED",
  );
  const setupAccount = (await service.listAccounts())[0];
  assert.equal(setupAccount.rollout.stageIndex, 1);
  assert.equal(setupAccount.rollout.canAdvance, false);
  assert.deepEqual(
    setupAccount.rollout.blockers,
    ["CS_ACCOUNT_ACTIVE_REQUIRED", "CS_ACCOUNT_OBSERVATION_REQUIRED"],
  );
  const observed = await service.ingestBatch("worker-a", {
    events: [inboundEvent({ accountId: account.id })],
  });
  assert.equal(account.settings.automationMode, "OBSERVE_ONLY");
  assert.equal(observed.results[0].suggestionId, null);
  assert.equal((await service.getConversation(observed.results[0].conversationId)).suggestions.length, 0);
  const observedAccount = (await service.listAccounts())[0];
  assert.equal(observedAccount.rollout.observedMessageTotal, 1);
  assert.equal(observedAccount.rollout.canAdvance, true);
  service.configureKnowledgeReadiness(async () => ({ ready: false, publishedSupportReleaseTotal: 0 }));
  await assert.rejects(
    service.updateAccountAutomation(account.id, { mode: "SUGGEST_ONLY" }, "operator-1"),
    (error) => error.code === "CS_PRODUCT_KNOWLEDGE_NOT_READY",
  );
  const missingKnowledge = (await service.listAccounts())[0];
  assert.deepEqual(missingKnowledge.rollout.blockers, [
    "CS_PRODUCT_KNOWLEDGE_NOT_READY",
    "CS_SUPPORT_KNOWLEDGE_RELEASE_REQUIRED",
  ]);
  service.configureKnowledgeReadiness(async () => ({ ready: true, publishedSupportReleaseTotal: 0 }));
  await assert.rejects(
    service.updateAccountAutomation(account.id, { mode: "SUGGEST_ONLY" }, "operator-1"),
    (error) => error.code === "CS_SUPPORT_KNOWLEDGE_RELEASE_REQUIRED",
  );
  service.configureKnowledgeReadiness(async () => ({ ready: true, publishedSupportReleaseTotal: 1 }));
  await assert.rejects(
    service.updateAccountAutomation(account.id, { mode: "DRAFT_FILL" }, "operator-1"),
    (error) => error.code === "CS_AUTOMATION_TRANSITION_INVALID",
  );
  const suggestOnly = await service.updateAccountAutomation(account.id, { mode: "SUGGEST_ONLY" }, "operator-1");
  assert.equal(suggestOnly.settings.automationMode, "SUGGEST_ONLY");
  assert.equal(suggestOnly.rollout.stageIndex, 2);
  assert.deepEqual(
    suggestOnly.rollout.blockers,
    ["CS_SUGGESTION_GENERATION_REQUIRED", "CS_SUGGESTION_REVIEW_REQUIRED"],
  );
  await assert.rejects(
    service.updateAccountAutomation(account.id, { mode: "DRAFT_FILL" }, "operator-1"),
    (error) => error.code === "CS_SUGGESTION_GENERATION_REQUIRED",
  );
});

test("account mode is rechecked before an automatic fill command is committed", async (t) => {
  const context = await initializedFixture();
  t.after(() => context.provider.close());
  const ingested = await context.service.ingestBatch("worker-a", {
    events: [inboundEvent({ accountId: context.account.id })],
  });
  const claimed = await context.repository.claimQueuedSuggestion({
    now: "2026-08-08T12:00:01.000Z",
    createdBefore: "2026-08-08T12:00:01.000Z",
  });
  assert.equal(claimed.automationMode, "DRAFT_FILL");
  await context.service.updateAccountAutomation(context.account.id, { mode: "SUGGEST_ONLY" }, "operator-1");
  const completed = await context.repository.completeGeneratedSuggestion({
    id: ingested.results[0].suggestionId,
    contextSnapshotId: null,
    draftCiphertext: context.encryptText("Safe answer"),
    languageCode: "en",
    provider: "fake",
    model: "fake-model",
    promptVersion: "test",
    confidence: 0.8,
    qualityFlags: [],
    evidence: [],
    command: {
      id: "race-command",
      idempotencyKey: "race-command",
      workerId: "worker-a",
      accountId: context.account.id,
      conversationId: claimed.conversationId,
      triggerMessageId: claimed.triggerMessageId,
      payloadCiphertext: context.encryptText("{}"),
      requiresAccountDraftFill: true,
    },
    now: "2026-08-08T12:00:02.000Z",
  });
  assert.equal(completed.commandCreated, false);
  assert.equal(context.db.prepare("SELECT COUNT(*) total FROM cs_worker_commands").get().total, 0);
});

test("customer-service ingestion is idempotent and stores sensitive message data encrypted", async (t) => {
  const { db, provider, service, account } = await initializedFixture();
  t.after(() => provider.close());
  const event = inboundEvent({ accountId: account.id });
  const first = await service.ingestBatch("worker-a", { events: [event] });
  const second = await service.ingestBatch("worker-a", { events: [event] });

  assert.equal(first.accepted, 1);
  assert.equal(first.results[0].duplicateEvent, false);
  assert.equal(second.results[0].duplicateEvent, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS total FROM cs_messages").get().total, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS total FROM cs_suggestions").get().total, 1);

  const stored = db.prepare("SELECT content_ciphertext,content_digest FROM cs_messages LIMIT 1").get();
  assert.equal(stored.content_ciphertext.includes("Where is my order?"), false);
  assert.equal(stored.content_ciphertext.startsWith("encrypted:"), true);
  assert.notEqual(stored.content_digest, "Where is my order?");
  const conversation = db.prepare("SELECT customer_display_ciphertext FROM cs_conversations LIMIT 1").get();
  assert.equal(conversation.customer_display_ciphertext.includes("Buyer A"), false);

  const inbox = await service.listInbox({});
  assert.equal(inbox[0].customerDisplayName, "Buyer A");
  assert.equal(inbox[0].latestMessage.content, "Where is my order?");
  assert.equal(inbox[0].suggestion.status, "QUEUED");
});

test("LiaoLiao shop bindings can enter the confirmed identity state required by business Context", async (t) => {
  const { db, provider, service, account } = await initializedFixture();
  t.after(() => provider.close());
  await service.ingestBatch("worker-a", { events: [inboundEvent({ accountId: account.id })] });
  const binding = db.prepare("SELECT id FROM cs_channel_shop_bindings LIMIT 1").get();
  assert.doesNotThrow(() => db.prepare(
    "UPDATE cs_channel_shop_bindings SET identity_status='CONFIRMED' WHERE id=?",
  ).run(binding.id));
  assert.equal(db.prepare("SELECT identity_status FROM cs_channel_shop_bindings WHERE id=?").get(binding.id).identity_status, "CONFIRMED");
  const shadow = fs.readFileSync(new URL("../postgresql/shadow/migrations/016_customer_service_control_plane.sql", import.meta.url), "utf8");
  assert.match(shadow, /identity_status IN \([^)]*'CONFIRMED'/);
});

test("a new message supersedes only its own conversation and never blocks another customer", async (t) => {
  const { db, provider, service, account, encryptText } = await initializedFixture();
  t.after(() => provider.close());
  const firstA = await service.ingestBatch("worker-a", { events: [inboundEvent({ accountId: account.id })] });
  const firstB = await service.ingestBatch("worker-a", { events: [inboundEvent({
    eventId: "event-b-1",
    sequenceNo: 2,
    accountId: account.id,
    conversationId: "conversation-b",
    customerId: "customer-b",
    customerName: "Buyer B",
    messageId: "message-b-1",
    content: "Is this item in stock?",
  })] });
  const firstSuggestionA = firstA.results[0].suggestionId;
  const firstSuggestionB = firstB.results[0].suggestionId;
  const conversationA = firstA.results[0].conversationId;
  db.prepare(`INSERT INTO cs_worker_commands (
      id,idempotency_key,worker_id,account_id,conversation_id,trigger_message_id,suggestion_id,
      command_type,status,payload_ciphertext,available_at,leased_until,attempt_count,result_code,
      result_json,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    "command-a-1", "fill-a-1", "worker-a", account.id, conversationA,
    firstA.results[0].messageId, firstSuggestionA, "FILL_DRAFT", "PENDING",
    encryptText(JSON.stringify({ draft: "Old answer" })), "2026-08-08T12:00:00.000Z",
    null, 0, null, "{}", "2026-08-08T12:00:00.000Z", "2026-08-08T12:00:00.000Z",
  );

  const secondA = await service.ingestBatch("worker-a", { events: [inboundEvent({
    eventId: "event-a-2",
    sequenceNo: 3,
    accountId: account.id,
    messageId: "message-a-2",
    content: "Please check it now, thanks.",
    sentAt: "2026-08-08T12:00:10.000Z",
  })] });

  assert.equal(db.prepare("SELECT status FROM cs_suggestions WHERE id=?").get(firstSuggestionA).status, "STALE");
  assert.equal(db.prepare("SELECT status FROM cs_worker_commands WHERE id='command-a-1'").get().status, "CANCELED");
  assert.equal(db.prepare("SELECT status FROM cs_suggestions WHERE id=?").get(firstSuggestionB).status, "QUEUED");
  assert.equal(db.prepare("SELECT status FROM cs_suggestions WHERE id=?").get(secondA.results[0].suggestionId).status, "QUEUED");
  assert.equal(db.prepare("SELECT COUNT(*) AS total FROM cs_conversations WHERE status='OPEN'").get().total, 2);
});

test("mark handled clears unread state but remains auditable", async (t) => {
  const { db, provider, service, account } = await initializedFixture();
  t.after(() => provider.close());
  const ingested = await service.ingestBatch("worker-a", { events: [inboundEvent({ accountId: account.id })] });
  const conversationId = ingested.results[0].conversationId;
  const handled = await service.markHandled(conversationId, "operator-1");

  assert.equal(handled.status, "HANDLED");
  assert.deepEqual(
    { ...db.prepare("SELECT status,unread_count FROM cs_conversations WHERE id=?").get(conversationId) },
    { status: "HANDLED", unread_count: 0 },
  );
  const action = db.prepare(
    "SELECT action,actor_type,actor_id,outcome,detail_json FROM cs_send_actions WHERE conversation_id=?",
  ).get(conversationId);
  assert.deepEqual(
    { action: action.action, actor_type: action.actor_type, actor_id: action.actor_id, outcome: action.outcome },
    { action: "MARK_HANDLED", actor_type: "USER", actor_id: "operator-1", outcome: "SUCCEEDED" },
  );
  assert.deepEqual(JSON.parse(action.detail_json), {
    semantic: "EXPLICIT_MARK_HANDLED_NOT_CONFIRMED_RESOLUTION",
    handlingFromMessageId: ingested.results[0].messageId,
    handlingLatencyMs: 0,
  });
  const duplicate = await service.markHandled(conversationId, "operator-1");
  assert.equal(duplicate.duplicate, true);
  assert.equal(db.prepare("SELECT COUNT(*) total FROM cs_send_actions WHERE action='MARK_HANDLED'").get().total, 1);
  const status = await service.status();
  assert.equal(status.quality.explicitHandledTotal, 1);
  assert.equal(status.quality.explicitHandledRate, 1);
  assert.equal(status.quality.handlingSampleTotal, 1);
  assert.equal(status.quality.handlingP50Ms, 0);
  assert.equal(status.quality.handlingP95Ms, 0);
});

test("worker authentication fails closed and uses a token distinct from normal app access", () => {
  const missing = createCustomerServiceWorkerAuth({ token: "" });
  assert.deepEqual(missing.authenticate({ "x-cs-worker-id": "worker-a" }), {
    ok: false,
    status: 503,
    code: "CS_WORKER_AUTH_NOT_CONFIGURED",
    error: "Customer-service worker authentication is not configured",
  });

  const auth = createCustomerServiceWorkerAuth({ token: "worker-token" });
  assert.equal(auth.authenticate({
    "x-cs-worker-id": "worker-a",
    authorization: "Bearer wrong-token",
  }).ok, false);
  assert.deepEqual(auth.authenticate({
    "x-cs-worker-id": "worker-a",
    authorization: "Bearer worker-token",
  }), { ok: true, workerId: "worker-a" });
});

test("one LiaoLiao account lease excludes duplicate Edge workers and requires the exact lease token", async (t) => {
  const context = await initializedFixture();
  t.after(() => context.provider.close());
  await context.service.registerWorker("worker-b", {
    displayName: "客服电脑 B",
    version: "0.1.0",
    capabilities: ["observe_messages", "fill_draft"],
  });

  const first = await context.service.acquireAccountLease("worker-a", context.account.id, {});
  assert.equal(first.workerId, "worker-a");
  assert.equal(first.renewed, false);
  assert.ok(first.leaseToken);
  const renewed = await context.service.acquireAccountLease("worker-a", context.account.id, {
    leaseToken: first.leaseToken,
  });
  assert.equal(renewed.renewed, true);
  assert.equal(renewed.leaseToken, first.leaseToken);
  await assert.rejects(
    context.service.acquireAccountLease("worker-b", context.account.id, {}),
    (error) => error.code === "CS_ACCOUNT_LEASE_CONFLICT",
  );
  await assert.rejects(
    context.service.assertAccountLease("worker-a", context.account.id, "wrong-token"),
    (error) => error.code === "CS_ACCOUNT_LEASE_INVALID",
  );
  assert.equal(
    (await context.service.assertAccountLease("worker-a", context.account.id, first.leaseToken)).workerId,
    "worker-a",
  );
  await assert.rejects(
    context.service.ingestBatch("worker-a", {
      events: [inboundEvent({ accountId: "another-account" })],
    }, { accountId: context.account.id }),
    (error) => error.code === "CS_ACCOUNT_LEASE_SCOPE_MISMATCH",
  );
  assert.equal(await context.service.releaseAccountLease("worker-a", context.account.id, first.leaseToken), true);
  const takeover = await context.service.acquireAccountLease("worker-b", context.account.id, {});
  assert.equal(takeover.workerId, "worker-b");
  assert.notEqual(takeover.leaseToken, first.leaseToken);
});

test("global AI and draft-fill rollout gates default to disabled", () => {
  const server = fs.readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  const envExample = fs.readFileSync(new URL("../.env.example", import.meta.url), "utf8");
  assert.match(server, /CUSTOMER_SERVICE_AI_ENABLED \|\| ["']false["']/);
  assert.match(server, /CUSTOMER_SERVICE_DRAFT_FILL_ENABLED \|\| ["']false["']/);
  assert.match(envExample, /CUSTOMER_SERVICE_AI_ENABLED=false/);
  assert.match(envExample, /CUSTOMER_SERVICE_DRAFT_FILL_ENABLED=false/);
  assert.doesNotMatch(server, /CUSTOMER_SERVICE_(?:AI|DRAFT_FILL)_ENABLED \|\| ["']true["']/);
});

test("authoritative logistics requires an exact confirmed shop binding and exact platform order items", async (t) => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE commerce_shop_registry (
    id TEXT PRIMARY KEY, platform TEXT NOT NULL, provider_shop_id TEXT NOT NULL,
    shop_code TEXT, shop_name TEXT NOT NULL, source_country_code TEXT NOT NULL,
    currency TEXT, category_name TEXT, growth_shop_id TEXT, platform_shop_id TEXT,
    platform_connector_shop_id TEXT, identity_status TEXT NOT NULL, status TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  db.prepare(`INSERT INTO commerce_shop_registry (
    id,platform,provider_shop_id,shop_name,source_country_code,platform_connector_shop_id,
    identity_status,status,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?)`).run(
    "shop-1", "SHOPEE", "seller-1", "Thailand Home", "TH", "connector-shop-1",
    "CONFIRMED", "ACTIVE", "2026-08-08T12:00:00.000Z",
  );
  const provider = new SqliteProvider({ connection: db });
  t.after(() => provider.close());
  const calls = [];
  const facade = new CustomerServiceBusinessContextFacade({
    provider,
    platformGatewayService: {
      getOrderItems: async (input) => {
        calls.push(input);
        return {
          data: {
            providerRequestId: "provider-request-1",
            records: [{
              id: "item-1",
              orderId: "ORDER-1001",
              status: "READY_TO_SHIP",
              trackingCode: "TRACK-1001",
              shipmentProvider: "SPX",
            }],
          },
        };
      },
    },
    now: () => new Date("2026-08-08T12:00:00.000Z"),
  });
  const resolved = await facade.authoritativeLogistics({ commerceShopId: "shop-1", orderRef: "ORDER-1001" });
  assert.equal(resolved.status, "RESOLVED");
  assert.equal(resolved.authoritative, true);
  assert.equal(resolved.trackingAssigned, true);
  assert.equal(resolved.records[0].trackingCode, "TRACK-1001");
  assert.deepEqual(calls[0], {
    platform: "shopee",
    shopId: "connector-shop-1",
    input: { orderId: "ORDER-1001" },
  });
  assert.equal((await facade.authoritativeLogistics({ commerceShopId: "shop-1", orderRef: "ORDER-1001" })).cacheHit, true);
  assert.equal(calls.length, 1);

  db.prepare("UPDATE commerce_shop_registry SET identity_status='REVIEW_REQUIRED' WHERE id='shop-1'").run();
  const blocked = await facade.authoritativeLogistics({ commerceShopId: "shop-1", orderRef: "ORDER-1002" });
  assert.equal(blocked.status, "SHOP_IDENTITY_NOT_CONFIRMED");
  assert.equal(blocked.authoritative, false);
  assert.equal(calls.length, 1);
});

test("customer-service Context promotes platform logistics only after authoritative order resolution", async (t) => {
  const context = await initializedFixture();
  t.after(() => context.provider.close());
  const ingested = await context.service.ingestBatch("worker-a", {
    events: [inboundEvent({ accountId: context.account.id })],
  });
  context.db.prepare(`UPDATE cs_channel_shop_bindings
    SET commerce_shop_id='shop-1',identity_status='CONFIRMED'`).run();
  const calls = [];
  const contextService = new CustomerServiceContextService({
    customerServiceRepository: context.repository,
    productCoreFacade: { resolveExactSku: async () => ({ status: "NOT_FOUND", product: null }) },
    productKnowledgeService: { resolveSupportKnowledge: async () => [] },
    businessContextFacade: {
      getCommerceShop: async () => ({ id: "shop-1", platform: "SHOPEE", identityStatus: "CONFIRMED" }),
      findExactOrder: async ({ orderRef }) => ({
        status: "RESOLVED",
        order: { id: "order-row-1", orderRef, status: "SHIPPED", qualityStatus: "VALID", revision: 2, lines: [] },
      }),
      authoritativeLogistics: async (input) => {
        calls.push(input);
        return {
          status: "RESOLVED",
          authoritative: true,
          orderRef: input.orderRef,
          providerRequestId: "provider-request-2",
          fetchedAt: "2026-08-08T12:00:00.000Z",
          trackingAssigned: true,
          records: [{ id: "item-1", orderId: input.orderRef, trackingCode: "TRACK-1001" }],
        };
      },
    },
    encryptText: context.service.encryptText,
    decryptText: context.service.decryptText,
    digestText: (value) => context.service.digest("context", value),
    createId: () => "authoritative-context-1",
    now: () => new Date("2026-08-08T12:00:00.000Z"),
  });
  const built = await contextService.build(ingested.results[0].conversationId);
  assert.deepEqual(calls, [{ commerceShopId: "shop-1", orderRef: "ORDER-1001" }]);
  assert.equal(built.context.logistics.authoritative, true);
  assert.equal(built.context.logistics.resolutionStatus, "RESOLVED");
  assert.equal(built.context.logistics.records[0].trackingCode, "TRACK-1001");
  assert.equal(built.context.unavailable.includes("authoritative_logistics_context"), false);
  assert.equal(built.evidence.some((item) => item.sourceType === "PLATFORM_GATEWAY_ORDER_ITEMS"), true);
});

test("deterministic reply quality gate blocks forged evidence and unsupported commitments", () => {
  const base = {
    output: {
      draftReply: "I am checking the verified details now.",
      confidence: 0.84,
      riskLevel: "LOW",
      usedEvidenceIds: [],
    },
    context: {
      order: { resolutionStatus: "NOT_FOUND" },
      logistics: { authoritative: false, resolutionStatus: "AUTHORITATIVE_ORDER_REQUIRED", records: [] },
      inventory: { resolutionStatus: "NOT_FOUND" },
      knowledge: { claims: [], accessories: [], policies: [], playbooks: [] },
    },
    evidence: [],
  };
  assert.equal(evaluateCustomerServiceReply(base).safeToAutoFill, true);

  const forged = evaluateCustomerServiceReply({
    ...base,
    output: { ...base.output, usedEvidenceIds: ["made-up-source"] },
  });
  assert.equal(forged.safeToAutoFill, false);
  assert.deepEqual(forged.invalidEvidenceIds, ["made-up-source"]);

  const financial = evaluateCustomerServiceReply({
    ...base,
    output: { ...base.output, draftReply: "We will refund and compensate you tomorrow." },
  });
  assert.equal(financial.effectiveRiskLevel, "HIGH");
  assert.equal(financial.autoFillBlockers.includes("HIGH_RISK_FINANCIAL_OR_COMPENSATION"), true);

  const inventedTracking = evaluateCustomerServiceReply({
    ...base,
    output: { ...base.output, draftReply: "Your tracking number is FAKE-TRACK-9988." },
  });
  assert.equal(inventedTracking.effectiveRiskLevel, "HIGH");
  assert.equal(inventedTracking.autoFillBlockers.includes("HIGH_RISK_UNKNOWN_TRACKING_IDENTIFIER"), true);

  const unsupportedStock = evaluateCustomerServiceReply({
    ...base,
    output: { ...base.output, draftReply: "This item is in stock and available now." },
  });
  assert.equal(unsupportedStock.safeToAutoFill, false);
  assert.equal(unsupportedStock.autoFillBlockers.includes("UNSUPPORTED_STOCK_STATUS"), true);

  const lowConfidence = evaluateCustomerServiceReply({
    ...base,
    output: { ...base.output, confidence: 0.5 },
    minimumAutoFillConfidence: 0.72,
  });
  assert.equal(lowConfidence.safeToAutoFill, false);
  assert.equal(lowConfidence.autoFillBlockers.includes("LOW_CONFIDENCE_AUTO_FILL_BLOCKED"), true);
});

test("review feedback uses a bounded reason taxonomy and deterministic edit metric", () => {
  assert.equal(normalizeCustomerServiceReviewReason("ACCEPT"), "AI_REPLY_APPROVED");
  assert.equal(normalizeCustomerServiceReviewReason("EDIT", "tone_adjustment"), "TONE_ADJUSTMENT");
  assert.throws(
    () => normalizeCustomerServiceReviewReason("REJECT", ""),
    (error) => error.code === "CS_REVIEW_REASON_REQUIRED",
  );
  assert.throws(
    () => normalizeCustomerServiceReviewReason("REJECT", "NOT_A_REASON"),
    (error) => error.code === "CS_REVIEW_REASON_INVALID",
  );
  const metric = measureCustomerServiceReviewEdit("Hello", "Hallo");
  assert.deepEqual(metric, {
    ratio: 0.2,
    metricVersion: "NORMALIZED_LEVENSHTEIN_V1",
    approximate: false,
    originalLength: 5,
    finalLength: 5,
  });
});

test("low-confidence model output remains reviewable but does not create an automatic fill command", async (t) => {
  const context = await replyFixture({
    draftReply: "I am checking the verified details now.",
    customerLanguage: "en",
    intent: "support_request",
    riskLevel: "LOW",
    confidence: 0.4,
    qualityFlags: [],
    usedEvidenceIds: [],
    requiresHumanConfirmation: true,
  });
  t.after(() => context.provider.close());
  const ingested = await context.service.ingestBatch("worker-a", {
    events: [inboundEvent({ accountId: context.account.id })],
  });
  const generated = await context.orchestrator.processNext();
  assert.equal(generated.suggestion.status, "READY");
  assert.equal(generated.suggestion.commandCreated, false);
  assert.equal(generated.qualityFlags.includes("LOW_CONFIDENCE_AUTO_FILL_BLOCKED"), true);
  assert.equal(context.db.prepare("SELECT COUNT(*) total FROM cs_worker_commands WHERE suggestion_id=?")
    .get(ingested.results[0].suggestionId).total, 0);
});

test("Reply Agent grounds one suggestion, queues fill-only and links the observed human send by exact digest", async (t) => {
  const context = await replyFixture({
    draftReply: "Thanks for your message. I am checking the latest verified tracking details for you.",
    customerLanguage: "en",
    intent: "order_tracking",
    riskLevel: "LOW",
    confidence: 0.84,
    qualityFlags: ["CLARIFYING_QUESTION"],
    usedEvidenceIds: [],
    requiresHumanConfirmation: true,
  });
  t.after(() => context.provider.close());
  const ingested = await context.service.ingestBatch("worker-a", {
    events: [inboundEvent({ accountId: context.account.id })],
  });
  const result = await context.orchestrator.processNext();

  assert.equal(result.suggestion.status, "READY");
  assert.equal(result.suggestion.commandCreated, true);
  assert.equal(context.gatewayCalls.length, 1);
  assert.equal(context.gatewayCalls[0].moduleId, "customer_service");
  const stored = context.db.prepare("SELECT * FROM cs_suggestions WHERE id=?").get(ingested.results[0].suggestionId);
  assert.equal(stored.status, "READY");
  assert.equal(stored.draft_ciphertext.includes("latest verified"), false);

  const commands = await context.service.pullCommands("worker-a", { accountId: context.account.id, limit: 10 });
  assert.equal(commands.length, 1);
  assert.equal(commands[0].commandType, "FILL_DRAFT");
  assert.equal(commands[0].payload.route.externalConversationId, "conversation-a");
  assert.equal(commands[0].payload.route.externalMessageId, "message-1");
  const sharedContract = JSON.parse(fs.readFileSync(
    new URL("../contracts/customer-service/cs-fill-draft-v1.example.json", import.meta.url),
    "utf8",
  ));
  assert.equal(commands[0].payload.contractVersion, sharedContract.payload.contractVersion);
  assert.deepEqual(commands[0].payload.safety, sharedContract.payload.safety);
  assert.equal(commands[0].payload.safety.automaticSend, false);
  assert.equal(commands[0].payload.safety.requireLatestInboundMessage, true);
  assert.match(commands[0].payload.expected.draftContentDigest, /^[a-f0-9]{64}$/);

  await context.service.completeCommand("worker-a", context.account.id, commands[0].id, {
    succeeded: true,
    resultCode: "DRAFT_FILLED_NO_SEND",
    result: {
      editorMatched: true,
      conversationMatched: true,
      draftContentDigest: commands[0].payload.expected.draftContentDigest,
    },
  });
  assert.equal(context.db.prepare("SELECT status FROM cs_suggestions WHERE id=?").get(stored.id).status, "FILLED");
  assert.deepEqual(
    { ...context.db.prepare("SELECT action,actor_type,outcome,detail_json FROM cs_send_actions").get() },
    {
      action: "DRAFT_FILLED",
      actor_type: "WORKER",
      outcome: "SUCCEEDED",
      detail_json: JSON.stringify({
        editorMatched: true,
        conversationMatched: true,
        draftContentDigest: commands[0].payload.expected.draftContentDigest,
        automaticSend: false,
      }),
    },
  );
  assert.equal(context.db.prepare("SELECT COUNT(*) total FROM cs_send_actions WHERE action='SEND_CONFIRMED'").get().total, 0);

  const outbound = inboundEvent({
    eventId: "event-outbound-1",
    sequenceNo: 2,
    accountId: context.account.id,
    messageId: "message-outbound-1",
    content: "Thanks for your message. I am checking the latest verified tracking details for you.",
    sentAt: "2026-08-08T12:00:10.000Z",
  });
  outbound.observedAt = "2026-08-08T12:00:11.000Z";
  outbound.message.direction = "OUTBOUND";
  outbound.observation.unread = false;
  delete outbound.panelSnapshot;
  const observed = await context.service.ingestBatch("worker-a", { events: [outbound] });
  assert.equal(observed.accepted, 1);
  const sendObserved = context.db.prepare(
    "SELECT suggestion_id,message_id,outcome,detail_json FROM cs_send_actions WHERE action='SEND_OBSERVED'",
  ).get();
  assert.equal(sendObserved.suggestion_id, stored.id);
  assert.equal(sendObserved.outcome, "MATCHED_AI_DRAFT");
  assert.deepEqual(JSON.parse(sendObserved.detail_json), {
    automaticSend: false,
    matchMethod: "DRAFT_CONTENT_DIGEST",
    draftFilledActionId: `${commands[0].id}:draft-filled`,
    responseFromMessageId: ingested.results[0].messageId,
    responseLatencyMs: 70_000,
  });
  await context.service.ingestBatch("worker-a", { events: [outbound] });
  assert.equal(context.db.prepare(
    "SELECT COUNT(*) total FROM cs_send_actions WHERE action='SEND_OBSERVED' AND message_id=?",
  ).get(sendObserved.message_id).total, 1);
  const detail = await context.service.getConversation(observed.results[0].conversationId);
  assert.equal(detail.sendActions.some((item) => (
    item.action === "SEND_OBSERVED" && item.suggestionId === stored.id && item.messageId === sendObserved.message_id
  )), true);
  assert.equal(context.db.prepare("SELECT status FROM cs_suggestions WHERE id=?").get(stored.id).status, "FILLED");

  const unmatchedOutbound = inboundEvent({
    eventId: "event-outbound-2",
    sequenceNo: 3,
    accountId: context.account.id,
    messageId: "message-outbound-2",
    content: "A separate reply written by the human operator.",
    sentAt: "2026-08-08T12:00:20.000Z",
  });
  unmatchedOutbound.observedAt = "2026-08-08T12:00:21.000Z";
  unmatchedOutbound.message.direction = "OUTBOUND";
  unmatchedOutbound.observation.unread = false;
  delete unmatchedOutbound.panelSnapshot;
  await context.service.ingestBatch("worker-a", { events: [unmatchedOutbound] });
  const unmatchedAction = context.db.prepare(
    "SELECT suggestion_id,outcome,detail_json FROM cs_send_actions WHERE action='SEND_OBSERVED' AND outcome='HUMAN_OR_UNMATCHED'",
  ).get();
  assert.equal(unmatchedAction.suggestion_id, null);
  assert.equal(JSON.parse(unmatchedAction.detail_json).responseLatencyMs, null);
  const status = await context.service.status();
  assert.equal(status.quality.observedOutboundTotal, 2);
  assert.equal(status.quality.matchedAiDraftSendTotal, 1);
  assert.equal(status.quality.exactAiDraftShare, 0.5);
  assert.equal(status.quality.firstResponseSampleTotal, 1);
  assert.equal(status.quality.firstResponseP50Ms, 70_000);
  assert.equal(status.quality.firstResponseP95Ms, 70_000);
});

test("suggest-only accounts require a review and explicit Draft Fill promotion before filling", async (t) => {
  const context = await replyFixture({
    draftReply: "I am checking the latest verified order details for you.",
    customerLanguage: "en",
    intent: "order_tracking",
    riskLevel: "LOW",
    confidence: 0.82,
    qualityFlags: [],
    usedEvidenceIds: [],
    requiresHumanConfirmation: true,
  });
  t.after(() => context.provider.close());
  await context.service.updateAccountAutomation(context.account.id, { mode: "SUGGEST_ONLY" }, "operator-1");
  const ingested = await context.service.ingestBatch("worker-a", {
    events: [inboundEvent({ accountId: context.account.id })],
  });
  const generated = await context.orchestrator.processNext();
  assert.equal(generated.suggestion.commandCreated, false);
  assert.equal(context.db.prepare("SELECT COUNT(*) total FROM cs_worker_commands").get().total, 0);

  await assert.rejects(
    context.service.reviewSuggestion(
      ingested.results[0].suggestionId,
      {
        action: "EDIT",
        finalText: "Thanks for your message. I am checking the verified order details now.",
        reasonCode: "TONE_ADJUSTMENT",
        queueFill: true,
      },
      "operator-1",
    ),
    (error) => error.code === "CS_ACCOUNT_DRAFT_FILL_DISABLED",
  );
  const rolloutReview = await context.service.reviewSuggestion(
    ingested.results[0].suggestionId,
    { action: "ACCEPT", queueFill: false },
    "operator-1",
  );
  assert.equal(rolloutReview.commandCreated, false);
  const promoted = await context.service.updateAccountAutomation(
    context.account.id,
    { mode: "DRAFT_FILL" },
    "operator-1",
  );
  assert.equal(promoted.settings.automationMode, "DRAFT_FILL");

  const reviewed = await context.service.reviewSuggestion(
    ingested.results[0].suggestionId,
    {
      action: "EDIT",
      finalText: "Thanks for your message. I am checking the verified order details now.",
      reasonCode: "TONE_ADJUSTMENT",
      queueFill: true,
    },
    "operator-1",
  );
  assert.equal(reviewed.status, "EDITED");
  assert.equal(reviewed.commandCreated, true);
  assert.equal(context.db.prepare("SELECT COUNT(*) total FROM cs_suggestion_reviews WHERE action='EDIT'").get().total, 1);
  const commands = await context.service.pullCommands("worker-a", { accountId: context.account.id, limit: 10 });
  assert.equal(commands.length, 1);
  assert.equal(commands[0].payload.draft, "Thanks for your message. I am checking the verified order details now.");
  assert.equal(commands[0].payload.safety.automaticSend, false);
  const status = await context.service.status();
  assert.equal(status.quality.generatedTotal, 1);
  assert.equal(status.quality.averageConfidence, 0.82);
  assert.equal(status.quality.belowThresholdTotal, 0);
  assert.equal(status.quality.reviewedTotal, 1);
  assert.deepEqual(status.quality.reviews, { EDIT: 1 });
  assert.deepEqual(status.quality.reviewReasons, { AI_REPLY_APPROVED: 1, TONE_ADJUSTMENT: 1 });
  assert.ok(status.quality.averageEditRatio > 0);
  assert.equal(status.quality.majorEditTotal, 1);
  assert.equal(status.quality.inputTokens, 100);
  assert.equal(status.quality.outputTokens, 40);
  assert.equal(status.quality.totalTokens, 140);
  const storedReview = context.db.prepare(
    "SELECT reason_code,edit_distance_ratio,edit_metric_version,original_length,final_length FROM cs_suggestion_reviews WHERE action='EDIT'",
  ).get();
  assert.equal(storedReview.reason_code, "TONE_ADJUSTMENT");
  assert.equal(storedReview.edit_metric_version, "NORMALIZED_LEVENSHTEIN_V1");
  assert.ok(storedReview.edit_distance_ratio > 0);
  assert.ok(storedReview.original_length > 0);
  assert.ok(storedReview.final_length > 0);
  const storedSuggestion = context.db.prepare(
    "SELECT intent_code,risk_level,country_code,input_tokens,output_tokens,total_tokens FROM cs_suggestions",
  ).get();
  assert.deepEqual({ ...storedSuggestion }, {
    intent_code: "order_tracking",
    risk_level: "LOW",
    country_code: "TH",
    input_tokens: 100,
    output_tokens: 40,
    total_tokens: 140,
  });
  const intentQuality = await context.service.qualityBreakdown({ dimension: "intent" });
  assert.equal(intentQuality.dimension, "intent");
  assert.deepEqual(intentQuality.rows.map((row) => ({
    value: row.value,
    generatedTotal: row.generatedTotal,
    editedTotal: row.editedTotal,
    averageConfidence: row.averageConfidence,
    totalTokens: row.totalTokens,
  })), [{
    value: "order_tracking",
    generatedTotal: 1,
    editedTotal: 1,
    averageConfidence: 0.82,
    totalTokens: 140,
  }]);
  const countryQuality = await context.service.qualityBreakdown({ dimension: "country" });
  assert.equal(countryQuality.rows[0].value, "TH");
  await assert.rejects(
    context.service.qualityBreakdown({ dimension: "raw_customer_text" }),
    (error) => error.code === "CS_QUALITY_DIMENSION_INVALID",
  );
  const handler = createCustomerServiceApi({ service: context.service });
  const response = { status: 0, body: null };
  await handler(
    { method: "GET", headers: {} },
    {
      writeHead(statusCode) { response.status = statusCode; },
      end(body) { response.body = JSON.parse(body); },
    },
    new URL("http://localhost/api/customer-service/quality-breakdown?dimension=intent"),
  );
  assert.equal(response.status, 200);
  assert.equal(response.body.quality.rows[0].value, "order_tracking");
});

test("review transaction rechecks account Draft Fill authorization before inserting a command", async (t) => {
  const context = await replyFixture({
    draftReply: "I am checking the verified order details now.",
    customerLanguage: "en",
    intent: "order_tracking",
    riskLevel: "LOW",
    confidence: 0.4,
    qualityFlags: [],
    usedEvidenceIds: [],
    requiresHumanConfirmation: true,
  });
  t.after(() => context.provider.close());
  const ingested = await context.service.ingestBatch("worker-a", {
    events: [inboundEvent({ accountId: context.account.id })],
  });
  await context.orchestrator.processNext();

  const commitReview = context.repository.reviewSuggestion.bind(context.repository);
  context.repository.reviewSuggestion = async (input) => {
    const stored = context.db.prepare("SELECT settings_json FROM cs_channel_accounts WHERE id=?")
      .get(context.account.id);
    context.db.prepare("UPDATE cs_channel_accounts SET settings_json=? WHERE id=?")
      .run(JSON.stringify({ ...JSON.parse(stored.settings_json), automationMode: "SUGGEST_ONLY" }), context.account.id);
    return commitReview(input);
  };

  await assert.rejects(
    context.service.reviewSuggestion(ingested.results[0].suggestionId, {
      action: "ACCEPT",
      queueFill: true,
    }, "operator-1"),
    (error) => error.code === "CS_ACCOUNT_DRAFT_FILL_DISABLED",
  );
  assert.equal(context.db.prepare("SELECT COUNT(*) total FROM cs_suggestion_reviews").get().total, 0);
  assert.equal(context.db.prepare("SELECT COUNT(*) total FROM cs_worker_commands").get().total, 0);
});

test("command pull cancels unauthorized draft fills before leasing and records the reason", async (t) => {
  const modelOutput = {
    draftReply: "I am checking the verified order details now.",
    customerLanguage: "en",
    intent: "order_tracking",
    riskLevel: "LOW",
    confidence: 0.9,
    qualityFlags: [],
    usedEvidenceIds: [],
    requiresHumanConfirmation: true,
  };
  const scenarios = [
    {
      name: "account mode",
      mutate(context) {
        const stored = context.db.prepare("SELECT settings_json FROM cs_channel_accounts WHERE id=?")
          .get(context.account.id);
        context.db.prepare("UPDATE cs_channel_accounts SET settings_json=? WHERE id=?")
          .run(JSON.stringify({ ...JSON.parse(stored.settings_json), automationMode: "SUGGEST_ONLY" }), context.account.id);
      },
      reasonCode: "ACCOUNT_DRAFT_FILL_DISABLED",
      expected: { accountStatus: "ACTIVE", automationMode: "SUGGEST_ONLY", draftFillEnabled: true },
    },
    {
      name: "account status",
      mutate(context) {
        context.db.prepare("UPDATE cs_channel_accounts SET status='PAUSED' WHERE id=?").run(context.account.id);
      },
      reasonCode: "ACCOUNT_NOT_ACTIVE",
      expected: { accountStatus: "PAUSED", automationMode: "DRAFT_FILL", draftFillEnabled: true },
    },
    {
      name: "global gate",
      mutate(context) {
        context.service.configureReplyAutomation(() => ({
          configured: true,
          enabled: true,
          draftFillEnabled: false,
        }));
      },
      reasonCode: "DRAFT_FILL_DISABLED",
      expected: { accountStatus: "ACTIVE", automationMode: "DRAFT_FILL", draftFillEnabled: false },
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async (subtest) => {
      const context = await replyFixture(modelOutput);
      subtest.after(() => context.provider.close());
      await context.service.ingestBatch("worker-a", {
        events: [inboundEvent({ accountId: context.account.id })],
      });
      const generated = await context.orchestrator.processNext();
      assert.equal(generated.suggestion.commandCreated, true);
      scenario.mutate(context);

      const commands = await context.service.pullCommands("worker-a", {
        accountId: context.account.id,
        limit: 10,
      });
      assert.deepEqual(commands, []);
      const stored = context.db.prepare(
        "SELECT status,result_code,result_json,attempt_count FROM cs_worker_commands LIMIT 1",
      ).get();
      assert.equal(stored.status, "CANCELED");
      assert.equal(stored.result_code, scenario.reasonCode);
      assert.equal(stored.attempt_count, 0);
      assert.deepEqual(JSON.parse(stored.result_json), {
        cancellationSource: "COMMAND_PULL_AUTHORIZATION_RECHECK",
        reasonCode: scenario.reasonCode,
        ...scenario.expected,
        automaticSend: false,
      });
    });
  }
});

test("high-risk suggestions require explicit acknowledgement before manual draft fill", async (t) => {
  const context = await replyFixture({
    draftReply: "We can provide compensation after verification.",
    customerLanguage: "en",
    intent: "compensation_request",
    riskLevel: "HIGH",
    confidence: 0.55,
    qualityFlags: ["MONEY_OR_COMPENSATION"],
    usedEvidenceIds: [],
    requiresHumanConfirmation: true,
  });
  t.after(() => context.provider.close());
  const ingested = await context.service.ingestBatch("worker-a", {
    events: [inboundEvent({ accountId: context.account.id })],
  });
  await context.orchestrator.processNext();
  await assert.rejects(
    context.service.reviewSuggestion(ingested.results[0].suggestionId, {
      action: "ACCEPT",
      queueFill: true,
    }, "operator-1"),
    (error) => error.code === "CS_HIGH_RISK_ACK_REQUIRED",
  );
  const reviewed = await context.service.reviewSuggestion(ingested.results[0].suggestionId, {
    action: "EDIT",
    finalText: "I will verify the applicable after-sales options before confirming anything.",
    queueFill: true,
    acknowledgeRisk: true,
  }, "operator-1");
  assert.equal(reviewed.commandCreated, true);
});

test("human edits are re-evaluated so a low-risk draft cannot be changed into an unacknowledged promise", async (t) => {
  const context = await replyFixture({
    draftReply: "I am checking the verified options for you.",
    customerLanguage: "en",
    intent: "support_request",
    riskLevel: "LOW",
    confidence: 0.9,
    qualityFlags: [],
    usedEvidenceIds: [],
    requiresHumanConfirmation: true,
  });
  t.after(() => context.provider.close());
  const ingested = await context.service.ingestBatch("worker-a", {
    events: [inboundEvent({ accountId: context.account.id })],
  });
  await context.orchestrator.processNext();
  await assert.rejects(
    context.service.reviewSuggestion(ingested.results[0].suggestionId, {
      action: "EDIT",
      finalText: "We will refund and compensate you tomorrow.",
      queueFill: true,
    }, "operator-1"),
    (error) => error.code === "CS_HIGH_RISK_ACK_REQUIRED",
  );
  const reviewed = await context.service.reviewSuggestion(ingested.results[0].suggestionId, {
    action: "EDIT",
    finalText: "I will verify the available after-sales options before confirming anything.",
    queueFill: true,
  }, "operator-1");
  assert.equal(reviewed.commandCreated, true);
});

test("a newer inbound message cancels an unfilled command while another conversation keeps generating", async (t) => {
  const context = await replyFixture({
    draftReply: "I will verify this for you now.",
    customerLanguage: "en",
    intent: "support_request",
    riskLevel: "LOW",
    confidence: 0.8,
    qualityFlags: [],
    usedEvidenceIds: [],
    requiresHumanConfirmation: true,
  });
  t.after(() => context.provider.close());
  const firstA = await context.service.ingestBatch("worker-a", {
    events: [inboundEvent({ accountId: context.account.id })],
  });
  await context.service.ingestBatch("worker-a", { events: [inboundEvent({
    eventId: "event-b-central",
    sequenceNo: 22,
    accountId: context.account.id,
    conversationId: "conversation-b",
    customerId: "customer-b",
    customerName: "Buyer B",
    messageId: "message-b",
    content: "Can you check stock?",
  })] });
  const generated = [
    await context.orchestrator.processNext(),
    await context.orchestrator.processNext(),
  ];
  assert.equal(generated.filter(Boolean).length, 2);
  assert.equal(context.db.prepare("SELECT COUNT(*) total FROM cs_worker_commands WHERE status='PENDING'").get().total, 2);

  await context.service.ingestBatch("worker-a", { events: [inboundEvent({
    eventId: "event-a-new",
    sequenceNo: 23,
    accountId: context.account.id,
    messageId: "message-a-new",
    content: "Here is another detail.",
    sentAt: "2026-08-08T12:00:10.000Z",
  })] });
  assert.equal(context.db.prepare("SELECT status FROM cs_suggestions WHERE id=?").get(firstA.results[0].suggestionId).status, "STALE");
  assert.equal(context.db.prepare("SELECT COUNT(*) total FROM cs_worker_commands WHERE status='CANCELED'").get().total, 1);
  assert.equal(context.db.prepare("SELECT COUNT(*) total FROM cs_worker_commands WHERE status='PENDING'").get().total, 1);
});
