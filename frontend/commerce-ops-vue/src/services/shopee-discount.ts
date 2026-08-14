import { apiJson } from "./api.ts";

const BASE = "/api/shopee-discount";
const ROUTES = Object.freeze({
  status: "/status",
  shops: "/shops",
  previews: "/previews",
  runs: "/runs",
  activities: "/activities",
  issues: "/issues",
  scans: "/scans",
});

export type DiscountTier = "DAILY" | "EVENT" | "MEGA";
export type DiscountWorkflow = "CURRENT_CORRECTION" | "NEXT_RENEWAL";
export type DiscountPlanState = "PREVIEWING" | "PREVIEWED" | "APPROVED" | "EXECUTING" | "PARTIAL_SUCCESS" | "SUCCEEDED" | "FAILED" | "BLOCKED" | "EXPIRED" | "CANCELLED";
export type DiscountRunState = "PENDING" | "RUNNING" | "PARTIAL_SUCCESS" | "SUCCEEDED" | "FAILED" | "BLOCKED";

export interface DiscountWriteGate {
  enabled: boolean;
  mode: "trusted_single_role" | "separate_execute_identity" | null;
  privilegedApprovalRequired: boolean;
  reasonCode: string;
  switchProtected: boolean;
  managedAttestationPresent: boolean;
  listenerPrivate: boolean;
  trustedProxy: boolean;
  whitelistConfigured: boolean;
  batchCapConfigured: boolean;
  transportSecure: boolean;
  independentExecuteIdentity: boolean;
}

export interface DiscountStatus {
  storageMode: { dialect: "sqlite" | "postgres"; productionScale: boolean; pilotLimits: { shops: number; variants: number } | null };
  writeSecurity: DiscountWriteGate;
  enabled: boolean;
  warehouseConfigured: boolean;
}

export interface DiscountShop {
  shopId: string;
  name: string;
  country: string;
  healthy: boolean;
}

export interface TierOverride { shopId: string; priceTier: DiscountTier }
export interface LinkTierOverride extends TierOverride { itemId: string; note?: string }
export interface ActivityTierSelection extends TierOverride { discountId: string }

export interface CreateDiscountPreviewInput {
  country: string;
  shopIds: string[];
  useDefaultShops: boolean;
  workflow: DiscountWorkflow;
  defaultTier: DiscountTier;
  shopOverrides: TierOverride[];
  linkOverrides: LinkTierOverride[];
  activitySelection: ActivityTierSelection[];
  category: string;
  renewal?: { requestedStartAt: string; durationDays: number };
}

export interface DiscountSummary {
  counts?: Record<string, number>;
  codes?: Record<string, number>;
  shopCount?: number;
  shardCount?: number;
  merkleRoot?: string;
  confirmationText?: string;
  writeSecurity?: DiscountWriteGate;
  [key: string]: unknown;
}

export interface DiscountPreview {
  id: string;
  foundationPlanId?: string | null;
  country: string;
  state: DiscountPlanState;
  merkleRoot: string;
  policyHash: string;
  itemCount: number;
  shardCount?: number;
  stateVersion?: number;
  targetStartsAt?: string | null;
  targetEndsAt?: string | null;
  sourceSnapshotHash?: string;
  expiresAt?: string | null;
  sealedAt?: string | null;
  approvedAt?: string | null;
  createdBy?: string;
  retentionUntil?: string | null;
  confirmationText: string;
  reasonCode?: string | null;
  summary: DiscountSummary;
  createdAt?: string;
  updatedAt?: string;
}

export interface DiscountPreviewItem {
  id: string;
  shopId: string;
  itemId: string;
  modelId: string;
  sku: string;
  currency: string;
  scale: number;
  currentPriceMinor: string;
  controlPriceMinor?: string | null;
  targetPriceMinor: string;
  executionStatus?: string | null;
  executionReasonCode?: string | null;
  payload: {
    priceTier?: DiscountTier;
    priceSource?: string;
    ruleSource?: string;
    originalMinor?: string;
    stock?: number;
    activity?: { discountId?: string; startsAt?: string | number | null; endsAt?: string | number | null } | null;
    [key: string]: unknown;
  };
}

export interface DiscountPage<T> { items: T[]; nextCursor: string | number | null }

export interface DiscountRun {
  id: string;
  planId: string;
  foundationTaskId?: string | null;
  jobType: string;
  status: DiscountRunState;
  ownerId?: string | null;
  epoch?: number;
  leaseUntil?: string | null;
  cursor?: Record<string, unknown>;
  input?: Record<string, unknown>;
  counters?: Record<string, number>;
  result?: Record<string, unknown>;
  lastErrorCode?: string | null;
  createdBy?: string;
  startedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  finishedAt?: string | null;
}

export interface DiscountActivity {
  id: string;
  planId: string;
  shopId: string;
  activityType: string;
  platformActivityId?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  status: string;
  metadata?: Record<string, unknown>;
}

