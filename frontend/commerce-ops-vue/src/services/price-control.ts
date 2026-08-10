import { apiJson } from "./api";

export interface PriceControlStatus {
  schemaReady: boolean;
  adjustmentWorkflowReady: boolean;
  automationReady: boolean;
  sourceConfigured: boolean;
  syncEnabled: boolean;
  manualSyncEnabled: boolean;
  syncIntervalMs: number;
  batchLimit: number;
  batchesPerScope: number;
  approvalStatus: string;
  repricing: {
    workflowReady: boolean;
    executionProviders: Array<"MABANG_LISTING" | "PLATFORM_GATEWAY">;
    limits: { maxSourceChanges: number; maxShopAssignments: number };
  };
  source: { connected: boolean; checked: boolean; serverVersion?: string; databaseName?: string; transactionReadOnly?: boolean; error?: string };
}

export interface PriceControlOverview {
  totalChanges: number;
  upCount: number;
  downCount: number;
  affectedSkuCount: number;
  latestDetectedAt: string | null;
  currentPriceCount: number;
  currentSkuCount: number;
  latestEffectiveAt: string | null;
  filters: {
    countries: string[];
    categories: string[];
    batches: Array<{ applyNo: string; countryCode: string; effectiveAt: string }>;
  };
}

export interface PriceChange {
  id: string;
  syncRunId: string;
  sourceApplyNo: string;
  priceKey: string;
  countryCode: string;
  categoryName: string | null;
  sku: string;
  productNameCn: string | null;
  platform: "LAZADA" | "SHOPEE" | "TIKTOK";
  shopType: "STANDARD" | "MALL";
  priceType: "REGULAR" | "CAMPAIGN" | "MEGA_CAMPAIGN";
  oldPrice: string | null;
  newPrice: string | null;
  deltaValue: string | null;
  deltaPercent: number | null;
  direction: "UP" | "DOWN" | "NEW" | "REMOVED";
  changeText: string;
  foundationTaskId: string | null;
  validityStatus: "VALID" | "INVALID";
  invalidReason: string | null;
  invalidatedAt: string | null;
  invalidatedBy: string | null;
  adjustmentStatus: "UNADJUSTED" | "ADJUSTED";
  adjustmentRemark: string | null;
  adjustmentUpdatedAt: string | null;
  adjustmentUpdatedBy: string | null;
  detectedAt: string;
}

export interface PriceChangeRound {
  id: string;
  triggerType: string;
  firstDetectedAt: string;
  lastDetectedAt: string;
  sourceBusinessUpdatedAt: string | null;
  sourceTableUpdatedAt: string | null;
  fetchedAt: string | null;
  changeCount: number;
  affectedSkuCount: number;
  adjustedCount: number;
  unadjustedCount: number;
}

