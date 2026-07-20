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
    rowPage: 1,
    rowTotalPages: 1,
    catalogPage: 1,
    catalogPageSize: 30,
    catalogTotalPages: 1,
    catalogFiltersLoaded: false,
    productFields: [],
    visibleProductFields: [],
    currentProduct: null,
    imageObjectUrls: new Set(),
  };

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

  function renderIssues(result) {
    const issues = result?.issues || [];
    state.issuePage = Number(result?.page || 1);
    state.issueTotalPages = Math.max(1, Number(result?.totalPages || 1));
    byId("productIssuesPrevBtn").disabled = state.issuePage <= 1;
    byId("productIssuesNextBtn").disabled = state.issuePage >= state.issueTotalPages;
    byId("productIssuesPageStatus").textContent = `第 ${state.issuePage} / ${state.issueTotalPages} 页 · ${Number(result?.total || 0)} 项`;
    byId("productIssueTable").innerHTML = issues.length ? `<table class="product-center-table">
      <thead><tr><th>级别</th><th>行号</th><th>问题</th><th>建议</th></tr></thead>
      <tbody>${issues.map((item) => `<tr>
        <td><span class="product-severity ${esc(item.severity)}">${esc({ blocker: "阻断", reminder: "提醒", information: "信息" }[item.severity])}</span></td>
        <td>${esc(item.sourceRowNumber || "批次")}</td><td><strong>${esc(item.message)}</strong><small>${esc(item.code)}</small></td>
        <td>${esc(item.suggestion || "-")}</td>
      </tr>`).join("")}</tbody></table>` : '<p class="product-empty">未发现数据质量问题。</p>';
  }

  function renderRows(result) {
    const rows = result?.rows || [];
    state.rowPage = Number(result?.page || 1);
    state.rowTotalPages = Math.max(1, Number(result?.totalPages || 1));
    byId("productRowsPrevBtn").disabled = state.rowPage <= 1;
    byId("productRowsNextBtn").disabled = state.rowPage >= state.rowTotalPages;
    byId("productRowsPageStatus").textContent = `第 ${state.rowPage} / ${state.rowTotalPages} 页 · ${Number(result?.total || 0)} 行`;
    byId("productImportRowsTable").innerHTML = rows.length ? `<table class="product-center-table">
      <thead><tr><th>行号</th><th>SKU</th><th>商品名称</th><th>主 SKU</th><th>生命周期</th><th>结果</th></tr></thead>
      <tbody>${rows.map((row) => `<tr>
        <td>${esc(row.sourceRowNumber)}</td><td><strong>${esc(row.sourceSku)}</strong></td>
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
    byId("productBatchMeta").textContent = `${STATUS_LABELS[batch.status] || batch.status} · ${formatDate(batch.createdAt)} · 文件 ${batch.fileHashShort || "-"}`;
    const values = [
      ["数据行", batch.rowCount], ["新增", batch.newCount], ["更新", batch.updatedCount], ["无变化", batch.unchangedCount],
      ["阻断", batch.blockerCount], ["提醒", batch.reminderCount], ["未知字段", batch.unknownFields?.length || 0], ["类目", batch.validationSummary?.categoryCount || 0],
    ];
    byId("productBatchSummary").innerHTML = values.map(([label, value]) => `<div><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join("");
    renderMapping(batch.mapping);
    renderIssues(detail.issues);
    renderRows(detail.rows);
    const confirmArea = byId("productImportConfirmation");
    confirmArea.hidden = batch.status !== "preview_ready";
    byId("productAcknowledgeWarnings").checked = batch.reminderCount === 0;
    byId("productAcknowledgeUnknown").checked = (batch.unknownFields?.length || 0) === 0;
    const applyButton = byId("applyProductImportBtn");
    applyButton.disabled = batch.blockerCount > 0;
    applyButton.textContent = batch.blockerCount > 0 ? "存在阻断问题，无法入库" : "确认正式入库";
    byId("productAppliedState").hidden = batch.status !== "applied";
    byId("revalidateProductImportBtn").hidden = !new Set(["preview_ready", "validation_failed", "apply_failed"]).has(batch.status);
  }

  async function loadDetail(batchId) {
    const data = await responseJson(await authorizedFetch(`/api/product-center/imports/${encodeURIComponent(batchId)}`));
    renderDetail(data.detail);
    setView("upload");
  }

  async function loadIssuePage(page) {
    const batchId = state.activeDetail?.batch?.id;
    if (!batchId) return;
    const data = await responseJson(await authorizedFetch(`/api/product-center/imports/${encodeURIComponent(batchId)}/issues?page=${page}&page_size=100`));
    renderIssues(data);
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
        <td><span class="product-status lifecycle-${esc(String(product.lifecycleStatus || "unknown").toLowerCase())}">${esc(LIFECYCLE_LABELS[product.lifecycleStatus] || product.sourceStatus)}</span><small>${product.operationalEligible ? "运营池" : "仅历史查询"}</small></td>
        <td>${esc(formatDate(product.updatedAt))}<small>${esc(product.sourcePeriod || "-")}</small></td>
        <td><div class="table-actions"><button class="button-tertiary" type="button" data-product-id="${esc(product.id)}">详情</button><button class="button-tertiary" type="button" data-product-edit-id="${esc(product.id)}">编辑</button></div></td>
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
    const visible = new Set(state.visibleProductFields);
    const sections = [...groupedFields(state.productFields.filter((field) => visible.has(field.code))).entries()].map(([label, fields]) => `
      <section><h3>${esc(label)}</h3><div class="product-drawer-grid">${fields.map((field) => `<div>
        <span>${esc(field.label)} · ${product.manualOverrides && Object.hasOwn(product.manualOverrides, field.code) ? "人工维护" : "中台来源"}</span>
        <strong>${esc(displayFieldValue(product.fieldValues?.[field.code]))}</strong>
      </div>`).join("")}</div></section>`).join("");
    byId("productDrawerContent").innerHTML = `${sections}
      <section><h3>产品图片</h3>${renderProductImages(product)}</section>
      <section><h3>来源与记录</h3><div class="product-drawer-grid">
        <div><span>来源文件</span><strong>${esc(product.sourceFilename)}</strong></div>
        <div><span>来源行</span><strong>${esc(product.sourceRowNumber)}</strong></div>
        <div><span>最近导入批次</span><strong>${esc(product.lastBatchId?.slice(0, 8))}</strong></div>
        <div><span>更新时间</span><strong>${esc(formatDate(product.updatedAt))}</strong></div>
        <div><span>运营池</span><strong>${product.operationalEligible ? "可进入" : "仅历史查询"}</strong></div>
        <div><span>人工变更</span><strong>${esc(product.overrideEvents?.length || 0)} 条</strong></div>
      </div></section>`;
    hydrateImages(byId("productDrawerContent"));
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
    byId("productEditFields").innerHTML = editableFields.map((field) => `<label class="field-block">
      <span>${esc(field.label)} <small class="product-field-source">人工维护</small></span>
      <input name="${esc(field.code)}" data-field-type="${esc(field.type)}" value="${esc(product.fieldValues?.[field.code] ?? "")}" ${field.type === "number" || field.type === "integer" ? 'inputmode="decimal"' : ""} />
    </label>`).join("");
    byId("productImageList").innerHTML = renderProductImages(product, { editable: true });
    hydrateImages(byId("productImageList"));
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
    for (const input of byId("productEditFields").querySelectorAll("[name]")) fields[input.name] = input.value.trim() || null;
    await responseJson(await authorizedFetch(`/api/product-center/products/${encodeURIComponent(product.id)}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ fields }),
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

  async function apply({ automatic = false } = {}) {
    const batch = state.activeDetail?.batch;
    if (!batch) return null;
    const button = byId("applyProductImportBtn");
    button.disabled = true;
    try {
      const response = await authorizedFetch(`/api/product-center/imports/${encodeURIComponent(batch.id)}/apply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          acknowledgeWarnings: automatic || byId("productAcknowledgeWarnings").checked,
          acknowledgeUnknownFields: automatic || byId("productAcknowledgeUnknown").checked,
        }),
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

  async function maybeAutoApply(detail) {
    const batch = detail?.batch;
    if (!byId("productAutoApply").checked || !batch || batch.status !== "preview_ready" || batch.blockerCount > 0) return false;
    state.activeDetail = detail;
    return apply({ automatic: true });
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
      await loadHistory();
      const applied = await maybeAutoApply(data.detail);
      if (!applied) {
        const message = data.revalidated ? "原批次已按最新规则重新校验。" : data.reused ? "该文件已存在，已打开原导入批次。" : "产品包校验完成。";
        onStatus(data.detail?.batch?.blockerCount ? `${message} 请先处理阻断问题。` : `${message} 可以确认入库。`, data.detail?.batch?.blockerCount ? "error" : "success");
      }
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
      const applied = await maybeAutoApply(data.detail);
      if (!applied) onStatus(data.detail.batch.blockerCount ? "重新校验完成，仍有真实阻断问题。" : "重新校验完成，可以入库。", data.detail.batch.blockerCount ? "error" : "success");
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
    byId("uploadProductImagesBtn").addEventListener("click", () => uploadProductImages().catch((error) => onStatus(error.message, "error")));
    byId("productImageList").addEventListener("click", (event) => {
      const button = event.target.closest("[data-delete-product-image]");
      if (button) deleteProductImage(button.dataset.deleteProductImage).catch((error) => onStatus(error.message, "error"));
    });
    byId("closeProductDrawerBtn").addEventListener("click", () => byId("productCatalogDrawer").close());
  }

  return Object.freeze({ initialize, load: () => loadCatalog(), loadDetail, setView, state });
}
