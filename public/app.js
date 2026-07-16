import {
  clearSessionToken,
  createAuthorizedFetch,
  readSessionToken,
  saveSessionToken,
} from "./auth-client.mjs";
import { createAdFrameBridge } from "./ad-frame-bridge.mjs";
import { createAuditPage } from "./audit-page.mjs";
import { createExcelHtmlRenderer } from "/excel-cell-policy.mjs";

let currentReport = null;
let currentMabangTask = null;
let currentMabangView = "orders";
let mabangResultRequestSeq = 0;
let lastRunMode = "analyze";
let scheduledFilterSequence = 0;
let currentRunNowTaskId = null;
let scheduledPollTimer = null;
let applicationInitialized = false;
let authenticationEnabled = false;
let adsFrameBridge = null;
let auditPage = null;

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const resultsEl = $("results");
const emptyStateEl = $("workspaceEmptyState");
const MAX_REFERENCE_IMAGE_BYTES = 2 * 1024 * 1024;
const TRANSPARENT_PIXEL = "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";
const RECENT_TASKS_KEY = "commerce-ops-recent-tasks";
const MABANG_USERNAME_KEY = "commerce-ops-mabang-username";
const MABANG_PASSWORD_KEY = "commerce-ops-mabang-password";
const mabangFieldCatalog = { orders: [], inventory: [] };
const mabangTasksByKind = { orders: null, inventory: null };
const scheduledState = {
  meta: null,
  accounts: [],
  dingtalkConfigs: [],
  tasks: [],
  runs: [],
  filterOptions: {},
  activeView: "tasks",
};
const mabangExportFilesState = { files: [], total: 0 };
const lifecycleState = { scan: null, items: [], quarantineRecords: [], page: 1, totalPages: 1, total: 0, pollTimer: null };
const LIFECYCLE_LABELS = {
  healthy: "正常",
  metadata_missing: "缺少数据库记录",
  physical_missing: "物理文件缺失",
  size_mismatch: "大小异常",
  hash_mismatch: "哈希异常",
  path_invalid: "路径异常",
  temp_stale: "临时残留",
  expired_candidate: "过期候选",
  unknown_file: "未知文件",
  duplicate_content: "重复内容",
  legacy_untracked_export: "旧版孤儿导出",
  active_or_recent: "活动或近期文件",
};
const MANAGED_FILE_TYPE_LABELS = {
  advertising_source: "广告源文件",
  advertising_output: "广告分析结果",
  advertising_report: "广告分析报告",
  advertising_temp: "广告临时文件",
  advertising_unknown: "用途待确认",
};
const FILE_REVIEW_STATUS_LABELS = {
  pending_review: "待复核",
  approved_for_registration: "已批准登记",
  registered: "已登记",
  approved_for_quarantine: "已批准隔离",
  quarantined: "已隔离",
  restored: "已恢复",
  rejected: "已拒绝",
  protected: "已保护",
};
const EXPORT_SOURCE_LABELS = {
  mabang_manual_order: "手工订单",
  mabang_manual_inventory: "手工库存",
  mabang_scheduled_order: "定时订单",
  mabang_scheduled_inventory: "定时库存",
  system_file_lifecycle_report: "生命周期报告",
};
const MABANG_ORDER_FILTER_OPERATORS = [
  { value: "contains", label: "包含", needsValue: true },
  { value: "equals", label: "等于", needsValue: true },
  { value: "notContains", label: "不包含", needsValue: true },
  { value: "notEquals", label: "不等于", needsValue: true },
  { value: "gte", label: "大于等于", needsValue: true },
  { value: "lte", label: "小于等于", needsValue: true },
  { value: "empty", label: "为空", needsValue: false },
  { value: "notEmpty", label: "非空", needsValue: false },
];
const MABANG_ORDER_FILTER_PREFERRED_FIELDS = ["平台", "店铺名", "店长", "订单状态", "仓库"];
let mabangOrderFilterSequence = 0;
let lastFocusedElement = null;

function setAuthError(message = "") {
  const error = $("authError");
  error.textContent = message;
  error.hidden = !message;
}

function showAuthGate(message = "") {
  if (scheduledPollTimer) {
    clearInterval(scheduledPollTimer);
    scheduledPollTimer = null;
  }
  $("appShell").hidden = true;
  $("authGate").hidden = false;
  $("logoutBtn").hidden = true;
  setAuthError(message);
  $("authToken").value = "";
  requestAnimationFrame(() => $("authToken").focus());
}

function initializeApplication() {
  if (applicationInitialized) return;
  applicationInitialized = true;
  updatePlatformDetection();
  renderRecentTasks();
  setWorkflowStep(1, 0);
  const rememberedMabangUsername = localStorage.getItem(MABANG_USERNAME_KEY) || "";
  const rememberedMabangPassword = localStorage.getItem(MABANG_PASSWORD_KEY) || "";
  $("mabangUsername").value = rememberedMabangUsername;
  $("mabangPassword").value = rememberedMabangPassword;
  $("mabangRememberCredentials").checked = Boolean(rememberedMabangUsername && rememberedMabangPassword);
  updateForgetCredentialsButton();
  $("scheduledTaskMonthDay").innerHTML = Array.from({ length: 31 }, (_, index) => `<option value="${index + 1}">${index + 1} 日</option>`).join("") + '<option value="last">每月最后一天</option>';
  updateScheduledFormVisibility();
  setOrderDatePreset("7");
  switchMabangView("orders");
  switchPage(location.hash.slice(1) || "link");
}

function showApplication() {
  $("authGate").hidden = true;
  $("appShell").hidden = false;
  $("logoutBtn").hidden = !authenticationEnabled;
  setAuthError();
  initializeApplication();
  if (applicationInitialized && currentMabangView === "scheduled" && !scheduledPollTimer) {
    switchMabangView("scheduled");
  }
}

function handleUnauthorized() {
  if (!authenticationEnabled) return;
  adsFrameBridge?.clear();
  clearSessionToken();
  showAuthGate("访问已失效，请重新输入访问密钥。");
}

const authorizedFetch = createAuthorizedFetch({ onUnauthorized: handleUnauthorized });
auditPage = createAuditPage({
  authorizedFetch,
  onError: (error) => setStatus(error.message || "操作记录加载失败", "error"),
});
auditPage.initialize();
adsFrameBridge = createAdFrameBridge({
  windowObject: window,
  frame: $("adsFrame"),
  getAuthContext: () => ({
    token: readSessionToken(),
    localCompatibilityMode: !authenticationEnabled,
  }),
  onSessionExpired: handleUnauthorized,
});

function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function loadAuthenticationStatus() {
  const token = readSessionToken();
  const response = await fetch("/api/auth/status", { headers: authHeaders(token) });
  if (!response.ok) throw new Error("无法读取认证状态");
  return response.json();
}

async function initializeAccess() {
  try {
    const status = await loadAuthenticationStatus();
    authenticationEnabled = Boolean(status.authenticationEnabled);
    if (!authenticationEnabled || status.authenticated) {
      showApplication();
      return;
    }
    clearSessionToken();
    showAuthGate();
  } catch {
    showAuthGate("无法连接主服务，请确认服务已经启动。");
  }
}

const PAGE_META = {
  link: {
    title: "链接维度竞品分析",
    subtitle: "抓取跨平台商品数据，完成 SKU 智能匹配、价格对比和主图分析。",
  },
  keyword: {
    title: "搜索关键词竞品分析",
    subtitle: "按国家和平台收集销量 TOP5 商品，并生成竞品结论。",
  },
  mabang: {
    title: "马帮数据",
    subtitle: "按账号权限获取订单和库存明细，在线预览并导出标准 Excel。",
  },
  ads: {
    title: "Lazada 广告分析",
    subtitle: "读取 Sponsored Max 报表，诊断计划、产品系列和推广链接表现。",
  },
  audit: {
    title: "操作记录",
    subtitle: "查看关键操作、失败原因和任务关联；敏感凭证与业务明细不会进入审计记录。",
  },
};

function setStatus(text, state = "neutral") {
  statusEl.textContent = text;
  statusEl.dataset.state = state;
}

function setWorkflowStep(activeStep, completedThrough = activeStep - 1) {
  document.querySelectorAll("[data-workflow-step]").forEach((item) => {
    const step = Number(item.dataset.workflowStep);
    item.classList.toggle("active", step === activeStep);
    item.classList.toggle("complete", step <= completedThrough);
  });
}

function detectPlatform(url) {
  const value = String(url || "").toLowerCase();
  if (value.includes("lazada.")) return "Lazada";
  if (value.includes("shopee.")) return "Shopee";
  if (value.includes("tiktok.com") || value.includes("shop.tiktok")) return "TikTok Shop";
  return null;
}

function updatePlatformDetection() {
  const urls = [
    $("myUrl").value.trim(),
    ...$("competitorUrls").value.split(/\n+/).map((line) => line.trim()).filter(Boolean),
  ];
  const platforms = [...new Set(urls.map(detectPlatform).filter(Boolean))];
  const container = $("platformDetection");
  if (!platforms.length) {
    container.innerHTML = `<span class="platform-tag neutral">${urls.some(Boolean) ? "未识别平台" : "等待链接"}</span>`;
    return;
  }
  container.innerHTML = platforms.map((platform) => `<span class="platform-tag">${platform}</span>`).join("");
}

function getRecentTasks() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_TASKS_KEY) || "[]");
  } catch {
    return [];
  }
}

function renderRecentTasks() {
  const container = $("recentTasksList");
  if (!container) return;
  const tasks = getRecentTasks().slice(0, 4);
  if (!tasks.length) {
    container.innerHTML = '<p class="muted">暂无最近任务</p>';
    return;
  }
  container.innerHTML = tasks.map((task) => `
    <div class="recent-task-item">
      <strong title="${esc(task.label)}">${esc(task.label)}</strong>
      <span>${esc(task.time)}</span>
    </div>
  `).join("");
}

function addRecentTask(label) {
  try {
    const tasks = getRecentTasks();
    tasks.unshift({
      label: String(label || "分析任务"),
      time: new Date().toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }),
    });
    localStorage.setItem(RECENT_TASKS_KEY, JSON.stringify(tasks.slice(0, 8)));
    renderRecentTasks();
  } catch {
    // Recent tasks are optional and must never fail the main workflow.
  }
}

function switchPage(page) {
  if (!PAGE_META[page]) page = "link";
  document.querySelectorAll(".tab-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.page === page);
    if (button.dataset.page === page) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  document.querySelectorAll(".page-section").forEach((section) => {
    section.hidden = section.id !== `page-${page}`;
    section.classList.toggle("active", section.id === `page-${page}`);
  });
  const meta = PAGE_META[page] || PAGE_META.link;
  $("pageTitle").textContent = meta.title;
  $("pageSubtitle").textContent = meta.subtitle;
  resultsEl.innerHTML = "";
  if (emptyStateEl) emptyStateEl.hidden = page !== "link" || Boolean(currentReport && !currentReport.discovery);
  if (page === "link" && currentReport && !currentReport.discovery) renderReport(currentReport);
  if (page === "keyword" && currentReport?.discovery) renderReport(currentReport);
  if (page === "mabang" && currentMabangView !== "scheduled" && currentMabangTask) renderMabangResult(currentMabangTask);
  if (page === "mabang" && currentMabangView === "scheduled") refreshScheduledData({ quiet: true }).catch(() => {});
  if (page === "ads") loadAdsAnalyzer();
  if (page === "audit") auditPage.load();
  if (location.hash !== `#${page}`) history.replaceState(null, "", `#${page}`);
}

async function loadAdsAnalyzer({ force = false } = {}) {
  const frame = $("adsFrame");
  const status = $("adsStatus");
  const openLink = $("adsOpenLink");
  const reconnectButton = $("adsReconnectBtn");
  if (!frame || (!force && frame.dataset.loaded === "true")) return;
  if (force) {
    frame.dataset.loaded = "false";
    frame.src = "about:blank";
  }
  reconnectButton.hidden = true;
  status.textContent = "正在启动 Lazada 广告分析子项目…";
  try {
    const data = await postJson("/api/ad-analyzer/status", {});
    const url = new URL(data.url || "/ads/", window.location.origin).href;
    frame.src = url;
    frame.dataset.loaded = "true";
    openLink.href = url;
    status.textContent = "广告分析子项目已连接。";
  } catch (error) {
    frame.dataset.loaded = "false";
    status.textContent = error.message || "广告服务未启动或连接超时。";
    reconnectButton.hidden = false;
  }
}

function showModal(title, text, options = {}) {
  if ($("serverVerifyModal").hidden) lastFocusedElement = document.activeElement;
  $("modalTitle").textContent = title;
  $("modalText").textContent = text || "";
  $("modalActions").hidden = !options.closable;
  $("serverVerifyModal").hidden = false;
  $("serverVerifyModal").querySelector(".modal-card")?.focus();
}

function hideModal() {
  $("modalActions").hidden = true;
  $("serverVerifyModal").hidden = true;
  if (lastFocusedElement instanceof HTMLElement) lastFocusedElement.focus();
  lastFocusedElement = null;
}

async function postJson(url, body) {
  const response = await authorizedFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new Error(data.error || `请求失败：${response.status}`);
  return data;
}

async function apiJson(url, { method = "GET", body } = {}) {
  const response = await authorizedFetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || `请求失败：${response.status}`);
  return data;
}

function esc(value) {
  return String(value ?? "not shown")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function imageProxy(url) {
  return url ? `/api/image?url=${encodeURIComponent(url)}` : "";
}

function protectedImageAttributes(url) {
  return `src="${TRANSPARENT_PIXEL}" data-protected-image="${esc(imageProxy(url))}"`;
}

function hydrateProtectedImages(root = document) {
  root.querySelectorAll("img[data-protected-image]").forEach(async (image) => {
    const proxyUrl = image.dataset.protectedImage;
    image.removeAttribute("data-protected-image");
    try {
      const response = await authorizedFetch(proxyUrl);
      if (!response.ok) throw new Error("图片加载失败");
      const objectUrl = URL.createObjectURL(await response.blob());
      image.addEventListener("load", () => URL.revokeObjectURL(objectUrl), { once: true });
      image.src = objectUrl;
    } catch {
      image.removeAttribute("src");
      image.classList.add("image-unavailable");
    }
  });
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("产品图片读取失败，请重新选择。"));
    reader.readAsDataURL(file);
  });
}

async function getTopImagePayload() {
  const file = $("topImage")?.files?.[0];
  if (!file) return null;
  if (!file.type.startsWith("image/")) throw new Error("请上传图片文件。");
  if (file.size > MAX_REFERENCE_IMAGE_BYTES) throw new Error("产品图片不能超过 2MB。");
  return {
    name: file.name,
    type: file.type,
    size: file.size,
    dataUrl: await readFileAsDataUrl(file),
  };
}

function renderSkuImage(url) {
  if (!url) return "-";
  return `<a href="${esc(url)}" target="_blank" rel="noreferrer"><img class="sku-thumb" ${protectedImageAttributes(url)} alt="SKU 图" width="54" height="54" loading="lazy"></a>`;
}

function platformName(value) {
  if (value === "tiktok") return "TikTok Shop";
  if (value === "shopee") return "Shopee";
  if (value === "lazada") return "Lazada";
  return value || "Unknown";
}

function advantageText(value) {
  if (value === "mine") return '<span class="adv-mine">我的优势</span>';
  if (value === "competitor") return '<span class="adv-competitor">竞品优势</span>';
  if (value === "competitor-coverage") return '<span class="adv-competitor">竞品覆盖优势</span>';
  if (value === "mine-coverage") return '<span class="adv-mine">我的覆盖优势</span>';
  if (value === "tie") return "持平";
  return "不可直接对比";
}

function renderInsights(items) {
  if (!Array.isArray(items) || !items.length) return "";
  return `
    <div class="insights">
      <strong>模块分析</strong>
      <ul>${items.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>
    </div>
  `;
}

function renderListBlock(title, items) {
  if (!Array.isArray(items) || !items.length) return "";
  return `
    <div class="mini-block">
      <h3>${esc(title)}</h3>
      <ul>${items.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>
    </div>
  `;
}

function renderKeyValueTable(title, rows, keyName = "item", valueName = "conclusion") {
  if (!Array.isArray(rows) || !rows.length) return "";
  return `
    <div class="mini-block">
      <h3>${esc(title)}</h3>
      <table>
        <tr><th>项目</th><th>结论</th></tr>
        ${rows.map((row) => `
          <tr>
            <td>${esc(row?.[keyName] || row?.module || "-")}</td>
            <td>${esc(row?.[valueName] || row?.template || row?.note || "-")}</td>
          </tr>
        `).join("")}
      </table>
    </div>
  `;
}

