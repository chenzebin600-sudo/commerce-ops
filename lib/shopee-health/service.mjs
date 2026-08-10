import { decryptSecret, encryptSecret } from "../mabang-scheduler/crypto.mjs";
import { sendDingtalkMessage } from "../mabang-scheduler/dingtalk.mjs";
import { SHOPEE_HEALTH_SHOPS } from "./shops.mjs";

const PATHS = Object.freeze({
  performance: "/api/v2/account_health/get_shop_performance",
  metricDetail: "/api/v2/account_health/get_metric_source_detail",
  penalties: "/api/v2/account_health/get_penalty_point_history",
  punishments: "/api/v2/account_health/get_punishment_history",
  listings: "/api/v2/account_health/get_listings_with_issues",
  lateOrders: "/api/v2/account_health/get_late_orders",
});

const LISTING_REASONS = new Map([[1, "违禁商品"], [2, "假冒或知识产权侵权"], [3, "垃圾商品"], [4, "图片不当"], [5, "信息不足"], [6, "商城商品待改善"], [7, "其他商品待改善"], [8, "低质量商品"]]);
const PENALTY_REASONS = new Map([
  [5, "高迟发货率"], [6, "高未履约率"], [7, "未履约订单过多"], [8, "迟发订单过多"],
  [9, "违禁商品"], [10, "假冒或知识产权侵权"], [11, "垃圾商品"], [16, "预售商品比例过高"],
  [21, "未回复聊天过多"], [23, "要求买家取消订单"], [25, "违反退货退款政策"],
  [3060, "未履约率极高"], [3068, "次日达未履约率过高"], [3070, "次日达迟发率过高"],
  [3072, "准时取件失败率违规"], [4130, "商品质量不佳"],
]);
const PUNISHMENT_TYPES = new Map([
  [103, "商品不在分类浏览中展示"], [104, "商品不在搜索中展示"], [105, "无法创建新商品"],
  [106, "无法编辑商品"], [107, "无法参加营销活动"], [108, "取消运费补贴"], [109, "账号暂停"],
  [600, "商品搜索屏蔽"], [601, "店铺商品不再推荐"], [602, "商品分类浏览屏蔽"],
  [1109, "商品刊登上限降低"], [1110, "商品刊登上限降低"], [1111, "商品刊登上限降低"],
  [1112, "商品刊登上限降低"], [2008, "每日订单上限"],
]);
const TERMINAL_APPEAL_STATUSES = new Set(["approved", "rejected", "closed"]);

