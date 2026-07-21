const OUTCOME_LABELS = Object.freeze({ new: "新增", updated: "更新", unchanged: "无变化", conflict: "冲突", exception: "异常" });
const STATUS_LABELS = Object.freeze({
  uploaded: "已上传", validating: "校验中", preview_ready: "待入库", applying: "入库中",
  applied: "已入库", validation_failed: "校验失败", apply_failed: "入库失败", cancelled: "已取消",
});
const LIFECYCLE_LABELS = Object.freeze({
  ACTIVE: "正常销售", NEW: "待开发", CLEARANCE: "清仓商品", DISCONTINUED: "灭款", ARCHIVED: "已归档",
});

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
    aiAbortController: null,
    imageObjectUrls: new Set(),
  };

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

  function renderEditDialog(product) {
    state.currentProduct = product;
    byId("productEditTitle").textContent = `编辑 ${product.sku}`;
    const editableFields = (product.fields || []).filter((field) => field.editable);
    byId("productEditFields").innerHTML = editableFields.map((field) => {
      const hasOverride = product.manualOverrides && Object.hasOwn(product.manualOverrides, field.code);
      const current = product.fieldValues?.[field.code] ?? "";
      return `<div class="product-override-field"><label class="field-block">
        <span>${esc(field.label)} <small class="product-field-source">${hasOverride ? "人工维护" : "中台来源"}</small></span>
        <input name="${esc(field.code)}" data-field-type="${esc(field.type)}" data-initial-value="${esc(current)}" value="${esc(current)}" ${field.type === "number" || field.type === "integer" ? 'inputmode="decimal"' : ""} />
        <small>中台原值：${esc(displayFieldValue(product.sourceFieldValues?.[field.code]))}</small>
      </label>${hasOverride ? `<label class="product-clear-override"><input type="checkbox" data-clear-override="${esc(field.code)}" /> 清除人工覆盖，恢复中台值</label>` : ""}</div>`;
    }).join("");
    byId("productImageList").innerHTML = renderProductImages(product, { editable: true });
    hydrateImages(byId("productImageList"));
    byId("productAiCountry").value = product.country || "";
    state.aiGenerated = product.confirmedAiContent ? {
      outputContent: product.confirmedAiContent.outputContent,
      inputContext: product.confirmedAiContent.inputContext,
      provider: product.confirmedAiContent.provider,
      model: product.confirmedAiContent.model,
      promptVersion: product.confirmedAiContent.promptVersion,
    } : null;
    renderAiConfiguration();
    renderAiEditor(state.aiGenerated?.outputContent || null);
    switchEditTab("info");
  }

  async function openProductEditor(id = state.currentProduct?.id) {
    if (!id) return;
    renderEditDialog(await fetchProduct(id));
    const dialog = byId("productEditDialog");
    if (!dialog.open) dialog.showModal();
  }

  async function saveProductEdit(event) {
    event.preventDefault();
    const product = state.currentProduct;
    if (!product) return;
    const fields = {};
    const clearFields = [...byId("productEditFields").querySelectorAll("[data-clear-override]:checked")].map((input) => input.dataset.clearOverride);
    for (const input of byId("productEditFields").querySelectorAll("[name]")) {
      if (clearFields.includes(input.name)) continue;
      if (input.value !== input.dataset.initialValue) fields[input.name] = input.value.trim() || null;
    }
    if (!Object.keys(fields).length && !clearFields.length) return onStatus("没有需要保存的产品信息修改。", "error");
    await responseJson(await authorizedFetch(`/api/product-center/products/${encodeURIComponent(product.id)}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ fields, clearFields }),
    }));
    byId("productEditDialog").close();
    await openProductDetail(product.id);
    await loadCatalog();
    onStatus("产品信息已更新，人工修改已留痕。", "success");
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
      renderEditDialog(await fetchProduct(product.id));
      byId("productImageFiles").value = "";
      await loadCatalog();
      onStatus("产品图片已上传。", "success");
    } finally {
      button.disabled = false;
    }
  }

  async function deleteProductImage(imageId) {
    const product = state.currentProduct;
    if (!product) return;
    await responseJson(await authorizedFetch(`/api/product-center/products/${encodeURIComponent(product.id)}/images/${encodeURIComponent(imageId)}`, { method: "DELETE" }));
    renderEditDialog(await fetchProduct(product.id));
    await loadCatalog();
    onStatus("图片已从产品展示中移除。", "success");
  }

  function switchEditTab(tab) {
    const selected = new Set(["info", "images", "ai"]).has(tab) ? tab : "info";
    documentObject.querySelectorAll("[data-product-edit-tab]").forEach((button) => button.classList.toggle("active", button.dataset.productEditTab === selected));
    byId("productEditInfoPanel").hidden = selected !== "info";
    byId("productEditImagesPanel").hidden = selected !== "images";
    byId("productEditAiPanel").hidden = selected !== "ai";
    byId("saveProductEditBtn").hidden = selected !== "info";
  }

  function renderAiConfiguration() {
    const configured = Boolean(state.aiStatus.configured);
    byId("productAiConfigurationNotice").className = `product-ai-notice ${configured ? "configured" : "unconfigured"}`;
    byId("productAiConfigurationNotice").textContent = configured
      ? `DeepSeek 已配置 · ${state.aiStatus.model || "deepseek-v4"} · ${state.aiStatus.promptVersion || "-"}`
      : "尚未配置 DeepSeek API Key，请联系管理员完成配置。";
    byId("generateProductAiBtn").disabled = !configured || !can("product.ai.generate");
    byId("showProductAiHistoryBtn").hidden = !can("product.ai.view_history");
  }

  function aiListEditor(title, listName, items, keys) {
    return `<section><h3>${esc(title)}</h3><div class="product-ai-items">${(items || []).map((item, index) => `<div class="product-ai-item">
      ${keys.map(([key, label]) => `<label><span>${esc(label)}</span><textarea rows="2" data-ai-list="${esc(listName)}" data-ai-index="${index}" data-ai-key="${esc(key)}">${esc(item?.[key] || "")}</textarea></label>`).join("")}
      <button class="button-tertiary" type="button" data-copy-ai-item="${esc(listName)}" data-copy-ai-index="${index}">复制本条</button>
    </div>`).join("")}</div></section>`;
  }

  function renderAiEditor(content) {
    const root = byId("productAiResult");
    const actions = byId("productAiSaveActions");
    if (!content) {
      root.innerHTML = '<p class="product-empty">尚未生成内容。生成结果只保存在当前页面，点击保存草稿或确认采用后才会写入数据库。</p>';
      actions.hidden = true;
      byId("copyProductAiBtn").disabled = true;
      return;
    }
    root.innerHTML = `<label class="field-block"><span>产品一句话总结</span><textarea id="productAiSummary" rows="2">${esc(content.product_summary)}</textarea></label>
      <div class="product-ai-simple-lists">
        <label class="field-block"><span>目标用户（每行一项）</span><textarea id="productAiTargetUsersResult" rows="4">${esc((content.target_users || []).join("\n"))}</textarea></label>
        <label class="field-block"><span>用户痛点（每行一项）</span><textarea id="productAiPainPointsResult" rows="4">${esc((content.user_pain_points || []).join("\n"))}</textarea></label>
      </div>
      ${aiListEditor("核心卖点", "selling_points", content.selling_points, [["title", "标题"], ["description", "说明"], ["source_field", "事实依据"]])}
      ${aiListEditor("使用场景", "usage_scenarios", content.usage_scenarios, [["scene", "场景"], ["user", "适用人群"], ["benefit", "场景价值"]])}
      ${aiListEditor("特征与收益", "feature_benefit_map", content.feature_benefit_map, [["feature", "产品特征"], ["benefit", "用户收益"]])}
      <label class="field-block"><span>风险与待确认项（每行一项）</span><textarea id="productAiRiskNotes" rows="4">${esc((content.risk_notes || []).join("\n"))}</textarea></label>`;
    actions.hidden = false;
    byId("confirmProductAiBtn").hidden = !can("product.ai.confirm");
    byId("saveProductAiDraftBtn").hidden = !can("product.ai.generate");
    byId("copyProductAiBtn").disabled = false;
    byId("generateProductAiBtn").textContent = "重新生成";
  }

  function lines(id) {
    return byId(id).value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  }

  function collectAiContent() {
    const grouped = { selling_points: [], usage_scenarios: [], feature_benefit_map: [] };
    for (const input of byId("productAiResult").querySelectorAll("[data-ai-list]")) {
      const list = grouped[input.dataset.aiList];
      const index = Number(input.dataset.aiIndex);
      list[index] ||= {};
      list[index][input.dataset.aiKey] = input.value.trim();
    }
    return {
      product_summary: byId("productAiSummary").value.trim(),
      target_users: lines("productAiTargetUsersResult"),
      user_pain_points: lines("productAiPainPointsResult"),
      selling_points: grouped.selling_points,
      usage_scenarios: grouped.usage_scenarios,
      feature_benefit_map: grouped.feature_benefit_map,
      risk_notes: lines("productAiRiskNotes"),
    };
  }

  function aiRequestOptions() {
    return {
      targetPlatform: byId("productAiPlatform").value,
      targetCountry: byId("productAiCountry").value.trim(),
      outputLanguage: byId("productAiLanguage").value,
      targetUsers: byId("productAiTargetUsers").value.trim(),
      productPositioning: byId("productAiPositioning").value.trim(),
      contentStyle: byId("productAiStyle").value.trim(),
      sellingPointCount: Number(byId("productAiSellingPointCount").value),
      scenarioCount: Number(byId("productAiScenarioCount").value),
      specialRequirements: byId("productAiSpecialRequirements").value.trim(),
      forbiddenContent: byId("productAiForbiddenContent").value.trim(),
    };
  }

  async function generateProductAi() {
    if (!state.currentProduct || !state.aiStatus.configured) return;
    const button = byId("generateProductAiBtn");
    const previous = state.aiGenerated;
    state.aiAbortController = new AbortController();
    button.disabled = true;
    button.textContent = "正在生成…";
    byId("cancelProductAiBtn").hidden = false;
    try {
      const data = await responseJson(await authorizedFetch(`/api/product-center/products/${encodeURIComponent(state.currentProduct.id)}/ai/generate`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(aiRequestOptions()), signal: state.aiAbortController.signal,
      }));
      state.aiGenerated = data.result;
      renderAiEditor(data.result.outputContent);
      onStatus("AI 内容已生成，尚未保存。", "success");
    } catch (error) {
      state.aiGenerated = previous;
      if (error?.name !== "AbortError") onStatus(error.message, "error");
    } finally {
      state.aiAbortController = null;
      button.disabled = !state.aiStatus.configured || !can("product.ai.generate");
      button.textContent = state.aiGenerated ? "重新生成" : "生成内容";
      byId("cancelProductAiBtn").hidden = true;
    }
  }

  async function saveProductAi(status) {
    const product = state.currentProduct;
    if (!product || !state.aiGenerated) return;
    const outputContent = collectAiContent();
    const data = await responseJson(await authorizedFetch(`/api/product-center/products/${encodeURIComponent(product.id)}/ai/contents`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        ...state.aiGenerated, outputContent, status,
      }),
    }));
    state.aiGenerated = { ...state.aiGenerated, outputContent };
    if (status === "confirmed") state.currentProduct.confirmedAiContent = data.content;
    onStatus(status === "confirmed" ? "AI 内容已确认采用。" : "AI 内容草稿已保存。", "success");
  }

  function aiContentText(content) {
    return [content.product_summary,
      "\n目标用户\n" + (content.target_users || []).join("\n"),
      "\n用户痛点\n" + (content.user_pain_points || []).join("\n"),
      "\n核心卖点\n" + (content.selling_points || []).map((item) => `${item.title}：${item.description}（依据：${item.source_field}）`).join("\n"),
      "\n使用场景\n" + (content.usage_scenarios || []).map((item) => `${item.scene}：${item.user}，${item.benefit}`).join("\n"),
      "\n风险提示\n" + (content.risk_notes || []).join("\n")].join("\n");
  }

  async function copyText(value) {
    const clipboard = documentObject.defaultView?.navigator?.clipboard;
    if (clipboard?.writeText) await clipboard.writeText(value);
    else {
      const textarea = documentObject.createElement("textarea");
      textarea.value = value;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      documentObject.body.append(textarea);
      textarea.select();
      documentObject.execCommand("copy");
      textarea.remove();
    }
    onStatus("内容已复制。", "success");
  }

  async function showAiHistory() {
    const product = state.currentProduct;
    if (!product) return;
    const data = await responseJson(await authorizedFetch(`/api/product-center/products/${encodeURIComponent(product.id)}/ai/contents?page=1&page_size=100`));
    byId("productAiHistoryList").innerHTML = data.contents?.length ? data.contents.map((content) => `<article>
      <header><strong>版本 ${esc(content.version)}</strong><span class="product-status ${esc(content.status)}">${esc({ draft: "草稿", confirmed: "已采用", archived: "历史" }[content.status] || content.status)}</span></header>
      <p>${esc(content.outputContent?.product_summary)}</p><small>${esc(content.model)} · ${esc(content.promptVersion)} · ${esc(formatDate(content.createdAt))}</small>
      ${content.status === "draft" && can("product.ai.confirm") ? `<button type="button" data-confirm-ai-version="${esc(content.id)}">确认采用此版本</button>` : ""}
    </article>`).join("") : '<p class="product-empty">暂无 AI 内容历史。</p>';
    byId("productAiHistoryDialog").showModal();
  }

  async function confirmAiVersion(contentId) {
    const product = state.currentProduct;
    const data = await responseJson(await authorizedFetch(`/api/product-center/products/${encodeURIComponent(product.id)}/ai/contents/${encodeURIComponent(contentId)}/confirm`, { method: "POST" }));
    state.currentProduct.confirmedAiContent = data.content;
    await showAiHistory();
    onStatus("历史草稿已确认采用。", "success");
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
    byId("productEditForm").addEventListener("submit", (event) => saveProductEdit(event).catch((error) => onStatus(error.message, "error")));
    documentObject.querySelectorAll("[data-product-edit-tab]").forEach((button) => button.addEventListener("click", () => switchEditTab(button.dataset.productEditTab)));
    byId("uploadProductImagesBtn").addEventListener("click", () => uploadProductImages().catch((error) => onStatus(error.message, "error")));
    byId("productImageList").addEventListener("click", (event) => {
      const button = event.target.closest("[data-delete-product-image]");
      if (button) deleteProductImage(button.dataset.deleteProductImage).catch((error) => onStatus(error.message, "error"));
    });
    byId("closeProductDrawerBtn").addEventListener("click", () => byId("productCatalogDrawer").close());
    byId("productDeleteForm").addEventListener("submit", (event) => deleteProduct(event).catch((error) => onStatus(error.message, "error")));
    byId("generateProductAiBtn").addEventListener("click", () => generateProductAi().catch((error) => onStatus(error.message, "error")));
    byId("cancelProductAiBtn").addEventListener("click", () => state.aiAbortController?.abort());
    byId("saveProductAiDraftBtn").addEventListener("click", () => saveProductAi("draft").catch((error) => onStatus(error.message, "error")));
    byId("confirmProductAiBtn").addEventListener("click", () => saveProductAi("confirmed").catch((error) => onStatus(error.message, "error")));
    byId("copyProductAiBtn").addEventListener("click", () => copyText(aiContentText(collectAiContent())).catch((error) => onStatus(error.message, "error")));
    byId("showProductAiHistoryBtn").addEventListener("click", () => showAiHistory().catch((error) => onStatus(error.message, "error")));
    byId("closeProductAiHistoryBtn").addEventListener("click", () => byId("productAiHistoryDialog").close());
    byId("productAiHistoryList").addEventListener("click", (event) => {
      const button = event.target.closest("[data-confirm-ai-version]");
      if (button) confirmAiVersion(button.dataset.confirmAiVersion).catch((error) => onStatus(error.message, "error"));
    });
    byId("productAiResult").addEventListener("click", (event) => {
      const button = event.target.closest("[data-copy-ai-item]");
      if (!button) return;
      const content = collectAiContent();
      const item = content[button.dataset.copyAiItem]?.[Number(button.dataset.copyAiIndex)];
      copyText(Object.values(item || {}).join("\n")).catch((error) => onStatus(error.message, "error"));
    });
  }

  return Object.freeze({ initialize, load: () => loadCatalog(), loadDetail, setView, state });
}
