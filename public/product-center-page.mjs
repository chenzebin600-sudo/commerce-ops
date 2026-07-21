const OUTCOME_LABELS = Object.freeze({ new: "新增", updated: "更新", unchanged: "无变化", conflict: "冲突", exception: "异常" });
const STATUS_LABELS = Object.freeze({
  uploaded: "已上传", validating: "校验中", preview_ready: "待入库", applying: "入库中",
  applied: "已入库", validation_failed: "校验失败", apply_failed: "入库失败", cancelled: "已取消",
});
const LIFECYCLE_LABELS = Object.freeze({
  ACTIVE: "正常销售", NEW: "待开发", CLEARANCE: "清仓商品", DISCONTINUED: "灭款", ARCHIVED: "已归档",
});
const LISTING_TARGETS = Object.freeze({
  TH: Object.freeze({ countryCode: "TH", countryName: "泰国", marketplaceCode: "TH" }),
  PH: Object.freeze({ countryCode: "PH", countryName: "菲律宾", marketplaceCode: "PH" }),
  MY: Object.freeze({ countryCode: "MY", countryName: "马来西亚", marketplaceCode: "MY" }),
  ID: Object.freeze({ countryCode: "ID", countryName: "印度尼西亚", marketplaceCode: "ID" }),
  VN: Object.freeze({ countryCode: "VN", countryName: "越南", marketplaceCode: "VN" }),
});
const COUNTRY_ALIASES = Object.freeze({ 泰国: "TH", TH: "TH", Thailand: "TH", 菲律宾: "PH", PH: "PH", Philippines: "PH", 马来: "MY", 马来西亚: "MY", MY: "MY", Malaysia: "MY", 印尼: "ID", 印度尼西亚: "ID", ID: "ID", Indonesia: "ID", 越南: "VN", VN: "VN", Vietnam: "VN" });
const AI_TYPE_LABELS = Object.freeze({
  target_audience: "目标用户", product_positioning: "产品定位", content_style: "内容风格",
  listing_title: "商品标题", listing_subtitle: "商品副标题", listing_description: "商品描述",
  selling_points: "核心卖点", usage_scenarios: "使用场景", image_prompt: "图片方案与提示词", product_images: "AI 商品图片",
});
const WORKFLOW_STATE_LABELS = Object.freeze({
  not_started: "未开始", incomplete: "待完善", ready: "可继续", generating: "生成中", generated: "AI 已生成",
  manually_modified: "人工已改", stale: "需更新", completed: "已完成", blocked: "有阻断",
});
const AI_CONTENT_STATUS_LABELS = Object.freeze({
  pending: "待人工确认", waiting: "待人工确认", not_generated: "未生成", generating_prompt: "生成中",
  waiting_generation: "生成中", generating: "生成中", generated: "AI 已生成", completed: "AI 已生成",
  confirmed: "已采用", adopted: "已采用", manually_modified: "已人工修改", stale: "上下文已变化",
  failed: "生成失败", cancelled: "已取消",
});
const WORKFLOW_CHECK_GROUPS = Object.freeze({
  product_facts: Object.freeze({ label: "产品事实", codes: ["SKU_REQUIRED"] }),
  listing_strategy: Object.freeze({ label: "上架策略", codes: ["PLATFORM_REQUIRED", "SHOP_REQUIRED", "CATEGORY_REQUIRED"] }),
  product_copy: Object.freeze({ label: "商品文案", codes: ["TITLE_REQUIRED", "AI_RISK_REVIEW"] }),
  image_assets: Object.freeze({ label: "图片素材", codes: ["PRIMARY_IMAGE_REQUIRED"] }),
  commerce_logistics: Object.freeze({ label: "交易与物流", codes: ["PRICE_REQUIRED", "WEIGHT_REQUIRED", "DIMENSIONS_REQUIRED", "REQUIRED_ATTRIBUTES"] }),
  publication_checks: Object.freeze({ label: "其他检查", codes: [] }),
});
const LISTING_CHECK_TARGETS = Object.freeze({
  TITLE_REQUIRED: "listingTitle", PLATFORM_REQUIRED: "listingPlatform", SHOP_REQUIRED: "listingShopName",
  CATEGORY_REQUIRED: "listingCategoryName", PRIMARY_IMAGE_REQUIRED: "listingMediaList", SKU_REQUIRED: "productWorkbenchIdentityFacts",
  PRICE_REQUIRED: "listingSalePrice", WEIGHT_REQUIRED: "listingWeightG", DIMENSIONS_REQUIRED: "listingLengthCm",
  REQUIRED_ATTRIBUTES: "workbenchAttributes", AI_RISK_REVIEW: "workbenchAi",
});

export function groupPublicationChecks(checks = []) {
  const matched = new Set();
  const groups = Object.entries(WORKFLOW_CHECK_GROUPS).map(([key, definition]) => {
    const items = checks.filter((item) => definition.codes.includes(item.code));
    items.forEach((item) => matched.add(item));
    return { key, label: definition.label, items };
  });
  const fallback = groups.find((group) => group.key === "publication_checks");
  fallback.items = checks.filter((item) => !matched.has(item));
  return groups.filter((group) => group.items.length);
}

function esc(value) {
  return String(value ?? "-")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString("zh-CN", { hour12: false });
}

function formatNumber(value) {
  if (value === null || value === undefined || value === "") return "-";
  return Number(value).toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

async function responseJson(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || `请求失败：${response.status}`);
  return data;
}

