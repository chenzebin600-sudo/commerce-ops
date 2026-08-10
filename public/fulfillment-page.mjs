const OUTCOME_LABELS = {
  auto_fulfillment_started: "自动发货已启动",
  preview_created: "已生成待确认预览",
  no_eligible_orders: "暂无可发货订单",
  skipped_active_batch: "已有任务执行中",
  skipped_pending_preview: "已有预览待确认",
  partial_scan_failed: "部分店铺扫描失败",
  scan_failed: "扫描失败",
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
  GIFT_ONLY_ORDER_NOT_ALLOWED: "赠品不可单独销售",
  ALREADY_FULFILLED: "已完成或处于人工处理",
};

const RECHECKABLE_MANUAL_CODES = new Set([
  "INVENTORY_UNKNOWN_BEFORE_SUBMIT",
  "MULTI_WAREHOUSE_REQUIRES_REVIEW",
]);

const RECOVERY_LABELS = {
  waiting_tracking: "等待运单审批",
  ready_to_resubmit: "已清空，待重新交运",
  resubmitting: "正在重新交运",
  waiting_after_reset: "重新交运后等待",
  completed: "恢复成功",
  manual_attention: "需要人工处理",
};

const DASHBOARD_EXCEPTION_LABELS = {
  ...EXCLUSION_LABELS,
  MULTI_WAREHOUSE_REQUIRES_REVIEW: "多仓待换仓",
  INVENTORY_UNKNOWN_BEFORE_SUBMIT: "库存状态未知",
  TRACKING_NUMBER_PENDING: "运单审批中",
  SERVICE_RESTARTED_DURING_BATCH: "执行中服务重启",
  SKIPPED_AFTER_BATCH_FAILURE: "批次异常后跳过",
  VERIFY_FAILED: "发货后回查失败",
  ORDER_EXCLUDED: "预检未通过",
  failed: "发货失败",
  needs_attention: "需要人工核对",
};

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