function responseOf(result) { return result?.data?.response || result?.data || {}; }
function localDate(date, timeZone = "Asia/Shanghai") {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const get = (type) => parts.find((item) => item.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
function localTime(date, timeZone = "Asia/Shanghai") {
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}
function number(value, fallback = 0) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback; }
function metricFailed(metric) {
  if (metric.current_period == null || metric.target?.value == null) return false;
  const current = Number(metric.current_period), target = Number(metric.target.value);
  if (!Number.isFinite(current) || !Number.isFinite(target)) return false;
  return ({ "<": current >= target, "<=": current > target, ">": current <= target, ">=": current < target, "=": current !== target })[metric.target.comparator] || false;
}
function metricWarning(metric, warningRatio, override) {
  if (metricFailed(metric) || metric.current_period == null || metric.target?.value == null) return false;
  const current = Number(metric.current_period), target = Number(metric.target.value), comparator = metric.target.comparator;
  if (!Number.isFinite(current) || !Number.isFinite(target)) return false;
  if (override?.enabled && override.warningValue != null) {
    return ["<", "<="].includes(comparator) ? current >= Number(override.warningValue) : [">", ">="].includes(comparator) ? current <= Number(override.warningValue) : false;
  }
  if (target === 0) return false;
  return ["<", "<="].includes(comparator)
    ? current >= target * (1 - warningRatio)
    : [">", ">="].includes(comparator) ? current <= target * (1 + warningRatio) : false;
}
function unitValue(value, unit) {
  if (value == null) return "-";
  return `${value}${unit === 2 ? "%" : unit === 3 ? "秒" : unit === 4 ? "天" : unit === 5 ? "小时" : ""}`;
}
function hintForKey(value) {
  const text = String(value || "");
  return text.length < 9 ? "已配置" : `${text.slice(0, 4)}••••${text.slice(-4)}`;
}

export class ShopeeHealthService {
  constructor({ repository, client, robotRepository = null, notify = sendDingtalkMessage, shops = SHOPEE_HEALTH_SHOPS, now = () => new Date(), concurrency = 3 }) {
    this.repository = repository;
    this.client = client;
    this.robotRepository = robotRepository;
    this.notify = notify;
    this.shops = shops;
    this.now = now;
    this.concurrency = Math.max(1, Math.min(5, concurrency));
    this.activePromise = null;
  }

  async saveSettings(input, actor = "current-user") {
    const scheduleTime = String(input.scheduleTime || "09:00");
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(scheduleTime)) throw new Error("每日执行时间格式无效。");
    const retryCount = Math.max(0, Math.min(5, Number(input.retryCount ?? 3)));
    const warningRatio = Number(input.warningRatio ?? 0.1);
    if (!Number.isFinite(warningRatio) || warningRatio < 0 || warningRatio > 1) throw new Error("提前预警比例必须在 0% 到 100% 之间。");
    const dingtalkConfigId = input.dingtalkNotificationsEnabled && input.dingtalkConfigId
      ? String(input.dingtalkConfigId)
      : null;
    if (dingtalkConfigId && !this.robotRepository?.getDingtalkConfig(dingtalkConfigId)) throw new Error("选择的钉钉机器人不存在。");
    const update = {
      scheduleTime, retryCount, warningRatio, timezone: "Asia/Shanghai",
      dingtalkConfigId,
      siteNotificationsEnabled: input.siteNotificationsEnabled !== false,
      dingtalkNotificationsEnabled: Boolean(dingtalkConfigId),
      enabled: input.enabled !== false, updatedBy: actor,
    };
    const tokenKey = String(input.tokenKey || "").trim();
    if (tokenKey) {
      const verification = await this.client.verifyToken(tokenKey);
      const monitored = new Set(this.shops.map((shop) => shop.shopId));
      const recognized = verification.shopIds.filter((id) => monitored.has(id));
      if (!recognized.length) throw new Error("该 Key 未识别到当前42家监控店铺中的任何一家。");
      Object.assign(update, {
        encryptedTokenKey: encryptSecret(tokenKey), tokenHint: hintForKey(tokenKey), tokenVerifiedAt: this.now().toISOString(),
        tokenShopCount: recognized.length, lastKeyError: null,
      });
    }
    return this.repository.saveSettings(update, this.now());
  }

  async testKey() {
    const settings = this.repository.getSettings({ includeSecret: true });
    if (!settings?.encryptedTokenKey) throw new Error("请先配置 Shopee 专属 Key。");
    try {
      const result = await this.client.verifyToken(decryptSecret(settings.encryptedTokenKey));
      const monitored = new Set(this.shops.map((shop) => shop.shopId));
      const count = result.shopIds.filter((id) => monitored.has(id)).length;
      this.repository.saveSettings({ tokenVerifiedAt: this.now().toISOString(), tokenShopCount: count, lastKeyError: null }, this.now());
      return { ok: true, recognizedShopCount: count, monitoredShopCount: this.shops.length };
    } catch (error) {
      this.repository.saveSettings({ lastKeyError: error.message }, this.now());
      throw error;
    }
  }

  dashboard({ days = 30 } = {}) {
    const snapshots = this.repository.latestSnapshots();
    const issues = this.repository.listIssues({ status: "active", limit: 500 });
    const appeals = this.repository.listAppeals({ limit: 200 });
    const counts = { healthy: 0, warning: 0, critical: 0, unavailable: 0 };
    for (const snapshot of snapshots) counts[snapshot.status] += 1;
    counts.unavailable += Math.max(0, this.shops.length - snapshots.length);
    return {
      generatedAt: this.now().toISOString(), settings: this.repository.getSettings(), monitoredShopCount: this.shops.length,
      summary: { ...counts, activeIssues: issues.length, openAppeals: appeals.filter((item) => !TERMINAL_APPEAL_STATUSES.has(item.status)).length },
      shops: this.shops.map((shop) => snapshots.find((item) => item.shopId === shop.shopId) || ({ ...shop, shopCode: shop.code, shopName: shop.name, status: "unavailable" })),
      issues, appeals, trend: this.repository.trend(days), latestRun: this.repository.latestRun(),
      notifications: this.repository.listNotifications(20), unreadNotifications: this.repository.unreadNotificationCount(),
      thresholds: this.repository.listThresholds(),
    };
  }

  startCollection(triggerType = "manual", scheduledFor = null) {
    if (this.activePromise) return { started: false, run: this.repository.activeRun() };
    const existing = this.repository.activeRun();
    if (existing) return { started: false, run: existing };
    const run = this.repository.createRun({ triggerType, scheduledFor, shopTotal: this.shops.length }, this.now());
    this.activePromise = this.executeCollection(run.id).catch((error) => {
      this.repository.updateRun(run.id, { status: "failed", errorMessage: error.message, finishedAt: this.now().toISOString() }, this.now());
      if (this.repository.getSettings()?.siteNotificationsEnabled) this.repository.createNotification({ notificationType: "collection_failed", severity: "critical", title: "店铺健康采集失败", message: error.message }, this.now());
    }).finally(() => { this.activePromise = null; });
    return { started: true, run };
  }

  dueForSchedule(date = this.now()) {
    const settings = this.repository.getSettings();
    if (!settings?.enabled || !settings.tokenConfigured) return false;
    const dateKey = localDate(date, settings.timezone);
    return localTime(date, settings.timezone) >= settings.scheduleTime && !this.repository.hasRunForDate(dateKey);
  }

  runScheduledIfDue(date = this.now()) {
    if (!this.dueForSchedule(date)) return { started: false, reason: "not_due" };
    return this.startCollection("scheduled", `${localDate(date)}T${this.repository.getSettings().scheduleTime}:00+08:00`);
  }

  async executeCollection(runId) {
    const settings = this.repository.getSettings({ includeSecret: true });
    if (!settings?.encryptedTokenKey) {
      this.repository.updateRun(runId, { status: "failed", errorMessage: "未配置 Shopee 专属 Key。", finishedAt: this.now().toISOString() }, this.now());
      return;
    }
    this.repository.updateRun(runId, { status: "running", startedAt: this.now().toISOString() }, this.now());
    const tokenKey = decryptSecret(settings.encryptedTokenKey);
    try {
      await this.client.verifyToken(tokenKey);
    } catch (error) {
      this.repository.saveSettings({ lastKeyError: error.message }, this.now());
      if (settings.siteNotificationsEnabled) this.repository.createNotification({ notificationType: "key_invalid", severity: "critical", title: "Shopee 专属 Key 验证失败", message: `${error.message} 请进入店铺健康设置页更新 Key。` }, this.now());
      this.repository.updateRun(runId, { status: "failed", errorMessage: error.message, finishedAt: this.now().toISOString() }, this.now());
      await this.sendSummary(settings, { critical: 1, warning: 0, failed: this.shops.length }, error.message).catch(() => undefined);
      return;
    }
    const thresholds = new Map(this.repository.listThresholds().map((item) => [item.metricId, item]));
    const results = new Array(this.shops.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(this.concurrency, this.shops.length) }, async () => {
      while (cursor < this.shops.length) {
        const index = cursor++;
        try { results[index] = await this.collectShop({ shop: this.shops[index], runId, tokenKey, settings, thresholds }); }
        catch (error) { results[index] = { ok: false, shop: this.shops[index], error }; }
      }
    });
    await Promise.all(workers);
    const success = results.filter((item) => item?.ok).length;
    const failed = results.length - success;
    const warning = results.reduce((total, item) => total + number(item?.warningCount), 0);
    const critical = results.reduce((total, item) => total + number(item?.criticalCount), 0);
    const status = success === 0 ? "failed" : failed ? "partial" : "success";
    const errorMessage = failed ? `${failed} 家店采集失败：${results.filter((item) => !item?.ok).slice(0, 3).map((item) => `${item.shop.code} ${item.error.message}`).join("；")}` : null;
    if (settings.siteNotificationsEnabled) for (const item of results.filter((entry) => !entry?.ok)) this.repository.createNotification({
      notificationType: "collection_failed", severity: "critical", title: `${item.shop.code} 采集失败`, message: item.error.message, shopId: item.shop.shopId,
    }, this.now());
    this.repository.updateRun(runId, {
      status, attemptCount: settings.retryCount + 1, shopSuccess: success, shopFailed: failed,
      warningCount: warning, criticalCount: critical, errorMessage, finishedAt: this.now().toISOString(),
    }, this.now());
    await this.sendSummary(settings, { critical, warning, failed }, errorMessage).catch((error) => {
      if (settings.siteNotificationsEnabled) this.repository.createNotification({ notificationType: "dingtalk_failed", severity: "warning", title: "钉钉通知发送失败", message: error.message }, this.now());
    });
  }

  async call(tokenKey, shopId, apiPath, params, retryCount) {
    return this.client.call({ tokenKey, shopId, apiPath, params, retryCount });
  }

  async collectShop({ shop, runId, tokenKey, settings, thresholds }) {
    const retryCount = settings.retryCount;
    const [performance, penalties, punishments, listings, lateOrders] = await Promise.all([
      this.call(tokenKey, shop.shopId, PATHS.performance, {}, retryCount),
      this.call(tokenKey, shop.shopId, PATHS.penalties, { page_no: 1, page_size: 100 }, retryCount),
      this.call(tokenKey, shop.shopId, PATHS.punishments, { page_no: 1, page_size: 100, punishment_status: 1 }, retryCount),
      this.call(tokenKey, shop.shopId, PATHS.listings, { page_no: 1, page_size: 100 }, retryCount),
      this.call(tokenKey, shop.shopId, PATHS.lateOrders, { page_no: 1, page_size: 100 }, retryCount),
    ]);
    const performanceData = responseOf(performance);
    const penaltyData = responseOf(penalties);
    const punishmentData = responseOf(punishments);
    const listingData = responseOf(listings);
    const lateData = responseOf(lateOrders);
    const seen = [], collectedIssues = [];
    const record = async (issue) => {
      seen.push(issue.fingerprint);
      const saved = this.repository.upsertIssue({ ...issue, shopId: shop.shopId, shopCode: shop.code, shopName: shop.name, country: shop.country }, this.now());
      collectedIssues.push(saved.issue);
      if (saved.isNew && settings.siteNotificationsEnabled) this.repository.createNotification({
        notificationType: "new_issue", severity: issue.severity, title: `${shop.code} · ${issue.title}`, message: issue.reason || "发现新的店铺健康异常。", shopId: shop.shopId, issueId: saved.issue.id,
      }, this.now());
    };
    const metrics = performanceData.metric_list || [];
    for (const metric of metrics) {
      const override = thresholds.get(Number(metric.metric_id));
      const failed = metricFailed(metric), warning = metricWarning(metric, settings.warningRatio, override);
      if (!failed && !warning) continue;
      let source = {};
      try {
        source = responseOf(await this.call(tokenKey, shop.shopId, PATHS.metricDetail, { metric_id: Number(metric.metric_id), page_no: 1, page_size: 100 }, retryCount));
      } catch (error) { source = { detail_error: error.message }; }
      await record({
        fingerprint: `${shop.shopId}:metric:${metric.metric_id}`, issueType: "metric", severity: failed ? "critical" : "warning",
        title: metric.metric_name || `指标 ${metric.metric_id}`, metricId: Number(metric.metric_id),
        currentValue: metric.current_period, targetValue: metric.target?.value, comparator: metric.target?.comparator,
        reason: `${unitValue(metric.current_period, metric.unit)}，目标 ${metric.target?.comparator || ""} ${unitValue(metric.target?.value, metric.unit)}`,
        details: source,
      });
    }
    for (const penalty of penaltyData.penalty_point_list || []) if (number(penalty.latest_point_num) > 0) await record({
      fingerprint: `${shop.shopId}:penalty:${penalty.reference_id}`, issueType: "penalty", severity: "critical",
      title: `扣分 ${penalty.latest_point_num} 分`, referenceId: String(penalty.reference_id),
      reason: PENALTY_REASONS.get(Number(penalty.violation_type)) || `违规类型 ${penalty.violation_type}`,
      details: penalty,
    });
    for (const punishment of punishmentData.punishment_list || []) await record({
      fingerprint: `${shop.shopId}:punishment:${punishment.reference_id}`, issueType: "punishment", severity: "critical",
      title: PUNISHMENT_TYPES.get(Number(punishment.punishment_type)) || `处罚类型 ${punishment.punishment_type}`,
      referenceId: String(punishment.reference_id), reason: `处罚进行中，结束时间 ${punishment.end_time ? new Date(Number(punishment.end_time) * 1000).toLocaleDateString("zh-CN") : "待定"}`,
      details: punishment,
    });
    for (const listing of listingData.listing_list || []) await record({
      fingerprint: `${shop.shopId}:listing:${listing.item_id}:${listing.reason}`, issueType: "listing", severity: [1, 2, 3].includes(Number(listing.reason)) ? "critical" : "warning",
      title: `问题商品 ${listing.item_id}`, referenceId: String(listing.item_id), reason: LISTING_REASONS.get(Number(listing.reason)) || `问题类型 ${listing.reason}`, details: listing,
    });
    for (const order of lateData.late_order_list || []) await record({
      fingerprint: `${shop.shopId}:late:${order.order_sn}`, issueType: "late_order", severity: "warning",
      title: `迟发订单 ${order.order_sn}`, referenceId: order.order_sn, reason: `已迟发 ${order.late_by_days || 0} 天`, details: order,
    });
    this.repository.resolveMissingIssues(shop.shopId, seen, this.now());
    const criticalCount = collectedIssues.filter((item) => item.severity === "critical").length;
    const warningCount = collectedIssues.filter((item) => item.severity === "warning").length;
    const snapshotDate = localDate(this.now(), settings.timezone);
    this.repository.upsertSnapshot({
      runId, snapshotDate, shopId: shop.shopId, shopCode: shop.code, shopName: shop.name, country: shop.country,
      status: criticalCount ? "critical" : warningCount ? "warning" : "healthy",
      overallRating: performanceData.overall_performance?.rating ?? null,
      fulfillmentFailed: number(performanceData.overall_performance?.fulfillment_failed),
      listingFailed: number(performanceData.overall_performance?.listing_failed),
      customerServiceFailed: number(performanceData.overall_performance?.custom_service_failed),
      warningCount, criticalCount,
      penaltyPoints: (penaltyData.penalty_point_list || []).reduce((sum, item) => sum + number(item.latest_point_num), 0),
      ongoingPunishments: number(punishmentData.total_count, (punishmentData.punishment_list || []).length),
      issueListingCount: number(listingData.total_count, (listingData.listing_list || []).length),
      lateOrderCount: number(lateData.total_count, (lateData.late_order_list || []).length),
      metrics: metrics.map((metric) => ({ metricId: metric.metric_id, metricName: metric.metric_name, metricType: metric.metric_type, currentPeriod: metric.current_period, lastPeriod: metric.last_period, unit: metric.unit, target: metric.target })),
      collectedAt: this.now().toISOString(),
    }, this.now());
    return { ok: true, shop, warningCount, criticalCount };
  }

  async sendSummary(settings, counts, errorMessage = null) {
    if (!settings.dingtalkNotificationsEnabled || !settings.dingtalkConfigId || !this.robotRepository) return null;
    if (!counts.critical && !counts.warning && !counts.failed) return null;
    const robot = this.robotRepository.getDingtalkConfig(settings.dingtalkConfigId, { includeSecret: true });
    if (!robot?.enabled) return null;
    return this.notify({
      webhookUrl: decryptSecret(robot.encryptedWebhookUrl), secret: robot.encryptedSecret ? decryptSecret(robot.encryptedSecret) : "",
      title: "Shopee 店铺健康日报",
      markdown: ["### Shopee 店铺健康日报", "", `- 监控店铺：${this.shops.length} 家`, `- 严重异常：${counts.critical} 项`,
        `- 提前预警：${counts.warning} 项`, `- 采集失败：${counts.failed} 家`, errorMessage ? `- 失败摘要：${errorMessage}` : "", "", "请进入 Commerce Ops 的“店铺健康”查看并处理。"].filter(Boolean).join("\n"),
      atAll: robot.atAll, atMobiles: robot.atMobiles,
    });
  }
}

export const shopeeHealthTime = Object.freeze({ localDate, localTime });