export function createProductCenterPage({ authorizedFetch, documentObject = document, onStatus = () => {} } = {}) {
  const byId = (id) => documentObject.getElementById(id);
  const state = {
    activeView: "catalog",
    activeDetail: null,
    loaded: false,
    issuePage: 1,
    issueTotalPages: 1,
    reminderPage: 1,
    reminderTotalPages: 1,
    changePage: 1,
    changeTotalPages: 1,
    rowPage: 1,
    rowTotalPages: 1,
    catalogPage: 1,
    catalogPageSize: 30,
    catalogTotalPages: 1,
    catalogFiltersLoaded: false,
    productFields: [],
    visibleProductFields: [],
    currentProduct: null,
    pendingDeleteProduct: null,
    capabilities: {},
    aiStatus: { configured: false },
    aiGenerated: null,
    aiHistoryContents: [],
    aiCandidates: {},
    aiAdoptions: {},
    aiManualModifiedTypes: new Set(),
    aiContextBaseline: null,
    aiContextStale: false,
    aiAbortController: null,
    imageGenerationTask: null,
    imageObjectUrls: new Set(),
    listingDrafts: [],
    currentListingDraft: null,
    listingAttributes: [],
    listingSellingPoints: [],
    listingUsageScenarios: [],
    listingMediaOrder: [],
    dirtyScopes: new Set(),
    closeRequestPending: false,
    discardResolver: null,
    workbenchObserver: null,
    confirmedSteps: new Set(),
    aiActiveTypes: new Set(),
  };

  const LISTING_PLATFORM_LABELS = Object.freeze({
    shopee: "Shopee",
    lazada: "Lazada",
    tiktok_shop: "TikTok Shop",
  });

  function can(permission) {
    return Boolean(state.capabilities?.[permission]);
  }

  function setView(view) {
    state.activeView = new Set(["catalog", "upload", "history"]).has(view) ? view : "catalog";
    documentObject.querySelectorAll("[data-product-view]").forEach((button) => {
      const active = button.dataset.productView === state.activeView;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    });
    byId("productCatalogPanel").hidden = state.activeView !== "catalog";
    byId("productImportWorkspace").hidden = state.activeView !== "upload";
    byId("productImportHistory").hidden = state.activeView !== "history";
    if (state.activeView === "catalog") loadCatalog().catch((error) => onStatus(error.message, "error"));
    if (state.activeView === "history") loadHistory().catch((error) => onStatus(error.message, "error"));
  }

  function renderMapping(mapping = []) {
    byId("productFieldMappingTable").innerHTML = mapping.length ? `<table class="product-center-table">
      <thead><tr><th>Excel 字段</th><th>系统字段</th><th>状态</th></tr></thead>
      <tbody>${mapping.map((item) => `<tr>
        <td>${esc(item.sourceHeader)}</td><td><code>${esc(item.systemField || "unknown_field")}</code></td>
        <td><span class="product-status ${esc(item.status)}">${esc({ mapped: "成功", unknown: "待确认", missing: "缺失", duplicate: "重复", empty: "空表头" }[item.status] || item.status)}</span></td>
      </tr>`).join("")}</tbody></table>` : '<p class="product-empty">暂无字段映射。</p>';
  }

  function issueTable(issues) {
    return issues.length ? `<table class="product-center-table">
      <thead><tr><th>级别</th><th>行号</th><th>问题</th><th>建议</th></tr></thead>
      <tbody>${issues.map((item) => `<tr>
        <td><span class="product-severity ${esc(item.severity)}">${esc({ blocker: "阻断", reminder: "提醒", information: "信息" }[item.severity])}</span></td>
        <td>${esc(item.sourceRowNumber || "批次")}</td><td><strong>${esc(item.message)}</strong><small>${esc(item.code)}</small></td>
        <td>${esc(item.suggestion || "-")}</td>
      </tr>`).join("")}</tbody></table>` : '<p class="product-empty">未发现相关数据质量问题。</p>';
  }

  function renderIssues(result) {
    const issues = result?.issues || [];
    state.issuePage = Number(result?.page || 1);
    state.issueTotalPages = Math.max(1, Number(result?.totalPages || 1));
    byId("productIssuesPrevBtn").disabled = state.issuePage <= 1;
    byId("productIssuesNextBtn").disabled = state.issuePage >= state.issueTotalPages;
    byId("productIssuesPageStatus").textContent = `第 ${state.issuePage} / ${state.issueTotalPages} 页 · ${Number(result?.total || 0)} 项`;
    byId("productIssueTable").innerHTML = issueTable(issues);
  }

  function renderReminders(result) {
    const issues = result?.issues || [];
    state.reminderPage = Number(result?.page || 1);
    state.reminderTotalPages = Math.max(1, Number(result?.totalPages || 1));
    byId("productRemindersPrevBtn").disabled = state.reminderPage <= 1;
    byId("productRemindersNextBtn").disabled = state.reminderPage >= state.reminderTotalPages;
    byId("productRemindersPageStatus").textContent = `第 ${state.reminderPage} / ${state.reminderTotalPages} 页 · ${Number(result?.total || 0)} 项`;
    byId("productReminderTable").innerHTML = issueTable(issues);
  }

  function formatSourceValue(value) {
    if (value === null || value === undefined || value === "") return "空";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  }

  function renderChanges(result) {
    const changes = result?.changes || [];
    state.changePage = Number(result?.page || 1);
    state.changeTotalPages = Math.max(1, Number(result?.totalPages || 1));
    byId("productChangesPrevBtn").disabled = state.changePage <= 1;
    byId("productChangesNextBtn").disabled = state.changePage >= state.changeTotalPages;
    byId("productChangesPageStatus").textContent = `第 ${state.changePage} / ${state.changeTotalPages} 页 · ${Number(result?.total || 0)} 项字段变化`;
    byId("productImportChangesTable").innerHTML = changes.length ? `<table class="product-center-table product-change-table">
      <thead><tr><th>行号</th><th>国家 / 仓库</th><th>SKU / 商品</th><th>字段</th><th>原值</th><th>新值</th><th>人工覆盖</th></tr></thead>
      <tbody>${changes.map((item) => `<tr>
        <td>${esc(item.sourceRowNumber)}</td>
        <td><strong>${esc(item.country)}</strong><small>${esc(item.warehouse || "未指定")}</small></td>
        <td><strong>${esc(item.sku)}</strong><small>${esc(item.productName)}</small></td>
        <td><strong>${esc(item.sourceHeader)}</strong><small>${esc(item.fieldCode)}</small></td>
        <td>${esc(formatSourceValue(item.oldValue))}</td>
        <td class="product-change-new">${esc(formatSourceValue(item.newValue))}</td>
        <td>${item.hasManualOverride ? '<span class="product-override-badge">保留人工值</span>' : '-'}</td>
      </tr>`).join("")}</tbody></table>` : '<p class="product-empty">本批次没有字段级变化；新增源行请在解析结果中查看。</p>';
  }

  function renderRows(result) {
    const rows = result?.rows || [];
    state.rowPage = Number(result?.page || 1);
    state.rowTotalPages = Math.max(1, Number(result?.totalPages || 1));
    byId("productRowsPrevBtn").disabled = state.rowPage <= 1;
    byId("productRowsNextBtn").disabled = state.rowPage >= state.rowTotalPages;
    byId("productRowsPageStatus").textContent = `第 ${state.rowPage} / ${state.rowTotalPages} 页 · ${Number(result?.total || 0)} 行`;
    byId("productImportRowsTable").innerHTML = rows.length ? `<table class="product-center-table">
      <thead><tr><th>行号</th><th>国家 / 仓库</th><th>SKU</th><th>商品名称</th><th>主 SKU</th><th>生命周期</th><th>结果</th></tr></thead>
      <tbody>${rows.map((row) => `<tr>
        <td>${esc(row.sourceRowNumber)}</td><td><strong>${esc(row.sourceCountryRaw)}</strong><small>${esc(row.sourceWarehouseRaw || "未指定")} · 第 ${esc(row.rowOccurrence)} 次</small></td><td><strong>${esc(row.sourceSku)}</strong></td>
        <td>${esc(row.normalizedPayload?.product_name)}</td><td>${esc(row.normalizedPayload?.main_sku_code)}</td>
        <td>${esc(LIFECYCLE_LABELS[row.normalizedPayload?.lifecycle_status] || row.normalizedPayload?.lifecycle_status)}</td>
        <td><span class="product-outcome ${esc(row.outcome)}">${esc(OUTCOME_LABELS[row.outcome] || row.outcome)}</span></td>
      </tr>`).join("")}</tbody></table>` : '<p class="product-empty">暂无解析记录。</p>';
  }

  function renderDetail(detail) {
    state.activeDetail = detail;
    const batch = detail?.batch;
    const panel = byId("productImportDetail");
    if (!batch) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    byId("productBatchTitle").textContent = `批次 ${batch.id.slice(0, 8)}`;
    byId("productBatchMeta").textContent = `${STATUS_LABELS[batch.status] || batch.status} · ${formatDate(batch.createdAt)}`;
    const values = [
      ["文件名称", detail.file?.sourceFilename || "-"], ["工作表", batch.validationSummary?.sheetName || "-"],
      ["源数据总行数", batch.validationSummary?.sourceRowCount ?? batch.rowCount], ["可导入行数", batch.willWriteCount],
      ["新增", batch.newCount], ["更新", batch.updatedCount], ["无变化", batch.unchangedCount],
      ["字段变化", batch.validationSummary?.fieldChangeCount ?? detail.changes?.total ?? 0],
      ["信息提醒", Number(batch.reminderCount || 0) + Number(batch.informationCount || 0)], ["阻断", batch.blockerCount],
      ["文件 SHA-256", batch.fileSha256 || batch.fileHashShort || "-"],
      ["解析耗时", batch.validationSummary?.parseDurationMs == null ? "-" : `${formatNumber(batch.validationSummary.parseDurationMs)} ms`],
    ];
    byId("productBatchSummary").innerHTML = values.map(([label, value]) => `<div><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join("");
    renderMapping(batch.mapping);
    renderChanges(detail.changes);
    renderRows(detail.rows);
    byId("productChangesCount").textContent = `${batch.validationSummary?.fieldChangeCount ?? detail.changes?.total ?? 0} 项`;
    byId("productBlockerCount").textContent = `${batch.blockerCount || 0} 项`;
    byId("productReminderCount").textContent = `${Number(batch.reminderCount || 0) + Number(batch.informationCount || 0)} 项`;
    byId("productBlockerDetails").hidden = Number(batch.blockerCount || 0) === 0;
    byId("productBlockerDetails").open = Number(batch.blockerCount || 0) > 0;
    byId("productChangesDetails").open = false;
    byId("productReminderDetails").open = false;
    byId("productTechnicalDetails").open = false;
    byId("productImportDecision").className = `product-import-decision ${batch.blockerCount > 0 ? "blocked" : "ready"}`;
    byId("productImportDecision").innerHTML = batch.blockerCount > 0
      ? `<strong>暂时无法导入</strong><span>发现 ${esc(batch.blockerCount)} 个阻断问题，请展开错误明细处理。</span>`
      : "<strong>可以导入</strong><span>未发现阻断问题；请核对摘要和字段变化后确认。</span>";
    const confirmArea = byId("productImportConfirmation");
    confirmArea.hidden = batch.status !== "preview_ready";
    const applyButton = byId("applyProductImportBtn");
    applyButton.disabled = batch.blockerCount > 0;
    applyButton.textContent = batch.blockerCount > 0 ? "存在阻断问题，无法入库" : "确认正式入库";
    byId("productAppliedState").hidden = batch.status !== "applied";
    byId("revalidateProductImportBtn").hidden = !new Set(["preview_ready", "validation_failed", "apply_failed"]).has(batch.status);
  }

  async function loadDetail(batchId) {
    const data = await responseJson(await authorizedFetch(`/api/product-center/imports/${encodeURIComponent(batchId)}`));
    renderDetail(data.detail);
    if (data.detail?.batch?.blockerCount) await loadIssuePage(1);
    if (Number(data.detail?.batch?.reminderCount || 0) + Number(data.detail?.batch?.informationCount || 0)) await loadReminderPage(1);
    setView("upload");
  }

  async function loadIssuePage(page) {
    const batchId = state.activeDetail?.batch?.id;
    if (!batchId) return;
    const data = await responseJson(await authorizedFetch(`/api/product-center/imports/${encodeURIComponent(batchId)}/issues?page=${page}&page_size=100&severity=blocker`));
    renderIssues(data);
  }

  async function loadReminderPage(page) {
    const batchId = state.activeDetail?.batch?.id;
    if (!batchId) return;
    const data = await responseJson(await authorizedFetch(`/api/product-center/imports/${encodeURIComponent(batchId)}/issues?page=${page}&page_size=100&severity=non_blocking`));
    renderReminders(data);
  }

  async function loadChangePage(page = 1) {
    const batchId = state.activeDetail?.batch?.id;
    if (!batchId) return;
    const params = new URLSearchParams({ page: String(page), page_size: "100" });
    const country = byId("productChangeCountryFilter").value.trim();
    const sku = byId("productChangeSkuFilter").value.trim();
    const field = byId("productChangeFieldFilter").value.trim();
    if (country) params.set("country", country);
    if (sku) params.set("sku", sku);
    if (field) params.set("field", field);
    const data = await responseJson(await authorizedFetch(`/api/product-center/imports/${encodeURIComponent(batchId)}/changes?${params}`));
    renderChanges(data);
  }

  async function loadRowPage(page) {
    const batchId = state.activeDetail?.batch?.id;
    if (!batchId) return;
    const data = await responseJson(await authorizedFetch(`/api/product-center/imports/${encodeURIComponent(batchId)}/rows?page=${page}&page_size=100`));
    renderRows(data);
  }

  async function loadHistory() {
    const data = await responseJson(await authorizedFetch("/api/product-center/imports?page=1&page_size=50"));
    state.loaded = true;
    const batches = data.batches || [];
    byId("productImportHistoryTable").innerHTML = batches.length ? `<table class="product-center-table">
      <thead><tr><th>批次</th><th>来源文件</th><th>时间</th><th>状态</th><th>数据量</th><th>质量</th><th>操作</th></tr></thead>
      <tbody>${batches.map((batch) => `<tr>
        <td><strong>${esc(batch.id.slice(0, 8))}</strong><small>${esc(batch.sourceSystem)}</small></td>
        <td><strong>${esc(batch.sourceFilename || "-")}</strong><small>${esc(batch.fileHashShort || "-")}</small></td><td>${esc(formatDate(batch.createdAt))}</td>
        <td><span class="product-status ${esc(batch.status)}">${esc(STATUS_LABELS[batch.status] || batch.status)}</span></td>
        <td>${esc(batch.rowCount)}</td><td>${esc(batch.blockerCount)} 阻断 / ${esc(batch.reminderCount)} 提醒</td>
        <td><button class="button-tertiary" type="button" data-product-batch-id="${esc(batch.id)}">查看详情</button></td>
      </tr>`).join("")}</tbody></table>` : '<p class="product-empty">暂无产品包导入记录。</p>';
  }

  function setSelectOptions(select, options, placeholder) {
    const selected = select.value;
    select.innerHTML = `<option value="">${esc(placeholder)}</option>${options.map((value) => `<option value="${esc(value)}">${esc(value)}</option>`).join("")}`;
    if (options.includes(selected)) select.value = selected;
  }

  async function loadCatalogFilters() {
    if (state.catalogFiltersLoaded) return;
    const data = await responseJson(await authorizedFetch("/api/product-center/products/filters"));
    const filters = data.filters || {};
    setSelectOptions(byId("productCatalogCategoryL1"), [...new Set((filters.categories || []).map((item) => item.categoryL1).filter(Boolean))], "全部类目");
    setSelectOptions(byId("productCatalogLifecycle"), filters.lifecycleStatuses || [], "全部状态");
    [...byId("productCatalogLifecycle").options].forEach((option) => {
      if (option.value) option.textContent = LIFECYCLE_LABELS[option.value] || option.value;
    });
    setSelectOptions(byId("productCatalogCountry"), filters.countries || [], "全部国家");
    state.catalogFiltersLoaded = true;
  }

  async function loadCapabilities() {
    const [capabilities, aiStatus] = await Promise.all([
      responseJson(await authorizedFetch("/api/product-center/capabilities")),
      responseJson(await authorizedFetch("/api/product-center/ai/status")),
    ]);
    state.capabilities = capabilities.permissions || {};
    state.aiStatus = aiStatus;
    byId("productDeletedFilterField").hidden = !can("product.restore");
  }

  function catalogQuery() {
    const params = new URLSearchParams({
      page: String(state.catalogPage),
      page_size: String(state.catalogPageSize),
      sort_by: "updated_at",
      sort_direction: "desc",
    });
    const fields = [
      ["keyword", byId("productCatalogKeyword").value.trim()],
      ["category_l1", byId("productCatalogCategoryL1").value],
      ["lifecycle_status", byId("productCatalogLifecycle").value],
      ["country", byId("productCatalogCountry").value],
      ["deleted", byId("productCatalogDeleted").value],
    ];
    fields.forEach(([key, value]) => { if (value) params.set(key, value); });
    return params;
  }

  function renderCatalog(data) {
    for (const url of state.imageObjectUrls) URL.revokeObjectURL(url);
    state.imageObjectUrls.clear();
    const products = data.products || [];
    state.catalogPage = Number(data.page || 1);
    state.catalogPageSize = Number(data.pageSize || 30);
    state.catalogTotalPages = Math.max(1, Number(data.totalPages || 1));
    const total = Number(data.total || 0);
    const start = total ? (state.catalogPage - 1) * state.catalogPageSize + 1 : 0;
    const end = Math.min(total, state.catalogPage * state.catalogPageSize);
    byId("productCatalogRange").textContent = total ? `显示 ${start}-${end}，共 ${total} 个 SKU` : "暂无已入库产品";
    byId("productCatalogPageStatus").textContent = `第 ${state.catalogPage} / ${state.catalogTotalPages} 页`;
    byId("productCatalogPrevBtn").disabled = state.catalogPage <= 1;
    byId("productCatalogNextBtn").disabled = state.catalogPage >= state.catalogTotalPages;
    byId("productCatalogTable").innerHTML = products.length ? `<table class="product-center-table product-catalog-table">
      <thead><tr><th>素材</th><th>SKU / 商品</th><th>国家 / 主 SKU</th><th>类目 / 规格</th><th>状态</th><th>更新</th><th>操作</th></tr></thead>
      <tbody>${products.map((product) => `<tr>
        <td>${product.image?.primaryImageId
          ? `<img class="product-thumbnail-image" alt="${esc(product.productName)}" data-product-image-product="${esc(product.id)}" data-product-image-id="${esc(product.image.primaryImageId)}" />`
          : '<div class="product-thumbnail-placeholder"><span>无图</span><small>可上传</small></div>'}</td>
        <td><strong>${esc(product.sku)}</strong><small class="product-name-cell">${esc(product.productName)}</small></td>
        <td><strong>${esc(product.country)}</strong><small>${esc(product.mainSku || "无主 SKU")}</small></td>
        <td><strong>${esc([product.categoryL1, product.categoryL2].filter(Boolean).join(" / "))}</strong><small>${esc(product.salesSpec)}</small></td>
        <td><span class="product-status ${product.deletedAt ? "deleted" : `lifecycle-${esc(String(product.lifecycleStatus || "unknown").toLowerCase())}`}">${product.deletedAt ? "已删除" : esc(LIFECYCLE_LABELS[product.lifecycleStatus] || product.sourceStatus)}</span><small>${product.deletedAt ? esc(formatDate(product.deletedAt)) : product.operationalEligible ? "运营池" : "仅历史查询"}</small></td>
        <td>${esc(formatDate(product.updatedAt))}<small>${esc(product.sourcePeriod || "-")}</small></td>
        <td><div class="table-actions">
          ${can("product.view") ? `<button class="button-tertiary" type="button" data-product-id="${esc(product.id)}">详情</button>` : ""}
          ${can("product.edit") && !product.deletedAt ? `<button class="button-tertiary" type="button" data-product-edit-id="${esc(product.id)}">编辑</button>` : ""}
          ${can("product.delete") && !product.deletedAt ? `<button class="button-danger-text" type="button" data-product-delete-id="${esc(product.id)}">删除</button>` : ""}
          ${can("product.restore") && product.deletedAt ? `<button class="button-tertiary" type="button" data-product-restore-id="${esc(product.id)}">恢复</button>` : ""}
        </div></td>
      </tr>`).join("")}</tbody></table>` : '<p class="product-empty">没有符合条件的产品。导入并入库产品包后会显示在这里。</p>';
    hydrateImages(byId("productCatalogTable"));
  }

  async function hydrateImages(root) {
    const images = [...root.querySelectorAll("[data-product-image-id]")];
    await Promise.all(images.map(async (image) => {
      try {
        const response = await authorizedFetch(`/api/product-center/products/${encodeURIComponent(image.dataset.productImageProduct)}/images/${encodeURIComponent(image.dataset.productImageId)}/content`);
        if (!response.ok) return;
        const objectUrl = URL.createObjectURL(await response.blob());
        state.imageObjectUrls.add(objectUrl);
        image.src = objectUrl;
      } catch {
        image.removeAttribute("src");
      }
    }));
  }

  async function loadCatalog({ resetPage = false } = {}) {
    if (resetPage) state.catalogPage = 1;
    if (!Object.keys(state.capabilities).length) await loadCapabilities();
    await loadCatalogFilters();
    const data = await responseJson(await authorizedFetch(`/api/product-center/products?${catalogQuery()}`));
    renderCatalog(data);
  }

  function displayFieldValue(value) {
    if (Array.isArray(value)) return value.length ? value.map((item) => formatNumber(item)).join("；") : "-";
    if (value === null || value === undefined || value === "") return "-";
    return typeof value === "number" ? formatNumber(value) : String(value);
  }

  function groupedFields(fields) {
    const groups = new Map();
    for (const field of fields) {
      if (!groups.has(field.groupLabel)) groups.set(field.groupLabel, []);
      groups.get(field.groupLabel).push(field);
    }
    return groups;
  }

  function renderProductImages(product, { editable = false } = {}) {
    if (!product.images?.length) return '<p class="product-empty">暂无图片，可在编辑中上传。</p>';
    return `<div class="product-image-list">${product.images.map((image) => `<div class="product-image-item">
      <img alt="${esc(image.originalFilename)}" data-product-image-product="${esc(product.id)}" data-product-image-id="${esc(image.id)}" />
      ${editable ? `<button class="icon-text-button" type="button" data-delete-product-image="${esc(image.id)}" title="移除图片" aria-label="移除图片">×</button>` : ""}
    </div>`).join("")}</div>`;
  }

  function renderProductDetail(product) {
    state.currentProduct = product;
    state.productFields = product.fields || state.productFields;
    state.visibleProductFields = product.visibleFields || state.visibleProductFields;
    byId("productDrawerTitle").textContent = product.productName || product.sku;
    byId("productDrawerMeta").textContent = `${product.country || "-"} · ${product.sku} · ${LIFECYCLE_LABELS[product.lifecycleStatus] || product.sourceStatus}`;
    byId("editProductBtn").hidden = !can("product.edit") || Boolean(product.deletedAt);
    const visible = new Set(state.visibleProductFields);
    const sections = [...groupedFields(state.productFields.filter((field) => visible.has(field.code))).entries()].map(([label, fields]) => `
      <section><h3>${esc(label)}</h3><div class="product-drawer-grid">${fields.map((field) => `<div>
        <span>${esc(field.label)} · ${product.manualOverrides && Object.hasOwn(product.manualOverrides, field.code) ? "人工维护" : "中台来源"}</span>
        <strong>${esc(displayFieldValue(product.fieldValues?.[field.code]))}</strong>
      </div>`).join("")}</div></section>`).join("");
    byId("productDrawerContent").innerHTML = `${sections}
      <section><h3>产品图片</h3>${renderProductImages(product)}</section>
      <section><h3>仓库明细</h3>${product.inventories?.length ? `<div class="product-inventory-list">${product.inventories.map((item) => `<div><strong>${esc(item.warehouse)}</strong><span>库存 ${esc(formatNumber(item.stock))}</span><small>${esc(item.plannedWarehouse || "无计划仓")}</small></div>`).join("")}</div>` : '<p class="product-empty">暂无仓库记录。</p>'}</section>
      <section><h3>人工修改记录</h3>${product.overrideEvents?.length ? `<div class="product-change-history">${product.overrideEvents.map((event) => `<div><strong>${esc(event.fieldCode)}</strong><span>原值：${esc(displayFieldValue(event.previousValue))}</span><span>人工值：${esc(displayFieldValue(event.nextValue))}</span><small>${esc(event.operatorLabel)} · ${esc(formatDate(event.occurredAt))}</small></div>`).join("")}</div>` : '<p class="product-empty">暂无人工修改。</p>'}</section>
      <section><h3>已确认 AI 内容</h3>${renderConfirmedAiContent(product.confirmedAiContent)}</section>
      <section><h3>来源与记录</h3><div class="product-drawer-grid">
        <div><span>来源文件</span><strong>${esc(product.sourceFilename)}</strong></div>
        <div><span>来源行</span><strong>${esc(product.sourceRowNumber)}</strong></div>
        <div><span>最近导入批次</span><strong>${esc(product.lastBatchId?.slice(0, 8))}</strong></div>
        <div><span>更新时间</span><strong>${esc(formatDate(product.updatedAt))}</strong></div>
        <div><span>运营池</span><strong>${product.operationalEligible ? "可进入" : "仅历史查询"}</strong></div>
        <div><span>人工变更</span><strong>${esc(product.overrideEvents?.length || 0)} 条</strong></div>
        <div><span>删除状态</span><strong>${product.deletedAt ? `已删除 · ${esc(formatDate(product.deletedAt))}` : "正常"}</strong></div>
      </div></section>`;
    hydrateImages(byId("productDrawerContent"));
  }

  function renderConfirmedAiContent(content) {
    const value = content?.outputContent;
    if (!value) return '<p class="product-empty">暂无已确认的 AI 内容。</p>';
    return `<div class="product-ai-readonly">
      <p>${esc(value.product_summary)}</p>
      <h4>核心卖点</h4><ul>${(value.selling_points || []).map((item) => `<li><strong>${esc(item.title)}</strong> ${esc(item.description)}<small>依据：${esc(item.source_field)}</small></li>`).join("")}</ul>
      <h4>使用场景</h4><ul>${(value.usage_scenarios || []).map((item) => `<li><strong>${esc(item.scene)}</strong> ${esc(item.user)} · ${esc(item.benefit)}</li>`).join("")}</ul>
      ${(value.risk_notes || []).length ? `<h4>待确认</h4><ul>${value.risk_notes.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>` : ""}
      <small>版本 ${esc(content.version)} · ${esc(content.model)} · ${esc(formatDate(content.confirmedAt))}</small>
    </div>`;
  }

  async function fetchProduct(id) {
    const data = await responseJson(await authorizedFetch(`/api/product-center/products/${encodeURIComponent(id)}`));
    return data.product;
  }

  async function openProductDetail(id) {
    renderProductDetail(await fetchProduct(id));
    const drawer = byId("productCatalogDrawer");
    if (!drawer.open) drawer.showModal();
  }

  function openFieldSettings() {
    const selected = new Set(state.visibleProductFields);
    byId("productDetailFieldsList").innerHTML = [...groupedFields(state.productFields).entries()].map(([label, fields]) => `
      <section class="product-field-group"><h3>${esc(label)}</h3><div class="product-field-options">${fields.map((field) => `<label>
        <input type="checkbox" name="product-detail-field" value="${esc(field.code)}" ${selected.has(field.code) ? "checked" : ""} />
        <span>${esc(field.label)}</span>
      </label>`).join("")}</div></section>`).join("");
    byId("productDetailFieldsDialog").showModal();
  }

  async function saveFieldSettings(event) {
    event.preventDefault();
    const visibleFields = [...byId("productDetailFieldsForm").querySelectorAll('input[name="product-detail-field"]:checked')].map((input) => input.value);
    const data = await responseJson(await authorizedFetch("/api/product-center/products/detail-preferences", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ visibleFields }),
    }));
    state.visibleProductFields = data.preference.visibleFields;
    byId("productDetailFieldsDialog").close();
    if (state.currentProduct) renderProductDetail({ ...state.currentProduct, visibleFields: state.visibleProductFields });
    onStatus("产品详情显示字段已应用到全部产品。", "success");
  }

  function markDirty(scope) {
    state.dirtyScopes.add(scope);
    byId("productListingStatus").className = "listing-status dirty";
    byId("productListingStatus").textContent = "有未保存修改";
  }

  function clearDirty(scope) {
    state.dirtyScopes.delete(scope);
    if (!state.dirtyScopes.size) renderListingStatus(state.currentListingDraft);
  }

  function hasUnsavedChanges() {
    return state.dirtyScopes.size > 0;
  }

  function renderProductOverrideFields(product) {
    const editableFields = (product.fields || []).filter((field) => field.editable);
    byId("productEditFields").innerHTML = editableFields.map((field) => {
      const hasOverride = product.manualOverrides && Object.hasOwn(product.manualOverrides, field.code);
      const current = product.fieldValues?.[field.code] ?? "";
      const longText = field.code === "sales_spec";
      const input = longText
        ? `<textarea class="auto-grow-textarea sales-spec-textarea" rows="3" name="${esc(field.code)}" data-field-type="${esc(field.type)}" data-initial-value="${esc(current)}">${esc(current)}</textarea>`
        : `<input name="${esc(field.code)}" data-field-type="${esc(field.type)}" data-initial-value="${esc(current)}" value="${esc(current)}" ${field.type === "number" || field.type === "integer" ? 'inputmode="decimal"' : ""} />`;
      return `<div class="product-override-field"><label class="field-block">
        <span>${esc(field.label)} <small class="product-field-source ${hasOverride ? "manual" : "central"}">${hasOverride ? "人工维护" : "中台来源"}</small></span>
        ${input}
        <small class="source-value-preview">中台原值：${esc(displayFieldValue(product.sourceFieldValues?.[field.code]))}</small>
      </label>${hasOverride ? `<label class="product-clear-override"><input type="checkbox" data-clear-override="${esc(field.code)}" /> 清除人工覆盖，恢复中台值</label>` : ""}</div>`;
    }).join("");
    resizeAutoGrowTextareas(byId("productEditFields"));
  }

  function fact(label, value, source = "产品包") {
    return `<div class="${label === "销售规格" ? "long-content" : ""}"><span>${esc(label)} <small class="source-badge ${source === "人工修改" ? "manual" : "central"}">${esc(source)}</small></span><strong>${esc(displayFieldValue(value))}</strong></div>`;
  }

  function renderProductFacts(product) {
    const fieldSource = (code) => Object.hasOwn(product.manualOverrides || {}, code) ? "人工修改" : "产品包";
    const values = product.fieldValues || {};
    const packaging = product.packaging || {};
    const material = values.material || values.材质 || "-";
    const color = values.color || values.颜色 || "-";
    const dimensions = values.item_dimensions_raw || packaging.itemDimensions || "-";
    const weight = packaging.itemGrossWeightG || packaging.itemNetWeightG || values.item_gross_weight_g || values.item_net_weight_g;
    const carton = values.carton_dimensions_raw || [packaging.cartonLengthCm, packaging.cartonWidthCm, packaging.cartonHeightCm].filter(Boolean).join(" × ") || "-";
    byId("productWorkbenchIdentityFacts").innerHTML = [
      fact("商品名称", product.productName, fieldSource("product_name")), fact("SKU", product.sku), fact("主 SKU", product.mainSku, fieldSource("main_sku_code")),
      fact("款号", product.styleCode, fieldSource("style_code")), fact("款名", product.styleName, fieldSource("style_name")),
      fact("类目", [product.categoryL1, product.categoryL2].filter(Boolean).join(" / "), fieldSource("category_l1")),
      fact("销售规格", product.salesSpec, fieldSource("sales_spec")), fact("材质", material, fieldSource("material")),
      fact("颜色", color, fieldSource("color")), fact("产品尺寸", dimensions, fieldSource("item_dimensions_raw")),
      fact("重量（g）", weight, fieldSource("item_gross_weight_g")), fact("包装信息", carton, fieldSource("carton_dimensions_raw")),
      fact("生命周期", LIFECYCLE_LABELS[product.lifecycleStatus] || product.lifecycleStatus),
    ].join("");
    const totalStock = (product.inventories || []).reduce((sum, item) => sum + (Number(item.stock) || 0), 0);
    const latestCost = product.costHistory?.[0] || {};
    byId("listingVariantFacts").innerHTML = [
      fact("产品 SKU", product.sku), fact("销售规格", product.salesSpec, fieldSource("sales_spec")),
      fact("产品包总库存", totalStock), fact("来源成本（CNY）", latestCost.costCny),
    ].join("");
  }

  function numberValue(value) {
    return value === null || value === undefined || value === "" ? "" : String(value);
  }

  function targetForCountry(value) {
    const code = COUNTRY_ALIASES[String(value || "").trim()] || String(value || "").trim().toUpperCase();
    return LISTING_TARGETS[code] || LISTING_TARGETS.MY;
  }

  function resizeAutoGrow(element) {
    if (!element?.matches?.("textarea.auto-grow-textarea")) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(Math.max(element.scrollHeight, 84), 260)}px`;
    element.style.overflowY = element.scrollHeight > 260 ? "auto" : "hidden";
  }

  function resizeAutoGrowTextareas(root = documentObject) {
    root.querySelectorAll?.("textarea.auto-grow-textarea").forEach(resizeAutoGrow);
  }

  function defaultListingDraft(product) {
    const totalStock = (product.inventories || []).reduce((sum, item) => sum + (Number(item.stock) || 0), 0);
    const images = product.images || [];
    const target = targetForCountry(product.country);
    return {
      id: null,
      platform: "",
      country: target.countryName,
      countryCode: target.countryCode,
      countryName: target.countryName,
      marketplaceCode: target.marketplaceCode,
      shopId: "",
      shopName: "",
      platformCategoryId: "",
      platformCategoryName: "",
      listingMode: "standard",
      title: product.productName || "",
      subtitle: "",
      description: "",
      searchKeywords: [],
      brand: "",
      model: product.styleCode || product.mainSku || "",
      targetUsers: "",
      productPositioning: "",
      contentStyle: "",
      pricePositioning: "",
      primaryScenarios: "",
      specialRequirements: "",
      forbiddenContent: "",
      contentLanguage: "中文",
      sellingPoints: [],
      usageScenarios: [],
      platformAttributes: [],
      variants: [{ sku: product.sku, name: product.salesSpec || product.productName || product.sku, status: "active", availableStock: totalStock }],
      pricing: { salePrice: null, originalPrice: null, promotionPrice: null },
      media: { imageIds: images.map((item) => item.id), primaryImageId: images.find((item) => item.isPrimary)?.id || images[0]?.id || null, videoUrl: "" },
      logistics: {
        weightG: product.packaging?.itemGrossWeightG ?? product.packaging?.itemNetWeightG ?? null,
        lengthCm: product.packaging?.cartonLengthCm ?? null,
        widthCm: product.packaging?.cartonWidthCm ?? null,
        heightCm: product.packaging?.cartonHeightCm ?? null,
        packageType: product.packaging?.shippingMethod || "",
        warehouse: product.inventories?.[0]?.warehouse || "",
        logisticsChannel: "",
        preorder: false,
        leadTimeDays: null,
      },
      compliance: { aiRiskNotes: [] },
      aiContextHash: null,
      aiAdoptions: {},
      validationResult: {},
      status: "draft",
    };
  }

  function renderListingStatus(draft) {
    const status = draft?.status || "draft";
    const label = { draft: "草稿", ready: "检查通过", publishing: "发布中", published: "已发布", failed: "失败", archived: "已归档" }[status] || status;
    byId("productListingStatus").className = `listing-status ${esc(status)}`;
    byId("productListingStatus").textContent = label;
  }

  function hasValue(id) {
    return Boolean(String(byId(id)?.value ?? "").trim());
  }

  function strategyIsReady() {
    return ["listingPlatform", "listingCountrySite", "listingShopName", "listingCategoryName", "listingTargetUsers", "listingProductPositioning", "listingContentStyle"].every(hasValue);
  }

  function copyIsReady() {
    return ["listingTitle", "listingDescription"].every(hasValue) && state.listingSellingPoints.length > 0 && state.listingUsageScenarios.length > 0;
  }

  function imagePlanPrerequisites() {
    return strategyIsReady() && copyIsReady() && !state.aiContextStale;
  }

  function workflowStates() {
    const validation = state.currentListingDraft?.validationResult || {};
    const checks = validation.checks || [];
    const strategyTypes = ["target_audience", "product_positioning", "content_style", "usage_scenarios"];
    const copyTypes = ["listing_title", "listing_subtitle", "listing_description", "selling_points", "usage_scenarios"];
    const anyActive = (types) => types.some((type) => state.aiActiveTypes.has(type));
    const anyAdopted = (types) => types.some((type) => state.aiAdoptions[type]);
    const anyManual = (types) => types.some((type) => state.aiManualModifiedTypes.has(type));
    const imageStatus = state.imageGenerationTask?.status;
    const productFacts = state.confirmedSteps.has("product_facts") ? "completed" : state.currentProduct ? "ready" : "not_started";
    let listingStrategy = strategyIsReady() ? "ready" : "incomplete";
    if (anyActive(strategyTypes)) listingStrategy = "generating";
    else if (state.aiContextStale && anyAdopted(strategyTypes)) listingStrategy = "stale";
    else if (anyManual(strategyTypes)) listingStrategy = "manually_modified";
    else if (anyAdopted(strategyTypes)) listingStrategy = "generated";
    let productCopy = copyIsReady() ? "ready" : "incomplete";
    if (anyActive(copyTypes)) productCopy = "generating";
    else if (state.aiContextStale && anyAdopted(copyTypes)) productCopy = "stale";
    else if (anyManual(copyTypes)) productCopy = "manually_modified";
    else if (anyAdopted(copyTypes)) productCopy = "generated";
    let imageAssets = imagePlanPrerequisites() ? ((state.currentListingDraft?.media?.imageIds || []).length ? "ready" : "incomplete") : "blocked";
    if (["pending", "generating_prompt", "waiting_generation", "generating"].includes(imageStatus)) imageAssets = "generating";
    else if (state.aiContextStale && state.imageGenerationTask) imageAssets = "stale";
    else if (imageStatus === "completed") imageAssets = "completed";
    else if (state.imageGenerationTask) imageAssets = "generated";
    const logisticsReady = Number(byId("listingSalePrice")?.value) > 0 && Number(byId("listingWeightG")?.value) > 0
      && ["listingLengthCm", "listingWidthCm", "listingHeightCm"].every((id) => Number(byId(id)?.value) > 0);
    const commerceLogistics = logisticsReady ? "ready" : "incomplete";
    const publicationChecks = !checks.length ? "not_started" : validation.blockerCount ? "blocked" : "completed";
    return { product_facts: productFacts, listing_strategy: listingStrategy, product_copy: productCopy, image_assets: imageAssets, commerce_logistics: commerceLogistics, publication_checks: publicationChecks };
  }

  function renderWorkbenchSummary() {
    if (!state.currentProduct) return;
    const target = LISTING_TARGETS[byId("listingCountrySite")?.value] || null;
    const platform = LISTING_PLATFORM_LABELS[byId("listingPlatform")?.value] || "待选择";
    const checks = state.currentListingDraft?.validationResult?.checks || [];
    const readiness = checks.length ? Math.round(((state.currentListingDraft.validationResult.completedCount || 0) / checks.length) * 100) : 0;
    byId("workbenchSummaryProduct").textContent = state.currentProduct.productName || "-";
    byId("workbenchSummarySku").textContent = state.currentProduct.sku || "-";
    byId("workbenchSummaryTarget").textContent = `${platform} / ${target?.countryName || "待选择"}`;
    byId("workbenchSummaryShop").textContent = byId("listingShopName")?.value.trim() || "待填写";
    byId("workbenchSummarySaved").textContent = state.currentListingDraft?.updatedAt ? formatDate(state.currentListingDraft.updatedAt) : "尚未保存";
    const aiSummary = byId("workbenchSummaryAi");
    const aiState = state.aiContextStale ? "stale" : Object.keys(state.aiAdoptions).length ? "generated" : "not_started";
    aiSummary.className = `workflow-state ${aiState}`;
    aiSummary.textContent = state.aiContextStale ? "上下文已变化" : Object.keys(state.aiAdoptions).length ? "已有采用内容" : "未生成";
    byId("workbenchSummaryReadiness").textContent = `${readiness}%`;
  }

  function renderListingPreview() {
    if (!state.currentProduct) return;
    const target = LISTING_TARGETS[byId("listingCountrySite")?.value];
    byId("listingPreviewTarget").textContent = `${LISTING_PLATFORM_LABELS[byId("listingPlatform")?.value] || "平台待选择"} · ${target?.countryName || "站点待选择"} · ${byId("listingShopName")?.value.trim() || "店铺待填写"}`;
    byId("listingPreviewTitle").textContent = byId("listingTitle")?.value.trim() || "商品标题待填写";
    byId("listingPreviewDescription").textContent = byId("listingDescription")?.value.trim() || "商品描述待填写";
    byId("listingPreviewPrice").textContent = Number(byId("listingSalePrice")?.value) > 0 ? `销售价 ${byId("listingSalePrice").value}` : "销售价待填写";
    const media = collectListingMedia();
    const image = (state.currentProduct.images || []).find((item) => item.id === media.primaryImageId);
    byId("listingPreviewImage").innerHTML = image
      ? `<img alt="${esc(image.originalFilename || "商品主图")}" data-product-image-product="${esc(state.currentProduct.id)}" data-product-image-id="${esc(image.id)}" />`
      : "暂无主图";
    if (image) hydrateImages(byId("listingPreviewImage"));
  }

  function updateWorkflowState() {
    if (!state.currentProduct) return;
    const states = workflowStates();
    for (const [step, status] of Object.entries(states)) {
      documentObject.querySelectorAll(`[data-step-state="${step}"], [data-workflow-nav="${step}"] .workflow-state`).forEach((element) => {
        element.className = `workflow-state ${status}`;
        element.textContent = WORKFLOW_STATE_LABELS[status];
      });
      const section = documentObject.querySelector(`[data-listing-workflow-step="${step}"]`);
      if (section) section.dataset.workflowStatus = status;
    }
    const imagePlanButton = byId("generateImagePlanBtn");
    if (imagePlanButton) imagePlanButton.disabled = !state.aiStatus.configured || !can("product.ai.generate") || !imagePlanPrerequisites();
    renderWorkbenchSummary();
    renderListingPreview();
  }

  function setValue(id, value) {
    const element = byId(id);
    if (element) element.value = value ?? "";
  }

  function renderDraftSelector() {
    const drafts = state.listingDrafts;
    byId("listingDraftSelector").innerHTML = `<div><strong>已有草稿</strong><span>${drafts.length} 个平台/店铺组合</span></div>
      <div class="listing-draft-chips">${drafts.map((draft) => `<button type="button" class="${draft.id === state.currentListingDraft?.id ? "active" : ""}" data-listing-draft-id="${esc(draft.id)}">
        <strong>${esc(LISTING_PLATFORM_LABELS[draft.platform] || draft.platform)}</strong><span>${esc(draft.shopName || draft.shopId || "未指定店铺")}</span>
      </button>`).join("")}<button type="button" data-new-listing-draft>＋ 新建平台草稿</button></div>`;
  }

  function renderAttributes() {
    byId("listingAttributesTable").innerHTML = state.listingAttributes.length ? state.listingAttributes.map((item, index) => `<div class="listing-attribute-row" data-attribute-index="${index}">
      <input data-attribute-key value="${esc(item.key || "")}" placeholder="属性名" aria-label="平台属性名" />
      <input data-attribute-value value="${esc(item.value || "")}" placeholder="属性值" aria-label="平台属性值" />
      <label><input data-attribute-required type="checkbox" ${item.required ? "checked" : ""} /> 必填</label>
      <button class="icon-text-button" type="button" data-remove-listing-attribute="${index}" aria-label="删除属性">×</button>
    </div>`).join("") : '<p class="product-empty">暂无平台属性。平台属性接口接入前，可手工增加键值。</p>';
  }

  function renderListingMedia(product, draft, { hydrate = true } = {}) {
    const selected = new Set(draft.media?.imageIds || []);
    const primary = draft.media?.primaryImageId || null;
    const byImageId = new Map((product.images || []).map((image) => [image.id, image]));
    const orderedIds = [...(draft.media?.imageIds || []), ...(product.images || []).map((item) => item.id).filter((id) => !selected.has(id))];
    state.listingMediaOrder = orderedIds;
    byId("listingMediaList").innerHTML = orderedIds.length ? orderedIds.map((id) => {
      const image = byImageId.get(id);
      if (!image) return "";
      return `<article class="listing-media-card ${selected.has(id) ? "selected" : ""}" draggable="true" data-listing-media-id="${esc(id)}">
        <img alt="${esc(image.originalFilename)}" data-product-image-product="${esc(product.id)}" data-product-image-id="${esc(id)}" />
        <div><label><input type="checkbox" data-listing-image-selected="${esc(id)}" ${selected.has(id) ? "checked" : ""} /> 加入草稿</label>
        <label><input type="radio" name="listing-primary-image" value="${esc(id)}" ${primary === id ? "checked" : ""} ${selected.has(id) ? "" : "disabled"} /> 设为主图</label></div>
        <span class="media-drag-handle" title="拖动排序">⋮⋮</span>
      </article>`;
    }).join("") : '<p class="product-empty">暂无可用产品图片，请先上传基础图片。</p>';
    if (hydrate) hydrateImages(byId("listingMediaList"));
  }

  async function hydrateWorkbenchImages() {
    await Promise.all([
      hydrateImages(byId("productImageList")),
      hydrateImages(byId("listingMediaList")),
    ]);
  }

  function renderValidation(result = {}) {
    const checks = result.checks || [];
    const ready = Boolean(result.ready);
    documentObject.querySelectorAll("[data-listing-field-error]").forEach((element) => element.remove());
    documentObject.querySelectorAll('[aria-invalid="true"]').forEach((element) => element.removeAttribute("aria-invalid"));
    for (const item of checks.filter((entry) => !entry.complete)) {
      const target = byId(LISTING_CHECK_TARGETS[item.code]);
      if (!target) continue;
      target.setAttribute("aria-invalid", "true");
      const field = target.closest?.(".field-block");
      if (field) field.insertAdjacentHTML("beforeend", `<small class="listing-field-error" data-listing-field-error>${esc(item.message)}</small>`);
    }
    byId("listingReadinessBadge").className = `listing-status ${checks.length ? (ready ? "ready" : "failed") : "draft"}`;
    byId("listingReadinessBadge").textContent = checks.length ? (ready ? "检查通过" : `${result.blockerCount || 0} 项阻断`) : "尚未检查";
    const readiness = checks.length ? Math.round(((result.completedCount || 0) / checks.length) * 100) : 0;
    const groups = groupPublicationChecks(checks);
    const infoCount = checks.filter((item) => item.severity === "info" && !item.complete).length;
    byId("listingValidationSummary").innerHTML = checks.length ? `<div class="validation-overview"><div><strong>${ready ? "发布前检查通过" : "仍需处理发布阻断项"}</strong><span>${result.blockerCount || 0} 阻断 · ${result.warningCount || 0} 提醒 · ${infoCount} 信息 · ${result.completedCount || 0} 已通过</span></div><b>${readiness}%</b></div>
      <div class="validation-groups">${groups.map((group) => `<section><header><h5>${esc(group.label)}</h5><span>${group.items.filter((item) => item.complete).length}/${group.items.length}</span></header><div class="validation-checks">${group.items.map((item) => `<article class="${item.complete ? "passed" : item.severity}" data-check-code="${esc(item.code)}"><span>${item.complete ? "✓" : item.severity === "blocker" ? "!" : item.severity === "warning" ? "△" : "i"}</span><div><strong>${esc(item.label)}</strong><small>${item.complete ? "已完成" : esc(item.message)}</small>${item.complete ? "" : `<p>建议：${esc(item.message)}</p>`}</div>${item.complete ? "" : `<button class="button-tertiary" type="button" data-locate-listing-check="${esc(item.code)}">定位字段</button>`}</article>`).join("")}</div></section>`).join("")}</div>`
      : '<p class="product-empty">点击“运行发布检查”生成报告。</p>';
    updateWorkflowState();
  }

  function renderListingDraft(product, draft) {
    state.currentListingDraft = draft;
    state.listingAttributes = [...(draft.platformAttributes || [])];
    state.listingSellingPoints = [...(draft.sellingPoints || [])];
    state.listingUsageScenarios = [...(draft.usageScenarios || [])];
    state.aiAdoptions = { ...(draft.aiAdoptions || {}) };
    state.aiManualModifiedTypes.clear();
    state.aiContextStale = false;
    setValue("listingPlatform", draft.platform);
    setValue("listingCountrySite", draft.countryCode || targetForCountry(draft.countryName || draft.country || product.country).countryCode);
    setValue("listingShopName", draft.shopName);
    setValue("listingShopId", draft.shopId);
    setValue("listingCategoryName", draft.platformCategoryName);
    setValue("listingCategoryId", draft.platformCategoryId);
    setValue("listingMode", draft.listingMode || "standard");
    setValue("listingTitle", draft.title);
    setValue("listingSubtitle", draft.subtitle);
    setValue("listingDescription", draft.description);
    setValue("listingKeywords", (draft.searchKeywords || []).join("\n"));
    setValue("listingTargetUsers", draft.targetUsers);
    setValue("listingProductPositioning", draft.productPositioning);
    setValue("listingContentStyle", draft.contentStyle);
    setValue("listingPricePositioning", draft.pricePositioning);
    setValue("listingPrimaryScenarios", draft.primaryScenarios);
    setValue("listingSpecialRequirements", draft.specialRequirements);
    setValue("listingForbiddenContent", draft.forbiddenContent);
    setValue("listingBrand", draft.brand);
    setValue("listingModel", draft.model);
    setValue("listingLanguage", draft.contentLanguage || "中文");
    const variant = draft.variants?.[0] || {};
    setValue("listingSalePrice", numberValue(draft.pricing?.salePrice));
    setValue("listingOriginalPrice", numberValue(draft.pricing?.originalPrice));
    setValue("listingPromotionPrice", numberValue(draft.pricing?.promotionPrice));
    setValue("listingAvailableStock", numberValue(variant.availableStock));
    setValue("listingVariantName", variant.name || product.salesSpec || "");
    setValue("listingVariantStatus", variant.status || "active");
    setValue("listingVideoUrl", draft.media?.videoUrl);
    setValue("listingWeightG", numberValue(draft.logistics?.weightG));
    setValue("listingLengthCm", numberValue(draft.logistics?.lengthCm));
    setValue("listingWidthCm", numberValue(draft.logistics?.widthCm));
    setValue("listingHeightCm", numberValue(draft.logistics?.heightCm));
    setValue("listingPackageType", draft.logistics?.packageType);
    setValue("listingWarehouse", draft.logistics?.warehouse);
    setValue("listingLogisticsChannel", draft.logistics?.logisticsChannel);
    setValue("listingPreorder", String(Boolean(draft.logistics?.preorder)));
    setValue("listingLeadTimeDays", numberValue(draft.logistics?.leadTimeDays));
    renderAttributes();
    renderListingMedia(product, draft);
    renderValidation(draft.validationResult);
    renderCurrentAiContent();
    renderAiSourceBadges();
    renderListingStatus(draft);
    updateListingCounts();
    renderDraftSelector();
    resizeAutoGrowTextareas(byId("productEditForm"));
    const currentSignature = listingStaleSignature();
    const adoptedSignatures = Object.values(state.aiAdoptions).map((entry) => entry?.contextSignature).filter(Boolean);
    state.aiContextBaseline = adoptedSignatures.at(-1) || currentSignature;
    state.aiContextStale = adoptedSignatures.some((signature) => signature !== currentSignature);
    byId("listingAiStaleNotice").hidden = !state.aiContextStale;
    updateWorkflowState();
  }

  function updateListingCounts() {
    for (const [field, counter] of [["listingTitle", "listingTitleCount"], ["listingSubtitle", "listingSubtitleCount"], ["listingDescription", "listingDescriptionCount"]]) {
      byId(counter).textContent = `${byId(field).value.length} 字`;
    }
  }

  function collectListingAttributes() {
    return [...byId("listingAttributesTable").querySelectorAll("[data-attribute-index]")].map((row) => ({
      key: row.querySelector("[data-attribute-key]").value.trim(),
      value: row.querySelector("[data-attribute-value]").value.trim(),
      required: row.querySelector("[data-attribute-required]").checked,
    })).filter((item) => item.key || item.value);
  }

  function collectListingMedia() {
    const selected = new Set([...byId("listingMediaList").querySelectorAll("[data-listing-image-selected]:checked")].map((input) => input.dataset.listingImageSelected));
    return {
      imageIds: state.listingMediaOrder.filter((id) => selected.has(id)),
      primaryImageId: byId("listingMediaList").querySelector('input[name="listing-primary-image"]:checked')?.value || null,
      videoUrl: byId("listingVideoUrl").value.trim(),
    };
  }

  function collectListingDraft() {
    const valueOrNull = (id) => byId(id).value === "" ? null : Number(byId(id).value);
    const target = LISTING_TARGETS[byId("listingCountrySite").value] || targetForCountry(state.currentProduct?.country);
    return {
      id: state.currentListingDraft?.id || null,
      platform: byId("listingPlatform").value,
      country: target.countryName,
      countryCode: target.countryCode,
      countryName: target.countryName,
      marketplaceCode: target.marketplaceCode,
      shopName: byId("listingShopName").value.trim(),
      shopId: byId("listingShopId").value.trim(),
      platformCategoryName: byId("listingCategoryName").value.trim(),
      platformCategoryId: byId("listingCategoryId").value.trim(),
      listingMode: byId("listingMode").value,
      title: byId("listingTitle").value.trim(),
      subtitle: byId("listingSubtitle").value.trim(),
      description: byId("listingDescription").value.trim(),
      searchKeywords: lines("listingKeywords"),
      targetUsers: byId("listingTargetUsers").value.trim(),
      productPositioning: byId("listingProductPositioning").value.trim(),
      contentStyle: byId("listingContentStyle").value.trim(),
      pricePositioning: byId("listingPricePositioning").value.trim(),
      primaryScenarios: byId("listingPrimaryScenarios").value.trim(),
      specialRequirements: byId("listingSpecialRequirements").value.trim(),
      forbiddenContent: byId("listingForbiddenContent").value.trim(),
      brand: byId("listingBrand").value.trim(),
      model: byId("listingModel").value.trim(),
      contentLanguage: byId("listingLanguage").value,
      sellingPoints: state.listingSellingPoints || [],
      usageScenarios: state.listingUsageScenarios || [],
      platformAttributes: collectListingAttributes(),
      variants: [{
        sku: state.currentProduct?.sku,
        name: byId("listingVariantName").value.trim(),
        status: byId("listingVariantStatus").value,
        availableStock: valueOrNull("listingAvailableStock"),
      }],
      pricing: {
        salePrice: valueOrNull("listingSalePrice"),
        originalPrice: valueOrNull("listingOriginalPrice"),
        promotionPrice: valueOrNull("listingPromotionPrice"),
      },
      media: collectListingMedia(),
      logistics: {
        weightG: valueOrNull("listingWeightG"), lengthCm: valueOrNull("listingLengthCm"),
        widthCm: valueOrNull("listingWidthCm"), heightCm: valueOrNull("listingHeightCm"),
        packageType: byId("listingPackageType").value.trim(), warehouse: byId("listingWarehouse").value.trim(),
        logisticsChannel: byId("listingLogisticsChannel").value.trim(), preorder: byId("listingPreorder").value === "true",
        leadTimeDays: valueOrNull("listingLeadTimeDays"),
      },
      compliance: {
        ...(state.currentListingDraft?.compliance || {}),
        aiRiskNotes: [...new Set(Object.values(state.aiCandidates).flatMap((entry) => entry.output?.risk_notes || []))],
      },
      aiContextHash: state.aiContextStale ? state.currentListingDraft?.aiContextHash || null : Object.values(state.aiAdoptions).find((entry) => entry?.contextHash)?.contextHash || state.currentListingDraft?.aiContextHash || null,
      aiAdoptions: state.aiAdoptions,
      status: state.currentListingDraft?.status || "draft",
      validationResult: state.currentListingDraft?.validationResult || {},
    };
  }

  function renderEditDialog(product, drafts = []) {
    state.currentProduct = product;
    state.listingDrafts = drafts;
    state.dirtyScopes.clear();
    state.confirmedSteps.clear();
    state.aiActiveTypes.clear();
    byId("productEditTitle").textContent = product.productName || product.sku;
    byId("productWorkbenchMeta").textContent = `${product.country || "-"} · ${product.sku} · 产品包事实与平台草稿分层保存`;
    renderProductFacts(product);
    renderProductOverrideFields(product);
    byId("productImageList").innerHTML = renderProductImages(product, { editable: true });
    hydrateImages(byId("productImageList"));
    state.aiGenerated = null;
    state.aiCandidates = {};
    state.aiAdoptions = {};
    state.imageGenerationTask = null;
    for (const id of ["aiPositioningCandidates", "aiTitleCandidates", "aiSubtitleCandidates", "aiDescriptionCandidates", "aiSellingScenarioCandidates"]) byId(id).innerHTML = "";
    byId("adoptAllStrategyBtn").hidden = true;
    renderAiConfiguration();
    renderListingDraft(product, drafts[0] || defaultListingDraft(product));
    renderImageGeneration();
    loadImageGenerationTasks().catch((error) => onStatus(error.message, "error"));
    documentObject.querySelectorAll("[data-workbench-section]").forEach((section, index) => {
      section.classList.remove("collapsed");
      section.classList.toggle("active-step", index === 0);
      const toggle = section.querySelector("[data-toggle-workflow-step]");
      if (toggle) toggle.textContent = "收起";
    });
    byId("productWorkbenchScroll").scrollTop = 0;
    state.dirtyScopes.clear();
    byId("productExtendedFacts").open = false;
    updateWorkflowState();
  }

  async function loadListingDrafts(productId) {
    const data = await responseJson(await authorizedFetch(`/api/product-center/products/${encodeURIComponent(productId)}/listing-drafts`));
    return data.drafts || [];
  }

  async function openProductEditor(id = state.currentProduct?.id) {
    if (!id) return;
    const [product, drafts] = await Promise.all([fetchProduct(id), loadListingDrafts(id)]);
    const drawer = byId("productCatalogDrawer");
    if (drawer.open) drawer.close();
    renderEditDialog(product, drafts);
    const dialog = byId("productEditDialog");
    if (!dialog.open) dialog.showModal();
  }

  async function saveProductOverrides() {
    const product = state.currentProduct;
    if (!product || !state.dirtyScopes.has("product")) return false;
    const fields = {};
    const clearFields = [...byId("productEditFields").querySelectorAll("[data-clear-override]:checked")].map((input) => input.dataset.clearOverride);
    for (const input of byId("productEditFields").querySelectorAll("[name]")) {
      if (clearFields.includes(input.name)) continue;
      if (input.value !== input.dataset.initialValue) fields[input.name] = input.value.trim() || null;
    }
    if (!Object.keys(fields).length && !clearFields.length) {
      clearDirty("product");
      return false;
    }
    await responseJson(await authorizedFetch(`/api/product-center/products/${encodeURIComponent(product.id)}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ fields, clearFields }),
    }));
    state.currentProduct = await fetchProduct(product.id);
    renderProductFacts(state.currentProduct);
    renderProductOverrideFields(state.currentProduct);
    clearDirty("product");
    return true;
  }

  async function saveListingWorkbench(check = false, triggerButton = null) {
    const product = state.currentProduct;
    if (!product) return;
    const button = triggerButton || (check ? byId("saveAndCheckListingBtn") : byId("saveListingDraftBtn"));
    button.disabled = true;
    let productChanged = false;
    try {
      productChanged = await saveProductOverrides();
      const draft = collectListingDraft();
      if (!draft.platform) {
        if (productChanged) {
          onStatus("产品人工修改已保存；上架草稿尚未保存，请选择目标平台。", "error");
          return;
        }
        throw new Error("请先选择目标平台，再保存上架草稿。");
      }
      let data;
      try {
        data = await responseJson(await authorizedFetch(`/api/product-center/products/${encodeURIComponent(product.id)}/listing-drafts`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ draft, check }),
        }));
      } catch (error) {
        throw new Error(`上架草稿保存失败；产品信息${productChanged ? "已成功保存" : "没有改动"}。${error.message}`);
      }
      state.currentListingDraft = data.draft;
      state.listingDrafts = await loadListingDrafts(product.id);
      await persistManualAiEdits();
      clearDirty("listing");
      renderListingDraft(state.currentProduct, data.draft);
      await loadCatalog();
      await hydrateWorkbenchImages();
      onStatus(`${productChanged ? "产品人工修改与" : ""}上架草稿已${check ? "保存并检查" : "保存"}，未调用平台接口。`, "success");
    } finally {
      button.disabled = false;
    }
  }

  function cleanupWorkbench() {
    state.aiAbortController?.abort();
    state.aiAbortController = null;
    state.workbenchObserver?.disconnect();
    state.workbenchObserver = null;
    state.dirtyScopes.clear();
    state.listingDrafts = [];
    state.currentListingDraft = null;
    state.listingAttributes = [];
    state.listingMediaOrder = [];
    state.aiGenerated = null;
    state.aiHistoryContents = [];
    state.aiCandidates = {};
    state.aiAdoptions = {};
    state.aiManualModifiedTypes.clear();
    state.aiContextBaseline = null;
    state.aiContextStale = false;
    state.confirmedSteps.clear();
    state.aiActiveTypes.clear();
    state.imageGenerationTask = null;
    state.currentProduct = null;
    byId("productDiscardDialog").open && byId("productDiscardDialog").close();
    byId("productEditDialog").open && byId("productEditDialog").close();
  }

  function resolveDiscardDecision(discard) {
    const resolver = state.discardResolver;
    state.discardResolver = null;
    if (byId("productDiscardDialog").open) byId("productDiscardDialog").close();
    resolver?.(discard);
  }

  function askToDiscard() {
    if (state.discardResolver) return Promise.resolve(false);
    return new Promise((resolve) => {
      state.discardResolver = resolve;
      byId("productDiscardDialog").showModal();
    });
  }

  async function handleRequestClose(source = "unknown") {
    if (!byId("productEditDialog").open || state.closeRequestPending) return !byId("productEditDialog").open;
    state.closeRequestPending = true;
    try {
      if (hasUnsavedChanges() && !(await askToDiscard())) return false;
      cleanupWorkbench();
      onStatus(source === "route-change" ? "已关闭上架工作台。" : "", "success");
      return true;
    } finally {
      state.closeRequestPending = false;
    }
  }

  async function uploadProductImages() {
    const product = state.currentProduct;
    const files = [...(byId("productImageFiles").files || [])];
    if (!product || !files.length) return onStatus("请选择需要上传的产品图片。", "error");
    const button = byId("uploadProductImagesBtn");
    button.disabled = true;
    try {
      for (const file of files) {
        await responseJson(await authorizedFetch(`/api/product-center/products/${encodeURIComponent(product.id)}/images`, {
          method: "POST",
          headers: { "content-type": file.type, "x-file-name": encodeURIComponent(file.name) },
          body: file,
        }));
      }
      state.currentProduct = await fetchProduct(product.id);
      byId("productImageList").innerHTML = renderProductImages(state.currentProduct, { editable: true });
      renderListingMedia(state.currentProduct, collectListingDraft(), { hydrate: false });
      byId("productImageFiles").value = "";
      await loadCatalog();
      await hydrateWorkbenchImages();
      onStatus("产品图片已上传。", "success");
    } finally {
      button.disabled = false;
    }
  }

  async function deleteProductImage(imageId) {
    const product = state.currentProduct;
    if (!product) return;
    await responseJson(await authorizedFetch(`/api/product-center/products/${encodeURIComponent(product.id)}/images/${encodeURIComponent(imageId)}`, { method: "DELETE" }));
    state.currentProduct = await fetchProduct(product.id);
    byId("productImageList").innerHTML = renderProductImages(state.currentProduct, { editable: true });
    renderListingMedia(state.currentProduct, collectListingDraft(), { hydrate: false });
    await loadCatalog();
    await hydrateWorkbenchImages();
    onStatus("图片已从产品展示中移除。", "success");
  }

  function renderAiConfiguration() {
    const configured = Boolean(state.aiStatus.configured);
    byId("productAiConfigurationNotice").className = `product-ai-notice ${configured ? "configured" : "unconfigured"}`;
    byId("productAiConfigurationNotice").textContent = configured
      ? `DeepSeek 已配置 · ${state.aiStatus.model || "deepseek-v4"} · ${state.aiStatus.promptVersion || "-"}`
      : "尚未配置 DeepSeek API Key，请联系管理员完成配置。";
    documentObject.querySelectorAll("[data-generate-ai-types]").forEach((button) => { button.disabled = !configured || !can("product.ai.generate"); });
    byId("showProductAiHistoryBtn").hidden = !can("product.ai.view_history");
    renderImageGeneration();
  }

  function sourceBadge(type) {
    const adoption = state.aiAdoptions[type];
    if (!adoption) return { label: "人工维护", className: "manual" };
    if (state.aiManualModifiedTypes.has(type)) return { label: "已人工修改", className: "manual" };
    return { label: "已采用", className: "ai" };
  }

  function renderAiSourceBadges() {
    documentObject.querySelectorAll("[data-content-source]").forEach((label) => {
      const source = sourceBadge(label.dataset.contentSource);
      label.textContent = source.label;
      label.className = `content-source ${source.className}`;
    });
  }

  function lines(id) {
    return byId(id).value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  }

  function collectCurrentAiLists() {
    const grouped = { selling_points: [], usage_scenarios: [] };
    for (const input of byId("productAiResult").querySelectorAll("[data-current-ai-list]")) {
      const list = grouped[input.dataset.currentAiList];
      const index = Number(input.dataset.currentAiIndex);
      list[index] ||= {};
      list[index][input.dataset.currentAiKey] = input.value.trim();
    }
    if (grouped.selling_points.length) state.listingSellingPoints = grouped.selling_points;
    if (grouped.usage_scenarios.length) state.listingUsageScenarios = grouped.usage_scenarios;
  }

  function renderCurrentAiContent() {
    const points = state.listingSellingPoints || [];
    const scenarios = state.listingUsageScenarios || [];
    const current = (title, type, items, fields) => `<section class="current-ai-content"><header><h4>${esc(title)}</h4><span class="content-source ${sourceBadge(type).className}">${sourceBadge(type).label}</span></header>
      <div class="product-ai-items">${items.length ? items.map((item, index) => `<div class="product-ai-item">${fields.map(([key, label]) => `<label><span>${esc(label)}</span><textarea rows="2" data-current-ai-list="${type}" data-current-ai-index="${index}" data-current-ai-key="${key}">${esc(item?.[key] || "")}</textarea></label>`).join("")}</div>`).join("") : '<p class="product-empty">尚未采用内容。</p>'}</div></section>`;
    byId("productAiResult").innerHTML = current("当前核心卖点", "selling_points", points, [["title", "标题"], ["description", "说明"], ["source_field", "事实依据"]])
      + current("当前使用场景", "usage_scenarios", scenarios, [["scene", "场景"], ["user", "适用人群"], ["benefit", "场景价值"]]);
  }

  function collectProductUiFacts() {
    const values = { ...(state.currentProduct?.fieldValues || {}) };
    byId("productEditFields").querySelectorAll("[name]").forEach((input) => { values[input.name] = input.value; });
    return {
      productName: values.product_name || state.currentProduct?.productName,
      mainSku: values.main_sku_code || state.currentProduct?.mainSku,
      styleCode: values.style_code || state.currentProduct?.styleCode,
      styleName: values.style_name || state.currentProduct?.styleName,
      categoryL1: values.category_l1 || state.currentProduct?.categoryL1,
      categoryL2: values.category_l2 || state.currentProduct?.categoryL2,
      salesSpec: values.sales_spec || state.currentProduct?.salesSpec,
      dimensions: values.item_dimensions_raw || state.currentProduct?.packaging?.itemDimensions,
      netWeightG: values.item_net_weight_g || state.currentProduct?.packaging?.itemNetWeightG,
      grossWeightG: values.item_gross_weight_g || state.currentProduct?.packaging?.itemGrossWeightG,
      packageDimensions: values.carton_dimensions_raw,
      cartonQuantity: values.carton_quantity,
      material: values.material || values.材质,
      color: values.color || values.颜色,
    };
  }

  function collectListingAiContext() {
    collectCurrentAiLists();
    const target = LISTING_TARGETS[byId("listingCountrySite").value] || targetForCountry(state.currentProduct?.country);
    return {
      productFacts: collectProductUiFacts(),
      platform: byId("listingPlatform").value,
      target,
      shopId: byId("listingShopId").value.trim(),
      shopName: byId("listingShopName").value.trim(),
      platformCategoryId: byId("listingCategoryId").value.trim(),
      platformCategoryName: byId("listingCategoryName").value.trim(),
      outputLanguage: byId("listingLanguage").value,
      targetAudience: byId("listingTargetUsers").value.trim(),
      productPositioning: byId("listingProductPositioning").value.trim(),
      contentStyle: byId("listingContentStyle").value.trim(),
      pricePositioning: byId("listingPricePositioning").value.trim(),
      primaryScenarios: byId("listingPrimaryScenarios").value.trim(),
      specialRequirements: byId("listingSpecialRequirements").value.trim(),
      forbiddenContent: byId("listingForbiddenContent").value.trim(),
      currentContent: {
        title: byId("listingTitle").value.trim(), subtitle: byId("listingSubtitle").value.trim(),
        description: byId("listingDescription").value.trim(), sellingPoints: state.listingSellingPoints,
        usageScenarios: state.listingUsageScenarios,
        manuallyModified: Object.fromEntries([...state.aiManualModifiedTypes].map((type) => [type, true])),
      },
      adoptedAi: state.aiAdoptions,
    };
  }

  function listingContextSignature() {
    return JSON.stringify(collectListingAiContext());
  }

  function listingStaleSignature() {
    const context = collectListingAiContext();
    delete context.adoptedAi;
    delete context.currentContent?.manuallyModified;
    return JSON.stringify(context);
  }

  function markAiContextStale() {
    if ((!Object.keys(state.aiAdoptions).length && !state.imageGenerationTask) || !state.aiContextBaseline) return;
    state.aiContextStale = listingStaleSignature() !== state.aiContextBaseline;
    byId("listingAiStaleNotice").hidden = !state.aiContextStale;
    if (state.aiContextStale) {
      const affected = Object.keys(state.aiAdoptions).map((type) => AI_TYPE_LABELS[type] || type);
      if (state.imageGenerationTask) affected.push("图片方案");
      byId("listingAiStaleScope").textContent = `受影响：${affected.join("、") || "已采用的 AI 内容"}。旧内容保留，人工修改不会被覆盖。`;
    }
    updateWorkflowState();
  }

  function candidateCard(type, value, index, reason = "") {
    const dataName = type === "listing_title" ? "data-adopt-ai-title" : type === "listing_description" ? "data-adopt-ai-description" : "data-adopt-ai-candidate";
    return `<article class="listing-ai-candidate"><div><span class="source-badge ai">待人工确认</span><strong>${esc(value)}</strong>${reason ? `<p>${esc(reason)}</p>` : ""}</div><button class="button-tertiary" type="button" ${dataName}="${index}" data-ai-type="${type}">采用此候选</button></article>`;
  }

  function renderGeneratedCandidates(types) {
    if (types.some((type) => ["target_audience", "product_positioning", "content_style"].includes(type))) {
      const strategyCards = types.filter((type) => ["target_audience", "product_positioning", "content_style"].includes(type) && state.aiCandidates[type]).map((type) => {
        const output = state.aiCandidates[type].output;
        const value = type === "target_audience" ? (output.target_users || []).join("\n") : output.text;
        return candidateCard(type, value, 0, output.reasoning_summary);
      });
      if (types.includes("usage_scenarios") && state.aiCandidates.usage_scenarios) {
        const output = state.aiCandidates.usage_scenarios.output;
        const value = (output.items || []).map((item) => `${item.scene}：${item.description}`).join("\n");
        strategyCards.push(candidateCard("usage_scenarios", value, 0, "采用后同步到使用场景，并可继续人工调整"));
      }
      byId("aiPositioningCandidates").innerHTML = strategyCards.join("");
      byId("adoptAllStrategyBtn").hidden = strategyCards.length === 0;
    }
    if (types.includes("listing_title")) {
      const output = state.aiCandidates.listing_title?.output;
      byId("aiTitleCandidates").innerHTML = (output?.titles || []).map((item, index) => candidateCard("listing_title", item.text, index, `${item.character_count} 字 · ${item.reason || "候选标题"}`)).join("");
    }
    if (types.includes("listing_subtitle")) {
      const output = state.aiCandidates.listing_subtitle?.output;
      byId("aiSubtitleCandidates").innerHTML = (output?.subtitles || []).map((item, index) => candidateCard("listing_subtitle", item.text, index, `${item.character_count} 字 · ${item.reason || "候选副标题"}`)).join("");
    }
    if (types.includes("listing_description")) {
      const output = state.aiCandidates.listing_description?.output;
      byId("aiDescriptionCandidates").innerHTML = output ? `<div class="listing-ai-compare"><section><span>当前版本</span><p>${esc(byId("listingDescription").value || "尚未填写")}</p></section><section><span>AI 候选</span><p>${esc(output.text)}</p></section></div>${candidateCard("listing_description", output.text, 0, "采用后仍可人工编辑")}` : "";
    }
    if (types.some((type) => ["selling_points", "usage_scenarios"].includes(type))) {
      const points = state.aiCandidates.selling_points?.output;
      const scenes = state.aiCandidates.usage_scenarios?.output;
      const html = [
        points ? `<section><h4>核心卖点候选</h4>${(points.items || []).map((item) => `<article class="ai-structured-candidate"><strong>${esc(item.title)}</strong><p>${esc(item.description)}</p><small>依据：${esc((item.source_fields || []).join("、"))}</small></article>`).join("")}<button type="button" data-adopt-ai-candidate="0" data-ai-type="selling_points">采用全部卖点</button></section>` : "",
        scenes ? `<section><h4>使用场景候选</h4>${(scenes.items || []).map((item) => `<article class="ai-structured-candidate"><strong>${esc(item.scene)}</strong><p>${esc(item.target_user)} · ${esc(item.description)}</p></article>`).join("")}<button type="button" data-adopt-ai-candidate="0" data-ai-type="usage_scenarios">采用全部场景</button></section>` : "",
      ].join("");
      byId("aiSellingScenarioCandidates").innerHTML = html;
    }
  }

  async function generateListingAi(types, button) {
    if (!state.currentProduct || !state.aiStatus.configured) return;
    const strategyRequest = types.some((type) => ["target_audience", "product_positioning", "content_style"].includes(type));
    if (strategyRequest && (!hasValue("listingPlatform") || !hasValue("listingCountrySite"))) {
      onStatus("请先选择平台和国家/站点，再生成上架策略。", "error");
      locateWorkbenchTarget("listingPlatform");
      return;
    }
    if (!strategyRequest && !strategyIsReady()) {
      onStatus("请先完成上架目标、目标用户、产品定位和内容风格，再生成商品文案。", "error");
      locateWorkbenchTarget("workflowListingStrategy", { focus: false });
      return;
    }
    state.aiAbortController = new AbortController();
    state.aiActiveTypes = new Set(types);
    updateWorkflowState();
    button.disabled = true;
    const originalLabel = button.textContent;
    button.textContent = "正在准备产品上下文…";
    byId("cancelProductAiBtn").hidden = false;
    try {
      const data = await responseJson(await authorizedFetch(`/api/product-center/products/${encodeURIComponent(state.currentProduct.id)}/ai/listing/generate`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
          contentTypes: types,
          listingDraftId: state.currentListingDraft?.id || null,
          listingContext: collectListingAiContext(),
          sellingPointCount: Number(byId("productAiSellingPointCount").value),
          scenarioCount: Number(byId("productAiScenarioCount").value),
          titleLimits: state.aiStatus.titleLimits || {},
        }), signal: state.aiAbortController.signal,
      }));
      state.aiGenerated = data.result;
      for (const type of types) {
        const record = data.result.records.find((item) => item.contentType === type);
        state.aiCandidates[type] = { output: data.result.outputContent[type], record };
      }
      renderGeneratedCandidates(types);
      button.textContent = "重新生成";
      onStatus("AI 候选已生成并记录，当前草稿内容尚未被覆盖。", "success");
    } catch (error) {
      if (error?.name !== "AbortError") onStatus(error.message, "error");
    } finally {
      state.aiAbortController = null;
      state.aiActiveTypes.clear();
      button.disabled = !state.aiStatus.configured || !can("product.ai.generate");
      if (button.textContent === "正在准备产品上下文…") button.textContent = originalLabel;
      byId("cancelProductAiBtn").hidden = true;
      updateWorkflowState();
    }
  }

  function generateProductAi() {
    return generateListingAi(["selling_points", "usage_scenarios"], byId("generateProductAiBtn"));
  }

  function selectedAiValue(type, output, index = 0) {
    if (type === "target_audience") return (output.target_users || []).join("\n");
    if (type === "product_positioning" || type === "content_style") return output.text || "";
    if (type === "listing_title") return output.titles?.[index]?.text || "";
    if (type === "listing_subtitle") return output.subtitles?.[index]?.text || "";
    if (type === "listing_description") return output.text || "";
    if (type === "selling_points") return (output.items || []).map((item) => ({ title: item.title, description: item.description, source_field: (item.source_fields || []).join("、") }));
    if (type === "usage_scenarios") return (output.items || []).map((item) => ({ scene: item.scene, user: item.target_user, benefit: item.description }));
    return "";
  }

  function applyAiValue(type, value) {
    const field = { target_audience: "listingTargetUsers", product_positioning: "listingProductPositioning", content_style: "listingContentStyle", listing_title: "listingTitle", listing_subtitle: "listingSubtitle", listing_description: "listingDescription" }[type];
    if (field) {
      setValue(field, value);
      resizeAutoGrow(byId(field));
      updateListingCounts();
    } else if (type === "selling_points") {
      state.listingSellingPoints = value;
      renderCurrentAiContent();
    } else if (type === "usage_scenarios") {
      state.listingUsageScenarios = value;
      renderCurrentAiContent();
    }
  }

  async function adoptAiCandidate(type, index = 0) {
    const candidate = state.aiCandidates[type];
    if (!candidate?.record) return;
    const value = selectedAiValue(type, candidate.output, index);
    const data = await responseJson(await authorizedFetch(`/api/product-center/products/${encodeURIComponent(state.currentProduct.id)}/ai/contents/${encodeURIComponent(candidate.record.id)}/confirm`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ adoptedContent: { value, selectedCandidateIndex: index } }),
    }));
    applyAiValue(type, value);
    if (type === "usage_scenarios" && Array.isArray(value)) {
      setValue("listingPrimaryScenarios", value.map((item) => `${item.scene}${item.benefit ? `：${item.benefit}` : ""}`).join("\n"));
      resizeAutoGrow(byId("listingPrimaryScenarios"));
    }
    const contextSignature = listingStaleSignature();
    state.aiAdoptions[type] = { contentId: data.content.id, version: data.content.version, contextHash: data.content.contextHash, contextSignature, value };
    state.aiManualModifiedTypes.delete(type);
    state.aiContextBaseline = contextSignature;
    state.aiContextStale = false;
    byId("listingAiStaleNotice").hidden = true;
    renderAiSourceBadges();
    markDirty("listing");
    updateWorkflowState();
    onStatus(`${AI_TYPE_LABELS[type]}候选已采用到当前上架草稿。`, "success");
  }

  async function adoptAllStrategyCandidates() {
    const types = ["target_audience", "product_positioning", "content_style", "usage_scenarios"].filter((type) => state.aiCandidates[type]?.record);
    for (const type of types) await adoptAiCandidate(type, 0);
    byId("adoptAllStrategyBtn").hidden = true;
    onStatus("上架策略建议已全部采用，仍可逐项人工调整。", "success");
  }

  function affectedAiTypes() {
    return Object.keys(state.aiAdoptions).filter((type) => AI_TYPE_LABELS[type]);
  }

  async function previewAndRegenerateAffectedContent() {
    const types = affectedAiTypes();
    const labels = types.map((type) => AI_TYPE_LABELS[type] || type);
    if (state.imageGenerationTask) labels.push("图片方案");
    if (!labels.length) return;
    const confirmed = documentObject.defaultView?.confirm?.(`将重新生成以下候选：${labels.join("、")}。\n\n当前已采用内容和人工修改会保留，只有明确采用新候选后才会变化。是否继续？`);
    if (confirmed === false) return;
    if (types.length) await generateListingAi(types, byId("regenerateAffectedContentBtn"));
    if (state.imageGenerationTask && imagePlanPrerequisites()) await generateImagePlan();
  }

  function manualValueForType(type) {
    if (type === "target_audience") return byId("listingTargetUsers").value.trim();
    if (type === "product_positioning") return byId("listingProductPositioning").value.trim();
    if (type === "content_style") return byId("listingContentStyle").value.trim();
    if (type === "listing_title") return byId("listingTitle").value.trim();
    if (type === "listing_subtitle") return byId("listingSubtitle").value.trim();
    if (type === "listing_description") return byId("listingDescription").value.trim();
    if (type === "selling_points") return state.listingSellingPoints;
    if (type === "usage_scenarios") return state.listingUsageScenarios;
    return null;
  }

  async function persistManualAiEdits() {
    const pending = [...state.aiManualModifiedTypes].filter((type) => state.aiAdoptions[type]?.contentId);
    for (const type of pending) {
      await responseJson(await authorizedFetch(`/api/product-center/products/${encodeURIComponent(state.currentProduct.id)}/ai/contents/${encodeURIComponent(state.aiAdoptions[type].contentId)}/manual`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ manualContent: { value: manualValueForType(type) } }),
      }));
    }
    state.aiManualModifiedTypes.clear();
    renderAiSourceBadges();
  }

  function aiHistorySummary(content) {
    const value = content.manualContent?.value ?? content.outputContent;
    if (typeof value === "string") return value.slice(0, 220);
    if (Array.isArray(value)) return value.map((item) => typeof item === "string" ? item : item.title || item.scene || "").filter(Boolean).join("；").slice(0, 220);
    const candidates = value?.titles || value?.subtitles || value?.target_users || value?.items;
    if (Array.isArray(candidates)) return candidates.map((item) => typeof item === "string" ? item : item.text || item.title || item.scene || "").filter(Boolean).join("；").slice(0, 220);
    return value?.text || value?.summary || "已保存结构化内容";
  }

  async function showAiHistory(contentType = "selling_points") {
    const product = state.currentProduct;
    if (!product) return;
    const data = await responseJson(await authorizedFetch(`/api/product-center/products/${encodeURIComponent(product.id)}/ai/contents?page=1&page_size=100&content_type=${encodeURIComponent(contentType)}`));
    state.aiHistoryContents = data.contents || [];
    byId("productAiHistoryDialog").dataset.contentType = contentType;
    byId("productAiHistoryDialog").querySelector("h2").textContent = `${AI_TYPE_LABELS[contentType] || contentType}生成记录`;
    byId("productAiHistoryList").innerHTML = data.contents?.length ? data.contents.map((content) => `<article>
      <header><strong>版本 ${esc(content.version)}</strong><span class="product-status ${esc(content.status)}">${esc({ draft: "候选", confirmed: "已采用", archived: "历史" }[content.status] || content.status)}</span></header>
      <p>${esc(aiHistorySummary(content))}</p><small>${esc(content.platform || "通用")} · ${esc(content.country)} · ${esc(content.model)} · ${esc(formatDate(content.createdAt))}</small>
      <div class="history-flags"><span>${content.isManuallyModified ? "已人工修改" : "AI 原始版本"}</span>${content.contextHash && state.aiContextStale ? "<span>上下文已变化</span>" : ""}</div>
      ${can("product.ai.confirm") ? `<button type="button" data-restore-ai-version="${esc(content.id)}">恢复此版本</button>` : ""}
    </article>`).join("") : '<p class="product-empty">暂无 AI 内容历史。</p>';
    byId("productAiHistoryDialog").showModal();
  }

  async function restoreAiVersion(contentId) {
    const product = state.currentProduct;
    const content = state.aiHistoryContents?.find((entry) => entry.id === contentId);
    if (!content) return;
    const confirmed = documentObject.defaultView?.confirm?.(`确认恢复${AI_TYPE_LABELS[content.contentType] || "此内容"}的版本 ${content.version}？`);
    if (confirmed === false) return;
    const data = await responseJson(await authorizedFetch(`/api/product-center/products/${encodeURIComponent(product.id)}/ai/contents/${encodeURIComponent(contentId)}/restore`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
    const output = data.content.manualContent?.value ?? data.content.adoptedContent?.value ?? selectedAiValue(content.contentType, data.content.outputContent, 0);
    applyAiValue(content.contentType, output);
    const contextSignature = listingStaleSignature();
    state.aiAdoptions[content.contentType] = { contentId, version: content.version, contextHash: content.contextHash, contextSignature, value: output };
    state.aiManualModifiedTypes.delete(content.contentType);
    state.aiContextBaseline = contextSignature;
    renderAiSourceBadges();
    markDirty("listing");
    byId("productAiHistoryDialog").close();
    onStatus("历史版本已恢复到当前草稿，请保存草稿。", "success");
  }

  function renderImageGeneration() {
    const status = state.aiStatus.imageGeneration || { configured: false, message: "尚未配置图片生成模型API，目前仅支持生成图片方案和提示词。", template: { slots: [] } };
    const notice = byId("imageAiConfigurationNotice");
    if (!notice) return;
    notice.className = `product-ai-notice ${status.configured ? "configured" : "unconfigured"}`;
    const prerequisitesReady = imagePlanPrerequisites();
    notice.textContent = !prerequisitesReady
      ? "请先完成上架策略和商品文案，并处理已失效的 AI 上下文，再生成图片方案。"
      : status.message || "尚未配置图片生成模型API，目前仅支持生成图片方案和提示词。";
    byId("generateImagePlanBtn").disabled = !state.aiStatus.configured || !can("product.ai.generate") || !prerequisitesReady;
    byId("generateImageTaskBtn").disabled = !state.imageGenerationTask;
    byId("retryImageTaskBtn").disabled = !state.imageGenerationTask?.items?.some((item) => item.status === "failed");
    byId("cancelImageTaskBtn").disabled = !state.imageGenerationTask || ["completed", "failed", "cancelled"].includes(state.imageGenerationTask.status);
    const task = state.imageGenerationTask;
    byId("imageGenerationTaskState").innerHTML = task ? `<strong>任务状态：${esc(AI_CONTENT_STATUS_LABELS[task.status] || task.status)}</strong><span>${esc(formatDate(task.updatedAt))}</span>` : "<span>尚未创建图片任务。</span>";
    const slots = task?.items || (status.template?.slots || []).map((slot, index) => ({ id: "", slotKey: slot.key, slotType: slot.type, slotIndex: index, label: slot.label, aspectRatio: slot.aspectRatio, prompt: "", status: "waiting" }));
    byId("imageGenerationSlots").innerHTML = slots.map((item) => `<article class="image-generation-slot ${esc(item.status)}"><div class="image-slot-preview"><span>${item.slotType === "primary" ? "主图" : `副图 ${item.slotIndex}`}</span></div><div><strong>${esc(item.label)}</strong><small>${esc(item.aspectRatio)} · ${esc(AI_CONTENT_STATUS_LABELS[item.status] || item.status)}</small><textarea rows="4" readonly>${esc(item.prompt || "生成图片方案后显示提示词")}</textarea>${item.errorMessage ? `<p class="error-text">${esc(item.errorMessage)}</p>` : ""}<div class="image-slot-actions">${item.id ? `<button class="button-tertiary" type="button" data-regenerate-image-item="${esc(item.id)}">单张重新生成</button>` : ""}${item.status === "completed" ? `<button type="button" data-adopt-image-item="${esc(item.id)}">采用到上架素材</button>` : ""}</div></div></article>`).join("");
    updateWorkflowState();
  }

  async function loadImageGenerationTasks() {
    if (!state.currentProduct) return;
    const data = await responseJson(await authorizedFetch(`/api/product-center/products/${encodeURIComponent(state.currentProduct.id)}/ai/images/tasks`));
    state.imageGenerationTask = data.tasks?.[0] || null;
    renderImageGeneration();
  }

  async function generateImagePlan() {
    if (!state.currentProduct) return;
    const button = byId("generateImagePlanBtn");
    button.disabled = true;
    button.textContent = "正在生成图片方案…";
    try {
      const data = await responseJson(await authorizedFetch(`/api/product-center/products/${encodeURIComponent(state.currentProduct.id)}/ai/images/plan`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ listingDraftId: state.currentListingDraft?.id || null, listingContext: collectListingAiContext() }),
      }));
      state.imageGenerationTask = data.task;
      renderImageGeneration();
      onStatus("图片方案和提示词已生成，尚未生成真实图片。", "success");
    } finally {
      button.disabled = !state.aiStatus.configured;
      button.textContent = "重新生成图片方案和提示词";
    }
  }

  async function runImageGeneration(failedOnly = false, onlyItemId = null) {
    const task = state.imageGenerationTask;
    if (!task) return;
    const itemIds = onlyItemId ? [onlyItemId] : failedOnly ? task.items.filter((item) => item.status === "failed").map((item) => item.id) : null;
    const data = await responseJson(await authorizedFetch(`/api/product-center/products/${encodeURIComponent(state.currentProduct.id)}/ai/images/tasks/${encodeURIComponent(task.id)}/generate`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ itemIds }),
    }));
    state.imageGenerationTask = data.task;
    renderImageGeneration();
  }

  async function cancelImageGeneration() {
    const task = state.imageGenerationTask;
    if (!task) return;
    const data = await responseJson(await authorizedFetch(`/api/product-center/products/${encodeURIComponent(state.currentProduct.id)}/ai/images/tasks/${encodeURIComponent(task.id)}/cancel`, { method: "POST" }));
    state.imageGenerationTask = data.task;
    renderImageGeneration();
  }

  async function adoptGeneratedImage(itemId) {
    const task = state.imageGenerationTask;
    const data = await responseJson(await authorizedFetch(`/api/product-center/products/${encodeURIComponent(state.currentProduct.id)}/ai/images/tasks/${encodeURIComponent(task.id)}/items/${encodeURIComponent(itemId)}/adopt`, { method: "POST" }));
    state.imageGenerationTask = data.task;
    renderImageGeneration();
    onStatus("AI 图片已采用到当前上架素材。", "success");
  }

  function contentTypeForElement(element) {
    const byElementId = {
      listingTargetUsers: "target_audience", listingProductPositioning: "product_positioning", listingContentStyle: "content_style",
      listingTitle: "listing_title", listingSubtitle: "listing_subtitle", listingDescription: "listing_description",
    };
    if (byElementId[element.id]) return byElementId[element.id];
    return element.closest?.("[data-current-ai-list]")?.dataset.currentAiList || null;
  }

  function markAiManualEdit(element) {
    const type = contentTypeForElement(element);
    if (!type || !state.aiAdoptions[type]) return;
    state.aiManualModifiedTypes.add(type);
    if (type === "selling_points" || type === "usage_scenarios") collectCurrentAiLists();
    renderAiSourceBadges();
  }

  function renderDeleteSummary(product) {
    const warehouseCount = new Set((product.inventories || []).map((item) => item.warehouse).filter(Boolean)).size;
    byId("productDeleteSummary").innerHTML = `<dl>
      <div><dt>中文名称</dt><dd>${esc(product.productName)}</dd></div><div><dt>SKU</dt><dd>${esc(product.sku)}</dd></div>
      <div><dt>国家</dt><dd>${esc(product.country)}</dd></div><div><dt>一级品类</dt><dd>${esc(product.categoryL1)}</dd></div>
      <div><dt>二级品类</dt><dd>${esc(product.categoryL2)}</dd></div><div><dt>关联仓库</dt><dd>${warehouseCount} 个</dd></div>
      <div><dt>关联图片</dt><dd>${esc(product.images?.length || 0)} 张</dd></div><div><dt>人工修改</dt><dd>${product.manualOverrideCount || Object.keys(product.manualOverrides || {}).length ? "有" : "无"}</dd></div>
      <div><dt>AI 生成内容</dt><dd>${product.aiContentCount || product.confirmedAiContent ? "有" : "无"}</dd></div>
    </dl><p>删除后，该产品将不再出现在正常产品查询结果中。历史产品包导入数据和导入批次记录不会被删除。</p>`;
  }

  async function openDeleteDialog(productId) {
    const product = await fetchProduct(productId);
    state.pendingDeleteProduct = product;
    byId("productDeleteReason").value = "";
    renderDeleteSummary(product);
    byId("productDeleteDialog").showModal();
  }

  async function deleteProduct(event) {
    event.preventDefault();
    const product = state.pendingDeleteProduct;
    if (!product) return;
    await responseJson(await authorizedFetch(`/api/product-center/products/${encodeURIComponent(product.id)}`, {
      method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: byId("productDeleteReason").value.trim() }),
    }));
    byId("productDeleteDialog").close();
    state.pendingDeleteProduct = null;
    await loadCatalog();
    onStatus(`已删除 ${product.country} · ${product.sku}，历史记录仍保留。`, "success");
  }

  async function restoreProduct(productId) {
    await responseJson(await authorizedFetch(`/api/product-center/products/${encodeURIComponent(productId)}/restore`, { method: "POST" }));
    await loadCatalog();
    onStatus("产品已恢复。", "success");
  }

  function locateWorkbenchTarget(targetId, { focus = true } = {}) {
    const target = byId(targetId);
    if (!target) return;
    const disclosure = target.closest?.("details");
    if (disclosure) disclosure.open = true;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.add("field-locate-highlight");
    if (focus && typeof target.focus === "function") target.focus({ preventScroll: true });
    setTimeout(() => target.classList.remove("field-locate-highlight"), 2200);
  }

  function showListingPreview() {
    renderListingPreview();
    locateWorkbenchTarget("listingPlatformPreview", { focus: true });
  }

  async function apply() {
    const batch = state.activeDetail?.batch;
    if (!batch) return null;
    const button = byId("applyProductImportBtn");
    button.disabled = true;
    try {
      const response = await authorizedFetch(`/api/product-center/imports/${encodeURIComponent(batch.id)}/apply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmed: true }),
      });
      await responseJson(response);
      await loadDetail(batch.id);
      state.catalogFiltersLoaded = false;
      await loadCatalog({ resetPage: true });
      onStatus("产品包已入库，产品查询数据已更新。", "success");
      return true;
    } catch (error) {
      onStatus(error.message, "error");
      button.disabled = false;
      return false;
    }
  }

  async function upload(event) {
    event.preventDefault();
    const file = byId("productPackageFile").files?.[0];
    if (!file) return onStatus("请选择产品包 Excel。", "error");
    if (!file.name.toLowerCase().endsWith(".xlsx")) return onStatus("仅支持 .xlsx 产品包。", "error");
    const button = byId("uploadProductPackageBtn");
    button.disabled = true;
    button.textContent = "正在处理…";
    onStatus("正在读取产品包并校验中台字段…", "loading");
    try {
      const response = await authorizedFetch("/api/product-center/imports", {
        method: "POST",
        headers: {
          "content-type": file.type || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "x-file-name": encodeURIComponent(file.name),
        },
        body: file,
      });
      const data = await responseJson(response);
      renderDetail(data.detail);
      if (data.detail?.batch?.blockerCount) await loadIssuePage(1);
      if (Number(data.detail?.batch?.reminderCount || 0) + Number(data.detail?.batch?.informationCount || 0)) await loadReminderPage(1);
      await loadHistory();
      const message = data.revalidated ? "原批次已按最新规则重新校验。" : data.reused ? "该文件已存在，已打开原导入批次。" : "产品包解析完成，已生成逐行差异预览。";
      onStatus(data.detail?.batch?.blockerCount ? `${message} 请先处理真实阻断问题。` : `${message} 请确认后入库。`, data.detail?.batch?.blockerCount ? "error" : "success");
    } catch (error) {
      onStatus(error.message, "error");
    } finally {
      button.disabled = false;
      button.textContent = "上传产品包";
    }
  }

  async function revalidate() {
    const batch = state.activeDetail?.batch;
    if (!batch) return;
    const button = byId("revalidateProductImportBtn");
    button.disabled = true;
    onStatus("正在按最新中台状态规则重新校验…", "loading");
    try {
      const response = await authorizedFetch(`/api/product-center/imports/${encodeURIComponent(batch.id)}/revalidate`, { method: "POST" });
      const data = await responseJson(response);
      renderDetail(data.detail);
      if (data.detail?.batch?.blockerCount) await loadIssuePage(1);
      if (Number(data.detail?.batch?.reminderCount || 0) + Number(data.detail?.batch?.informationCount || 0)) await loadReminderPage(1);
      onStatus(data.detail.batch.blockerCount ? "重新校验完成，仍有真实阻断问题。" : "重新校验完成，请检查差异后确认入库。", data.detail.batch.blockerCount ? "error" : "success");
      await loadHistory();
    } catch (error) {
      onStatus(error.message, "error");
    } finally {
      button.disabled = false;
    }
  }

  function initialize() {
    byId("productPackageUploadForm").addEventListener("submit", upload);
    byId("applyProductImportBtn").addEventListener("click", () => apply());
    byId("revalidateProductImportBtn").addEventListener("click", revalidate);
    documentObject.querySelectorAll("[data-product-view]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.productView)));
    byId("refreshProductImportsBtn").addEventListener("click", () => loadHistory().catch((error) => onStatus(error.message, "error")));
    byId("productImportHistoryTable").addEventListener("click", (event) => {
      const button = event.target.closest("[data-product-batch-id]");
      if (button) loadDetail(button.dataset.productBatchId).catch((error) => onStatus(error.message, "error"));
    });
    byId("productIssuesPrevBtn").addEventListener("click", () => loadIssuePage(state.issuePage - 1).catch((error) => onStatus(error.message, "error")));
    byId("productIssuesNextBtn").addEventListener("click", () => loadIssuePage(state.issuePage + 1).catch((error) => onStatus(error.message, "error")));
    byId("productRemindersPrevBtn").addEventListener("click", () => loadReminderPage(state.reminderPage - 1).catch((error) => onStatus(error.message, "error")));
    byId("productRemindersNextBtn").addEventListener("click", () => loadReminderPage(state.reminderPage + 1).catch((error) => onStatus(error.message, "error")));
    byId("productChangesPrevBtn").addEventListener("click", () => loadChangePage(state.changePage - 1).catch((error) => onStatus(error.message, "error")));
    byId("productChangesNextBtn").addEventListener("click", () => loadChangePage(state.changePage + 1).catch((error) => onStatus(error.message, "error")));
    byId("productChangeFilters").addEventListener("submit", (event) => {
      event.preventDefault();
      loadChangePage(1).catch((error) => onStatus(error.message, "error"));
    });
    byId("resetProductChangeFiltersBtn").addEventListener("click", () => {
      byId("productChangeFilters").reset();
      loadChangePage(1).catch((error) => onStatus(error.message, "error"));
    });
    byId("productRowsPrevBtn").addEventListener("click", () => loadRowPage(state.rowPage - 1).catch((error) => onStatus(error.message, "error")));
    byId("productRowsNextBtn").addEventListener("click", () => loadRowPage(state.rowPage + 1).catch((error) => onStatus(error.message, "error")));
    byId("productCatalogSearchForm").addEventListener("submit", (event) => {
      event.preventDefault();
      loadCatalog({ resetPage: true }).catch((error) => onStatus(error.message, "error"));
    });
    byId("resetProductCatalogBtn").addEventListener("click", () => {
      byId("productCatalogSearchForm").reset();
      loadCatalog({ resetPage: true }).catch((error) => onStatus(error.message, "error"));
    });
    byId("productCatalogPageSize").addEventListener("change", (event) => {
      state.catalogPageSize = Number(event.target.value || 30);
      loadCatalog({ resetPage: true }).catch((error) => onStatus(error.message, "error"));
    });
    byId("productCatalogPrevBtn").addEventListener("click", () => {
      state.catalogPage -= 1;
      loadCatalog().catch((error) => onStatus(error.message, "error"));
    });
    byId("productCatalogNextBtn").addEventListener("click", () => {
      state.catalogPage += 1;
      loadCatalog().catch((error) => onStatus(error.message, "error"));
    });
    byId("productCatalogTable").addEventListener("click", (event) => {
      const deleteButton = event.target.closest("[data-product-delete-id]");
      if (deleteButton) {
        openDeleteDialog(deleteButton.dataset.productDeleteId).catch((error) => onStatus(error.message, "error"));
        return;
      }
      const restoreButton = event.target.closest("[data-product-restore-id]");
      if (restoreButton) {
        restoreProduct(restoreButton.dataset.productRestoreId).catch((error) => onStatus(error.message, "error"));
        return;
      }
      const editButton = event.target.closest("[data-product-edit-id]");
      if (editButton) {
        openProductEditor(editButton.dataset.productEditId).catch((error) => onStatus(error.message, "error"));
        return;
      }
      const button = event.target.closest("[data-product-id]");
      if (button) openProductDetail(button.dataset.productId).catch((error) => onStatus(error.message, "error"));
    });
    byId("configureProductFieldsBtn").addEventListener("click", openFieldSettings);
    byId("editProductBtn").addEventListener("click", () => openProductEditor().catch((error) => onStatus(error.message, "error")));
    byId("productDetailFieldsForm").addEventListener("submit", (event) => saveFieldSettings(event).catch((error) => onStatus(error.message, "error")));
    for (const [id, source] of [["cancelProductEditBtn", "cancel-button"], ["closeProductEditBtn", "close-icon"], ["productWorkbenchBackBtn", "route-change"]]) {
      byId(id).addEventListener("click", () => handleRequestClose(source).catch((error) => onStatus(error.message, "error")));
    }
    byId("saveListingDraftBtn").addEventListener("click", () => saveListingWorkbench(false).catch((error) => onStatus(error.message, "error")));
    byId("saveAndCheckListingBtn").addEventListener("click", () => saveListingWorkbench(true).catch((error) => onStatus(error.message, "error")));
    byId("previewListingBtn").addEventListener("click", showListingPreview);
    byId("saveCommerceInfoBtn").addEventListener("click", (event) => saveListingWorkbench(false, event.currentTarget).catch((error) => onStatus(error.message, "error")));
    byId("runPublicationChecksBtn").addEventListener("click", (event) => saveListingWorkbench(true, event.currentTarget).catch((error) => onStatus(error.message, "error")));
    byId("confirmProductFactsBtn").addEventListener("click", async () => {
      await saveProductOverrides();
      state.confirmedSteps.add("product_facts");
      updateWorkflowState();
      onStatus("产品事实已确认，可继续制定上架策略。", "success");
    });
    byId("productEditDialog").addEventListener("cancel", (event) => {
      event.preventDefault();
      handleRequestClose("escape-key").catch((error) => onStatus(error.message, "error"));
    });
    byId("productEditDialog").addEventListener("click", (event) => {
      if (event.target === byId("productEditDialog")) handleRequestClose("backdrop").catch((error) => onStatus(error.message, "error"));
    });
    byId("productDiscardDialog").addEventListener("cancel", (event) => {
      event.preventDefault();
      resolveDiscardDecision(false);
    });
    byId("continueProductEditBtn").addEventListener("click", () => resolveDiscardDecision(false));
    byId("discardProductEditBtn").addEventListener("click", () => resolveDiscardDecision(true));
    byId("productEditForm").addEventListener("input", (event) => {
      if (event.target.id === "productImageFiles") return;
      resizeAutoGrow(event.target);
      markAiManualEdit(event.target);
      if (event.target.closest("#productEditFields")) markDirty("product");
      else markDirty("listing");
      updateListingCounts();
      markAiContextStale();
      updateWorkflowState();
    });
    byId("productEditForm").addEventListener("change", (event) => {
      if (event.target.id === "productImageFiles") return;
      if (event.target.closest("#productEditFields")) markDirty("product");
      else markDirty("listing");
      markAiContextStale();
      updateWorkflowState();
    });
    documentObject.querySelectorAll("[data-workbench-anchor]").forEach((button) => button.addEventListener("click", () => {
      const target = byId(button.dataset.workbenchAnchor);
      target?.classList.remove("collapsed");
      const toggle = target?.querySelector("[data-toggle-workflow-step]");
      if (toggle) toggle.textContent = "收起";
      target?.scrollIntoView({ behavior: "smooth", block: "start" });
    }));
    documentObject.querySelectorAll("[data-toggle-workflow-step]").forEach((button) => button.addEventListener("click", () => {
      const section = byId(button.dataset.toggleWorkflowStep);
      section?.classList.toggle("collapsed");
      button.textContent = section?.classList.contains("collapsed") ? "展开" : "收起";
    }));
    byId("productWorkbenchScroll").addEventListener("scroll", () => {
      const scrollRoot = byId("productWorkbenchScroll");
      const sections = [...documentObject.querySelectorAll("[data-workbench-section]")];
      const active = sections.reduce((current, section) => section.offsetTop <= scrollRoot.scrollTop + 150 ? section : current, sections[0]);
      documentObject.querySelectorAll("[data-workbench-anchor]").forEach((button) => button.classList.toggle("active", button.dataset.workbenchAnchor === active?.id));
      sections.forEach((section) => section.classList.toggle("active-step", section === active));
    });
    byId("listingDraftSelector").addEventListener("click", (event) => {
      const draftButton = event.target.closest("[data-listing-draft-id]");
      const newButton = event.target.closest("[data-new-listing-draft]");
      if (!draftButton && !newButton) return;
      if (hasUnsavedChanges()) return onStatus("请先保存或关闭当前修改，再切换上架草稿。", "error");
      const nextDraft = draftButton
        ? state.listingDrafts.find((item) => item.id === draftButton.dataset.listingDraftId)
        : defaultListingDraft(state.currentProduct);
      if (nextDraft) renderListingDraft(state.currentProduct, nextDraft);
    });
    byId("addListingAttributeBtn").addEventListener("click", () => {
      state.listingAttributes = collectListingAttributes();
      state.listingAttributes.push({ key: "", value: "", required: false, source: "manual" });
      renderAttributes();
      markDirty("listing");
      byId("listingAttributesTable").querySelector("[data-attribute-index]:last-child [data-attribute-key]")?.focus();
    });
    byId("listingAttributesTable").addEventListener("click", (event) => {
      const button = event.target.closest("[data-remove-listing-attribute]");
      if (!button) return;
      state.listingAttributes = collectListingAttributes();
      state.listingAttributes.splice(Number(button.dataset.removeListingAttribute), 1);
      renderAttributes();
      markDirty("listing");
    });
    byId("listingMediaList").addEventListener("change", (event) => {
      const checkbox = event.target.closest("[data-listing-image-selected]");
      if (checkbox) {
        const card = checkbox.closest("[data-listing-media-id]");
        card.classList.toggle("selected", checkbox.checked);
        const primary = card.querySelector('input[name="listing-primary-image"]');
        primary.disabled = !checkbox.checked;
        if (!checkbox.checked && primary.checked) primary.checked = false;
      }
      markDirty("listing");
    });
    let draggedMediaId = null;
    byId("listingMediaList").addEventListener("dragstart", (event) => {
      draggedMediaId = event.target.closest("[data-listing-media-id]")?.dataset.listingMediaId || null;
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    });
    byId("listingMediaList").addEventListener("dragover", (event) => event.preventDefault());
    byId("listingMediaList").addEventListener("drop", (event) => {
      event.preventDefault();
      const targetId = event.target.closest("[data-listing-media-id]")?.dataset.listingMediaId;
      if (!draggedMediaId || !targetId || draggedMediaId === targetId) return;
      const draft = collectListingDraft();
      const order = [...state.listingMediaOrder];
      const from = order.indexOf(draggedMediaId);
      const to = order.indexOf(targetId);
      order.splice(to, 0, order.splice(from, 1)[0]);
      draft.media.imageIds = order.filter((id) => draft.media.imageIds.includes(id));
      state.listingMediaOrder = order;
      renderListingMedia(state.currentProduct, draft);
      markDirty("listing");
      draggedMediaId = null;
    });
    byId("uploadProductImagesBtn").addEventListener("click", () => uploadProductImages().catch((error) => onStatus(error.message, "error")));
    byId("productImageList").addEventListener("click", (event) => {
      const button = event.target.closest("[data-delete-product-image]");
      if (button) deleteProductImage(button.dataset.deleteProductImage).catch((error) => onStatus(error.message, "error"));
    });
    byId("closeProductDrawerBtn").addEventListener("click", () => byId("productCatalogDrawer").close());
    byId("productDeleteForm").addEventListener("submit", (event) => deleteProduct(event).catch((error) => onStatus(error.message, "error")));
    byId("cancelProductAiBtn").addEventListener("click", () => state.aiAbortController?.abort());
    byId("showProductAiHistoryBtn").addEventListener("click", () => showAiHistory("selling_points").catch((error) => onStatus(error.message, "error")));
    byId("closeProductAiHistoryBtn").addEventListener("click", () => byId("productAiHistoryDialog").close());
    byId("productAiHistoryList").addEventListener("click", (event) => {
      const button = event.target.closest("[data-restore-ai-version]");
      if (button) restoreAiVersion(button.dataset.restoreAiVersion).catch((error) => onStatus(error.message, "error"));
    });
    byId("adoptAllStrategyBtn").addEventListener("click", () => adoptAllStrategyCandidates().catch((error) => onStatus(error.message, "error")));
    byId("regenerateAffectedContentBtn").addEventListener("click", () => previewAndRegenerateAffectedContent().catch((error) => onStatus(error.message, "error")));
    byId("listingValidationSummary").addEventListener("click", (event) => {
      const button = event.target.closest("[data-locate-listing-check]");
      if (!button) return;
      locateWorkbenchTarget(LISTING_CHECK_TARGETS[button.dataset.locateListingCheck] || "workflowPublicationChecks");
    });
    byId("productEditForm").addEventListener("click", (event) => {
      const generate = event.target.closest("[data-generate-ai-types]");
      if (generate) {
        generateListingAi(generate.dataset.generateAiTypes.split(","), generate).catch((error) => onStatus(error.message, "error"));
        return;
      }
      const history = event.target.closest("[data-show-ai-history]");
      if (history) {
        showAiHistory(history.dataset.showAiHistory).catch((error) => onStatus(error.message, "error"));
        return;
      }
      const adopt = event.target.closest("[data-adopt-ai-candidate],[data-adopt-ai-title],[data-adopt-ai-description]");
      if (adopt) {
        const index = Number(adopt.dataset.adoptAiCandidate ?? adopt.dataset.adoptAiTitle ?? adopt.dataset.adoptAiDescription ?? 0);
        adoptAiCandidate(adopt.dataset.aiType, index).catch((error) => onStatus(error.message, "error"));
      }
    });
    byId("clearListingSubtitleBtn").addEventListener("click", () => { byId("listingSubtitle").value = ""; markDirty("listing"); updateListingCounts(); markAiContextStale(); });
    byId("generateImagePlanBtn").addEventListener("click", () => generateImagePlan().catch((error) => onStatus(error.message, "error")));
    byId("generateImageTaskBtn").addEventListener("click", () => runImageGeneration(false).catch((error) => onStatus(error.message, "error")));
    byId("retryImageTaskBtn").addEventListener("click", () => runImageGeneration(true).catch((error) => onStatus(error.message, "error")));
    byId("cancelImageTaskBtn").addEventListener("click", () => cancelImageGeneration().catch((error) => onStatus(error.message, "error")));
    byId("imageGenerationSlots").addEventListener("click", (event) => {
      const retry = event.target.closest("[data-regenerate-image-item]");
      if (retry) {
        runImageGeneration(false, retry.dataset.regenerateImageItem).catch((error) => onStatus(error.message, "error"));
        return;
      }
      const button = event.target.closest("[data-adopt-image-item]");
      if (button) adoptGeneratedImage(button.dataset.adoptImageItem).catch((error) => onStatus(error.message, "error"));
    });
  }

  return Object.freeze({
    initialize,
    load: () => loadCatalog(),
    loadDetail,
    setView,
    state,
    isEditing: () => Boolean(byId("productEditDialog")?.open),
    requestClose: (source = "route-change") => handleRequestClose(source),
  });
}
