import { ApiError, apiJson } from "@/services/api";

export type CollectionHealth = "healthy" | "delayed" | "failed" | "unauthorized" | "never";
export type CollectionJobStatus = "running" | "success" | "failed" | "partial";
export type ReturnCaseStatus = "requested" | "processing" | "accepted" | "completed" | "cancelled";

export interface ReturnsCollectionSummary {
  totalShops: number;
  healthyShops: number;
  attentionShops: number;
  todayCases: number;
  activeCases: number;
  urgentCases: number;
  coverageRate: number;
}
export interface ReturnsCollectionShop {
  shopId: string;
  shopCode: string;
  shopName: string;
  country: string;
  health: CollectionHealth;
  authorizationStatus: "active" | "expired" | "missing";
  lastSyncAt: string | null;
  nextSyncAt: string | null;
  todayCollected: number;
  totalCases: number;
  latencyMinutes: number | null;
  consecutiveFailures: number;
  cursorUpdatedAt: string | null;
  latestError: string | null;
}

export interface ReturnsCollectionJob {
  id: string;
  shopId: string;
  shopName: string;
  country: string;
  type: "incremental" | "backfill" | "repair" | "detail";
  status: CollectionJobStatus;
  startedAt: string;
  finishedAt: string | null;
  scanned: number;
  inserted: number;
  updated: number;
  skipped: number;
  retries: number;
  error: string | null;
}

export interface ReturnCaseItem {
  sku: string;
  name: string;
  quantity: number;
  amount: number;
}

export interface CollectedReturnCase {
  returnSn: string;
  orderSn: string;
  shopId: string;
  shopName: string;
  country: string;
  buyerName: string;
  reason: string;
  status: ReturnCaseStatus;
  refundAmount: number;
  currency: string;
  logisticsStatus: string;
  createdAt: string;
  updatedAt: string;
  dueAt: string | null;
  complete: boolean;
  items: ReturnCaseItem[];
}

export interface ReturnsCollectionDashboard {
  source: "live" | "demo";
  generatedAt: string;
  summary: ReturnsCollectionSummary;
  shops: ReturnsCollectionShop[];
  jobs: ReturnsCollectionJob[];
  cases: CollectedReturnCase[];
}

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const later = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