export function createFulfillmentPage({ authorizedFetch, setStatus }) {
  const state = { health: null, scheduler: null, dashboard: null, previews: [], batches: [], recoveries: [], view: "overview", loaded: false, loading: false };
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

  function fallbackDashboard(batches, recoveries) {
    const activeRecoveryKeys = new Set(recoveries.filter((item) => ["waiting_tracking", "ready_to_resubmit", "resubmitting", "waiting_after_reset"].includes(item.status)).map((item) => item.orderKey));
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
    for (const batch of batches) {
      const date = new Date(batch.createdAt).toLocaleDateString("en-CA");
      const day = trend.find((item) => item.date === date);
      const dayMap = new Map((day?.shops || []).map((item) => [item.shopId, item]));
      for (const order of batch.orders || []) { if (day) add(dayMap, batch.shop, order); if (date === today) add(todayShops, batch.shop, order); }
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
    byId("fulfillmentOrdersTable").innerHTML = `<table class="fulfillment-table fulfillment-order-table"><thead><tr><th>平台</th><th>店铺</th><th>订单号</th><th>仓库</th><th>SKU / 数量</th><th>库存</th><th>物流渠道</th><th>状态</th></tr></thead><tbody>${orders.map((order) => {
      const shop = state.health?.shops?.find((item) => item.id === order.preview.shop?.id) || {};
      const stockLabel = order.stockStatus === "in_stock" ? "有货" : order.stockStatus === "out_of_stock" ? "缺货" : "库存未知";
      return `<tr><td><span class="platform-mark">${escapeHtml(shop.platform || "Shopee")}</span></td><td><strong>${escapeHtml(order.preview.shop?.name)}</strong></td>
        <td><strong class="mono">${escapeHtml(order.displayOrderId)}</strong></td><td>${escapeHtml(order.warehouse)}</td>
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
    const manualCount = recoveries.filter((item) => item.status === "manual_attention").length;
    byId("fulfillmentRecoveryCount").textContent = activeCount ? `${activeCount} 单处理中` : `${recoveries.length} 单`;
    byId("fulfillmentRecoveryCount").classList.toggle("danger", manualCount > 0);
    if (!recoveries.length) {
      byId("fulfillmentRecoveriesTable").innerHTML = emptyState("当前没有运单恢复记录", "遇到 Shopee 运单审批中时，订单会自动进入这里持续回查。");
      return;
    }
    byId("fulfillmentRecoveriesTable").innerHTML = `<table class="fulfillment-table fulfillment-recovery-table"><thead><tr><th>订单号</th><th>店铺</th><th>恢复阶段</th><th>提交时间</th><th>下次回查</th><th>清空渠道</th><th>最后结果</th></tr></thead><tbody>${recoveries.map((item) => {
      const shop = state.health?.shops?.find((candidate) => candidate.id === item.shopId);
      const tone = item.status === "completed" ? "success"
        : item.status === "manual_attention" ? "failed"
          : ["resubmitting", "waiting_after_reset"].includes(item.status) ? "running" : "queued";
      const result = item.lastErrorMessage || (item.status === "completed" ? `完成于 ${formatTime(item.completedAt)}` : "等待系统回查");
      return `<tr><td><strong class="mono">${escapeHtml(item.displayOrderId)}</strong><small>${escapeHtml(item.batchId)}</small></td>
        <td><strong>${escapeHtml(shop?.name || item.shopId)}</strong><small>${escapeHtml(item.shopId)}</small></td>
        <td>${statusBadge(tone, RECOVERY_LABELS[item.status] || item.status)}</td>
        <td>${formatTime(item.submittedAt)}</td><td>${item.status === "completed" || item.status === "manual_attention" ? "—" : formatTime(item.nextCheckAt)}</td>
        <td>${Number(item.resetCount || 0) > 0 ? statusBadge("running", `${item.resetCount} / 1 次`) : "0 / 1 次"}</td>
        <td title="${escapeHtml(result)}">${escapeHtml(result)}</td></tr>`;
    }).join("")}</tbody></table>`;
  }

  function renderExceptions() {
    const excluded = allOrders().filter((order) => !order.eligible).map((order) => ({
      type: (order.exclusions || []).includes("MULTI_WAREHOUSE_REQUIRES_REVIEW") ? "多仓待处理"
        : order.stockStatus === "out_of_stock" ? "库存不足" : "订单已排除",
      shop: order.preview.shop?.name, shopId: order.preview.shop?.id, orderId: order.displayOrderId,
      reason: (order.exclusions || []).map((code) => EXCLUSION_LABELS[code] || code).join("；") || "订单未通过预检",
      action: "修正后重新扫描", canRecheck: false, key: `${order.preview.shop?.id}:${order.displayOrderId}`,
    }));
    const failed = filteredBatches().flatMap((batch) => (batch.orders || [])
      .filter((order) => ["failed", "needs_attention"].includes(order.status)).map((order) => ({
        type: order.errorCode === "MULTI_WAREHOUSE_REQUIRES_REVIEW" ? "多仓待处理"
          : order.status === "needs_attention" ? "需要人工核对" : "发货失败",
        shop: batch.shop?.name, shopId: batch.shop?.id, orderId: order.displayOrderId,
        reason: order.errorMessage || order.errorCode || "未知错误",
        action: order.status === "needs_attention" ? "人工换仓并改回待处理后重新核对" : "核对马帮订单",
        canRecheck: order.status === "needs_attention" && RECHECKABLE_MANUAL_CODES.has(order.errorCode),
        key: `${batch.shop?.id}:${order.displayOrderId}`, createdAt: batch.createdAt,
      })));
    const unique = new Map();
    for (const item of [...failed, ...excluded]) if (!unique.has(item.key)) unique.set(item.key, item);
    const items = [...unique.values()];
    byId("fulfillmentExceptionCount").textContent = `${items.length} 项`;
    if (!items.length) {
      byId("fulfillmentExceptionsTable").innerHTML = emptyState("当前没有异常", "缺货、库存未知和发货失败订单会集中显示在这里。");
      return;
    }
    byId("fulfillmentExceptionsTable").innerHTML = `<table class="fulfillment-table"><thead><tr><th>异常类型</th><th>店铺</th><th>订单号</th><th>原因</th><th>建议操作</th></tr></thead><tbody>${items.map((item) => `<tr><td>${statusBadge("failed", item.type)}</td><td>${escapeHtml(item.shop)}</td><td><strong class="mono">${escapeHtml(item.orderId)}</strong></td><td>${escapeHtml(item.reason)}</td><td>${item.canRecheck
      ? `<button class="button-secondary fulfillment-recheck-button" type="button" data-fulfillment-recheck data-shop-id="${escapeHtml(item.shopId)}" data-order-id="${escapeHtml(item.orderId)}" aria-label="重新核对订单 ${escapeHtml(item.orderId)} 并解除人工处理锁">重新核对并解除</button><small class="fulfillment-action-hint">不会立即发货</small>`
      : escapeHtml(item.action)}</td></tr>`).join("")}</tbody></table>`;
  }

  async function recheckManualReview(button) {
    const shopId = button.dataset.shopId;
    const orderId = button.dataset.orderId;
    if (!window.confirm(`确认重新核对订单 ${orderId}？\n\n系统会检查仓库、库存、待处理状态、物流渠道和运单号。检查通过后只解除人工处理锁，不会立即提交发货。`)) return;
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = "正在核对…";
    try {
      const result = await request("/api/fulfillment-dashboard/manual-reviews/recheck", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ shopId, orderId }),
      });
      setStatus(`${result.orderId} 已通过重新核对并解除人工处理锁，将在下一轮扫描重新进入正常流程。`, "success");
      state.loaded = false;
      await load(true);
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      button.disabled = false;
      button.textContent = originalText;
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
    renderMetrics();
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
    state.loading = true;
    byId("fulfillmentLoading").hidden = false;
    byId("fulfillmentContent").hidden = true;
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
      byId("fulfillmentServiceAlert").className = dashboard ? "fulfillment-service-alert good" : "fulfillment-service-alert neutral";
      byId("fulfillmentServiceAlert").textContent = !dashboard ? "看板已使用最近批次临时统计；重启履约服务后将自动切换为完整数据库统计。" : scheduler.scanning
        ? "履约服务正在扫描店铺，页面会在稍后刷新。"
        : `${health.shopCount || 0} 家店铺已连接。${scheduler.lastMessage || "等待下一次扫描。"}`;
      byId("fulfillmentSyncText").textContent = `更新于 ${formatTime(new Date().toISOString(), false)}`;
    } catch (error) {
      byId("fulfillmentServiceAlert").className = "fulfillment-service-alert bad";
      byId("fulfillmentServiceAlert").textContent = error.message;
      throw error;
    } finally {
      state.loading = false;
      byId("fulfillmentLoading").hidden = true;
      byId("fulfillmentContent").hidden = !state.loaded;
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
    byId("fulfillmentExceptionsTable").addEventListener("click", (event) => {
      const button = event.target.closest("[data-fulfillment-recheck]");
      if (button) recheckManualReview(button);
    });
    window.setInterval(() => {
      if (!document.getElementById("page-fulfillment")?.hidden) load(true).catch(() => {});
    }, 20000);
  }

  return { initialize, load, switchView };
}
