import { apiJson } from "@/services/api";

export async function loadAdvertisingStatus() {
  return apiJson<{ url: string; started?: boolean; ok?: boolean }>("/api/ad-analyzer/status", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
}

export function loadAdvertisingFiles() {
  return apiJson<{ files: Array<Record<string, unknown>>; total: number }>("/api/files?page=1&page_size=100&scope=ads");
}

export interface ShopeeAdvertisingMetricWindow {
  impression: number;
  expense: number;
  clicks: number;
  conversions: number;
  gmv: number;
  roas: number;
  ctr: number;
  cvr: number;
}

export interface ShopeeAdvertisingRow {
  adKey: string;
  adName: string;
  productId: string;
  priority: "P0" | "P1" | "WAITING" | "NORMAL";
  ruleCode: string;
  diagnosis: string;
  action: string;
  guardrail: string;
  confidence: "high" | "medium" | "low";
  mode: "auto" | "custom" | "unknown";
  status: string;
  biddingMethod: string;
  startDate: string | null;
  ageDays: number | null;
  inLearning: boolean;
  sampleEnough: boolean;
  targetAttainment: number | null;
  fourteenTrend: number | null;
  targetRoas: number | null;
  detail: {
    campaignType: "individual" | "ad_group" | "shop_gmv_max" | "new_product";
    stage: "learning" | "stabilizing" | "new_product" | "mature";
    bottleneck: string;
    evidence: string[];
    actionSteps: string[];
    suggestedAdjustment: string;
    observationWindow: string;
    successSignal: string;
    stopSignal: string;
    healthChecklist: string[];
    missingData: string[];
    dailySpend: number | null;
  };
  day: ShopeeAdvertisingMetricWindow | null;
  seven: ShopeeAdvertisingMetricWindow | null;
  fourteen: ShopeeAdvertisingMetricWindow | null;
  previousFourteen: ShopeeAdvertisingMetricWindow | null;
  long: ShopeeAdvertisingMetricWindow | null;
}

export interface ShopeeAdvertisingDashboard {
  empty: boolean;
  selectedShopId?: string;
  shops: Array<{ shopId: string; shopName: string }>;
  batches: Array<Record<string, unknown>>;
  dayBatch?: Record<string, unknown> | null;
  sevenBatch?: Record<string, unknown> | null;
  fourteenBatch?: Record<string, unknown> | null;
  previousFourteenBatch?: Record<string, unknown> | null;
  longBatch?: Record<string, unknown> | null;
  evidenceReady?: boolean;
  coverage?: { day: boolean; seven: boolean; fourteen: boolean; previousFourteen: boolean; long: boolean };
  targets?: Array<Record<string, unknown>>;
  summary: null | {
    reportDate: string;
    day: Record<string, number> | null;
    dayProduct: Record<string, number> | null;
    seven: Record<string, number> | null;
    sevenProduct: Record<string, number> | null;
    fourteen: Record<string, number> | null;
    fourteenProduct: Record<string, number> | null;
    previousFourteenProduct: Record<string, number> | null;
    targetCoverage: number;
    p0Count: number;
    p1Count: number;
    waitingCount: number;
    matureCount: number;
    learningCount: number;
    insufficientCount: number;
    holdCount: number;
  };
  findings: ShopeeAdvertisingRow[];
  rows: ShopeeAdvertisingRow[];
}

export function loadShopeeAdvertisingDashboard(shopId = "") {
  const query = shopId ? `?shop_id=${encodeURIComponent(shopId)}` : "";
  return apiJson<ShopeeAdvertisingDashboard>(`/api/shopee-advertising/dashboard${query}`);
}

export function importShopeeAdvertisingCsv(filename: string, csvText: string) {
  return apiJson<{ batch: Record<string, unknown>; duplicate: boolean }>("/api/shopee-advertising/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ filename, csvText }),
  });
}

export function deleteShopeeAdvertisingBatch(batchId: string) {
  return apiJson<{ batch: Record<string, unknown>; deletedFacts: number }>(`/api/shopee-advertising/batches/${encodeURIComponent(batchId)}`, {
    method: "DELETE",
  });
}

export function saveShopeeAdvertisingTargets(input: {
  shopId: string;
  effectiveFrom: string;
  sourceType: "manual" | "screenshot" | "import";
  targets: Array<{ targetKey: string; productId: string; adName: string; targetRoas: number }>;
}) {
  return apiJson<{ saved: number }>("/api/shopee-advertising/targets", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}
