const OUTCOME_LABELS = {
  auto_fulfillment_started: "自动发货已启动",
  preview_created: "已生成待确认预览",
  no_eligible_orders: "暂无可发货订单",
  skipped_active_batch: "已有任务执行中",
  skipped_pending_preview: "已有预览待确认",
  partial_scan_failed: "部分店铺扫描失败",
  scan_failed: "扫描失败",
  message_review_recovered: "留言订单已转回待处理",
  message_review_followup_deferred: "留言订单等待定向扫描",
  message_review_followup_no_eligible: "留言订单定向复查未通过",
  message_review_followup_failed: "留言订单定向扫描失败",
  not_run: "尚未扫描",
};

const BATCH_LABELS = {
  queued: "等待执行",
  running: "执行中",
  success: "已完成",
  partial_success: "部分成功",
  failed: "失败",
  needs_attention: "需要核对",
  skipped: "已跳过",
};

const EXCLUSION_LABELS = {
  OUT_OF_STOCK: "库存不足",
  INVENTORY_UNKNOWN: "库存未知",
  MULTI_WAREHOUSE_REQUIRES_REVIEW: "多仓订单，需人工换仓",
  ALREADY_FULFILLED: "已完成或处于人工处理",
};

const RECHECKABLE_MANUAL_CODES = new Set([
  "INVENTORY_UNKNOWN_BEFORE_SUBMIT",
  "MULTI_WAREHOUSE_REQUIRES_REVIEW",
  "CHANNEL_NOT_AVAILABLE_BEFORE_SUBMIT",
]);

const RECOVERY_LABELS = {
  waiting_tracking: "等待运单审批",
  ready_to_resubmit: "已清空，待重新交运",
  resubmitting: "正在重新交运",
  waiting_after_reset: "重新交运后等待",
  completed: "恢复成功",
  manual_attention: "需要人工处理",
  awaiting_manual_confirmation: "待人工确认",
  acknowledged: "已确认处理",
};

const DASHBOARD_EXCEPTION_LABELS = {
  ...EXCLUSION_LABELS,
  MULTI_WAREHOUSE_REQUIRES_REVIEW: "多仓待换仓",
  INVENTORY_UNKNOWN_BEFORE_SUBMIT: "库存状态未知",
  CHANNEL_NOT_AVAILABLE_BEFORE_SUBMIT: "物流渠道识别异常",
  TRACKING_NUMBER_PENDING: "运单审批中",
  SERVICE_RESTARTED_DURING_BATCH: "执行中服务重启",
  SKIPPED_AFTER_BATCH_FAILURE: "批次异常后跳过",
  VERIFY_FAILED: "发货后回查失败",
  ORDER_EXCLUDED: "预检未通过",
  failed: "发货失败",
  needs_attention: "需要人工核对",
};

const ALERT_TYPE_META = {
  inventory: { label: "库存异常", shortLabel: "库存", action: "补充库存或修正库存状态" },
  multi_warehouse: { label: "多仓订单", shortLabel: "多仓", action: "统一仓库后重新核对" },
  tracking_delay: { label: "运单延迟", shortLabel: "运单", action: "等待系统回查，禁止重复交运" },
  shipping_deadline: { label: "发货时效", shortLabel: "时效", action: "优先处理，但不得跳过安全检查" },
  login: { label: "登录异常", shortLabel: "登录", action: "重新登录马帮后安全扫描" },
  other: { label: "其他异常", shortLabel: "其他", action: "打开马帮核对订单" },
};

const ALERT_SEVERITY_LABELS = { critical: "紧急", warning: "关注", info: "提示" };

