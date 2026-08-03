import { apiJson } from "./api";

export interface SalesDashboard {
  sourceStatus?: {
    order: SourceRecord | null;
    inventory: SourceRecord | null;
    productPackage: SourceRecord | null;
  };
  filters?: {
    selected?: Record<string, string | number>;
    options?: { countries?: string[]; categoryL1?: string[]; categoryL2?: string[]; styles?: string[]; stores?: string[] };
  };
  period?: {
    days?: number;
    mode?: string;
    orderDateFrom?: string | null;
    orderDateTo?: string | null;
    sufficient?: boolean;
    comparisonDays?: number;
    comparisonSufficient?: boolean;
  };
  summary: {
    assortmentDailyAmount: number;
    assortmentAmount: number;
    ownAmount: number;
    ownQuantity: number;
    ownShare: number;
    dailySalesGap: number;
    gapAmount: number;
    ownDataDays: number;
    orderCount: number;
    averageOrderValue: number;
    skuCount: number;
    storeCount: number;
  };
  hierarchy?: { dimension?: string; rows?: PerformanceRow[] };
  opportunityMatrix?: Array<PerformanceRow & { country?: string; category?: string; opportunityScore?: number }>;
  trend: Array<{ date: string; ownAmount: number; ownQuantity: number; assortmentDailyAmount: number }>;
  topProducts?: ProductRow[];
  stores: Array<{ store: string; platform: string; country: string; ownAmount: number; opportunityCount: number }>;
  storeSalesTrend?: StoreSalesTrend[];
  productSalesRanking?: ProductSalesRanking[];
  storeAnomalies?: AnomalyGroup<StoreSalesTrend>;
  styleSalesTrend?: StyleSalesTrend[];
  styleAnomalies?: AnomalyGroup<StyleSalesTrend>;
  businessOpportunities?: BusinessOpportunity[];
  inventoryComparison?: {
    currentCollectedAt: string | null;
    previousCollectedAt: string | null;
    comparable: boolean;
  };
  inventoryInsights?: InventoryInsight[];
  priorityAlerts?: PriorityAlert[];
  dailyReport?: {
    version: string;
    reportDate: string | null;
    title: string;
    summary: {
      ownAmount: number;
      assortmentAmount: number;
      gapAmount: number;
      ownShare: number;
      orderCount: number;
      averageOrderValue: number;
      storeCount: number;
      productCount: number;
      priorityCount: number;
      storeAnomalyCount: number;
      storeGrowthCount?: number;
      productAnomalyCount: number;
      styleAnomalyCount?: number;
      styleGrowthCount?: number;
      inventoryChangeCount?: number;
    };
    delivery?: { preferred?: string; fallback?: string };
  };
  quality?: { inventoryRows?: number; orderRows?: number; productPackageRows?: number; priceCoverage?: number; unmatchedInventoryProducts?: number };
}

export interface SourceRecord {
  source_filename?: string;
  source_period?: string;
  row_count?: number;
  collected_at?: string;
  imported_at?: string;
  applied_at?: string;
  created_at?: string;
}

export interface DailySalesPoint {
  date: string;
  amount: number;
}

export type SalesTrendStatus = "decline" | "growth" | "new_activity" | "stable" | "data_insufficient";

export interface StoreSalesTrend {
  store: string;
  country: string;
  platform: string;
  manager: string;
  totalAmount: number;
  current7dAmount: number;
  previous7dAmount: number;
  currentAmount: number;
  previousAmount: number;
  comparisonDays: number;
  changeRate: number | null;
  amountChange: number;
  impactAmount: number;
  impactScore: number;
  trendStatus: SalesTrendStatus;
  priority: "P0" | "P1" | "P2" | "P3";
  points: DailySalesPoint[];
}

export interface StyleSalesTrend {
  country: string;
  style: string;
  categoryL1: string;
  categoryL2: string;
  currentQuantity: number;
  previousQuantity: number;
  comparisonDays: number;
  changeRate: number | null;
  quantityChange: number;
  impactQuantity: number;
  impactScore: number;
  trendStatus: SalesTrendStatus;
  priority: "P0" | "P1" | "P2" | "P3";
}

