export const GROWTH_RADAR_VIEWS = Object.freeze([
  ["overview", "数据概览"],
  ["shops", "店铺与范围"],
  ["batches", "来源批次"],
  ["orders", "订单预览"],
  ["inventory", "库存预览"],
  ["quality", "数据质量"],
  ["semantics", "数据语义"],
  ["applications", "应用记录"],
]);

export const GROWTH_RADAR_PERMISSIONS = Object.freeze({
  view: "growth_radar.data.view",
  preview: "growth_radar.data.preview",
  apply: "growth_radar.data.apply",
  shopManage: "growth_radar.shop.manage",
  scopeConfirm: "growth_radar.scope.confirm",
  qualityView: "growth_radar.quality.view",
});

export const SEMANTIC_DEFINITIONS = Object.freeze([
  ["historical_observed", "历史发生", "只说明在历史订单事实中发生过，不表示当前在线。"],
  ["current_online", "当前在线", "需要权威在线来源；当前无真实来源时明确显示不可用。"],
  ["own_sales", "自有订单销量", "仅来自本系统接入且有效的自有订单事实。"],
  ["company_sales", "公司总销量", "需要经确认的公司级权威来源；当前无真实来源。"],
  ["source_visible_sales", "来源页面可见销量", "仅代表来源账号页面可见范围，不代表公司总销量。"],
  ["source_predicted_daily_sales", "来源预测日销量", "来源预测，不是实际销量，不与实际值合并。"],
]);

export const QUALITY_COPY = Object.freeze({
  missing_shop_mapping: ["缺少店铺映射", "完成店铺映射或确认店铺范围"],
  pending_shop_confirmation: ["店铺范围待确认", "由范围确认用户核对后确认"],
  missing_sku: ["SKU 未匹配", "在产品中心补齐对应 SKU"],
  empty_source_sku: ["来源 SKU 为空", "补齐来源 SKU 后重新预览"],
  empty_source_warehouse: ["来源仓库为空", "补齐来源仓库后重新预览"],
  duplicate_source_row: ["来源行重复", "核对并去除重复来源行"],
  invalid_order_status: ["订单状态无效", "使用支持的订单状态后重新预览"],
  pii_field_filtered: ["客户敏感字段已过滤", "保持 PII 在增长雷达之外"],
  formula_injection_risk: ["公式注入风险", "数据已拦截或安全处理"],
  inventory_key_not_visible_in_source_scope: ["库存键不在来源可见范围", "核对 SKU 与仓库范围"],
  current_online_source_unavailable: ["当前在线来源不可用", "接入权威当前在线来源"],
  company_sales_source_unavailable: ["公司销量来源不可用", "接入经确认的公司销量来源"],
  prediction_not_actual: ["预测值不是实际销量", "保持预测值与实际销量分层"],
  stale_preview: ["预览已过期", "重新生成预览"],
  source_scope_unconfirmed: ["来源范围待确认", "应用前核对并确认来源范围"],
});

const LABELS = Object.freeze({
  mabang_order: "马帮订单",
  mabang_inventory: "马帮库存",
  current_online: "当前在线",
  company_sales: "公司销量",
  manual_mapping: "人工映射",
  applied: "已应用",
  applying: "应用中",
  failed: "失败",
  preview_ready: "预览就绪",
  confirmed: "已确认",
  pending: "待确认",
  unconfirmed: "未确认",
  review_required: "待复核",
  available: "可用",
  unavailable: "不可用",
  source_prediction_not_actual: "预测，不是实际",
  blocker: "阻断",
  warning: "警告",
  information: "信息",
  open: "待处理",
  resolved: "已解决",
  active: "启用",
  inactive: "停用",
  historical_observed: "历史发生",
  own_sales: "自有订单销量",
  source_visible_sales: "来源可见销量",
  source_predicted_daily_sales: "来源预测日销量",
});

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function formatCount(value) {
  const number = finiteNumber(value);
  return number === null ? "—" : new Intl.NumberFormat("zh-CN").format(number);
}

export function formatMetricValue(metric) {
  if (!metric || metric.availability_status === "unavailable" || metric.value === null || metric.value === undefined) return "不可用";
  if (typeof metric.value === "object") {
    const values = [["7日", metric.value.days7], ["28日", metric.value.days28], ["42日", metric.value.days42]];
    const visible = values.filter(([, value]) => finiteNumber(value) !== null);
    return visible.length ? visible.map(([label, value]) => `${label} ${formatCount(value)}`).join(" · ") : "不可用";
  }
  return formatCount(metric.value);
}

export function formatDate(value, fallback = "尚无数据") {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("zh-CN", { hour12: false });
}

export function permissionState(capabilities, permission) {
  const granted = capabilities?.permissions?.[permission] === true;
  return { granted, reason: granted ? "" : "当前会话没有此操作权限" };
}

export function previewGate(preview, { canApply = false, scopeConfirmed = false, now = Date.now() } = {}) {
  if (!preview) return { allowed: false, reason: "请先生成预览" };
  if (preview.status !== "preview_ready") return { allowed: false, reason: "预览状态不是 preview_ready" };
  if (new Date(preview.expiresAt).getTime() <= Number(now)) return { allowed: false, reason: "预览已过期，请重新生成" };
  if ((preview.issues ?? []).some((issue) => issue.blocking === true || issue.severity === "blocker")) {
    return { allowed: false, reason: "存在阻断问题" };
  }
  if (!canApply) return { allowed: false, reason: "当前会话没有应用权限" };
  if (!scopeConfirmed) return { allowed: false, reason: "请先核对并确认来源范围" };
  return { allowed: true, reason: "" };
}