function renderMainImageAnalysis(analysis) {
  const modules = analysis?.modules || null;
  if (!modules) return analysis?.raw ? `<section class="panel"><h2>主图分析</h2>${renderInsights([analysis.raw])}</section>` : "";
  const checklist = modules.checklist || {};
  return `
    <section class="panel main-image-analysis">
      <h2>主图分析</h2>
      ${renderListBlock("核心结论", modules.summary)}
      ${renderKeyValueTable("产品与用户判断", modules.productUser)}
      ${Array.isArray(modules.firstSecond) && modules.firstSecond.length ? `
        <div class="mini-block">
          <h3>第一秒信息诊断</h3>
          <table>
            <tr><th>维度</th><th>当前状态</th><th>问题</th><th>建议</th></tr>
            ${modules.firstSecond.map((row) => `
              <tr>
                <td>${esc(row.dimension)}</td>
                <td>${esc(row.current)}</td>
                <td>${esc(row.problem)}</td>
                <td>${esc(row.recommendation)}</td>
              </tr>
            `).join("")}
          </table>
        </div>
      ` : ""}
      ${renderListBlock("点击理由", modules.clickReasons)}
      ${renderListBlock("主图短文案选项", modules.headlineOptions)}
      ${renderListBlock("构图建议", modules.composition)}
      ${Array.isArray(modules.competitorComparison) && modules.competitorComparison.length ? `
        <div class="mini-block">
          <h3>竞品主图对比</h3>
          <table>
            <tr><th>对比项</th><th>我的主图</th><th>竞品主图</th><th>机会点</th></tr>
            ${modules.competitorComparison.map((row) => `
              <tr>
                <td>${esc(row.item)}</td>
                <td>${esc(row.mine)}</td>
                <td>${esc(row.competitor)}</td>
                <td>${esc(row.opportunity)}</td>
              </tr>
            `).join("")}
          </table>
        </div>
      ` : ""}
      <div class="analysis-grid">
        ${renderListBlock("必须修改", checklist.mustChange)}
        ${renderListBlock("可以优化", checklist.niceToImprove)}
        ${renderListBlock("建议保留", checklist.keep)}
        ${renderListBlock("A/B 测试", checklist.abTests)}
      </div>
      ${renderKeyValueTable("复用模板", modules.template, "module", "template")}
      ${Array.isArray(modules.scores) && modules.scores.length ? `
        <div class="mini-block">
          <h3>评分</h3>
          <table>
            <tr><th>项目</th><th>分数</th><th>说明</th></tr>
            ${modules.scores.map((row) => `
              <tr>
                <td>${esc(row.item)}</td>
                <td>${esc(row.score)}</td>
                <td>${esc(row.note)}</td>
              </tr>
            `).join("")}
          </table>
        </div>
      ` : ""}
    </section>
  `;
}

async function jumpToVerification(url) {
  if (!url) return;
  try {
    setStatus("正在跳转到主服务器 Chrome 验证页面…");
    await postJson("/api/chrome/navigate", { url });
    setStatus("已跳转到主服务器 Chrome。请在主服务器电脑完成验证，然后重新获取。");
  } catch (error) {
    setStatus(error.message);
  }
}

function renderVerification(report) {
  const blocked = report.blockedProducts || [];
  resultsEl.innerHTML = `
    <section class="verify-card">
      <h2>主服务器需要完成平台验证</h2>
      <p>${esc(report.message || "页面被验证拦截，暂时无法提取商品信息。请等待主服务器完成验证。")}</p>
      <div class="verify-list">
        ${blocked.map((item, index) => `
          <article class="verify-item">
            <div>
              <strong>${item.role === "mine" ? "我的链接" : `竞品 ${item.index}`}</strong>
              <div class="muted">平台：${esc(platformName(item.platform))}</div>
              <div class="muted">状态：${esc(item.title || "验证码拦截")}</div>
              <div class="link-text">原始链接：${esc(item.inputUrl)}</div>
              <div class="link-text">当前页面：${esc(item.currentUrl || item.verificationUrl)}</div>
            </div>
            <button type="button" data-verify-index="${index}">主服务器打开验证</button>
          </article>
        `).join("")}
      </div>
      <div class="verify-actions">
        <button id="retryExtractBtn" type="button">${lastRunMode === "discover-top5" ? "主服务器已验证，重新收集 TOP5 并分析" : lastRunMode === "analyze" ? "主服务器已验证，重新获取并分析" : "主服务器已验证，重新获取信息"}</button>
      </div>
    </section>
  `;

  resultsEl.querySelectorAll("[data-verify-index]").forEach((button) => {
    button.addEventListener("click", () => {
      const item = blocked[Number(button.dataset.verifyIndex)];
      jumpToVerification(item?.inputUrl || item?.verificationUrl);
    });
  });
  $("retryExtractBtn")?.addEventListener("click", () => {
    if (lastRunMode === "discover-top5") runKeywordDiscovery();
    else runExtraction({ analyze: lastRunMode === "analyze" });
  });
}

function renderProducts(products, modules) {
  return `
    <section class="product-grid">
      ${products.map((product, index) => `
        <article class="product-card">
          ${product.mainImage ? `<img ${protectedImageAttributes(product.mainImage)} alt="${currentReport?.discovery ? `TOP ${index + 1} 主图` : index === 0 ? "我的主图" : "竞品主图"}" width="640" height="640" loading="lazy">` : ""}
          <div class="product-body">
            <h3>${currentReport?.discovery ? `TOP ${index + 1}` : index === 0 ? "我的链接" : `竞品 ${index}`}</h3>
            <div><strong>平台：</strong>${esc(platformName(product.platform))}</div>
            <div><strong>标题：</strong>${esc(product.title)}</div>
            <div><strong>店铺：</strong>${esc(product.shopName)}</div>
            <div><strong>评分：</strong>${esc(product.rating)} / <strong>评价数：</strong>${esc(product.reviewCount)} / <strong>销量：</strong>${esc(product.soldCount)}</div>
            <div><strong>主图链接：</strong><div class="link-text">${esc(product.mainImage)}</div></div>
          </div>
        </article>
      `).join("")}
    </section>
    <section class="panel">${renderInsights([...(modules?.titleShop || []), ...(modules?.images || [])])}</section>
  `;
}

function renderDiscoverySummary(report, modules) {
  const discovery = report.discovery;
  if (!discovery) return "";
  const products = report.products || [];
  const reference = discovery.referenceProduct || {};
  const referenceImage = reference.image?.dataUrl;
  const referenceDescription = reference.description || "";
  return `
    <section class="panel">
      <h2>关键词 TOP5</h2>
      <div class="muted">
        关键词：${esc(discovery.keyword)} / 国家：${esc(String(discovery.country || "").toUpperCase())} / 站点：${esc(platformName(discovery.platform))}
      </div>
      ${discovery.originalKeyword && discovery.originalKeyword !== discovery.keyword ? `<div class="muted">原始关键词：${esc(discovery.originalKeyword)} / 优化说明：${esc(discovery.keywordOptimizationReason || "已结合产品描述优化")}</div>` : ""}
      ${referenceImage || referenceDescription ? `
        <div class="reference-card">
          ${referenceImage ? `<img src="${esc(referenceImage)}" alt="参考产品图片" width="120" height="120" loading="lazy">` : ""}
          <div>
            <strong>参考产品</strong>
            ${referenceDescription ? `<p>${esc(referenceDescription)}</p>` : `<p>已上传参考图片。</p>`}
          </div>
        </div>
      ` : ""}
      <div class="link-text">搜索页：${esc(discovery.finalUrl || discovery.searchUrl)}</div>
      <div class="muted">${discovery.usedVisibleSales ? "已读取搜索页可见销量并排序。" : "搜索页未稳定展示销量，已按平台销量/热门排序后的前 5 个结果抓取。"}</div>
      <table>
        <tr><th>排名</th><th>标题</th><th>店铺</th><th>评分</th><th>评价数</th><th>销量</th><th>搜索页销量</th><th>链接</th></tr>
        ${products.map((product, index) => `
          <tr>
            <td>TOP ${index + 1}</td>
            <td>${esc(product.title)}</td>
            <td>${esc(product.shopName)}</td>
            <td>${esc(product.rating)}</td>
            <td>${esc(product.reviewCount)}</td>
            <td>${esc(product.soldCount)}</td>
            <td>${esc(product.discoverySoldText || "-")}</td>
            <td><div class="link-text">${esc(product.finalUrl || product.inputUrl)}</div></td>
          </tr>
        `).join("")}
      </table>
      ${renderInsights([...(modules?.titleShop || []), ...(modules?.images || []), ...(modules?.ratingReviews || []), ...(modules?.sales || []), ...(modules?.productDetails || [])])}
    </section>
  `;
}

function mabangSummaryEntries(task) {
  const summary = task.summary || {};
  if (task.kind === "orders") {
    const entries = [
      [summary.orderFilterCount ? "筛选后订单" : "订单数", summary.orders ?? task.unfilteredTotal ?? task.total],
      [summary.orderFilterCount ? "筛选后明细" : "明细行", summary.rows ?? task.unfilteredTotal ?? task.total],
    ];
    if (summary.orderFilterCount) {
      entries.push(
        ["日期范围明细", summary.collectedRows ?? "-"],
        ["采集条件", `${summary.orderFilterCount} 项`],
      );
    }
    entries.push(
      ["开始日期", String(summary.startDate || "-").slice(0, 10)],
      ["结束日期", String(summary.endDate || "-").slice(0, 10)],
    );
    return entries;
  }
  return [
    ["库存明细", summary.rows ?? task.unfilteredTotal ?? task.total],
    ["系统记录", summary.reportedRows ?? "-"],
    ["库存总量", summary.total || "-"],
    ["库存成本", summary.totalCost || "-"],
    ["在途库存", summary.inTransitTotal || "-"],
    ["缓存时间", summary.cacheUpdateTime || "-"],
  ];
}

function renderMabangResult(task) {
  currentMabangTask = task;
  mabangTasksByKind[task.kind] = task;
  renderMabangFilterFields(task.columns || [], task.filterField || "__all__");
  $("mabangResultQuery").value = task.query || "";
  $("mabangPageSize").value = String(task.pageSize || 50);
  const panel = $("mabangResultPanel");
  panel.hidden = false;
  $("mabangResultTitle").textContent = task.kind === "orders" ? "订单信息结果" : "库存信息结果";
  const filtered = Number(task.total || 0);
  const original = Number(task.unfilteredTotal ?? filtered);
  const collectedRows = Number(task.summary?.collectedRows ?? original);
  const prefilterCount = Number(task.summary?.orderFilterCount || 0);
  const fieldLabel = task.filterField && task.filterField !== "__all__" ? task.filterField : "全部字段";
  $("mabangResultSummary").textContent = filtered !== original
    ? `查找结果 ${filtered} 条，采集结果 ${original} 条`
    : prefilterCount && collectedRows !== original
      ? `采集条件筛选后 ${original} 条，日期范围原始 ${collectedRows} 条`
      : `共 ${filtered} 条数据`;
  $("mabangFilterHint").textContent = task.query
    ? `当前按“${fieldLabel}”筛选“${task.query}”；Excel 将导出这 ${filtered} 条结果。`
    : prefilterCount
      ? `已应用 ${prefilterCount} 项采集条件；可在当前结果中继续查找，Excel 将导出当前结果。`
      : `当前显示全部 ${original} 条数据；选择字段并输入关键词后可筛选导出。`;
  $("mabangExportBtn").disabled = !task.taskId;
  $("mabangSearchBtn").disabled = !task.taskId;
  $("mabangClearFilterBtn").disabled = !task.query && (!task.filterField || task.filterField === "__all__");
  $("mabangSummaryCards").innerHTML = mabangSummaryEntries(task).map(([label, value]) => `
    <div class="mabang-summary-item"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>
  `).join("");

  const columns = task.columns || [];
  const records = task.records || [];
  $("mabangDataTable").innerHTML = columns.length ? `
    <table class="mabang-data-table">
      <thead><tr><th class="row-number">#</th>${columns.map((column) => `<th>${esc(column)}</th>`).join("")}</tr></thead>
      <tbody>${records.length ? records.map((record, index) => `
        <tr>
          <td class="row-number">${(task.page - 1) * task.pageSize + index + 1}</td>
          ${columns.map((column) => `<td title="${esc(record[column] ?? "-")}">${esc(record[column] ?? "-")}</td>`).join("")}
        </tr>
      `).join("") : `<tr><td colspan="${columns.length + 1}">没有符合当前搜索条件的数据。</td></tr>`}</tbody>
    </table>
  ` : '<div class="data-empty">本次采集没有返回可显示字段。</div>';

  $("mabangPageInfo").textContent = `第 ${task.page || 1} / ${task.totalPages || 1} 页，共 ${task.total || 0} 条`;
  $("mabangPrevPage").disabled = (task.page || 1) <= 1;
  $("mabangNextPage").disabled = (task.page || 1) >= (task.totalPages || 1);
}

function setMabangTaskState(title, text, state = "neutral") {
  const container = $("mabangTaskState");
  container.dataset.state = state;
  container.querySelector("strong").textContent = title;
  container.querySelector("p").textContent = text;
}

function setMabangBusy(disabled) {
  ["mabangTestLoginBtn", "mabangOrderFetchBtn", "mabangInventoryFetchBtn", "mabangExportBtn", "mabangClearFilterBtn", "mabangSearchBtn", "mabangAddOrderFilterBtn"].forEach((id) => {
    const button = $(id);
    if (!button) return;
    if (disabled) button.disabled = true;
    else if (id === "mabangExportBtn") button.disabled = !currentMabangTask?.taskId;
    else if (id === "mabangSearchBtn") button.disabled = !currentMabangTask?.taskId;
    else if (id === "mabangClearFilterBtn") button.disabled = !currentMabangTask?.query && (!currentMabangTask?.filterField || currentMabangTask.filterField === "__all__");
    else if (id === "mabangAddOrderFilterBtn") button.disabled = !mabangFieldCatalog.orders.length || document.querySelectorAll(".order-filter-row").length >= mabangFieldCatalog.orders.length;
    else button.disabled = false;
  });
  document.querySelectorAll(".order-filter-row").forEach((row) => {
    row.querySelectorAll("select, input, button").forEach((control) => { control.disabled = disabled; });
    if (!disabled) setMabangOrderFilterValueState(row);
  });
}

function getMabangCredentials() {
  const username = $("mabangUsername").value.trim();
  const password = $("mabangPassword").value;
  if (!username || !password) throw new Error("请输入马帮账号和密码。");
  if ($("mabangRememberCredentials").checked) {
    localStorage.setItem(MABANG_USERNAME_KEY, username);
    localStorage.setItem(MABANG_PASSWORD_KEY, password);
  } else {
    localStorage.removeItem(MABANG_USERNAME_KEY);
    localStorage.removeItem(MABANG_PASSWORD_KEY);
  }
  updateForgetCredentialsButton();
  return { username, password };
}

function renderMabangFilterFields(columns, selected = "__all__") {
  const select = $("mabangFilterField");
  const activeColumns = Array.isArray(columns) ? columns : [];
  const preserved = activeColumns.includes(selected) ? selected : "__all__";
  select.innerHTML = `<option value="__all__">全部字段</option>${activeColumns.map((column) => `<option value="${esc(column)}">${esc(column)}</option>`).join("")}`;
  select.value = preserved;
  $("mabangFilterFieldLabel").textContent = `筛选字段（${activeColumns.length}）`;
  const label = preserved === "__all__" ? "全部字段" : preserved;
  $("mabangFilterHint").textContent = `当前按“${label}”筛选；结果表和 Excel 导出将使用同一条件。`;
}

function mabangOrderFieldOptions(selected = "") {
  return mabangFieldCatalog.orders.map((field) => `
    <option value="${esc(field)}"${field === selected ? " selected" : ""}>${esc(field)}</option>
  `).join("");
}

function preferredMabangOrderField() {
  const selectedFields = new Set(Array.from(document.querySelectorAll(".order-filter-field")).map((select) => select.value));
  return MABANG_ORDER_FILTER_PREFERRED_FIELDS.find((field) => mabangFieldCatalog.orders.includes(field) && !selectedFields.has(field))
    || mabangFieldCatalog.orders.find((field) => !selectedFields.has(field))
    || mabangFieldCatalog.orders[0]
    || "";
}

