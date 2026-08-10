import { apiJson } from "./api";

export type ProfitPlatform = "ALL" | "LAZADA" | "SHOPEE";
export type ProfitDataStatus = "COMPLETE" | "PARTIAL" | "FAILED" | "EMPTY";
export type ProfitDecimal = number | string;
export type ProfitPreset = "CURRENT_BILLING_PERIOD" | "LAST_BILLING_PERIOD" | "CUSTOM";

export interface ProfitMetricCoverage {
  listRevenueShopCount: number;
  receivedRevenueShopCount: number;
  totalCostShopCount: number;
  knownCostShopCount: number;
  expenseShopCount: number;
  gmvShopCount: number;
  expenseRateShopCount: number;
  listProfitMarginShopCount: number;
  receivedProfitMarginShopCount: number;
  listToReceivedProfitMarginShopCount: number;
}

export interface ProfitMetrics {
  currency: string | null;
  dataStatus: ProfitDataStatus;
  mixedCurrency?: boolean;
  listRevenue: ProfitDecimal | null;
  receivedRevenue: ProfitDecimal | null;
  totalCost: ProfitDecimal | null;
  knownTotalCost: ProfitDecimal | null;
  expenseValue: ProfitDecimal | null;
  gmvValue: ProfitDecimal | null;
  knownGmvValue: ProfitDecimal | null;
  expenseRate: ProfitDecimal | null;
  advertisingExpenseSigned: ProfitDecimal | null;
  billingExpenseSigned: ProfitDecimal | null;
  expenseDataStatus: ProfitDataStatus;
  completeExpenseShopCount: number;
  partialExpenseShopCount: number;
  gmvDataStatus: ProfitDataStatus;
  completeGmvShopCount: number;
  partialGmvShopCount: number;
  expenseRateDataStatus: ProfitDataStatus;
  listProfitMargin: ProfitDecimal | null;
  receivedProfitMargin: ProfitDecimal | null;
  listToReceivedProfitMargin: ProfitDecimal | null;
  selectedOrderCount: number;
  missingOrderCount: number;
  missingCostLineCount: number;
  ambiguousCostLineCount: number;
  gmvOrderCount: number;
  confirmedGmvOrderCount: number;
  missingGmvOrderCount: number;
  conflictingGmvOrderCount: number;
  invalidGmvOrderCount: number;
  shopCount: number;
  completeShopCount: number;
  partialShopCount: number;
  failedShopCount: number;
  metricCoverage: ProfitMetricCoverage;
}

export interface ProfitExchangeRate {
  countryCode: string;
  status: "MATCHED" | "MISSING" | "AMBIGUOUS";
  rate: ProfitDecimal | null;
  direction: "local_per_cny" | "cny_per_local" | "equivalent" | null;
  sourceUpdatedAt: string | null;
}

export interface ProfitShop extends ProfitMetrics {
  id: string;
  platform: Exclude<ProfitPlatform, "ALL">;
  connectorShopId: string;
  canonicalShopId: string | null;
  shopCode: string;
  shopName: string;
  countryCode: string;
  financeRowCount: number;
  linkedOrderCount: number;
  evaluationOrderCount: number;
  costLineCount: number;
  matchedCostLineCount: number;
  warnings: Array<{ code: string; count?: number; message?: string }>;
  expenseDayCount: number;
  completeExpenseDayCount: number;
  expectedExpenseDayCount: number;
  advertisingExpenseRowCount: number;
  billingExpenseRowCount: number;
  duplicateExpenseGroupCount: number;
  duplicateExpenseRemovedCount: number;
  expenseIssues: string[];
  gmvSourceCoveredDayCount: number;
  expectedGmvDayCount: number;
  gmvSourceBatchCount: number;
  gmvMappingSources: string[];
  gmvRuleVersions: string[];
  gmvDateBasis: "MABANG_PAID_AT_ASIA_SHANGHAI";
  gmvIssues: string[];
  calculatedAt: string;
}

export interface ProfitCountry extends ProfitMetrics {
  countryCode: string;
  mixedCurrency: boolean;
  exchangeRate: ProfitExchangeRate | null;
  cnyEquivalent: {
    currency: "CNY";
    listRevenue: ProfitDecimal | null;
    receivedRevenue: ProfitDecimal | null;
    totalCost: ProfitDecimal | null;
    expenseValue: ProfitDecimal | null;
    gmvValue: ProfitDecimal | null;
    expenseRate: ProfitDecimal | null;
  };
  platforms: Array<ProfitMetrics & { platform: Exclude<ProfitPlatform, "ALL">; countryCode: string }>;
}