export interface DiscountIssue {
  id: string;
  planId?: string | null;
  jobId?: string | null;
  intentId?: string | null;
  eventType?: string;
  code?: string | null;
  evidence?: Record<string, unknown>;
  occurredAt?: string | null;
}

export interface DiscountScanJob {
  id: string;
  jobType: string;
  dedupeKey: string;
  dueAt: string;
  status: string;
  ownerId?: string | null;
  epoch?: number;
  leaseUntil?: string | null;
  payload?: Record<string, unknown>;
  result?: Record<string, unknown>;
  lastErrorCode?: string | null;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string | null;
}

export interface DiscountSettings { enabled: boolean; timezone: string; warehouseConfigured: boolean; warehouseKeyHint?: string | null; warehouseKeyReference?: string | null; warehouseKeyVerifiedAt?: string | null; updatedAt?: string | null; updatedBy?: string | null }
export interface DiscountOverrideLookupRow { shopId: string; shopName: string; itemId: string; sku: string; variantCount: number; finalTier?: DiscountTier | null; ruleSource?: string | null; note?: string | null }
export interface DiscountOverrideLookup { query: string; parsedItemId?: string | null; rows: DiscountOverrideLookupRow[] }
export interface DiscountUnknownIntent { intentId: string; id: string; planId: string; jobId: string; operationUuid: string; targetType: string; targetKey: string; status: "UNKNOWN"; reasonCode?: string | null; dispatchedAt?: string | null }
export interface DiscountOverrideBatchEcho extends DiscountOverrideLookupRow { index: number; status: "READY" | "ERROR"; query: string; errorCode?: string }

export type DiscountRequestLane = "dashboard" | "operationalSnapshot" | "preview" | "approve" | "execute" | "items" | "scan";
export interface DiscountRequestBinding { scopeKey?: string; planId?: string; merkleRoot?: string }
export interface DiscountRequestTicket { lane: DiscountRequestLane; generation: number; bindingKey: string }

export interface DiscountPageFlowState {
  preview: DiscountPreview | null;
  previewing: boolean;
  approving: boolean;
  executing: boolean;
  itemLoading: boolean;
  operatorName: string;
  confirmationInput: string;
}

function requestBindingKey(binding: DiscountRequestBinding) {
  return JSON.stringify(Object.fromEntries(Object.entries(binding).sort(([left], [right]) => left.localeCompare(right))));
}

export class DiscountRequestGuard {
  private readonly generations = new Map<DiscountRequestLane, number>();

  begin(lane: DiscountRequestLane, binding: DiscountRequestBinding): DiscountRequestTicket {
    const generation = (this.generations.get(lane) || 0) + 1;
    this.generations.set(lane, generation);
    return Object.freeze({ lane, generation, bindingKey: requestBindingKey(binding) });
  }

  invalidate(lane: DiscountRequestLane) {
    this.generations.set(lane, (this.generations.get(lane) || 0) + 1);
  }

  invalidatePlan() {
    this.invalidate("preview");
    this.invalidatePlanDependents();
  }

  invalidatePlanDependents() {
    for (const lane of ["approve", "execute", "items"] as const) this.invalidate(lane);
  }

  invalidateAll() {
    for (const lane of ["dashboard", "operationalSnapshot", "preview", "approve", "execute", "items", "scan"] as const) this.invalidate(lane);
  }

  isCurrent(ticket: DiscountRequestTicket, binding: DiscountRequestBinding) {
    return this.generations.get(ticket.lane) === ticket.generation
      && ticket.bindingKey === requestBindingKey(binding);
  }
}

export class DiscountPageFlowController {
  private readonly state: DiscountPageFlowState;
  readonly requestGuard: DiscountRequestGuard;
  private disposed = false;

  constructor(state: DiscountPageFlowState, requestGuard = new DiscountRequestGuard()) {
    this.state = state;
    this.requestGuard = requestGuard;
  }

  beginPreview(scopeKey: string) {
    this.requestGuard.invalidatePlan();
    this.state.preview = null;
    this.state.operatorName = "";
    this.state.confirmationInput = "";
    this.state.approving = false;
    this.state.executing = false;
    this.state.itemLoading = false;
    this.state.previewing = true;
    return this.requestGuard.begin("preview", { scopeKey });
  }

  acceptPreview(ticket: DiscountRequestTicket, scopeKey: string, preview: DiscountPreview) {
    if (!this.requestGuard.isCurrent(ticket, { scopeKey })) return false;
    this.requestGuard.invalidatePlanDependents();
    this.state.preview = preview;
    this.state.operatorName = "";
    this.state.confirmationInput = "";
    return true;
  }

  finishPreview(ticket: DiscountRequestTicket, scopeKey: string) {
    if (!this.requestGuard.isCurrent(ticket, { scopeKey })) return false;
    this.state.previewing = false;
    return true;
  }

  canApprove(baseAllowed: boolean) { return baseAllowed && !this.state.previewing; }
  canExecute(baseAllowed: boolean) { return baseAllowed && !this.state.previewing; }