function setMabangOrderFilterValueState(row) {
  const operator = row.querySelector(".order-filter-operator")?.value || "contains";
  const definition = MABANG_ORDER_FILTER_OPERATORS.find((item) => item.value === operator);
  const input = row.querySelector(".order-filter-input");
  if (!input) return;
  const needsValue = definition?.needsValue !== false;
  input.disabled = !needsValue;
  input.placeholder = needsValue ? "输入筛选值" : "此匹配方式无需填写";
  if (!needsValue) input.value = "";
}

function refreshMabangOrderFilterState() {
  const rows = document.querySelectorAll(".order-filter-row");
  $("mabangOrderFilterEmpty").hidden = rows.length > 0;
  $("mabangAddOrderFilterBtn").disabled = !mabangFieldCatalog.orders.length || rows.length >= mabangFieldCatalog.orders.length;
}

function addMabangOrderFilter(initial = {}) {
  if (!mabangFieldCatalog.orders.length) {
    setStatus("订单字段仍在加载，请稍候再试。", "error");
    return;
  }
  if (document.querySelectorAll(".order-filter-row").length >= mabangFieldCatalog.orders.length) return;
  const filterId = ++mabangOrderFilterSequence;
  const selectedField = mabangFieldCatalog.orders.includes(initial.field) ? initial.field : preferredMabangOrderField();
  const selectedOperator = MABANG_ORDER_FILTER_OPERATORS.some((item) => item.value === initial.operator) ? initial.operator : "contains";
  const row = document.createElement("div");
  row.className = "order-filter-row";
  row.dataset.filterId = String(filterId);
  row.innerHTML = `
    <label class="field-block">
      <span>字段</span>
      <select class="order-filter-field" aria-label="第 ${filterId} 个筛选字段">${mabangOrderFieldOptions(selectedField)}</select>
    </label>
    <label class="field-block">
      <span>匹配方式</span>
      <select class="order-filter-operator" aria-label="第 ${filterId} 个匹配方式">
        ${MABANG_ORDER_FILTER_OPERATORS.map((item) => `<option value="${item.value}"${item.value === selectedOperator ? " selected" : ""}>${item.label}</option>`).join("")}
      </select>
    </label>
    <label class="field-block order-filter-value">
      <span>条件值</span>
      <input class="order-filter-input" type="search" autocomplete="off" aria-label="第 ${filterId} 个筛选值" value="${esc(initial.value || "")}" placeholder="输入筛选值" />
    </label>
    <button class="remove-order-filter" type="button" aria-label="移除第 ${filterId} 个筛选条件" title="移除筛选条件">×</button>
  `;
  row.querySelector(".order-filter-operator").addEventListener("change", () => setMabangOrderFilterValueState(row));
  row.querySelector(".remove-order-filter").addEventListener("click", () => {
    row.remove();
    refreshMabangOrderFilterState();
  });
  $("mabangOrderFilterList").appendChild(row);
  setMabangOrderFilterValueState(row);
  refreshMabangOrderFilterState();
}

function renderMabangOrderFilterCatalog() {
  const fields = mabangFieldCatalog.orders;
  $("mabangOrderFilterFieldCount").textContent = fields.length ? `可选字段 ${fields.length}` : "字段加载失败";
  document.querySelectorAll(".order-filter-row").forEach((row) => {
    const select = row.querySelector(".order-filter-field");
    const selected = fields.includes(select.value) ? select.value : fields[0] || "";
    select.innerHTML = mabangOrderFieldOptions(selected);
    select.value = selected;
  });
  refreshMabangOrderFilterState();
}

function getMabangOrderFilters() {
  const conditions = [];
  document.querySelectorAll(".order-filter-row").forEach((row, index) => {
    const field = row.querySelector(".order-filter-field").value;
    const operator = row.querySelector(".order-filter-operator").value;
    const value = row.querySelector(".order-filter-input").value.trim();
    const definition = MABANG_ORDER_FILTER_OPERATORS.find((item) => item.value === operator);
    if (!mabangFieldCatalog.orders.includes(field)) throw new Error(`第 ${index + 1} 个筛选字段无效，请重新选择。`);
    if (definition?.needsValue !== false && !value) throw new Error(`请填写第 ${index + 1} 个筛选条件的值。`);
    conditions.push({ field, operator, value });
  });
  return { mode: "all", conditions };
}

async function loadMabangFieldCatalog(kind) {
  const view = kind === "inventory" ? "inventory" : "orders";
  if (!mabangFieldCatalog[view].length) {
    const response = await authorizedFetch(`/api/mabang-data/fields?kind=${view}`);
    const data = await response.json();
    if (!response.ok || data.ok === false) throw new Error(data.error || "无法加载马帮字段列表。");
    mabangFieldCatalog[view] = data.columns || [];
  }
  if (view === "orders") renderMabangOrderFilterCatalog();
  if (currentMabangView === view && !mabangTasksByKind[view]) {
    renderMabangFilterFields(mabangFieldCatalog[view]);
  }
}

function formatDateInput(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function setOrderDatePreset(preset) {
  const end = new Date();
  const start = new Date(end);
  if (preset === "yesterday") {
    start.setDate(start.getDate() - 1);
    end.setDate(end.getDate() - 1);
  } else if (Number(preset) > 1) {
    start.setDate(start.getDate() - Number(preset) + 1);
  }
  $("mabangOrderStartDate").value = formatDateInput(start);
  $("mabangOrderEndDate").value = formatDateInput(end);
  document.querySelectorAll(".date-preset-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.datePreset === String(preset));
  });
}

function clearMabangPasswordAfterTask() {
  if (!$("mabangRememberCredentials").checked) $("mabangPassword").value = "";
}

function updateForgetCredentialsButton() {
  $("mabangForgetCredentialsBtn").disabled = !localStorage.getItem(MABANG_USERNAME_KEY) && !localStorage.getItem(MABANG_PASSWORD_KEY);
}

function forgetMabangCredentials() {
  localStorage.removeItem(MABANG_USERNAME_KEY);
  localStorage.removeItem(MABANG_PASSWORD_KEY);
  $("mabangUsername").value = "";
  $("mabangPassword").value = "";
  $("mabangPassword").type = "password";
  $("mabangPasswordToggle").textContent = "显示";
  $("mabangPasswordToggle").setAttribute("aria-pressed", "false");
  $("mabangRememberCredentials").checked = false;
  $("mabangLoginState").textContent = "尚未验证";
  $("mabangLoginState").className = "status-badge neutral";
  updateForgetCredentialsButton();
  setMabangTaskState("已清除保存的凭证", "当前浏览器不再保存马帮账号和密码。", "success");
}

async function clearMabangFilters() {
  if (!currentMabangTask?.taskId) return;
  $("mabangFilterField").value = "__all__";
  $("mabangResultQuery").value = "";
  await fetchMabangResult(1, { useDraft: true });
}

function markMabangFilterDraft() {
  if (!currentMabangTask?.taskId) return;
  const field = $("mabangFilterField").value;
  const query = $("mabangResultQuery").value.trim();
  const fieldLabel = field === "__all__" ? "全部字段" : field;
  const hasDraftFilter = Boolean(query) || field !== "__all__";
  const hasAppliedFilter = Boolean(currentMabangTask.query)
    || (currentMabangTask.filterField && currentMabangTask.filterField !== "__all__");
  $("mabangClearFilterBtn").disabled = !hasDraftFilter && !hasAppliedFilter;
  $("mabangFilterHint").textContent = query
    ? `已填写按“${fieldLabel}”查找“${query}”，点击“查找”后更新结果。`
    : `已选择“${fieldLabel}”，点击“查找”后更新结果。`;
}

async function applyMabangFilters() {
  if (!currentMabangTask?.taskId) return;
  const button = $("mabangSearchBtn");
  button.disabled = true;
  button.textContent = "查找中...";
  try {
    await fetchMabangResult(1, { useDraft: true });
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    button.textContent = "查找";
    button.disabled = !currentMabangTask?.taskId;
  }
}

function switchMabangView(view) {
  currentMabangView = ["orders", "inventory", "scheduled", "files"].includes(view) ? view : "orders";
  document.querySelectorAll(".mabang-view-tab").forEach((button) => {
    const active = button.dataset.mabangView === currentMabangView;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  $("mabangOrdersPanel").hidden = currentMabangView !== "orders";
  $("mabangInventoryPanel").hidden = currentMabangView !== "inventory";
  $("mabangScheduledPanel").hidden = currentMabangView !== "scheduled";
  $("mabangFilesPanel").hidden = currentMabangView !== "files";
  $("mabangCredentialSection").hidden = ["scheduled", "files"].includes(currentMabangView);
  $("mabangTaskState").hidden = ["scheduled", "files"].includes(currentMabangView);
  if (currentMabangView === "scheduled") {
    currentMabangTask = null;
    $("mabangResultPanel").hidden = true;
    refreshScheduledData({ quiet: true }).catch((error) => setStatus(error.message, "error"));
    if (!scheduledPollTimer) {
      scheduledPollTimer = setInterval(() => {
        if (currentMabangView === "scheduled" && !document.hidden) refreshScheduledData({ quiet: true }).catch(() => {});
      }, 10000);
    }
    return;
  }
  if (currentMabangView === "files") {
    currentMabangTask = null;
    $("mabangResultPanel").hidden = true;
    refreshMabangExportFiles().catch((error) => setStatus(error.message, "error"));
    refreshLifecycleSummary().catch((error) => setStatus(error.message, "error"));
    return;
  }
  currentMabangTask = mabangTasksByKind[currentMabangView];
  if (currentMabangTask) {
    renderMabangResult(currentMabangTask);
  } else {
    $("mabangResultPanel").hidden = true;
    $("mabangResultQuery").value = "";
    $("mabangPageSize").value = "50";
    $("mabangSearchBtn").disabled = true;
  }
  loadMabangFieldCatalog(currentMabangView).catch((error) => setStatus(error.message, "error"));
}

function formatFileSize(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function exportFileStatus(file) {
  if (file.status === "available") return '<span class="run-status success">可下载</span>';
  if (file.status === "missing") return '<span class="run-status failed">文件缺失</span>';
  if (file.status === "integrity_failed") return '<span class="run-status failed">校验失败</span>';
  if (file.status === "expired") return '<span class="run-status skipped">已过期</span>';
  return `<span class="run-status disabled">${esc(file.status || "不可用")}</span>`;
}

function renderMabangExportFiles() {
  const files = mabangExportFilesState.files;
  $("mabangFilesHint").textContent = files.length
    ? `共 ${mabangExportFilesState.total} 条记录，当前显示最近 ${files.length} 条。`
    : "暂无持久化导出记录。";
  if (!files.length) {
    $("mabangFilesTable").innerHTML = '<p class="order-filter-empty">暂无导出文件。</p>';
    return;
  }
  $("mabangFilesTable").innerHTML = `<table class="mabang-data-table scheduled-table">
    <thead><tr><th>文件名称</th><th>来源</th><th>创建时间</th><th>文件大小</th><th>状态</th><th>操作</th></tr></thead>
    <tbody>${files.map((file) => `<tr>
      <td><strong>${esc(file.originalFilename)}</strong><small>${esc(file.id.slice(0, 8))}</small></td>
      <td>${esc(EXPORT_SOURCE_LABELS[file.sourceType] || file.sourceType)}</td>
      <td>${esc(formatScheduledDate(file.createdAt))}</td>
      <td>${esc(formatFileSize(file.fileSize))}</td>
      <td>${exportFileStatus(file)}</td>
      <td><div class="table-actions">${file.status === "available" ? `<button type="button" data-file-action="download" data-file-id="${esc(file.id)}">下载</button>` : "-"}</div></td>
    </tr>`).join("")}</tbody>
  </table>`;
}

async function refreshMabangExportFiles() {
  const data = await apiJson("/api/files?page=1&page_size=50");
  mabangExportFilesState.files = data.files || [];
  mabangExportFilesState.total = Number(data.total || 0);
  renderMabangExportFiles();
}

async function downloadMabangExportFile(fileId) {
  const response = await authorizedFetch(`/api/files/${encodeURIComponent(fileId)}/download`);
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "文件下载失败。");
  }
  const disposition = response.headers.get("content-disposition") || "";
  const filename = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
    ? decodeURIComponent(disposition.match(/filename\*=UTF-8''([^;]+)/i)[1])
    : disposition.match(/filename="([^"]+)"/)?.[1] || "mabang-export.xlsx";
  const objectUrl = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
}

function lifecycleStatusClass(classification) {
  if (classification === "healthy") return "success";
  if (classification === "active_or_recent") return "running";
  if (["expired_candidate", "temp_stale"].includes(classification)) return "skipped";
  return "failed";
}

function lifecycleReviewActions(item) {
  const actions = [`<button type="button" data-lifecycle-action="detail" data-lifecycle-id="${esc(item.id)}">查看</button>`];
  if (["pending_review", "approved_for_registration"].includes(item.reviewStatus)
    && ["advertising_source", "advertising_output", "advertising_report"].includes(item.detectedFileType)) {
    actions.push(`<button type="button" data-lifecycle-action="register" data-lifecycle-id="${esc(item.id)}">确认登记</button>`);
  }
  if (item.reviewStatus === "pending_review" && item.detectedFileType === "advertising_unknown") {
    actions.push(`<button type="button" data-lifecycle-action="protect" data-lifecycle-id="${esc(item.id)}">标记保护</button>`);
  }
  const quarantineEligible = item.detectedFileType === "advertising_temp"
    || item.categories.some((value) => ["temp_stale", "expired_candidate"].includes(value));
  const historicalUnmanagedFile = Boolean(item.fileId && !item.managedFileId);
  if (quarantineEligible && item.reviewStatus === "pending_review" && !historicalUnmanagedFile) {
    actions.push(`<button type="button" data-lifecycle-action="approve-quarantine" data-lifecycle-id="${esc(item.id)}">确认候选</button>`);
  }
  if (quarantineEligible && item.reviewStatus === "approved_for_quarantine" && !historicalUnmanagedFile) {
    actions.push(`<button type="button" data-lifecycle-action="quarantine" data-lifecycle-id="${esc(item.id)}">执行隔离</button>`);
  }
  if (item.reviewStatus === "quarantined") {
    actions.push(`<button type="button" data-lifecycle-action="restore" data-lifecycle-id="${esc(item.id)}">恢复</button>`);
  }
  return actions.join("");
}

function renderLifecycleSummary() {
  const scan = lifecycleState.scan;
  const summary = scan?.summary || {};
  const cards = [
    ["healthy", "正常"], ["metadata_missing", "数据库缺失文件"], ["physical_missing", "物理文件缺失"],
    ["hash_mismatch", "哈希异常"], ["temp_stale", "临时残留"], ["expired_candidate", "过期候选"],
    ["legacy_untracked_export", "旧版孤儿导出"],
  ];
  $("lifecycleSummary").innerHTML = cards.map(([key, label]) => `<article class="summary-card">
    <span>${esc(label)}</span><strong>${Number(summary[key] || 0)}</strong>
  </article>`).join("");
  $("lifecycleScanHint").textContent = !scan
    ? "尚未执行文件生命周期扫描。"
    : scan.status === "running"
      ? `扫描进行中，开始于 ${formatScheduledDate(scan.startedAt)}。`
      : `最近扫描：${formatScheduledDate(scan.finishedAt || scan.startedAt)}，共 ${scan.totalFiles} 条结果${scan.truncated ? "，已达到扫描保护上限" : ""}。`;
  $("startLifecycleScanBtn").disabled = scan?.status === "running";
  $("classifyLifecycleBtn").disabled = scan?.status !== "completed";
  $("exportLifecycleBtn").disabled = scan?.status !== "completed";
}

