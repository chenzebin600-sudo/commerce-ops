export type CountryCode = string;

export type PlatformCode = "SHOPEE" | "LAZADA" | "TIKTOK" | "UNMAPPED";

export type DataMode = "DEMO" | "READINESS";

export type DirectionCode =
  | "QUIET_ENTRY"
  | "PRIORITY_GROWTH"
  | "DEFEND_WINNER"
  | "SUPPLY_CONSTRAINED"
  | "CROSS_COUNTRY_CANDIDATE";

export type TaskPriority = "P0" | "P1" | "P2" | "P3";

export type TaskStatus =
  | "NEW"
  | "ACKNOWLEDGED"
  | "IN_PROGRESS"
  | "MONITORING"
  | "RESOLVED"
  | "BLOCKED"
  | "DISMISSED"
  | "REOPENED";

export type TaskType =
  | "STORE_ASSORTMENT_GAP"
  | "SALES_DECLINE"
  | "INVENTORY_RISK"
  | "NEW_PRODUCT"
  | "QUIET_ENTRY"
  | "CROSS_COUNTRY_CANDIDATE"
  | "DATA_CONFIGURATION";

export type StoreState =
  | "ACTION_REQUIRED"
  | "WATCH"
  | "STABLE"
  | "BLOCKED";

export type TrendState =
  | "GROWING"
  | "DECLINING"
  | "STABLE"
  | "NEWLY_SELLING"
  | "INSUFFICIENT_HISTORY";

export type ReadinessState = "READY" | "PARTIAL" | "BLOCKED";

export interface TaskEvidence {
  label: string;
  value: string;
  detail?: string;
}

export interface OperationTask {
  id: string;
  persisted?: boolean;
  revision?: number;
  priority: TaskPriority;
  type: TaskType;
  title: string;
  discovery: string;
  recommendation: string;
  shopName: string;
  countryCode: CountryCode | "UNMAPPED";
  countryName: string;
  platform: PlatformCode | "UNMAPPED";
  manager: string;
  category: string;
  skuCount: number;
  status: TaskStatus;
  firstSeen: string;
  lastHit: string;
  dueAt?: string;
  snoozedUntil?: string;
  evidence: TaskEvidence[];
  blockedReason?: string;
}

export interface TaskEvent {
  id: string;
  taskRevision: number;
  eventType: string;
  fromStatus?: TaskStatus;
  toStatus: TaskStatus;
  actorUserId: string;
  actorType: "user" | "system";
  reasonCode?: string;
  note?: string;
  occurredAt: string;
}

export interface StoreSummary {
  id: string;
  shopName: string;
  countryCode: CountryCode | "UNMAPPED";
  countryName: string;
  platform: PlatformCode | "UNMAPPED";
  manager: string;
  current7d: number | null;
  previous7d: number | null;
  trendPercent: number | null;
  trendState: TrendState;
  highPerformanceCoverage: number | null;
  activeTaskCount: number;
  severeAnomalyCount: number;
  state: StoreState;
  updatedAt: string;
  blocker?: string;
}

export interface OpportunityCell {
  countryCode: CountryCode;
  countryName: string;
  category: string;
  opportunityCount: number;
  highPerformanceSkuCount: number;
  lowCaptureSkuCount: number;
  inventoryReadySkuCount: number;
}

export interface ProductInsight {
  key: string;
  rank: number;
  sku: string;
  name: string;
  countryCode: CountryCode;
  countryName: string;
  category: string;
  predictedDailySales: number;
  ownSales28d: number;
  current7d: number;
  previous7d: number;
  captureRatio: number;
  available: number;
  inbound: number;
  coverageDays: number | null;
  direction: DirectionCode;
  marketPercentile: number;
  trendState: TrendState;
  trendPercent: number | null;
  sourceLabel: string;
}

export interface ReadinessItem {
  key: string;
  label: string;
  current: number;
  target: number;
  unit: string;
  state: ReadinessState;
  detail: string;
  nextAction: string;
}

export interface CountryMappingRow {
  key: string;
  warehouseName: string;
  normalizedWarehouseName?: string;
  rowCount?: number;
  countryCode?: string;
  countryName?: string;
  status: "UNMAPPED" | "DRAFT" | "CONFIRMED";
  lastUpdated?: string;
}

export interface ShopMappingRow {
  key: string;
  sourceShopName: string;
  platform: PlatformCode;
  internalShopId?: string;
  internalShopName?: string;
  countryCode?: string;
  countryName?: string;
  manager?: string;
  missingFields?: string[];
  status: "UNMAPPED" | "DRAFT" | "CONFIRMED";
}

export interface MetricSummary {
  key: string;
  label: string;
  value: number;
  delta?: number;
  tone: "danger" | "warning" | "positive" | "info";
  description: string;
  targetView: string;
}

export interface TrendSeries {
  dates: string[];
  current: number[];
  previous: number[];
}