export interface AnomalyGroup<T> {
  comparisonDays: number;
  declines: T[];
  growth: T[];
}

export interface BusinessOpportunity extends PerformanceRow {
  key: string;
  country: string;
  categoryL1: string;
  categoryL2: string;
  style: string;
  assortmentDailySales: number;
  ownDailySales: number;
  ownDailySalesShare: number;
  inventoryValue: number;
  opportunityAmount: number;
  opportunityScore: number;
  children: Array<PerformanceRow & {
    country: string;
    productName: string;
    categoryL1: string;
    categoryL2: string;
    style: string;
    assortmentDailySales: number;
    ownDailySales: number;
    ownDailySalesShare: number;
    inventoryValue: number;
    opportunityAmount: number;
  }>;
}

export interface InventoryInsight {
  country: string;
  productName: string;
  style: string;
  categoryL1: string;
  categoryL2: string;
  type: "stockout" | "low_stock" | "rapid_drop" | "new_arrival" | "restock_arrival" | "observe";
  priority: "P0" | "P1" | "P2" | "P3";
  ownDailySales: number;
  predictedDailySales: number;
  assortmentDailyAmount: number;
  assortmentAmount: number;
  ownAmount: number;
  inventoryValue: number;
  availableQuantity: number;
  inTransitQuantity: number;
  daysOfSupply: number;
  previousAvailableQuantity: number | null;
  inventoryChange: number | null;
  inventoryChangeRate: number | null;
  currentInventoryCollectedAt: string | null;
  previousInventoryCollectedAt: string | null;
  lastInboundAt: string | null;
  action: string;
}

export interface ProductSalesRanking {
  rank: number;
  current7dRank: number | null;
  previous7dRank: number | null;
  rankChange: number | null;
  country: string;
  productName: string;
  mainSku: string;
  categoryL1: string;
  categoryL2: string;
  style: string;
  ownAmount: number;
  ownQuantity: number;
  current7dAmount: number;
  previous7dAmount: number;
  changeRate: number | null;
  trendStatus: SalesTrendStatus;
  priority: "P0" | "P1" | "P2" | "P3";
  points: DailySalesPoint[];
}

export interface PriorityAlert {
  id: string;
  priority: "P0" | "P1" | "P2" | "P3";
  type: "store_decline" | "product_decline" | "inventory_risk";
  entityType: "store" | "product";
  entityName: string;
  title: string;
  summary: string;
  metricLabel: string;
  metricValue: string;
  action: string;
  evidence: string[];
}

