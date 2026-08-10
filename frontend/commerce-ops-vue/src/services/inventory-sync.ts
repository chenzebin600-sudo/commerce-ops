import { apiJson } from "@/services/api";

const BASE = "/api/inventory-sync";

export interface InventorySyncAccount {
  id: string;
  name: string;
  usernameMasked: string;
  enabled: boolean;
  passwordConfigured: boolean;
  lastVerifyStatus: string;
}

export interface InventorySyncShop { id: string; name: string; site: string }
export interface InventorySyncWarehouse { id?: string; name: string; rowCount: number; availableQuantity: number; loaded?: boolean }
export interface InventoryPrepareProgress { accountProfileId: string; stage: string; percent: number; message: string; terminal: boolean; updatedAt: string; startedAt?: string; elapsedMs?: number; metrics?: { loginMs?: number; shopReadMs?: number; inventoryReadMs?: number; totalMs?: number } }
export interface InventoryPreviewProgress extends InventoryPrepareProgress { fetchedCount: number; totalCount: number; page: number; pageCount: number; elapsedMs: number }
export interface InventoryPoolInput { id: string; name: string; shopIds: string[]; warehouseNames: string[] }
export interface InventoryConfigImportRow {
  id: string;
  sourceRow: number;
  shopCode: string;
  shopName: string;
  platform: string;
  countryCode: string;
  syncMode: string;
  sourceWarehouses: string[];
  matchedWarehouses: string[];
  shopId: string;
  matchedShopName: string;
  ready: boolean;
  issues: string[];
  warnings: string[];
}
export interface InventoryConfigImportPreview {
  filename: string;
  sheetName: string;
  rows: InventoryConfigImportRow[];
  inventoryPools: InventoryPoolInput[];
  summary: {
    total: number;
    ready: number;
    needsReview: number;
    shopee: number;
    lazada: number;
    inventoryPoolCount: number;
    warningCount: number;
    selectedPlatform?: string;
  };
}

export interface InventorySyncItem {
  platform: string;
  shopId: string;
  shopName: string;
  internalId: string;
  productId: string;
  title: string;
  variationId: string;
  sellerSku: string;
  stockSku: string;
  currentStock: number;
  targetStock: number | null;
  inventoryAvailable?: number;
  sharedTargetCount?: number;
  inventoryPoolId?: string;
  inventoryPoolName?: string;
  status: "READY" | "UNCHANGED" | "BLOCKED";
  reasonCode: string;
}

export interface InventorySyncPlan {
  id: string;
  operationType?: string;
  state: string;
  planHash: string;
  scope: { platform?: "shopee" | "lazada"; accountProfileId: string; shopIds: string[]; warehouseNames: string[]; inventoryPools?: InventoryPoolInput[]; selectedProducts?: Array<{ shopId: string; internalId: string }>; selectedItems?: Array<{ shopId: string; internalId: string; variationId: string }>; excludedProducts?: Array<{ shopId: string; internalId: string }>; productBatch?: { number: number; count: number; totalReadyProductCount: number } | null };
  sourceSnapshot: { capturedAt: string; expiresAt: string; rowCount: number; mabangCacheUpdateTime?: string | null; inventoryPools?: Array<{ id: string; name: string; warehouseNames: string[]; readyStockSkus?: string[] }>; listingRead?: { shopCount?: number; pageCount?: number; listingCount?: number; durationMs?: number; fresh?: boolean } };
  policy: { safetyStock: number; perListingCap: number; allocationMode: string; multiWarehouseMode?: "block" | "single_largest" | "proportional" };
  items: InventorySyncItem[];
  summary: { listingCount: number; variantCount: number; readyCount: number; unchangedCount: number; blockedCount: number; uniqueProductCount: number; inventoryPoolCount?: number; skippedInventoryPoolCount?: number; totalReadyProductCount?: number; selectedReadyProductCount?: number | null; selectedReadyVariantCount?: number | null; productBatchNumber?: number; productBatchCount?: number; totalProductCount?: number; totalVariantCount?: number; totalReadyVariantCount?: number; totalUnchangedVariantCount?: number; totalBlockedVariantCount?: number; blockedOnlyProductCount?: number; deferredProductCount?: number; deferredVariantCount?: number; remainingReadyProductCount?: number };
  result?: Record<string, unknown>;
  expiresAt: string;
  createdAt: string;
  approvedAt?: string | null;
  finishedAt?: string | null;
  lastErrorCode?: string | null;
  lastErrorMessage?: string | null;
}

