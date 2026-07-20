const OUTCOME_LABELS = Object.freeze({ new: "新增", updated: "更新", unchanged: "无变化", conflict: "冲突", exception: "异常" });
const STATUS_LABELS = Object.freeze({
  uploaded: "已上传", validating: "校验中", preview_ready: "待确认", applying: "入库中",
  applied: "已入库", validation_failed: "校验失败", apply_failed: "入库失败", cancelled: "已取消",
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

async function responseJson(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || `请求失败：${response.status}`);
  return data;
}

export function createProductCenterPage({ authorizedFetch, documentObject = document, onStatus = () => {} } = {}) {
  const byId = (id) => documentObject.getElementById(id);
  const state = {
    activeView: "upload",
    activeDetail: null,
    loaded: false,
    issuePage: 1,
    issueTotalPages: 1,
    rowPage: 1,
    rowTotalPages: 1,
  };

  function setView(view) {
    state.activeView = view === "history" ? "history" : "upload";
    documentObject.querySelectorAll("[data-product-view]").forEach((button) => {
      const active = button.dataset.productView === state.activeView;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    });
    byId("productImportWorkspace").hidden = state.activeView !== "upload";
    byId("productImportHistory").hidden = state.activeView !== "history";
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
        <td>${esc(row.normalizedPayload?.lifecycle_status)}</td>
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
    const apply = byId("applyProductImportBtn");
    apply.disabled = batch.blockerCount > 0;
    apply.textContent = batch.blockerCount > 0 ? "存在阻断问题，无法入库" : "确认正式入库";
    byId("productAppliedState").hidden = batch.status !== "applied";
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

  async function upload(event) {
    event.preventDefault();
    const file = byId("productPackageFile").files?.[0];
    if (!file) return onStatus("请选择产品包 Excel。", "error");
    if (!file.name.toLowerCase().endsWith(".xlsx")) return onStatus("仅支持 .xlsx 产品包。", "error");
    const button = byId("uploadProductPackageBtn");
    button.disabled = true;
    button.textContent = "正在校验…";
    onStatus("正在安全读取产品包并生成校验报告…", "loading");
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
      onStatus(data.reused ? "该文件已存在，已打开原导入批次。" : "产品包校验完成，请检查后确认入库。", "success");
    } catch (error) {
      onStatus(error.message, "error");
    } finally {
      button.disabled = false;
      button.textContent = "上传并校验";
    }
  }

  async function apply() {
    const batch = state.activeDetail?.batch;
    if (!batch) return;
    const button = byId("applyProductImportBtn");
    button.disabled = true;
    try {
      const response = await authorizedFetch(`/api/product-center/imports/${encodeURIComponent(batch.id)}/apply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          acknowledgeWarnings: byId("productAcknowledgeWarnings").checked,
          acknowledgeUnknownFields: byId("productAcknowledgeUnknown").checked,
        }),
      });
      await responseJson(response);
      await loadDetail(batch.id);
      onStatus("产品包已正式入库，来源事实和生命周期记录已保存。", "success");
    } catch (error) {
      onStatus(error.message, "error");
      button.disabled = false;
    }
  }

  function initialize() {
    byId("productPackageUploadForm").addEventListener("submit", upload);
    byId("applyProductImportBtn").addEventListener("click", apply);
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
  }

  return Object.freeze({ initialize, load: () => loadHistory(), loadDetail, setView, state });
}
