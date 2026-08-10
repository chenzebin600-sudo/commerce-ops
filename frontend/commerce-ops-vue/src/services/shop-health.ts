import { apiJson } from "@/services/api";

export type HealthStatus = "healthy" | "warning" | "critical" | "unavailable";
export type AppealStatus = "pending_review" | "preparing" | "submitted" | "waiting_result" | "approved" | "rejected" | "closed";

export interface HealthSettings {
  tokenConfigured: boolean;
  tokenHint: string;
  tokenVerifiedAt: string | null;
  tokenShopCount: number;
  scheduleTime: string;
  timezone: string;
  retryCount: number;
  warningRatio: number;
  dingtalkConfigId: string | null;
  siteNotificationsEnabled: boolean;
  dingtalkNotificationsEnabled: boolean;
  enabled: boolean;
  lastKeyError: string | null;
  updatedAt: string;
}

export interface ShopHealthSnapshot {
  shopId: string;
  shopCode: string;
  shopName: string;
  country: string;
  status: HealthStatus;
  overallRating?: number | null;
  fulfillmentFailed?: number;
  listingFailed?: number;
  customerServiceFailed?: number;
  warningCount?: number;
  criticalCount?: number;
  penaltyPoints?: number;
  ongoingPunishments?: number;
  issueListingCount?: number;
  lateOrderCount?: number;
  metrics?: Array<{ metricId: number; metricName: string; metricType: number; currentPeriod: number | null; lastPeriod: number | null; unit: number; target: { value: number; comparator: string } }>;
  collectedAt?: string;
}

export interface HealthIssue {
  id: string;
  shopId: string;
  shopCode: string;
  shopName: string;
  country: string;
  issueType: string;
  severity: "warning" | "critical";
  title: string;
  reason: string | null;
  referenceId: string | null;
  metricId: number | null;
  currentValue: number | null;
  targetValue: number | null;
  comparator: string | null;
  details: Record<string, unknown>;
  firstSeenAt: string;
  lastSeenAt: string;
  status: "open" | "in_appeal" | "resolved";
}

export interface HealthAppeal {
  id: string;
  issueId: string;
  shopId: string;
  title: string;
  status: AppealStatus;
  assigneeUserId: string | null;
  assigneeName: string | null;
  dueDate: string | null;
  sellerCenterReference: string | null;
  evidence: Array<{ name: string; url: string }>;
  notes: string | null;
  resolution: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ThresholdConfig {
  metricId: number;
  metricName: string;
  warningValue: number | null;
  enabled: boolean;
  updatedAt?: string;
}

export interface HealthDashboard {
  generatedAt: string;
  monitoredShopCount: number;
  settings: HealthSettings;
  summary: { healthy: number; warning: number; critical: number; unavailable: number; activeIssues: number; openAppeals: number };
  shops: ShopHealthSnapshot[];
  issues: HealthIssue[];
  appeals: HealthAppeal[];
  trend: Array<{ date: string; shops: number; healthy: number; warning: number; critical: number; penaltyPoints: number; punishments: number }>;
  latestRun: Record<string, unknown> | null;
  notifications: HealthNotification[];
  unreadNotifications: number;
  thresholds: ThresholdConfig[];
}

export interface HealthNotification {
  id: string;
  severity: "info" | "warning" | "critical";
  title: string;
  message: string;
  readAt: string | null;
  createdAt: string;
}

export interface DingtalkConfig { id: string; name: string; enabled: boolean }

const json = (body: unknown) => ({ headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export function loadHealthDashboard(days = 30) {
  return apiJson<HealthDashboard>(`/api/shopee-health/dashboard?days=${days}`);
}
export function saveHealthSettings(input: Partial<HealthSettings> & { tokenKey?: string }) {
  return apiJson<HealthSettings>("/api/shopee-health/settings", { method: "PUT", ...json(input) });
}
export function testHealthKey() {
  return apiJson<{ recognizedShopCount: number; monitoredShopCount: number }>("/api/shopee-health/settings/test-key", { method: "POST" });
}
export function runHealthCollection() {
  return apiJson<{ started: boolean; run: Record<string, unknown> }>("/api/shopee-health/collect", { method: "POST" });
}
export function saveHealthThresholds(items: ThresholdConfig[]) {
  return apiJson<ThresholdConfig[]>("/api/shopee-health/thresholds", { method: "PUT", ...json({ items }) });
}
export function loadDingtalkConfigs() {
  return apiJson<{ configs: DingtalkConfig[] }>("/api/notifications/dingtalk/configs").then((result) => result.configs || []);
}
export function createHealthAppeal(issueId: string, input: Partial<HealthAppeal> = {}) {
  return apiJson<HealthAppeal>("/api/shopee-health/appeals", { method: "POST", ...json({ issueId, ...input }) });
}
export function updateHealthAppeal(id: string, input: Partial<HealthAppeal> & { eventNote?: string }) {
  return apiJson<HealthAppeal>(`/api/shopee-health/appeals/${encodeURIComponent(id)}`, { method: "PUT", ...json(input) });
}
export function markAllHealthNotificationsRead() {
  return apiJson<{ updated: number }>("/api/shopee-health/notifications/read-all", { method: "POST" });
}