let demoDashboard: ReturnsCollectionDashboard = {
  source: "demo",
  generatedAt: new Date().toISOString(),
  summary: {
    totalShops: 42,
    healthyShops: 36,
    attentionShops: 6,
    todayCases: 186,
    activeCases: 64,
    urgentCases: 9,
    coverageRate: 92.8,
  },
  shops: [
    { shopId: "10001201", shopCode: "TW-01", shopName: "台湾旗舰店", country: "TW", health: "healthy", authorizationStatus: "active", lastSyncAt: ago(2), nextSyncAt: later(3), todayCollected: 36, totalCases: 2841, latencyMinutes: 2, consecutiveFailures: 0, cursorUpdatedAt: ago(2), latestError: null },
    { shopId: "10001202", shopCode: "PH-02", shopName: "菲律宾生活馆", country: "PH", health: "failed", authorizationStatus: "expired", lastSyncAt: ago(186), nextSyncAt: null, todayCollected: 0, totalCases: 1849, latencyMinutes: 186, consecutiveFailures: 8, cursorUpdatedAt: ago(190), latestError: "Access Token 已失效，需要重新授权" },
    { shopId: "10001203", shopCode: "MY-03", shopName: "马来西亚家居店", country: "MY", health: "delayed", authorizationStatus: "active", lastSyncAt: ago(34), nextSyncAt: ago(29), todayCollected: 21, totalCases: 1236, latencyMinutes: 34, consecutiveFailures: 2, cursorUpdatedAt: ago(39), latestError: "连续两次请求触发站点限流" },
    { shopId: "10001204", shopCode: "SG-01", shopName: "新加坡精品店", country: "SG", health: "healthy", authorizationStatus: "active", lastSyncAt: ago(4), nextSyncAt: later(1), todayCollected: 18, totalCases: 906, latencyMinutes: 4, consecutiveFailures: 0, cursorUpdatedAt: ago(4), latestError: null },
    { shopId: "10001205", shopCode: "TH-04", shopName: "泰国数码配件店", country: "TH", health: "healthy", authorizationStatus: "active", lastSyncAt: ago(1), nextSyncAt: later(4), todayCollected: 42, totalCases: 3170, latencyMinutes: 1, consecutiveFailures: 0, cursorUpdatedAt: ago(1), latestError: null },
    { shopId: "10001206", shopCode: "VN-02", shopName: "越南日用百货", country: "VN", health: "never", authorizationStatus: "active", lastSyncAt: null, nextSyncAt: later(1), todayCollected: 0, totalCases: 0, latencyMinutes: null, consecutiveFailures: 0, cursorUpdatedAt: null, latestError: "新店铺等待首次历史回溯" },
    { shopId: "10001207", shopCode: "BR-01", shopName: "巴西优选店", country: "BR", health: "healthy", authorizationStatus: "active", lastSyncAt: ago(6), nextSyncAt: later(4), todayCollected: 29, totalCases: 758, latencyMinutes: 6, consecutiveFailures: 0, cursorUpdatedAt: ago(6), latestError: null },
  ],
  jobs: [
    { id: "JOB-260808-1048", shopId: "10001201", shopName: "台湾旗舰店", country: "TW", type: "incremental", status: "success", startedAt: ago(4), finishedAt: ago(2), scanned: 42, inserted: 4, updated: 11, skipped: 27, retries: 0, error: null },
    { id: "JOB-260808-1047", shopId: "10001205", shopName: "泰国数码配件店", country: "TH", type: "detail", status: "success", startedAt: ago(3), finishedAt: ago(1), scanned: 28, inserted: 0, updated: 28, skipped: 0, retries: 0, error: null },
    { id: "JOB-260808-1046", shopId: "10001203", shopName: "马来西亚家居店", country: "MY", type: "incremental", status: "failed", startedAt: ago(38), finishedAt: ago(34), scanned: 0, inserted: 0, updated: 0, skipped: 0, retries: 2, error: "error_limit: 站点请求频率受限，已进入退避队列" },
    { id: "JOB-260808-1045", shopId: "10001202", shopName: "菲律宾生活馆", country: "PH", type: "repair", status: "failed", startedAt: ago(190), finishedAt: ago(186), scanned: 0, inserted: 0, updated: 0, skipped: 0, retries: 3, error: "error_auth: Access Token 无效" },
    { id: "JOB-260808-1044", shopId: "10001206", shopName: "越南日用百货", country: "VN", type: "backfill", status: "running", startedAt: ago(8), finishedAt: null, scanned: 436, inserted: 421, updated: 0, skipped: 15, retries: 0, error: null },
    { id: "JOB-260808-1043", shopId: "10001207", shopName: "巴西优选店", country: "BR", type: "incremental", status: "partial", startedAt: ago(12), finishedAt: ago(6), scanned: 33, inserted: 3, updated: 24, skipped: 6, retries: 1, error: "2 条退货详情将在下一轮补采" },
  ],
  cases: [
    { returnSn: "250808TW8M3R2", orderSn: "250803TW4N9JQ", shopId: "10001201", shopName: "台湾旗舰店", country: "TW", buyerName: "li***88", reason: "商品损坏或瑕疵", status: "requested", refundAmount: 1280, currency: "TWD", logisticsStatus: "等待卖家处理", createdAt: ago(48), updatedAt: ago(2), dueAt: later(76), complete: true, items: [{ sku: "HOME-LAMP-WH", name: "可调光桌面阅读灯", quantity: 1, amount: 1280 }] },
    { returnSn: "250808PH6Q1P7", orderSn: "250801PH2K8XM", shopId: "10001202", shopName: "菲律宾生活馆", country: "PH", buyerName: "mar***a", reason: "收到错误商品", status: "processing", refundAmount: 899, currency: "PHP", logisticsStatus: "买家已寄回", createdAt: ago(240), updatedAt: ago(186), dueAt: later(14), complete: false, items: [{ sku: "KIT-BOX-04", name: "四件套厨房收纳盒", quantity: 1, amount: 899 }] },
    { returnSn: "250808MY4H7D9", orderSn: "250804MY9A2TC", shopId: "10001203", shopName: "马来西亚家居店", country: "MY", buyerName: "nur***n", reason: "商品与描述不符", status: "accepted", refundAmount: 76.5, currency: "MYR", logisticsStatus: "退货运输中", createdAt: ago(310), updatedAt: ago(34), dueAt: later(420), complete: true, items: [{ sku: "BATH-RACK-BK", name: "免打孔浴室置物架", quantity: 2, amount: 76.5 }] },
    { returnSn: "250808SG2V5L1", orderSn: "250806SG1R3BH", shopId: "10001204", shopName: "新加坡精品店", country: "SG", buyerName: "jo***ng", reason: "少件或漏发", status: "requested", refundAmount: 34.9, currency: "SGD", logisticsStatus: "仅退款审核中", createdAt: ago(82), updatedAt: ago(4), dueAt: later(32), complete: true, items: [{ sku: "CABLE-3IN1", name: "三合一快充数据线", quantity: 1, amount: 34.9 }] },
    { returnSn: "250807TH9T2C4", orderSn: "250731TH7P6DL", shopId: "10001205", shopName: "泰国数码配件店", country: "TH", buyerName: "pa***ee", reason: "商品无法使用", status: "processing", refundAmount: 649, currency: "THB", logisticsStatus: "等待买家寄回", createdAt: ago(820), updatedAt: ago(1), dueAt: later(19), complete: true, items: [{ sku: "HUB-USB-C-06", name: "USB-C 六合一扩展坞", quantity: 1, amount: 649 }] },
    { returnSn: "250807BR3F8K6", orderSn: "250729BR8E1WA", shopId: "10001207", shopName: "巴西优选店", country: "BR", buyerName: "an***os", reason: "包装内商品缺失", status: "completed", refundAmount: 119.9, currency: "BRL", logisticsStatus: "退款已完成", createdAt: ago(1740), updatedAt: ago(6), dueAt: null, complete: true, items: [{ sku: "TOOLS-SET-12", name: "家用工具组合套装", quantity: 1, amount: 119.9 }] },
  ],
};

