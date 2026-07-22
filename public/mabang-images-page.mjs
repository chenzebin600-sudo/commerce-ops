const MODE_LABELS = Object.freeze({ full_initial: "首次全量", missing_only: "补采缺失", retry_failed: "失败重试" });
const STATUS_LABELS = Object.freeze({
  pending: "等待开始", running: "运行中", pause_requested: "正在暂停", paused: "已暂停",
  completed: "已完成", partial_success: "部分成功", failed: "失败",
  downloaded: "已下载", duplicate: "重复图片", missing: "缺失图片", skipped: "已跳过",
});

function esc(value) {
  return String(value ?? "—").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function dateTime(value) {
  return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";
}

function shortId(value) { return value ? String(value).slice(0, 8) : "—"; }

export function createMabangImagesPage({ apiJson, authorizedFetch, setStatus }) {
  const el = (id) => document.getElementById(id);
  const state = { accounts: [], batches: [], selectedBatchId: null, selectedBatch: null, pollTimer: null, loaded: false };

  function statusBadge(status) {
    const tone = ["completed", "downloaded"].includes(status) ? "success"
      : ["failed"].includes(status) ? "danger" : ["partial_success", "missing", "pause_requested"].includes(status) ? "warning" : "neutral";
    return `<span class="status-badge ${tone}">${esc(STATUS_LABELS[status] || status)}</span>`;
  }

  function renderAccounts() {
    const select = el("mabangImageAccount");
    const enabled = state.accounts.filter((account) => account.enabled);
    select.innerHTML = enabled.length
      ? enabled.map((account) => `<option value="${esc(account.id)}">${esc(account.name)} · ${esc(account.usernameMasked || "账号已配置")}</option>`).join("")
      : '<option value="">没有可用账号</option>';
  }

  function renderBatches() {
    const container = el("mabangImageBatchTable");
    if (!state.batches.length) {
      container.innerHTML = '<div class="mabang-image-empty">尚无采集批次。先打开验证浏览器并登录马帮，再开始首次全量采集。</div>';
      return;
    }
    container.innerHTML = `<table class="mabang-data-table mabang-image-table">
      <thead><tr><th>批次</th><th>模式</th><th>状态</th><th>进度</th><th>发现 / 下载 / 失败</th><th>开始时间</th><th></th></tr></thead>
      <tbody>${state.batches.map((batch) => `<tr class="${batch.id === state.selectedBatchId ? "selected" : ""}">
        <td><strong>${esc(shortId(batch.id))}</strong><small>${esc(batch.accountId)}</small></td>
        <td>${esc(MODE_LABELS[batch.mode] || batch.mode)}</td><td>${statusBadge(batch.status)}</td>
        <td>${batch.currentPage || 0} / ${batch.totalPages || "?"}</td>
        <td>${batch.discoveredSkus} / ${batch.downloadedImages + batch.duplicateImages} / ${batch.failedImages}</td>
        <td>${esc(dateTime(batch.startedAt || batch.createdAt))}</td>
        <td><button class="text-action" type="button" data-image-batch="${esc(batch.id)}">查看</button></td>
      </tr>`).join("")}</tbody></table>`;
  }

  function renderProgress(batch) {
    state.selectedBatch = batch || null;
    el("mabangImageBatchTitle").textContent = batch ? `${MODE_LABELS[batch.mode] || batch.mode} · ${STATUS_LABELS[batch.status] || batch.status}` : "暂无任务";
    const values = {
      mabangImageCurrentPage: batch?.currentPage || "—", mabangImageTotalPages: batch?.totalPages || "—",
      mabangImageDiscovered: batch?.discoveredSkus || 0, mabangImageDownloaded: batch?.downloadedImages || 0,
      mabangImageMissing: batch?.missingImages || 0, mabangImageFailed: batch?.failedImages || 0,
      mabangImageDuplicate: batch?.duplicateImages || 0, mabangImageMismatch: batch?.filenameMismatches || 0,
      mabangImageLinked: batch?.linkedProducts || 0,
    };
    for (const [id, value] of Object.entries(values)) el(id).textContent = value;
    const percent = batch?.totalPages ? Math.min(100, Math.round((batch.currentPage / batch.totalPages) * 100)) : batch?.status === "completed" ? 100 : 0;
    el("mabangImageProgressBar").style.width = `${percent}%`;
    el("mabangImagePauseBtn").disabled = !["running"].includes(batch?.status);
    el("mabangImageResumeBtn").disabled = !["paused", "failed", "partial_success"].includes(batch?.status);
    el("mabangImageRetryBtn").disabled = !batch || batch.failedImages < 1;
  }

  async function hydrateAssetImages(root = document) {
    for (const image of root.querySelectorAll("img[data-mabang-asset]")) {
      const assetId = image.dataset.mabangAsset;
      image.removeAttribute("data-mabang-asset");
      try {
        const response = await authorizedFetch(`/api/mabang-images/assets/${encodeURIComponent(assetId)}/content`);
        if (!response.ok) throw new Error();
        const url = URL.createObjectURL(await response.blob());
        image.addEventListener("load", () => URL.revokeObjectURL(url), { once: true });
        image.src = url;
      } catch { image.alt = "图片不可用"; image.classList.add("image-unavailable"); }
    }
  }

  async function loadDiscoveries() {
    if (!state.selectedBatchId) return;
    const status = el("mabangImageDiscoveryStatus").value;
    const query = status ? `?status=${encodeURIComponent(status)}` : "";
    const data = await apiJson(`/api/mabang-images/batches/${encodeURIComponent(state.selectedBatchId)}/discoveries${query}`);
    const rows = data.discoveries || [];
    el("mabangImageDiscoveryHint").textContent = `${rows.length} 条发现记录${status ? ` · ${STATUS_LABELS[status] || status}` : ""}`;
    el("mabangImageDiscoveryTable").innerHTML = rows.length ? `<table class="mabang-data-table mabang-image-table">
      <thead><tr><th>图片</th><th>SKU / 商品</th><th>仓库</th><th>来源</th><th>状态</th><th>失败原因 / 质量问题</th><th>产品</th></tr></thead>
      <tbody>${rows.map((row) => `<tr>
        <td>${row.assetId ? `<button class="mabang-image-thumb-button" type="button" data-image-preview="${esc(row.assetId)}" aria-label="查看 ${esc(row.sourceSku)} 图片"><img data-mabang-asset="${esc(row.assetId)}" alt="${esc(row.sourceSku)}" /></button>` : '<span class="mabang-image-placeholder">无图</span>'}</td>
        <td><strong>${esc(row.sourceSku)}</strong><small>${esc(row.productName || "未提供商品名")}</small></td>
        <td>${esc(row.warehouseName)}</td><td>第 ${row.sourcePage} 页 · ${esc(row.sourceKind)}</td>
        <td>${statusBadge(row.downloadStatus)}${row.qualityIssueCode ? '<span class="quality-flag">SKU 文件名不一致</span>' : ""}</td>
        <td><code>${esc(row.errorCode || row.qualityIssueCode || "—")}</code><small>${esc(row.errorMessage || "")}</small></td>
        <td>${row.assetId ? `<button class="text-action" type="button" data-image-products="${esc(row.assetId)}">查看关联产品</button>` : "—"}</td>
      </tr>`).join("")}</tbody></table>` : '<div class="mabang-image-empty">当前筛选条件下没有记录。</div>';
    await hydrateAssetImages(el("mabangImageDiscoveryTable"));
  }

  async function selectBatch(batchId) {
    state.selectedBatchId = batchId;
    const data = await apiJson(`/api/mabang-images/batches/${encodeURIComponent(batchId)}`);
    renderProgress(data.batch);
    renderBatches();
    await loadDiscoveries();
  }

  function configurePolling() {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
    if (["pending", "running", "pause_requested"].includes(state.selectedBatch?.status)) {
      state.pollTimer = setInterval(() => refresh({ quiet: true }).catch(() => {}), 2000);
    }
  }

  async function refresh({ quiet = false } = {}) {
    const [accountsData, batchesData] = await Promise.all([
      apiJson("/api/mabang-images/accounts"), apiJson("/api/mabang-images/batches?limit=50"),
    ]);
    state.accounts = accountsData.accounts || [];
    state.batches = batchesData.batches || [];
    renderAccounts();
    if (!state.selectedBatchId && state.batches[0]) state.selectedBatchId = state.batches[0].id;
    renderBatches();
    if (state.selectedBatchId) {
      const selected = state.batches.find((batch) => batch.id === state.selectedBatchId);
      if (selected) renderProgress(selected);
      await loadDiscoveries();
    } else renderProgress(null);
    configurePolling();
    state.loaded = true;
    if (!quiet) setStatus("马帮 SKU 图片任务已刷新。", "success");
  }

  async function start(mode) {
    const accountId = el("mabangImageAccount").value;
    if (!accountId) throw new Error("请先选择可用的马帮账号。");
    if (mode === "full_initial" && !window.confirm("确认开始首次全量采集？该任务可能运行较长时间，但可以暂停和恢复。")) return;
    const body = { accountId, mode };
    if (mode === "retry_failed") {
      if (!state.selectedBatch) throw new Error("请先选择存在失败图片的批次。");
      body.sourceBatchId = state.selectedBatch.id;
    }
    const data = await apiJson("/api/mabang-images/batches", { method: "POST", body });
    state.selectedBatchId = data.batch.id;
    setStatus("采集任务已进入后台队列。", "success");
    await refresh({ quiet: true });
  }

  async function openProducts(assetId) {
    const data = await apiJson(`/api/mabang-images/assets/${encodeURIComponent(assetId)}/products`);
    const content = el("mabangImageProductsContent");
    content.innerHTML = `<div class="mabang-image-asset-summary">
      <img data-mabang-asset="${esc(assetId)}" alt="马帮 SKU 图片" />
      <div><strong>${esc(data.asset.originalFilename)}</strong><span>${data.asset.width} × ${data.asset.height} · ${Math.round(data.asset.fileSize / 1024)} KB</span><code>${esc(data.asset.sha256.slice(0, 16))}…</code></div>
    </div>${data.products.length ? `<table class="mabang-data-table"><thead><tr><th>国家</th><th>SKU / 产品</th><th>素材角色</th><th>关联状态</th><th></th></tr></thead><tbody>
      ${data.products.map((link) => `<tr><td>${esc(link.countryCode || "—")}</td><td><strong>${esc(link.sourceSku)}</strong><small>${esc(link.productName)}</small></td><td>${esc(link.mediaRole === "suggested_primary" ? "建议主图" : link.mediaRole === "primary" ? "正式主图" : "图库")}</td><td>${esc(link.mappingStatus)}</td><td>${link.mediaRole !== "primary" ? `<button class="button-secondary" type="button" data-confirm-primary="${esc(link.id)}">确认设为产品主图</button>` : "已确认"}</td></tr>`).join("")}
    </tbody></table>` : '<div class="mabang-image-empty">产品中心暂未找到相同 SKU 记录。</div>'}`;
    el("mabangImageProductsDialog").showModal();
    await hydrateAssetImages(content);
  }

  function bind() {
    el("mabangImageFullBtn").addEventListener("click", () => start("full_initial").catch((error) => setStatus(error.message, "error")));
    el("mabangImageMissingBtn").addEventListener("click", () => start("missing_only").catch((error) => setStatus(error.message, "error")));
    el("mabangImageRetryBtn").addEventListener("click", () => start("retry_failed").catch((error) => setStatus(error.message, "error")));
    el("mabangImageRefreshBtn").addEventListener("click", () => refresh().catch((error) => setStatus(error.message, "error")));
    el("mabangImageDiscoveryStatus").addEventListener("change", () => loadDiscoveries().catch((error) => setStatus(error.message, "error")));
    el("mabangImagePauseBtn").addEventListener("click", async () => {
      try { await apiJson(`/api/mabang-images/batches/${encodeURIComponent(state.selectedBatchId)}/pause`, { method: "POST", body: {} }); await refresh({ quiet: true }); }
      catch (error) { setStatus(error.message, "error"); }
    });
    el("mabangImageResumeBtn").addEventListener("click", async () => {
      try { await apiJson(`/api/mabang-images/batches/${encodeURIComponent(state.selectedBatchId)}/resume`, { method: "POST", body: {} }); await refresh({ quiet: true }); }
      catch (error) { setStatus(error.message, "error"); }
    });
    el("mabangImageBatchTable").addEventListener("click", (event) => {
      const button = event.target.closest("[data-image-batch]");
      if (button) selectBatch(button.dataset.imageBatch).catch((error) => setStatus(error.message, "error"));
    });
    el("mabangImageDiscoveryTable").addEventListener("click", (event) => {
      const products = event.target.closest("[data-image-products]");
      if (products) openProducts(products.dataset.imageProducts).catch((error) => setStatus(error.message, "error"));
      const preview = event.target.closest("[data-image-preview]");
      if (preview) openProducts(preview.dataset.imagePreview).catch((error) => setStatus(error.message, "error"));
    });
    el("mabangImageProductsContent").addEventListener("click", async (event) => {
      const button = event.target.closest("[data-confirm-primary]");
      if (!button || !window.confirm("确认将这张马帮来源图片设为该产品的正式主图？")) return;
      try {
        button.disabled = true;
        await apiJson(`/api/mabang-images/links/${encodeURIComponent(button.dataset.confirmPrimary)}/confirm-primary`, { method: "POST", body: {} });
        setStatus("已确认产品主图。", "success");
        el("mabangImageProductsDialog").close();
        await loadDiscoveries();
      } catch (error) { setStatus(error.message, "error"); button.disabled = false; }
    });
  }

  bind();
  return Object.freeze({ load: () => state.loaded ? refresh({ quiet: true }) : refresh({ quiet: true }) });
}