export interface PerformanceRow {
  label: string;
  assortmentDailyAmount?: number;
  assortmentAmount?: number;
  predictedDailySales?: number;
  availableQuantity?: number;
  ownAmount?: number;
  ownQuantity?: number;
  ownShare?: number;
  dailySalesGap?: number;
  ownDataDays?: number;
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

interface FulfillmentSchedulerResponse {
  scanning?: boolean;
  nextRunAt?: string;
  lastRunAt?: string;
  lastOutcome?: string;
}

interface FulfillmentBatchResponse {
  id?: string;
  status?: string;
  createdAt?: string;
  finishedAt?: string;
  shop?: { id?: string };
  orders?: Array<{ status?: string }>;
}

interface FulfillmentRecoveryResponse {
  orderKey?: string;
  displayOrderId?: string;
  shopId?: string;
  status?: string;
  submittedAt?: string;
  lastCheckedAt?: string;
  completedAt?: string;
  lastErrorCode?: string | null;
  lastErrorMessage?: string | null;
  originErrorCode?: string | null;
}

export interface SalesDashboardFilters {
  periodDays: number;
  dateFrom?: string;
  dateTo?: string;
  comparisonDays?: number;
  country?: string;
  categoryL1?: string;
  categoryL2?: string;
  style?: string;
  store?: string;
  forceRefresh?: boolean;
}

function salesDashboardQuery(filters: SalesDashboardFilters) {
  const query = new URLSearchParams({ period_days: String(filters.periodDays) });
  if (filters.dateFrom) query.set("date_from", filters.dateFrom);
  if (filters.dateTo) query.set("date_to", filters.dateTo);
  if (filters.comparisonDays) query.set("comparison_days", String(filters.comparisonDays));
  if (filters.country) query.set("country", filters.country);
  if (filters.categoryL1) query.set("category_l1", filters.categoryL1);
  if (filters.categoryL2) query.set("category_l2", filters.categoryL2);
  if (filters.style) query.set("style", filters.style);
  if (filters.store) query.set("store", filters.store);
  if (filters.forceRefresh) query.set("force_refresh", "1");
  return query;
}

export function loadSalesDashboard(filters: SalesDashboardFilters, signal?: AbortSignal) {
  return apiJson<SalesDashboard>(`/api/sales-assortment/dashboard?${salesDashboardQuery(filters)}`, { signal });
}

export function loadSalesTrend(filters: SalesDashboardFilters, signal?: AbortSignal) {
  return apiJson<SalesDashboard["trend"]>(`/api/sales-assortment/trend?${salesDashboardQuery(filters)}`, { signal });
}

export async function loadFulfillmentWorkspace() {
  const [health, schedulerResponse, dashboard, batchResponses, recoveryResponses] = await Promise.all([
    apiJson<FulfillmentHealth>("/api/fulfillment-dashboard/health"),
    apiJson<FulfillmentSchedulerResponse>("/api/fulfillment-dashboard/scheduler"),
    apiJson<FulfillmentDashboard>("/api/fulfillment-dashboard/dashboard?days=7"),
    apiJson<FulfillmentBatchResponse[]>("/api/fulfillment-dashboard/batches?limit=30"),
    apiJson<FulfillmentRecoveryResponse[]>("/api/fulfillment-dashboard/tracking-recoveries?limit=50"),
  ]);
  const scheduler: FulfillmentScheduler = {
    running: schedulerResponse.scanning,
    nextScanAt: schedulerResponse.nextRunAt,
    lastScanAt: schedulerResponse.lastRunAt,
    lastOutcome: schedulerResponse.lastOutcome,
  };
  const batches: FulfillmentBatch[] = (Array.isArray(batchResponses) ? batchResponses : []).map((batch) => {
    const orders = Array.isArray(batch.orders) ? batch.orders : [];
    return {
      id: batch.id,
      shopId: batch.shop?.id,
      status: batch.status,
      createdAt: batch.createdAt,
      completedAt: batch.finishedAt,
      orderCount: orders.length,
      successCount: orders.filter((order) => order.status === "success").length,
      failedCount: orders.filter((order) => order.status && order.status !== "success").length,
    };
  });
  const recoveries: FulfillmentRecovery[] = (Array.isArray(recoveryResponses) ? recoveryResponses : []).map((recovery) => ({
    id: recovery.orderKey,
    shopId: recovery.shopId,
    orderReference: recovery.displayOrderId,
    status: recovery.status,
    reason: recovery.lastErrorMessage || recovery.lastErrorCode || recovery.originErrorCode || undefined,
    updatedAt: recovery.completedAt || recovery.lastCheckedAt || recovery.submittedAt,
  }));
  return { health, scheduler, dashboard, batches, recoveries };
}

export function runFulfillmentScan() {
  return apiJson<{ message?: string; outcome?: string }>("/api/fulfillment-dashboard/scheduler/scan", { method: "POST" });
}

export async function loadOperationsOverview(periodDays: number, signal?: AbortSignal) {
  const [sales, fulfillment, health] = await Promise.allSettled([
    apiJson<Pick<SalesDashboard, "summary" | "trend" | "stores">>(`/api/sales-assortment/overview?period_days=${periodDays}`, { signal }),
    apiJson<FulfillmentDashboard>("/api/fulfillment-dashboard/dashboard?days=7", { signal }),
    apiJson<FulfillmentHealth>("/api/fulfillment-dashboard/health", { signal }),
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