  beginOperationalSnapshot() {
    return this.requestGuard.begin("operationalSnapshot", {});
  }

  isOperationalSnapshotCurrent(ticket: DiscountRequestTicket) {
    return !this.disposed && this.requestGuard.isCurrent(ticket, {});
  }

  commitOperationalSnapshot(ticket: DiscountRequestTicket, apply: () => void) {
    if (!this.isOperationalSnapshotCurrent(ticket)) return false;
    apply();
    return true;
  }

  invalidateRequests() {
    this.requestGuard.invalidateAll();
  }

  dispose() {
    this.disposed = true;
    this.invalidateRequests();
  }
}

export function discountPreviewInputKey(input: CreateDiscountPreviewInput) {
  return JSON.stringify(input);
}

function query(values: Record<string, string | number | null | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== null && value !== undefined && value !== "") search.set(key, String(value));
  const text = search.toString();
  return text ? `?${text}` : "";
}

function previewRoute(planId: string, suffix = "") {
  return `${BASE}${ROUTES.previews}/${encodeURIComponent(planId)}${suffix}`;
}

export function loadDiscountStatus() {
  return apiJson<DiscountStatus>(`${BASE}${ROUTES.status}`);
}

export function loadDiscountShops() {
  return apiJson<DiscountShop[]>(`${BASE}${ROUTES.shops}`);
}

export function createDiscountPreview(input: CreateDiscountPreviewInput) {
  return apiJson<DiscountPreview>(`${BASE}${ROUTES.previews}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  });
}

export function loadDiscountPreview(planId: string) {
  return apiJson<DiscountPreview>(previewRoute(planId));
}

export function loadDiscountPreviewItems(planId: string, filters: { cursor?: string | number | null; pageSize?: number; shopId?: string; status?: string; code?: string } = {}) {
  return apiJson<DiscountPage<DiscountPreviewItem>>(`${previewRoute(planId, "/items")}${query(filters)}`);
}

export function approveDiscountPreview(input: {
  planId: string;
  merkleRoot: string;
  operatorName: string;
  confirmationText: string;
  privilegedApproval?: { planId: string; merkleRoot: string; policyHash: string; expiresAt: string };
}) {
  return apiJson<DiscountPreview>(previewRoute(input.planId, "/approve"), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  });
}

export function executeDiscountPreview(input: { planId: string; merkleRoot: string }) {
  return apiJson<DiscountRun>(previewRoute(input.planId, "/execute"), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  });
}

export function loadDiscountRuns(filters: { status?: string; planId?: string; limit?: number } = {}) {
  return apiJson<DiscountRun[]>(`${BASE}${ROUTES.runs}${query(filters)}`);
}

export function loadDiscountActivities(filters: { shopId?: string; status?: string; limit?: number } = {}) {
  return apiJson<DiscountActivity[]>(`${BASE}${ROUTES.activities}${query(filters)}`);
}

export function loadDiscountIssues(filters: { planId?: string; code?: string; limit?: number } = {}) {
  return apiJson<DiscountIssue[]>(`${BASE}${ROUTES.issues}${query(filters)}`);
}

export function requestDiscountScan(country: string, shopIds: string[]) {
  return apiJson<DiscountScanJob>(`${BASE}${ROUTES.scans}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ country, shopIds }),
  });
}

export function loadDiscountSettings() { return apiJson<DiscountSettings>(`${BASE}/settings`); }
export function saveDiscountSettings(input: { enabled?: boolean; timezone?: string; warehouseKey?: string; warehouseKeyReference?: string }) {
  return apiJson<DiscountSettings>(`${BASE}/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
}
export function verifyDiscountSettings() { return apiJson<DiscountSettings>(`${BASE}/settings/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); }
export function lookupDiscountOverrides(input: { country: string; shopIds: string[]; query: string; limit?: number; priceTier?: DiscountTier; note?: string }) {
  return apiJson<DiscountOverrideLookup>(`${BASE}/overrides/lookup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
}
export function lookupDiscountOverrideBatch(input: { country: string; rows: Array<{ shopId: string; query: string; priceTier: DiscountTier; note: string }> }) {
  return apiJson<{ country: string; rowCount: number; rows: DiscountOverrideBatchEcho[] }>(`${BASE}/overrides/lookup-batch`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
}
export function loadDiscountUnknownIntents(limit = 50) { return apiJson<DiscountUnknownIntent[]>(`${BASE}/intents${query({ limit })}`); }
export function loadDiscountIntent(intentId: string) { return apiJson<Record<string, unknown>>(`${BASE}/intents/${encodeURIComponent(intentId)}`); }
export function reconcileDiscountIntent(intentId: string, resolution: "LINK_VERIFIED_OBJECT" | "CONFIRMED_NOT_SENT" | "ABANDONED", evidence?: Record<string, unknown>) {
  return apiJson<Record<string, unknown>>(`${BASE}/intents/${encodeURIComponent(intentId)}/reconcile`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ resolution, evidence }) });
}
