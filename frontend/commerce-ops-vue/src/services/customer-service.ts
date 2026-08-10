import { apiJson } from "@/services/api";

export type CustomerServiceSuggestionStatus =
  | "QUEUED" | "GENERATING" | "READY" | "STALE" | "FAILED"
  | "ACCEPTED" | "EDITED" | "REJECTED" | "FILLED";

export type CustomerServiceAutomationMode = "OBSERVE_ONLY" | "SUGGEST_ONLY" | "DRAFT_FILL";

export type CustomerServiceRolloutBlocker =
  | "CS_AUTOMATION_TRANSITION_INVALID"
  | "CS_REPLY_AGENT_NOT_CONFIGURED"
  | "CS_AI_ROLLOUT_DISABLED"
  | "CS_PRODUCT_KNOWLEDGE_NOT_READY"
  | "CS_SUPPORT_KNOWLEDGE_RELEASE_REQUIRED"
  | "CS_ACCOUNT_ACTIVE_REQUIRED"
  | "CS_ACCOUNT_OBSERVATION_REQUIRED"
  | "CS_DRAFT_FILL_DISABLED"
  | "CS_SUGGESTION_GENERATION_REQUIRED"
  | "CS_SUGGESTION_REVIEW_REQUIRED";

export interface CustomerServiceAccountRollout {
  currentMode: CustomerServiceAutomationMode;
  stageIndex: number;
  stageTotal: 3;
  nextMode: CustomerServiceAutomationMode | null;
  canAdvance: boolean;
  blockers: CustomerServiceRolloutBlocker[];
  observedMessageTotal: number;
  generatedSuggestionTotal: number;
  reviewedSuggestionTotal: number;
  requirements: Array<{
    code: CustomerServiceRolloutBlocker;
    requiredFor: "SUGGEST_ONLY" | "DRAFT_FILL";
    satisfied: boolean;
    observedValue: string | number | null;
  }>;
}

export interface CustomerServiceAccount {
  id: string;
  channel: string;
  displayName: string;
  status: "SETUP_REQUIRED" | "ACTIVE" | "PAUSED" | "ERROR" | "DISABLED";
  settings: {
    countryCodes?: string[];
    languageCodes?: string[];
    automationMode?: CustomerServiceAutomationMode;
    automationUpdatedAt?: string;
    automationUpdatedBy?: string;
  };
  lastObservedAt: string | null;
  createdAt: string;
  updatedAt: string;
  rollout?: CustomerServiceAccountRollout;
}

export type CustomerServiceLocalRuntimeStatus =
  | "IDLE"
  | "STARTING"
  | "WAITING_FOR_LOGIN"
  | "SESSION_READY"
  | "MONITOR_STARTING"
  | "MONITORING"
  | "STOPPING"
  | "STOPPED"
  | "FAILED";

export interface CustomerServiceLocalRuntime {
  accountId: string;
  status: CustomerServiceLocalRuntimeStatus;
  workerId: string | null;
  sessionReady: boolean;
  monitoring: boolean;
  retryable: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  message: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  pollAfterMs: number | null;
}

interface CustomerServiceLocalRuntimePayload extends Partial<CustomerServiceLocalRuntime> {
  state?: CustomerServiceLocalRuntimeStatus | "UNAVAILABLE";
  available?: boolean;
  canStop?: boolean;
  canRetry?: boolean;
  workerOnline?: boolean;
  leaseActive?: boolean;
  lastError?: {
    code?: string;
    retryable?: boolean;
    at?: string | null;
  } | null;
}

interface CustomerServiceLocalRuntimeResponse extends CustomerServiceLocalRuntimePayload {
  runtime?: CustomerServiceLocalRuntimePayload;
}

export interface CustomerServiceWorker {
  id: string;
  displayName: string;
  status: string;
  version: string | null;
  capabilities: string[];
  lastHeartbeatAt: string | null;
  lastErrorCode: string | null;
  online: boolean;
}

