export const GROWTH_RADAR_V2_VIEWS = Object.freeze([
  ["direction", "方向总览"],
  ["skus", "SKU 机会池"],
  ["stores", "店铺横比"],
  ["configuration", "配置管理"],
]);

export const GROWTH_RADAR_V2_REQUEST_PLANS = Object.freeze({
  direction: [
    "/api/growth-radar/v2/directions",
    "/api/growth-radar/v2/overview",
  ],
  skus: ["/api/growth-radar/v2/directions"],
  stores: ["/api/growth-radar/v2/directions"],
  configuration: ["/api/growth-radar/v2/configuration"],
});

const DIRECTION_LABELS = Object.freeze({
  QUIET_ENTRY: "悄悄入场",
  PRIORITY_GROWTH: "优先发力",
  DEFEND_WINNER: "守住优势",
  SUPPLY_CONSTRAINED: "补货后发力",
});

const DIRECTION_COPY = Object.freeze({
  QUIET_ENTRY: "预测高、库存可用，自营近 28 天尚未承接",
  PRIORITY_GROWTH: "预测高、已有销量，但自营承接仍偏低",
  DEFEND_WINNER: "预测高且自营已形成有效承接",
  SUPPLY_CONSTRAINED: "预测高，但库存不足以支持继续发力",
});

const DIRECTION_TONES = Object.freeze({
  QUIET_ENTRY: "quiet",
  PRIORITY_GROWTH: "priority",
  DEFEND_WINNER: "defend",
  SUPPLY_CONSTRAINED: "supply",
});

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function number(value, fallback = "不可用", digits = 1) {
  if (value === null || value === undefined || value === "" || !Number.isFinite(Number(value))) return fallback;
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: digits }).format(Number(value));
}

function percent(value, fallback = "不可用") {
  return value === null || value === undefined || !Number.isFinite(Number(value))
    ? fallback
    : `${(Number(value) * 100).toFixed(1)}%`;
}

function dateTime(value, fallback = "暂无数据") {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? String(value)
    : date.toLocaleString("zh-CN", { hour12: false });
}

function badge(label, tone = "neutral") {
  return `<span class="grv2-badge ${esc(tone)}">${esc(label)}</span>`;
}

function directionBadge(code) {
  return code
    ? badge(DIRECTION_LABELS[code] || code, DIRECTION_TONES[code] || "neutral")
    : `<span class="grv2-muted">持续观察</span>`;
}

function emptyState(title, copy, action = "") {
  return `<section class="grv2-empty">
    <div class="grv2-empty-mark" aria-hidden="true">GR</div>
    <div><h3>${esc(title)}</h3><p>${esc(copy)}</p></div>
    ${action}
  </section>`;
}

function errorState(error) {
  return `<section class="grv2-inline-error" role="alert">
    <strong>数据读取失败</strong>
    <p>${esc(error?.message || "Growth Radar 暂时不可用。")}</p>
    <code>${esc(error?.code || "GROWTH_RADAR_V2_FAILED")}</code>
  </section>`;
}

function table(headers, rows, label) {
  if (!rows.length) return emptyState("当前没有结果", "调整筛选条件，或完成店铺与国家配置后重新分析。");
  return `<div class="grv2-table-scroll" role="region" aria-label="${esc(label)}" tabindex="0">
    <table class="grv2-table">
      <thead><tr>${headers.map((header) => `<th scope="col">${esc(header)}</th>`).join("")}</tr></thead>
      <tbody>${rows.join("")}</tbody>
    </table>
  </div>`;
}

function horizontalBars(items, { label, valueLabel = (value) => number(value), maximum = null } = {}) {
  if (!items.length) return `<p class="grv2-chart-empty">当前没有可绘制的数据。</p>`;
  const max = maximum ?? Math.max(1, ...items.map((item) => Number(item.value || 0)));
  return `<div class="grv2-bars" role="img" aria-label="${esc(label)}">
    ${items.map((item) => {
      const ratio = Math.max(0, Math.min(100, (Number(item.value || 0) / max) * 100));
      return `<div class="grv2-bar-row">
        <span title="${esc(item.label)}">${esc(item.label)}</span>
        <div><i class="${esc(item.tone || "")}" style="width:${ratio.toFixed(2)}%"></i></div>
        <strong>${esc(valueLabel(item.value, item))}</strong>
      </div>`;
    }).join("")}
  </div>`;
}

function heatmap(rows) {
  if (!rows.length) return `<p class="grv2-chart-empty">当前筛选范围没有类目机会。</p>`;
  const maximum = Math.max(1, ...rows.map((row) => Number(row.actionCount || 0)));
  return `<div class="grv2-heatmap" role="img" aria-label="国家与类目机会热力图">
    ${rows.slice(0, 24).map((row) => {
      const intensity = Math.max(0.08, Number(row.actionCount || 0) / maximum);
      return `<button type="button" class="grv2-heat-cell" style="--heat:${intensity.toFixed(3)}"
        data-grv2-country="${esc(row.countryCode)}" data-grv2-category="${esc(row.category)}"
        title="${esc(`${row.countryName} / ${row.category}：${row.actionCount} 个待处理方向`)}">
        <span>${esc(row.countryCode)} · ${esc(row.category)}</span>
        <strong>${number(row.actionCount, "0", 0)}</strong>
        <small>预测 ${number(row.forecastDailySales)} / 日</small>
      </button>`;
    }).join("")}
  </div>`;
}