export interface ProfitRun {
  id: string;
  platform: Exclude<ProfitPlatform, "ALL">;
  dateFrom: string;
  dateTo: string;
  ruleVersion: string;
  status: "RUNNING" | "COMPLETE" | "PARTIAL" | "FAILED";
  currentStage: string;
  totalShopCount: number;
  financeSuccessCount: number;
  completeShopCount: number;
  partialShopCount: number;
  failedShopCount: number;
  selectedOrderCount: number;
  mabangSyncStatus: string;
  startedAt: string;
  completedAt: string | null;
}

export interface ProfitPeriod {
  platform: Exclude<ProfitPlatform, "ALL">;
  preset: ProfitPreset;
  accountingMonth: string | null;
  accountingRange: { dateFrom: string; dateTo: string };
  transactionRange: { dateFrom: string; dateTo: string };
  transactionCutoffDate?: string | null;
  cutoffApplied?: boolean;
}

export interface ProfitCoverage {
  status: "COVERED" | "PARTIAL" | "UNCOVERED";
  source: "RUN_COVERAGE";
  dateFrom: string;
  dateTo: string;
  dayCount: number;
  totalShopCount: number;
  coveredShopCount: number;
  missingShopCount: number;
  totalShopDays: number;
  coveredShopDays: number;
  missingShopDays: number;
  availableDateFrom: string | null;
  availableDateTo: string | null;
  latestCoverageAt: string | null;
}

export interface ProfitDashboard {
  platform: ProfitPlatform;
  ruleVersion: string;
  range: { dateFrom: string; dateTo: string };
  periods: ProfitPeriod[];
  run: ProfitRun | null;
  calculation: null | { mode: "SNAPSHOT" | "CACHED_PREVIEW"; calculatedAt: string | null; costBasis: string; sourceRunId: string | null };
  coverage: ProfitCoverage | null;
  automation: { enabled: boolean; timeZone: "Asia/Shanghai"; scheduleTime: string; mode: string; transactionCutoffDate?: string | null };
  filters: {
    platforms: Array<Exclude<ProfitPlatform, "ALL">>;
    countries: string[];
    shops: Array<{ id: string; shopCode: string; shopName: string; countryCode: string; currency: string; platform: Exclude<ProfitPlatform, "ALL"> }>;
  };
  selection: ProfitMetrics;
  countries: ProfitCountry[];
  platforms: Array<{ platform: Exclude<ProfitPlatform, "ALL">; period: ProfitPeriod; run: ProfitRun | null; coverage: ProfitCoverage; metrics: ProfitMetrics }>;
  shops: ProfitShop[];
  exchangeRates: ProfitExchangeRate[];
  snapshots: ProfitRun[];
  cnySummary: ProfitMetrics & {
    countryCode: "ALL";
    currency: "CNY";
    rateCoverage: {
      countryCount: number;
      convertedCountryCount: number;
      missingCountries: string[];
      ambiguousCountries: string[];
      sourceUpdatedAt: string | null;
    };
  };
}

export interface ProfitQuery {
  preset?: ProfitPreset;
  dateFrom?: string;
  dateTo?: string;
  platform?: ProfitPlatform;
  country?: string;
  shopId?: string;
}

function queryString(input: ProfitQuery) {
  const query = new URLSearchParams();
  if (input.preset) query.set("preset", input.preset);
  if (input.dateFrom) query.set("date_from", input.dateFrom);
  if (input.dateTo) query.set("date_to", input.dateTo);
  if (input.platform) query.set("platform", input.platform);
  if (input.country) query.set("country", input.country);
  if (input.shopId) query.set("shop_id", input.shopId);
  return query;
}

export function getProfitDashboard(input: ProfitQuery) {
  return apiJson<ProfitDashboard>(`/api/profit/dashboard?${queryString(input)}`);
}

export function startProfitSync(input: ProfitQuery) {
  return apiJson<{ accepted: boolean; platform: ProfitPlatform; outcomes: unknown[] }>("/api/profit/sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function getProfitStatus(input: ProfitQuery) {
  return apiJson<{ platform: ProfitPlatform; statuses: Array<{ platform: string; run: ProfitRun | null }> }>(`/api/profit/status?${queryString(input)}`);
}

export function importShopeeStatement(input: { file: File; countryCode: string; shopId: string }) {
  return apiJson<{ run: ProfitRun }>("/api/profit/shopee/import", {
    method: "POST",
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "x-file-name": encodeURIComponent(input.file.name),
      "x-country-code": input.countryCode,
      "x-shop-id": input.shopId,
    },
    body: input.file,
  });
}