export interface CustomerServiceAccountLease {
  accountId: string;
  workerId: string;
  status: "ACTIVE" | "RELEASED";
  leasedUntil: string;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerServiceStatus {
  ready: boolean;
  phase: "MIGRATION_REQUIRED" | "CONTROL_PLANE_READY";
  humanConfirmationRequired: boolean;
  automaticSendEnabled: boolean;
  identityProtectionConfigured: boolean;
  accounts: Record<string, number>;
  workers: CustomerServiceWorker[];
  accountLeases: CustomerServiceAccountLease[];
  conversations: Record<string, number>;
  suggestions: Record<string, number>;
  commands: Record<string, number>;
  quality: {
    generatedTotal: number;
    averageConfidence: number | null;
    belowThresholdTotal: number;
    minimumAutoFillConfidence: number;
    reviewedTotal: number;
    reviews: Record<string, number>;
    reviewReasons: Record<string, number>;
    averageEditRatio: number | null;
    majorEditTotal: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    observedOutboundTotal?: number;
    matchedAiDraftSendTotal?: number;
    exactAiDraftShare?: number | null;
    firstResponseSampleTotal?: number;
    firstResponseP50Ms?: number | null;
    firstResponseP95Ms?: number | null;
    explicitHandledTotal?: number;
    explicitHandledRate?: number | null;
    handlingSampleTotal?: number;
    handlingP50Ms?: number | null;
    handlingP95Ms?: number | null;
  };
  replyAutomation: {
    configured: boolean;
    enabled: boolean;
    draftFillEnabled: boolean;
    name?: string;
    version?: string;
    model?: string;
    promptVersion?: string;
    concurrency?: number;
    pollIntervalMs?: number;
    minimumAutoFillConfidence?: number;
  };
  dependencies?: {
    productKnowledge: {
      ready: boolean;
      publishedSupportReleaseTotal: number;
    };
  };
}

export type CustomerServiceQualityDimension = "country" | "category" | "intent" | "risk" | "account" | "shop" | "model";

export interface CustomerServiceQualityBreakdown {
  dimension: CustomerServiceQualityDimension;
  minimumAutoFillConfidence: number;
  rows: Array<{
    dimension: CustomerServiceQualityDimension;
    value: string;
    generatedTotal: number;
    averageConfidence: number | null;
    belowThresholdTotal: number;
    acceptedTotal: number;
    editedTotal: number;
    rejectedTotal: number;
    averageEditRatio: number | null;
    totalTokens: number;
  }>;
}

export interface CustomerServiceInboxItem {
  id: string;
  accountId: string;
  accountName: string | null;
  channel: string | null;
  shopBindingId: string | null;
  shopName: string | null;
  countryCode: string | null;
  commerceShopId: string | null;
  shopIdentityStatus: string | null;
  customerDisplayName: string;
  status: "OPEN" | "HANDLED" | "ARCHIVED";
  priority: "LOW" | "NORMAL" | "HIGH" | "URGENT";
  unreadCount: number;
  latestMessageAt: string | null;
  latestMessage: { content: string; contentType: string } | null;
  suggestion: {
    id: string;
    status: CustomerServiceSuggestionStatus;
    draft: string | null;
    updatedAt: string;
  } | null;
}

export interface CustomerServiceMessage {
  id: string;
  conversationId: string;
  direction: "INBOUND" | "OUTBOUND" | "SYSTEM";
  contentType: string;
  content: string;
  sentAt: string;
  observedAt: string;
}

export interface CustomerServiceSuggestion {
  id: string;
  conversationId: string;
  triggerMessageId: string;
  contextSnapshotId: string | null;
  status: CustomerServiceSuggestionStatus;
  draft: string | null;
  languageCode: string | null;
  provider: string | null;
  model: string | null;
  promptVersion: string | null;
  confidence: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  intentCode: string | null;
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | null;
  countryCode: string | null;
  commerceShopId: string | null;
  productModelId: string | null;
  productSkuId: string | null;
  categoryId: string | null;
  categoryName: string | null;
  qualityFlags: string[];
  errorCode: string | null;
  supersededByMessageId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerServiceEvidence {
  id: string;
  suggestionId: string;
  sourceType: string;
  sourceId: string | null;
  sourceVersion: string | null;
  label: string;
  excerpt: string | null;
  rank: number;
  metadata: Record<string, unknown>;
}

export interface CustomerServiceSendAction {
  id: string;
  suggestionId: string | null;
  messageId: string | null;
  action: "DRAFT_FILLED" | "SEND_CONFIRMED" | "SEND_OBSERVED" | "MARK_HANDLED";
  actorType: "USER" | "WORKER" | "SYSTEM";
  outcome: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface CustomerServiceConversationDetail {
  conversation: CustomerServiceInboxItem;
  messages: CustomerServiceMessage[];
  suggestions: CustomerServiceSuggestion[];
  evidence: CustomerServiceEvidence[];
  sendActions?: CustomerServiceSendAction[];
}

export interface CommerceShopCandidate {
  id: string;
  platform: string;
  shopName: string;
  countryCode: string;
  identityStatus: string;
  status: string;
}

export interface CustomerServiceContextDetail {
  snapshot: {
    id: string;
    conversationId: string;
    triggerMessageId: string;
    contextDigest: string;
    contextVersion: string;
    evidenceCount: number;
    missingFields: string[];
    builtAt: string;
    expiresAt: string | null;
  };
  context: {
    builtAt: string;
    shop: {
      observedShopName: string | null;
      countryCode: string | null;
      commerceShopId: string | null;
      identityStatus: string | null;
      registryResolution?: {
        status: string;
        candidates?: CommerceShopCandidate[];
        shop?: CommerceShopCandidate;
      };
    };
    observedPanel: { authoritative: false; observedAt: string; data: Record<string, unknown> } | null;
    product: Record<string, unknown>;
    productPackage: Record<string, unknown> | null;
    order: { source: string; resolutionStatus: string; data?: Record<string, unknown> };
    logistics: {
      source: string;
      authoritative: boolean;
      resolutionStatus: string;
      orderRef?: string | null;
      providerRequestId?: string | null;
      fetchedAt?: string | null;
      cacheHit?: boolean;
      trackingAssigned?: boolean;
      records: Array<Record<string, unknown>>;
      observed?: Record<string, unknown> | null;
      errorCode?: string | null;
    };
    inventory: { source: string; resolutionStatus: string; snapshots: Array<Record<string, unknown>> };
    knowledge: {
      source: string;
      claims: Array<Record<string, unknown>>;
      accessories: Array<Record<string, unknown>>;
      policies: Array<Record<string, unknown>>;
      playbooks: Array<Record<string, unknown>>;
    };
    unavailable: string[];
  };
}

function normalizeCustomerServiceStatus(status: CustomerServiceStatus): CustomerServiceStatus {
  const quality = status.quality as CustomerServiceStatus["quality"] | undefined;
  const replyAutomation = status.replyAutomation as CustomerServiceStatus["replyAutomation"] | undefined;

  return {
    ...status,
    accounts: status.accounts || {},
    workers: Array.isArray(status.workers) ? status.workers : [],
    accountLeases: Array.isArray(status.accountLeases) ? status.accountLeases : [],
    conversations: status.conversations || {},
    suggestions: status.suggestions || {},
    commands: status.commands || {},
    quality: {
      generatedTotal: quality?.generatedTotal || 0,
      averageConfidence: quality?.averageConfidence ?? null,
      belowThresholdTotal: quality?.belowThresholdTotal || 0,
      minimumAutoFillConfidence: quality?.minimumAutoFillConfidence ?? 0,
      reviewedTotal: quality?.reviewedTotal || 0,
      reviews: quality?.reviews || {},
      reviewReasons: quality?.reviewReasons || {},
      averageEditRatio: quality?.averageEditRatio ?? null,
      majorEditTotal: quality?.majorEditTotal || 0,
      inputTokens: quality?.inputTokens || 0,
      outputTokens: quality?.outputTokens || 0,
      totalTokens: quality?.totalTokens || 0,
      ...quality,
    },
    replyAutomation: {
      configured: false,
      enabled: false,
      draftFillEnabled: false,
      ...replyAutomation,
    },
  };
}

export function loadCustomerServiceStatus(signal?: AbortSignal) {
  return apiJson<{ status: CustomerServiceStatus }>("/api/customer-service/status", { signal })
    .then((response) => normalizeCustomerServiceStatus(response.status));
}

export function loadCustomerServiceQualityBreakdown(filters: {
  dimension?: CustomerServiceQualityDimension;
  accountId?: string;
  limit?: number;
} = {}, signal?: AbortSignal) {
  const query = new URLSearchParams();
  query.set("dimension", filters.dimension || "intent");
  if (filters.accountId) query.set("account_id", filters.accountId);
  query.set("limit", String(filters.limit || 20));
  return apiJson<{ quality: CustomerServiceQualityBreakdown }>(
    `/api/customer-service/quality-breakdown?${query}`,
    { signal },
  ).then((response) => response.quality);
}

export function loadCustomerServiceAccounts(signal?: AbortSignal) {
  return apiJson<{ accounts: CustomerServiceAccount[] }>("/api/customer-service/accounts", { signal })
    .then((response) => response.accounts || []);
}

export function createCustomerServiceAccount(input: {
  displayName: string;
  externalAccountKey?: string;
  countryCodes?: string[];
}) {
  return apiJson<{ account: CustomerServiceAccount }>("/api/customer-service/accounts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channel: "LIAOLIAO", ...input }),
  }).then((response) => response.account);
}

function customerServiceLocalRuntimePath(id: string, action?: "start" | "stop" | "retry") {
  const base = `/api/customer-service/accounts/${encodeURIComponent(id)}/local-runtime`;
  return action ? `${base}/${action}` : base;
}

function normalizeCustomerServiceLocalRuntime(
  response: CustomerServiceLocalRuntimeResponse,
  accountId: string,
): CustomerServiceLocalRuntime {
  const runtime = response.runtime || response;
  const rawStatus = String(runtime.state || runtime.status || "IDLE");
  const status = (rawStatus === "UNAVAILABLE" ? "FAILED" : rawStatus) as CustomerServiceLocalRuntimeStatus;
  return {
    accountId: String(runtime.accountId || accountId),
    status,
    workerId: runtime.workerId ? String(runtime.workerId) : null,
    sessionReady: runtime.sessionReady === true || ["SESSION_READY", "MONITOR_STARTING", "MONITORING"].includes(status),
    monitoring: runtime.monitoring === true || status === "MONITORING",
    retryable: runtime.canRetry === true
      || runtime.retryable === true
      || (runtime.lastError?.retryable !== false && ["IDLE", "STOPPED", "FAILED"].includes(status)),
    errorCode: runtime.errorCode ? String(runtime.errorCode) : runtime.lastError?.code ? String(runtime.lastError.code) : null,
    errorMessage: runtime.errorMessage ? String(runtime.errorMessage) : null,
    message: runtime.message ? String(runtime.message) : null,
    startedAt: runtime.startedAt ? String(runtime.startedAt) : null,
    updatedAt: runtime.updatedAt ? String(runtime.updatedAt) : null,
    pollAfterMs: Number.isFinite(Number(runtime.pollAfterMs)) ? Number(runtime.pollAfterMs) : null,
  };
}

function mutateCustomerServiceLocalRuntime(id: string, action: "start" | "stop" | "retry") {
  return apiJson<CustomerServiceLocalRuntimeResponse>(
    customerServiceLocalRuntimePath(id, action),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-commerce-ops-local-action": "1",
      },
      body: "{}",
    },
  ).then((response) => normalizeCustomerServiceLocalRuntime(response, id));
}