function cloneDemo() {
  return structuredClone(demoDashboard);
}

export async function loadReturnsCollectionDashboard(): Promise<ReturnsCollectionDashboard> {
  try {
    return await apiJson<ReturnsCollectionDashboard>("/api/shopee-returns/dashboard");
  } catch (error) {
    if (error instanceof ApiError && [404, 501].includes(error.status)) return cloneDemo();
    throw error;
  }
}

export async function runReturnsCollection(shopIds: string[] = []): Promise<ReturnsCollectionDashboard> {
  try {
    return await apiJson<ReturnsCollectionDashboard>("/api/shopee-returns/collect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shopIds }),
    });
  } catch (error) {
    if (!(error instanceof ApiError) || ![404, 501].includes(error.status)) throw error;
    const targets = shopIds.length ? shopIds : demoDashboard.shops.filter((shop) => shop.authorizationStatus === "active").map((shop) => shop.shopId);
    const now = new Date().toISOString();
    for (const shop of demoDashboard.shops) {
      if (!targets.includes(shop.shopId) || shop.authorizationStatus !== "active") continue;
      shop.lastSyncAt = now;
      shop.nextSyncAt = later(5);
      shop.latencyMinutes = 0;
      shop.health = "healthy";
      shop.consecutiveFailures = 0;
      shop.latestError = null;
    }
    demoDashboard.jobs.unshift({
      id: `JOB-${Date.now()}`,
      shopId: shopIds.length === 1 ? shopIds[0] : "multi-shop",
      shopName: shopIds.length === 1 ? demoDashboard.shops.find((shop) => shop.shopId === shopIds[0])?.shopName || "未知店铺" : `${targets.length} 家店铺`,
      country: shopIds.length === 1 ? demoDashboard.shops.find((shop) => shop.shopId === shopIds[0])?.country || "-" : "ALL",
      type: "incremental",
      status: "running",
      startedAt: now,
      finishedAt: null,
      scanned: 0,
      inserted: 0,
      updated: 0,
      skipped: 0,
      retries: 0,
      error: null,
    });
    demoDashboard.generatedAt = now;
    return cloneDemo();
  }
}