export function safeAuditText(value) {
  const text = String(value ?? "");
  if (!text) return "—";
  if (/token|cookie|password|authorization/i.test(text)) return "[已隐藏]";
  if (/^[A-Za-z]:\\|^\\\\|^\//.test(text)) return "[本机路径已隐藏]";
  return text.slice(0, 160);
}

export function requestPlanForView(view) {
  const plans = {
    overview: ["/api/growth-radar/freshness", "/api/growth-radar/source-batches", "/api/growth-radar/data-quality/issues", "/api/growth-radar/semantics/status"],
    shops: ["/api/growth-radar/shops"],
    batches: ["/api/growth-radar/source-batches"],
    orders: [],
    inventory: [],
    quality: ["/api/growth-radar/data-quality/issues"],
    semantics: ["/api/growth-radar/semantics/status"],
    applications: ["/api/growth-radar/source-batches"],
  };
  return [...(plans[view] ?? [])];
}

function badge(value, tone = "neutral") {
  const label = LABELS[value] ?? value ?? "—";
  return `<span class="gr-badge ${tone}"><span aria-hidden="true">●</span>${esc(label)}</span>`;
}

function toneFor(value) {
  if (["confirmed", "available", "applied", "active"].includes(value)) return "success";
  if (["blocker", "failed"].includes(value)) return "danger";
  if (["warning", "pending", "unconfirmed", "review_required"].includes(value)) return "warning";
  if (["information", "preview_ready"].includes(value)) return "info";
  return "muted";
}

function empty(title, message) {
  return `<div class="gr-empty"><span aria-hidden="true">◇</span><strong>${esc(title)}</strong><p>${esc(message)}</p></div>`;
}

function heading(title, description, aside = "") {
  return `<div class="gr-view-heading"><div><span class="gr-eyebrow">G1B · DATA SCOPE</span><h3>${esc(title)}</h3><p>${esc(description)}</p></div>${aside}</div>`;
}

function table(headers, rows, label) {
  if (!rows.length) return empty("暂无记录", "当前条件下没有可展示的数据。数据不可用时不会用 0 代替。");
  return `<div class="gr-table-wrap" role="region" aria-label="${esc(label)}" tabindex="0"><table class="gr-table"><thead><tr>${headers.map((item) => `<th scope="col">${esc(item)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}

function chips(values, fallback = "未声明") {
  const list = Array.isArray(values) ? values.filter(Boolean) : [];
  return list.length ? `<div class="gr-chips">${list.map((item) => `<span>${esc(item)}</span>`).join("")}</div>` : `<span class="gr-muted">${esc(fallback)}</span>`;
}

function permissionButton({ permission, capabilities, label, attributes = "", className = "", reason = "" }) {
  const state = permissionState(capabilities, permission);
  const blocked = reason || state.reason;
  return `<button type="button" class="${esc(className)}" ${attributes} ${blocked ? `disabled aria-disabled="true" title="${esc(blocked)}"` : ""}>${esc(label)}</button>`;
}

function issueDescription(issue) {
  return QUALITY_COPY[issue.issueCode ?? issue.code] ?? [issue.message ?? "数据质量问题", issue.recommendedAction ?? "复核来源数据"];
}

function safeSampleRows(issue) {
  const rows = Array.isArray(issue.sampleRows) ? issue.sampleRows : [];
  return rows.length ? rows.map((row) => `来源行 ${formatCount(row.sourceRowNumber)}`).join("、") : "无原始值回显";
}

export function createGrowthRadarPage({ authorizedFetch, onStatus = () => {}, rootId = "growthRadarRoot" }) {
  const state = {
    initialized: false,
    loaded: false,
    activeView: "overview",
    summary: {},
    capabilities: { permissions: {} },
    previews: {},
    scopeAcknowledged: { orders: false, inventory: false },
    lastApplication: {},
    qualityFilters: { issueCode: "", batchId: "", subject: "", severity: "", blocking: "" },
    shopFilter: "pending",
    renderSequence: 0,
  };
  const root = () => document.getElementById(rootId);

  async function api(path, options = {}) {
    const response = await authorizedFetch(path, options);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.error ?? "增长雷达数据操作失败。");
      error.code = body.issue_code ?? body.code ?? "GROWTH_RADAR_FAILED";
      throw error;
    }
    return body;
  }

  function can(permission) {
    return state.capabilities?.permissions?.[permission] === true;
  }

  function showError(error) {
    const target = document.getElementById("growthRadarView");
    if (target) target.innerHTML = `<div class="gr-callout danger" role="alert"><strong>无法完成操作</strong><p>${esc(error?.message ?? "增长雷达数据操作失败。")}</p><small>错误编号：${esc(error?.code ?? "GROWTH_RADAR_FAILED")}</small></div>`;
    onStatus(error?.message ?? "增长雷达操作失败", "error");
  }

  function renderShell() {
    const isA2ValidationRuntime = globalThis.location?.hostname === "127.0.0.1" && globalThis.location?.port === "3193";
    const permissions = [
      [GROWTH_RADAR_PERMISSIONS.view, "查看数据"],
      [GROWTH_RADAR_PERMISSIONS.preview, "执行预览"],
      [GROWTH_RADAR_PERMISSIONS.apply, "应用数据"],
      [GROWTH_RADAR_PERMISSIONS.shopManage, "管理店铺"],
      [GROWTH_RADAR_PERMISSIONS.scopeConfirm, "确认范围"],
    ];
    root().innerHTML = `
      <header class="gr-hero">
        <div class="gr-hero-copy"><span class="growth-radar-kicker">DETERMINISTIC GROWTH RADAR · G1B</span><h2>数据范围与来源管理</h2><p>以可追溯批次连接订单、库存和店铺范围。当前节点不提供机会评分、店铺推荐或 AI 推荐。</p></div>
        <div class="gr-hero-state"><span>正式范围状态</span><strong>${finiteNumber(state.summary.confirmedShopMappings) > 0 ? "部分已确认" : "待确认"}</strong><small>未确认店铺不进入正式机会范围</small></div>
      </header>
      ${isA2ValidationRuntime ? `<aside class="gr-validation-banner" role="status"><strong>测试/验收数据</strong><span>当前功能已通过合成脱敏 fixture 验证；真实马帮订单/库存样本尚未执行，不代表生产结果。</span></aside>` : ""}
      <section class="gr-permission-strip" aria-label="当前会话权限">
        <strong>当前权限</strong>${permissions.map(([permission, label]) => `<span class="${can(permission) ? "gr-allowed" : "gr-denied"}"><i aria-hidden="true">${can(permission) ? "✓" : "—"}</i>${esc(label)}<small>${can(permission) ? "允许" : "只读/禁用"}</small></span>`).join("")}
      </section>
      <nav class="gr-subnav" aria-label="增长雷达 G1B 工作区" role="tablist">${GROWTH_RADAR_VIEWS.map(([id, label]) => `<button type="button" role="tab" aria-selected="${state.activeView === id}" data-gr-view="${id}" class="${state.activeView === id ? "active" : ""}">${esc(label)}</button>`).join("")}</nav>
      <section id="growthRadarView" class="gr-view" aria-live="polite"></section>
      <dialog id="grActionDialog" class="gr-dialog" aria-labelledby="grDialogTitle"></dialog>`;
    renderView().catch(showError);
  }

  function setLoading(title) {
    const target = document.getElementById("growthRadarView");
    if (target) target.innerHTML = `${heading(title, "正在按需读取当前工作区数据。")}<div class="gr-skeleton" aria-label="正在加载" aria-busy="true"></div>`;
  }

  async function renderOverview() {
    const [freshness, batches, quality, semantics] = await Promise.all([
      api("/api/growth-radar/freshness"),
      api("/api/growth-radar/source-batches?page_size=30"),
      can(GROWTH_RADAR_PERMISSIONS.qualityView) ? api("/api/growth-radar/data-quality/issues?page_size=200&status=open") : Promise.resolve({ issues: [] }),
      api("/api/growth-radar/semantics/status"),
    ]);
    const issues = quality.issues ?? [];
    const blockerCount = issues.filter((issue) => issue.blocking === true || issue.severity === "blocker").length;
    const warningCount = issues.filter((issue) => issue.severity === "warning").length;
    const orderBatches = (batches.batches ?? []).filter((batch) => batch.sourceType === "mabang_order");
    const inventoryBatches = (batches.batches ?? []).filter((batch) => batch.sourceType === "mabang_inventory");
    const recentOrder = orderBatches[0];
    const recentInventory = inventoryBatches[0];
    const formalReady = finiteNumber(state.summary.confirmedShopMappings) > 0 && blockerCount === 0;
    const metrics = [
      ["来源批次数", state.summary.batches, "已应用并可追溯"],
      ["待确认店铺", state.summary.unresolvedShopMappings, "不进入正式机会范围"],
      ["已确认店铺", state.summary.confirmedShopMappings, "进入正式范围的映射"],
      ["订单预览", state.previews.orders ? 1 : 0, "仅当前浏览器会话"],
      ["库存预览", state.previews.inventory ? 1 : 0, "仅当前浏览器会话"],
      ["阻断问题", blockerCount, blockerCount ? "必须处理后才能应用" : "当前无阻断"],
      ["警告问题", warningCount, "不会伪装成成功"],
    ];
    const freshnessRows = (freshness.freshness ?? []).map((item) => `<tr><td>${esc(LABELS[item.sourceType] ?? item.sourceType)}</td><td>${formatDate(item.latestAt)}</td><td>${formatCount(item.batchCount)}</td></tr>`);
    return heading("数据概览", "区分已有、待确认、不可用和无权威来源；不可用指标不会显示为 0。", `<span class="gr-readiness ${formalReady ? "ready" : "pending"}"><i aria-hidden="true"></i>${formalReady ? "可用于已确认范围" : "正式范围尚未就绪"}</span>`) + `
      <div class="gr-overview-grid">${metrics.map(([label, value, hint]) => `<article><span>${esc(label)}</span><strong>${formatCount(value)}</strong><small>${esc(hint)}</small></article>`).join("")}</div>
      <div class="gr-status-grid">
        <section><span class="gr-section-label">最近数据窗口</span><strong>${recentOrder ? `${esc(recentOrder.dataWindowStart ?? "起始未知")} → ${esc(recentOrder.dataWindowEnd ?? "结束未知")}` : "尚无订单来源"}</strong><p>订单窗口来自来源批次，不根据库存时间推断。</p></section>
        <section><span class="gr-section-label">最近库存快照</span><strong>${recentInventory ? formatDate(recentInventory.snapshotAt) : "尚无库存来源"}</strong><p>库存保持 source_sku + source_warehouse 粒度。</p></section>
        <section class="unavailable"><span class="gr-section-label">CURRENT ONLINE</span><strong>${formatMetricValue(semantics.semantics?.current_online)}</strong><p>无权威数据源，不显示为 0。</p></section>
        <section class="unavailable"><span class="gr-section-label">COMPANY SALES</span><strong>${formatMetricValue(semantics.semantics?.company_sales)}</strong><p>无权威数据源，不显示为 0。</p></section>
      </div>
      <div class="gr-split"><section><h4>来源新鲜度</h4>${table(["来源", "最近时间", "批次数"], freshnessRows, "来源新鲜度")}</section><section class="gr-boundary-note"><span class="gr-section-label">能力边界</span><h4>G1B 仅完成数据闭环</h4><ul><li>历史发生不等于当前在线</li><li>来源可见销量不等于公司总销量</li><li>来源预测不等于实际销量</li><li>本节点不进入 G2 机会识别</li></ul></section></div>`;
  }

  async function renderShops() {
    const query = state.shopFilter ? `&confirmation_status=${encodeURIComponent(state.shopFilter)}` : "";
    const data = await api(`/api/growth-radar/shops?page_size=200${query}`);
    const controls = `<div class="gr-filter-tabs" role="group" aria-label="店铺确认状态"><button type="button" data-gr-shop-filter="pending" class="${state.shopFilter === "pending" ? "active" : ""}">待确认</button><button type="button" data-gr-shop-filter="confirmed" class="${state.shopFilter === "confirmed" ? "active" : ""}">已确认</button><button type="button" data-gr-shop-filter="" class="${state.shopFilter === "" ? "active" : ""}">全部</button></div>`;
    const rows = (data.shops ?? []).map((shop) => `<tr>
      <td><strong>${esc(shop.displayName)}</strong><small>来源名称将在详情中按映射展示</small></td>
      <td>${esc(shop.displayName)}<small>${esc(shop.internalShopCode)}</small></td>
      <td>${esc(LABELS[shop.platform] ?? shop.platform)}</td><td>${esc(shop.countryCode)} · ${esc(shop.countryName)}</td>
      <td>${esc(shop.ownerUserId ?? "未分配")}</td><td>${badge("historical_observed", "info")}</td>
      <td>${badge("unavailable", "muted")}<small>无权威在线来源</small></td>
      <td>${badge(shop.confirmationStatus, toneFor(shop.confirmationStatus))}<small>${shop.confirmationStatus === "pending" ? "不进入正式机会范围" : "已进入确认范围"}</small></td>
      <td>${shop.confirmationStatus === "confirmed" ? "详情查看" : "—"}</td><td>${formatDate(shop.updatedAt)}</td>
      <td><button type="button" class="button-tertiary" data-gr-shop-detail="${esc(shop.id)}">查看详情</button></td></tr>`);
    return heading("店铺与范围确认", "样本店铺默认保持 pending；不批量自动确认。确认和取消确认均保留服务端审计历史。", controls) + table(["店铺来源名称", "店铺显示名", "平台", "国家", "内部归属", "历史观察", "当前在线", "范围状态", "确认人", "最近更新", "操作"], rows, "店铺与范围列表");
  }

  function scopeCell(batch) {
    return `<div class="gr-scope-cell"><span>店铺 ${chips(batch.shopScope)}</span><span>国家 ${chips(batch.countryScope)}</span><span>仓库 ${chips(batch.warehouseScope)}</span><span>语义 ${chips(batch.semanticScope)}</span></div>`;
  }

  async function renderBatches({ applicationsOnly = false } = {}) {
    const data = await api("/api/growth-radar/source-batches?page_size=200");
    const batches = (data.batches ?? []).filter((batch) => !applicationsOnly || batch.status === "applied");
    const rows = batches.map((batch) => `<tr>
      <td><code>${esc(batch.id.slice(0, 8))}</code><small>${esc(batch.sourceFilename ?? "无来源文件名")}</small></td>
      <td><strong>${esc(LABELS[batch.sourceType] ?? batch.sourceType)}</strong><small>${esc(batch.sourceType)}</small></td>
      <td>${esc(batch.sourceSystem ?? "未声明")}</td><td>${formatDate(batch.importedAt ?? batch.createdAt)}</td><td>${formatDate(batch.snapshotAt, "不适用")}</td>
      <td>${batch.dataWindowStart || batch.dataWindowEnd ? `${esc(batch.dataWindowStart ?? "?")} → ${esc(batch.dataWindowEnd ?? "?")}` : "未声明"}</td>
      <td>${scopeCell(batch)}</td><td>${badge(batch.status, toneFor(batch.status))}</td><td>${badge(batch.confirmationStatus, toneFor(batch.confirmationStatus))}</td>
      <td>${batch.status === "applied" ? "已写入可追溯事实" : esc(batch.errorCode ?? "等待处理")}</td>
      <td><button type="button" class="button-tertiary" data-gr-batch-detail="${esc(batch.id)}">详情与结果</button></td></tr>`);
    const title = applicationsOnly ? "应用记录" : "来源批次";
    const description = applicationsOnly ? "展示真实应用结果、操作用户和审计入口；重复应用不会重复写入。" : "保留来源系统、数据窗口、范围、语义和确认状态；没有来源的数据类型不伪造批次。";
    return heading(title, description) + table(["批次 ID", "来源类型", "来源系统", "导入时间", "快照时间", "数据窗口", "范围", "状态", "确认", "应用结果", "操作"], rows, title);
  }

  function previewMetrics(preview, domain) {
    const summary = preview.summary ?? {};
    const order = [
      ["原始行数", summary.rawRowCount], ["有效行数", summary.validRowCount], ["无效行数", summary.invalidRowCount],
      ["重复行数", summary.duplicateRowCount], ["未匹配店铺", summary.unmatchedShopCount], ["未匹配 SKU", summary.unmatchedSkuCount],
      ["被排除订单", summary.excludedStatusCount], ["PII 字段", summary.piiFieldCount ?? preview.piiFilteredFieldCount],
      ["公式风险", preview.formulaCellCount], ["唯一订单", summary.standardOrderCount], ["唯一 SKU", summary.uniqueSkuCount],
    ];
    const inventory = [
      ["原始行数", summary.rawRowCount], ["有效快照", summary.validSnapshotCount], ["空 SKU", summary.emptySkuCount],
      ["空仓库", summary.emptyWarehouseCount], ["重复记录", summary.duplicateRecordCount], ["多仓 SKU", summary.multiWarehouseSkuCount],
      ["未匹配 SKU", summary.unmatchedSkuCount], ["唯一 SKU", summary.uniqueSkuCount], ["仓库数", summary.warehouseCount],
    ];
    return domain === "orders" ? order : inventory;
  }

  function renderPreviewIssues(preview) {
    const issues = preview.issues ?? [];
    if (!issues.length) return `<div class="gr-callout success"><strong>未检测到数据质量问题</strong><p>仍需人工核对来源范围后才能应用。</p></div>`;
    return `<div class="gr-preview-issues"><h4>预览问题</h4>${issues.map((issue) => { const [description, action] = issueDescription(issue); return `<article><div>${badge(issue.severity, toneFor(issue.severity))}<strong>${esc(issue.issueCode)}</strong></div><p>${esc(description)} · 影响 ${formatCount(issue.affectedCount)}</p><small>${esc(action)}${issue.blocking ? " · 阻断应用" : ""}</small></article>`; }).join("")}</div>`;
  }

  function renderPreviewSample(preview, domain) {
    const rows = (preview.sampleRows ?? []).map((row) => {
      const item = row.normalized ?? {};
      if (domain === "orders") return `<tr><td>${formatCount(row.sourceRowNumber)}</td><td>${esc(item.orderHint ?? "已脱敏")}</td><td>${esc(item.sourceShopName ?? "—")}</td><td>${esc(item.sourceSku ?? "—")}</td><td>${esc(item.warehouseName ?? "—")}</td><td>${esc(item.orderStatus ?? "—")}</td><td>${badge(row.parseStatus, toneFor(row.parseStatus))}</td></tr>`;
      return `<tr><td>${formatCount(row.sourceRowNumber)}</td><td>${esc(item.sourceSku ?? "—")}</td><td>${esc(item.warehouseName ?? "—")}</td><td>${formatCount(item.availableQuantity)}</td><td>${formatCount(item.sourceVisibleSales7d)}<small>来源页面可见销量</small></td><td>${formatCount(item.sourcePredictedDailySales)}<small>来源预测，不是实际销量</small></td><td>${badge(row.parseStatus, toneFor(row.parseStatus))}</td></tr>`;
    });
    const headers = domain === "orders" ? ["来源行", "订单标识", "店铺", "SKU", "仓库", "状态", "解析"] : ["来源行", "SKU", "来源仓库", "可用量", "来源可见销量", "预测日销量", "解析"];
    return table(headers, rows, `${domain === "orders" ? "订单" : "库存"}脱敏预览样本`);
  }

  function renderImport(domain) {
    const isOrder = domain === "orders";
    const preview = state.previews[domain];
    const permission = permissionState(state.capabilities, GROWTH_RADAR_PERMISSIONS.preview);
    const gate = previewGate(preview, { canApply: can(GROWTH_RADAR_PERMISSIONS.apply), scopeConfirmed: state.scopeAcknowledged[domain] });
    const result = state.lastApplication[domain];
    const metadata = isOrder ? "" : `<div class="gr-inline-fields"><label for="gr-inventory-platform">来源平台<input id="gr-inventory-platform" value="mabang" autocomplete="off"></label><label for="gr-inventory-country">国家代码（可选）<input id="gr-inventory-country" maxlength="8" placeholder="例如 TH" autocomplete="off"></label><label for="gr-inventory-snapshot">快照时间（可选）<input id="gr-inventory-snapshot" type="datetime-local"></label></div>`;
    const metrics = previewMetrics(preview ?? {}, domain);
    return heading(isOrder ? "订单数据预览" : "库存数据预览", isOrder ? "先执行只读预览；客户 PII 和公式风险仅展示安全分类，不回显原始值。" : "匹配键固定为 source_sku + source_warehouse；同一 SKU 的多个仓库保持独立。") + `
      <div class="gr-import-grid"><section class="gr-upload-card"><span class="gr-step">01 · 只读预览</span><h4>选择 ${isOrder ? "马帮订单" : "马帮库存"} Excel</h4><label class="gr-file-label" for="gr-${domain}-file">来源文件</label><input id="gr-${domain}-file" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ${permission.granted ? "" : `disabled title="${esc(permission.reason)}"`}>
      ${metadata}<button type="button" data-gr-preview="${domain}" ${permission.granted ? "" : `disabled aria-disabled="true" title="${esc(permission.reason)}"`}>生成只读预览</button><p>预览阶段不创建批次、不写原始行、不生成标准事实。</p></section>
      <section class="gr-confirm-card"><span class="gr-step">02 · 范围确认</span><h4>确认来源范围</h4><label class="gr-check"><input type="checkbox" data-gr-scope-ack="${domain}" ${state.scopeAcknowledged[domain] ? "checked" : ""} ${preview ? "" : "disabled"}><span>我已核对数据窗口、店铺/国家/仓库范围和语义边界</span></label><p>${preview ? `预览有效期至 ${formatDate(preview.expiresAt)}` : "请先生成预览。确认不会修改解析行内容。"}</p><button type="button" data-gr-apply="${domain}" ${gate.allowed ? "" : `disabled aria-disabled="true" title="${esc(gate.reason)}"`}>打开应用确认</button><small class="gr-control-reason">${esc(gate.allowed ? "点击后仍需二次确认" : gate.reason)}</small></section></div>
      ${preview ? `<section class="gr-preview-result"><div class="gr-preview-head"><div><span class="gr-eyebrow">PREVIEW_READY · 尚未写库</span><h3>${esc(preview.sourceFilename)}</h3><p>${isOrder ? `数据窗口 ${esc(preview.summary?.dataWindow?.start ?? "未知")} → ${esc(preview.summary?.dataWindow?.end ?? "未知")}` : `快照时间 ${formatDate(preview.summary?.snapshotAt)}`}</p></div>${badge(preview.status, "info")}</div><div class="gr-mini-metrics">${metrics.map(([label, value]) => `<div><span>${esc(label)}</span><strong>${formatCount(value)}</strong></div>`).join("")}</div>${isOrder ? `<div class="gr-safety-note"><strong>PII 安全摘要</strong><p>检测类别：个人身份、联系方式与客户备注 · 影响字段 ${formatCount(preview.piiFilteredFieldCount)} · 脱敏样本：已过滤，不回显客户原值。</p><strong>公式安全摘要</strong><p>风险单元格 ${formatCount(preview.formulaCellCount)}；数据已拦截或安全处理，不回显可执行公式。</p></div>` : `<div class="gr-safety-note"><strong>匹配键：source_sku + source_warehouse</strong><p>多仓 SKU 不合并。来源预测标注为“预测，不是实际”；来源可见销量不代表公司总销量。</p></div>`}${renderPreviewIssues(preview)}<h4>脱敏样本</h4>${renderPreviewSample(preview, domain)}</section>` : empty("等待预览", `选择经过批准的${isOrder ? "订单" : "库存"}文件后生成只读预览。`) }
      ${result ? `<section class="gr-application-result"><span class="gr-section-label">最近应用结果</span><h4>${result.reused ? "该批次已经应用，无重复写入" : "应用完成"}</h4><div><span>新增 <strong>${formatCount(result.applicationResult?.createdCount)}</strong></span><span>更新 <strong>${formatCount(result.applicationResult?.updatedCount)}</strong></span><span>忽略 <strong>${formatCount(result.applicationResult?.ignoredCount)}</strong></span><span>应用时间 <strong>${formatDate(result.batch?.importedAt)}</strong></span><span>操作用户 <strong>${esc(safeAuditText(result.batch?.createdBy))}</strong></span></div><button type="button" class="button-tertiary" data-gr-batch-detail="${esc(result.batch?.id)}">查看批次与审计入口</button></section>` : ""}`;
  }

  async function renderQuality() {
    if (!can(GROWTH_RADAR_PERMISSIONS.qualityView)) return heading("数据质量问题", "当前会话没有数据质量查看权限。") + empty("无查看权限", "写操作不会因为前端隐藏而获得权限，服务器仍会拒绝未授权请求。");
    const data = await api("/api/growth-radar/data-quality/issues?page_size=200&status=open");
    const filters = state.qualityFilters;
    const issues = (data.issues ?? []).filter((issue) => {
      const code = issue.issueCode ?? issue.code ?? "";
      const subject = JSON.stringify(issue.sourceContext ?? {}).toLocaleLowerCase("zh-CN");
      return (!filters.issueCode || code.includes(filters.issueCode))
        && (!filters.batchId || issue.batchId.includes(filters.batchId))
        && (!filters.subject || subject.includes(filters.subject.toLocaleLowerCase("zh-CN")))
        && (!filters.severity || issue.severity === filters.severity)
        && (!filters.blocking || String(issue.blocking === true) === filters.blocking);
    });
    const form = `<form id="grQualityFilter" class="gr-quality-filter"><label>问题代码<input name="issueCode" value="${esc(filters.issueCode)}" placeholder="例如 missing_sku"></label><label>来源批次<input name="batchId" value="${esc(filters.batchId)}" placeholder="批次 ID"></label><label>店铺或 SKU<input name="subject" value="${esc(filters.subject)}" placeholder="安全上下文关键字"></label><label>严重程度<select name="severity"><option value="">全部</option>${[["blocker", "阻断"], ["warning", "警告"], ["information", "信息"]].map(([value, label]) => `<option value="${value}" ${filters.severity === value ? "selected" : ""}>${label}</option>`).join("")}</select></label><label>是否阻断<select name="blocking"><option value="">全部</option><option value="true" ${filters.blocking === "true" ? "selected" : ""}>是</option><option value="false" ${filters.blocking === "false" ? "selected" : ""}>否</option></select></label><button type="submit">应用筛选</button></form>`;
    const rows = issues.map((issue) => { const [description, action] = issueDescription(issue); return `<tr><td>${badge(issue.severity, toneFor(issue.severity))}</td><td><strong>${esc(issue.issueCode ?? issue.code)}</strong><small>${esc(description)}</small></td><td>${formatCount(issue.affectedCount)}</td><td>${esc(action)}</td><td>${esc(safeSampleRows(issue))}</td><td>${issue.blocking ? badge("blocker", "danger") : "否"}</td><td><code>${esc(issue.batchId.slice(0, 8))}</code></td></tr>`; });
    return heading("数据质量问题", "按稳定 issue_code 展示阻断、警告和信息；样本只显示来源行号，不显示原始客户信息。", `<span class="gr-result-count">${formatCount(issues.length)} / ${formatCount(data.total)} 条</span>`) + form + table(["级别", "问题代码与说明", "影响数量", "推荐动作", "脱敏样本", "阻断应用", "来源批次"], rows, "数据质量问题列表");
  }

  async function renderSemantics() {
    const data = await api("/api/growth-radar/semantics/status");
    const semantics = data.semantics ?? {};
    return heading("数据语义与可用状态", "每个指标使用相同语义信封：值、类型、来源、观察/快照时间、确认状态和可用状态。") + `<div class="gr-semantic-grid">${SEMANTIC_DEFINITIONS.map(([key, name, description]) => {
      const metric = semantics[key] ?? {};
      const unavailable = metric.availability_status === "unavailable";
      return `<article class="${unavailable ? "unavailable" : ""}"><header><div><span>${esc(key)}</span><h4>${esc(name)}</h4></div>${badge(metric.availability_status ?? "unavailable", toneFor(metric.availability_status))}</header><div class="gr-semantic-value">${esc(formatMetricValue(metric))}</div><dl><div><dt>semantic_type</dt><dd>${esc(metric.semantic_type ?? key)}</dd></div><div><dt>来源</dt><dd>${esc(metric.source ? (LABELS[metric.source] ?? metric.source) : "无权威数据源")}</dd></div><div><dt>观察/快照时间</dt><dd>${formatDate(metric.observed_at ?? metric.snapshot_at)}</dd></div><div><dt>确认状态</dt><dd>${esc(LABELS[metric.confirmation_status] ?? metric.confirmation_status ?? "未确认")}</dd></div><div><dt>可用状态</dt><dd>${esc(LABELS[metric.availability_status] ?? metric.availability_status ?? "不可用")}</dd></div></dl><p>${esc(description)}</p></article>`;
    }).join("")}</div>`;
  }

  async function renderView() {
    const sequence = ++state.renderSequence;
    const view = state.activeView;
    const title = GROWTH_RADAR_VIEWS.find(([id]) => id === view)?.[1] ?? "数据概览";
    setLoading(title);
    let html;
    if (!can(GROWTH_RADAR_PERMISSIONS.view)) html = heading(title, "当前会话没有增长雷达数据查看权限。") + empty("无查看权限", "请联系管理员授予 growth_radar.data.view。");
    else if (view === "overview") html = await renderOverview();
    else if (view === "shops") html = await renderShops();
    else if (view === "batches") html = await renderBatches();
    else if (view === "orders") html = renderImport("orders");
    else if (view === "inventory") html = renderImport("inventory");
    else if (view === "quality") html = await renderQuality();
    else if (view === "semantics") html = await renderSemantics();
    else html = await renderBatches({ applicationsOnly: true });
    if (sequence === state.renderSequence) document.getElementById("growthRadarView").innerHTML = html;
  }

  function openDialog({ title, description = "", body = "", confirmLabel = "确认", danger = false, onConfirm }) {
    const dialog = document.getElementById("grActionDialog");
    dialog.innerHTML = `<form method="dialog" class="gr-dialog-shell"><header><div><span class="gr-eyebrow">需要用户确认</span><h3 id="grDialogTitle">${esc(title)}</h3><p>${esc(description)}</p></div><button type="button" class="gr-dialog-close" data-gr-dialog-close aria-label="关闭弹窗">×</button></header><div class="gr-dialog-body">${body}</div><footer><button type="button" class="button-tertiary" data-gr-dialog-close>取消</button><button type="submit" class="${danger ? "button-danger" : ""}">${esc(confirmLabel)}</button></footer></form>`;
    const form = dialog.querySelector("form");
    const close = () => dialog.close();
    dialog.querySelectorAll("[data-gr-dialog-close]").forEach((button) => button.addEventListener("click", close));
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const submit = form.querySelector('button[type="submit"]');
      submit.disabled = true;
      try { await onConfirm(new FormData(form)); dialog.close(); } catch (error) { submit.disabled = false; showDialogError(dialog, error); }
    });
    dialog.showModal();
    dialog.querySelector("input, select, button")?.focus();
  }

  function showDialogError(dialog, error) {
    dialog.querySelector(".gr-dialog-error")?.remove();
    const message = document.createElement("div");
    message.className = "gr-dialog-error";
    message.setAttribute("role", "alert");
    message.textContent = error?.message ?? "操作失败。";
    dialog.querySelector(".gr-dialog-body").append(message);
  }

  async function showShopDetail(id) {
    const data = await api(`/api/growth-radar/shops/${encodeURIComponent(id)}`);
    const detail = data.detail;
    const shop = detail.shop;
    const mapping = detail.mappings?.[0] ?? {};
    const history = detail.history ?? [];
    const latest = history[0];
    const body = `<div class="gr-detail-grid"><dl><div><dt>店铺来源名称</dt><dd>${esc(mapping.sourceShopName ?? shop.displayName)}</dd></div><div><dt>店铺显示名</dt><dd>${esc(shop.displayName)}</dd></div><div><dt>平台 / 国家</dt><dd>${esc(shop.platform)} · ${esc(shop.countryCode)} ${esc(shop.countryName)}</dd></div><div><dt>内部归属</dt><dd>${esc(shop.ownerUserId ?? "未分配")}</dd></div><div><dt>历史观察状态</dt><dd>historical_observed</dd></div><div><dt>当前在线状态</dt><dd>不可用 · 无权威来源</dd></div><div><dt>范围确认</dt><dd>${esc(LABELS[shop.confirmationStatus] ?? shop.confirmationStatus)}</dd></div><div><dt>确认人 / 时间</dt><dd>${esc(safeAuditText(mapping.confirmedBy))} · ${formatDate(mapping.confirmedAt)}</dd></div><div><dt>最近来源批次</dt><dd>${esc(mapping.lastSourceBatchId ?? "尚无来源批次")}</dd></div></dl></div>
      <div class="gr-detail-actions">${permissionButton({ permission: GROWTH_RADAR_PERMISSIONS.shopManage, capabilities: state.capabilities, label: "编辑店铺", attributes: `data-gr-edit-shop="${esc(shop.id)}"` })}${shop.confirmationStatus === "confirmed" ? permissionButton({ permission: GROWTH_RADAR_PERMISSIONS.scopeConfirm, capabilities: state.capabilities, label: "取消确认", className: "button-danger", attributes: `data-gr-revoke-scope="${esc(shop.id)}"` }) : permissionButton({ permission: GROWTH_RADAR_PERMISSIONS.scopeConfirm, capabilities: state.capabilities, label: "确认进入范围", attributes: `data-gr-confirm-scope="${esc(shop.id)}"` })}</div>
      <section class="gr-history"><h4>确认历史</h4>${history.length ? history.map((event) => `<article><strong>${esc(LABELS[event.action] ?? event.action)}</strong><span>${esc(safeAuditText(event.actorLabel))} · ${formatDate(event.occurredAt)}</span><small>变化字段：${esc((event.after?.changedFields ?? []).join("、") || "未声明")} ${event.after?.reason ? `· 原因：${esc(event.after.reason)}` : ""}</small></article>`).join("") : empty("暂无确认历史", "店铺尚未执行范围确认或取消确认。")}</section>
      ${latest ? `<p class="gr-audit-foot">最近审计请求：${esc(safeAuditText(latest.requestId))}</p>` : ""}`;
    openDialog({ title: shop.displayName, description: shop.confirmationStatus === "pending" ? "当前不进入正式机会范围" : "已进入确认范围", body, confirmLabel: "关闭", onConfirm: async () => {} });
  }

  async function editShop(id) {
    const data = await api(`/api/growth-radar/shops/${encodeURIComponent(id)}`);
    const shop = data.detail.shop;
    openDialog({ title: "编辑店铺范围属性", description: "编辑不会自动确认店铺进入正式范围。", confirmLabel: "保存修改", body: `<div class="gr-form-grid"><label>显示名<input name="displayName" required value="${esc(shop.displayName)}"></label><label>平台<input name="platform" required value="${esc(shop.platform)}"></label><label>国家代码<input name="countryCode" required maxlength="8" value="${esc(shop.countryCode)}"></label><label>国家名称<input name="countryName" required value="${esc(shop.countryName)}"></label><label>内部负责人或组织归属<input name="ownerUserId" value="${esc(shop.ownerUserId ?? "")}" placeholder="可选"></label></div>`, onConfirm: async (formData) => {
      const body = Object.fromEntries(formData);
      await api(`/api/growth-radar/shops/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      onStatus("店铺范围属性已更新，确认状态未被自动改变。", "success");
      await renderView();
    } });
  }

  async function confirmShop(id) {
    const detail = (await api(`/api/growth-radar/shops/${encodeURIComponent(id)}`)).detail;
    openDialog({ title: "确认店铺进入正式范围", description: "这是二次确认。确认用户由服务器认证上下文决定，客户端不会提交 confirmedBy。", confirmLabel: "确认进入范围", body: `<div class="gr-confirm-summary"><p><strong>店铺</strong>${esc(detail.shop.displayName)}</p><p><strong>平台 / 国家</strong>${esc(detail.shop.platform)} · ${esc(detail.shop.countryCode)} ${esc(detail.shop.countryName)}</p><p><strong>来源映射</strong>${formatCount(detail.mappings?.length)}</p><div class="gr-callout warning"><strong>范围影响</strong><p>确认后，该店铺的合格历史观察可进入正式机会范围。当前仍不会启动 G2 评分。</p></div></div>`, onConfirm: async () => {
      const result = await api(`/api/growth-radar/shops/${encodeURIComponent(id)}/confirm`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      onStatus(result.reused ? "该店铺已经确认，未重复写入。" : "店铺已确认进入范围。", "success");
      state.summary = (await api("/api/growth-radar/summary")).summary;
      await renderView();
    } });
  }

  function revokeShop(id) {
    openDialog({ title: "取消店铺范围确认", description: "必须填写原因；操作用户和时间由服务器记录。", confirmLabel: "确认取消", danger: true, body: `<label class="gr-full-field">取消原因<textarea name="reason" required minlength="3" maxlength="500" rows="4" placeholder="说明范围变化依据"></textarea></label><div class="gr-callout danger"><strong>影响说明</strong><p>取消后，该店铺不再进入正式机会范围，历史事实仍保留并可审计。</p></div>`, onConfirm: async (formData) => {
      const reason = String(formData.get("reason") ?? "").trim();
      if (!reason) throw new Error("取消确认必须填写原因。");
      const result = await api(`/api/growth-radar/shops/${encodeURIComponent(id)}/revoke`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason }) });
      onStatus(result.reused ? "该店铺已是待确认状态。" : "店铺范围确认已取消并保留原因。", "success");
      state.summary = (await api("/api/growth-radar/summary")).summary;
      await renderView();
    } });
  }

  async function showBatchDetail(id) {
    const [detailData, resultData, qualityData] = await Promise.all([
      api(`/api/growth-radar/source-batches/${encodeURIComponent(id)}`),
      api(`/api/growth-radar/source-batches/${encodeURIComponent(id)}/result`),
      can(GROWTH_RADAR_PERMISSIONS.qualityView) ? api(`/api/growth-radar/data-quality/issues?page_size=200&batch_id=${encodeURIComponent(id)}`) : Promise.resolve({ issues: [] }),
    ]);
    const batch = detailData.detail.batch;
    const metrics = resultData.applicationResult ?? {};
    const issues = qualityData.issues ?? [];
    const blockerCount = issues.filter((issue) => issue.blocking === true || issue.severity === "blocker").length;
    const created = (metrics.orderHeaders ?? 0) + (metrics.orderLines ?? 0) + (metrics.inventorySnapshots ?? 0);
    const body = `<div class="gr-batch-detail"><dl><div><dt>批次类型</dt><dd>${esc(LABELS[batch.sourceType] ?? batch.sourceType)} <code>${esc(batch.sourceType)}</code></dd></div><div><dt>来源系统</dt><dd>${esc(batch.sourceSystem ?? "未声明")}</dd></div><div><dt>数据窗口</dt><dd>${esc(batch.dataWindowStart ?? "未声明")} → ${esc(batch.dataWindowEnd ?? "未声明")}</dd></div><div><dt>快照时间</dt><dd>${formatDate(batch.snapshotAt, "不适用")}</dd></div><div><dt>店铺范围</dt><dd>${chips(batch.shopScope)}</dd></div><div><dt>国家范围</dt><dd>${chips(batch.countryScope)}</dd></div><div><dt>仓库范围</dt><dd>${chips(batch.warehouseScope)}</dd></div><div><dt>语义范围</dt><dd>${chips(batch.semanticScope)}</dd></div><div><dt>状态 / 确认</dt><dd>${badge(batch.status, toneFor(batch.status))} ${badge(batch.confirmationStatus, toneFor(batch.confirmationStatus))}</dd></div><div><dt>阻断问题</dt><dd>${formatCount(blockerCount)}</dd></div></dl>
      <section><h4>实际应用结果</h4><div class="gr-mini-metrics"><div><span>标准事实新增</span><strong>${formatCount(created)}</strong></div><div><span>订单原始行</span><strong>${formatCount(metrics.orderRawRows)}</strong></div><div><span>库存原始行</span><strong>${formatCount(metrics.inventoryRawRows)}</strong></div><div><span>质量问题</span><strong>${formatCount(metrics.qualityIssues)}</strong></div><div><span>映射问题</span><strong>${formatCount(metrics.mappingIssues)}</strong></div></div></section>
      <section class="gr-history"><h4>脱敏审计记录</h4><article><strong>数据应用</strong><span>${esc(safeAuditText(batch.createdBy))} · ${formatDate(batch.importedAt ?? batch.createdAt)}</span><small>批次 ${esc(batch.id.slice(0, 8))} · 文件仅保留基础名称 ${esc(batch.sourceFilename ?? "未声明")}</small></article><button type="button" class="button-tertiary" data-gr-open-audit>打开操作记录</button></section></div>`;
    openDialog({ title: `来源批次 ${batch.id.slice(0, 8)}`, description: "批次详情、质量状态、实际计数与审计入口", body, confirmLabel: "关闭", onConfirm: async () => {} });
  }

  async function previewFile(domain, button) {
    const file = document.getElementById(`gr-${domain}-file`)?.files?.[0];
    if (!file) throw new Error("请先选择 .xlsx 来源文件。");
    button.disabled = true;
    button.textContent = "正在安全解析…";
    try {
      const headers = { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "x-file-name": encodeURIComponent(file.name) };
      if (domain === "inventory") {
        headers["x-source-platform"] = document.getElementById("gr-inventory-platform").value.trim();
        headers["x-source-country"] = document.getElementById("gr-inventory-country").value.trim().toUpperCase();
        const collectedAt = document.getElementById("gr-inventory-snapshot").value;
        if (collectedAt) headers["x-collected-at"] = new Date(collectedAt).toISOString();
      }
      const data = await api(`/api/growth-radar/import/${domain}/preview`, { method: "POST", headers, body: file });
      state.previews[domain] = data.preview;
      state.scopeAcknowledged[domain] = false;
      delete state.lastApplication[domain];
      onStatus(`${domain === "orders" ? "订单" : "库存"}只读预览完成，尚未写库。`, "success");
      await renderView();
    } finally {
      button.disabled = false;
    }
  }

  function confirmApply(domain) {
    const preview = state.previews[domain];
    const gate = previewGate(preview, { canApply: can(GROWTH_RADAR_PERMISSIONS.apply), scopeConfirmed: state.scopeAcknowledged[domain] });
    if (!gate.allowed) throw new Error(gate.reason);
    const summary = preview.summary ?? {};
    const blockers = (preview.issues ?? []).filter((issue) => issue.blocking === true || issue.severity === "blocker").length;
    const valid = domain === "orders" ? summary.validRowCount : summary.validSnapshotCount;
    const shopCount = summary.sourceShopCount ?? preview.sourceScope?.shopScope?.length;
    const skuCount = summary.uniqueSkuCount;
    openDialog({ title: "确认应用预览数据", description: "二次确认后才会写入 A2 隔离数据库；弹窗内不能修改解析行。", confirmLabel: "确认应用到隔离库", body: `<div class="gr-confirm-summary"><p><strong>批次类型</strong>${esc(LABELS[preview.sourceType] ?? preview.sourceType)}</p><p><strong>数据窗口</strong>${esc(summary.dataWindow?.start ?? summary.snapshotAt ?? "未声明")} → ${esc(summary.dataWindow?.end ?? summary.snapshotAt ?? "未声明")}</p><p><strong>原始 / 有效行</strong>${formatCount(summary.rawRowCount)} / ${formatCount(valid)}</p><p><strong>阻断问题</strong>${formatCount(blockers)}</p><p><strong>待应用数量</strong>${formatCount(valid)}</p><p><strong>影响店铺 / SKU</strong>${formatCount(shopCount)} / ${formatCount(skuCount)}</p><div class="gr-callout warning"><strong>不可逆影响说明</strong><p>应用会创建可追溯来源批次和事实记录；不能在此修改解析行。相同来源哈希将幂等复用，不会重复写入。</p></div></div>`, onConfirm: async () => {
      const result = await api(`/api/growth-radar/import/${domain}/apply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ previewId: preview.previewId, idempotencyKey: preview.sourceSha256 }) });
      state.lastApplication[domain] = result;
      state.summary = (await api("/api/growth-radar/summary")).summary;
      onStatus(result.reused ? "该批次已经应用，无重复写入。" : "数据已应用到 A2 隔离库。", "success");
      await renderView();
    } });
  }

  function initialize() {
    if (state.initialized) return;
    state.initialized = true;
    root()?.addEventListener("click", (event) => {
      const view = event.target.closest("[data-gr-view]");
      if (view) { state.activeView = view.dataset.grView; renderShell(); return; }
      const shopFilter = event.target.closest("[data-gr-shop-filter]");
      if (shopFilter) { state.shopFilter = shopFilter.dataset.grShopFilter; renderView().catch(showError); return; }
      const shop = event.target.closest("[data-gr-shop-detail]");
      if (shop) { showShopDetail(shop.dataset.grShopDetail).catch(showError); return; }
      const edit = event.target.closest("[data-gr-edit-shop]");
      if (edit) { document.getElementById("grActionDialog")?.close(); editShop(edit.dataset.grEditShop).catch(showError); return; }
      const confirm = event.target.closest("[data-gr-confirm-scope]");
      if (confirm) { document.getElementById("grActionDialog")?.close(); confirmShop(confirm.dataset.grConfirmScope).catch(showError); return; }
      const revoke = event.target.closest("[data-gr-revoke-scope]");
      if (revoke) { document.getElementById("grActionDialog")?.close(); revokeShop(revoke.dataset.grRevokeScope); return; }
      const batch = event.target.closest("[data-gr-batch-detail]");
      if (batch) { showBatchDetail(batch.dataset.grBatchDetail).catch(showError); return; }
      const previewButton = event.target.closest("[data-gr-preview]");
      if (previewButton) { previewFile(previewButton.dataset.grPreview, previewButton).catch(showError); return; }
      const applyButton = event.target.closest("[data-gr-apply]");
      if (applyButton) { try { confirmApply(applyButton.dataset.grApply); } catch (error) { showError(error); } return; }
      if (event.target.closest("[data-gr-open-audit]")) { document.getElementById("grActionDialog")?.close(); location.hash = "#audit"; }
    });
    root()?.addEventListener("change", (event) => {
      const checkbox = event.target.closest("[data-gr-scope-ack]");
      if (!checkbox) return;
      state.scopeAcknowledged[checkbox.dataset.grScopeAck] = checkbox.checked;
      renderView().catch(showError);
    });
    root()?.addEventListener("submit", (event) => {
      if (event.target.id !== "grQualityFilter") return;
      event.preventDefault();
      state.qualityFilters = Object.fromEntries(new FormData(event.target));
      renderView().catch(showError);
    });
  }

  async function load({ force = false } = {}) {
    if (state.loaded && !force) return;
    const [capabilities, summary] = await Promise.all([
      api("/api/growth-radar/capabilities"),
      api("/api/growth-radar/summary"),
    ]);
    state.capabilities = capabilities.capabilities ?? { permissions: {} };
    state.summary = summary.summary ?? {};
    state.loaded = true;
    renderShell();
  }

  return { initialize, load, requestPlanForView };
}
