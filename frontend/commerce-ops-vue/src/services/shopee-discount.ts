import { apiJson } from "@/services/api";

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

export interface DiscountWriteGate {
  enabled?: boolean;
  mode?: string;
  ready?: boolean;
  reasonCode?: string | null;
  constraints?: { countries?: string[]; shops?: string[]; maxBatchItems?: number };
  [key: string]: unknown;
}

export interface DiscountStatus {
  storageMode: { mode?: string; productionScale?: boolean } | string;
  writeSecurity: DiscountWriteGate;
  enabled: boolean;
  warehouseConfigured: boolean;
}

export interface DiscountShop {
  shopId: string;
  shopName: string;
  country: string;
  healthy: boolean;
}

export interface TierOverride { shopId: string; priceTier: DiscountTier }
export interface LinkTierOverride extends TierOverride { itemId: string }
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
  country: string;
  state: string;
  merkleRoot: string;
  policyHash: string;
  itemCount: number;
  targetStartsAt?: string | null;
  targetEndsAt?: string | null;
  expiresAt?: string | null;
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
  jobType: string;
  status: string;
  counters?: Record<string, number>;
  result?: Record<string, unknown>;
  lastErrorCode?: string | null;
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
  targetStartsAt?: string | null;
  targetEndsAt?: string | null;
  status: string;
  metadata?: Record<string, unknown>;
}

export interface DiscountIssue {
  id: string;
  planId?: string | null;
  eventType?: string;
  reasonCode?: string | null;
  code?: string | null;
  evidence?: Record<string, unknown>;
  createdAt?: string;
}

export interface DiscountScanJob {
  id: string;
  jobType: string;
  dueAt: string;
  status: string;
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