function renderLifecycleItems() {
  if (!lifecycleState.items.length) {
    $("lifecycleItemsTable").innerHTML = '<p class="order-filter-empty">暂无符合条件的扫描条目。</p>';
  } else {
    $("lifecycleItemsTable").innerHTML = `<table class="mabang-data-table scheduled-table">
      <thead><tr><th>文件</th><th>扫描分类</th><th>识别用途</th><th>复核状态</th><th>范围</th><th>大小</th><th>操作</th></tr></thead>
      <tbody>${lifecycleState.items.map((item) => `<tr>
        <td><strong>${esc(item.maskedFilename)}</strong><small>${esc(item.fileId ? item.fileId.slice(0, 8) : item.shortHash || "未登记")}</small></td>
        <td><span class="run-status ${lifecycleStatusClass(item.classification)}">${esc(LIFECYCLE_LABELS[item.classification] || item.classification)}</span></td>
        <td>${esc(MANAGED_FILE_TYPE_LABELS[item.detectedFileType] || "未复核")}</td>
        <td>${esc(FILE_REVIEW_STATUS_LABELS[item.reviewStatus] || item.reviewStatus || "待复核")}</td>
        <td>${esc(item.scope)}</td><td>${esc(formatFileSize(item.fileSize))}</td>
        <td class="table-actions">${lifecycleReviewActions(item)}</td>
      </tr>`).join("")}</tbody>
    </table>`;
  }
  $("lifecyclePageInfo").textContent = `第 ${lifecycleState.page} / ${lifecycleState.totalPages} 页，共 ${lifecycleState.total} 条`;
  $("lifecyclePrevPageBtn").disabled = lifecycleState.page <= 1;
  $("lifecycleNextPageBtn").disabled = lifecycleState.page >= lifecycleState.totalPages;
}

function renderQuarantineRecords() {
  if (!lifecycleState.quarantineRecords.length) {
    $("lifecycleQuarantineTable").innerHTML = '<p class="order-filter-empty">暂无隔离记录。</p>';
    return;
  }
  $("lifecycleQuarantineTable").innerHTML = `<table class="mabang-data-table scheduled-table">
    <thead><tr><th>记录</th><th>范围</th><th>大小</th><th>状态</th><th>隔离时间</th><th>操作</th></tr></thead>
    <tbody>${lifecycleState.quarantineRecords.map((record) => `<tr>
      <td><strong>${esc(record.id.slice(0, 8))}</strong></td><td>${esc(record.rootKey)}</td>
      <td>${esc(formatFileSize(record.fileSize))}</td><td>${esc(FILE_REVIEW_STATUS_LABELS[record.status] || record.status)}</td>
      <td>${esc(formatScheduledDate(record.quarantinedAt))}</td>
      <td>${record.status === "quarantined" ? `<button type="button" data-quarantine-action="restore" data-lifecycle-id="${esc(record.lifecycleItemId)}">恢复</button>` : "-"}</td>
    </tr>`).join("")}</tbody>
  </table>`;
}

async function loadQuarantineRecords() {
  const data = await apiJson("/api/files/lifecycle/quarantine-records?page=1&page_size=50");
  lifecycleState.quarantineRecords = data.records || [];
  renderQuarantineRecords();
}

async function loadLifecycleReport(page = 1) {
  if (!lifecycleState.scan?.id || lifecycleState.scan.status !== "completed") {
    lifecycleState.items = [];
    renderLifecycleItems();
    return;
  }
  const params = new URLSearchParams({ page: String(page), page_size: "50" });
  const category = $("lifecycleCategoryFilter").value;
  if (category) params.set("classification", category);
  const data = await apiJson(`/api/files/lifecycle/reports/${encodeURIComponent(lifecycleState.scan.id)}?${params}`);
  lifecycleState.scan = data.scan;
  lifecycleState.items = data.items || [];
  lifecycleState.page = Number(data.page || 1);
  lifecycleState.totalPages = Number(data.totalPages || 1);
  lifecycleState.total = Number(data.total || 0);
  renderLifecycleSummary();
  renderLifecycleItems();
}

async function refreshLifecycleSummary() {
  const data = await apiJson("/api/files/lifecycle/summary");
  lifecycleState.scan = data.scan || null;
  renderLifecycleSummary();
  if (lifecycleState.scan?.status === "completed") await loadLifecycleReport(1);
  else {
    lifecycleState.items = [];
    lifecycleState.total = 0;
    lifecycleState.page = 1;
    lifecycleState.totalPages = 1;
    renderLifecycleItems();
  }
  if (lifecycleState.scan?.status === "running") {
    clearTimeout(lifecycleState.pollTimer);
    lifecycleState.pollTimer = setTimeout(() => refreshLifecycleSummary().catch(() => {}), 1200);
  }
  await loadQuarantineRecords();
}

async function startLifecycleScan() {
  $("startLifecycleScanBtn").disabled = true;
  const data = await apiJson("/api/files/lifecycle/scan", { method: "POST", body: { scopes: "all" } });
  lifecycleState.scan = data.scan;
  lifecycleState.items = [];
  renderLifecycleSummary();
  renderLifecycleItems();
  clearTimeout(lifecycleState.pollTimer);
  lifecycleState.pollTimer = setTimeout(() => refreshLifecycleSummary().catch(() => {}), 600);
}

async function exportLifecycleReport() {
  if (!lifecycleState.scan?.id) return;
  const data = await apiJson(`/api/files/lifecycle/reports/${encodeURIComponent(lifecycleState.scan.id)}/export`, { method: "POST", body: {} });
  await downloadMabangExportFile(data.fileId);
  refreshMabangExportFiles().catch(() => {});
}

async function classifyLifecycleReport() {
  if (!lifecycleState.scan?.id) return;
  const data = await apiJson(`/api/files/lifecycle/reports/${encodeURIComponent(lifecycleState.scan.id)}/classify`, { method: "POST", body: {} });
  setStatus(`已复核 ${Number(data.matchedCount || 0)} 个受控广告文件。`, "success");
  await loadLifecycleReport(lifecycleState.page);
}

async function performLifecycleReviewAction(action, itemId) {
  const prompts = {
    register: "确认将这个已识别的正式广告文件登记到统一元数据吗？",
    protect: "确认将这个用途待定文件标记为保护吗？",
    "approve-quarantine": "确认将这个临时测试文件批准为隔离候选吗？",
    quarantine: "确认隔离这个已批准的测试候选吗？文件不会被删除。",
    restore: "确认将隔离文件恢复到原位置吗？",
  };
  if (prompts[action] && !window.confirm(prompts[action])) return;
  await apiJson(`/api/files/lifecycle/items/${encodeURIComponent(itemId)}/${action}`, { method: "POST", body: { reason: `manual_${action}` } });
  await loadLifecycleReport(lifecycleState.page);
  await loadQuarantineRecords();
  setStatus("文件复核操作已完成。", "success");
}