export function loadCustomerServiceLocalRuntime(id: string, signal?: AbortSignal) {
  return apiJson<CustomerServiceLocalRuntimeResponse>(
    customerServiceLocalRuntimePath(id),
    { signal, headers: { "x-commerce-ops-local-action": "1" } },
  ).then((response) => normalizeCustomerServiceLocalRuntime(response, id));
}

export function startCustomerServiceLocalRuntime(id: string) {
  return mutateCustomerServiceLocalRuntime(id, "start");
}

export function stopCustomerServiceLocalRuntime(id: string) {
  return mutateCustomerServiceLocalRuntime(id, "stop");
}

export function retryCustomerServiceLocalRuntime(id: string) {
  return mutateCustomerServiceLocalRuntime(id, "retry");
}

export function updateCustomerServiceAccountAutomation(id: string, mode: CustomerServiceAutomationMode) {
  return apiJson<{ account: CustomerServiceAccount }>(
    `/api/customer-service/accounts/${encodeURIComponent(id)}/automation`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode }),
    },
  ).then((response) => response.account);
}

export function loadCustomerServiceInbox(filters: {
  accountId?: string;
  status?: string;
  limit?: number;
} = {}, signal?: AbortSignal) {
  const query = new URLSearchParams();
  if (filters.accountId) query.set("account_id", filters.accountId);
  if (filters.status) query.set("status", filters.status);
  query.set("limit", String(filters.limit || 100));
  return apiJson<{ conversations: CustomerServiceInboxItem[] }>(`/api/customer-service/inbox?${query}`, { signal })
    .then((response) => response.conversations || []);
}