export interface SkuRebindItem {
  platform: string;
  shopId: string;
  shopName: string;
  internalId: string;
  productId: string;
  title: string;
  variationId: string;
  inventoryPoolId?: string;
  inventoryPoolName?: string;
  fromSku: string;
  toSku: string;
  productKey: string;
  targetAvailable: number | null;
  status: "READY" | "BLOCKED";
  reasonCode: string;
}

export interface SkuRebindVerificationRow {
  shopId: string;
  shopName: string;
  internalId: string;
  variationId: string;
  fromSku: string;
  toSku: string;
  observedSku: string;
  status: "VERIFIED" | "MISMATCH";
}

export interface SkuRebindPlan extends Omit<InventorySyncPlan, "items" | "summary" | "sourceSnapshot" | "result"> {
  items: SkuRebindItem[];
  summary: { candidateCount: number; readyCount: number; blockedCount: number; uniqueProductCount: number };
  sourceSnapshot: { sourcePlanId: string; sourcePlanHash: string; snapshotId: string; capturedAt: string; inventoryScopeHash: string };
  result?: {
    jobId?: string;
    state?: string;
    verification?: { totalCount: number; verifiedCount: number; failedCount: number; rows: SkuRebindVerificationRow[] };
    [key: string]: unknown;
  };
}

export interface SkuRebindProgress {
  planId: string;
  stage: "IDLE" | "QUEUED" | "VALIDATING" | "PREFLIGHT" | "SUBMITTING" | "PROCESSING" | "READBACK" | "RECOVERING" | "SUCCEEDED" | "FAILED" | "UNKNOWN" | "BLOCKED" | "EXPIRED";
  percent: number;
  message: string;
  totalCount: number;
  processedCount: number;
  successfulCount: number;
  failedCount: number;
  skippedCount?: number;
  adjustedCount?: number;
  jobId?: string | null;
  terminal: boolean;
  updatedAt: string;
}

export interface InventoryContinuousRun {
  id: string;
  platform?: "shopee" | "lazada";
  state: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";
  message: string;
  startingPlanId: string;
  currentPlanId: string;
  completedBatches: number;
  estimatedBatches: number;
  successfulProducts: number;
  failedProducts: number;
  exceptionCount: number;
  exceptions: Array<Record<string, unknown>>;
  terminal: boolean;
  stage?: string;
  batchProcessed?: number;
  batchTotal?: number;
  batchSuccessful?: number;
  batchFailed?: number;
  updatedAt: string;
}

export interface LazadaRunMonitor {
  runId: string;
  platform: "lazada";
  mode: "execute" | "preview";
  pid: number | null;
  alive?: boolean;
  state: "IDLE" | "RUNNING" | "STALLED" | "SUCCEEDED" | "PARTIAL" | "NO_CHANGES" | "FAILED";
  stage: string;
  stageLabel: string;
  message: string;
  startedAt: string | null;
  updatedAt: string | null;
  heartbeatAt: string | null;
  finishedAt: string | null;
  reportPath: string | null;
  terminal: boolean;
  counts: Record<string, number>;
  problem: { code: string; message: string; details?: Array<Record<string, unknown>> } | null;
}

export function loadInventorySyncStatus() {
  return apiJson<{ mode: string; platform: string; officialApiRequired: boolean; accounts: InventorySyncAccount[]; plans: InventorySyncPlan[]; rebindPlans: SkuRebindPlan[]; continuousRuns?: InventoryContinuousRun[] }>(`${BASE}/status`);
}

export function loadLazadaRunMonitor() {
  return apiJson<{ monitor: LazadaRunMonitor | null }>(`${BASE}/lazada-run-monitor`);
}

export function loadInventoryOperationPlan(planId: string) {
  return apiJson<{ plan: InventorySyncPlan | SkuRebindPlan }>(`${BASE}/plans/${encodeURIComponent(planId)}`);
}

export function prepareInventorySync(accountProfileId: string, platform: "shopee" | "lazada" = "shopee", forceRefresh = false, warehouseNames: string[] = []) {
  return apiJson<{
    snapshot: { id: string; capturedAt: string; expiresAt: string; rowCount: number; compactRowCount?: number; cacheUpdateTime?: string | null; hash: string; reused?: boolean; scoped?: boolean; scopeWarehouseNames?: string[]; readMetrics?: { loginMs?: number; shopReadMs?: number; inventoryReadMs?: number; totalMs?: number } | null; sourceMode?: string; sourcePageCount?: number };
    shops: InventorySyncShop[];
    warehouses: InventorySyncWarehouse[];
    inventoryPools?: InventoryPoolInput[];
  }>(`${BASE}/prepare`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accountProfileId, platform, forceRefresh, warehouseNames }),
  });
}

