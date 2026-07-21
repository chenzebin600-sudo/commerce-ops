const VIEWS = Object.freeze([
  ["batches", "来源批次"],
  ["orders", "订单预览"],
  ["inventory", "库存预览"],
  ["shops", "店铺主数据"],
  ["shop-mapping", "待处理店铺"],
  ["sku-mapping", "待处理 SKU"],
  ["quality", "数据质量"],
  ["freshness", "新鲜度"],
]);

const LABELS = Object.freeze({
  mabang_order: "马帮订单",
  mabang_inventory: "马帮库存",
  applied: "已入库",
  applying: "处理中",
  failed: "失败",
  matched: "已匹配",
  manually_confirmed: "人工确认",
  unmatched: "未匹配",
  ambiguous: "有歧义",
  revoked: "已撤销",
  blocker: "阻断",
  warning: "警告",
  open: "待处理",
  resolved: "已解决",
  historical_observed: "历史观察",
  current_online: "当前在线",
  country_unresolved: "国家待确认",
  sku_ambiguous: "跨国家歧义",
  sku_unmatched: "SKU 未匹配",
});

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function formatNumber(value) {
  return new Intl.NumberFormat("zh-CN").format(Number(value || 0));
}

function formatDate(value) {
  if (!value) return "尚无数据";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("zh-CN", { hour12: false });
}

function badge(value, tone = "neutral") {
  return `<span class="gr-badge ${tone}">${esc(LABELS[value] || value || "—")}</span>`;
}

function empty(message) {
  return `<div class="gr-empty"><strong>暂无记录</strong><p>${esc(message)}</p></div>`;
}