export function loadCustomerServiceConversation(id: string, signal?: AbortSignal) {
  return apiJson<CustomerServiceConversationDetail>(
    `/api/customer-service/conversations/${encodeURIComponent(id)}`,
    { signal },
  );
}

export function markCustomerServiceConversationHandled(id: string) {
  return apiJson<{ conversation: { id: string; status: "HANDLED"; handledAt: string } }>(
    `/api/customer-service/conversations/${encodeURIComponent(id)}/handled`,
    { method: "POST" },
  ).then((response) => response.conversation);
}

export function loadCustomerServiceContext(id: string, signal?: AbortSignal) {
  return apiJson<CustomerServiceContextDetail>(
    `/api/customer-service/conversations/${encodeURIComponent(id)}/context`,
    { signal },
  );
}

export function rebuildCustomerServiceContext(id: string) {
  return apiJson<CustomerServiceContextDetail>(
    `/api/customer-service/conversations/${encodeURIComponent(id)}/context/rebuild`,
    { method: "POST" },
  );
}

export function queueCustomerServiceReply(id: string) {
  return apiJson<{ suggestion: { id: string; status: CustomerServiceSuggestionStatus; duplicate: boolean } }>(
    `/api/customer-service/conversations/${encodeURIComponent(id)}/reply/queue`,
    { method: "POST" },
  ).then((response) => response.suggestion);
}

export function reviewCustomerServiceSuggestion(id: string, input: {
  action: "ACCEPT" | "EDIT" | "REJECT";
  finalText?: string;
  queueFill?: boolean;
  acknowledgeRisk?: boolean;
  reasonCode?: string;
  comment?: string;
}) {
  return apiJson<{ review: { id: string; status: CustomerServiceSuggestionStatus; reviewId: string; commandCreated: boolean } }>(
    `/api/customer-service/suggestions/${encodeURIComponent(id)}/review`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  ).then((response) => response.review);
}

export function confirmCustomerServiceShopBinding(bindingId: string, commerceShopId: string) {
  return apiJson<{ binding: { id: string; commerceShopId: string; identityStatus: string } }>(
    `/api/customer-service/shop-bindings/${encodeURIComponent(bindingId)}/confirm`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commerceShopId }),
    },
  ).then((response) => response.binding);
}