export function previewInventoryConfigImport(input: { accountProfileId: string; snapshotId: string; platform: "shopee" | "lazada"; filename: string; fileBase64: string }) {
  return apiJson<InventoryConfigImportPreview>(`${BASE}/config-import/preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function loadInventoryPrepareProgress(accountProfileId: string) {
  return apiJson<{ progress: InventoryPrepareProgress }>(`${BASE}/prepare-progress?accountProfileId=${encodeURIComponent(accountProfileId)}`);
}

export function loadInventoryPreviewProgress(accountProfileId: string) {
  return apiJson<{ progress: InventoryPreviewProgress }>(`${BASE}/preview-progress?accountProfileId=${encodeURIComponent(accountProfileId)}`);
}

export function previewInventorySync(input: { snapshotId: string; accountProfileId: string; platform: "shopee" | "lazada"; inventoryPools: InventoryPoolInput[]; safetyStock: number; perListingCap: number; multiWarehouseMode: "block" | "single_largest" | "proportional"; productBatchNumber?: number; selectedProducts?: Array<{ shopId: string; internalId: string }>; selectedItems?: Array<{ shopId: string; internalId: string; variationId: string }>; excludedProducts?: Array<{ shopId: string; internalId: string }> }) {
  return apiJson<{ plan: InventorySyncPlan; approvalText: string }>(`${BASE}/preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function approveInventorySync(planId: string, planHash: string, approvalText: string) {
  return apiJson<{ plan: InventorySyncPlan }>(`${BASE}/plans/${encodeURIComponent(planId)}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ planHash, approvalText }),
  });
}

export function executeInventorySync(planId: string, planHash: string) {
  return apiJson<{ plan: InventorySyncPlan }>(`${BASE}/plans/${encodeURIComponent(planId)}/execute`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ planHash }),
  });
}

export function startInventorySync(planId: string, planHash: string) {
  return apiJson<{ plan: InventorySyncPlan; progress: SkuRebindProgress }>(`${BASE}/plans/${encodeURIComponent(planId)}/execute-start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ planHash }),
  });
}

export function loadInventorySyncProgress(planId: string) {
  return apiJson<{ plan: InventorySyncPlan; progress: SkuRebindProgress }>(`${BASE}/plans/${encodeURIComponent(planId)}/progress`);
}

export function startContinuousInventorySync(planId: string, approvalText: string) {
  return apiJson<{ run: InventoryContinuousRun }>(`${BASE}/plans/${encodeURIComponent(planId)}/continuous-start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ approvalText }),
  });
}

export function loadContinuousInventorySync(runId: string) {
  return apiJson<{ run: InventoryContinuousRun }>(`${BASE}/continuous/${encodeURIComponent(runId)}`);
}

export function previewSkuRebind(sourcePlanId: string, sourcePlanHash: string, mappings: Array<{ fromSku: string; toSku: string }> = []) {
  return apiJson<{ plan: SkuRebindPlan; approvalText: string }>(`${BASE}/rebind/preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourcePlanId, sourcePlanHash, mappings }),
  });
}

export function approveSkuRebind(planId: string, planHash: string, approvalText: string) {
  return apiJson<{ plan: SkuRebindPlan }>(`${BASE}/rebind/plans/${encodeURIComponent(planId)}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ planHash, approvalText }),
  });
}

export function executeSkuRebind(planId: string, planHash: string) {
  return apiJson<{ plan: SkuRebindPlan }>(`${BASE}/rebind/plans/${encodeURIComponent(planId)}/execute`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ planHash }),
  });
}

export function startSkuRebind(planId: string, planHash: string) {
  return apiJson<{ plan: SkuRebindPlan; progress: SkuRebindProgress }>(`${BASE}/rebind/plans/${encodeURIComponent(planId)}/execute-start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ planHash }),
  });
}

export function loadSkuRebindProgress(planId: string) {
  return apiJson<{ plan: SkuRebindPlan; progress: SkuRebindProgress }>(`${BASE}/rebind/plans/${encodeURIComponent(planId)}/progress`);
}
