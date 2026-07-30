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
  const state = {
    accounts: [],
    batches: [],
    syncRuns: [],
    selectedSyncRunId: null,
    selectedSyncRun: null,
    selectedBatchId: null,
    selectedBatch: null,
    pollTimer: null,
    loaded: false,
  };

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
      container.innerHTML = '<div class="mabang-image-empty">尚无采集批次。选择已配置账号后，系统会在后台登录马帮并开始采集。</div>';
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
    state.selectedSyncRun = null;
    state.selectedBatch = batch || null;
    el("mabangImageBatchTitle").textContent = batch ? `${MODE_LABELS[batch.mode] || batch.mode} · ${STATUS_LABELS[batch.status] || batch.status}` : "暂无任务";
    const values = {
      mabangImageCurrentPage: batch?.currentPage || "—", mabangImageTotalPages: batch?.totalPages || "—",
      mabangImageDiscovered: batch?.discoveredSkus || 0, mabangImageDownloaded: batch?.downloadedImages || 0,
      mabangImageMissing: batch?.missingImages || 0, mabangImageFailed: batch?.failedImages || 0,
      mabangImageDuplicate: batch?.duplicateImages || 0, mabangImageMismatch: batch?.filenameMismatches || 0,
      mabangImageTotalCandidates: (batch?.downloadedImages || 0) + (batch?.duplicateImages || 0)
        + (batch?.missingImages || 0) + (batch?.failedImages || 0),
      mabangImageLinked: batch?.linkedProducts || 0,
    };
    for (const [id, value] of Object.entries(values)) el(id).textContent = value;
    const percent = batch?.totalPages ? Math.min(100, Math.round((batch.currentPage / batch.totalPages) * 100)) : batch?.status === "completed" ? 100 : 0;
    el("mabangImageProgressBar").style.width = `${percent}%`;
    const batchError = el("mabangImageBatchError");
    batchError.replaceChildren();
    if (batch?.lastErrorCode) {
      const code = document.createElement("code");
      code.textContent = batch.lastErrorCode;
      const message = document.createElement("span");
      message.textContent = batch.lastErrorMessage || "采集任务失败。";
      batchError.append(code, message);
      batchError.hidden = false;
    } else {
      batchError.hidden = true;
    }
    el("mabangImagePauseBtn").disabled = !["running"].includes(batch?.status);
    el("mabangImageResumeBtn").disabled = !["paused", "failed", "partial_success"].includes(batch?.status);
    el("mabangImageRetryBtn").disabled = !batch || batch.failedImages < 1;
  }

  function renderSyncProgress(syncRun) {
    state.selectedSyncRun = syncRun || null;
    state.selectedBatch = null;
    el("mabangImageBatchTitle").textContent = syncRun
      ? `全量同步 · ${STATUS_LABELS[syncRun.status] || syncRun.status} · ${syncRun.segmentCount} 个安全批次`
      : "暂无任务";
    const values = {
      mabangImageCurrentPage: syncRun ? Math.max(0, syncRun.nextPage - 1) : "—",
      mabangImageTotalPages: syncRun?.totalPages || "—",
      mabangImageDiscovered: syncRun?.discoveredSkus || 0,
      mabangImageDownloaded: (syncRun?.downloadedImages || 0) + (syncRun?.duplicateImages || 0),
      mabangImageMissing: syncRun?.unmatchedSkus || 0,
      mabangImageFailed: syncRun?.failedImages || 0,
      mabangImageDuplicate: syncRun?.duplicateImages || 0,
      mabangImageTotalCandidates: syncRun?.discoveredImages || 0,
      mabangImageMismatch: 0,
      mabangImageLinked: syncRun?.matchedSkus || 0,
    };
    for (const [id, value] of Object.entries(values)) el(id).textContent = value;
    const percent = syncRun?.totalPages
      ? Math.min(100, Math.round((Math.max(0, syncRun.nextPage - 1) / syncRun.totalPages) * 100))
      : syncRun?.status === "completed" ? 100 : 0;
    el("mabangImageProgressBar").style.width = `${percent}%`;
    const batchError = el("mabangImageBatchError");
    batchError.replaceChildren();
    if (syncRun?.lastErrorCode) {
      const code = document.createElement("code");
      code.textContent = syncRun.lastErrorCode;
      const message = document.createElement("span");
      message.textContent = syncRun.lastErrorMessage || "全量同步失败。";
      batchError.append(code, message);
      batchError.hidden = false;
    } else batchError.hidden = true;
    el("mabangImagePauseBtn").disabled = true;
    el("mabangImageResumeBtn").disabled = !["failed", "partial_success"].includes(syncRun?.status);
    el("mabangImageRetryBtn").disabled = true;
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

  function renderDiscoveryImages(row) {
    const images = (row.images || []).filter((image) => image.assetId);
    if (!images.length && row.assetId) images.push({ assetId: row.assetId, imageIndex: 0 });
    if (!images.length) return '<span class="mabang-image-placeholder">无图</span>';
    return `<div class="mabang-discovery-thumbs">${images.map((image) => `
      <button class="mabang-image-thumb-button" type="button" data-image-preview="${esc(image.assetId)}"
        aria-label="查看 ${esc(row.sourceSku)} 第 ${Number(image.imageIndex || 0) + 1} 张图片">
        <img data-mabang-asset="${esc(image.assetId)}" alt="${esc(row.sourceSku)}" />
      </button>`).join("")}</div>`;
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
        <td>${renderDiscoveryImages(row)}</td>
        <td><strong>${esc(row.sourceSku)}</strong><small>${esc(row.productName || "未提供商品名")}</small></td>
        <td>${esc(row.warehouseName)}</td><td>第 ${row.sourcePage} 页 · ${esc(row.sourceKind)}</td>
        <td>${statusBadge(row.downloadStatus)}${row.qualityIssueCode ? '<span class="quality-flag">SKU 文件名不一致</span>' : ""}</td>
        <td><code>${esc(row.errorCode || row.qualityIssueCode || "—")}</code><small>${esc(row.errorMessage || "")}</small></td>
        <td>${(row.images || []).some((image) => image.assetId) || row.assetId ? `<button class="text-action" type="button" data-image-products="${esc((row.images || []).find((image) => image.assetId)?.assetId || row.assetId)}">查看关联产品</button>` : "—"}</td>
      </tr>`).join("")}</tbody></table>` : '<div class="mabang-image-empty">当前筛选条件下没有记录。</div>';
    await hydrateAssetImages(el("mabangImageDiscoveryTable"));
  }

  async function selectBatch(batchId) {
    state.selectedSyncRunId = null;
    state.selectedBatchId = batchId;
    const data = await apiJson(`/api/mabang-images/batches/${encodeURIComponent(batchId)}`);
    renderProgress(data.batch);
    renderBatches();
    await loadDiscoveries();
  }

  function configurePolling() {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
    if (["pending", "running", "pause_requested"].includes(state.selectedBatch?.status)
      || ["pending", "running"].includes(state.selectedSyncRun?.status)) {
      state.pollTimer = setInterval(() => refresh({ quiet: true }).catch(() => {}), 2000);
    }
  }

  async function refresh({ quiet = false } = {}) {
    const [accountsData, batchesData, syncRunsData] = await Promise.all([
      apiJson("/api/mabang-images/accounts"),
      apiJson("/api/mabang-images/batches?limit=50"),
      apiJson("/api/mabang-images/sync-runs?limit=20"),
    ]);
    state.accounts = accountsData.accounts || [];
    state.batches = batchesData.batches || [];
    state.syncRuns = syncRunsData.syncRuns || [];
    renderAccounts();
    if (!state.selectedSyncRunId && !state.selectedBatchId && state.syncRuns[0]) {
      state.selectedSyncRunId = state.syncRuns[0].id;
    }
    if (!state.selectedBatchId && state.batches[0]) state.selectedBatchId = state.batches[0].id;
    renderBatches();
    if (state.selectedSyncRunId) {
      const selected = state.syncRuns.find((run) => run.id === state.selectedSyncRunId);
      if (selected) renderSyncProgress(selected);
    } else if (state.selectedBatchId) {
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
    if (mode === "full_initial" && !window.confirm("确认同步全部 SKU 图片？系统会按安全批次运行，失败后可从最后完成页继续。")) return;
    if (mode === "full_initial") {
      const data = await apiJson("/api/mabang-images/sync-runs", { method: "POST", body: { accountId } });
      state.selectedSyncRunId = data.syncRun.id;
      state.selectedBatchId = null;
      setStatus("全量同步已启动，系统会遍历全部 SKU，并按每批最多 100 个唯一 SKU 自动分段。", "success");
      await refresh({ quiet: true });
      return;
    }
    const body = { accountId, mode };
    if (mode === "retry_failed") {
      if (!state.selectedBatch) throw new Error("请先选择存在失败图片的批次。");
      body.sourceBatchId = state.selectedBatch.id;
    }
    const data = await apiJson("/api/mabang-images/batches", { method: "POST", body });
    state.selectedSyncRunId = null;
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
      ${data.products.map((link) => `<tr><td>${esc(link.countryCode || "—")}</td><td><strong>${esc(link.sourceSku)}</strong><small>${esc(link.productName)}</small></td><td>参考图库</td><td>${esc(link.mappingStatus)}</td><td>
        ${link.mappingStatus === "confirmed" ? "已加入产品图片" : `<button class="button-secondary" type="button" data-confirm-gallery="${esc(link.id)}">加入产品图片</button>`}
        ${link.mappingStatus !== "rejected" ? `<button class="button-tertiary" type="button" data-reject-link="${esc(link.id)}">移除关联</button>` : "已移除"}
      </td></tr>`).join("")}
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
      try {
        const url = state.selectedSyncRun
          ? `/api/mabang-images/sync-runs/${encodeURIComponent(state.selectedSyncRun.id)}/resume`
          : `/api/mabang-images/batches/${encodeURIComponent(state.selectedBatchId)}/resume`;
        await apiJson(url, { method: "POST", body: {} });
        await refresh({ quiet: true });
      }
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
      const confirm = event.target.closest("[data-confirm-gallery]");
      const reject = event.target.closest("[data-reject-link]");
      if (!confirm && !reject) return;
      if (reject && !window.confirm("确认移除这张马帮参考图片关联？图片资产不会被删除。")) return;
      const button = confirm || reject;
      try {
        button.disabled = true;
        const action = confirm ? "confirm-gallery" : "reject";
        const linkId = confirm ? confirm.dataset.confirmGallery : reject.dataset.rejectLink;
        await apiJson(`/api/mabang-images/links/${encodeURIComponent(linkId)}/${action}`, { method: "POST", body: {} });
        setStatus(confirm ? "已加入产品图片。" : "参考图片关联已移除。", "success");
        el("mabangImageProductsDialog").close();
        await loadDiscoveries();
      } catch (error) { setStatus(error.message, "error"); button.disabled = false; }
    });
  }

  bind();
  return Object.freeze({ load: () => state.loaded ? refresh({ quiet: true }) : refresh({ quiet: true }) });
}