function escapeHtml(value) {
  return String(value ?? "—").replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function formatTime(value, withDate = true) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("zh-CN", withDate
    ? { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }
    : { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function statusBadge(status, label = BATCH_LABELS[status] || status || "未知") {
  const tone = ["success"].includes(status) ? "good"
    : ["failed", "needs_attention", "partial_success"].includes(status) ? "bad"
      : ["running"].includes(status) ? "live" : "neutral";
  return `<span class="fulfillment-badge ${tone}">${escapeHtml(label)}</span>`;
}

function emptyState(title, text) {
  return `<div class="fulfillment-empty"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(text)}</span></div>`;
}

function formatDuration(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} 毫秒`;
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} 秒`;
  return `${Math.floor(ms / 60000)}分${Math.round(ms % 60000 / 1000)}秒`;
}

function formatAge(value) {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) return "时间未知";
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  if (minutes < 1) return "刚刚发现";
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`;
  return `${Math.floor(minutes / 1440)} 天前`;
}

function formatShippingRemaining(value) {
  if (value == null || value === "") return "期限未知";
  const minutes = Number(value);
  if (!Number.isFinite(minutes)) return "期限未知";
  if (minutes <= 0) return `已超时 ${Math.abs(minutes)} 分钟`;
  if (minutes < 60) return `剩余 ${minutes} 分钟`;
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes % 1440 / 60);
  const rest = minutes % 60;
  return `剩余 ${days ? `${days} 天 ` : ""}${hours ? `${hours} 小时 ` : ""}${rest} 分钟`;
}

export function createFulfillmentPage({ authorizedFetch, setStatus }) {
  const state = { health: null, scheduler: null, dashboard: null, previews: [], batches: [], recoveries: [],
    view: "overview", alertFilter: "all", loaded: false, loading: false, filterSignature: "",
    selectedManualReviews: new Map(), selectedTrackingAcknowledgements: new Map(), recheckingManualReviews: false,
    checkingMessageReviews: false, messageReviewCandidates: null };
  const byId = (id) => document.getElementById(id);

  async function request(path, options = {}) {
    const response = await authorizedFetch(path, options);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.success === false) {
      throw new Error(payload.error?.message || `履约服务请求失败：${response.status}`);
    }
    return payload.data ?? payload;
  }

  function selectedFilters() {
    return {
      country: byId("fulfillmentCountryFilter").value,
      platform: byId("fulfillmentPlatformFilter").value,
      shopId: byId("fulfillmentShopFilter").value,
    };
  }

  function shopMatches(shop, filters = selectedFilters()) {
    return (!filters.country || shop.countryCode === filters.country)
      && (!filters.platform || shop.platform === filters.platform)
      && (!filters.shopId || shop.id === filters.shopId);
  }

  function previewMatches(preview, filters = selectedFilters()) {
    const shop = state.health?.shops?.find((item) => item.id === preview.shop?.id) || {};
    return shopMatches({ ...shop, id: preview.shop?.id }, filters);
  }

  function populateFilters() {
    const shops = state.health?.shops || [];
    const signature = JSON.stringify(shops.map((item) => [item.id,item.name,item.countryCode,item.platform]));
    if (signature === state.filterSignature) return;
    const country = byId("fulfillmentCountryFilter");
    const platform = byId("fulfillmentPlatformFilter");
    const shop = byId("fulfillmentShopFilter");
    const values = { country: country.value, platform: platform.value, shop: shop.value };
    const countries = [...new Set(shops.map((item) => item.countryCode).filter(Boolean))];
    const platforms = [...new Set(shops.map((item) => item.platform).filter(Boolean))];
    country.innerHTML = '<option value="">全部国家</option>' + countries.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("");
    platform.innerHTML = '<option value="">全部平台</option>' + platforms.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("");
    shop.innerHTML = '<option value="">全部店铺</option>' + shops.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join("");
    country.value = values.country;
    platform.value = values.platform;
    shop.value = values.shop;
    state.filterSignature = signature;
  }

  function allOrders() {
    return state.previews.flatMap((preview) => [
      ...(preview.eligibleOrders || []).map((order) => ({ ...order, preview, eligible: true })),
      ...(preview.excludedOrders || []).map((order) => ({ ...order, preview, eligible: false })),
    ]).filter((order) => previewMatches(order.preview));
  }

  function filteredBatches() {
    const filters = selectedFilters();
    return state.batches.filter((batch) => previewMatches({ shop: batch.shop }, filters));
  }

  function filteredRecoveries() {
    const filters = selectedFilters();
    return state.recoveries.filter((recovery) => {
      const shop = state.health?.shops?.find((item) => item.id === recovery.shopId) || { id: recovery.shopId };
      return shopMatches(shop, filters);
    });
  }

  function selectedShopIds() {
    return new Set((state.health?.shops || []).filter((shop) => shopMatches(shop)).map((shop) => shop.id));
  }

  function aggregateShopBuckets(buckets = []) {
    const selected = selectedShopIds();
    return buckets.filter((item) => selected.has(item.shopId)).reduce((total, item) => {
      for (const key of ["total", "success", "running", "exceptions", "totalMsSum", "trackingWaitMsSum", "timingSamples"])
        total[key] += Number(item[key] || 0);
      return total;
    }, { total: 0, success: 0, running: 0, exceptions: 0, totalMsSum: 0, trackingWaitMsSum: 0, timingSamples: 0 });
  }

  function filteredDashboardExceptions() {
    const selected = selectedShopIds();
    const grouped = new Map();
    for (const item of state.dashboard?.exceptions || []) {
      if (!selected.has(item.shopId)) continue;
      grouped.set(item.code, (grouped.get(item.code) || 0) + Number(item.count || 0));
    }
    return [...grouped].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count);
  }

  function latestBatchOrders(batches = state.batches) {
    const latest = new Map();
    for (const batch of batches || []) for (const order of batch.orders || []) {
      const key = order.orderKey || `${batch.shop?.id || "unknown"}:${order.displayOrderId || "unknown"}`;
      const current = latest.get(key);
      if (!current || String(batch.createdAt || "") > String(current.batch.createdAt || "")) {
        latest.set(key, { batch, order });
      }
    }
    return [...latest.values()];
  }

  function localOperationalAlerts() {
    const alerts = [];
    for (const preview of state.previews) for (const order of [...(preview.eligibleOrders || []), ...(preview.excludedOrders || [])]) {
      if (order.shippingRemainingMinutes == null) continue;
      const minutes = Number(order.shippingRemainingMinutes);
      if (!Number.isFinite(minutes) || minutes > 1440) continue;
      const overdue = minutes <= 0;
      const critical = overdue || minutes <= 120;
      const warning = !critical && minutes <= 360;
      alerts.push({ id:`shipping_deadline:${preview.shop?.id}:${order.displayOrderId}`,type:"shipping_deadline",
        severity:critical ? "critical" : warning ? "warning" : "info",shopId:preview.shop?.id,shopName:preview.shop?.name,
        orderId:order.displayOrderId,code:overdue ? "SHIPPING_DEADLINE_OVERDUE" : critical ? "SHIPPING_DEADLINE_CRITICAL"
          : warning ? "SHIPPING_DEADLINE_URGENT" : "SHIPPING_DEADLINE_DUE_SOON",
        title:overdue ? "订单已超过发货期限" : critical ? "发货期限不足 2 小时" : warning ? "发货期限不足 6 小时" : "发货期限不足 24 小时",
        message:formatShippingRemaining(minutes),action:ALERT_TYPE_META.shipping_deadline.action,
        detectedAt:preview.createdAt || preview.expiresAt,shippingDeadlineAt:order.shippingDeadlineAt,shippingRemainingMinutes:minutes,canRecheck:false });
    }
    for (const preview of state.previews) for (const order of preview.excludedOrders || []) {
      const codes = new Set(order.exclusions || []);
      const type = codes.has("MULTI_WAREHOUSE_REQUIRES_REVIEW") ? "multi_warehouse"
        : codes.has("OUT_OF_STOCK") || codes.has("INVENTORY_UNKNOWN") ? "inventory" : null;
      if (!type) continue;
      alerts.push({ id:`${type}:${preview.shop?.id}:${order.displayOrderId}`,type,
        severity:type === "multi_warehouse" ? "critical" : "warning",shopId:preview.shop?.id,shopName:preview.shop?.name,
        orderId:order.displayOrderId,code:[...codes][0],title:type === "multi_warehouse" ? "订单包含多个仓库" : "库存不足或状态未知",
        message:type === "multi_warehouse" ? "同一订单中的 SKU 分属不同仓库，系统未提交发货。" : "订单库存未通过安全检查，系统未提交发货。",
        action:ALERT_TYPE_META[type].action,detectedAt:preview.createdAt || preview.expiresAt,canRecheck:false });
    }
    for (const { batch, order } of latestBatchOrders()) {
      if (!["failed", "needs_attention"].includes(order.status)) continue;
      const type = order.errorCode === "MULTI_WAREHOUSE_REQUIRES_REVIEW" ? "multi_warehouse"
        : ["OUT_OF_STOCK_BEFORE_SUBMIT", "INVENTORY_UNKNOWN_BEFORE_SUBMIT"].includes(order.errorCode) ? "inventory" : "other";
      alerts.push({ id:`${type}:${batch.shop?.id}:${order.displayOrderId}`,type,
        severity:type === "multi_warehouse" || type === "other" ? "critical" : "warning",shopId:batch.shop?.id,shopName:batch.shop?.name,
        orderId:order.displayOrderId,code:order.errorCode,title:DASHBOARD_EXCEPTION_LABELS[order.errorCode] || ALERT_TYPE_META[type].label,
        message:order.errorMessage || "订单需要人工核对。",action:ALERT_TYPE_META[type].action,detectedAt:batch.createdAt,
        canRecheck:order.status === "needs_attention" && RECHECKABLE_MANUAL_CODES.has(order.errorCode) });
    }
    for (const item of state.recoveries) {
      if (!["waiting_tracking", "verifying_unsubmitted", "ready_to_resubmit", "resubmitting", "waiting_after_reset", "manual_attention",
        "awaiting_manual_confirmation"].includes(item.status)) continue;
      const ageMinutes = Math.max(0, Math.floor((Date.now() - Date.parse(item.submittedAt || new Date())) / 60000));
      if (!["manual_attention", "awaiting_manual_confirmation"].includes(item.status) && ageMinutes < 30) continue;
      const shop = state.health?.shops?.find((candidate) => candidate.id === item.shopId);
      const awaitingConfirmation = item.status === "awaiting_manual_confirmation";
      alerts.push({ id:`tracking_delay:${item.shopId}:${item.displayOrderId}`,type:"tracking_delay",
        severity:awaitingConfirmation ? "warning" : item.status === "waiting_tracking" && !item.resetCount ? "warning" : "critical",
        shopId:item.shopId,shopName:shop?.name || item.shopId,orderId:item.displayOrderId,
        code:item.lastErrorCode || "TRACKING_DELAY",title:awaitingConfirmation ? "人工处理结果待确认"
          : item.status === "manual_attention" ? "运单恢复需要人工处理" : "运单号获取超时",
        message:item.lastErrorMessage || `运单号已等待 ${ageMinutes} 分钟，系统正在持续回查。`,
        action:awaitingConfirmation ? "确认业务处理结果后标记已处理" : ALERT_TYPE_META.tracking_delay.action,
        detectedAt:item.manualResolutionDetectedAt || item.submittedAt,ageMinutes,canRecheck:false,
        canAcknowledge:awaitingConfirmation,trackingNumberMasked:item.trackingNumberMasked });
    }
    const latestScan = state.scheduler?.recentScans?.[0];
    for (const failure of latestScan?.details?.failures || []) if (failure.category === "login") {
      alerts.push({ id:`login:${failure.shopId || "account"}`,type:"login",severity:"critical",shopId:failure.shopId || null,
        shopName:failure.shopName || "马帮账号",orderId:null,code:failure.code,title:"马帮登录状态异常",message:failure.message,
        action:ALERT_TYPE_META.login.action,detectedAt:latestScan.finishedAt || latestScan.startedAt,canRecheck:false });
    }
    return alerts;
  }

  function operationalAlerts({ applyTypeFilter = true } = {}) {
    const localAlerts = localOperationalAlerts();
    const source = Array.isArray(state.dashboard?.alerts)
      ? [...state.dashboard.alerts, ...localAlerts]
      : localAlerts;
    const selected = selectedShopIds();
    const unique = new Map();
    for (const item of source) {
      if (item.shopId && !selected.has(item.shopId)) continue;
      if (applyTypeFilter && state.alertFilter !== "all" && item.type !== state.alertFilter) continue;
      const key = item.id || `${item.type}:${item.shopId || "account"}:${item.orderId || item.code}`;
      if (!unique.has(key)) unique.set(key, item);
    }
    const priority = { critical:0,warning:1,info:2 };
    return [...unique.values()].sort((left,right)=>(priority[left.severity] ?? 3)-(priority[right.severity] ?? 3)
      || String(right.detectedAt || "").localeCompare(String(left.detectedAt || "")));
  }

  function alertSeverityBadge(alert) {
    return `<span class="fulfillment-alert-severity ${escapeHtml(alert.severity || "warning")}">${escapeHtml(ALERT_SEVERITY_LABELS[alert.severity] || "关注")}</span>`;
  }

  function renderAlertRadar() {
    const alerts = operationalAlerts({ applyTypeFilter:false });
    const critical = alerts.filter((item)=>item.severity === "critical").length;
    const tabCount = byId("fulfillmentAlertTabCount");
    tabCount.textContent = alerts.length;
    tabCount.hidden = alerts.length === 0;
    const types = ["inventory","multi_warehouse","tracking_delay","shipping_deadline","login"];
    byId("fulfillmentAlertSummary").innerHTML = types.map((type) => {
      const items = alerts.filter((item)=>item.type === type);
      const urgent = items.filter((item)=>item.severity === "critical").length;
      return `<button type="button" data-alert-type="${type}" class="fulfillment-alert-type ${items.length ? "has-alerts" : "clear"}">
        <span>${escapeHtml(ALERT_TYPE_META[type].label)}</span><strong>${items.length}</strong><small>${items.length ? urgent ? `${urgent} 项紧急` : "需要关注" : "当前正常"}</small></button>`;
    }).join("");
    if (!alerts.length) {
      byId("fulfillmentAlertFeed").innerHTML = `<div class="fulfillment-alert-clear"><span aria-hidden="true">✓</span><div><strong>当前没有需要处理的业务预警</strong><p>库存、多仓、发货时效、运单审批和马帮登录状态均未发现阻断问题。</p></div></div>`;
      return;
    }
    byId("fulfillmentAlertFeed").innerHTML = `<div class="fulfillment-alert-feed-head"><strong>${critical ? `${critical} 项紧急预警` : `${alerts.length} 项需要关注`}</strong><span>每 20 秒自动刷新</span></div>${alerts.slice(0,4).map((alert)=>`
      <article class="fulfillment-alert-item ${escapeHtml(alert.severity || "warning")}">
        <div class="fulfillment-alert-marker" aria-hidden="true"></div><div><div class="fulfillment-alert-title">${alertSeverityBadge(alert)}<strong>${escapeHtml(alert.title || ALERT_TYPE_META[alert.type]?.label)}</strong></div>
        <p>${escapeHtml(alert.shopName || "马帮账号")}${alert.orderId ? ` · ${escapeHtml(alert.orderId)}` : ""}：${escapeHtml(alert.message)}</p>
        <small>${escapeHtml(alert.action || ALERT_TYPE_META[alert.type]?.action)} · ${formatAge(alert.detectedAt)}</small></div></article>`).join("")}`;
  }

  function renderAlertFilters() {
    const all = operationalAlerts({ applyTypeFilter:false });
    const options = [{ type:"all",label:"全部" },...Object.entries(ALERT_TYPE_META).map(([type,meta])=>({ type,label:meta.shortLabel }))];
    byId("fulfillmentAlertFilters").innerHTML = options.map((option)=>{
      const count = option.type === "all" ? all.length : all.filter((item)=>item.type === option.type).length;
      return `<button type="button" data-alert-filter="${option.type}" class="${state.alertFilter === option.type ? "active" : ""}">${escapeHtml(option.label)} <span>${count}</span></button>`;
    }).join("");
  }

  function fallbackDashboard(batches, recoveries) {
    const activeRecoveryKeys = new Set(recoveries.filter((item) => ["waiting_tracking", "verifying_unsubmitted", "ready_to_resubmit", "resubmitting", "waiting_after_reset"].includes(item.status)).map((item) => item.orderKey));
    const dates = Array.from({ length: 7 }, (_, index) => {
      const date = new Date(); date.setHours(0, 0, 0, 0); date.setDate(date.getDate() - (6 - index));
      return date.toLocaleDateString("en-CA");
    });
    const trend = dates.map((date) => ({ date, shops: [] }));
    const today = dates[dates.length - 1];
    const todayShops = new Map();
    const exceptions = new Map();
    const add = (map, shop, order) => {
      if (!map.has(shop.id)) map.set(shop.id, { shopId: shop.id, shopName: shop.name, total: 0, success: 0, running: 0, exceptions: 0, totalMsSum: 0, trackingWaitMsSum: 0, timingSamples: 0 });
      const bucket = map.get(shop.id); bucket.total += 1;
      const category = activeRecoveryKeys.has(order.orderKey) || ["queued", "running"].includes(order.status) ? "running" : order.status === "success" ? "success" : "exceptions";
      bucket[category] += 1;
      const totalMs = Number(order.timings?.total ?? order.timings?.executorTotal);
      if (Number.isFinite(totalMs) && totalMs >= 0) { bucket.totalMsSum += totalMs; bucket.trackingWaitMsSum += Number(order.timings?.trackingWait || 0); bucket.timingSamples += 1; }
      if (category === "exceptions") {
        const code = order.errorCode || order.status; const key = `${shop.id}:${code}`;
        const current = exceptions.get(key) || { shopId: shop.id, code, count: 0 }; current.count += 1; exceptions.set(key, current);
      }
    };
    for (const { batch, order } of latestBatchOrders(batches)) {
      const date = new Date(batch.createdAt).toLocaleDateString("en-CA");
      const day = trend.find((item) => item.date === date);
      const dayMap = new Map((day?.shops || []).map((item) => [item.shopId, item]));
      if (day) add(dayMap, batch.shop, order);
      if (date === today) add(todayShops, batch.shop, order);
      if (day) day.shops = [...dayMap.values()];
    }
    const tracking = new Map();
    for (const item of recoveries) if (activeRecoveryKeys.has(item.orderKey)) {
      const key = `${item.shopId}:${item.status}`; const current = tracking.get(key) || { shopId: item.shopId, status: item.status, count: 0 }; current.count += 1; tracking.set(key, current);
    }
    return { shops: [...todayShops.values()], trend, exceptions: [...exceptions.values()], queues: { tracking: [...tracking.values()], manual: [] }, fallback: true };
  }

  function renderMetrics() {
    const summary = aggregateShopBuckets(state.dashboard?.shops || []);
    const exceptions = filteredDashboardExceptions().reduce((sum, item) => sum + item.count, 0);
    const successRate = summary.total ? Math.round(summary.success / summary.total * 100) : null;
    const selected = selectedShopIds();
    const tracking = (state.dashboard?.queues?.tracking || []).filter((item) => selected.has(item.shopId))
      .reduce((sum, item) => sum + Number(item.count || 0), 0);
    const manual = (state.dashboard?.queues?.manual || []).filter((item) => selected.has(item.shopId))
      .reduce((sum, item) => sum + Number(item.count || 0), 0);
    const averageTotal = summary.timingSamples ? summary.totalMsSum / summary.timingSamples : null;
    const averageTracking = summary.timingSamples ? summary.trackingWaitMsSum / summary.timingSamples : null;
    byId("fulfillmentMetricTotal").textContent = summary.total;
    byId("fulfillmentMetricRunning").textContent = summary.running;
    byId("fulfillmentMetricSuccess").textContent = summary.success;
    byId("fulfillmentMetricSuccessRate").textContent = successRate == null ? "—" : `${successRate}%`;
    byId("fulfillmentMetricExceptions").textContent = exceptions;
    byId("fulfillmentOverviewMeta").innerHTML = `
      <article><span>平均处理</span><strong>${formatDuration(averageTotal)}</strong></article>
      <article><span>等待运单号</span><strong>${formatDuration(averageTracking)}</strong></article>
      <article class="${tracking ? "attention" : ""}"><span>运单恢复中</span><strong>${tracking} 单</strong></article>
      <article class="${manual ? "danger" : ""}"><span>待人工处理</span><strong>${manual} 单</strong></article>`;
  }

  function renderShopOverview() {
    const shops = (state.health?.shops || []).filter((shop) => shopMatches(shop));
    const stats = new Map((state.dashboard?.shops || []).map((item) => [item.shopId, item]));
    byId("fulfillmentShopCount").textContent = `${shops.length} 家`;
    if (!shops.length) {
      byId("fulfillmentShopOverview").innerHTML = emptyState("没有匹配的店铺", "请调整国家、平台或店铺筛选条件。");
      return;
    }
    const rows = shops.map((shop) => ({ shop, stat: stats.get(shop.id) || {} }))
      .sort((a, b) => Number(b.stat.total || 0) - Number(a.stat.total || 0) || a.shop.name.localeCompare(b.shop.name));
    byId("fulfillmentShopOverview").innerHTML = `<table class="fulfillment-table fulfillment-shop-performance"><thead><tr><th>店铺</th><th>今日订单</th><th>成功</th><th>成功率</th><th>异常 / 执行中</th><th>平均处理</th><th>模式</th></tr></thead><tbody>${rows.map(({ shop, stat }) => {
      const total = Number(stat.total || 0);
      const rate = total ? `${Math.round(Number(stat.success || 0) / total * 100)}%` : "—";
      const average = Number(stat.timingSamples || 0) ? Number(stat.totalMsSum || 0) / Number(stat.timingSamples) : null;
      return `<tr><td><strong>${escapeHtml(shop.name)}</strong><small>${escapeHtml(shop.platform)} · ${escapeHtml(shop.countryCode)}</small></td>
        <td><strong class="fulfillment-data-number">${total}</strong></td><td>${Number(stat.success || 0)}</td><td>${rate}</td>
        <td><span class="fulfillment-inline-stat ${Number(stat.exceptions || 0) ? "bad" : ""}">${Number(stat.exceptions || 0)} 异常</span><span class="fulfillment-inline-stat">${Number(stat.running || 0)} 执行中</span></td>
        <td>${formatDuration(average)}</td><td>${statusBadge(shop.autoFulfillEnabled ? "success" : "queued", shop.autoFulfillEnabled ? "自动" : "人工")}</td></tr>`;
    }).join("")}</tbody></table>`;
  }

  function renderTrend() {
    const days = (state.dashboard?.trend || []).map((day) => ({ ...aggregateShopBuckets(day.shops || []), date: day.date }));
    const max = Math.max(1, ...days.map((day) => day.total));
    if (!days.some((day) => day.total)) {
      byId("fulfillmentTrendChart").innerHTML = emptyState("近 7 日暂无真实发货", "出现真实发货批次后，这里会显示每日订单量和结果趋势。");
      return;
    }
    byId("fulfillmentTrendChart").innerHTML = `<div class="fulfillment-chart-plot" role="img" aria-label="近 7 日每日成功和异常订单柱状图">${days.map((day) => {
      const date = new Date(`${day.date}T00:00:00+08:00`);
      const label = `${date.getMonth() + 1}/${date.getDate()}`;
      const successHeight = Math.max(day.success ? 5 : 0, day.success / max * 100);
      const exceptionHeight = Math.max(day.exceptions ? 5 : 0, day.exceptions / max * 100);
      return `<div class="fulfillment-chart-day" title="${escapeHtml(day.date)}：${day.total} 单，成功 ${day.success} 单，异常 ${day.exceptions} 单">
        <span class="fulfillment-chart-value">${day.total || ""}</span><div class="fulfillment-chart-bars"><i class="success" style="height:${successHeight}%"></i><i class="exception" style="height:${exceptionHeight}%"></i></div><span>${label}</span></div>`;
    }).join("")}</div>`;
  }

  function renderExceptionBreakdown() {
    const items = filteredDashboardExceptions();
    const total = items.reduce((sum, item) => sum + item.count, 0);
    byId("fulfillmentExceptionSummaryCount").textContent = `${total} 项`;
    if (!items.length) {
      byId("fulfillmentExceptionBreakdown").innerHTML = emptyState("今日没有发现异常", "预检排除、发货失败和人工处理订单会显示在这里。");
      return;
    }
    const max = Math.max(...items.map((item) => item.count), 1);
    byId("fulfillmentExceptionBreakdown").innerHTML = items.slice(0, 6).map((item) => `<article>
      <div><strong>${escapeHtml(DASHBOARD_EXCEPTION_LABELS[item.code] || item.code)}</strong><span>${item.count} 项</span></div>
      <div class="fulfillment-breakdown-track"><i style="width:${Math.max(6, item.count / max * 100)}%"></i></div></article>`).join("");
  }

  function renderRecentScans() {
    const scans = state.scheduler?.recentScans || [];
    byId("fulfillmentNextScan").textContent = state.scheduler?.enabled && state.scheduler?.nextRunAt
      ? `下次 ${formatTime(state.scheduler.nextRunAt, false)}` : "手动模式";
    if (!scans.length) {
      byId("fulfillmentRecentScans").innerHTML = emptyState("尚无扫描记录", "点击“立即扫描订单”执行第一次扫描。");
      return;
    }
    byId("fulfillmentRecentScans").innerHTML = scans.slice(0, 6).map((scan) => `
      <article class="fulfillment-event"><span class="event-marker ${scan.outcome?.includes("failed") ? "bad" : ""}"></span>
      <div><strong>${escapeHtml(OUTCOME_LABELS[scan.outcome] || scan.outcome)}</strong><p>${escapeHtml(scan.message)}</p></div>
      <time>${formatTime(scan.startedAt)}</time></article>`).join("");
  }

  function renderOrders() {
    const orders = allOrders();
    byId("fulfillmentOrderCount").textContent = `${orders.length} 单`;
    if (!orders.length) {
      byId("fulfillmentOrdersTable").innerHTML = emptyState("目前没有待发货订单", "系统会在下次扫描后自动更新这里。");
      return;
    }
    byId("fulfillmentOrdersTable").innerHTML = `<table class="fulfillment-table fulfillment-order-table"><thead><tr><th>平台</th><th>店铺</th><th>订单号</th><th>发货期限</th><th>仓库</th><th>SKU / 数量</th><th>库存</th><th>物流渠道</th><th>状态</th></tr></thead><tbody>${orders.map((order) => {
      const shop = state.health?.shops?.find((item) => item.id === order.preview.shop?.id) || {};
      const stockLabel = order.stockStatus === "in_stock" ? "有货" : order.stockStatus === "out_of_stock" ? "缺货" : "库存未知";
      const deadlineTone = ["overdue", "critical"].includes(order.shippingDeadlineStatus) ? "failed"
        : ["urgent", "due_soon"].includes(order.shippingDeadlineStatus) ? "running" : "queued";
      return `<tr><td><span class="platform-mark">${escapeHtml(shop.platform || "Shopee")}</span></td><td><strong>${escapeHtml(order.preview.shop?.name)}</strong></td>
        <td><strong class="mono">${escapeHtml(order.displayOrderId)}</strong></td><td>${statusBadge(deadlineTone, formatShippingRemaining(order.shippingRemainingMinutes))}<small>${formatTime(order.shippingDeadlineAt)}</small></td><td>${escapeHtml(order.warehouse)}</td>
        <td>${escapeHtml(order.skuCount)} SKU · ${escapeHtml(order.totalItemQuantity || order.requiredQuantity)}</td>
        <td>${statusBadge(order.stockStatus === "in_stock" ? "success" : "failed", `${stockLabel} ${order.availableQuantity ?? ""}`.trim())}</td>
        <td title="${escapeHtml(order.preview.channel?.name)}">${escapeHtml(order.preview.channel?.name || "—")}</td>
        <td>${statusBadge(order.eligible ? "success" : "failed", order.eligible ? "可发货"
          : EXCLUSION_LABELS[(order.exclusions || [])[0]] || (order.exclusions || [])[0] || "已排除")}</td></tr>`;
    }).join("")}</tbody></table>`;
  }

  function batchProgress(batch) {
    const orders = batch.orders || [];
    const completed = orders.filter((order) => ["success", "failed", "needs_attention", "skipped"].includes(order.status)).length;
    return { completed, total: orders.length, percent: orders.length ? Math.round(completed / orders.length * 100) : 0 };
  }

  function renderTasks() {
    const batches = filteredBatches();
    const active = batches.find((batch) => ["queued", "running"].includes(batch.status));
    byId("fulfillmentTaskCount").textContent = `${batches.length} 批`;
    if (active) {
      const progress = batchProgress(active);
      byId("fulfillmentActiveTask").innerHTML = `<div><span class="page-context">ACTIVE FULFILLMENT</span><h2>${escapeHtml(active.shop?.name)} · 批次 ${escapeHtml(active.id.slice(0, 8))}</h2><p>${progress.completed}/${progress.total} 单已完成，后台仍在逐单获取运单号并转入配货中。</p></div>
        <div class="fulfillment-progress"><span style="width:${progress.percent}%"></span></div>${statusBadge(active.status)}`;
    } else {
      byId("fulfillmentActiveTask").innerHTML = `<div><span class="page-context">TASK QUEUE</span><h2>当前没有执行中的发货任务</h2><p>系统会在扫描发现符合条件的订单后创建任务。</p></div>${statusBadge("success", "队列空闲")}`;
    }
    if (!batches.length) {
      byId("fulfillmentTasksTable").innerHTML = emptyState("尚无发货任务", "成功创建发货批次后会在这里保留逐单结果。");
      return;
    }
    byId("fulfillmentTasksTable").innerHTML = `<table class="fulfillment-table"><thead><tr><th>批次</th><th>店铺</th><th>订单</th><th>成功</th><th>异常</th><th>创建时间</th><th>状态</th></tr></thead><tbody>${batches.map((batch) => {
      const orders = batch.orders || [];
      const success = orders.filter((order) => order.status === "success").length;
      const failed = orders.filter((order) => ["failed", "needs_attention"].includes(order.status)).length;
      return `<tr><td><strong class="mono">${escapeHtml(batch.id.slice(0, 8))}</strong><small>${escapeHtml(batch.id)}</small></td><td>${escapeHtml(batch.shop?.name)}</td><td>${orders.length}</td><td>${success}</td><td>${failed}</td><td>${formatTime(batch.createdAt)}</td><td>${statusBadge(batch.status)}</td></tr>`;
    }).join("")}</tbody></table>`;
  }

  function renderRecoveries() {
    const recoveries = filteredRecoveries();
    const activeStatuses = new Set(["waiting_tracking", "ready_to_resubmit", "resubmitting", "waiting_after_reset"]);
    const activeCount = recoveries.filter((item) => activeStatuses.has(item.status)).length;
    const manualCount = recoveries.filter((item) => ["manual_attention", "awaiting_manual_confirmation"].includes(item.status)).length;
    byId("fulfillmentRecoveryCount").textContent = activeCount ? `${activeCount} 单处理中` : `${recoveries.length} 单`;
    byId("fulfillmentRecoveryCount").classList.toggle("danger", manualCount > 0);
    if (!recoveries.length) {
      byId("fulfillmentRecoveriesTable").innerHTML = emptyState("当前没有运单恢复记录", "遇到 Shopee 运单审批中时，订单会自动进入这里持续回查。");
      return;
    }
    byId("fulfillmentRecoveriesTable").innerHTML = `<table class="fulfillment-table fulfillment-recovery-table"><thead><tr><th>订单号</th><th>店铺</th><th>恢复阶段</th><th>提交时间</th><th>下次回查</th><th>清空渠道</th><th>最后结果</th></tr></thead><tbody>${recoveries.map((item) => {
      const shop = state.health?.shops?.find((candidate) => candidate.id === item.shopId);
      const tone = item.status === "completed" ? "success"
        : item.status === "acknowledged" ? "success"
          : item.status === "awaiting_manual_confirmation" ? "queued"
            : item.status === "manual_attention" ? "failed"
          : ["resubmitting", "waiting_after_reset"].includes(item.status) ? "running" : "queued";
      const result = item.lastErrorMessage || (item.status === "completed" ? `完成于 ${formatTime(item.completedAt)}` : "等待系统回查");
      return `<tr><td><strong class="mono">${escapeHtml(item.displayOrderId)}</strong><small>${escapeHtml(item.batchId)}</small></td>
        <td><strong>${escapeHtml(shop?.name || item.shopId)}</strong><small>${escapeHtml(item.shopId)}</small></td>
        <td>${statusBadge(tone, RECOVERY_LABELS[item.status] || item.status)}</td>
        <td>${formatTime(item.submittedAt)}</td><td>${["completed", "manual_attention", "awaiting_manual_confirmation", "acknowledged"].includes(item.status) ? "—" : formatTime(item.nextCheckAt)}</td>
        <td>${Number(item.resetCount || 0) > 0 ? statusBadge("running", `${item.resetCount} / 1 次`) : "0 / 1 次"}</td>
        <td title="${escapeHtml(result)}">${escapeHtml(result)}</td></tr>`;
    }).join("")}</tbody></table>`;
  }

  function renderExceptions() {
    renderAlertFilters();
    const items = operationalAlerts();
    const allSelectable = operationalAlerts({ applyTypeFilter:false })
      .filter((item) => (item.canRecheck || item.canAcknowledge) && item.shopId && item.orderId);
    const recheckKeys = new Set(allSelectable.filter((item) => item.canRecheck).map((item) => `${item.shopId}:${item.orderId}`));
    const acknowledgementKeys = new Set(allSelectable.filter((item) => item.canAcknowledge).map((item) => `${item.shopId}:${item.orderId}`));
    for (const key of state.selectedManualReviews.keys()) {
      if (!recheckKeys.has(key)) state.selectedManualReviews.delete(key);
    }
    for (const key of state.selectedTrackingAcknowledgements.keys()) {
      if (!acknowledgementKeys.has(key)) state.selectedTrackingAcknowledgements.delete(key);
    }
    byId("fulfillmentExceptionCount").textContent = `${items.length} 项`;
    if (!items.length) {
      const filtered = state.alertFilter !== "all";
      byId("fulfillmentExceptionsTable").innerHTML = emptyState(filtered ? "该类型当前没有预警" : "当前没有异常",
        filtered ? "可以选择“全部”查看其他业务预警。" : "库存、多仓、发货时效、运单延迟和登录异常会集中显示在这里。");
      return;
    }
    const visibleSelectable = items.filter((item) => (item.canRecheck || item.canAcknowledge) && item.shopId && item.orderId);
    const selected = (item) => (item.canRecheck ? state.selectedManualReviews : state.selectedTrackingAcknowledgements)
      .has(`${item.shopId}:${item.orderId}`);
    const visibleSelectedCount = visibleSelectable.filter(selected).length;
    const selectedCount = state.selectedManualReviews.size + state.selectedTrackingAcknowledgements.size;
    const selectionToolbar = visibleSelectable.length ? `<div class="fulfillment-bulk-review" role="group" aria-label="批量处理异常订单">
      <label class="fulfillment-check-label"><input type="checkbox" data-fulfillment-select-all aria-label="选择当前列表全部可处理订单" ${visibleSelectedCount === visibleSelectable.length ? "checked" : ""}><span>全选当前可处理项</span></label>
      <span class="fulfillment-selection-count" aria-live="polite">已选 <strong>${selectedCount}</strong> 项</span>
      ${recheckKeys.size ? `<button class="fulfillment-bulk-recheck-button" type="button" data-fulfillment-bulk-recheck ${state.selectedManualReviews.size && !state.recheckingManualReviews ? "" : "disabled"}>${state.recheckingManualReviews ? "处理中…" : "批量核对并解除"}</button>` : ""}
      ${acknowledgementKeys.size ? `<button class="fulfillment-bulk-acknowledge-button" type="button" data-fulfillment-bulk-acknowledge ${state.selectedTrackingAcknowledgements.size && !state.recheckingManualReviews ? "" : "disabled"}>${state.recheckingManualReviews ? "处理中…" : "批量已处理"}</button>` : ""}
      <small>核对解除会执行深度预检；“已处理”只归档系统已回查成功的订单</small></div>` : "";
    byId("fulfillmentExceptionsTable").innerHTML = `${selectionToolbar}<table class="fulfillment-table fulfillment-alert-table"><thead><tr><th class="fulfillment-select-column"><span class="sr-only">选择</span></th><th>级别</th><th>异常类型</th><th>店铺 / 订单</th><th>发现时间</th><th>问题说明</th><th>建议操作</th></tr></thead><tbody>${items.map((item) => {
      const action = item.canRecheck ? "recheck" : item.canAcknowledge ? "acknowledge" : "";
      const key = action && item.shopId && item.orderId ? `${item.shopId}:${item.orderId}` : "";
      return `<tr class="alert-row-${escapeHtml(item.severity || "warning")}">
      <td class="fulfillment-select-cell">${key ? `<label><input type="checkbox" data-fulfillment-select-review data-action="${action}" data-shop-id="${escapeHtml(item.shopId)}" data-order-id="${escapeHtml(item.orderId)}" aria-label="选择订单 ${escapeHtml(item.orderId)}" ${(action === "recheck" ? state.selectedManualReviews : state.selectedTrackingAcknowledgements).has(key) ? "checked" : ""} ${state.recheckingManualReviews ? "disabled" : ""}><span class="sr-only">选择订单 ${escapeHtml(item.orderId)}</span></label>` : ""}</td>
      <td>${alertSeverityBadge(item)}</td><td><strong>${escapeHtml(ALERT_TYPE_META[item.type]?.label || item.title || "业务异常")}</strong><small>${escapeHtml(item.code || "—")}</small></td>
      <td><strong>${escapeHtml(item.shopName || "马帮账号")}</strong><small class="mono">${escapeHtml(item.orderId || "账号级异常")}</small></td>
      <td><strong>${formatAge(item.detectedAt)}</strong><small>${formatTime(item.detectedAt)}</small></td>
      <td><strong>${escapeHtml(item.title || ALERT_TYPE_META[item.type]?.label)}</strong><small title="${escapeHtml(item.message)}">${escapeHtml(item.message)}</small></td>
      <td>${item.canRecheck && item.shopId && item.orderId
      ? `<button class="button-secondary fulfillment-recheck-button" type="button" data-fulfillment-recheck data-shop-id="${escapeHtml(item.shopId)}" data-order-id="${escapeHtml(item.orderId)}" aria-label="重新核对订单 ${escapeHtml(item.orderId)} 并解除人工处理锁" ${state.recheckingManualReviews ? "disabled" : ""}>重新核对并解除</button><small class="fulfillment-action-hint">只解除锁，不立即发货</small>`
      : item.canAcknowledge ? `<span class="fulfillment-awaiting-confirmation">待人工确认</span><small class="fulfillment-action-hint">勾选后点击“批量已处理”</small>`
      : `<span class="fulfillment-alert-action">${escapeHtml(item.action || ALERT_TYPE_META[item.type]?.action)}</span>`}</td></tr>`;
    }).join("")}</tbody></table>`;
    const selectAll = byId("fulfillmentExceptionsTable").querySelector("[data-fulfillment-select-all]");
    if (selectAll) selectAll.indeterminate = visibleSelectedCount > 0 && visibleSelectedCount < visibleSelectable.length;
  }

  function renderMessageReviewStatus() {
    const scheduler = state.scheduler || {};
    const enabled = Boolean(scheduler.messageReviewRecoveryEnabled);
    const interval = Math.max(5, Number(scheduler.messageReviewRecoveryIntervalMinutes) || 30);
    const lastCheckedAt = scheduler.lastMessageReviewCheckAt;
    const nextCheckAt = lastCheckedAt ? new Date(Date.parse(lastCheckedAt) + interval * 60000).toISOString() : null;
    const followUpDelay = Math.max(5, Number(scheduler.messageReviewFollowUpDelaySeconds) || 30);
    const followUpPending = Number(scheduler.messageReviewFollowUpPendingCount || 0);
    const followUpAt = scheduler.messageReviewFollowUpAt;
    const result = scheduler.lastMessageReviewRecovery;
    const checked = Number(result?.checked || 0);
    const moved = Number(result?.moved?.length || 0);
    const failed = result?.errorCode || result?.results?.filter((item) => item.status === "failed").length;
    const card = byId("fulfillmentMessageReviewCard");
    card.classList.toggle("disabled", !enabled);
    card.classList.toggle("failed", Boolean(failed));
    byId("fulfillmentMessageReviewStats").innerHTML = `
      <article><span>运行状态</span><strong>${enabled ? "已开启" : "未开启"}</strong></article>
      <article><span>巡检频率</span><strong>${enabled ? `每 ${interval} 分钟` : "—"}</strong></article>
      <article><span>下次巡检</span><strong>${enabled ? nextCheckAt ? formatTime(nextCheckAt) : "下一轮扫描" : "—"}</strong></article>
      <article><span>自动推单</span><strong>${followUpPending ? `${followUpPending} 单 · ${formatTime(followUpAt)}` : enabled ? `恢复后 ${followUpDelay} 秒` : "—"}</strong></article>
      <article><span>上次结果</span><strong>${failed ? "检查失败" : result ? `检查 ${checked} · 转回 ${moved}` : "等待首次巡检"}</strong></article>`;
    const candidateText = Array.isArray(state.messageReviewCandidates)
      ? `只读检查发现 ${state.messageReviewCandidates.filter((item) => item.eligible).length} 笔符合条件，${state.messageReviewCandidates.length} 笔待审核候选`
      : "不会改变订单状态";
    byId("fulfillmentMessageReviewCheckResult").textContent = candidateText;
  }

  async function requestManualReviewRecheck({ shopId, orderId }) {
    return request("/api/fulfillment-dashboard/manual-reviews/recheck", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ shopId, orderId }),
    });
  }

  async function recheckManualReview(button) {
    const shopId = button.dataset.shopId;
    const orderId = button.dataset.orderId;
    if (!window.confirm(`确认重新核对订单 ${orderId}？\n\n系统会检查仓库、库存、待处理状态、物流渠道和运单号。检查通过后只解除人工处理锁，不会立即提交发货。`)) return;
    if (state.recheckingManualReviews) return;
    state.recheckingManualReviews = true;
    renderExceptions();
    try {
      const result = await requestManualReviewRecheck({ shopId, orderId });
      setStatus(`${result.orderId} 已通过重新核对并解除人工处理锁，将在下一轮扫描重新进入正常流程。`, "success");
      state.loaded = false;
      await load(true);
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      state.recheckingManualReviews = false;
      renderExceptions();
    }
  }

  async function recheckSelectedManualReviews() {
    if (state.recheckingManualReviews || !state.selectedManualReviews.size) return;
    const reviews = [...state.selectedManualReviews.values()];
    if (!window.confirm(`确认批量核对并解除这 ${reviews.length} 个订单？\n\n系统将逐单检查仓库、库存、待处理状态、物流渠道和运单号。通过后只解除人工处理锁，不会立即提交发货。`)) return;
    state.recheckingManualReviews = true;
    renderExceptions();
    const succeeded = [];
    const failed = [];
    try {
      for (let index = 0; index < reviews.length; index += 1) {
        const review = reviews[index];
        const progressButton = byId("fulfillmentExceptionsTable").querySelector("[data-fulfillment-bulk-recheck]");
        if (progressButton) progressButton.textContent = `正在核对 ${index + 1}/${reviews.length}…`;
        try {
          await requestManualReviewRecheck(review);
          succeeded.push(review);
          state.selectedManualReviews.delete(`${review.shopId}:${review.orderId}`);
        } catch (error) {
          failed.push({ ...review, message:error.message });
        }
      }
      const failedText = failed.length ? `；${failed.length} 项未通过：${failed.slice(0, 2).map((item) => item.orderId).join("、")}` : "";
      setStatus(`批量核对完成：${succeeded.length} 项已解除，${failed.length} 项保留人工锁${failedText}。`, failed.length ? "error" : "success");
      state.loaded = false;
      await load(true);
    } finally {
      state.recheckingManualReviews = false;
      renderExceptions();
    }
  }

  async function acknowledgeSelectedTrackingRecoveries() {
    if (state.recheckingManualReviews || !state.selectedTrackingAcknowledgements.size) return;
    const items = [...state.selectedTrackingAcknowledgements.values()];
    if (!window.confirm(`确认将这 ${items.length} 个订单标记为“已处理”？\n\n这些订单已经由系统回查到配货中或后续状态。本操作只归档看板记录，不会修改马帮订单。`)) return;
    state.recheckingManualReviews = true;
    renderExceptions();
    try {
      const result = await request("/api/fulfillment-dashboard/tracking-recoveries/acknowledge", {
        method:"POST",headers:{ "content-type":"application/json" },body:JSON.stringify({ items }),
      });
      for (const item of result.acknowledged || []) {
        state.selectedTrackingAcknowledgements.delete(`${item.shopId}:${item.orderId}`);
      }
      const notReady = result.notReady || [];
      setStatus(`已确认处理 ${result.acknowledged?.length || 0} 项${notReady.length ? `；${notReady.length} 项状态已变化，请刷新核对` : ""}。`,
        notReady.length ? "error" : "success");
      state.loaded = false;
      await load(true);
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      state.recheckingManualReviews = false;
      renderExceptions();
    }
  }

  function renderStores() {
    const shops = (state.health?.shops || []).filter((shop) => shopMatches(shop));
    if (!shops.length) {
      byId("fulfillmentStoresTable").innerHTML = emptyState("没有匹配的店铺", "当前筛选条件下没有可显示的店铺配置。");
      return;
    }
    byId("fulfillmentStoresTable").innerHTML = `<table class="fulfillment-table"><thead><tr><th>国家</th><th>平台</th><th>店铺</th><th>店铺 ID</th><th>默认物流渠道</th><th>单批上限</th><th>发货模式</th></tr></thead><tbody>${shops.map((shop) => `<tr><td><strong>${escapeHtml(shop.countryCode)}</strong></td><td><span class="platform-mark">${escapeHtml(shop.platform)}</span></td><td><strong>${escapeHtml(shop.name)}</strong></td><td class="mono">${escapeHtml(shop.id)}</td><td title="${escapeHtml(shop.channelName)}">${escapeHtml(shop.channelName)}</td><td>最多 10 单</td><td>${statusBadge(shop.autoFulfillEnabled ? "success" : "queued", shop.autoFulfillEnabled ? "自动发货" : "人工确认")}</td></tr>`).join("")}</tbody></table>`;
  }

  function renderAll() {
    renderAlertRadar();
    renderMetrics();
    renderMessageReviewStatus();
    renderShopOverview();
    renderTrend();
    renderExceptionBreakdown();
    renderRecentScans();
    renderOrders();
    renderTasks();
    renderRecoveries();
    renderExceptions();
    renderStores();
  }

  function switchView(view) {
    state.view = view;
    document.querySelectorAll("[data-fulfillment-view]").forEach((button) => {
      const active = button.dataset.fulfillmentView === view;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    });
    document.querySelectorAll("[data-fulfillment-panel]").forEach((panel) => {
      const active = panel.dataset.fulfillmentPanel === view;
      panel.hidden = !active;
      panel.classList.toggle("active", active);
    });
  }

  async function load(force = false) {
    if (state.loading || (state.loaded && !force)) return;
    const initialLoad = !state.loaded;
    state.loading = true;
    if (initialLoad) {
      byId("fulfillmentLoading").hidden = false;
      byId("fulfillmentContent").hidden = true;
    }
    try {
      const [health, scheduler, dashboard, batches, recoveries] = await Promise.all([
        request("/api/fulfillment-dashboard/health"),
        request("/api/fulfillment-dashboard/scheduler"),
        request("/api/fulfillment-dashboard/dashboard?days=7").catch(() => null),
        request("/api/fulfillment-dashboard/batches?limit=30"),
        request("/api/fulfillment-dashboard/tracking-recoveries?limit=50"),
      ]);
      const summaries = scheduler.pendingPreviews || [];
      const previewResults = await Promise.allSettled(summaries.slice(0, 20)
        .map((item) => request(`/api/fulfillment-dashboard/previews/${encodeURIComponent(item.previewId)}`)));
      const previews = previewResults.filter((result) => result.status === "fulfilled").map((result) => result.value);
      state.health = health;
      state.scheduler = scheduler;
      state.batches = Array.isArray(batches) ? batches : [];
      state.recoveries = Array.isArray(recoveries) ? recoveries : [];
      state.dashboard = dashboard || fallbackDashboard(state.batches, state.recoveries);
      state.previews = previews;
      state.loaded = true;
      populateFilters();
      renderAll();
      const activeAlerts = operationalAlerts({ applyTypeFilter:false });
      const criticalAlerts = activeAlerts.filter((item)=>item.severity === "critical");
      byId("fulfillmentServiceAlert").className = criticalAlerts.length ? "fulfillment-service-alert bad"
        : activeAlerts.length ? "fulfillment-service-alert attention" : dashboard ? "fulfillment-service-alert good" : "fulfillment-service-alert neutral";
      byId("fulfillmentServiceAlert").textContent = criticalAlerts.length
        ? `发现 ${criticalAlerts.length} 项紧急预警：${[...new Set(criticalAlerts.map((item)=>ALERT_TYPE_META[item.type]?.label || "业务异常"))].join("、")}。请打开异常中心处理。`
        : activeAlerts.length ? `当前有 ${activeAlerts.length} 项业务预警需要关注，自动发货安全拦截仍然生效。`
          : !dashboard ? "看板已使用最近批次临时统计；重启履约服务后将自动切换为完整数据库统计。" : scheduler.scanning
            ? "履约服务正在扫描店铺，页面会在稍后刷新。"
            : `${health.shopCount || 0} 家店铺已连接。${scheduler.lastMessage || "等待下一次扫描。"}`;
      byId("fulfillmentSyncText").textContent = `更新于 ${formatTime(new Date().toISOString(), false)}`;
    } catch (error) {
      byId("fulfillmentServiceAlert").className = "fulfillment-service-alert bad";
      byId("fulfillmentServiceAlert").textContent = error.message;
      throw error;
    } finally {
      state.loading = false;
      if (initialLoad) {
        byId("fulfillmentLoading").hidden = true;
        byId("fulfillmentContent").hidden = !state.loaded;
      }
    }
  }

  async function scanNow() {
    if (!window.confirm("立即扫描可能会对已开启自动发货的店铺执行真实发货并转入配货中。确认继续吗？")) return;
    const button = byId("fulfillmentScanBtn");
    button.disabled = true;
    button.textContent = "正在扫描…";
    try {
      const result = await request("/api/fulfillment-dashboard/scheduler/scan", { method: "POST" });
      setStatus(result.message || "扫描已完成。", result.outcome?.includes("failed") ? "error" : "success");
      state.loaded = false;
      await load(true);
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      button.disabled = false;
      button.textContent = "立即扫描订单";
    }
  }

  async function checkMessageReviews() {
    if (state.checkingMessageReviews) return;
    state.checkingMessageReviews = true;
    const button = byId("fulfillmentCheckMessageReviewsBtn");
    button.disabled = true;
    button.textContent = "正在检查…";
    byId("fulfillmentMessageReviewCheckResult").textContent = "正在读取马帮待审核订单，不会改变状态…";
    try {
      state.messageReviewCandidates = await request("/api/fulfillment-dashboard/message-review-recoveries/candidates?limit=10");
      renderMessageReviewStatus();
    } catch (error) {
      byId("fulfillmentMessageReviewCheckResult").textContent = `检查失败：${error.message}`;
      setStatus(error.message, "error");
    } finally {
      state.checkingMessageReviews = false;
      button.disabled = false;
      button.textContent = "立即只读检查";
    }
  }

  function initialize() {
    document.querySelectorAll("[data-fulfillment-view]").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.fulfillmentView)));
    ["fulfillmentCountryFilter", "fulfillmentPlatformFilter", "fulfillmentShopFilter"].forEach((id) => byId(id).addEventListener("change", renderAll));
    byId("fulfillmentRefreshBtn").addEventListener("click", async () => {
      const button = byId("fulfillmentRefreshBtn");
      button.disabled = true;
      try { await load(true); setStatus("履约状态已刷新。", "success"); }
      catch (error) { setStatus(error.message, "error"); }
      finally { button.disabled = false; }
    });
    byId("fulfillmentScanBtn").addEventListener("click", scanNow);
    byId("fulfillmentCheckMessageReviewsBtn").addEventListener("click", checkMessageReviews);
    byId("fulfillmentOpenAlertsBtn").addEventListener("click", () => {
      state.alertFilter = "all"; switchView("exceptions"); renderExceptions();
    });
    byId("fulfillmentAlertSummary").addEventListener("click", (event) => {
      const button = event.target.closest("[data-alert-type]");
      if (!button) return;
      state.alertFilter = button.dataset.alertType; switchView("exceptions"); renderExceptions();
    });
    byId("fulfillmentAlertFilters").addEventListener("click", (event) => {
      const button = event.target.closest("[data-alert-filter]");
      if (!button) return;
      state.alertFilter = button.dataset.alertFilter; renderExceptions();
    });
    byId("fulfillmentExceptionsTable").addEventListener("click", (event) => {
      if (event.target.closest("[data-fulfillment-bulk-acknowledge]")) {
        acknowledgeSelectedTrackingRecoveries();
        return;
      }
      if (event.target.closest("[data-fulfillment-bulk-recheck]")) {
        recheckSelectedManualReviews();
        return;
      }
      const button = event.target.closest("[data-fulfillment-recheck]");
      if (button) recheckManualReview(button);
    });
    byId("fulfillmentExceptionsTable").addEventListener("change", (event) => {
      const selectAll = event.target.closest("[data-fulfillment-select-all]");
      if (selectAll) {
        for (const item of operationalAlerts().filter((alert) => (alert.canRecheck || alert.canAcknowledge)
          && alert.shopId && alert.orderId)) {
          const key = `${item.shopId}:${item.orderId}`;
          const selection = item.canRecheck ? state.selectedManualReviews : state.selectedTrackingAcknowledgements;
          if (selectAll.checked) selection.set(key, { shopId:item.shopId,orderId:item.orderId });
          else selection.delete(key);
        }
        renderExceptions();
        return;
      }
      const checkbox = event.target.closest("[data-fulfillment-select-review]");
      if (!checkbox) return;
      const review = { shopId:checkbox.dataset.shopId,orderId:checkbox.dataset.orderId };
      const key = `${review.shopId}:${review.orderId}`;
      const selection = checkbox.dataset.action === "acknowledge"
        ? state.selectedTrackingAcknowledgements : state.selectedManualReviews;
      if (checkbox.checked) selection.set(key, review);
      else selection.delete(key);
      renderExceptions();
    });
    window.setInterval(() => {
      if (!state.recheckingManualReviews && !document.getElementById("page-fulfillment")?.hidden) load(true).catch(() => {});
    }, 20000);
  }

  return { initialize, load, switchView };
}