function showLifecycleDetail(itemId) {
  const item = lifecycleState.items.find((entry) => entry.id === itemId);
  if (!item) return;
  const fields = [
    ["分类", LIFECYCLE_LABELS[item.classification] || item.classification], ["附加分类", item.categories.join(", ")],
    ["文件", item.maskedFilename], ["扫描范围", item.scope], ["来源", item.sourceType || "未识别"],
    ["文件ID", item.fileId || "未登记"], ["任务ID", item.taskId || "-"], ["执行记录ID", item.runId || "-"],
    ["文件大小", formatFileSize(item.fileSize)], ["创建时间", formatScheduledDate(item.fileCreatedAt)],
    ["修改时间", formatScheduledDate(item.fileModifiedAt)], ["数据库状态", item.databaseStatus || "无记录"],
    ["物理状态", item.physicalStatus], ["短哈希", item.shortHash || "-"], ["原因代码", item.reasonCode],
    ["识别用途", MANAGED_FILE_TYPE_LABELS[item.detectedFileType] || "未复核"],
    ["复核状态", FILE_REVIEW_STATUS_LABELS[item.reviewStatus] || item.reviewStatus || "待复核"],
    ["受管文件ID", item.managedFileId || "-"], ["复核时间", formatScheduledDate(item.reviewedAt)],
  ];
  $("lifecycleDetailBody").innerHTML = fields.map(([label, value]) => `<div><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join("");
  openManagementDialog("lifecycleDetailDialog");
}

async function fetchMabangResult(page = 1, { useDraft = false } = {}) {
  if (!currentMabangTask?.taskId) return;
  const taskId = currentMabangTask.taskId;
  const requestSeq = ++mabangResultRequestSeq;
  const query = useDraft ? $("mabangResultQuery").value.trim() : String(currentMabangTask.query || "");
  const field = useDraft ? $("mabangFilterField").value : String(currentMabangTask.filterField || "__all__");
  const params = new URLSearchParams({
    taskId,
    page: String(page),
    pageSize: $("mabangPageSize").value,
    query,
    field,
  });
  const response = await authorizedFetch(`/api/mabang-data/result?${params}`);
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new Error(data.error || "无法读取采集结果。");
  if (requestSeq !== mabangResultRequestSeq || currentMabangTask?.taskId !== taskId) return;
  renderMabangResult(data);
}

const SCHEDULE_STATUS_LABELS = {
  pending: "等待执行",
  running: "执行中",
  success: "成功",
  partial_success: "部分成功",
  failed: "失败",
  skipped: "已跳过",
  cancelled: "已取消",
};

const SCHEDULE_TASK_TYPE_LABELS = {
  order_export: "订单信息",
  inventory_export: "库存信息",
};

const PAYMENT_DATE_LABELS = {
  today: "当天",
  yesterday: "前一天",
  last_7_days: "近 7 天",
  last_14_days: "近 14 天",
  last_30_days: "近 30 天",
  this_week: "本周",
  previous_week: "上一周",
  this_month: "本月",
  previous_month: "上一个月",
  relative: "自定义相对日期",
  fixed: "固定日期范围",
};

const FILTER_OPTION_KEYS = {
  uq172: "managers",
  uq135: "shops",
  uq205: "platforms",
  uq108: "regions",
  uq137: "warehouses",
  uq136: "orderStatuses",
  uq119: "skus",
  uq128: "logisticsChannels",
};

function scheduleStatus(status) {
  const value = String(status || "");
  return `<span class="run-status ${esc(value)}">${esc(SCHEDULE_STATUS_LABELS[value] || value || "未执行")}</span>`;
}

function formatScheduledDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", { hour12: false });
}

function scheduledTimeText(task) {
  const config = task.scheduleConfig || {};
  const time = `${String(config.hour ?? 0).padStart(2, "0")}:${String(config.minute ?? 0).padStart(2, "0")}`;
  if (task.scheduleType === "daily") return `每天 ${time}`;
  if (task.scheduleType === "weekly") return `每周 ${(config.weekdays || []).map((day) => "一二三四五六日"[day - 1]).join("、")} ${time}`;
  const day = config.day === "last" ? "最后一天" : `${config.day} 日`;
  return `每月 ${day} ${time}`;
}

function scheduledDateRangeText(task) {
  if (task.taskType === "inventory_export") return "执行时点库存快照";
  if (task.paymentDateMode === "relative") {
    return `执行日前 ${task.paymentDateConfig.startDaysAgo} 天至 ${task.paymentDateConfig.endDaysAgo} 天`;
  }
  if (task.paymentDateMode === "fixed") return `${task.paymentDateConfig.startDate} 至 ${task.paymentDateConfig.endDate}`;
  return PAYMENT_DATE_LABELS[task.paymentDateMode] || task.paymentDateMode;
}

function taskFilter(task, fieldId) {
  return (task.filters || []).find((filter) => filter.fieldId === fieldId);
}

function taskFilterText(task, fieldId) {
  const values = taskFilter(task, fieldId)?.values || [];
  if (!values.length) return "全部";
  const visible = values.slice(0, 2).join("、");
  return values.length > 2 ? `${visible} 等 ${values.length} 项` : visible;
}

function fullTaskFilterText(task) {
  if (task.taskType === "inventory_export") return "完整库存快照，无订单筛选";
  if (!task.filters?.length) return "无筛选条件";
  return task.filters.map((filter) => `${filter.field || filter.fieldId}：${filter.values?.join(" 或 ") || filter.operator}`).join("；");
}

function renderScheduledSummary() {
  const enabled = scheduledState.tasks.filter((task) => task.enabled && !task.deleted).length;
  const deleted = scheduledState.tasks.filter((task) => task.deleted).length;
  const running = scheduledState.runs.filter((run) => ["pending", "running"].includes(run.status)).length;
  const failed = scheduledState.runs.filter((run) => ["failed", "partial_success"].includes(run.status)).length;
  const files = scheduledState.runs.filter((run) => run.fileStatus === "available").length;
  $("scheduledTaskSummary").innerHTML = [
    ["当前列表", scheduledState.tasks.length], ["已启用", enabled], ["已删除", deleted], ["等待 / 执行中", running],
    ["异常记录", failed], ["可下载文件", files],
  ].map(([label, value]) => `<div class="mabang-summary-item"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join("");
}

function renderScheduledTasks() {
  const tasks = scheduledState.tasks;
  $("scheduledTasksHint").textContent = tasks.length ? `共 ${tasks.length} 个任务，后台调度不依赖浏览器。` : "暂无定时任务";
  if (!tasks.length) {
    $("scheduledTasksTable").innerHTML = '<p class="order-filter-empty">尚未创建定时任务。</p>';
    return;
  }
  $("scheduledTasksTable").innerHTML = `
    <table class="mabang-data-table scheduled-table">
      <thead><tr><th>任务名称</th><th>导出内容</th><th>马帮账号</th><th>执行周期</th><th>数据范围</th><th>店长</th><th>店铺</th><th>状态</th><th>上次执行</th><th>下次执行</th><th>通知</th><th>操作</th></tr></thead>
      <tbody>${tasks.map((task) => `
        <tr class="${task.deleted ? "task-deleted-row" : ""}">
          <td><strong>${esc(task.name)}</strong><small>${esc(task.description || (task.taskType === "inventory_export" ? "库存快照导出" : "订单导出"))}</small>${task.deleted ? `<small>删除于 ${esc(formatScheduledDate(task.deletedAt))}${task.deleteReason ? ` · ${esc(task.deleteReason)}` : ""}</small>` : ""}</td>
          <td><span class="run-status ${task.taskType === "inventory_export" ? "inventory-type" : "order-type"}">${esc(SCHEDULE_TASK_TYPE_LABELS[task.taskType] || "订单信息")}</span></td>
          <td>${esc(task.accountName)}<small>${esc(task.accountUsernameMasked)}</small></td>
          <td>${esc(scheduledTimeText(task))}<small>${esc(task.timezone)}</small></td>
          <td>${esc(scheduledDateRangeText(task))}</td>
          <td>${task.taskType === "inventory_export" ? "-" : esc(taskFilterText(task, "uq172"))}</td>
          <td>${task.taskType === "inventory_export" ? "-" : esc(taskFilterText(task, "uq135"))}</td>
          <td>${task.deleted ? '<span class="run-status skipped">已删除</span>' : task.enabled ? '<span class="run-status enabled">启用</span>' : '<span class="run-status disabled">停用</span>'}<small>${task.lastRunStatus ? SCHEDULE_STATUS_LABELS[task.lastRunStatus] || task.lastRunStatus : "尚未执行"}</small></td>
          <td>${esc(formatScheduledDate(task.lastRunAt))}</td>
          <td>${esc(formatScheduledDate(task.nextRunAt))}</td>
          <td>${task.notifyEnabled && task.dingtalkConfigId ? '<span class="run-status enabled">已启用</span>' : '<span class="run-status disabled">未启用</span>'}<small>${esc(task.dingtalkName || "-")}</small></td>
          <td><div class="table-actions">${task.deleted ? `
            <button type="button" data-task-action="records" data-task-id="${esc(task.id)}">历史记录与文件</button>
            <button type="button" data-task-action="restore" data-task-id="${esc(task.id)}">恢复</button>
          ` : `
            <button type="button" data-task-action="edit" data-task-id="${esc(task.id)}">编辑</button>
            <button type="button" data-task-action="run" data-task-id="${esc(task.id)}">立即执行</button>
            <button type="button" data-task-action="toggle" data-task-id="${esc(task.id)}">${task.enabled ? "停用" : "启用"}</button>
            <button type="button" data-task-action="duplicate" data-task-id="${esc(task.id)}">复制</button>
            <button type="button" data-task-action="records" data-task-id="${esc(task.id)}">执行记录</button>
            <button class="danger-action" type="button" data-task-action="delete" data-task-id="${esc(task.id)}">删除</button>
          `}</div></td>
        </tr>`).join("")}</tbody>
    </table>`;
}

function renderScheduledRuns() {
  const runs = scheduledState.runs;
  $("scheduledRunsHint").textContent = runs.length ? `当前显示 ${runs.length} 条执行记录。` : "暂无执行记录。";
  if (!runs.length) {
    $("scheduledRunsTable").innerHTML = '<p class="order-filter-empty">当前条件下没有执行记录。</p>';
    return;
  }
  $("scheduledRunsTable").innerHTML = `
    <table class="mabang-data-table scheduled-table">
      <thead><tr><th>执行编号</th><th>任务</th><th>导出内容</th><th>计划时间</th><th>实际时间</th><th>状态</th><th>数据范围</th><th>数据统计</th><th>明细</th><th>文件</th><th>通知</th><th>错误摘要</th><th>操作</th></tr></thead>
      <tbody>${runs.map((run) => {
        const inventoryRun = run.taskType === "inventory_export";
        return `
        <tr>
          <td><strong>${esc(run.id.slice(0, 8))}</strong><small>${esc(run.triggerType)}</small></td>
          <td>${esc(run.taskName)}</td>
          <td><span class="run-status ${inventoryRun ? "inventory-type" : "order-type"}">${esc(SCHEDULE_TASK_TYPE_LABELS[run.taskType] || "订单信息")}</span></td>
          <td>${esc(formatScheduledDate(run.scheduledRunAt))}</td>
          <td>${esc(formatScheduledDate(run.startedAt))}</td><td>${scheduleStatus(run.status)}</td>
          <td>${inventoryRun ? "库存快照" : run.paymentStartDate ? `${esc(run.paymentStartDate)}<small>至 ${esc(run.paymentEndDate)}</small>` : "-"}</td>
          <td>${inventoryRun ? `${esc(run.rawOrderCount)} 报告 / ${esc(run.detailRowCount)} 导出` : `${esc(run.rawOrderCount)} / ${esc(run.filteredOrderCount)}`}</td><td>${esc(run.detailRowCount)}</td>
          <td>${run.fileStatus === "available" ? '<span class="run-status success">可下载</span>' : run.fileStatus === "expired" ? '<span class="run-status skipped">已过期</span>' : "-"}<small>${esc(run.filename || "")}</small></td>
          <td>${esc(run.notificationStatus || "-")}</td><td>${esc(run.errorMessage || "-")}</td>
          <td><div class="table-actions">
            <button type="button" data-run-action="detail" data-run-id="${esc(run.id)}">查看详情</button>
            ${run.exportFileId && run.fileStatus === "available" ? `<button type="button" data-run-action="download" data-run-id="${esc(run.id)}" data-file-id="${esc(run.exportFileId)}">下载</button>` : ""}
            ${!run.taskDeleted && ["failed", "partial_success", "skipped"].includes(run.status) ? `<button type="button" data-run-action="retry" data-run-id="${esc(run.id)}">重新执行</button>` : ""}
          </div></td>
        </tr>`;
      }).join("")}</tbody>
    </table>`;
}

function renderSchedulerStatus() {
  const online = scheduledState.meta?.scheduler?.online;
  $("schedulerStatusBadge").textContent = online ? "调度器在线" : "调度器未连接";
  $("schedulerStatusBadge").className = `status-badge ${online ? "success" : "error"}`;
}

async function refreshScheduledData({ quiet = false } = {}) {
  try {
    if (!quiet) setStatus("正在刷新定时任务状态…");
    const status = $("scheduledRunStatusFilter")?.value || "";
    const [meta, accounts, dingtalk, tasks, runs] = await Promise.all([
      apiJson("/api/mabang/scheduler-meta"),
      apiJson("/api/mabang/account-profiles"),
      apiJson("/api/notifications/dingtalk/configs"),
      apiJson(`/api/mabang/scheduled-tasks${$("scheduledIncludeDeleted")?.checked ? "?include_deleted=true" : ""}`),
      apiJson(`/api/mabang/scheduled-runs?limit=200${status ? `&status=${encodeURIComponent(status)}` : ""}`),
    ]);
    scheduledState.meta = meta;
    scheduledState.accounts = accounts.profiles || [];
    scheduledState.dingtalkConfigs = dingtalk.configs || [];
    scheduledState.tasks = tasks.tasks || [];
    scheduledState.runs = runs.runs || [];
    renderSchedulerStatus();
    renderScheduledSummary();
    renderScheduledTasks();
    renderScheduledRuns();
    populateScheduledConfigSelects();
    if (!quiet) setStatus("定时任务状态已刷新。", "success");
  } catch (error) {
    $("schedulerStatusBadge").textContent = "调度服务异常";
    $("schedulerStatusBadge").className = "status-badge error";
    if (!quiet) setStatus(error.message, "error");
    throw error;
  }
}

function populateScheduledConfigSelects() {
  const accountSelect = $("scheduledTaskAccount");
  const accountValue = accountSelect.value;
  accountSelect.innerHTML = scheduledState.accounts.map((profile) => `<option value="${esc(profile.id)}">${esc(profile.name)} · ${esc(profile.usernameMasked)}</option>`).join("");
  if (scheduledState.accounts.some((profile) => profile.id === accountValue)) accountSelect.value = accountValue;

  const robotSelect = $("scheduledTaskDingtalk");
  const robotValue = robotSelect.value;
  robotSelect.innerHTML = '<option value="">不使用机器人</option>' + scheduledState.dingtalkConfigs.map((config) => `<option value="${esc(config.id)}">${esc(config.name)}</option>`).join("");
  if (scheduledState.dingtalkConfigs.some((config) => config.id === robotValue)) robotSelect.value = robotValue;
}

function showFormError(id, message = "") {
  const element = $(id);
  element.textContent = message;
  element.hidden = !message;
}

function openManagementDialog(id) {
  const dialog = $(id);
  if (!dialog.open) dialog.showModal();
}

function closeManagementDialog(id) {
  const dialog = $(id);
  if (dialog.open) dialog.close();
}

function resetAccountForm() {
  $("mabangAccountProfileForm").reset();
  $("mabangAccountProfileId").value = "";
  $("mabangAccountProfileEnabled").checked = true;
  $("mabangAccountPasswordHint").textContent = "必填";
  $("mabangAccountProfilePassword").placeholder = "输入服务端保存的密码";
  showFormError("mabangAccountFormError");
}

function renderAccountProfiles() {
  $("mabangAccountProfileList").innerHTML = scheduledState.accounts.length ? scheduledState.accounts.map((profile) => `
    <div class="management-item">
      <div><strong>${esc(profile.name)}</strong><span>${esc(profile.usernameMasked)} · ${profile.passwordConfigured ? "密码已配置" : "未配置密码"} · ${profile.lastVerifyStatus === "success" ? "最近验证成功" : profile.lastVerifyStatus === "failed" ? "最近验证失败" : "尚未验证"}</span></div>
      <div class="management-item-actions">
        <button class="button-secondary" type="button" data-account-action="edit" data-account-id="${esc(profile.id)}">编辑</button>
        <button class="button-secondary" type="button" data-account-action="test" data-account-id="${esc(profile.id)}">测试登录</button>
        <button class="button-tertiary" type="button" data-account-action="delete" data-account-id="${esc(profile.id)}">删除</button>
      </div>
    </div>`).join("") : '<p class="order-filter-empty">尚未创建服务端马帮账号配置。</p>';
}

function editAccountProfile(id) {
  const profile = scheduledState.accounts.find((item) => item.id === id);
  if (!profile) return;
  $("mabangAccountProfileId").value = profile.id;
  $("mabangAccountProfileName").value = profile.name;
  $("mabangAccountProfileUsername").value = profile.username;
  $("mabangAccountProfilePassword").value = "";
  $("mabangAccountProfilePassword").placeholder = "已配置；留空则不修改";
  $("mabangAccountPasswordHint").textContent = "已配置，留空不修改";
  $("mabangAccountProfileEnabled").checked = profile.enabled;
}

async function saveAccountProfile(event) {
  event.preventDefault();
  showFormError("mabangAccountFormError");
  const id = $("mabangAccountProfileId").value;
  try {
    await apiJson(id ? `/api/mabang/account-profiles/${encodeURIComponent(id)}` : "/api/mabang/account-profiles", {
      method: id ? "PUT" : "POST",
      body: {
        name: $("mabangAccountProfileName").value,
        username: $("mabangAccountProfileUsername").value,
        password: $("mabangAccountProfilePassword").value,
        enabled: $("mabangAccountProfileEnabled").checked,
      },
    });
    await refreshScheduledData({ quiet: true });
    renderAccountProfiles();
    resetAccountForm();
    setStatus("马帮账号配置已保存。", "success");
  } catch (error) {
    showFormError("mabangAccountFormError", error.message);
  }
}

function resetDingtalkForm() {
  $("dingtalkConfigForm").reset();
  $("dingtalkConfigId").value = "";
  $("dingtalkEnabled").checked = true;
  $("dingtalkNotifySuccess").checked = true;
  $("dingtalkNotifyFailure").checked = true;
  $("dingtalkNotifyEmpty").checked = true;
  $("dingtalkWebhookUrl").placeholder = "https://oapi.dingtalk.com/robot/send?...";
  $("dingtalkSecret").placeholder = "开启加签时填写";
  showFormError("dingtalkFormError");
}

function renderDingtalkConfigs() {
  $("dingtalkConfigList").innerHTML = scheduledState.dingtalkConfigs.length ? scheduledState.dingtalkConfigs.map((config) => `
    <div class="management-item">
      <div><strong>${esc(config.name)}</strong><span>Webhook 已配置${config.secretConfigured ? " · 加签已配置" : ""} · ${config.enabled ? "已启用" : "已停用"}</span></div>
      <div class="management-item-actions">
        <button class="button-secondary" type="button" data-dingtalk-action="edit" data-dingtalk-id="${esc(config.id)}">编辑</button>
        <button class="button-secondary" type="button" data-dingtalk-action="test" data-dingtalk-id="${esc(config.id)}">测试机器人</button>
        <button class="button-tertiary" type="button" data-dingtalk-action="delete" data-dingtalk-id="${esc(config.id)}">删除</button>
      </div>
    </div>`).join("") : '<p class="order-filter-empty">尚未创建钉钉机器人配置。</p>';
}

function editDingtalkConfig(id) {
  const config = scheduledState.dingtalkConfigs.find((item) => item.id === id);
  if (!config) return;
  $("dingtalkConfigId").value = config.id;
  $("dingtalkConfigName").value = config.name;
  $("dingtalkWebhookUrl").value = "";
  $("dingtalkWebhookUrl").placeholder = "已配置；留空则不修改";
  $("dingtalkSecret").value = "";
  $("dingtalkSecret").placeholder = config.secretConfigured ? "已配置；留空则不修改" : "未配置";
  $("dingtalkAtMobiles").value = (config.atMobiles || []).join(", ");
  $("dingtalkEnabled").checked = config.enabled;
  $("dingtalkAtAll").checked = config.atAll;
  $("dingtalkNotifySuccess").checked = config.notifyOnSuccess;
  $("dingtalkNotifyFailure").checked = config.notifyOnFailure;
  $("dingtalkNotifyEmpty").checked = config.notifyOnEmpty;
}

async function saveDingtalkConfig(event) {
  event.preventDefault();
  showFormError("dingtalkFormError");
  const id = $("dingtalkConfigId").value;
  try {
    await apiJson(id ? `/api/notifications/dingtalk/configs/${encodeURIComponent(id)}` : "/api/notifications/dingtalk/configs", {
      method: id ? "PUT" : "POST",
      body: {
        name: $("dingtalkConfigName").value,
        webhookUrl: $("dingtalkWebhookUrl").value,
        secret: $("dingtalkSecret").value,
        atMobiles: $("dingtalkAtMobiles").value,
        enabled: $("dingtalkEnabled").checked,
        atAll: $("dingtalkAtAll").checked,
        notifyOnSuccess: $("dingtalkNotifySuccess").checked,
        notifyOnFailure: $("dingtalkNotifyFailure").checked,
        notifyOnEmpty: $("dingtalkNotifyEmpty").checked,
      },
    });
    await refreshScheduledData({ quiet: true });
    renderDingtalkConfigs();
    resetDingtalkForm();
    setStatus("钉钉机器人配置已保存。", "success");
  } catch (error) {
    showFormError("dingtalkFormError", error.message);
  }
}

function updateScheduledFormVisibility() {
  const inventoryTask = $("scheduledTaskType").value === "inventory_export";
  const type = $("scheduledTaskScheduleType").value;
  $("scheduledWeeklyConfig").hidden = type !== "weekly";
  $("scheduledMonthlyConfig").hidden = type !== "monthly";
  const dateMode = $("scheduledTaskDateMode").value;
  $("scheduledOrderDateSection").hidden = inventoryTask;
  $("scheduledOrderFilterSection").hidden = inventoryTask;
  $("scheduledInventoryScopeSection").hidden = !inventoryTask;
  $("scheduledRelativeDateConfig").hidden = inventoryTask || dateMode !== "relative";
  $("scheduledFixedDateConfig").hidden = inventoryTask || dateMode !== "fixed";
  $("scheduledTaskName").placeholder = inventoryTask ? "例如：菲律宾仓库每日库存" : "例如：菲律宾兰双满每日订单";
}

function scheduledFieldOptions(selected = "") {
  const fields = scheduledState.meta?.fields || [];
  const primary = new Set(scheduledState.meta?.primaryFilterIds || []);
  return [...fields].sort((a, b) => Number(primary.has(b.id)) - Number(primary.has(a.id))).map((field) => `
    <option value="${esc(field.id)}"${field.id === selected ? " selected" : ""}>${primary.has(field.id) ? "常用 · " : ""}${esc(field.label)}</option>`).join("");
}

function valuesFromScheduledFilterRow(row) {
  const selected = [...row.querySelectorAll(".scheduled-filter-suggestions option:checked")].map((option) => option.value);
  const custom = row.querySelector(".scheduled-filter-values textarea").value.split(/[\n,，;；]+/).map((value) => value.trim()).filter(Boolean);
  return [...new Set([...selected, ...custom])];
}

function refreshScheduledFilterSuggestions() {
  const options = scheduledState.filterOptions || {};
  const managerValues = [...document.querySelectorAll('.scheduled-filter-row[data-field-id="uq172"]')].flatMap(valuesFromScheduledFilterRow);
  document.querySelectorAll(".scheduled-filter-row").forEach((row) => {
    const fieldId = row.querySelector(".scheduled-filter-field").value;
    row.dataset.fieldId = fieldId;
    const key = FILTER_OPTION_KEYS[fieldId];
    let values = key ? options[key] || [] : [];
    if (fieldId === "uq135" && managerValues.length && options.managerShops) {
      values = [...new Set(managerValues.flatMap((manager) => options.managerShops[manager] || []))];
    }
    const select = row.querySelector(".scheduled-filter-suggestions");
    const current = new Set([...select.selectedOptions].map((option) => option.value));
    select.innerHTML = values.map((value) => `<option value="${esc(value)}"${current.has(value) ? " selected" : ""}>${esc(value)}</option>`).join("");
    select.hidden = !values.length;
  });
}

async function loadScheduledFilterOptions(accountProfileId) {
  if (!accountProfileId) {
    scheduledState.filterOptions = {};
    refreshScheduledFilterSuggestions();
    return;
  }
  const data = await apiJson(`/api/mabang/scheduler-filter-options?accountProfileId=${encodeURIComponent(accountProfileId)}`);
  scheduledState.filterOptions = data.options || {};
  refreshScheduledFilterSuggestions();
}

function refreshScheduledFilterEmptyState() {
  $("scheduledFilterEmpty").hidden = Boolean(document.querySelector(".scheduled-filter-row"));
}

function addScheduledFilter(initial = {}) {
  const fields = scheduledState.meta?.fields || [];
  if (!fields.length) return;
  const id = ++scheduledFilterSequence;
  const fieldId = fields.some((field) => field.id === initial.fieldId) ? initial.fieldId : (scheduledState.meta.primaryFilterIds || [])[0] || fields[0].id;
  const operator = ["equals", "contains", "notEquals", "notContains", "empty", "notEmpty"].includes(initial.operator) ? initial.operator : "equals";
  const row = document.createElement("div");
  row.className = "scheduled-filter-row";
  row.dataset.fieldId = fieldId;
  row.innerHTML = `
    <label class="field-block"><span>字段</span><select class="scheduled-filter-field" aria-label="第 ${id} 个任务筛选字段">${scheduledFieldOptions(fieldId)}</select></label>
    <label class="field-block"><span>匹配方式</span><select class="scheduled-filter-operator">
      <option value="equals"${operator === "equals" ? " selected" : ""}>等于任一值</option>
      <option value="contains"${operator === "contains" ? " selected" : ""}>包含任一值</option>
      <option value="notEquals"${operator === "notEquals" ? " selected" : ""}>不等于所有值</option>
      <option value="notContains"${operator === "notContains" ? " selected" : ""}>不包含所有值</option>
      <option value="empty"${operator === "empty" ? " selected" : ""}>为空</option>
      <option value="notEmpty"${operator === "notEmpty" ? " selected" : ""}>非空</option>
    </select></label>
    <label class="field-block scheduled-filter-values"><span>多选值 <small>每行一个，可多选建议值</small></span>
      <select class="scheduled-filter-suggestions" multiple size="3" hidden></select>
      <textarea rows="2" placeholder="输入自定义值，每行一个">${esc((initial.values || []).join("\n"))}</textarea>
    </label>
    <button class="scheduled-filter-remove" type="button" aria-label="移除此筛选条件" title="移除筛选条件">×</button>`;
  const updateDisabled = () => {
    const disabled = ["empty", "notEmpty"].includes(row.querySelector(".scheduled-filter-operator").value);
    row.querySelector("textarea").disabled = disabled;
    row.querySelector(".scheduled-filter-suggestions").disabled = disabled;
  };
  row.querySelector(".scheduled-filter-field").addEventListener("change", refreshScheduledFilterSuggestions);
  row.querySelector(".scheduled-filter-operator").addEventListener("change", updateDisabled);
  row.querySelector(".scheduled-filter-suggestions").addEventListener("change", refreshScheduledFilterSuggestions);
  row.querySelector("textarea").addEventListener("change", refreshScheduledFilterSuggestions);
  row.querySelector(".scheduled-filter-remove").addEventListener("click", () => {
    row.remove();
    refreshScheduledFilterEmptyState();
    refreshScheduledFilterSuggestions();
  });
  $("scheduledFilterList").appendChild(row);
  updateDisabled();
  refreshScheduledFilterEmptyState();
  refreshScheduledFilterSuggestions();
}

function collectScheduledFilters() {
  return [...document.querySelectorAll(".scheduled-filter-row")].map((row, index) => {
    const fieldId = row.querySelector(".scheduled-filter-field").value;
    const operator = row.querySelector(".scheduled-filter-operator").value;
    const values = valuesFromScheduledFilterRow(row);
    if (!["empty", "notEmpty"].includes(operator) && !values.length) throw new Error(`请填写第 ${index + 1} 个筛选条件的值。`);
    return { fieldId, operator, values };
  });
}

function taskFormPayload() {
  const [hour, minute] = $("scheduledTaskTime").value.split(":").map(Number);
  const taskType = $("scheduledTaskType").value;
  const inventoryTask = taskType === "inventory_export";
  const scheduleType = $("scheduledTaskScheduleType").value;
  const scheduleConfig = { hour, minute };
  if (scheduleType === "weekly") scheduleConfig.weekdays = [...$("scheduledWeeklyConfig").querySelectorAll("input:checked")].map((input) => Number(input.value));
  if (scheduleType === "monthly") {
    const day = $("scheduledTaskMonthDay").value;
    scheduleConfig.day = day === "last" ? "last" : Number(day);
    scheduleConfig.monthEndFallback = true;
  }
  const paymentDateMode = inventoryTask ? "snapshot" : $("scheduledTaskDateMode").value;
  let paymentDateConfig = {};
  if (!inventoryTask && paymentDateMode === "relative") paymentDateConfig = { startDaysAgo: Number($("scheduledRelativeStart").value), endDaysAgo: Number($("scheduledRelativeEnd").value) };
  if (!inventoryTask && paymentDateMode === "fixed") paymentDateConfig = { startDate: $("scheduledFixedStart").value, endDate: $("scheduledFixedEnd").value };
  return {
    taskType,
    name: $("scheduledTaskName").value,
    description: $("scheduledTaskDescription").value,
    accountProfileId: $("scheduledTaskAccount").value,
    dingtalkConfigId: $("scheduledTaskDingtalk").value || null,
    scheduleType,
    scheduleConfig,
    timezone: $("scheduledTaskTimezone").value,
    paymentDateMode,
    paymentDateConfig,
    filters: inventoryTask ? [] : collectScheduledFilters(),
    enabled: $("scheduledTaskEnabled").checked,
    fileRetentionDays: $("scheduledTaskRetention").value,
    notifyEnabled: $("scheduledTaskNotify").checked,
    catchUpEnabled: $("scheduledTaskCatchUp").checked,
  };
}

async function openScheduledTaskDialog(task = null) {
  if (!scheduledState.accounts.length) {
    renderAccountProfiles();
    resetAccountForm();
    openManagementDialog("mabangAccountDialog");
    setStatus("请先创建一个服务端马帮账号配置。", "warning");
    return;
  }
  $("scheduledTaskForm").reset();
  $("scheduledTaskId").value = task?.id || "";
  $("scheduledTaskDialogTitle").textContent = task ? "编辑定时任务" : "新建定时任务";
  $("scheduledFilterList").innerHTML = "";
  populateScheduledConfigSelects();
  $("scheduledTaskEnabled").checked = task?.enabled ?? true;
  $("scheduledTaskCatchUp").checked = task?.catchUpEnabled ?? true;
  $("scheduledTaskNotify").checked = task?.notifyEnabled ?? true;
  $("scheduledTaskType").value = task?.taskType || "order_export";
  $("scheduledTaskName").value = task?.name || "";
  $("scheduledTaskDescription").value = task?.description || "";
  $("scheduledTaskAccount").value = task?.accountProfileId || scheduledState.accounts[0].id;
  $("scheduledTaskDingtalk").value = task?.dingtalkConfigId || "";
  $("scheduledTaskScheduleType").value = task?.scheduleType || "daily";
  $("scheduledTaskTime").value = `${String(task?.scheduleConfig?.hour ?? 8).padStart(2, "0")}:${String(task?.scheduleConfig?.minute ?? 30).padStart(2, "0")}`;
  $("scheduledTaskTimezone").value = task?.timezone || "Asia/Shanghai";
  $("scheduledTaskDateMode").value = task?.paymentDateMode || "yesterday";
  $("scheduledRelativeStart").value = task?.paymentDateConfig?.startDaysAgo ?? 7;
  $("scheduledRelativeEnd").value = task?.paymentDateConfig?.endDaysAgo ?? 1;
  $("scheduledFixedStart").value = task?.paymentDateConfig?.startDate || "";
  $("scheduledFixedEnd").value = task?.paymentDateConfig?.endDate || "";
  $("scheduledTaskRetention").value = String(task?.fileRetentionDays ?? 30);
  $("scheduledTaskMonthDay").value = String(task?.scheduleConfig?.day ?? 1);
  $("scheduledWeeklyConfig").querySelectorAll("input").forEach((input) => {
    input.checked = (task?.scheduleConfig?.weekdays || [1]).includes(Number(input.value));
  });
  updateScheduledFormVisibility();
  showFormError("scheduledTaskFormError");
  openManagementDialog("scheduledTaskDialog");
  await loadScheduledFilterOptions($("scheduledTaskAccount").value).catch(() => {});
  (task?.filters || []).forEach(addScheduledFilter);
  refreshScheduledFilterEmptyState();
}

async function saveScheduledTask(event) {
  event.preventDefault();
  showFormError("scheduledTaskFormError");
  const id = $("scheduledTaskId").value;
  try {
    await apiJson(id ? `/api/mabang/scheduled-tasks/${encodeURIComponent(id)}` : "/api/mabang/scheduled-tasks", {
      method: id ? "PUT" : "POST",
      body: taskFormPayload(),
    });
    closeManagementDialog("scheduledTaskDialog");
    await refreshScheduledData({ quiet: true });
    setStatus(id ? "定时任务已更新。" : "定时任务已创建。", "success");
  } catch (error) {
    showFormError("scheduledTaskFormError", error.message);
  }
}

function showScheduledView(view, taskId = "") {
  scheduledState.activeView = view === "runs" ? "runs" : "tasks";
  $("scheduledTasksView").hidden = scheduledState.activeView !== "tasks";
  $("scheduledRunsView").hidden = scheduledState.activeView !== "runs";
  $("toggleScheduledRunsBtn").textContent = scheduledState.activeView === "runs" ? "返回任务列表" : "执行记录";
  if (taskId) {
    $("scheduledRunStatusFilter").value = "";
    apiJson(`/api/mabang/scheduled-runs?limit=200&taskId=${encodeURIComponent(taskId)}`).then((data) => {
      scheduledState.runs = data.runs || [];
      renderScheduledRuns();
      renderScheduledSummary();
    }).catch((error) => setStatus(error.message, "error"));
  }
}

async function openRunNowConfirmation(task) {
  const preview = await apiJson(`/api/mabang/scheduled-tasks/${encodeURIComponent(task.id)}/preview`, { method: "POST", body: {} });
  const inventoryTask = task.taskType === "inventory_export";
  currentRunNowTaskId = task.id;
  $("runNowConfirmTitle").textContent = `立即执行：${task.name}`;
  $("runNowConfirmContent").innerHTML = `<dl>
    <div><dt>导出内容</dt><dd>${esc(SCHEDULE_TASK_TYPE_LABELS[task.taskType] || "订单信息")}</dd></div>
    <div><dt>数据范围</dt><dd>${inventoryTask ? "执行时点完整库存快照" : `${esc(preview.paymentDateRange.startDate)} 至 ${esc(preview.paymentDateRange.endDate)}`}</dd></div>
    <div><dt>马帮账号</dt><dd>${esc(task.accountName)} · ${esc(task.accountUsernameMasked)}</dd></div>
    <div><dt>${inventoryTask ? "库存范围" : "筛选条件"}</dt><dd>${esc(fullTaskFilterText(task))}</dd></div>
    <div><dt>钉钉通知</dt><dd>${task.notifyEnabled && task.dingtalkConfigId ? esc(task.dingtalkName) : "未启用"}</dd></div>
  </dl>`;
  openManagementDialog("runNowConfirmDialog");
}

async function confirmRunNow() {
  if (!currentRunNowTaskId) return;
  try {
    const result = await apiJson(`/api/mabang/scheduled-tasks/${encodeURIComponent(currentRunNowTaskId)}/run-now`, { method: "POST", body: {} });
    closeManagementDialog("runNowConfirmDialog");
    currentRunNowTaskId = null;
    showScheduledView("runs");
    await refreshScheduledData({ quiet: true });
    setStatus(`任务已提交后台，执行编号 ${result.runId.slice(0, 8)}。`, "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function handleScheduledTaskAction(button) {
  const task = scheduledState.tasks.find((item) => item.id === button.dataset.taskId);
  if (!task) return;
  const action = button.dataset.taskAction;
  if (action === "edit") return openScheduledTaskDialog(task);
  if (action === "run") return openRunNowConfirmation(task);
  if (action === "records") return showScheduledView("runs", task.id);
  if (action === "restore") {
    if (!confirm(`确定恢复定时任务“${task.name}”吗？恢复后任务保持停用，不会补执行删除期间错过的计划。`)) return;
    const result = await apiJson(`/api/mabang/scheduled-tasks/${encodeURIComponent(task.id)}/restore`, { method: "POST", body: {} });
    await refreshScheduledData({ quiet: true });
    setStatus(result.warning || "定时任务已恢复并保持停用。", result.warning ? "warning" : "success");
    return;
  }
  if (action === "delete" && !confirm(`确定删除定时任务“${task.name}”吗？历史执行记录和已生成文件会继续保留。`)) return;
  if (action === "delete") {
    const reason = prompt("可选：填写删除原因（最多 240 个字符）", "");
    if (reason === null) return;
    await apiJson(`/api/mabang/scheduled-tasks/${encodeURIComponent(task.id)}`, { method: "DELETE", body: { reason } });
    await refreshScheduledData({ quiet: true });
    setStatus("定时任务已软删除，历史记录和文件仍然保留。", "success");
    return;
  }
  const endpoint = action === "toggle" ? (task.enabled ? "disable" : "enable") : action;
  await apiJson(`/api/mabang/scheduled-tasks/${encodeURIComponent(task.id)}/${endpoint}`, { method: "POST", body: {} });
  await refreshScheduledData({ quiet: true });
  setStatus("定时任务状态已更新。", "success");
}

async function showRunDetails(runId) {
  const data = await apiJson(`/api/mabang/scheduled-runs/${encodeURIComponent(runId)}`);
  const run = data.run;
  const inventoryRun = run.taskType === "inventory_export";
  $("scheduledRunDetailTitle").textContent = `${run.taskName} · ${run.id.slice(0, 8)}`;
  $("scheduledRunDetailSubtitle").textContent = `${SCHEDULE_STATUS_LABELS[run.status] || run.status} · ${formatScheduledDate(run.scheduledRunAt)}`;
  $("scheduledRunDetailContent").innerHTML = `
    <div class="run-detail-grid">
      <div><span>导出内容</span><strong>${esc(SCHEDULE_TASK_TYPE_LABELS[run.taskType] || "订单信息")}</strong></div>
      <div><span>数据范围</span><strong>${inventoryRun ? "执行时点完整库存快照" : `${esc(run.paymentStartDate || "-")} 至 ${esc(run.paymentEndDate || "-")}`}</strong></div>
      <div><span>${inventoryRun ? "库存统计" : "订单统计"}</span><strong>${inventoryRun ? `${esc(run.rawOrderCount)} 报告 / ${esc(run.detailRowCount)} 导出明细` : `${esc(run.rawOrderCount)} 原始 / ${esc(run.filteredOrderCount)} 筛选 / ${esc(run.detailRowCount)} 明细`}</strong></div>
      <div><span>通知状态</span><strong>${esc(run.notificationStatus || "-")}</strong></div>
      <div><span>重试次数</span><strong>${esc(run.retryCount)}</strong></div>
      <div><span>${inventoryRun ? "库存范围" : "筛选条件"}</span><strong>${esc(fullTaskFilterText(run.task))}</strong></div>
      <div><span>错误摘要</span><strong>${esc(run.errorMessage || "无")}</strong></div>
    </div>
    <div class="run-event-list">${(run.events || []).map((event) => `
      <div class="run-event-item"><strong>${esc(event.stage)}</strong>${scheduleStatus(event.status)}<span>${event.durationMs == null ? "-" : `${event.durationMs} ms`}</span><span>${esc(event.message || "-")}</span></div>`).join("") || '<p class="order-filter-empty">暂无步骤日志。</p>'}</div>`;
  openManagementDialog("scheduledRunDetailDialog");
}

async function handleScheduledRunAction(button) {
  const id = button.dataset.runId;
  if (button.dataset.runAction === "detail") return showRunDetails(id);
  if (button.dataset.runAction === "download") {
    const fileId = button.dataset.fileId;
    return downloadMabangExportFile(fileId);
  }
  if (button.dataset.runAction === "retry") {
    const result = await apiJson(`/api/mabang/scheduled-runs/${encodeURIComponent(id)}/retry`, { method: "POST", body: {} });
    await refreshScheduledData({ quiet: true });
    setStatus(`重试任务已提交，执行编号 ${result.runId.slice(0, 8)}。`, "success");
  }
}

function renderRating(products, modules) {
  const mine = products[0];
  const comp = products[1];
  if (!mine) return "";
  if (!comp) {
    return `
      <section>
        <h2>评分、评价数与销量</h2>
        <table>
          <tr><th>项目</th><th>我的链接</th></tr>
          <tr><td>评分</td><td>${esc(mine.rating)}</td></tr>
          <tr><td>评价数</td><td>${esc(mine.reviewCount)}</td></tr>
          <tr><td>销量</td><td>${esc(mine.soldCount)}</td></tr>
        </table>
        ${renderInsights([...(modules?.ratingReviews || []), ...(modules?.sales || [])])}
      </section>
    `;
  }
  const ratingAdv = Number(mine.rating) > Number(comp.rating) ? "我的优势" : Number(mine.rating) < Number(comp.rating) ? "竞品优势" : "持平";
  const reviewAdv = Number(mine.reviewCount) > Number(comp.reviewCount) ? "我的优势" : Number(mine.reviewCount) < Number(comp.reviewCount) ? "竞品优势" : "持平";
  const soldAdv = Number(mine.soldCount) > Number(comp.soldCount) ? "我的优势" : Number(mine.soldCount) < Number(comp.soldCount) ? "竞品优势" : "持平";
  return `
    <section>
      <h2>评分、评价数与销量对比</h2>
      <table>
        <tr><th>项目</th><th>我的链接</th><th>竞品链接</th><th>优势方</th></tr>
        <tr><td>评分</td><td>${esc(mine.rating)}</td><td>${esc(comp.rating)}</td><td>${ratingAdv}</td></tr>
        <tr><td>评价数</td><td>${esc(mine.reviewCount)}</td><td>${esc(comp.reviewCount)}</td><td>${reviewAdv}</td></tr>
        <tr><td>销量</td><td>${esc(mine.soldCount)}</td><td>${esc(comp.soldCount)}</td><td>${soldAdv}</td></tr>
      </table>
      ${renderInsights([...(modules?.ratingReviews || []), ...(modules?.sales || [])])}
    </section>
  `;
}

function renderSkuComparison(rows, modules) {
  return `
    <section>
      <h2>SKU 横向价格对比</h2>
      <table>
        <tr><th>归一名称</th><th>我的 SKU</th><th>我的 SKU 图</th><th>我的价格</th><th>竞品 SKU</th><th>竞品 SKU 图</th><th>竞品价格</th><th>库存</th><th>优势</th><th>匹配依据</th></tr>
        ${(rows || []).map((row) => `
          <tr>
            <td>${esc(row.normalizedName || row.mySku?.name || row.competitorSku?.name || "-")}</td>
            <td>${esc(row.mySku?.name || "-")}</td>
            <td>${renderSkuImage(row.mySku?.image)}</td>
            <td>${esc(row.mySku?.salePrice || "-")}</td>
            <td>${esc(row.competitorSku?.name || "-")}</td>
            <td>${renderSkuImage(row.competitorSku?.image)}</td>
            <td>${esc(row.competitorSku?.salePrice || "-")}</td>
            <td>${esc(row.mySku?.stock ?? row.competitorSku?.stock ?? "-")}</td>
            <td>${advantageText(row.advantage)}</td>
            <td>${esc(row.matchReason || row.sortText || "-")}${row.matchScore ? `<div class="muted">相似度：${esc(Math.round(Number(row.matchScore) * 100))}%</div>` : ""}</td>
          </tr>
        `).join("")}
      </table>
      ${renderInsights(modules?.skuComparison)}
    </section>
  `;
}

function renderDetails(rows, modules) {
  return `
    <section>
      <h2>Product Specifications 差异与优势</h2>
      <table>
        <tr><th>属性</th><th>我的链接</th><th>竞品链接</th><th>优势方</th></tr>
        ${(rows || []).map((row) => `
          <tr>
            <td>${esc(row.key)}</td>
            <td>${esc(row.mine)}</td>
            <td>${esc(row.competitor)}</td>
            <td>${advantageText(row.advantage)}</td>
          </tr>
        `).join("")}
      </table>
      ${renderInsights(modules?.productDetails)}
    </section>
  `;
}

function renderReport(report) {
  if (emptyStateEl) emptyStateEl.hidden = true;
  if (report.needsVerification) {
    renderVerification(report);
    return;
  }
  const modules = report.analysis?.modules || null;
  if (report.discovery) {
    const sections = [
      renderDiscoverySummary(report, modules),
      renderProducts(report.products || [], modules),
    ];
    if (report.analysis) {
      sections.push(`<section class="panel"><h2>TOP5 结论建议</h2>${renderInsights(modules?.recommendations || (report.analysis?.raw ? [report.analysis.raw] : []))}</section>`);
    }
    if (report.mainImageAnalysis) sections.push(renderMainImageAnalysis(report.mainImageAnalysis));
    resultsEl.innerHTML = sections.join("");
    hydrateProtectedImages(resultsEl);
    return;
  }
  const sections = [
    renderProducts(report.products || [], modules),
    renderRating(report.products || [], modules),
    renderSkuComparison(report.skuComparison || [], modules),
    renderDetails(report.productDetailsComparison || [], modules),
  ];
  if (report.analysis) {
    sections.push(`<section class="panel"><h2>结论建议</h2>${renderInsights(modules?.recommendations || (report.analysis?.raw ? [report.analysis.raw] : []))}</section>`);
  }
  if (report.mainImageAnalysis) sections.push(renderMainImageAnalysis(report.mainImageAnalysis));
  resultsEl.innerHTML = sections.join("");
  hydrateProtectedImages(resultsEl);
}

function plainTextFromHtml(html) {
  const div = document.createElement("div");
  div.innerHTML = html || "";
  return div.textContent || div.innerText || "";
}

function exportExcel() {
  if (!currentReport) {
    setStatus("请先获取信息，再导出 Excel。");
    return;
  }

  const products = currentReport.products || [];
  const modules = currentReport.analysis?.modules || {};
  const discovery = currentReport.discovery || null;
  const reference = discovery?.referenceProduct || {};
  const excel = createExcelHtmlRenderer();
  const excelCell = excel.text;
  const excelLink = excel.link;
  const excelTable = excel.table;
  const discoveryRows = discovery ? [
    ["站点", excelCell(platformName(discovery.platform))],
    ["国家", excelCell(String(discovery.country || "").toUpperCase())],
    ["原始关键词", excelCell(discovery.originalKeyword || discovery.keyword)],
    ["实际搜索关键词", excelCell(discovery.keyword)],
    ["关键词优化说明", excelCell(discovery.keywordOptimizationReason || "")],
    ["参考产品描述", excelCell(reference.description || "")],
    ["参考产品图片", reference.image?.dataUrl ? excelLink(reference.image.dataUrl, reference.image.name || "参考产品图片") : ""],
  ] : [];
  const productRows = products.map((product, index) => [
    excelCell(currentReport.discovery ? `TOP ${index + 1}` : index === 0 ? "我的链接" : `竞品 ${index}`),
    excelCell(platformName(product.platform)),
    excelCell(product.title),
    excelCell(product.shopName),
    excelCell(product.rating),
    excelCell(product.reviewCount),
    excelCell(product.soldCount),
    excelLink(product.finalUrl || product.inputUrl, product.finalUrl || product.inputUrl),
    excelLink(product.mainImage, product.mainImage),
  ]);

  const skuRows = (currentReport.skuComparison || []).map((row) => [
    excelCell(row.normalizedName || row.mySku?.name || row.competitorSku?.name || "-"),
    excelCell(row.mySku?.name || "-"),
    excelLink(row.mySku?.image, row.mySku?.image || ""),
    excelCell(row.mySku?.salePrice || "-"),
    excelCell(row.competitorSku?.name || "-"),
    excelLink(row.competitorSku?.image, row.competitorSku?.image || ""),
    excelCell(row.competitorSku?.salePrice || "-"),
    excelCell(row.mySku?.stock ?? ""),
    excelCell(row.competitorSku?.stock ?? ""),
    excelCell(plainTextFromHtml(advantageText(row.advantage))),
    excelCell(row.difference ?? ""),
    excelCell(row.matchReason || ""),
    excelCell(row.matchScore ? `${Math.round(Number(row.matchScore) * 100)}%` : ""),
  ]);

  const detailRows = (currentReport.productDetailsComparison || []).map((row) => [
    excelCell(row.key),
    excelCell(row.mine),
    excelCell(row.competitor),
    excelCell(plainTextFromHtml(advantageText(row.advantage))),
  ]);

  const analysisRows = [
    ...(modules.titleShop || []).map((text) => ["标题/店铺", excelCell(text)]),
    ...(modules.images || []).map((text) => ["图片", excelCell(text)]),
    ...(modules.ratingReviews || []).map((text) => ["评分/评价", excelCell(text)]),
    ...(modules.sales || []).map((text) => ["销量", excelCell(text)]),
    ...(modules.skuComparison || []).map((text) => ["SKU 对比", excelCell(text)]),
    ...(modules.productDetails || []).map((text) => ["Product Specifications", excelCell(text)]),
    ...(modules.recommendations || []).map((text) => ["结论建议", excelCell(text)]),
  ];
  if (!analysisRows.length && currentReport.analysis?.raw) analysisRows.push(["DeepSeek 原文", excelCell(currentReport.analysis.raw)]);

  const html = `<!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <style>
          body { font-family: Arial, sans-serif; }
          table { border-collapse: collapse; margin-bottom: 24px; }
          th, td { border: 1px solid #999; padding: 6px 8px; vertical-align: top; mso-number-format:"\\@"; }
          th { background: #eef4f8; }
        </style>
      </head>
      <body>
        ${discoveryRows.length ? excelTable("TOP5 搜索信息", ["项目", "内容"], discoveryRows) : ""}
        ${excelTable("商品信息", ["角色", "平台", "标题", "店铺", "评分", "评价数", "销量", "页面链接", "主图链接"], productRows)}
        ${excelTable("SKU 横向价格对比", ["归一名称", "我的 SKU", "我的 SKU 图", "我的价格", "竞品 SKU", "竞品 SKU 图", "竞品价格", "我的库存", "竞品库存", "优势", "差价", "匹配依据", "相似度"], skuRows)}
        ${excelTable("Product Specifications 差异与优势", ["属性", "我的链接", "竞品链接", "优势方"], detailRows)}
        ${excelTable("DeepSeek 分析", ["模块", "内容"], analysisRows)}
      </body>
    </html>`;

  const blob = new Blob(["\ufeff", html], { type: "application/vnd.ms-excel;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `marketplace-report-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.xls`;
  document.body.appendChild(link);
  link.click();
  URL.revokeObjectURL(link.href);
  link.remove();
  auditPage.recordClientAction(currentReport.discovery ? "competitor.keyword_export.download" : "competitor.export.download", currentReport.discovery ? "keyword" : "link");
  if (excel.sanitizedCount > 0) {
    console.info(`Excel cell sanitization: fileId=browser-export sheet=all count=${excel.sanitizedCount}`);
  }
  setWorkflowStep(4, 4);
  setStatus("Excel 已导出。", "success");
}

$("openChromeBtn").addEventListener("click", async () => {
  try {
    const url = $("myUrl").value.trim() || "https://www.lazada.com.ph/";
    setStatus("正在打开主服务器 Chrome 验证浏览器…");
    await postJson("/api/chrome/navigate", { url });
    setStatus("已打开。若出现验证码，请在主服务器 Chrome 中完成验证。");
  } catch (error) {
    setStatus(error.message);
  }
});

function setActionButtonsDisabled(disabled) {
  $("fetchOnlyBtn").disabled = disabled;
  $("extractBtn").disabled = disabled;
  $("discoverTopBtn").disabled = disabled;
  $("mainImageBtn").disabled = disabled || !currentReport || currentReport.needsVerification;
  $("exportExcelBtn").disabled = disabled || !currentReport;
}

async function runMainImageAnalysis() {
  if (!currentReport || currentReport.needsVerification) {
    setStatus("请先获取商品信息，再分析主图。");
    return;
  }
  try {
    setWorkflowStep(3, 2);
    setStatus("正在调用 DeepSeek 分析主图…");
    setActionButtonsDisabled(true);
    const result = await postJson("/api/analyze-main-images", {
      model: $("model").value.trim() || "deepseek-chat",
      report: currentReport,
    });
    currentReport.mainImageAnalysis = result.analysis;
    renderReport(currentReport);
    setWorkflowStep(4, 3);
    setStatus("主图分析已完成。", "success");
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    setActionButtonsDisabled(false);
  }
}

async function runExtraction({ analyze }) {
  lastRunMode = analyze ? "analyze" : "fetch-only";
  const myUrl = $("myUrl").value.trim();
  const competitorUrls = $("competitorUrls").value.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  $("linkValidation").hidden = true;
  $("linkValidation").textContent = "";
  $("myUrl").setAttribute("aria-invalid", "false");
  $("competitorUrls").setAttribute("aria-invalid", "false");
  if (!myUrl && !competitorUrls.length) {
    $("linkValidation").textContent = "请在“我的商品链接”或“竞品商品链接”中至少填写一个链接。";
    $("linkValidation").hidden = false;
    $("myUrl").setAttribute("aria-invalid", "true");
    $("competitorUrls").setAttribute("aria-invalid", "true");
    setWorkflowStep(1, 0);
    setStatus("请至少填写一个商品链接。", "error");
    $("myUrl").focus();
    return;
  }
  const invalidUrls = [myUrl, ...competitorUrls].filter(Boolean).filter((url) => !detectPlatform(url));
  if (invalidUrls.length) {
    $("linkValidation").textContent = "存在无法识别的链接。请检查链接是否来自 Lazada、Shopee 或 TikTok Shop。";
    $("linkValidation").hidden = false;
    $(myUrl && !detectPlatform(myUrl) ? "myUrl" : "competitorUrls").setAttribute("aria-invalid", "true");
    setStatus("请修正无法识别的平台链接。", "error");
    return;
  }
  try {
    setWorkflowStep(2, 1);
    setStatus(analyze ? "正在获取商品信息，智能匹配 SKU，然后调用 DeepSeek 分析…" : "正在获取商品信息，并调用 DeepSeek 智能匹配 SKU…");
    showModal("正在获取信息中，请等待！", "主服务器正在抓取商品信息，并进行 SKU 翻译归一与智能匹配。");
    setActionButtonsDisabled(true);
    const report = await postJson(analyze ? "/api/extract-and-analyze" : "/api/extract", {
      myUrl,
      competitorUrls,
      model: $("model").value.trim() || "deepseek-chat",
    });
    currentReport = report;
    $("mainImageBtn").disabled = Boolean(report.needsVerification);
    $("exportExcelBtn").disabled = false;
    renderReport(report);
    if (report.needsVerification) {
      showModal("你的主服务器正在帮你进行验证，请等待！", "检测到平台验证，主服务器完成验证后，关闭弹窗并点击下面的重新获取按钮。", { closable: true });
      setStatus("检测到平台验证。你的主服务器正在帮你进行验证，请等待！", "warning");
    } else {
      hideModal();
      setWorkflowStep(analyze ? 4 : 3, analyze ? 3 : 2);
      setStatus(analyze ? "商品信息和分析已完成。" : "商品信息已获取，未调用 DeepSeek。", "success");
      addRecentTask(`${analyze ? "链接分析" : "信息采集"}：${myUrl || competitorUrls[0]}`);
    }
  } catch (error) {
    hideModal();
    setWorkflowStep(1, 0);
    setStatus(error.message, "error");
  } finally {
    setActionButtonsDisabled(false);
  }
}

async function runKeywordDiscovery() {
  lastRunMode = "discover-top5";
  const keyword = $("topKeyword").value.trim();
  const productDescription = $("topDescription").value.trim();
  const country = $("topCountry").value;
  const site = $("topSite").value;
  try {
    if (!keyword && !productDescription) throw new Error("请输入关键词或产品描述。");
    const productImage = await getTopImagePayload();
    setStatus("正在结合参考产品收集销量 TOP5 链接，并调用 DeepSeek 分析…");
    showModal("正在收集销量 TOP5，请等待！", "主服务器正在结合关键词、产品描述和参考图片收集商品链接、抓取详情并分析。");
    setActionButtonsDisabled(true);
    const report = await postJson("/api/discover-top5-and-analyze", {
      keyword,
      productDescription,
      productImage,
      country,
      site,
      model: $("model").value.trim() || "deepseek-chat",
    });
    currentReport = report;
    $("mainImageBtn").disabled = Boolean(report.needsVerification);
    $("exportExcelBtn").disabled = false;
    renderReport(report);
    if (report.needsVerification) {
      showModal("你的主服务器正在帮你进行验证，请等待！", "检测到平台验证，主服务器完成验证后，关闭弹窗并点击下面的重新收集 TOP5 按钮。", { closable: true });
      setStatus("检测到平台验证。你的主服务器正在帮你进行验证，请等待！", "warning");
    } else {
      hideModal();
      setStatus("销量 TOP5 链接收集和分析已完成。", "success");
      addRecentTask(`关键词 TOP5：${keyword || productDescription.slice(0, 36)}`);
    }
  } catch (error) {
    hideModal();
    setStatus(error.message, "error");
  } finally {
    setActionButtonsDisabled(false);
  }
}

async function testMabangLogin() {
  try {
    const credentials = getMabangCredentials();
    setMabangBusy(true);
    setMabangTaskState("正在验证账号", "正在连接马帮 ERP，请稍候。", "loading");
    $("mabangLoginState").textContent = "验证中";
    $("mabangLoginState").className = "status-badge loading";
    const result = await postJson("/api/mabang-data/login-test", credentials);
    updateForgetCredentialsButton();
    $("mabangLoginState").textContent = "登录成功";
    $("mabangLoginState").className = "status-badge success";
    setMabangTaskState("账号可用", result.message || "登录验证成功，可以开始采集。", "success");
    setStatus("马帮账号登录验证成功。", "success");
  } catch (error) {
    $("mabangLoginState").textContent = "验证失败";
    $("mabangLoginState").className = "status-badge error";
    setMabangTaskState("登录失败", error.message, "error");
    setStatus(error.message, "error");
  } finally {
    clearMabangPasswordAfterTask();
    setMabangBusy(false);
  }
}

async function collectMabangData(kind) {
  try {
    const credentials = getMabangCredentials();
    const payload = { ...credentials, kind };
    if (kind === "orders") {
      payload.startDate = $("mabangOrderStartDate").value;
      payload.endDate = $("mabangOrderEndDate").value;
      if (!payload.startDate || !payload.endDate) throw new Error("请选择订单开始日期和结束日期。");
      payload.orderFilters = getMabangOrderFilters();
    }
    setMabangBusy(true);
    const label = kind === "orders" ? "订单" : "库存";
    setMabangTaskState(`正在获取${label}信息`, "系统正在登录马帮并下载官方数据，请保持页面打开。", "loading");
    showModal(`正在获取马帮${label}信息，请等待！`, "数据量较大时可能需要数分钟，完成后会自动展示结果。");
    const result = await postJson("/api/mabang-data/collect", payload);
    updateForgetCredentialsButton();
    currentMabangTask = result;
    $("mabangResultQuery").value = "";
    renderMabangResult(result);
    hideModal();
    setMabangTaskState("采集完成", result.message, "success");
    setStatus(result.message, "success");
    addRecentTask(`马帮${label}：${result.unfilteredTotal ?? result.total ?? 0} 条`);
  } catch (error) {
    hideModal();
    setMabangTaskState("采集失败", error.message, "error");
    setStatus(error.message, "error");
  } finally {
    clearMabangPasswordAfterTask();
    setMabangBusy(false);
  }
}

async function exportMabangData() {
  if (!currentMabangTask?.taskId) return;
  try {
    setMabangBusy(true);
    setMabangTaskState("正在生成 Excel", "正在整理当前采集结果，请稍候。", "loading");
    const response = await authorizedFetch("/api/mabang-data/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskId: currentMabangTask.taskId,
        query: String(currentMabangTask.query || ""),
        field: String(currentMabangTask.filterField || "__all__"),
        requestId: crypto.randomUUID(),
      }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || "Excel 导出失败。");
    }
    const exportInfo = await response.json();
    const downloadResponse = await authorizedFetch(exportInfo.downloadUrl);
    if (!downloadResponse.ok) {
      const data = await downloadResponse.json().catch(() => ({}));
      throw new Error(data.error || "Excel 下载失败。");
    }
    const blob = await downloadResponse.blob();
    const exportedRows = Number(exportInfo.exportedRows || currentMabangTask.total || 0);
    const filename = exportInfo.filename || "mabang-data.xlsx";
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    URL.revokeObjectURL(link.href);
    link.remove();
    setMabangTaskState("Excel 已导出", `已导出 ${exportedRows} 条，内容与当前筛选结果一致。`, "success");
    setStatus(`马帮 Excel 已导出，共 ${exportedRows} 条。`, "success");
    refreshMabangExportFiles().catch(() => {});
  } catch (error) {
    setMabangTaskState("导出失败", error.message, "error");
    setStatus(error.message, "error");
  } finally {
    setMabangBusy(false);
  }
}

$("fetchOnlyBtn").addEventListener("click", () => runExtraction({ analyze: false }));
$("extractBtn").addEventListener("click", () => runExtraction({ analyze: true }));
$("discoverTopBtn").addEventListener("click", runKeywordDiscovery);
$("mainImageBtn").addEventListener("click", runMainImageAnalysis);
$("exportExcelBtn").addEventListener("click", exportExcel);
$("modalCloseBtn").addEventListener("click", hideModal);
$("mabangTestLoginBtn").addEventListener("click", testMabangLogin);
$("mabangOrderFetchBtn").addEventListener("click", () => collectMabangData("orders"));
$("mabangInventoryFetchBtn").addEventListener("click", () => collectMabangData("inventory"));
$("mabangAddOrderFilterBtn").addEventListener("click", () => addMabangOrderFilter());
$("mabangExportBtn").addEventListener("click", exportMabangData);
$("refreshMabangFilesBtn").addEventListener("click", () => refreshMabangExportFiles().catch((error) => setStatus(error.message, "error")));
$("startLifecycleScanBtn").addEventListener("click", () => startLifecycleScan().catch((error) => {
  $("startLifecycleScanBtn").disabled = false;
  setStatus(error.message, "error");
}));
$("refreshLifecycleBtn").addEventListener("click", () => refreshLifecycleSummary().catch((error) => setStatus(error.message, "error")));
$("classifyLifecycleBtn").addEventListener("click", () => classifyLifecycleReport().catch((error) => setStatus(error.message, "error")));
$("exportLifecycleBtn").addEventListener("click", () => exportLifecycleReport().catch((error) => setStatus(error.message, "error")));
$("refreshQuarantineBtn").addEventListener("click", () => loadQuarantineRecords().catch((error) => setStatus(error.message, "error")));
$("lifecycleCategoryFilter").addEventListener("change", () => loadLifecycleReport(1).catch((error) => setStatus(error.message, "error")));
$("lifecyclePrevPageBtn").addEventListener("click", () => loadLifecycleReport(lifecycleState.page - 1).catch((error) => setStatus(error.message, "error")));
$("lifecycleNextPageBtn").addEventListener("click", () => loadLifecycleReport(lifecycleState.page + 1).catch((error) => setStatus(error.message, "error")));
$("lifecycleItemsTable").addEventListener("click", (event) => {
  const button = event.target.closest("[data-lifecycle-action]");
  if (!button) return;
  if (button.dataset.lifecycleAction === "detail") showLifecycleDetail(button.dataset.lifecycleId);
  else performLifecycleReviewAction(button.dataset.lifecycleAction, button.dataset.lifecycleId).catch((error) => setStatus(error.message, "error"));
});
$("lifecycleQuarantineTable").addEventListener("click", (event) => {
  const button = event.target.closest("[data-quarantine-action='restore']");
  if (button) performLifecycleReviewAction("restore", button.dataset.lifecycleId).catch((error) => setStatus(error.message, "error"));
});
$("mabangFilesTable").addEventListener("click", (event) => {
  const button = event.target.closest("[data-file-action='download']");
  if (!button) return;
  downloadMabangExportFile(button.dataset.fileId).catch((error) => setStatus(error.message, "error"));
});
$("mabangSearchBtn").addEventListener("click", applyMabangFilters);
$("mabangClearFilterBtn").addEventListener("click", () => clearMabangFilters().catch((error) => setStatus(error.message, "error")));
$("mabangForgetCredentialsBtn").addEventListener("click", forgetMabangCredentials);
$("mabangPrevPage").addEventListener("click", () => fetchMabangResult((currentMabangTask?.page || 1) - 1).catch((error) => setStatus(error.message, "error")));
$("mabangNextPage").addEventListener("click", () => fetchMabangResult((currentMabangTask?.page || 1) + 1).catch((error) => setStatus(error.message, "error")));
$("mabangPageSize").addEventListener("change", () => fetchMabangResult(1).catch((error) => setStatus(error.message, "error")));
$("mabangFilterField").addEventListener("change", markMabangFilterDraft);
$("mabangResultQuery").addEventListener("input", markMabangFilterDraft);
$("mabangResultQuery").addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  applyMabangFilters();
});
document.querySelectorAll(".mabang-view-tab").forEach((button) => {
  button.addEventListener("click", () => switchMabangView(button.dataset.mabangView));
});
document.querySelectorAll(".date-preset-button").forEach((button) => {
  button.addEventListener("click", () => setOrderDatePreset(button.dataset.datePreset));
});
$("mabangOrderStartDate").addEventListener("change", () => document.querySelectorAll(".date-preset-button").forEach((button) => button.classList.remove("active")));
$("mabangOrderEndDate").addEventListener("change", () => document.querySelectorAll(".date-preset-button").forEach((button) => button.classList.remove("active")));
$("mabangPasswordToggle").addEventListener("click", () => {
  const input = $("mabangPassword");
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  $("mabangPasswordToggle").textContent = show ? "隐藏" : "显示";
  $("mabangPasswordToggle").setAttribute("aria-pressed", String(show));
});
$("mabangRememberCredentials").addEventListener("change", () => {
  if (!$("mabangRememberCredentials").checked) {
    localStorage.removeItem(MABANG_USERNAME_KEY);
    localStorage.removeItem(MABANG_PASSWORD_KEY);
    updateForgetCredentialsButton();
  }
});

$("newScheduledTaskBtn").addEventListener("click", () => openScheduledTaskDialog().catch((error) => setStatus(error.message, "error")));
$("manageMabangAccountsBtn").addEventListener("click", async () => {
  await refreshScheduledData({ quiet: true }).catch(() => {});
  renderAccountProfiles();
  resetAccountForm();
  openManagementDialog("mabangAccountDialog");
});
$("manageDingtalkBtn").addEventListener("click", async () => {
  await refreshScheduledData({ quiet: true }).catch(() => {});
  renderDingtalkConfigs();
  resetDingtalkForm();
  openManagementDialog("dingtalkConfigDialog");
});
$("refreshScheduledBtn").addEventListener("click", () => refreshScheduledData().catch(() => {}));
$("toggleScheduledRunsBtn").addEventListener("click", () => showScheduledView(scheduledState.activeView === "runs" ? "tasks" : "runs"));
$("scheduledRunStatusFilter").addEventListener("change", () => refreshScheduledData({ quiet: true }).catch((error) => setStatus(error.message, "error")));
$("scheduledIncludeDeleted").addEventListener("change", () => refreshScheduledData({ quiet: true }).catch((error) => setStatus(error.message, "error")));
$("scheduledTasksTable").addEventListener("click", (event) => {
  const button = event.target.closest("[data-task-action]");
  if (button) handleScheduledTaskAction(button).catch((error) => setStatus(error.message, "error"));
});
$("scheduledRunsTable").addEventListener("click", (event) => {
  const button = event.target.closest("[data-run-action]");
  if (button) handleScheduledRunAction(button).catch((error) => setStatus(error.message, "error"));
});
$("scheduledTaskForm").addEventListener("submit", saveScheduledTask);
$("mabangAccountProfileForm").addEventListener("submit", saveAccountProfile);
$("dingtalkConfigForm").addEventListener("submit", saveDingtalkConfig);
$("resetMabangAccountBtn").addEventListener("click", resetAccountForm);
$("resetDingtalkBtn").addEventListener("click", resetDingtalkForm);
$("addScheduledFilterBtn").addEventListener("click", () => addScheduledFilter());
$("scheduledTaskType").addEventListener("change", updateScheduledFormVisibility);
$("scheduledTaskScheduleType").addEventListener("change", updateScheduledFormVisibility);
$("scheduledTaskDateMode").addEventListener("change", updateScheduledFormVisibility);
$("scheduledTaskAccount").addEventListener("change", () => loadScheduledFilterOptions($("scheduledTaskAccount").value).catch((error) => setStatus(error.message, "error")));
$("confirmRunNowBtn").addEventListener("click", confirmRunNow);
$("mabangAccountProfileList").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-account-action]");
  if (!button) return;
  const id = button.dataset.accountId;
  const profile = scheduledState.accounts.find((item) => item.id === id);
  try {
    if (button.dataset.accountAction === "edit") return editAccountProfile(id);
    if (button.dataset.accountAction === "test") {
      button.disabled = true;
      button.textContent = "验证中…";
      const result = await apiJson(`/api/mabang/account-profiles/${encodeURIComponent(id)}/test`, { method: "POST", body: {} });
      setStatus(result.message, "success");
    }
    if (button.dataset.accountAction === "delete") {
      if (!confirm(`确定删除马帮账号配置“${profile?.name || ""}”吗？`)) return;
      await apiJson(`/api/mabang/account-profiles/${encodeURIComponent(id)}`, { method: "DELETE" });
      setStatus("马帮账号配置已删除。", "success");
    }
    await refreshScheduledData({ quiet: true });
    renderAccountProfiles();
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      if (button.dataset.accountAction === "test") button.textContent = "测试登录";
    }
  }
});
$("dingtalkConfigList").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-dingtalk-action]");
  if (!button) return;
  const id = button.dataset.dingtalkId;
  const config = scheduledState.dingtalkConfigs.find((item) => item.id === id);
  try {
    if (button.dataset.dingtalkAction === "edit") return editDingtalkConfig(id);
    if (button.dataset.dingtalkAction === "test") {
      button.disabled = true;
      button.textContent = "发送中…";
      const result = await apiJson(`/api/notifications/dingtalk/configs/${encodeURIComponent(id)}/test`, { method: "POST", body: {} });
      setStatus(result.message, "success");
    }
    if (button.dataset.dingtalkAction === "delete") {
      if (!confirm(`确定删除钉钉机器人配置“${config?.name || ""}”吗？`)) return;
      await apiJson(`/api/notifications/dingtalk/configs/${encodeURIComponent(id)}`, { method: "DELETE" });
      setStatus("钉钉机器人配置已删除。", "success");
    }
    await refreshScheduledData({ quiet: true });
    renderDingtalkConfigs();
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      if (button.dataset.dingtalkAction === "test") button.textContent = "测试机器人";
    }
  }
});
document.querySelectorAll("[data-close-dialog]").forEach((button) => {
  button.addEventListener("click", () => closeManagementDialog(button.dataset.closeDialog));
});