export interface PriceChangeResult {
  changes: PriceChange[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface PriceControlRun {
  id: string;
  triggerType: string;
  syncMode: string;
  status: string;
  sourceRowsSeen: number;
  changeCount: number;
  notificationStatus: "SENT" | "SKIPPED" | "FAILED" | "NOT_CONFIGURED" | null;
  notifiedAt: string | null;
  notificationErrorCode: string | null;
  watermarkAt: string | null;
  sourceCheckedAt: string | null;
  sourceTableUpdatedAt: string | null;
  sourceBusinessUpdatedAt: string | null;
  fetchedAt: string | null;
  createdAt: string;
}

export interface PriceControlAutomationSettings {
  enabled: boolean;
  intervalMinutes: number;
  dingtalkConfigId: string | null;
  notifyOnChange: boolean;
  notifyOnFailure: boolean;
  lastRunAt: string | null;
  lastRunStatus: "SUCCEEDED" | "FAILED" | "PARTIAL_SUCCESS" | null;
  lastNotificationAt: string | null;
  lastNotificationStatus: "SENT" | "SKIPPED" | "FAILED" | "NOT_CONFIGURED" | null;
  nextRunAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  updatedAt: string | null;
}

export interface PriceControlRobot {
  id: string;
  name: string;
  enabled: boolean;
  webhookConfigured: boolean;
  secretConfigured: boolean;
  atAll: boolean;
  atMobiles: string[];
}

export interface PriceControlAutomation {
  ready: boolean;
  settings: PriceControlAutomationSettings | null;
  robots: PriceControlRobot[];
  defaults: { intervalMinutes: number; minimumIntervalMinutes: number };
}

export interface CurrentPrice {
  priceKey: string;
  countryCode: string;
  categoryName: string | null;
  sku: string;
  productNameCn: string | null;
  skuStatus: string | null;
  platform: "LAZADA" | "SHOPEE" | "TIKTOK";
  shopType: "STANDARD" | "MALL";
  priceType: "REGULAR" | "CAMPAIGN" | "MEGA_CAMPAIGN";
  priceValue: string;
  sourceApplyNo: string;
  effectiveAt: string;
  revision: number;
  updatedAt: string | null;
}

export interface CurrentPriceResult {
  prices: CurrentPrice[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface CommerceShop {
  id: string;
  platform: "LAZADA" | "SHOPEE" | "TIKTOK";
  providerShopId: string;
  shopName: string;
  countryCode: string;
  controlShopType: "STANDARD" | "MALL" | "ALL" | "UNKNOWN";
  executionProvider: "MABANG_LISTING" | "PLATFORM_GATEWAY";
  status: "ACTIVE" | "INACTIVE";
}

export interface PriceControlRepricingItem {
  id: string;
  sourceChangeId: string;
  registryShopId: string;
  platform: "LAZADA" | "SHOPEE" | "TIKTOK";
  countryCode: string;
  sku: string;
  matchedSku: string;
  skuMatchType: "exact" | "virtual" | "unknown";
  controlShopType: CommerceShop["controlShopType"];
  priceType: PriceChange["priceType"];
  targetField: "price" | "special_price";
  shopName: string;
  oldValue: string | number | null;
  newValue: string | number | null;
  selected: boolean;
  status: "PREVIEWED" | "SUBMITTED" | "SUCCEEDED" | "FAILED" | "SKIPPED" | "EXECUTION_UNKNOWN";
}

export interface PriceControlRepricingPlan {
  id: string;
  sourceRoundId: string;
  executionProvider: "MABANG_LISTING" | "PLATFORM_GATEWAY";
  status: "PREVIEW_READY" | "CONFIRMING" | "EXECUTING" | "EXECUTION_UNKNOWN" | "SUCCEEDED" | "PARTIAL" | "FAILED" | "EXPIRED" | "CANCELLED";
  instructionText: string;
  previewFingerprint: string;
  previewCreatedAt: string;
  previewExpiresAt: string;
  targetShopCount: number;
  listingChangeCount: number;
  warnings: string[];
  selectedItemIds: string[];
  executionJobId: string | null;
  executionState: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  items: PriceControlRepricingItem[];
}

export async function loadPriceControlStatus(probe = false) {
  const result = await apiJson<{ status: PriceControlStatus }>(`/api/price-control/status${probe ? "?probe=1" : ""}`);
  return result.status;
}

export async function loadPriceControlOverview() {
  const result = await apiJson<{ overview: PriceControlOverview }>("/api/price-control/overview");
  return result.overview;
}

export async function loadPriceChanges(query: Record<string, string | number | undefined>) {
  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== "") parameters.set(key, String(value));
  return apiJson<PriceChangeResult>(`/api/price-control/changes?${parameters}`);
}

export async function loadPriceChangeRounds(limit = 50) {
  return apiJson<{ rounds: PriceChangeRound[] }>(`/api/price-control/rounds?limit=${limit}`);
}

export async function copyPriceChangeRound(syncRunId: string) {
  return apiJson<{ round: PriceChangeRound; count: number; text: string }>(
    `/api/price-control/rounds/${encodeURIComponent(syncRunId)}/copy`,
  );
}

export async function updatePriceChangeAdjustment(changeId: string, input: {
  status: "UNADJUSTED" | "ADJUSTED";
  remark: string;
}) {
  return apiJson<{ change: PriceChange }>(
    `/api/price-control/changes/${encodeURIComponent(changeId)}/adjustment`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
}

export async function loadCurrentPrices(query: Record<string, string | number | undefined>) {
  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== "") parameters.set(key, String(value));
  return apiJson<CurrentPriceResult>(`/api/price-control/current-prices?${parameters}`);
}

export async function loadPriceControlRuns() {
  return apiJson<{ runs: PriceControlRun[] }>("/api/price-control/runs?page=1&page_size=10");
}

export async function loadPriceControlAutomation() {
  const result = await apiJson<{ automation: PriceControlAutomation }>("/api/price-control/automation");
  return result.automation;
}

export async function savePriceControlAutomation(input: {
  enabled: boolean;
  intervalMinutes: number;
  dingtalkConfigId: string | null;
  notifyOnChange: boolean;
  notifyOnFailure: boolean;
}) {
  return apiJson<{ settings: PriceControlAutomationSettings }>("/api/price-control/automation", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function runPriceControlSync(mode: "baseline" | "incremental") {
  return apiJson<{ run: PriceControlRun; changes: PriceChange[]; notificationText: string }>("/api/price-control/sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  });
}

export async function loadPriceControlShops(platform: PriceChange["platform"], countryCode: string) {
  const query = new URLSearchParams({ platform, country: countryCode });
  const result = await apiJson<{ shops: CommerceShop[] }>(`/api/price-control/shops?${query}`);
  return result.shops;
}

export async function createPriceControlRepricingPreview(input: {
  roundId: string;
  assignments: Array<{ changeId: string; shopIds: string[] }>;
}) {
  const result = await apiJson<{ plan: PriceControlRepricingPlan }>("/api/price-control/repricing/previews", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return result.plan;
}

export async function confirmPriceControlRepricingPlan(planId: string, input: {
  confirmed: true;
  confirmationText: string;
  previewFingerprint: string;
  selectedItemIds: string[];
  acknowledgeUnknownShopTypes: boolean;
}) {
  const result = await apiJson<{ plan: PriceControlRepricingPlan }>(
    `/api/price-control/repricing/plans/${encodeURIComponent(planId)}/confirm`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  return result.plan;
}

export async function refreshPriceControlRepricingPlan(planId: string) {
  const result = await apiJson<{ plan: PriceControlRepricingPlan }>(
    `/api/price-control/repricing/plans/${encodeURIComponent(planId)}/refresh`,
    { method: "POST" },
  );
  return result.plan;
}
