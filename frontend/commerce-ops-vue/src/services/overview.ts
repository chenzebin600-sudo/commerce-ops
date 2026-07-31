import { apiJson } from "./api";

export interface SalesDashboard {
  filters?: {
    selected?: Record<string, string | number>;
    options?: { countries?: string[]; categoryL1?: string[]; categoryL2?: string[]; styles?: string[] };
  };
  period?: { days?: number; orderDateFrom?: string | null; orderDateTo?: string | null; sufficient?: boolean };
  summary: {
    assortmentAmount: number;
    ownAmount: number;
    ownQuantity: number;
    ownShare: number;
    dailySalesGap: number;
    skuCount: number;
    storeCount: number;
  };
  hierarchy?: { dimension?: string; rows?: PerformanceRow[] };
  opportunityMatrix?: Array<PerformanceRow & { country?: string; category?: string; opportunityScore?: number }>;
  trend: Array<{ date: string; ownAmount: number; ownQuantity: number; assortmentDailyAmount: number }>;
  topProducts?: ProductRow[];
  stores: Array<{ store: string; platform: string; country: string; ownAmount: number; opportunityCount: number }>;
  quality?: { inventoryRows?: number; orderRows?: number; productPackageRows?: number; priceCoverage?: number; unmatchedInventoryProducts?: number };
}

export interface PerformanceRow {
  label: string;
  assortmentAmount?: number;
  predictedDailySales?: number;
  availableQuantity?: number;
  ownAmount?: number;
  ownQuantity?: number;
  ownShare?: number;
  dailySalesGap?: number;
  skuCount?: number;
}

export interface ProductRow extends PerformanceRow {
  key?: string;
  country?: string;
  productName?: string;
  categoryL1?: string;
  categoryL2?: string;
  style?: string;
  mainSku?: string;
  daysOfSupply?: number;
  gapAmount?: number;
}

export interface FulfillmentDashboard {
  shops?: Array<{ total?: number; success?: number; running?: number; exceptions?: number }>;
  exceptions?: Array<{ code?: string; count?: number }>;
  trend?: Array<{ date: string; shops?: Array<{ total?: number; success?: number; exceptions?: number }> }>;
}

export interface FulfillmentHealth {
  realSubmitEnabled?: boolean;
  shops?: Array<{ id: string; name: string; platform?: string; countryCode?: string; channelName?: string; autoFulfillEnabled?: boolean }>;
}

export interface FulfillmentScheduler {
  running?: boolean;
  nextScanAt?: string;
  lastScanAt?: string;
  lastOutcome?: string;
}

export interface FulfillmentBatch {
  id?: string;
  shopId?: string;
  status?: string;
  createdAt?: string;
  completedAt?: string;
  orderCount?: number;
  successCount?: number;
  failedCount?: number;
}

export interface FulfillmentRecovery {
  id?: string;
  shopId?: string;
  orderReference?: string;
  status?: string;
  reason?: string;
  updatedAt?: string;
}

export function loadSalesDashboard(filters: { periodDays: number; country?: string; categoryL1?: string; categoryL2?: string; style?: string }) {
  const query = new URLSearchParams({ period_days: String(filters.periodDays) });
  if (filters.country) query.set("country", filters.country);
  if (filters.categoryL1) query.set("category_l1", filters.categoryL1);
  if (filters.categoryL2) query.set("category_l2", filters.categoryL2);
  if (filters.style) query.set("style", filters.style);
  return apiJson<SalesDashboard>(`/api/sales-assortment/dashboard?${query}`);
}

export async function loadFulfillmentWorkspace() {
  const [health, scheduler, dashboard, batches, recoveries] = await Promise.all([
    apiJson<FulfillmentHealth>("/api/fulfillment-dashboard/health"),
    apiJson<FulfillmentScheduler>("/api/fulfillment-dashboard/scheduler"),
    apiJson<FulfillmentDashboard>("/api/fulfillment-dashboard/dashboard?days=7"),
    apiJson<FulfillmentBatch[]>("/api/fulfillment-dashboard/batches?limit=30"),
    apiJson<FulfillmentRecovery[]>("/api/fulfillment-dashboard/tracking-recoveries?limit=50"),
  ]);
  return { health, scheduler, dashboard, batches, recoveries };
}

export function runFulfillmentScan() {
  return apiJson<{ message?: string; outcome?: string }>("/api/fulfillment-dashboard/scheduler/scan", { method: "POST" });
}

export async function loadOperationsOverview(periodDays: number) {
  const [sales, fulfillment, health] = await Promise.allSettled([
    apiJson<SalesDashboard>(`/api/sales-assortment/dashboard?period_days=${periodDays}`),
    apiJson<FulfillmentDashboard>("/api/fulfillment-dashboard/dashboard?days=7"),
    apiJson<FulfillmentHealth>("/api/fulfillment-dashboard/health"),
  ]);
  return {
    sales: sales.status === "fulfilled" ? sales.value : null,
    fulfillment: fulfillment.status === "fulfilled" ? fulfillment.value : null,
    health: health.status === "fulfilled" ? health.value : null,
    warnings: [sales, fulfillment, health]
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => String(result.reason?.message || result.reason || "数据源暂不可用")),
  };
}