function readinessBanner(readiness) {
  if (readiness?.shopComparisonAvailable
    && readiness.managerConfiguredShopCount === readiness.confirmedShopCount) return "";
  return `<aside class="grv2-readiness" role="status">
    <div>
      <strong>店铺横比仍需补齐配置</strong>
      <span>活跃店铺 ${number(readiness?.activeShopCount, "0", 0)} 家，已确认 ${number(readiness?.confirmedShopCount, "0", 0)} 家，
        已配置店长 ${number(readiness?.managerConfiguredShopCount, "0", 0)} 家。未确认的数据不会被当成零销量。</span>
    </div>
    <button type="button" class="grv2-secondary-button" data-gr-open-data>配置店铺与店长</button>
  </aside>`;
}

function mappingRow(mapping = {}, index = 0) {
  const status = mapping.mappingStatus || "confirmed";
  return `<tr data-grv2-mapping-row>
    <td><input name="sourceWarehouseName" value="${esc(mapping.sourceWarehouseName || "")}"
      placeholder="马帮仓库名称" maxlength="160" required><small>${number(mapping.rowCount || 0, "0", 0)} 条记录</small></td>
    <td><input name="normalizedWarehouseName" value="${esc(mapping.normalizedWarehouseName || "")}"
      placeholder="标准仓库名称" maxlength="160" required></td>
    <td><select name="mappingStatus" data-grv2-mapping-status>
      <option value="confirmed" ${status === "confirmed" ? "selected" : ""}>映射到国家</option>
      <option value="excluded" ${status === "excluded" ? "selected" : ""}>排除</option>
    </select></td>
    <td><input name="countryCode" value="${esc(status === "excluded" ? "" : mapping.countryCode || "")}"
      placeholder="TH" maxlength="2" pattern="[A-Za-z]{2}" ${status === "excluded" ? "disabled" : "required"}></td>
    <td><input name="countryName" value="${esc(status === "excluded" ? "" : mapping.countryName || "")}"
      placeholder="泰国" maxlength="80" ${status === "excluded" ? "disabled" : "required"}></td>
    <td><input name="exclusionReason" value="${esc(mapping.exclusionReason || "")}"
      placeholder="排除原因" maxlength="240" ${status === "excluded" ? "required" : "disabled"}></td>
    <td><button type="button" class="grv2-icon-button" data-grv2-remove-mapping
      aria-label="删除第 ${index + 1} 条映射" title="删除映射">×</button></td>
  </tr>`;
}

export function requestPlanForV2View(view) {
  return [...(GROWTH_RADAR_V2_REQUEST_PLANS[view] || [])];
}