document.querySelectorAll(".tab-button").forEach((button) => {
  button.addEventListener("click", () => switchPage(button.dataset.page));
});

$("sidebarToggleBtn").addEventListener("click", () => {
  const layout = document.querySelector(".app-layout");
  const collapsed = layout.classList.toggle("sidebar-collapsed");
  $("sidebarToggleBtn").textContent = collapsed ? "展开" : "收起导航";
  $("sidebarToggleBtn").setAttribute("aria-expanded", String(!collapsed));
});

$("myUrl").addEventListener("input", updatePlatformDetection);
$("competitorUrls").addEventListener("input", updatePlatformDetection);
$("myUrl").addEventListener("input", () => {
  $("linkValidation").hidden = true;
  $("myUrl").setAttribute("aria-invalid", "false");
});
$("competitorUrls").addEventListener("input", () => {
  $("linkValidation").hidden = true;
  $("competitorUrls").setAttribute("aria-invalid", "false");
});

window.addEventListener("hashchange", () => switchPage(location.hash.slice(1) || "link"));

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("serverVerifyModal").hidden && !$("modalActions").hidden) {
    hideModal();
  }
});

$("topImage").addEventListener("change", async () => {
  const preview = $("topImagePreview");
  const file = $("topImage").files?.[0];
  preview.hidden = true;
  preview.innerHTML = "";
  if (!file) return;
  try {
    if (!file.type.startsWith("image/")) throw new Error("请上传图片文件。");
    if (file.size > MAX_REFERENCE_IMAGE_BYTES) throw new Error("产品图片不能超过 2MB。");
    const dataUrl = await readFileAsDataUrl(file);
    preview.innerHTML = `
      <img src="${esc(dataUrl)}" alt="参考产品图片预览" width="112" height="112">
      <div>
        <strong>${esc(file.name)}</strong>
        <p>${Math.round(file.size / 1024)} KB，提交后会作为参考产品图片进入 TOP5 报告。</p>
      </div>
    `;
    preview.hidden = false;
  } catch (error) {
    $("topImage").value = "";
    setStatus(error.message);
  }
});

$("authForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const token = $("authToken").value.trim();
  const submit = $("authSubmit");
  setAuthError();
  submit.disabled = true;
  try {
    const response = await fetch("/api/auth/verify", {
      method: "POST",
      headers: authHeaders(token),
    });
    if (!response.ok) throw new Error("访问密钥错误");
    const result = await response.json().catch(() => ({}));
    if (!result.authenticated) throw new Error("访问密钥错误");
    saveSessionToken(token);
    authenticationEnabled = true;
    showApplication();
  } catch {
    clearSessionToken();
    setAuthError("访问密钥错误");
    $("authToken").select();
  } finally {
    submit.disabled = false;
  }
});

$("logoutBtn").addEventListener("click", async () => {
  await authorizedFetch("/api/auth/logout", { method: "POST" }).catch(() => {});
  adsFrameBridge?.clear();
  clearSessionToken();
  showAuthGate();
});

$("adsReconnectBtn").addEventListener("click", () => {
  loadAdsAnalyzer({ force: true });
});

initializeAccess();