function table(headers, rows) {
  if (!rows.length) return empty("当前筛选条件下没有可显示的数据。");
  return `<div class="gr-table-wrap"><table class="gr-table"><thead><tr>${headers.map((item) => `<th>${esc(item)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}

function summarizePreview(preview, domain) {
  const summary = preview.summary || {};
  const items = domain === "orders" ? [
    ["原始行", summary.rawRowCount], ["标准订单", summary.standardOrderCount], ["标准明细", summary.standardLineCount],
    ["多行订单", summary.multiLineOrders], ["最大行数", summary.maxLinesPerOrder], ["作废订单", summary.cancelledOrders],
    ["来源店铺", summary.sourceShopCount], ["唯一 SKU", summary.uniqueSkuCount], ["跨国家歧义", summary.crossCountryAmbiguousSkus],
    ["未匹配 SKU", summary.unmatchedSkus],
  ] : [
    ["原始行", summary.rawRowCount], ["快照候选", summary.snapshotCandidateCount], ["拒绝行", summary.rejectedRowCount],
  ];
  return `<div class="gr-preview-result">
    <div class="gr-preview-head"><div><span class="gr-eyebrow">预览完成 · 尚未写库</span><h3>${esc(preview.sourceFilename)}</h3></div>${badge("只读预览", "info")}</div>
    <div class="gr-mini-metrics">${items.map(([label, value]) => `<div><span>${esc(label)}</span><strong>${formatNumber(value)}</strong></div>`).join("")}</div>
    <p class="gr-method-note">${domain === "orders" ? "订单金额只采用订单级人民币核算金额；行金额不可用。作废订单保留事实，但不进入历史销量聚合。" : "当前没有生产库存样本。可售库存语义未确认，库销比不可计算，本次仅验证接入框架。"}</p>
  </div>`;
}

export function createGrowthRadarPage({ authorizedFetch, onStatus = () => {} }) {
  const state = { initialized: false, loaded: false, activeView: "batches", summary: {}, capabilities: [], previews: {} };
  const root = () => document.getElementById("growthRadarRoot");

  async function api(path, options = {}) {
    const response = await authorizedFetch(path, options);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "增长雷达数据读取失败。");
    return body;
  }

  function renderShell() {
    root().innerHTML = `
      <header class="gr-hero">
        <div><span class="growth-radar-kicker">DATA FOUNDATION · G1A</span><h2>订单事实与身份映射</h2><p>从来源批次到标准事实逐层留痕。所有映射确认与撤销均进入审计记录。</p></div>
        <div class="gr-semantic-state"><span>${badge("historical_observed", "success")}<small>历史观察已实现</small></span><span>${badge("current_online", "muted")}<small>当前在线未实现</small></span></div>
      </header>
      <section class="gr-kpis" aria-label="数据底座摘要">
        ${[
          ["来源批次", state.summary.batches, "可追溯导入"],
          ["标准订单", state.summary.orderHeaders, `作废 ${formatNumber(state.summary.cancelledOrders)}`],
          ["当前明细", state.summary.orderLines, "行金额不可用"],
          ["历史观察", state.summary.historicalObserved, "不等于在线货盘"],
          ["待定店铺", state.summary.unresolvedShopMappings, "需人工确认"],
          ["质量问题", state.summary.openQualityIssues, "开放问题"],
        ].map(([label, value, hint]) => `<article><span>${esc(label)}</span><strong>${formatNumber(value)}</strong><small>${esc(hint)}</small></article>`).join("")}
      </section>
      <nav class="gr-subnav" aria-label="增长雷达数据视图">${VIEWS.map(([id, label]) => `<button type="button" data-gr-view="${id}" class="${state.activeView === id ? "active" : ""}">${label}</button>`).join("")}</nav>
      <section id="growthRadarView" class="gr-view" aria-live="polite"></section>`;
    renderView().catch(showError);
  }

  function showError(error) {
    const target = document.getElementById("growthRadarView");
    if (target) target.innerHTML = `<div class="gr-callout danger"><strong>无法完成操作</strong><p>${esc(error.message)}</p></div>`;
    onStatus(error.message || "增长雷达操作失败", "error");
  }

  function viewLoading(title) {
    document.getElementById("growthRadarView").innerHTML = `<div class="gr-view-heading"><div><span class="gr-eyebrow">GROWTH RADAR</span><h3>${esc(title)}</h3></div></div><div class="gr-skeleton"></div>`;
  }

  async function renderBatches() {
    const data = await api("/api/growth-radar/source-batches?page_size=100");
    const rows = data.batches.map((item) => `<tr><td><strong>${esc(LABELS[item.sourceType] || item.sourceType)}</strong><small>${esc(item.sourceFilename || "无来源文件名")}</small></td><td>${formatNumber(item.rowCount)}</td><td>${badge(item.status, item.status === "applied" ? "success" : "warning")}</td><td>${formatDate(item.importedAt || item.createdAt)}</td><td><code>${esc(item.id.slice(0, 8))}</code></td></tr>`);
    return heading("来源批次", "每次导入保留来源哈希、文件名、采集范围和处理结果。") + table(["来源", "行数", "状态", "入库时间", "批次"], rows);
  }

  function heading(title, description, action = "") {
    return `<div class="gr-view-heading"><div><span class="gr-eyebrow">GROWTH RADAR</span><h3>${esc(title)}</h3><p>${esc(description)}</p></div>${action}</div>`;
  }

  function renderImport(domain) {
    const isOrder = domain === "orders";
    const preview = state.previews[domain];
    const title = isOrder ? "订单事实预览" : "库存接入预览";
    const detail = isOrder ? "选择马帮订单 Excel，先执行无写入预览；确认后才进入隔离的数据底座。" : "当前节点只有库存框架，没有生产样本。上传时必须明确国家与平台范围。";
    return heading(title, detail) + `<div class="gr-import-grid"><section class="gr-upload-card">
      <span class="gr-step">01 · SELECT</span><h4>选择 Excel 来源文件</h4>
      <input id="gr-${domain}-file" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" />
      ${isOrder ? "" : `<div class="gr-inline-fields"><label>平台<input id="gr-inventory-platform" value="mabang" /></label><label>国家代码<input id="gr-inventory-country" maxlength="8" placeholder="例如 TH" /></label></div>`}
      <button type="button" data-gr-preview="${domain}">生成只读预览</button><p>预览阶段不创建批次、不写原始行、不生成标准事实。</p>
    </section><section class="gr-confirm-card"><span class="gr-step">02 · APPLY</span><h4>确认入库</h4><p>${preview ? "预览已就绪。确认后将使用来源哈希作为幂等键。" : "请先生成预览并核对行数、订单数和歧义口径。"}</p><button type="button" data-gr-apply="${domain}" ${preview ? "" : "disabled"}>确认写入数据底座</button></section></div>${preview ? summarizePreview(preview, domain) : ""}`;
  }

  async function renderShops() {
    const data = await api("/api/growth-radar/shops?page_size=100");
    const rows = data.shops.map((item) => `<tr><td><strong>${esc(item.displayName)}</strong><small>${esc(item.internalShopCode)}</small></td><td>${esc(item.platform)}</td><td>${esc(item.countryCode)} · ${esc(item.countryName)}</td><td>${badge(item.status, item.status === "active" ? "success" : "muted")}</td><td>${formatDate(item.updatedAt)}</td></tr>`);
    const form = `<form id="grShopForm" class="gr-shop-form"><label>店铺编码<input name="internalShopCode" required placeholder="TH-LAZ-001" /></label><label>展示名称<input name="displayName" required /></label><label>平台<input name="platform" required placeholder="lazada" /></label><label>国家代码<input name="countryCode" required maxlength="8" placeholder="TH" /></label><label>国家名称<input name="countryName" required placeholder="泰国" /></label><button type="submit">创建店铺</button></form>`;
    return heading("店铺主数据", "内部店铺身份是国家与 SKU 映射的业务锚点。") + form + table(["店铺", "平台", "国家", "状态", "更新时间"], rows);
  }

  async function renderShopMappings() {
    const [data, shops] = await Promise.all([api("/api/growth-radar/mappings/shops/unresolved?page_size=100"), api("/api/growth-radar/shops?page_size=200&status=active")]);
    const candidates = shops.shops;
    const rows = data.mappings.map((item) => `<tr><td><strong>${esc(item.sourceShopName)}</strong><small>${esc(item.platform)}</small></td><td>${badge(item.mappingStatus, "warning")}</td><td><select aria-label="选择内部店铺" data-gr-shop-select="${item.id}"><option value="">选择同平台店铺</option>${candidates.filter((shop) => shop.platform === item.platform).map((shop) => `<option value="${shop.id}">${esc(shop.displayName)} · ${esc(shop.countryCode)}</option>`).join("")}</select></td><td><div class="gr-row-actions"><button type="button" data-gr-confirm-shop="${item.id}">确认</button>${item.mappingStatus !== "revoked" ? `<button class="button-tertiary" type="button" data-gr-revoke-shop="${item.id}">撤销</button>` : ""}</div></td></tr>`);
    return heading("待处理店铺身份", `开放映射问题 ${formatNumber(data.issueTotal)} 个；确认后将回填订单国家并重新执行 SKU 映射。`) + table(["来源店铺", "状态", "内部店铺", "操作"], rows);
  }

  async function renderSkuMappings() {
    const data = await api("/api/growth-radar/mappings/products/unresolved?page_size=100");
    const issueByValue = new Map(data.issues.map((issue) => [String(issue.sourceValue).toUpperCase(), issue]));
    const entries = data.mappings.map((mapping) => ({ mapping, issue: issueByValue.get(String(mapping.sourceSku).toUpperCase()) || null }));
    const representedIssues = new Set(entries.map(({ issue }) => issue?.id).filter(Boolean));
    for (const issue of data.issues) if (!representedIssues.has(issue.id)) entries.push({ mapping: null, issue });
    const rows = entries.map(({ mapping: item, issue }) => {
      const sourceSku = item?.sourceSku || issue?.sourceValue || "—";
      const candidates = issue?.candidateValues || [];
      const status = item?.mappingStatus || issue?.issueType || "country_unresolved";
      const mappingId = item?.id || "";
      const candidateControl = mappingId
        ? `<select aria-label="选择产品" data-gr-product-select="${mappingId}"><option value="">${candidates.length ? "选择精确候选" : "暂无可确认候选"}</option>${candidates.map((candidate) => `<option value="${esc(candidate.id)}">${esc(candidate.sku || sourceSku)} · ${esc(candidate.countryCode || "—")}</option>`).join("")}</select>`
        : `<span class="gr-blocked-reason">${status === "country_unresolved" || status === "sku_ambiguous" ? "先确认来源店铺国家" : "产品中心暂无候选"}</span>`;
      const actions = mappingId
        ? `<div class="gr-row-actions"><button type="button" data-gr-confirm-product="${mappingId}" ${candidates.length ? "" : "disabled"}>确认</button>${item.mappingStatus !== "revoked" ? `<button class="button-tertiary" type="button" data-gr-revoke-product="${mappingId}">撤销</button>` : ""}</div>`
        : `<span class="gr-muted-action">等待上游身份</span>`;
      return `<tr><td><strong>${esc(sourceSku)}</strong><small>${esc(item?.platform || "来源平台待店铺映射")} · ${esc(item?.countryCode || "国家待定")}</small></td><td>${badge(status, status === "sku_unmatched" ? "danger" : "warning")}</td><td>${candidateControl}</td><td>${actions}</td></tr>`;
    });
    return heading("待处理 SKU 身份", `开放身份问题 ${formatNumber(data.issueTotal)} 个。系统只接受“国家 + SKU”精确候选，不跨国家猜测。`) + table(["来源 SKU", "状态", "产品候选", "操作"], rows);
  }

  async function renderQuality() {
    const data = await api("/api/growth-radar/data-quality/issues?page_size=100&status=open");
    const rows = data.issues.map((item) => `<tr><td>${badge(item.severity, item.severity === "blocker" ? "danger" : "warning")}</td><td><strong>${esc(item.code)}</strong><small>${esc(item.entityType)}</small></td><td>${esc(item.message)}</td><td>${formatDate(item.createdAt)}</td><td><code>${esc(item.batchId.slice(0, 8))}</code></td></tr>`);
    return heading("数据质量问题", "解析异常与缺失字段以稳定问题码呈现；原始值不会进入错误消息。") + table(["级别", "问题码", "说明", "发现时间", "批次"], rows);
  }

  async function renderFreshness() {
    const [data, coverage] = await Promise.all([api("/api/growth-radar/freshness"), api("/api/growth-radar/coverage/status")]);
    const cards = data.freshness.map((item) => `<article><span>${esc(LABELS[item.sourceType] || item.sourceType)}</span><strong>${formatDate(item.latestAt)}</strong><small>${formatNumber(item.batchCount)} 个批次</small></article>`).join("");
    return heading("数据新鲜度与语义边界", "新鲜度只回答最近一次事实采集时间，不代表店铺当前仍在线销售。") + `<div class="gr-freshness-grid">${cards || empty("尚未导入订单或库存批次。")}</div><div class="gr-boundary"><div><span>HISTORICAL OBSERVED</span><strong>${coverage.historicalObservedImplemented ? "已实现" : "未实现"}</strong><p>由有效历史订单事实聚合，作废订单不计入。</p></div><div class="disabled"><span>CURRENT ONLINE</span><strong>未实现</strong><p>没有平台在线状态权威来源，不做推断、不生成快照。</p></div><div class="disabled"><span>INVENTORY AUTHORITY</span><strong>未验证</strong><p>没有生产库存样本，可售库存和库销比语义保持不可用。</p></div></div>`;
  }

  async function renderView() {
    const target = document.getElementById("growthRadarView");
    if (!target) return;
    const title = VIEWS.find(([id]) => id === state.activeView)?.[1] || "数据底座";
    viewLoading(title);
    let html;
    if (state.activeView === "batches") html = await renderBatches();
    else if (state.activeView === "orders") html = renderImport("orders");
    else if (state.activeView === "inventory") html = renderImport("inventory");
    else if (state.activeView === "shops") html = await renderShops();
    else if (state.activeView === "shop-mapping") html = await renderShopMappings();
    else if (state.activeView === "sku-mapping") html = await renderSkuMappings();
    else if (state.activeView === "quality") html = await renderQuality();
    else html = await renderFreshness();
    target.innerHTML = html;
  }

  async function preview(domain, button) {
    const file = document.getElementById(`gr-${domain}-file`)?.files?.[0];
    if (!file) throw new Error("请先选择 .xlsx 文件。");
    button.disabled = true;
    button.textContent = "正在解析…";
    try {
      const headers = { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "x-file-name": encodeURIComponent(file.name) };
      if (domain === "inventory") {
        headers["x-source-platform"] = document.getElementById("gr-inventory-platform").value.trim();
        headers["x-source-country"] = document.getElementById("gr-inventory-country").value.trim().toUpperCase();
        if (!headers["x-source-country"]) throw new Error("库存预览必须填写国家代码。");
      }
      const data = await api(`/api/growth-radar/import/${domain}/preview`, { method: "POST", headers, body: file });
      state.previews[domain] = data.preview;
      onStatus(`${domain === "orders" ? "订单" : "库存"}预览完成，尚未写库。`, "success");
      await renderView();
    } finally {
      button.disabled = false;
    }
  }

  async function apply(domain, button) {
    const preview = state.previews[domain];
    if (!preview) throw new Error("预览已失效，请重新生成预览。");
    button.disabled = true;
    button.textContent = "正在写入…";
    const data = await api(`/api/growth-radar/import/${domain}/apply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ previewId: preview.previewId, idempotencyKey: preview.sourceSha256 }) });
    delete state.previews[domain];
    state.summary = (await api("/api/growth-radar/summary")).summary;
    onStatus(data.reused ? "相同来源批次已存在，本次未重复写入。" : "来源批次已写入增长雷达数据底座。", "success");
    renderShell();
  }

  async function submitShop(form) {
    const body = Object.fromEntries(new FormData(form));
    await api("/api/growth-radar/shops", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    onStatus("内部店铺已创建。", "success");
    await renderView();
  }

  async function mappingAction(kind, action, mappingId, select) {
    const body = { mappingId };
    if (action === "confirm") {
      const value = document.querySelector(`[${select}="${mappingId}"]`)?.value;
      if (!value) throw new Error(kind === "shops" ? "请选择内部店铺。" : "请选择产品候选。");
      body[kind === "shops" ? "internalShopId" : "internalProductId"] = value;
    }
    await api(`/api/growth-radar/mappings/${kind}/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    state.summary = (await api("/api/growth-radar/summary")).summary;
    onStatus(action === "confirm" ? "映射已确认并完成事实回填。" : "映射已撤销并保留审计记录。", "success");
    renderShell();
  }

  function initialize() {
    if (state.initialized) return;
    state.initialized = true;
    root()?.addEventListener("click", (event) => {
      const view = event.target.closest("[data-gr-view]");
      if (view) {
        state.activeView = view.dataset.grView;
        document.querySelectorAll("[data-gr-view]").forEach((item) => item.classList.toggle("active", item === view));
        renderView().catch(showError);
        return;
      }
      const previewButton = event.target.closest("[data-gr-preview]");
      if (previewButton) preview(previewButton.dataset.grPreview, previewButton).catch(showError);
      const applyButton = event.target.closest("[data-gr-apply]");
      if (applyButton) apply(applyButton.dataset.grApply, applyButton).catch(showError);
      const confirmShop = event.target.closest("[data-gr-confirm-shop]");
      if (confirmShop) mappingAction("shops", "confirm", confirmShop.dataset.grConfirmShop, "data-gr-shop-select").catch(showError);
      const revokeShop = event.target.closest("[data-gr-revoke-shop]");
      if (revokeShop) mappingAction("shops", "revoke", revokeShop.dataset.grRevokeShop).catch(showError);
      const confirmProduct = event.target.closest("[data-gr-confirm-product]");
      if (confirmProduct) mappingAction("products", "confirm", confirmProduct.dataset.grConfirmProduct, "data-gr-product-select").catch(showError);
      const revokeProduct = event.target.closest("[data-gr-revoke-product]");
      if (revokeProduct) mappingAction("products", "revoke", revokeProduct.dataset.grRevokeProduct).catch(showError);
    });
    root()?.addEventListener("submit", (event) => {
      if (event.target.id !== "grShopForm") return;
      event.preventDefault();
      submitShop(event.target).catch(showError);
    });
  }

  async function load({ force = false } = {}) {
    if (state.loaded && !force) return;
    const [summary, capabilities] = await Promise.all([api("/api/growth-radar/summary"), api("/api/growth-radar/capabilities")]);
    state.summary = summary.summary;
    state.capabilities = capabilities.capabilities;
    state.loaded = true;
    renderShell();
  }

  return { initialize, load };
}