export function createGrowthRadarV2Page({ authorizedFetch, onStatus = () => {}, rootId = "growthRadarV2Root" }) {
  const state = {
    initialized: false,
    loaded: false,
    activeView: "direction",
    capabilities: { permissions: {} },
    status: null,
    published: false,
    country: "",
    category: "",
    direction: "",
    search: "",
    renderSequence: 0,
  };
  const root = () => document.getElementById(rootId);
  const canRun = () => state.capabilities?.permissions?.["growth_radar.data.apply"] === true;

  async function api(path, options = {}) {
    const response = await authorizedFetch(path, options);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.error || "Growth Radar 数据操作失败。");
      error.code = body.issue_code || body.code || "GROWTH_RADAR_V2_FAILED";
      error.status = response.status;
      throw error;
    }
    return body;
  }

  function renderShell() {
    const latest = state.status?.latestPublished;
    const previous = state.status?.servingPreviousPublishedRun;
    root().innerHTML = `<section class="grv2-shell">
      <header class="grv2-toolbar">
        <div class="grv2-freshness">
          <span>${latest ? `数据日期 ${esc(latest.analysisDate)}` : "尚未生成分析"}</span>
          <strong>${latest ? `方向合同 ${esc(state.status.metricsVersion)}` : "等待首次确定性计算"}</strong>
          <small>${latest ? `库存批次 ${esc(latest.inventoryBatchId.slice(0, 8))} · 发布 ${dateTime(latest.publishedAt)}` : "分析结果独立保存，不改写库存和订单事实。"}</small>
        </div>
        <button type="button" class="grv2-run-button" data-grv2-run ${canRun() ? "" : "disabled"}>更新分析</button>
      </header>
      ${previous ? `<aside class="grv2-stale-banner" role="status"><strong>正在展示上一成功结果</strong><span>最近一次刷新失败，现有结果未被覆盖。</span></aside>` : ""}
      <nav class="grv2-tabs" role="tablist" aria-label="货盘方向分析">
        ${GROWTH_RADAR_V2_VIEWS.map(([id, label]) => `<button type="button" role="tab"
          aria-selected="${state.activeView === id}" class="${state.activeView === id ? "active" : ""}"
          data-grv2-view="${id}">${esc(label)}</button>`).join("")}
      </nav>
      <main id="growthRadarV2View" class="grv2-view" aria-live="polite"></main>
      <aside id="growthRadarV2Detail" class="grv2-detail" hidden aria-live="polite"></aside>
    </section>`;
  }

  function setLoading() {
    const target = document.getElementById("growthRadarV2View");
    if (target) {
      target.innerHTML = `<div class="grv2-skeleton" aria-busy="true" aria-label="正在读取分析结果">
        <span></span><span></span><span></span><span></span>
      </div>`;
    }
  }

  function noPublished() {
    return emptyState(
      "还没有已发布的方向分析",
      "先完成国家映射和店铺范围配置，再生成第一轮国家 × 类目预测排名。",
      canRun() ? `<button type="button" class="grv2-run-button" data-grv2-run>生成分析</button>` : "",
    );
  }

  function filteredDirections(data) {
    return (data.skuDirections || []).filter((item) => (
      (!state.country || item.countryCode === state.country)
      && (!state.category || item.category === state.category)
      && (!state.direction || item.directionCode === state.direction)
      && (!state.search || `${item.sku} ${item.productName || ""}`.toLowerCase().includes(state.search.toLowerCase()))
    ));
  }

  function directionFilters(data, { search = false } = {}) {
    return `<form class="grv2-filterbar" id="grv2DirectionFilter">
      <label><span>国家</span><select name="country">
        <option value="">全部国家</option>
        ${(data.countries || []).map((item) => `<option value="${esc(item.code)}" ${state.country === item.code ? "selected" : ""}>${esc(item.name)} (${esc(item.code)})</option>`).join("")}
      </select></label>
      <label><span>类目</span><select name="category">
        <option value="">全部类目</option>
        ${(data.categories || []).map((item) => `<option value="${esc(item)}" ${state.category === item ? "selected" : ""}>${esc(item)}</option>`).join("")}
      </select></label>
      ${search ? `<label class="grv2-search"><span>SKU</span><input type="search" name="q" value="${esc(state.search)}" placeholder="搜索 SKU 或商品名称"></label>` : ""}
      <button type="submit" class="grv2-secondary-button">应用筛选</button>
    </form>`;
  }

  async function renderDirection() {
    const [data, overview] = await Promise.all([
      api("/api/growth-radar/v2/directions"),
      api("/api/growth-radar/v2/overview"),
    ]);
    const items = filteredDirections(data);
    const categoryRows = (data.categoryCountry || []).filter((item) => (
      (!state.country || item.countryCode === state.country)
      && (!state.category || item.category === state.category)
    ));
    const counts = data.directionCounts || {};
    const actionBars = [
      { label: "悄悄入场", value: counts.quietEntry || 0, tone: "quiet" },
      { label: "优先发力", value: counts.priorityGrowth || 0, tone: "priority" },
      { label: "补货后发力", value: counts.supplyConstrained || 0, tone: "supply" },
      { label: "守住优势", value: counts.defendWinner || 0, tone: "defend" },
    ];
    const rows = items.filter((item) => item.directionCode).slice(0, 40).map((item) => `<tr>
      <td>${directionBadge(item.directionCode)}<small>${esc(DIRECTION_COPY[item.directionCode] || "")}</small></td>
      <td>${esc(item.countryName)}<small>${esc(item.category)}</small></td>
      <td><button type="button" class="grv2-link" data-grv2-sku="${esc(item.sku)}">${esc(item.sku)}</button><small>${esc(item.productName || "商品名称待映射")}</small></td>
      <td><strong>${number(item.sourcePredictedDailySales)}</strong><small>类目第 ${number(item.forecastRank, "-", 0)} / ${number(item.forecastComparisonSampleSize, "-", 0)}</small></td>
      <td><strong>${number(item.ownSalesQuantity28d)}</strong><small>承接 ${percent(item.ownCaptureRatio28d)}</small></td>
      <td><strong>${number(item.availableQuantity)}</strong><small>在途 ${number(item.inTransitQuantity)} · ${number(item.forecastCoverageDays)} 天</small></td>
    </tr>`);
    return `<section class="grv2-section-heading">
        <div><h3>运营方向总览</h3><p>先看国家与类目，再定位预测高表现 SKU 和自营承接差距。</p></div>
        ${badge(overview.run.qualityStatus === "confirmed" ? "数据可用" : "部分可用", overview.run.qualityStatus === "confirmed" ? "success" : "warning")}
      </section>
      ${readinessBanner(data.readiness)}
      ${directionFilters(data)}
      <dl class="grv2-kpi-strip">
        <div><dt>悄悄入场</dt><dd>${number(counts.quietEntry || 0, "0", 0)}</dd><small>高预测、零承接、有库存</small></div>
        <div><dt>优先发力</dt><dd>${number(counts.priorityGrowth || 0, "0", 0)}</dd><small>高预测、低承接</small></div>
        <div><dt>补货后发力</dt><dd>${number(counts.supplyConstrained || 0, "0", 0)}</dd><small>方向正确、库存受限</small></div>
        <div><dt>守住优势</dt><dd>${number(counts.defendWinner || 0, "0", 0)}</dd><small>高预测、已有承接</small></div>
        <div><dt>确认店铺</dt><dd>${number(data.readiness?.confirmedShopCount || 0, "0", 0)}</dd><small>活跃 ${number(data.readiness?.activeShopCount || 0, "0", 0)} 家</small></div>
      </dl>
      <section class="grv2-visual-grid">
        <article class="grv2-chart-panel grv2-chart-panel-wide">
          <header><div><h4>国家 × 类目机会热力图</h4><p>颜色越深，待处理的入场、增长和供应方向越集中。</p></div></header>
          ${heatmap(categoryRows)}
        </article>
        <article class="grv2-chart-panel">
          <header><div><h4>行动结构</h4><p>把异常直接转换为运营检查队列。</p></div></header>
          ${horizontalBars(actionBars, { label: "运营行动结构", valueLabel: (value) => `${number(value, "0", 0)} SKU` })}
        </article>
        <article class="grv2-chart-panel">
          <header><div><h4>高机会类目</h4><p>按待处理方向数排序，不用运营逐店翻找。</p></div></header>
          ${horizontalBars(categoryRows.slice(0, 10).map((item) => ({
            label: `${item.countryCode} · ${item.category}`,
            value: item.actionCount,
            tone: item.quietEntryCount ? "quiet" : "priority",
          })), { label: "高机会类目", valueLabel: (value) => `${number(value, "0", 0)} 个方向` })}
        </article>
      </section>
      <section class="grv2-action-queue">
        <div class="grv2-subheading"><div><h4>优先行动队列</h4><p>每条方向都保留预测排名、订单承接和库存证据。</p></div><span>${number(items.length, "0", 0)} 条</span></div>
        ${table(["方向", "国家 / 类目", "SKU", "预测日销量 / 排名", "自营 28 天 / 承接", "库存 / 在途 / 覆盖"], rows, "优先运营方向")}
      </section>`;
  }

  async function renderSkus() {
    const data = await api("/api/growth-radar/v2/directions");
    const items = filteredDirections(data);
    const rows = items.map((item) => `<tr>
      <td>${directionBadge(item.directionCode)}</td>
      <td>${esc(item.countryCode)}<small>${esc(item.category)}</small></td>
      <td><button type="button" class="grv2-link" data-grv2-sku="${esc(item.sku)}">${esc(item.sku)}</button><small>${esc(item.productName || "商品名称待映射")}</small></td>
      <td><strong>${number(item.sourcePredictedDailySales)}</strong><small>P${item.forecastPercentile === null ? "-" : Math.round(item.forecastPercentile * 100)} · 第 ${number(item.forecastRank, "-", 0)}</small></td>
      <td><strong>${number(item.ownSalesQuantity28d)}</strong><small>${number(item.ownDailySales28d)} / 日 · 承接 ${percent(item.ownCaptureRatio28d)}</small></td>
      <td><strong>${number(item.availableQuantity)}</strong><small>在途 ${number(item.inTransitQuantity)} · ${number(item.forecastCoverageDays)} 天</small></td>
      <td>${esc(DIRECTION_COPY[item.directionCode] || "持续观察")}</td>
    </tr>`);
    return `<section class="grv2-section-heading">
        <div><h3>SKU 机会池</h3><p>只按国家与类目内的预测日销量排序，不拿跨类目绝对值硬比。</p></div>
        <span class="grv2-result-count">${number(items.length, "0", 0)} 个 SKU</span>
      </section>
      ${readinessBanner(data.readiness)}
      ${directionFilters(data, { search: true })}
      <div class="grv2-segments" role="group" aria-label="方向筛选">
        ${[["", "全部"], ...Object.entries(DIRECTION_LABELS)].map(([value, label]) => `<button type="button"
          data-grv2-direction="${esc(value)}" class="${state.direction === value ? "active" : ""}">${esc(label)}</button>`).join("")}
      </div>
      ${table(["方向", "国家 / 类目", "SKU / 商品", "预测日销量 / 排名", "自营销量 / 承接", "库存 / 覆盖", "判断依据"], rows, "SKU 机会池")}`;
  }

  async function renderStores() {
    const data = await api("/api/growth-radar/v2/directions");
    if (!data.readiness?.shopComparisonAvailable) {
      return `<section class="grv2-section-heading"><div><h3>店铺与店长横比</h3><p>只使用已确认店铺和已发货订单。</p></div></section>
        ${readinessBanner(data.readiness)}
        ${emptyState("店铺比较尚未生成", "先在“数据与范围”中确认店铺国家、店长和来源映射，再更新分析。", `<button type="button" class="grv2-secondary-button" data-gr-open-data>去配置</button>`)}`;
    }
    const managerRows = (data.managerComparisons || []).map((item) => `<tr>
      <td>${esc(item.manager)}</td><td>${number(item.shopCount, "0", 0)}</td>
      <td>${number(item.ownSalesQuantity28d)}</td><td>${number(item.quietEntryCount, "0", 0)}</td>
      <td>${number(item.priorityGrowthCount, "0", 0)}</td><td>${number(item.supplyConstrainedCount, "0", 0)}</td>
    </tr>`);
    const shopRows = (data.shopComparisons || []).map((store) => `<tr>
      <td><button type="button" class="grv2-link" data-grv2-store="${esc(store.shopId)}">${esc(store.displayName)}</button><small>${esc(store.platform)} · ${esc(store.ownerUserId || "店长未配置")}</small></td>
      <td>${esc(store.countryCode)}</td><td>${number(store.ownSalesQuantity28d)}</td>
      <td>${percent(store.highPerformanceCoverageRate28d)}<small>销售覆盖，不是在线 Listing 覆盖</small></td>
      <td>${number(store.quietEntryCount, "0", 0)}</td><td>${number(store.priorityGrowthCount, "0", 0)}</td>
      <td>${badge(store.anomalyCode === "STABLE" ? "稳定" : store.anomalyCode === "NO_SHIPPED_SALES_28D" ? "28 天无已发货销量" : "存在关注缺口", store.anomalyCode === "STABLE" ? "success" : "warning")}</td>
    </tr>`);
    return `<section class="grv2-section-heading">
        <div><h3>店铺与店长横比</h3><p>帮助一名运营同时巡视大量店铺，只把异常和机会推到前面。</p></div>
        <span class="grv2-result-count">${number(data.shopComparisons?.length || 0, "0", 0)} 家店铺</span>
      </section>
      ${readinessBanner(data.readiness)}
      <section class="grv2-visual-grid">
        <article class="grv2-chart-panel grv2-chart-panel-wide">
          <header><div><h4>店铺 28 天已发货销量</h4><p>仅展示已确认店铺，缺失配置不会显示成零。</p></div></header>
          ${horizontalBars((data.shopComparisons || []).slice(0, 20).map((store) => ({
            label: store.displayName,
            value: store.ownSalesQuantity28d,
            tone: store.anomalyCode === "STABLE" ? "defend" : "priority",
          })), { label: "店铺 28 天已发货销量" })}
        </article>
        <article class="grv2-chart-panel">
          <header><div><h4>店长待处理方向</h4><p>按悄悄入场和优先发力数量排序。</p></div></header>
          ${horizontalBars((data.managerComparisons || []).slice(0, 12).map((item) => ({
            label: item.manager,
            value: item.quietEntryCount + item.priorityGrowthCount,
            tone: "quiet",
          })), { label: "店长待处理方向", valueLabel: (value) => `${number(value, "0", 0)} 个` })}
        </article>
      </section>
      <section class="grv2-comparison-section"><div class="grv2-subheading"><div><h4>店长汇总</h4><p>先看负责人，再下钻具体店铺。</p></div></div>
        ${table(["店长", "店铺数", "28 天销量", "悄悄入场", "优先发力", "供应受限"], managerRows, "店长横向比较")}</section>
      <section class="grv2-comparison-section"><div class="grv2-subheading"><div><h4>店铺异常清单</h4><p>覆盖率只表达历史销售承接，不解释为是否上架。</p></div></div>
        ${table(["店铺", "国家", "28 天销量", "高预测 SKU 销售覆盖", "悄悄入场", "优先发力", "状态"], shopRows, "店铺横向比较")}</section>`;
  }

  async function renderConfiguration() {
    const data = await api("/api/growth-radar/v2/configuration");
    const configuration = data.configuration;
    const activeMappings = new Map((configuration.countryMappings || []).map((item) => [item.normalizedWarehouseName, item]));
    const rows = (configuration.knownWarehouses || []).map((warehouse) => ({
      ...warehouse,
      ...(activeMappings.get(warehouse.normalizedWarehouseName) || {}),
      sourceWarehouseName: activeMappings.get(warehouse.normalizedWarehouseName)?.sourceWarehouseName || warehouse.sourceWarehouseName,
    }));
    for (const mapping of configuration.countryMappings || []) {
      if (!rows.some((row) => row.normalizedWarehouseName === mapping.normalizedWarehouseName)) rows.push(mapping);
    }
    const parameters = configuration.activeRuleSet?.parameters || {};
    const thresholds = parameters.thresholds || {};
    const windows = parameters.windows || {};
    const slowDays = thresholds.slowDays || [60, 90, 180];
    const lowStockDays = thresholds.lowStockDays || [14, 7, 0];
    return `<section class="grv2-section-heading">
        <div><h3>分析配置</h3><p>国家映射与规则由用户维护并版本化保存；店铺与店长在“数据与范围”中维护。</p></div>
        ${badge(configuration.pendingAnalysisRefresh ? "等待重新分析" : "配置与结果一致", configuration.pendingAnalysisRefresh ? "warning" : "success")}
      </section>
      <aside class="grv2-config-notice"><div><strong>店铺、国家、店长都是分析输入</strong><span>修改后必须重新运行分析，历史结果继续引用原版本。</span></div>
        <button type="button" class="grv2-secondary-button" data-gr-open-data>配置店铺与店长</button></aside>
      <div class="grv2-config-layout">
        <section class="grv2-config-section">
          <header><div><h4>仓库国家映射</h4><p>国家是货盘排名和店铺比较的第一层边界。</p></div><span>${number(rows.length, "0", 0)} 个仓库</span></header>
          <form id="grv2CountryConfigForm">
            <label class="grv2-config-description"><span>版本说明</span><input name="description" maxlength="240"
              value="${esc(configuration.activeCountryMappingSet?.description || "用户维护的仓库国家映射")}"></label>
            <div class="grv2-table-scroll"><table class="grv2-table grv2-config-table">
              <thead><tr><th>来源仓库</th><th>标准仓库</th><th>处理</th><th>国家代码</th><th>国家名称</th><th>排除原因</th><th></th></tr></thead>
              <tbody data-grv2-mapping-rows>${rows.map((item, index) => mappingRow(item, index)).join("")}</tbody>
            </table></div>
            <footer class="grv2-form-actions"><button type="button" class="grv2-secondary-button" data-grv2-add-mapping>添加仓库</button>
              <button type="submit" class="grv2-run-button" ${canRun() ? "" : "disabled"}>保存国家映射</button></footer>
          </form>
        </section>
        <section class="grv2-config-section">
          <header><div><h4>确定性方向规则</h4><p>预测高表现使用类目内分位；承接率是日均已发货销量 ÷ 预测日销量。</p></div><span>${esc(configuration.activeRuleSet?.version || "未配置")}</span></header>
          <form id="grv2RuleConfigForm" class="grv2-rule-form">
            <fieldset><legend>机会识别</legend>
              <label><span>预测高表现分位</span><input type="number" name="sourceHighPercentile" min="0.5" max="0.99" step="0.01" required value="${esc(thresholds.sourceHighPercentile ?? 0.8)}"></label>
              <label><span>低承接率阈值</span><input type="number" name="storeLowRatioPercentile" min="0.01" max="0.5" step="0.01" required value="${esc(thresholds.storeLowRatioPercentile ?? 0.2)}"></label>
              <label><span>最小比较样本</span><input type="number" name="minimumComparisonSize" min="5" max="10000" step="1" required value="${esc(thresholds.minimumComparisonSize ?? 30)}"></label>
              <label><span>新品观察天数</span><input type="number" name="newDays" min="1" max="365" step="1" required value="${esc(windows.newDays ?? 90)}"></label>
            </fieldset>
            <fieldset><legend>滞销阈值</legend>
              <label><span>关注</span><input type="number" name="slowAttentionDays" min="1" max="730" step="1" required value="${esc(slowDays[0])}"></label>
              <label><span>高风险</span><input type="number" name="slowHighDays" min="1" max="730" step="1" required value="${esc(slowDays[1])}"></label>
              <label><span>严重</span><input type="number" name="slowCriticalDays" min="1" max="730" step="1" required value="${esc(slowDays[2])}"></label>
            </fieldset>
            <fieldset><legend>供应阈值</legend>
              <label><span>关注</span><input type="number" name="lowStockWarningDays" min="1" max="365" step="1" required value="${esc(lowStockDays[0])}"></label>
              <label><span>高风险</span><input type="number" name="lowStockHighDays" min="1" max="365" step="1" required value="${esc(lowStockDays[1])}"></label>
            </fieldset>
            <footer class="grv2-form-actions"><span>指标合同 ${esc(configuration.metricsContractVersion)}</span>
              <button type="submit" class="grv2-run-button" ${canRun() ? "" : "disabled"}>保存规则</button></footer>
          </form>
        </section>
      </div>`;
  }

  async function renderView() {
    const sequence = ++state.renderSequence;
    const target = document.getElementById("growthRadarV2View");
    if (!target) return;
    if (state.activeView !== "configuration" && !state.published) {
      target.innerHTML = noPublished();
      return;
    }
    setLoading();
    try {
      let html = "";
      if (state.activeView === "configuration") html = await renderConfiguration();
      else if (state.activeView === "skus") html = await renderSkus();
      else if (state.activeView === "stores") html = await renderStores();
      else html = await renderDirection();
      if (sequence === state.renderSequence) target.innerHTML = html;
    } catch (error) {
      if (sequence === state.renderSequence) target.innerHTML = errorState(error);
    }
  }

  async function showSku(sku) {
    const panel = document.getElementById("growthRadarV2Detail");
    panel.hidden = false;
    panel.innerHTML = `<div class="grv2-detail-loading">正在读取 SKU 证据…</div>`;
    try {
      const data = await api(`/api/growth-radar/v2/skus/${encodeURIComponent(sku)}`);
      const metric = data.metric;
      panel.innerHTML = `<header><div><span>SKU 证据</span><h3>${esc(metric.sku)}</h3><p>${esc(metric.productName || "商品名称待映射")}</p></div>
          <button type="button" class="grv2-close" data-grv2-close-detail aria-label="关闭详情">×</button></header>
        <dl class="grv2-detail-metrics">
          <div><dt>预测日销量</dt><dd>${number(metric.sourcePredictedDailySales)}</dd></div>
          <div><dt>类目排名</dt><dd>${number(metric.forecastRank, "-", 0)} / ${number(metric.forecastComparisonSampleSize, "-", 0)}</dd></div>
          <div><dt>可用 / 在途</dt><dd>${number(metric.availableQuantity)} / ${number(metric.inTransitQuantity)}</dd></div>
          <div><dt>预测覆盖</dt><dd>${number(metric.forecastCoverageDays)} 天</dd></div>
        </dl>
        <section><h4>为什么这样判断</h4><dl class="grv2-evidence">
          <div><dt>比较范围</dt><dd>${esc(metric.forecastComparisonScope || "不可用")}</dd></div>
          <div><dt>预测分位</dt><dd>${percent(metric.forecastPercentile)}</dd></div>
          <div><dt>库存覆盖公式</dt><dd>${esc(metric.evidence?.forecastCoverageFormula || "可用库存 ÷ 预测日销量")}</dd></div>
          <div><dt>指标版本</dt><dd>${esc(metric.metricsVersion)}</dd></div>
        </dl></section>
        <section><h4>店铺承接</h4>${data.stores?.length ? data.stores.map((store) => `<article class="grv2-store-evidence">
          <strong>${esc(store.shopId)}</strong><span>28 天 ${number(store.ownSalesQuantity28d)} · 承接 ${percent(store.ownCaptureRatio28d)}</span>${directionBadge(store.directionCode)}
        </article>`).join("") : `<p class="grv2-muted">尚无已确认店铺的承接证据。</p>`}</section>`;
    } catch (error) {
      panel.innerHTML = errorState(error);
    }
  }

  async function showStore(shopId) {
    const panel = document.getElementById("growthRadarV2Detail");
    panel.hidden = false;
    panel.innerHTML = `<div class="grv2-detail-loading">正在读取店铺方向…</div>`;
    try {
      const data = await api(`/api/growth-radar/v2/stores/${encodeURIComponent(shopId)}?page_size=80`);
      const store = data.store;
      const rows = (data.items || []).filter((item) => item.directionCode).map((item) => `<tr>
        <td><button type="button" class="grv2-link" data-grv2-sku="${esc(item.sku)}">${esc(item.sku)}</button></td>
        <td>${directionBadge(item.directionCode)}</td><td>${number(item.sourcePredictedDailySales)}</td>
        <td>${number(item.ownSalesQuantity28d)}</td><td>${percent(item.ownCaptureRatio28d)}</td>
      </tr>`);
      panel.innerHTML = `<header><div><span>店铺方向</span><h3>${esc(store.displayName)}</h3><p>${esc(store.platform)} · ${esc(store.countryCode)} · ${esc(store.ownerUserId || "店长未配置")}</p></div>
          <button type="button" class="grv2-close" data-grv2-close-detail aria-label="关闭详情">×</button></header>
        <dl class="grv2-detail-metrics">
          <div><dt>28 天销量</dt><dd>${number(store.ownSalesQuantity28d)}</dd></div>
          <div><dt>高预测销售覆盖</dt><dd>${percent(store.highPerformanceCoverageRate28d)}</dd></div>
          <div><dt>亮点款</dt><dd>${number(store.keyPerformerCount, "0", 0)}</dd></div>
          <div><dt>增长跟进</dt><dd>${number(store.growthFocusCount, "0", 0)}</dd></div>
        </dl>
        <section><h4>重点 SKU</h4>${table(["SKU", "方向", "预测日销量", "28 天自营", "承接率"], rows, "店铺重点 SKU")}</section>`;
    } catch (error) {
      panel.innerHTML = errorState(error);
    }
  }

  async function saveCountryConfiguration(form, button) {
    const mappings = [...form.querySelectorAll("[data-grv2-mapping-row]")].map((row) => ({
      sourceWarehouseName: row.querySelector('[name="sourceWarehouseName"]').value,
      normalizedWarehouseName: row.querySelector('[name="normalizedWarehouseName"]').value,
      mappingStatus: row.querySelector('[name="mappingStatus"]').value,
      countryCode: row.querySelector('[name="countryCode"]').value,
      countryName: row.querySelector('[name="countryName"]').value,
      exclusionReason: row.querySelector('[name="exclusionReason"]').value,
    }));
    const original = button.textContent;
    button.disabled = true;
    button.textContent = "正在保存";
    try {
      await api("/api/growth-radar/v2/configuration/country-mappings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ description: new FormData(form).get("description"), mappings }),
      });
      onStatus("国家映射已保存。请重新运行分析。", "success");
      await renderView();
    } catch (error) {
      onStatus(error.message, "error");
    } finally {
      button.disabled = !canRun();
      button.textContent = original;
    }
  }

  async function saveRuleConfiguration(form, button) {
    const original = button.textContent;
    button.disabled = true;
    button.textContent = "正在保存";
    try {
      await api("/api/growth-radar/v2/configuration/rules", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(Object.fromEntries(new FormData(form))),
      });
      onStatus("方向规则已保存。请重新运行分析。", "success");
      await renderView();
    } catch (error) {
      onStatus(error.message, "error");
    } finally {
      button.disabled = !canRun();
      button.textContent = original;
    }
  }

  async function runAnalysis(button) {
    if (!canRun()) return;
    button.disabled = true;
    button.textContent = "正在计算";
    try {
      const result = await api("/api/growth-radar/v2/analysis-runs", { method: "POST" });
      onStatus(result.reused ? "当前输入已有分析结果。" : "新的运营方向已发布。", "success");
      await load({ force: true });
    } catch (error) {
      onStatus(error.message, "error");
    } finally {
      button.disabled = false;
      button.textContent = "更新分析";
    }
  }

  function closeDetail() {
    const panel = document.getElementById("growthRadarV2Detail");
    if (panel) {
      panel.hidden = true;
      panel.innerHTML = "";
    }
  }

  function initialize() {
    if (state.initialized) return;
    state.initialized = true;
    root()?.addEventListener("click", (event) => {
      const view = event.target.closest("[data-grv2-view]");
      if (view) {
        state.activeView = view.dataset.grv2View;
        closeDetail();
        renderShell();
        renderView();
        return;
      }
      const heatCell = event.target.closest("[data-grv2-country][data-grv2-category]");
      if (heatCell) {
        state.country = heatCell.dataset.grv2Country;
        state.category = heatCell.dataset.grv2Category;
        state.activeView = "skus";
        renderShell();
        renderView();
        return;
      }
      const direction = event.target.closest("[data-grv2-direction]");
      if (direction) {
        state.direction = direction.dataset.grv2Direction;
        renderView();
        return;
      }
      const run = event.target.closest("[data-grv2-run]");
      if (run) {
        runAnalysis(run);
        return;
      }
      const sku = event.target.closest("[data-grv2-sku]");
      if (sku) {
        showSku(sku.dataset.grv2Sku);
        return;
      }
      const store = event.target.closest("[data-grv2-store]");
      if (store) {
        showStore(store.dataset.grv2Store);
        return;
      }
      const addMapping = event.target.closest("[data-grv2-add-mapping]");
      if (addMapping) {
        const body = root()?.querySelector("[data-grv2-mapping-rows]");
        body?.insertAdjacentHTML("beforeend", mappingRow({}, body.querySelectorAll("tr").length));
        return;
      }
      const removeMapping = event.target.closest("[data-grv2-remove-mapping]");
      if (removeMapping) {
        removeMapping.closest("[data-grv2-mapping-row]")?.remove();
        return;
      }
      if (event.target.closest("[data-grv2-close-detail]")) closeDetail();
    });
    root()?.addEventListener("change", (event) => {
      if (!event.target.matches("[data-grv2-mapping-status]")) return;
      const row = event.target.closest("[data-grv2-mapping-row]");
      const excluded = event.target.value === "excluded";
      for (const name of ["countryCode", "countryName"]) {
        const input = row.querySelector(`[name="${name}"]`);
        input.disabled = excluded;
        input.required = !excluded;
      }
      const reason = row.querySelector('[name="exclusionReason"]');
      reason.disabled = !excluded;
      reason.required = excluded;
    });
    root()?.addEventListener("submit", (event) => {
      event.preventDefault();
      if (event.target.id === "grv2DirectionFilter") {
        const form = new FormData(event.target);
        state.country = String(form.get("country") || "");
        state.category = String(form.get("category") || "");
        state.search = String(form.get("q") || "").trim();
        renderView();
      } else if (event.target.id === "grv2CountryConfigForm") {
        saveCountryConfiguration(event.target, event.submitter);
      } else if (event.target.id === "grv2RuleConfigForm") {
        saveRuleConfiguration(event.target, event.submitter);
      }
    });
  }

  async function load({ force = false } = {}) {
    if (state.loaded && !force) return;
    const [capabilities, status] = await Promise.all([
      api("/api/growth-radar/capabilities"),
      api("/api/growth-radar/v2/status"),
    ]);
    state.capabilities = capabilities.capabilities || { permissions: {} };
    state.status = status.status;
    state.published = Boolean(status.status?.latestPublished);
    state.loaded = true;
    renderShell();
    await renderView();
  }

  return { initialize, load, requestPlanForV2View };
}
