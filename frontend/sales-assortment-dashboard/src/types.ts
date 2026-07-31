export type AuthorizedFetch = typeof fetch;

export type MabangSyncTaskType = "order_export" | "inventory_export";

export interface MabangAccountProfile {
  id: string;
  name: string;
  usernameMasked: string;
  enabled: boolean;
  passwordConfigured: boolean;
  lastVerifiedAt: string | null;
  lastVerifyStatus: string | null;
}

export interface DingtalkConfig {
  id: string;
  name: string;
  webhookConfigured: boolean;
  secretConfigured: boolean;
  enabled: boolean;
  notifyOnSuccess: boolean;
  notifyOnFailure: boolean;
  notifyOnEmpty: boolean;
  atAll: boolean;
  atMobiles: string[];
}

export interface MabangScheduledTask {
  id: string;
  taskType: MabangSyncTaskType;
  name: string;
  description: string;
  accountProfileId: string;
  accountName: string;
  accountUsernameMasked: string;
  accountAvailable: boolean;
  accountEnabled: boolean;
  dingtalkConfigId: string | null;
  dingtalkName?: string | null;
  scheduleType: "daily" | "weekly" | "monthly";
  scheduleConfig: {
    hour?: number;
    minute?: number;
    weekdays?: number[];
    day?: number | "last";
  };
  timezone: string;
  paymentDateMode: string;
  paymentDateConfig: Record<string, unknown>;
  filters: Array<Record<string, unknown>>;
  enabled: boolean;
  fileRetentionDays: number | "forever";
  notifyEnabled: boolean;
  catchUpEnabled: boolean;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  nextRunAt: string | null;
}

export interface MabangScheduledRun {
  id: string;
  taskId: string;
  taskName: string;
  taskType: MabangSyncTaskType;
  status: string;
  scheduledRunAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  detailRowCount: number;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface AutomationOverview {
  scheduler: {
    online: boolean;
    leaseUntil: string | null;
    updatedAt: string | null;
  };
  encryptionConfigured: boolean;
  accounts: MabangAccountProfile[];
  dingtalkConfigs: DingtalkConfig[];
  tasks: MabangScheduledTask[];
  runs: MabangScheduledRun[];
}

export interface AiInsight {
  type: string;
  title: string;
  reason: string;
  evidence: string[];
}

export interface AiRecommendation {
  priority: "P0" | "P1" | "P2" | "P3";
  title: string;
  action: string;
  reason: string;
  evidence: string[];
}

export interface SalesAssortmentAiStatus {
  configured: boolean;
  provider: string;
  model: string;
  promptVersion: string;
}

export interface SalesAssortmentAnalysis {
  id: string;
  generatedAt: string;
  provider: string;
  model: string;
  promptVersion: string;
  cached: boolean;
  scope: DashboardData["filters"]["selected"];
  period: DashboardData["period"];
  sources: Record<string, SourceRecord | null>;
  analysis: {
    headline: string;
    overview: string;
    conclusions: AiInsight[];
    recommendations: AiRecommendation[];
    risks: AiInsight[];
    dataLimitations: string[];
  };
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

export interface DashboardData {
  contract: {
    version: string;
    amountBasis: string;
    orderStatuses: string[];
    aggregationKey: string;
  };
  sourceStatus: {
    order: SourceRecord | null;
    inventory: SourceRecord | null;
    productPackage: SourceRecord | null;
  };
  filters: {
    selected: {
      country: string;
      categoryL1: string;
      categoryL2: string;
      style: string;
      periodDays: number;
    };
    options: {
      countries: string[];
      categoryL1: string[];
      categoryL2: string[];
      styles: string[];
    };
  };
  period: {
    days: number;
    orderDateFrom: string | null;
    orderDateTo: string | null;
    availableOrderDays: number;
    sufficient: boolean;
  };
  summary: {
    assortmentQuantity: number;
    assortmentAmount: number;
    predictedDailySales: number;
    availableQuantity: number;
    inTransitQuantity: number;
    ownQuantity: number;
    ownAmount: number;
    ownShare: number;
    dailySalesGap: number;
    skuCount: number;
    countryCount: number;
    productCount: number;
    storeCount: number;
  };
  hierarchy: {
    dimension: "country" | "categoryL1" | "categoryL2" | "style";
    rows: PerformanceRow[];
  };
  opportunityMatrix: Array<PerformanceRow & {
    country: string;
    category: string;
    opportunityScore: number;
  }>;
  trend: Array<{
    date: string;
    ownAmount: number;
    ownQuantity: number;
    assortmentDailyAmount: number;
  }>;
  topProducts: ProductRow[];
  stores: StoreRow[];
  quality: {
    inventoryRows: number;
    orderRows: number;
    productPackageRows: number;
    priceCoverage: number;
    unmatchedInventoryProducts: number;
  };
}

export interface PerformanceRow {
  label: string;
  assortmentQuantity: number;
  assortmentAmount: number;
  predictedDailySales: number;
  availableQuantity: number;
  inTransitQuantity: number;
  ownQuantity: number;
  ownAmount: number;
  ownShare: number;
  dailySalesGap: number;
  skuCount: number;
}

export interface ProductRow extends PerformanceRow {
  key: string;
  country: string;
  productName: string;
  categoryL1: string;
  categoryL2: string;
  style: string;
  mainSku: string;
  activity: string;
  isNew: boolean;
  productStatus: string;
  daysOfSupply: number;
  gapAmount: number;
}

export interface StoreRow {
  store: string;
  country: string;
  manager: string;
  platform: string;
  ownAmount: number;
  ownQuantity: number;
  countryShare: number;
  strength: string;
  weakness: string;
  opportunityCount: number;
  opportunityProducts: string[];
}
