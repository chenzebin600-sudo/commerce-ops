import http from "node:http";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  appStartupMessages,
  authenticationApiResponse,
  createAccessPolicy,
  isLoopbackBindHost,
  protectedApiAccessResponse,
  resolveAppConfig,
} from "./lib/app-access.mjs";
import { loadLocalEnv } from "./lib/env.mjs";
import { createMabangWorkerRunner } from "./lib/mabang-worker-runner.mjs";
import { openSchedulerDatabase } from "./lib/mabang-scheduler/db.mjs";
import { createMabangSchedulerApi } from "./lib/mabang-scheduler/api.mjs";
import {
  AD_SERVICE_INTERNAL_HEADER,
  createAdServiceProxy,
  resolveAdServiceProxyConfig,
} from "./lib/ad-service-proxy.mjs";
import {
  DEFAULT_CHROME_ALLOWED_HOSTS_BY_PLATFORM,
  DEFAULT_IMAGE_PROXY_ALLOWED_HOSTS,
  NetworkPolicyError,
  createNetworkPolicy,
  hostnameMatchesAllowedHost,
  resolveAllowedHosts,
} from "./lib/security/network-policy.mjs";
import {
  createChromeNavigationGuard,
  resolveChromeNavigationConfig,
} from "./lib/security/chrome-navigation.mjs";
import {
  ImageProxyError,
  createSecureImageFetcher,
  resolveImageProxyConfig,
} from "./lib/security/image-proxy.mjs";
import {
  FILE_ERROR_CODES,
  FilePolicyError,
  cleanupTemporaryFiles,
  createTemporaryFilePath,
  ensureFileStorageRoots,
  publicFileError,
  removeFileInsideRoot,
  resolveFileStorageConfig,
  sanitizeFilename,
  validateFileId,
} from "./lib/security/file-policy.mjs";
import { normalizedSanitizationCounts } from "./lib/security/excel-cell-policy.mjs";
import {
  createOperationAuditService,
  parseTrustedProxies,
} from "./lib/security/audit-service.mjs";
import {
  completeHttpAudit,
  createHttpAuditContext,
} from "./lib/security/audit-http.mjs";
import { createAuditApi } from "./lib/security/audit-api.mjs";
import { createExportFileService } from "./lib/files/export-file-service.mjs";
import { createFileApi } from "./lib/files/file-api.mjs";
import { FileLifecycleRepository } from "./lib/files/file-lifecycle-repository.mjs";
import { FileLifecycleScanner, buildLifecycleRoots } from "./lib/files/file-lifecycle-scanner.mjs";
import { FileLifecycleService } from "./lib/files/file-lifecycle-service.mjs";
import { createFileLifecycleApi } from "./lib/files/file-lifecycle-api.mjs";
import { resolveLifecyclePolicy } from "./lib/files/file-lifecycle-policy.mjs";
import { FileReviewRepository } from "./lib/files/file-review-repository.mjs";
import { FileReviewService, resolveFileReviewPolicy } from "./lib/files/file-review-service.mjs";
import { createFileReviewApi } from "./lib/files/file-review-api.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const excelCellPolicyModulePath = path.join(__dirname, "lib", "security", "excel-cell-policy.mjs");
loadLocalEnv(__dirname);
const fileStorageConfig = await ensureFileStorageRoots(resolveFileStorageConfig(__dirname, process.env));
const startupTempCleanup = await cleanupTemporaryFiles(fileStorageConfig.tempRoot, {
  retentionHours: fileStorageConfig.tempFileRetentionHours,
});
if (startupTempCleanup.removed || startupTempCleanup.errors) {
  console.log(`Temporary file cleanup: ${startupTempCleanup.removed} removed, ${startupTempCleanup.errors} errors`);
}

async function resolveAdServiceInternalToken() {
  const configuredToken = String(process.env.AD_SERVICE_INTERNAL_TOKEN || "").trim();
  if (configuredToken) return configuredToken;

  const tokenFile = path.resolve(
    __dirname,
    process.env.AD_SERVICE_INTERNAL_TOKEN_FILE || "storage/.ad-service-internal-token",
  );
  try {
    const existingToken = String(await fs.readFile(tokenFile, "utf8")).trim();
    if (existingToken) return existingToken;
  } catch (error) {
    if (error?.code !== "ENOENT") throw new Error("无法读取广告服务内部Token文件");
  }

  const generatedToken = randomBytes(32).toString("base64url");
  await fs.mkdir(path.dirname(tokenFile), { recursive: true });
  try {
    await fs.writeFile(tokenFile, `${generatedToken}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return generatedToken;
  } catch (error) {
    if (error?.code !== "EEXIST") throw new Error("无法创建广告服务内部Token文件");
    const existingToken = String(await fs.readFile(tokenFile, "utf8")).trim();
    if (!existingToken) throw new Error("广告服务内部Token文件为空");
    return existingToken;
  }
}

const appConfig = resolveAppConfig(process.env);
const { port, host } = appConfig;
const accessPolicy = createAccessPolicy(appConfig);
const chromePort = Number(process.env.CHROME_DEBUG_PORT || 9222);
const adServiceConfig = resolveAdServiceProxyConfig(process.env);
const adAnalyzerPort = adServiceConfig.port;
const adAnalyzerDir = process.env.AD_ANALYZER_DIR || "D:\\codex\\Lazada-Sponsored Max analysis\\webapp";
const adServiceInternalToken = await resolveAdServiceInternalToken();
const proxyAdServiceRequest = createAdServiceProxy({
  baseUrl: adServiceConfig.baseUrl,
  internalToken: adServiceInternalToken,
  onResponse({ req, target, status, upstreamStatus, responseBody, error }) {
    const context = req.auditContext;
    if (!context) return;
    if (upstreamStatus === 401 || upstreamStatus === 403) {
      context.addRelated("ads", "ads.internal_auth.failed", {
        status: "failed",
        errorStage: "ads_internal_auth",
        errorCode: "ADS_INTERNAL_AUTH_FAILED",
      });
    }
    if (target?.pathname !== "/api/analyze" && context.pathname !== "/api/ads/analyze") return;
    context.addRelated("ads", status < 400 ? "ads.file.validation.success" : "ads.file.validation.failed", {
      status: status < 400 ? "success" : "failed",
      errorStage: status < 400 ? null : "file_validation",
      errorCode: status < 400 ? null : error?.code || "AD_UPLOAD_REJECTED",
    });
    if (status >= 400) {
      context.addRelated("file", "file.upload.rejected", { status: "failed", errorCode: error?.code || "AD_UPLOAD_REJECTED" });
      return;
    }
    if (!responseBody?.length) return;
    try {
      const payload = JSON.parse(responseBody.toString("utf8"));
      if (payload.jobId) context.annotate({ fileId: payload.jobId });
      if (payload.ai?.enabled) context.addRelated("ai", "deepseek.call", { metadata: { provider: "ads" } });
      else if (payload.ai?.error) context.addRelated("ai", "deepseek.call", {
        status: "failed",
        errorStage: "deepseek",
        errorCode: "DEEPSEEK_FAILED",
        errorSummary: "Advertising DeepSeek request failed; rule-based result was retained",
        metadata: { provider: "ads", result: "fallback" },
      });
    } catch {
      // Successful non-JSON advertising responses do not add inferred audit details.
    }
  },
});
const chromeAllowedHosts = resolveAllowedHosts(
  Object.values(DEFAULT_CHROME_ALLOWED_HOSTS_BY_PLATFORM).flat(),
  process.env.CHROME_ALLOWED_HOSTS,
  "CHROME_ALLOWED_HOSTS",
);
const imageProxyAllowedHosts = resolveAllowedHosts(
  DEFAULT_IMAGE_PROXY_ALLOWED_HOSTS,
  process.env.IMAGE_PROXY_ALLOWED_HOSTS,
  "IMAGE_PROXY_ALLOWED_HOSTS",
);
const chromeNetworkPolicy = createNetworkPolicy({
  name: "Chrome navigation",
  allowedHosts: chromeAllowedHosts,
});
const imageProxyNetworkPolicy = createNetworkPolicy({
  name: "image proxy",
  allowedHosts: imageProxyAllowedHosts,
});
const chromeNavigationConfig = resolveChromeNavigationConfig(process.env);
const imageProxyConfig = resolveImageProxyConfig(process.env);
const fetchSecureImage = createSecureImageFetcher({
  policy: imageProxyNetworkPolicy,
  ...imageProxyConfig,
});

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function json(res, status, data) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(data));
}

function securityErrorResponse(res, error, fallback = {}) {
  if (error instanceof FilePolicyError) {
    return json(res, error.status || 400, { ok: false, code: error.code, error: error.message });
  }
  if (error instanceof NetworkPolicyError || error instanceof ImageProxyError) {
    return json(res, error.status || 400, {
      ok: false,
      code: error.code,
      error: error.message,
    });
  }
  return json(res, fallback.status || 500, {
    ok: false,
    code: fallback.code || "SECURE_OPERATION_FAILED",
    error: fallback.message || "安全操作失败。",
  });
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error("请求内容过大。");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

const scheduledExportRoot = fileStorageConfig.exportRoot;
const schedulerDatabase = openSchedulerDatabase({ rootDir: __dirname });
const auditService = createOperationAuditService({ db: schedulerDatabase, env: process.env });
const trustedAuditProxies = parseTrustedProxies(process.env.TRUST_PROXY);
const auditRetentionDays = Number(process.env.AUDIT_RETENTION_DAYS || 180);
const handleAuditApi = createAuditApi({ audit: auditService, retentionDays: auditRetentionDays });
const exportFileService = createExportFileService({
  db: schedulerDatabase,
  exportRoot: scheduledExportRoot,
  tempRoot: fileStorageConfig.tempRoot,
  audit: auditService,
});
const handleFileApi = createFileApi({ fileService: exportFileService });
auditService.recordSafely({
  module: "file",
  action: "file.temp.cleanup",
  status: startupTempCleanup.errors ? "failed" : "success",
  errorCode: startupTempCleanup.errors ? "TEMP_CLEANUP_PARTIAL" : null,
  errorSummary: startupTempCleanup.errors ? "Temporary file cleanup completed with errors" : null,
  metadata: { cleanupDeleted: startupTempCleanup.removed, result: startupTempCleanup.errors ? "partial" : "complete" },
});
const runMabangWorker = createMabangWorkerRunner({ rootDir: __dirname, exportRoot: fileStorageConfig.tempRoot });
const lifecyclePolicy = resolveLifecyclePolicy(process.env);
const lifecycleRepository = new FileLifecycleRepository({ db: schedulerDatabase });
const fileReviewRepository = new FileReviewRepository({ db: schedulerDatabase });
const lifecycleRoots = buildLifecycleRoots({ fileStorageConfig, adAnalyzerDir, env: process.env });
const lifecycleScanner = new FileLifecycleScanner({
  fileRepository: exportFileService.repository,
  managedFileRepository: fileReviewRepository,
  roots: lifecycleRoots,
  policy: lifecyclePolicy,
  protectedFileIds: lifecycleRepository.protectedFileIds(),
});
const lifecycleService = new FileLifecycleService({
  repository: lifecycleRepository,
  scanner: lifecycleScanner,
  audit: auditService,
  fileService: exportFileService,
  tempRoot: fileStorageConfig.tempRoot,
  runWorker: runMabangWorker,
  policy: lifecyclePolicy,
});
const handleFileLifecycleApi = createFileLifecycleApi({ service: lifecycleService });
const fileReviewService = new FileReviewService({
  repository: fileReviewRepository,
  lifecycleRepository,
  roots: lifecycleRoots,
  storageRoot: fileStorageConfig.storageRoot,
  quarantineRoot: path.resolve(fileStorageConfig.storageRoot, process.env.FILE_QUARANTINE_ROOT || "quarantine"),
  audit: auditService,
  policy: resolveFileReviewPolicy(process.env),
});
await fileReviewService.ensureQuarantineRoot();
const handleFileReviewApi = createFileReviewApi({ service: fileReviewService });
const handleMabangSchedulerApi = createMabangSchedulerApi({
  db: schedulerDatabase,
  runWorker: runMabangWorker,
  exportRoot: scheduledExportRoot,
  fileService: exportFileService,
});
const mabangTasks = new Map();
const MABANG_TASK_TTL_MS = 30 * 60 * 1000;
const MABANG_MAX_TASKS = 8;

function pruneMabangTasks() {
  const cutoff = Date.now() - MABANG_TASK_TTL_MS;
  for (const [taskId, task] of mabangTasks) {
    if (task.createdAt < cutoff) mabangTasks.delete(taskId);
  }
  while (mabangTasks.size > MABANG_MAX_TASKS) {
    mabangTasks.delete(mabangTasks.keys().next().value);
  }
}

function getMabangTask(taskId) {
  pruneMabangTasks();
  const task = mabangTasks.get(String(taskId || ""));
  if (!task) throw new Error("采集结果已过期或不存在，请重新获取数据。");
  return task;
}

function filterMabangRecords(records, query, field = "__all__") {
  const term = String(query || "").trim().toLocaleLowerCase("zh-CN");
  if (!term) return records;
  const selectedField = String(field || "__all__");
  return records.filter((record) => {
    if (selectedField !== "__all__") {
      return String(record[selectedField] ?? "").toLocaleLowerCase("zh-CN").includes(term);
    }
    return Object.values(record).some((value) => String(value ?? "").toLocaleLowerCase("zh-CN").includes(term));
  });
}

function paginateMabangTask(task, { page = 1, pageSize = 50, query = "", field = "__all__" } = {}) {
  const selectedField = task.columns.includes(field) ? field : "__all__";
  const filtered = filterMabangRecords(task.records, query, selectedField);
  const safePageSize = Math.max(10, Math.min(Number(pageSize) || 50, 200));
  const totalPages = Math.max(1, Math.ceil(filtered.length / safePageSize));
  const safePage = Math.max(1, Math.min(Number(page) || 1, totalPages));
  const start = (safePage - 1) * safePageSize;
  return {
    taskId: task.id,
    kind: task.kind,
    columns: task.columns,
    summary: task.summary,
    total: filtered.length,
    unfilteredTotal: task.records.length,
    page: safePage,
    pageSize: safePageSize,
    totalPages,
    query: String(query || ""),
    filterField: selectedField,
    records: filtered.slice(start, start + safePageSize),
  };
}

function detectPlatform(inputUrl) {
  const hostName = new URL(inputUrl).hostname.toLowerCase();
  if (hostName.includes("shop.tiktok.com") || hostName.includes("tiktok.com")) return "tiktok";
  if (hostName.includes("shopee.")) return "shopee";
  if (hostName.includes("lazada.")) return "lazada";
  return "unknown";
}

function normalizeSite(value) {
  const site = String(value || "").trim().toLowerCase();
  if (/tiktok|tk|tt/.test(site)) return "tiktok";
  if (/shopee|虾皮/.test(site)) return "shopee";
  if (/lazada|来赞达/.test(site)) return "lazada";
  return site;
}

function normalizeCountry(value) {
  const raw = String(value || "ph").trim().toLowerCase();
  const aliases = new Map([
    ["ph", "ph"], ["philippines", "ph"], ["philippine", "ph"], ["菲律宾", "ph"],
    ["th", "th"], ["thailand", "th"], ["泰国", "th"],
    ["my", "my"], ["malaysia", "my"], ["马来西亚", "my"],
    ["sg", "sg"], ["singapore", "sg"], ["新加坡", "sg"],
    ["vn", "vn"], ["vietnam", "vn"], ["越南", "vn"],
    ["id", "id"], ["indonesia", "id"], ["印尼", "id"], ["印度尼西亚", "id"],
  ]);
  return aliases.get(raw) || raw;
}

function buildSearchUrl({ site, country, keyword }) {
  const platform = normalizeSite(site);
  const region = normalizeCountry(country);
  const q = encodeURIComponent(String(keyword || "").trim());
  if (!q) throw new Error("请输入关键词。");

  const lazadaHosts = {
    ph: "www.lazada.com.ph",
    th: "www.lazada.co.th",
    my: "www.lazada.com.my",
    sg: "www.lazada.sg",
    vn: "www.lazada.vn",
    id: "www.lazada.co.id",
  };
  const shopeeHosts = {
    ph: "shopee.ph",
    th: "shopee.co.th",
    my: "shopee.com.my",
    sg: "shopee.sg",
    vn: "shopee.vn",
    id: "shopee.co.id",
  };

  if (platform === "lazada") {
    const hostName = lazadaHosts[region];
    if (!hostName) throw new Error(`暂不支持 Lazada 这个国家：${country}`);
    return { platform, country: region, url: `https://${hostName}/catalog/?q=${q}&sort=popularity` };
  }
  if (platform === "shopee") {
    const hostName = shopeeHosts[region];
    if (!hostName) throw new Error(`暂不支持 Shopee 这个国家：${country}`);
    return { platform, country: region, url: `https://${hostName}/search?keyword=${q}&sortBy=sales` };
  }
  if (platform === "tiktok") {
    return { platform, country: region, url: `https://shop.tiktok.com/${region}/search?keyword=${q}` };
  }
  throw new Error(`暂不支持这个站点：${site}`);
}

function findChromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter(Boolean);

  return candidates.find((candidate) => candidate && existsSync(candidate));
}

function openChromeWindow() {
  const chromePath = findChromePath();
  if (!chromePath) throw new Error("未找到 Chrome 或 Edge，请设置 CHROME_PATH。");
  const profile = path.join(process.env.TEMP || __dirname, "marketplace-web-chrome-profile");
  spawn(chromePath, [
    `--remote-debugging-port=${chromePort}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ], { detached: true, stdio: "ignore" }).unref();
}

async function isAdAnalyzerRunning() {
  try {
    const response = await fetch(`${adServiceConfig.baseUrl}/api/service/status`, {
      headers: { [AD_SERVICE_INTERNAL_HEADER]: adServiceInternalToken },
      signal: AbortSignal.timeout(1500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureAdAnalyzerServer() {
  if (!existsSync(path.join(adAnalyzerDir, "server.mjs"))) return { ok: false, error: "广告分析项目 server.mjs 不存在。" };
  if (await isAdAnalyzerRunning()) return { ok: true, started: false, port: adAnalyzerPort };
  spawn(process.execPath, ["server.mjs"], {
    cwd: adAnalyzerDir,
    env: {
      ...process.env,
      AD_SERVICE_HOST: adServiceConfig.host,
      AD_SERVICE_PORT: String(adAnalyzerPort),
      AD_SERVICE_INTERNAL_TOKEN: adServiceInternalToken,
      PORT: String(adAnalyzerPort),
      HOST: adServiceConfig.host,
    },
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  }).unref();
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 700));
    if (await isAdAnalyzerRunning()) return { ok: true, started: true, port: adAnalyzerPort };
  }
  return { ok: false, error: "广告分析子服务启动超时。", port: adAnalyzerPort };
}

async function getChromeTargets() {
  try {
    const response = await fetch(`http://127.0.0.1:${chromePort}/json/list`);
    if (!response.ok) throw new Error(`Chrome debug port returned ${response.status}`);
    return response.json();
  } catch {
    throw new Error("Chrome 调试浏览器未连接，请先点击“打开验证浏览器”。");
  }
}

async function getPageTarget() {
  const targets = await getChromeTargets();
  return (
    targets.find((target) => target.type === "page" && /lazada|shopee|tiktok/i.test(target.url || "")) ||
    targets.find((target) => target.type === "page") ||
    targets[0]
  );
}

function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const eventListeners = new Map();

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
    if (msg.method && eventListeners.has(msg.method)) {
      for (const listener of eventListeners.get(msg.method)) listener(msg.params || {});
    }
  };

  return new Promise((resolve, reject) => {
    ws.onopen = () => {
      resolve({
        send(method, params = {}) {
          const callId = ++id;
          ws.send(JSON.stringify({ id: callId, method, params }));
          return new Promise((res) => pending.set(callId, res));
        },
        on(method, listener) {
          if (!eventListeners.has(method)) eventListeners.set(method, new Set());
          eventListeners.get(method).add(listener);
          return () => eventListeners.get(method)?.delete(listener);
        },
        close() {
          ws.close();
        },
      });
    };
    ws.onerror = reject;
  });
}

function safeChromeTargetUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    if (!chromeAllowedHosts.some((allowed) => hostnameMatchesAllowedHost(parsed.hostname, allowed))) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

async function waitForPageTarget(timeoutMs = chromeNavigationConfig.timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const target = await getPageTarget();
      if (target?.webSocketDebuggerUrl) return target;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new NetworkPolicyError("NAVIGATION_TIMEOUT", { status: 504 });
}

function configuredChromeNavigationGuard(cdp) {
  return createChromeNavigationGuard({
    cdp,
    policy: chromeNetworkPolicy,
    ...chromeNavigationConfig,
  });
}

async function navigateChromeBrowser(inputUrl) {
  const targetUrl = await chromeNetworkPolicy.validateUrl(inputUrl);
  let target;
  let mode = "navigate";
  try {
    target = await getPageTarget();
  } catch {
    openChromeWindow();
    target = await waitForPageTarget();
    mode = "open";
  }
  if (!target?.webSocketDebuggerUrl) {
    openChromeWindow();
    target = await waitForPageTarget();
    mode = "open";
  }

  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  let guard;
  try {
    guard = await configuredChromeNavigationGuard(cdp);
    await guard.navigate(targetUrl.url);
    await guard.throwIfBlocked();
    await cdp.send("Page.bringToFront");
    return { mode };
  } finally {
    await guard?.dispose();
    cdp.close();
  }
}

async function extractLazadaProductInPage() {
  const f = window.__moduleData__?.data?.root?.fields || {};
  const abs = (url) => (url ? (url.startsWith("//") ? `https:${url}` : url) : null);
  const mediaUrl = (value) => {
    if (!value) return null;
    if (typeof value === "string") return abs(value);
    return abs(value.src || value.poster || value.url || value.imageUrl || value.image || value.thumb);
  };
  const galleryImage = (items) => {
    const image = (items || []).find((g) => g && (g.type === "img" || !g.type) && (g.src || g.poster || g.url || g.image));
    return mediaUrl(image);
  };
  const galleries = f.skuGalleries?.["0"] || f.skuGalleries?.[f.primaryKey?.skuId] || [];
  const firstImageAfterVideo = galleries.find((g) => g.type === "img" && (g.src || g.poster));
  const fallbackImage =
    document.querySelector(".gallery-preview-panel-v2__image")?.currentSrc ||
    document.querySelector('meta[property="og:image"]')?.content ||
    null;
  const mainImage = abs(firstImageAfterVideo?.src || firstImageAfterVideo?.poster) || fallbackImage;

  const propValueName = {};
  const propValueImage = {};
  for (const prop of f.productOption?.skuBase?.properties || []) {
    for (const val of prop.values || []) {
      const key = `${prop.pid}:${val.vid}`;
      propValueName[key] = val.name;
      propValueImage[key] = mediaUrl(val.hoverImage || val.image || val.img || val.imageUrl || val.skuImage || val.thumb || val.url);
    }
  }

  async function clickAndReadSkuImages(items) {
    const imageBySkuId = new Map();
    const imageByName = new Map();
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
    const readCurrentImage = () =>
      abs(document.querySelector(".gallery-preview-panel-v2__image")?.currentSrc || document.querySelector(".gallery-preview-panel-v2__image")?.src) ||
      abs(document.querySelector(".pdp-block_mini-sku-top img")?.currentSrc || document.querySelector(".pdp-block_mini-sku-top img")?.src) ||
      null;
    const getOptionElements = () => [...document.querySelectorAll([
      ".mini-sku-visible .sku-variable-img-wrap",
      ".mini-sku-visible .sku-variable-img-wrap-selected",
      ".mini-sku-visible .sku-variable-name",
      ".mini-sku-visible .sku-variable-name-selected",
      ".sku-selector-v2 .sku-variable-img-wrap",
      ".sku-selector-v2 .sku-variable-img-wrap-selected",
      ".sku-selector-v2 .sku-variable-name",
      ".sku-selector-v2 .sku-variable-name-selected",
    ].join(","))];
    const clickOption = async (optionName) => {
      const normalizedName = normalize(optionName);
      if (!normalizedName) return false;
      const elements = getOptionElements();
      const element = elements.find((el) => normalize(el.innerText || el.textContent) === normalizedName);
      if (!element) return false;
      element.scrollIntoView({ block: "center", inline: "center" });
      await sleep(120);
      element.click();
      await sleep(650);
      return true;
    };

    for (const item of items) {
      let clicked = false;
      const clickNames = item.imagePropNames?.length ? item.imagePropNames : item.propNames || [];
      for (const optionName of clickNames) {
        clicked = (await clickOption(optionName)) || clicked;
      }
      if (!clicked) clicked = await clickOption(item.name);
      const image = clicked ? readCurrentImage() : null;
      if (image) {
        imageBySkuId.set(item.skuId, image);
        imageByName.set(item.name, image);
      }
    }
    return { imageBySkuId, imageByName };
  }

  const skus = (f.productOption?.skuBase?.skus || []).map((sku) => {
    const info = f.skuInfos?.[sku.skuId] || (f.skuInfos?.[0]?.skuId === sku.skuId ? f.skuInfos[0] : null) || {};
    const propKeys = (sku.propPath || "").split(";").filter(Boolean);
    const names = propKeys.map((key) => propValueName[key]).filter(Boolean);
    const imagePropNames = propKeys.filter((key) => propValueImage[key]).map((key) => propValueName[key]).filter(Boolean);
    const skuGallery =
      f.skuGalleries?.[sku.skuId] ||
      f.skuGalleries?.[String(sku.skuId)] ||
      f.skuGalleries?.[sku.innerSkuId] ||
      f.skuGalleries?.[sku.propPath] ||
      propKeys.map((key) => f.skuGalleries?.[key]).find(Boolean) ||
      [];
    const image =
      galleryImage(skuGallery) ||
      propKeys.map((key) => propValueImage[key]).find(Boolean) ||
      mediaUrl(info.image || info.skuImage || info.skuImg || info.imageUrl || info.skuImgUrl || sku.image || sku.skuImage || sku.imageUrl);
    return {
      skuId: String(sku.skuId || sku.innerSkuId || sku.propPath || ""),
      name: names.join(" / ") || propValueName[sku.propPath] || sku.propPath || sku.innerSkuId || "not shown",
      propNames: names,
      imagePropNames,
      salePrice: info.price?.salePrice?.text || null,
      salePriceValue: info.price?.salePrice?.value ?? null,
      originalPrice: info.price?.originalPrice?.text || null,
      discount: info.price?.discount || null,
      stock: info.stock ?? null,
      image,
    };
  });
  const clickedImages = await clickAndReadSkuImages(skus);
  for (const sku of skus) {
    sku.image = clickedImages.imageBySkuId.get(sku.skuId) || clickedImages.imageByName.get(sku.name) || sku.image;
    delete sku.propNames;
    delete sku.imagePropNames;
  }

  const specObj =
    f.specifications?.[f.primaryKey?.skuId] ||
    f.specifications?.[skus[0]?.skuId] ||
    Object.values(f.specifications || {})[0] ||
    {};

  const text = document.body?.innerText || "";
  return {
    platform: "lazada",
    finalUrl: location.href,
    title: f.product?.title || document.querySelector("h1")?.innerText || document.title || "not shown",
    shopName: f.seller?.name || "not shown",
    mainImage,
    images: galleries.filter((g) => g.type === "img" && (g.src || g.poster)).map((g) => abs(g.src || g.poster)).filter(Boolean),
    skus,
    rating: f.review?.averageRating ?? f.product?.rating?.score ?? null,
    reviewCount: f.review?.reviews ?? f.review?.contentedNum ?? f.product?.rating?.total ?? null,
    soldCount: null,
    productSpecifications: specObj.features || specObj || {},
    productDetails: specObj.features || specObj || {},
    visibleReviews: parseVisibleReviews(),
    blocked: /We need to check if you are a robot|reCAPTCHA|_____tmd_____\/punish/i.test(text + location.href),
    moduleReady: Boolean(window.__moduleData__),
  };

  function parseVisibleReviews() {
    const toAbs = (url) => (url ? (url.startsWith("//") ? `https:${url}` : url) : url);
    return [...document.querySelectorAll(".mod-reviews .item")].slice(0, 5).map((item) => ({
      username: item.querySelector(".reviewer")?.innerText?.trim() || "not shown",
      content: item.querySelector(".item-content-main-content-reviews")?.innerText?.trim() || "not shown",
      images: [...item.querySelectorAll("img")]
        .map((img) => toAbs(img.currentSrc || img.src))
        .filter(Boolean)
        .filter((src) => !/avatar|logo|data:image|blank/i.test(src)),
      variation: item.querySelector(".skuInfo-value")?.innerText?.trim() || null,
      time: item.querySelector(".time")?.innerText?.trim() || null,
    }));
  }
}

async function extractShopeeProductInPage() {
  const text = document.body?.innerText || "";
  const urlMatch = location.href.match(/(?:-|i\.)i?\.(\d+)\.(\d+)/) || location.href.match(/i\.(\d+)\.(\d+)/);
  const shopId = urlMatch?.[1] || new URL(location.href).searchParams.get("shop_id");
  const itemId = urlMatch?.[2] || new URL(location.href).searchParams.get("item_id");
  const abs = (url) => {
    if (!url) return null;
    if (url.startsWith("//")) return `https:${url}`;
    if (url.startsWith("http")) return url;
    if (/^[a-z0-9_-]{20,}$/i.test(url)) return `https://down-ph.img.susercontent.com/file/${url}`;
    return url;
  };
  const priceText = (value) => {
    if (value == null) return null;
    const num = Number(value);
    if (!Number.isFinite(num)) return String(value);
    const normalized = num >= 100000 ? num / 100000 : num;
    return `\u20b1${normalized.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };
  const normalizeCount = (value) => {
    if (Array.isArray(value)) return value[0] ?? null;
    return value ?? null;
  };
  const domFallback = () => ({
    title: document.querySelector('meta[property="og:title"]')?.content || document.querySelector("h1")?.innerText || document.title || "not shown",
    mainImage: abs(document.querySelector('meta[property="og:image"]')?.content || document.querySelector("img")?.currentSrc || document.querySelector("img")?.src),
    rating: text.match(/([\d.]+)\s+out of 5/i)?.[1] || text.match(/([\d.]+)\s*\/\s*5/)?.[1] || null,
    reviewCount: text.match(/([\d,.]+[KkMm]?)\s+Ratings?/i)?.[1] || text.match(/([\d,.]+[KkMm]?)\s+Reviews?/i)?.[1] || null,
    soldCount: text.match(/([\d,.]+[KkMm]?\+?)\s+sold/i)?.[1] || null,
  });

  function readInitialState() {
    for (const script of [...document.scripts]) {
      const content = script.textContent || "";
      if (!content.includes('"initialState"') || !content.includes(String(itemId || ""))) continue;
      try {
        return JSON.parse(content).initialState || null;
      } catch {}
    }
    return null;
  }

  async function clickAndReadPrices(models, tierVariations) {
    const priceByName = new Map();
    const options = tierVariations?.[0]?.options || [];
    const optionSet = new Set(options.map(String));
    const clickable = [...document.querySelectorAll("button, [role='button'], .product-variation")]
      .filter((element) => optionSet.has((element.innerText || element.textContent || "").trim()));
    const readPrice = () => {
      const matches = [...document.body.innerText.matchAll(/\u20b1\s*[\d,]+(?:\.\d+)?/g)].map((m) => m[0].replace(/\s+/g, ""));
      return matches.find((value) => Number(value.replace(/[^\d.]/g, "")) >= 100) || null;
    };
    for (const model of models || []) {
      const optionName = String(model.name || "");
      const button = clickable.find((element) => (element.innerText || element.textContent || "").trim() === optionName);
      if (!button) continue;
      try {
        button.scrollIntoView({ block: "center", inline: "center" });
        button.click();
        await new Promise((resolve) => setTimeout(resolve, 450));
        priceByName.set(optionName, readPrice());
      } catch {}
    }
    return Object.fromEntries(priceByName.entries());
  }

  const initialState = readInitialState();
  const stateItem = initialState?.item?.items?.[String(itemId)] || initialState?.item?.items?.[itemId] || null;
  const currentKey = initialState?.DOMAIN_PDP?.data?.PDP_BFF_DATA?.currentKey;
  const bff = currentKey ? initialState?.DOMAIN_PDP?.data?.PDP_BFF_DATA?.cachedMap?.[currentKey] : null;
  const stateShop = initialState?.PC_VARIATION_SELECTION?.data?.shop || bff?.shop_detailed || null;

  let api = null;
  if (shopId && itemId) {
    try {
      const response = await fetch(`/api/v4/pdp/get_pc?shop_id=${shopId}&item_id=${itemId}`, {
        credentials: "include",
        headers: { "x-requested-with": "XMLHttpRequest" },
      });
      if (response.ok) api = await response.json();
    } catch {}
  }

  const data = api?.data || api || {};
  const item = stateItem || bff?.item || data.item || data.item_detail || data;
  const fallback = domFallback();
  const tierVariations = item.tier_variations || item.tierVariations || [];
  const imageByTier = new Map();
  for (const tier of tierVariations) {
    (tier.options || []).forEach((name, index) => {
      const image = tier.images?.[index] || tier.images_url?.[index] || tier.imagesUrl?.[index];
      if (name && image) imageByTier.set(String(name), abs(image));
    });
  }

  const specs = {};
  for (const attr of item.attributes || item.attrs || item.product_attributes || []) {
      const key = attr.name || attr.key || attr.attribute_name;
      const value = attr.value || attr.val || attr.attribute_value || attr.value_name;
      if (key) specs[key] = Array.isArray(value) ? value.join(", ") : value ?? "not shown";
    }

  const models = item.models || item.model_infos || item.variations || [];
  const clickedPrices = await clickAndReadPrices(models, tierVariations);
  const skus = models.map((model, index) => {
    const name = model.name || model.model_name || model.sku || model.extinfo?.tier_index?.map((i, tierIndex) => tierVariations[tierIndex]?.options?.[i]).filter(Boolean).join(" / ") || `SKU ${index + 1}`;
    const price = model.price ?? model.price_before_discount ?? model.price_min;
    const originalPrice = model.price_before_discount || model.price_before_discount_min || null;
    const clickedPrice = clickedPrices[name];
    return {
      skuId: String(model.modelid || model.model_id || model.itemid || index),
      name,
      salePrice: priceText(price) || clickedPrice,
      salePriceValue: price == null ? (clickedPrice ? Number(clickedPrice.replace(/[^\d.]/g, "")) : null) : Number(price) >= 100000 ? Number(price) / 100000 : Number(price),
      originalPrice: priceText(originalPrice),
      discount: model.raw_discount || model.discount || null,
      stock: model.stock ?? model.normal_stock ?? model.current_promotion_reserved_stock ?? null,
      image: imageByTier.get(String(name)) || abs(model.extinfo?.sku_image) || null,
    };
  });

  const imageIds = item.images || item.image_list || item.images_url || [];
  const images = imageIds.map(abs).filter(Boolean);
  const ratingData = item.item_rating || item.itemRating || {};
  const reviewCount = normalizeCount(ratingData.rating_count) ?? item.cmt_count ?? item.comment_count ?? fallback.reviewCount;

  return {
    platform: "shopee",
    finalUrl: location.href,
    title: item.title || item.name || fallback.title,
    shopName: stateShop?.name || data.shop_detailed?.name || data.shop?.name || item.shop_name || "not shown",
    mainImage: images[0] || fallback.mainImage,
    images,
    skus,
    rating: ratingData.rating_star ?? item.rating_star ?? fallback.rating,
    reviewCount,
    soldCount: item.historical_sold ?? item.sold ?? item.global_sold ?? item.global_sold_count ?? fallback.soldCount,
    productSpecifications: specs,
    productDetails: specs,
    visibleReviews: [],
    blocked: /captcha|verify|robot|unusual traffic|security check/i.test(text + location.href),
    moduleReady: Boolean(api?.data || item?.itemid || item?.item_id || item?.name || fallback.title),
    shopeeIds: { shopId, itemId },
  };
}

function extractTikTokProductInPage() {
  const text = document.body?.innerText || "";
  const abs = (url) => {
    if (!url) return null;
    if (url.startsWith("//")) return `https:${url}`;
    if (url.startsWith("http")) return url;
    return url;
  };
  const firstImageUrl = (image) => abs(image?.url_list?.[0] || image?.urlList?.[0] || image?.url || image?.src || null);
  const uniq = (items) => [...new Set((items || []).filter(Boolean))];
  const moneyText = (price) => {
    if (!price) return null;
    const symbol = price.currency_symbol || price.currencySymbol || "";
    const value = price.sale_price_format || price.sale_price_decimal || price.price_format || price.price_decimal;
    return value == null ? null : `${symbol}${value}`;
  };
  const moneyValue = (price) => {
    const raw = price?.sale_price_decimal || price?.sale_price_format || price?.price_decimal || price?.price_format;
    const num = Number(String(raw ?? "").replace(/[^\d.]/g, ""));
    return Number.isFinite(num) ? num : null;
  };
  const domFallback = () => ({
    title: document.querySelector('meta[property="og:title"]')?.content || document.querySelector("h1")?.innerText || document.title?.replace(/\s+-\s+TikTok Shop.*$/i, "") || "not shown",
    mainImage: abs(document.querySelector('meta[property="og:image"]')?.content || document.querySelector("img")?.currentSrc || document.querySelector("img")?.src),
    rating: text.match(/\n([0-5](?:\.\d+)?)\n[\d,.]+\s*条/)?.[1] || text.match(/([0-5](?:\.\d+)?)\s*\([\d,.Kk]+\)/)?.[1] || null,
    reviewCount: text.match(/([\d,.]+)\s*条全球评价/)?.[1] || text.match(/\(([\d,.Kk]+)\)/)?.[1] || null,
    soldCount: text.match(/已售\s*([\d,.KkMm万+]+)/)?.[1] || text.match(/sold\s*([\d,.KkMm+]+)/i)?.[1] || null,
    shopName: text.match(/销售店铺\s*([^\n]+)/)?.[1]?.trim() || "not shown",
  });

  function readLoaderData() {
    const productId = (location.href.match(/\/(\d{12,})(?:[/?#]|$)/) || [])[1] || "";
    for (const script of [...document.scripts]) {
      const content = script.textContent || "";
      if (!content.includes('"loaderData"') || (productId && !content.includes(productId))) continue;
      try {
        const root = JSON.parse(content);
        const pageKey = Object.keys(root.loaderData || {}).find((key) => key.includes("pdp") && key.includes("page"));
        const page = root.loaderData?.[pageKey];
        const components = Object.values(page?.page_config?.components_map || {});
        const productInfo = components.map((component) => component?.component_data?.product_info).find(Boolean);
        if (productInfo) return { page, productInfo };
      } catch {}
    }
    return null;
  }

  const loader = readLoaderData();
  const productInfo = loader?.productInfo || {};
  const product = productInfo.product_model || {};
  const review = productInfo.review_model || {};
  const seller = productInfo.seller_model || {};
  const promotion = productInfo.promotion_model?.promotion_product_price || {};
  const skuPrices = promotion.skus_price || {};
  const fallback = domFallback();

  const propertyImageByValueId = new Map();
  for (const property of product.sale_properties || []) {
    for (const value of property.property_values || []) {
      const image = firstImageUrl(value.image);
      if (value.property_value_id && image) propertyImageByValueId.set(String(value.property_value_id), image);
    }
  }

  const specs = {};
  for (const property of product.product_properties || []) {
    const key = property.property_name;
    const values = (property.property_values || []).map((value) => value.property_value_name).filter(Boolean);
    if (key) specs[key] = values.length ? values.join(", ") : "not shown";
  }

  const skus = (product.skus || []).map((sku, index) => {
    const pairs = sku.property_pairs || [];
    const pairName = pairs.map((pair) => pair.sku_property_value_name).filter(Boolean).join(" / ");
    const image = pairs.map((pair) => propertyImageByValueId.get(String(pair.sku_property_value_id))).find(Boolean) || firstImageUrl(sku.sku_image);
    const price = skuPrices[String(sku.sku_id)] || (promotion.min_price?.sku_id === sku.sku_id ? promotion.min_price : null);
    return {
      skuId: String(sku.sku_id || index),
      name: sku.sku_name || pairName || `SKU ${index + 1}`,
      salePrice: moneyText(price),
      salePriceValue: moneyValue(price),
      originalPrice: price?.origin_price_format ? `${price.currency_symbol || ""}${price.origin_price_format}` : null,
      discount: price?.discount_format || null,
      stock: sku.sku_quantity?.available_quantity ?? null,
      image,
    };
  });

  const images = uniq((product.images || []).map(firstImageUrl));
  const details = { ...specs };
  if (product.description) details.Description = product.description;

  return {
    platform: "tiktok",
    finalUrl: location.href,
    title: product.name || fallback.title,
    shopName: seller.shop_name || fallback.shopName,
    mainImage: images[0] || fallback.mainImage,
    images,
    skus,
    rating: review.product_overall_score ?? fallback.rating,
    reviewCount: review.product_review_count ?? fallback.reviewCount,
    soldCount: product.sold_count ?? fallback.soldCount,
    productSpecifications: specs,
    productDetails: details,
    visibleReviews: [],
    blocked: /captcha|verify|robot|security check|access denied|验证|驗證/i.test(text + location.href),
    moduleReady: Boolean(product.name || product.product_id || skus.length || fallback.title),
  };
}

async function waitForProduct(cdp, platform, timeoutMs = 55000) {
  const start = Date.now();
  let last = null;
  const extractorMap = {
    lazada: extractLazadaProductInPage,
    shopee: extractShopeeProductInPage,
    tiktok: extractTikTokProductInPage,
  };
  const extractor = extractorMap[platform] || extractLazadaProductInPage;
  while (Date.now() - start < timeoutMs) {
    const out = await cdp.send("Runtime.evaluate", {
      expression: `(${extractor.toString()})()`,
      returnByValue: true,
      awaitPromise: true,
    });
    last = out.result?.result?.value || null;
    if (last?.moduleReady && !last?.blocked && last.title) return last;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return last;
}

function extractSearchResultsInPage(platform) {
  const abs = (href) => {
    if (!href) return null;
    try {
      return new URL(href, location.href).href;
    } catch {
      return null;
    }
  };
  const cleanUrl = (href) => {
    const url = abs(href);
    if (!url) return null;
    try {
      const parsed = new URL(url);
      if (platform === "lazada") return `${parsed.origin}${parsed.pathname}`;
      if (platform === "shopee") return `${parsed.origin}${parsed.pathname}`;
      if (platform === "tiktok") return `${parsed.origin}${parsed.pathname}`;
      return url;
    } catch {
      return url;
    }
  };
  const isProductUrl = (href) => {
    const url = cleanUrl(href);
    if (!url) return false;
    if (platform === "lazada") return /lazada\./i.test(url) && (/\/products\//i.test(url) || /-i\d+/i.test(url)) && /\.html/i.test(url);
    if (platform === "shopee") return /shopee\./i.test(url) && (/-i\.\d+\.\d+/i.test(url) || /\/product\/\d+\/\d+/i.test(url));
    if (platform === "tiktok") return /shop\.tiktok\.com/i.test(url) && /\/pdp\//i.test(url) && /\/\d{12,}/.test(url);
    return false;
  };
  const parseSales = (text) => {
    const source = String(text || "").replace(/\s+/g, " ");
    const patterns = [
      /([\d,.]+)\s*([KkMm])?\+?\s*(?:sold|已售|销量|ขายแล้ว|terjual|đã bán|sold out)/i,
      /(?:sold|已售|销量|ขายแล้ว|terjual|đã bán)\s*([\d,.]+)\s*([KkMm万])?\+?/i,
    ];
    for (const pattern of patterns) {
      const match = source.match(pattern);
      if (!match) continue;
      let value = Number(String(match[1]).replace(/,/g, ""));
      if (!Number.isFinite(value)) continue;
      const unit = String(match[2] || "").toLowerCase();
      if (unit === "k") value *= 1000;
      if (unit === "m") value *= 1000000;
      if (unit === "万") value *= 10000;
      return { value, text: match[0] };
    }
    return { value: 0, text: "" };
  };
  const nearestText = (anchor) => {
    let node = anchor;
    let best = anchor.innerText || anchor.textContent || "";
    for (let i = 0; node && i < 7; i += 1) {
      const text = node.innerText || node.textContent || "";
      if (text.length > best.length && text.length < 2500) best = text;
      node = node.parentElement;
    }
    return best;
  };

  const results = [];
  const seen = new Set();
  for (const anchor of [...document.querySelectorAll("a[href]")]) {
    if (!isProductUrl(anchor.href)) continue;
    const url = cleanUrl(anchor.href);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const cardText = nearestText(anchor);
    const sales = parseSales(cardText);
    const title =
      (anchor.innerText || anchor.textContent || "").trim() ||
      anchor.querySelector("img")?.alt ||
      cardText.split("\n").map((line) => line.trim()).find((line) => line.length > 12) ||
      "not shown";
    results.push({
      url,
      title: String(title).replace(/\s+/g, " ").trim().slice(0, 220),
      soldText: sales.text,
      soldValue: sales.value,
      order: results.length + 1,
    });
  }

  const hasSales = results.some((item) => item.soldValue > 0);
  const sorted = hasSales
    ? [...results].sort((a, b) => b.soldValue - a.soldValue || a.order - b.order)
    : results;
  const text = document.body?.innerText || "";
  return {
    finalUrl: location.href,
    results: sorted.slice(0, 12),
    blocked: /captcha|verify|traffic\/error|robot|security check|unusual traffic|_____tmd_____\/punish|x5secdata|验证码|驗證|滑块/i.test(text + location.href + document.title),
    moduleReady: results.length > 0,
    usedVisibleSales: hasSales,
  };
}

async function discoverTopLinks({ keyword, country, site, limit = 5 }) {
  const search = buildSearchUrl({ keyword, country, site });
  const target = await getPageTarget();
  if (!target?.webSocketDebuggerUrl) throw new Error("没有找到可用的 Chrome 调试页面。请先启动 Chrome 调试会话。");

  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  let guard;
  let searchData = null;
  try {
    await cdp.send("Runtime.enable");
    guard = await configuredChromeNavigationGuard(cdp);
    await guard.navigate(search.url);
    await new Promise((resolve) => setTimeout(resolve, search.platform === "tiktok" ? 9500 : 7500));
    await guard.throwIfBlocked();
    for (let i = 0; i < 5; i += 1) {
      await cdp.send("Runtime.evaluate", {
        expression: `window.scrollTo(0, document.body.scrollHeight * ${Math.min(0.25 + i * 0.18, 0.95)})`,
        returnByValue: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 900));
    }
    const start = Date.now();
    while (Date.now() - start < 25000) {
      const out = await cdp.send("Runtime.evaluate", {
        expression: `(${extractSearchResultsInPage.toString()})(${JSON.stringify(search.platform)})`,
        returnByValue: true,
        awaitPromise: true,
      });
      searchData = out.result?.result?.value || null;
      if (searchData?.moduleReady || searchData?.blocked) break;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    await guard.throwIfBlocked();
    if (searchData?.finalUrl) await chromeNetworkPolicy.validateUrl(searchData.finalUrl);
  } finally {
    await guard?.dispose();
    cdp.close();
  }

  const results = (searchData?.results || []).slice(0, limit);
  return {
    ...search,
    keyword,
    searchUrl: search.url,
    finalUrl: searchData?.finalUrl || search.url,
    usedVisibleSales: Boolean(searchData?.usedVisibleSales),
    blocked: Boolean(searchData?.blocked),
    results,
    links: results.map((item) => item.url),
  };
}

function sanitizeProductDescription(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 1500);
}

function sanitizeProductImage(value) {
  if (!value || typeof value !== "object") return null;
  const name = String(value.name || "reference-image").slice(0, 160);
  const type = String(value.type || "");
  const size = Number(value.size || 0);
  const dataUrl = String(value.dataUrl || "");
  if (!type.startsWith("image/")) return null;
  if (!dataUrl.startsWith("data:image/")) return null;
  if (!Number.isFinite(size) || size <= 0 || size > 2 * 1024 * 1024) return null;
  if (dataUrl.length > 3 * 1024 * 1024) return null;
  return { name, type, size, dataUrl };
}

function fallbackKeywordFromDescription(description) {
  const words = String(description || "")
    .replace(/[^\p{L}\p{N}\s+.-]/gu, " ")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 2)
    .slice(0, 8);
  return words.join(" ").slice(0, 90);
}

async function optimizeDiscoveryKeyword({ keyword, productDescription, productImage, country, site, model }) {
  const originalKeyword = String(keyword || "").trim();
  const description = sanitizeProductDescription(productDescription);
  const fallback = (originalKeyword || fallbackKeywordFromDescription(description) || "product").slice(0, 90);
  if (!description) return { keyword: fallback, reason: "使用用户输入的关键词。" };

  const key = getDeepSeekApiKey();
  if (!key) return { keyword: fallback, reason: "未配置 DeepSeek，已使用关键词或产品描述生成搜索词。" };

  try {
    const response = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: model || "deepseek-chat",
        stream: false,
        messages: [
          {
            role: "system",
            content: [
              "你是跨境电商搜索关键词专家。",
              "根据用户关键词和产品描述，为 Lazada、Shopee 或 TikTok Shop 生成一个更适合搜索销量 TOP5 商品的短关键词。",
              "当前模型只接收图片文件名、类型和大小，不能视觉识别图片内容；不要声称看到了图片。",
              "只返回 JSON，不要 Markdown。结构：{\"keyword\":\"...\",\"reason\":\"...\"}",
              "keyword 使用英文或平台常用搜索词，2-6 个词，避免品牌词和过长修饰。",
            ].join("\n"),
          },
          {
            role: "user",
            content: JSON.stringify({
              userKeyword: originalKeyword,
              productDescription: description,
              country,
              site,
              uploadedImage: productImage ? {
                name: productImage.name,
                type: productImage.type,
                size: productImage.size,
              } : null,
            }, null, 2),
          },
        ],
      }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error?.message || `DeepSeek API 请求失败：${response.status}`);
    const parsed = parseDeepSeekJson(data?.choices?.[0]?.message?.content || "");
    const optimized = String(parsed?.keyword || "").replace(/\s+/g, " ").trim().slice(0, 90);
    if (!optimized) return { keyword: fallback, reason: "DeepSeek 未返回有效关键词，已使用备用搜索词。" };
    return {
      keyword: optimized,
      reason: String(parsed?.reason || "已结合产品描述优化关键词。").replace(/\s+/g, " ").trim().slice(0, 220),
    };
  } catch (error) {
    return { keyword: fallback, reason: `关键词优化失败，已使用备用搜索词：${error.message}`.slice(0, 220) };
  }
}

async function extractProducts(urls) {
  const target = await getPageTarget();
  if (!target?.webSocketDebuggerUrl) throw new Error("没有找到可用的 Chrome 调试页面。请先启动 Chrome 调试会话。");

  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  let guard;
  const products = [];
  try {
    await cdp.send("Runtime.enable");
    guard = await configuredChromeNavigationGuard(cdp);
    for (const [index, inputUrl] of urls.entries()) {
      const platform = detectPlatform(inputUrl);
      if (platform === "unknown") throw new Error(`暂不支持这个平台链接：${inputUrl}`);
      await guard.navigate(inputUrl);
      await new Promise((resolve) => setTimeout(resolve, platform === "shopee" || platform === "tiktok" ? 8500 : 6000));
      await guard.throwIfBlocked();
      await cdp.send("Runtime.evaluate", {
        expression: "window.scrollTo(0, document.body.scrollHeight * 0.72)",
        returnByValue: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 2500));
      const product = await waitForProduct(cdp, platform);
      await guard.throwIfBlocked();
      if (product?.finalUrl) await chromeNetworkPolicy.validateUrl(product.finalUrl);
      products.push({
        ...product,
        platform,
        inputUrl,
        index,
        role: index === 0 ? "mine" : "competitor",
        needsVerification: Boolean(product?.blocked || !product?.moduleReady),
        verificationUrl: product?.blocked ? product.finalUrl : inputUrl,
      });
    }
  } finally {
    await guard?.dispose();
    cdp.close();
  }
  return products;
}

function parseMabangLimit(value) {
  const raw = String(value || "2").trim().toLowerCase();
  if (!raw || raw === "all" || raw === "全部") return "all";
  const number = Number.parseInt(raw, 10);
  if (!Number.isFinite(number) || number <= 0) throw new Error("获取条数请输入正整数或“全部”。");
  return Math.min(number, 1000);
}

function dateInRange(value, start, end) {
  const date = String(value || "").slice(0, 10);
  if (!date) return false;
  if (start && date < start) return false;
  if (end && date > end) return false;
  return true;
}

async function getMabangTarget() {
  const targets = await getChromeTargets();
  return (
    targets.find((target) => target.type === "page" && /mabangerp\.com/i.test(target.url || "")) ||
    targets.find((target) => target.type === "page") ||
    targets[0]
  );
}

async function collectMabangOrders(filters) {
  const status = String(filters.status || "").trim();
  if (!status) throw new Error("请选择订单状态。");
  const allowed = new Set(["全部订单", "未付款", "待审核", "待合并", "待处理", "配货中", "已发货", "待揽收", "已作废"]);
  if (!allowed.has(status)) throw new Error(`暂不支持这个订单状态：${status}`);

  const limit = parseMabangLimit(filters.limit);
  const target = await getMabangTarget();
  if (!target?.webSocketDebuggerUrl) throw new Error("没有找到可用的 Chrome 调试页面。请先打开马帮订单页并登录。");

  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  let guard;
  try {
    await cdp.send("Runtime.enable");
    guard = await configuredChromeNavigationGuard(cdp);
    if (!/mabangerp\.com\/index\.php\?mod=order\.list/i.test(target.url || "")) {
      await guard.navigate("https://900445.private.mabangerp.com/index.php?mod=order.list");
      await new Promise((resolve) => setTimeout(resolve, 12000));
    } else await chromeNetworkPolicy.validateUrl(target.url);
    await guard.throwIfBlocked();
    const clickOut = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const wanted = ${JSON.stringify(status)};
        const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
        const active = clean(document.querySelector("#order-tab-new li.active")?.innerText || "");
        if (active.startsWith(wanted)) return { clicked: true, skipped: true, text: active, url: location.href };
        const tabs = Array.from(document.querySelectorAll("#order-tab-new li, #order-tab-new a, #order-tab-new span"));
        const el = tabs.find((node) => clean(node.innerText || node.textContent).startsWith(wanted));
        if (!el) return { clicked: false, url: location.href, title: document.title, text: (document.body.innerText || "").slice(0, 500) };
        const clickable = el.closest("li") || el;
        clickable.click();
        return { clicked: true, text: clean(clickable.innerText || clickable.textContent), url: location.href };
      })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    const clickResult = clickOut.result?.result?.value;
    if (!clickResult?.clicked) {
      throw new Error("没有在马帮订单页找到对应订单状态。请确认已登录并能看到订单列表。");
    }

    for (let attempt = 0; attempt < 25; attempt += 1) {
      const ready = await cdp.send("Runtime.evaluate", {
        expression: `document.querySelectorAll(".custom-list .productTr").length`,
        returnByValue: true,
      });
      const count = Number(ready.result?.result?.value || 0);
      if (count > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    for (let i = 0; i < 8; i += 1) {
      await cdp.send("Runtime.evaluate", {
        expression: `window.scrollTo(0, document.body.scrollHeight * ${Math.min(0.2 + i * 0.1, 0.95)})`,
        returnByValue: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await cdp.send("Runtime.evaluate", { expression: "window.scrollTo(0, 0)", returnByValue: true });

    const out = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const clean = (value) => String(value || "").replace(/\\u00a0/g, " ").replace(/\\s+/g, " ").trim();
        const lines = (value) => String(value || "").split(/\\n+/).map((line) => clean(line)).filter(Boolean);
        const amountLines = (list) => list.filter((line) => /(?:PHP|MYR|THB|IDR|VND|SGD|RMB|₱|RM|฿)/i.test(line) || /^\\d+(?:,\\d{3})*\\.\\d{4}$/.test(line));
        const pickMain = (mainText) => {
          const list = lines(mainText);
          const platformIndex = list.findIndex((line) => /Lazada|Shopee|TikTok|Tiktok/i.test(line));
          const platformRaw = platformIndex >= 0 ? list[platformIndex] : "";
          const platform = platformRaw.match(/Lazada|Shopee|TikTok|Tiktok/i)?.[0] || "";
          const storeName = list[platformIndex + 1] || "";
          const managerName = list[platformIndex + 2] || "";
          const tradeIndex = list.findIndex((line, index) => index > platformIndex && /^\\d{12,22}$/.test(line));
          const tradeNo = tradeIndex >= 0 ? list[tradeIndex] : "";
          const buyerName = tradeIndex >= 0 ? list[tradeIndex + 1] || "" : "";
          const country = list.find((line) => /菲律宾|泰国|马来西亚|新加坡|越南|印尼|中国|Philippines|Thailand|Malaysia|Singapore|Vietnam|Indonesia/i.test(line)) || "";
          const paymentMethod = list.find((line) => /COD|PAY|GCASH|BANK|CARD|TNG|LATER|【/.test(line)) || "";
          const amounts = amountLines(list);
          const dates = list.filter((line) => /^\\d{4}-\\d{2}-\\d{2}/.test(line));
          const logistics = list.find((line) => /standard|express|logistics|物流|J&T|Kerry|Ninja|LGS/i.test(line)) || "";
          return {
            platform,
            storeName,
            managerName,
            tradeNo,
            buyerName,
            country,
            logistics,
            paymentMethod,
            orderAmount: amounts[0] || "",
            orderAmountOriginal: amounts[1] || "",
            incomeShipping: amounts[2] || "",
            paidAmount: amounts[3] || "",
            paymentDate: dates[0] || "",
            shipDate: dates[1] || "",
          };
        };
        const pickPackage = (packageText) => {
          const list = lines(packageText);
          const packageNo = list.find((line) => /^\\d{14,30}$/.test(line)) || "";
          const status = list.find((line) => /未付款|待审核|待合并|待处理|配货中|已发货|待揽收|已作废|已妥投/.test(line)) || "";
          const skus = packageText.match(/[A-Z]{1,5}[0-9A-Z]{4,}\\*\\d+(?:（[^）]+）)?/g) || [];
          const trackingNo = list.find((line) => /^[A-Z0-9]{8,30}$/i.test(line) && line !== packageNo && !skus.some((sku) => sku.includes(line))) || "";
          const batchMatch = packageText.match(/【预报批次】([^\\s]+)/);
          const logistics = list.find((line) => /Kerry|J&T|Ninja|LGS|物流|渠道|Native|Shopee|Lazada/i.test(line)) || "";
          const shippingCost = list.find((line) => /RMB$/i.test(line)) || "";
          return {
            packageNo,
            status,
            skus,
            logistics,
            trackingNo,
            batchNo: batchMatch?.[1] || "",
            shippingCost,
            packageText: clean(packageText),
          };
        };
        const rows = Array.from(document.querySelectorAll(".custom-list .productTr"))
          .filter((row) => row.offsetWidth || row.offsetHeight || row.getClientRects().length)
          .map((row, index) => {
          const mainText = row.previousElementSibling?.innerText || row.parentElement?.querySelector("ul")?.innerText || "";
          const packageText = row.querySelector(".packageinfo")?.innerText || row.innerText || "";
          const main = pickMain(mainText);
          const pkg = pickPackage(packageText);
          return {
            index: index + 1,
            ...main,
            ...pkg,
            logistics: pkg.logistics || main.logistics,
            rawMainText: clean(mainText).slice(0, 1000),
            rawPackageText: clean(packageText).slice(0, 1000),
          };
        });
        return {
          url: location.href,
          title: document.title,
          activeTab: clean(document.querySelector("#order-tab-new li.active")?.innerText || ""),
          statusButton: clean(document.querySelector("#statusButton")?.innerText || ""),
          visibleCount: rows.length,
          orders: rows,
        };
      })()`,
      returnByValue: true,
      awaitPromise: true,
    });

    const pageData = out.result?.result?.value || { orders: [] };
    await guard.throwIfBlocked();
    if (pageData.url) await chromeNetworkPolicy.validateUrl(pageData.url);
    const storeName = String(filters.storeName || "").trim().toLowerCase();
    const managerName = String(filters.managerName || "").trim().toLowerCase();
    const dateStart = String(filters.dateStart || "").trim();
    const dateEnd = String(filters.dateEnd || "").trim();
    let orders = (pageData.orders || []).filter((order) => {
      if (!order.packageNo && !order.status && !(order.skus || []).length) return false;
      if (storeName && !String(order.storeName || "").toLowerCase().includes(storeName)) return false;
      if (managerName && !String(order.managerName || "").toLowerCase().includes(managerName)) return false;
      if ((dateStart || dateEnd) && !dateInRange(order.paymentDate, dateStart, dateEnd)) return false;
      return true;
    });
    if (limit !== "all") orders = orders.slice(0, limit);
    return {
      ...pageData,
      filters: {
        status,
        dateStart,
        dateEnd,
        storeName: filters.storeName || "",
        managerName: filters.managerName || "",
        limit,
      },
      matchedCount: orders.length,
      orders,
    };
  } finally {
    await guard?.dispose();
    cdp.close();
  }
}

function getBlockedProducts(products) {
  return products
    .filter((product) => product?.needsVerification)
    .map((product) => ({
      index: product.index,
      role: product.role,
      platform: product.platform,
      inputUrl: product.inputUrl,
      currentUrl: product.finalUrl,
      verificationUrl: product.verificationUrl || product.inputUrl,
      title: product.title || "验证码拦截",
    }));
}

function priceValue(sku) {
  if (!sku) return null;
  if (typeof sku.salePriceValue === "number") return sku.salePriceValue;
  const raw = String(sku.salePrice || "").replace(/[^\d.]/g, "");
  return raw ? Number(raw) : null;
}

function parseSkuDimension(name) {
  const text = String(name || "").toLowerCase().replace(/[×]/g, "*");
  let width = null;
  let length = null;
  let unit = "";
  const pairs = [...text.matchAll(/(\d+(?:\.\d+)?)\s*\*\s*(\d+(?:\.\d+)?)(?:\s*(cm|in|inch|inches))?/g)];
  if (pairs.length) {
    const parsedPairs = pairs.map((match) => {
      const a = Number(match[1]);
      const b = Number(match[2]);
      const explicitUnit = match[3] || "";
      const inferredUnit = explicitUnit
        ? explicitUnit
        : (a > 90 || b > 90) ? "cm" : "in";
      return {
        width: inferredUnit.startsWith("in") ? a * 2.54 : a,
        length: inferredUnit.startsWith("in") ? b * 2.54 : b,
        unit: inferredUnit.startsWith("in") ? "in" : "cm",
        explicit: Boolean(explicitUnit),
      };
    });
    const chosen =
      parsedPairs.find((pair) => pair.unit === "cm") ||
      parsedPairs.find((pair) => pair.explicit) ||
      parsedPairs[0];
    width = chosen.width;
    length = chosen.length;
    unit = chosen.unit;
  }
  const textWithoutDimensions = text.replace(/(\d+(?:\.\d+)?)\s*\*\s*(\d+(?:\.\d+)?)(?:\s*(cm|in|inch|inches))?/g, " ");
  const thicknessIn = textWithoutDimensions.match(/(?:^|[,\s])(\d+(?:\.\d+)?)\s*(?:in|inch|inches)\b/);
  const thicknessCm = textWithoutDimensions.match(/(?:^|[,\s])(\d+(?:\.\d+)?)\s*cm\b/);
  const thickness = thicknessIn ? Number(thicknessIn[1]) * 2.54 : thicknessCm ? Number(thicknessCm[1]) : null;
  return {
    width,
    length,
    thickness,
    unit,
    area: width && length ? width * length : null,
    sortValue: width && length ? width * 1000 + length : null,
  };
}

function dimensionDistance(a, b) {
  const x = parseSkuDimension(a?.name);
  const y = parseSkuDimension(b?.name);
  if (!x.width || !x.length || !y.width || !y.length) return null;
  const direct = Math.abs(x.width - y.width) + Math.abs(x.length - y.length);
  const swapped = Math.abs(x.width - y.length) + Math.abs(x.length - y.width);
  const sizeDistance = Math.min(direct, swapped);
  const thicknessDistance = x.thickness && y.thickness ? Math.abs(x.thickness - y.thickness) * 0.25 : 0;
  return sizeDistance + thicknessDistance;
}

function dimensionNormalizedName(mySku, competitorSku) {
  const parsed = parseSkuDimension(mySku?.name || competitorSku?.name);
  const base = parsed.width && parsed.length ? `${Math.round(parsed.width)}*${Math.round(parsed.length)}cm` : (mySku?.name || competitorSku?.name || "");
  const thickness = parsed.thickness ? `${Math.round(parsed.thickness)}cm厚` : "";
  return [thickness, base].filter(Boolean).join(" ");
}

function skuStableKey(sku, index) {
  return String(sku?.skuId || sku?.name || index);
}

function normalizeSkuName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/["']/g, "")
    .replace(/\b(inch|inches)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function skuTokens(name) {
  const normalized = normalizeSkuName(name);
  return {
    normalized,
    size: normalized.match(/\d+(?:\.\d+)?\s*l|\d+(?:\.\d+)?\s*(?:cm|m)|\d+(?:\.\d+)?/)?.[0]?.replace(/\s+/g, "") || "",
    remote: /remote/.test(normalized),
    button: /button/.test(normalized),
    touch: /touch|touched|touchable/.test(normalized),
    standard: /standard/.test(normalized),
    hz: normalized.match(/\d+\s*hz/)?.[0]?.replace(/\s+/g, "") || "",
    resolution: normalized.match(/\d{3,4}p/)?.[0] || "",
  };
}

function compareSkuRows(a, b) {
  const aSort = Number.isFinite(a.sortValue) ? a.sortValue : null;
  const bSort = Number.isFinite(b.sortValue) ? b.sortValue : null;
  if (aSort != null && bSort != null && aSort !== bSort) return aSort - bSort;
  if (aSort != null && bSort == null) return -1;
  if (aSort == null && bSort != null) return 1;
  const aPrice = priceValue(a.mySku) ?? priceValue(a.competitorSku) ?? Number.POSITIVE_INFINITY;
  const bPrice = priceValue(b.mySku) ?? priceValue(b.competitorSku) ?? Number.POSITIVE_INFINITY;
  if (aPrice !== bPrice) return aPrice - bPrice;
  return String(a.normalizedName || a.mySku?.name || a.competitorSku?.name || "").localeCompare(
    String(b.normalizedName || b.mySku?.name || b.competitorSku?.name || ""),
    "zh-CN",
    { numeric: true },
  );
}

function finalizeSkuComparisonRows(rows) {
  return rows.map((row) => {
    const myPrice = priceValue(row.mySku);
    const compPrice = priceValue(row.competitorSku);
    let advantage = row.advantage || "not comparable";
    if (myPrice != null && compPrice != null) {
      if (myPrice < compPrice) advantage = "mine";
      else if (myPrice > compPrice) advantage = "competitor";
      else advantage = "tie";
    } else if (!row.mySku && row.competitorSku) {
      advantage = "competitor-coverage";
    } else if (row.mySku && !row.competitorSku) {
      advantage = "mine-coverage";
    }
    return {
      ...row,
      advantage,
      difference: myPrice != null && compPrice != null ? Math.abs(myPrice - compPrice) : null,
    };
  }).sort(compareSkuRows);
}

function skuSimilarity(a, b) {
  const distance = dimensionDistance(a, b);
  if (distance != null) return Math.max(0, 20 - distance);
  const x = skuTokens(a?.name);
  const y = skuTokens(b?.name);
  let score = 0;
  if (x.size && x.size === y.size) score += 5;
  if (x.remote === y.remote) score += 2;
  if (x.button === y.button) score += 2;
  if (x.touch === y.touch) score += 2;
  if (x.standard === y.standard) score += 1;
  if (x.hz && x.hz === y.hz) score += 1;
  if (x.resolution && x.resolution === y.resolution) score += 1;
  if (x.normalized === y.normalized) score += 8;
  return score;
}

function buildSkuComparison(products) {
  const mine = products[0];
  const competitor = products[1];
  if (!mine) return [];
  if (!competitor) {
    return (mine.skus || []).map((mySku) => ({
      mySku,
      competitorSku: null,
      matchScore: 0,
      advantage: "not comparable",
      difference: null,
    }));
  }

  const mineSkus = mine.skus || [];
  const compSkus = competitor.skus || [];
  const candidates = [];
  for (const [myIndex, mySku] of mineSkus.entries()) {
    for (const [compIndex, compSku] of compSkus.entries()) {
      candidates.push({ myIndex, compIndex, score: skuSimilarity(mySku, compSku) });
    }
  }
  candidates.sort((a, b) => b.score - a.score);

  const usedMine = new Set();
  const usedComp = new Set();
  const rows = [];
  for (const candidate of candidates) {
    if (candidate.score < 5) continue;
    if (usedMine.has(candidate.myIndex) || usedComp.has(candidate.compIndex)) continue;
    usedMine.add(candidate.myIndex);
    usedComp.add(candidate.compIndex);
    const mySku = mineSkus[candidate.myIndex];
    const compSku = compSkus[candidate.compIndex];
    rows.push({
      mySku,
      competitorSku: compSku,
      matchScore: candidate.score,
      normalizedName: dimensionNormalizedName(mySku, compSku) || mySku.name || compSku.name || "",
      matchReason: "按 SKU 规格/尺寸全局最优匹配",
      sortValue: parseSkuDimension(mySku.name || compSku.name).sortValue ?? priceValue(mySku) ?? priceValue(compSku),
    });
  }

  for (const [index, mySku] of mineSkus.entries()) {
    if (!usedMine.has(index)) {
      rows.push({
        mySku,
        competitorSku: null,
        matchScore: 0,
        normalizedName: dimensionNormalizedName(mySku, null) || mySku.name || "",
        matchReason: "我的链接独有 SKU，未找到足够相似的竞品 SKU",
        sortValue: parseSkuDimension(mySku.name).sortValue ?? priceValue(mySku),
        advantage: "mine-coverage",
        difference: null,
      });
    }
  }

  for (const [index, compSku] of compSkus.entries()) {
    if (!usedComp.has(index)) {
      rows.push({ mySku: null, competitorSku: compSku, matchScore: 0, normalizedName: dimensionNormalizedName(null, compSku) || compSku.name || "", matchReason: "竞品独有 SKU", sortValue: parseSkuDimension(compSku.name).sortValue ?? priceValue(compSku), advantage: "competitor-coverage", difference: null });
    }
  }

  return finalizeSkuComparisonRows(rows);
}

async function buildSmartSkuComparison(products, model) {
  const mine = products[0];
  const competitor = products[1];
  const fallback = buildSkuComparison(products);
  if (!mine || !competitor || !(mine.skus || []).length || !(competitor.skus || []).length) return fallback;
  const dimensionReady =
    (mine.skus || []).some((sku) => parseSkuDimension(sku.name).width && parseSkuDimension(sku.name).length) &&
    (competitor.skus || []).some((sku) => parseSkuDimension(sku.name).width && parseSkuDimension(sku.name).length);

  const key = getDeepSeekApiKey();
  if (!key) return fallback;

  const compactSkus = (skus) => (skus || []).slice(0, 120).map((sku, index) => ({
    index,
    id: skuStableKey(sku, index),
    name: sku.name || "",
    price: sku.salePrice || "",
    priceValue: priceValue(sku),
    stock: sku.stock ?? "",
  }));

  try {
    const response = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: model || "deepseek-chat",
        stream: false,
        messages: [
          {
            role: "system",
            content: [
              "你是跨境电商 SKU 名称翻译与匹配专家。",
              "任务：把我的 SKU 与竞品 SKU 翻译/归一化后，找出相同或最相似的组合，并给出排序字段。",
              "必须只返回 JSON，不要 Markdown，不要代码块。",
              "JSON 结构：",
              "{",
              '  "matches": [',
              '    {"myIndex":0,"competitorIndex":1,"normalizedName":"15.6英寸 1080P 75Hz","confidence":0.92,"sortValue":15.6,"sortText":"15.6 inch","reason":"尺寸、刷新率、分辨率一致"}',
              "  ]",
              "}",
              "规则：",
              "1. myIndex 或 competitorIndex 可为 null，表示一方独有 SKU。",
              "2. 每个 myIndex 和 competitorIndex 最多使用一次。",
              "3. normalizedName 用中文，包含关键规格，例如尺寸/容量/颜色/套餐/数量。",
              "4. confidence 0-1，低于 0.55 的不应强行配对，应该拆成一方独有。",
              "5. sortValue 优先用可比较的规格数值，例如尺寸、容量、件数；没有规格时用价格数值；没有则 null。",
              "6. 只做语义和规格匹配，不要根据价格高低强行匹配。",
            ].join("\n"),
          },
          {
            role: "user",
            content: JSON.stringify({
              myProduct: { title: mine.title, platform: mine.platform },
              competitorProduct: { title: competitor.title, platform: competitor.platform },
              mySkus: compactSkus(mine.skus),
              competitorSkus: compactSkus(competitor.skus),
            }, null, 2),
          },
        ],
      }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error?.message || `DeepSeek API 请求失败：${response.status}`);
    const parsed = parseDeepSeekJson(data?.choices?.[0]?.message?.content || "");
    const matches = Array.isArray(parsed?.matches) ? parsed.matches : [];
    if (dimensionReady) {
      return fallback.map((row) => ({
        ...row,
        matchSource: "dimension+deepseek",
        matchReason: row.mySku && row.competitorSku
          ? `${row.matchReason}；DeepSeek 已参与 SKU 翻译归一，尺寸硬规则优先防止错配`
          : row.matchReason,
      }));
    }
    if (!matches.length) return fallback;

    const usedMine = new Set();
    const usedComp = new Set();
    const rows = [];
    const readIndex = (value) => {
      if (value == null) return null;
      const number = Number(value);
      return Number.isInteger(number) ? number : null;
    };
    for (const match of matches) {
      const myIndex = readIndex(match.myIndex);
      const compIndex = readIndex(match.competitorIndex);
      if (myIndex != null && (myIndex < 0 || myIndex >= mine.skus.length || usedMine.has(myIndex))) continue;
      if (compIndex != null && (compIndex < 0 || compIndex >= competitor.skus.length || usedComp.has(compIndex))) continue;
      if (myIndex == null && compIndex == null) continue;
      const confidence = Number(match.confidence ?? 0);
      if (myIndex != null && compIndex != null && confidence < 0.55) continue;
      const mySku = myIndex != null ? mine.skus[myIndex] : null;
      const competitorSku = compIndex != null ? competitor.skus[compIndex] : null;
      if (myIndex != null) usedMine.add(myIndex);
      if (compIndex != null) usedComp.add(compIndex);
      rows.push({
        mySku,
        competitorSku,
        matchScore: confidence,
        matchSource: "deepseek",
        normalizedName: String(match.normalizedName || mySku?.name || competitorSku?.name || "").slice(0, 120),
        matchReason: String(match.reason || "DeepSeek 翻译归一后匹配").slice(0, 240),
        sortValue: Number.isFinite(Number(match.sortValue)) ? Number(match.sortValue) : null,
        sortText: String(match.sortText || "").slice(0, 80),
      });
    }

    for (const [index, mySku] of (mine.skus || []).entries()) {
      if (!usedMine.has(index)) {
        rows.push({
          mySku,
          competitorSku: null,
          matchScore: 0,
          matchSource: "deepseek",
          normalizedName: mySku.name || "",
          matchReason: "我的链接独有 SKU，DeepSeek 未找到高相似竞品 SKU",
          sortValue: priceValue(mySku),
        });
      }
    }
    for (const [index, competitorSku] of (competitor.skus || []).entries()) {
      if (!usedComp.has(index)) {
        rows.push({
          mySku: null,
          competitorSku,
          matchScore: 0,
          matchSource: "deepseek",
          normalizedName: competitorSku.name || "",
          matchReason: "竞品独有 SKU，DeepSeek 未找到高相似我的 SKU",
          sortValue: priceValue(competitorSku),
        });
      }
    }

    return finalizeSkuComparisonRows(rows);
  } catch {
    return fallback;
  }
}

const ATTRIBUTE_TRANSLATIONS = new Map([
  ["brand", "品牌"],
  ["model", "型号"],
  ["type", "类型"],
  ["color", "颜色"],
  ["colour", "颜色"],
  ["material", "材质"],
  ["dimension", "尺寸"],
  ["dimensions", "尺寸"],
  ["size", "尺寸"],
  ["weight", "重量"],
  ["capacity", "容量"],
  ["power", "功率"],
  ["voltage", "电压"],
  ["warranty", "保修"],
  ["warranty type", "保修类型"],
  ["warranty duration", "保修期"],
  ["warranty period", "保修期"],
  ["warranty policy", "保修政策"],
  ["condition", "成色/状态"],
  ["stock", "库存"],
  ["sku", "SKU"],
  ["package weight", "包装重量"],
  ["package dimensions", "包装尺寸"],
  ["number of pieces", "件数"],
  ["number of items", "件数"],
  ["quantity per pack", "每包装数量"],
  ["product line", "产品线"],
  ["certification", "认证"],
  ["features", "功能特性"],
  ["feature", "功能特性"],
  ["display features", "显示功能"],
  ["monitor feature", "显示器功能"],
  ["mounting type", "安装方式"],
  ["connectivity", "连接方式"],
  ["response time", "响应时间"],
  ["refresh frequency", "刷新率"],
  ["screen size", "屏幕尺寸"],
  ["refresh rate", "刷新率"],
  ["resolution", "分辨率"],
  ["panel type", "面板类型"],
  ["aspect ratio", "屏幕比例"],
  ["speaker", "扬声器"],
  ["built-in speaker", "内置扬声器"],
  ["interface", "接口"],
  ["ports", "接口"],
  ["การตั้งค่า", "适用场景"],
  ["จำนวนชั้น", "层数"],
  ["จํานวนชั้น", "层数"],
  ["การใช้งาน", "用途"],
  ["การติดตั้ง", "安装方式"],
  ["จำนวนต่อแพ็ค", "每包装数量"],
  ["จํานวนต่อแพ็ค", "每包装数量"],
  ["น้ำหนักที่รองรับ (กก.)", "承重（公斤）"],
  ["น้ําหนักที่รองรับ (กก.)", "承重（公斤）"],
  ["คุณสมบัติ", "功能特性"],
  ["วัสดุ", "材质"],
  ["แบรนด์", "品牌"],
  ["สี", "颜色"],
  ["ขนาด", "尺寸"],
  ["น้ำหนัก", "重量"],
  ["น้ําหนัก", "重量"],
  ["ประเภท", "类型"],
  ["รุ่น", "型号"],
  ["หมวดหมู่", "类目"],
  ["ประเทศต้นกำเนิด", "原产地"],
  ["ประเทศต้นกําเนิด", "原产地"],
  ["ระยะเวลาการรับประกัน", "保修期"],
  ["เงื่อนไขการรับประกัน", "保修条件"],
]);

function normalizeAttributeKey(key) {
  return String(key || "")
    .replace(/\s+/g, " ")
    .replace(/[:：]\s*$/, "")
    .trim()
    .toLowerCase();
}

function translateAttributeKey(key) {
  const raw = String(key || "").trim();
  if (!raw || /[\u4e00-\u9fff]/.test(raw)) return "";
  const normalized = normalizeAttributeKey(raw);
  if (ATTRIBUTE_TRANSLATIONS.has(raw)) return ATTRIBUTE_TRANSLATIONS.get(raw);
  if (ATTRIBUTE_TRANSLATIONS.has(normalized)) return ATTRIBUTE_TRANSLATIONS.get(normalized);
  if (/warranty/i.test(raw) && /duration|period|time/i.test(raw)) return "保修期";
  if (/warranty/i.test(raw)) return "保修";
  if (/brand/i.test(raw)) return "品牌";
  if (/model/i.test(raw)) return "型号";
  if (/material/i.test(raw)) return "材质";
  if (/dimension|size/i.test(raw)) return "尺寸";
  if (/weight/i.test(raw)) return "重量";
  if (/color|colour/i.test(raw)) return "颜色";
  return "";
}

function displayAttributeKey(key) {
  const translation = translateAttributeKey(key);
  return translation ? `${key}（${translation}）` : key;
}

function buildProductDetailsComparison(products) {
  const mine = products[0]?.productSpecifications || products[0]?.productDetails || {};
  const competitor = products[1]?.productSpecifications || products[1]?.productDetails || {};
  const keys = [...new Set([...Object.keys(mine), ...Object.keys(competitor)])];
  return keys.map((key) => {
    const myValue = mine[key] ?? "not shown";
    const compValue = competitor[key] ?? "not shown";
    let advantage = "tie";
    if (myValue === "not shown" && compValue !== "not shown") advantage = "competitor";
    else if (myValue !== "not shown" && compValue === "not shown") advantage = "mine";
    else if (/info unavailable|not shown/i.test(String(myValue)) && !/info unavailable|not shown/i.test(String(compValue))) advantage = "competitor";
    else if (!/info unavailable|not shown/i.test(String(myValue)) && /info unavailable|not shown/i.test(String(compValue))) advantage = "mine";
    return { key: displayAttributeKey(key), rawKey: key, mine: myValue, competitor: compValue, advantage };
  });
}

function buildDeterministicReport(products, options = {}) {
  return {
    products,
    skuComparison: options.skuComparison || buildSkuComparison(products),
    productDetailsComparison: buildProductDetailsComparison(products),
  };
}

function parseDeepSeekJson(content) {
  if (!content) return null;
  const cleaned = content.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function getDeepSeekApiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  if (process.platform !== "win32") return "";
  try {
    return execFileSync("powershell.exe", [
      "-NoProfile",
      "-Command",
      "[Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY','User')",
    ], { encoding: "utf8", windowsHide: true }).trim();
  } catch {
    return "";
  }
}

async function callDeepSeek({ model, report }) {
  const key = getDeepSeekApiKey();
  if (!key) throw new Error("缺少 DeepSeek API Key。请在后端环境变量 DEEPSEEK_API_KEY 中配置。");

  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: model || "deepseek-chat",
      stream: false,
      messages: [
        {
          role: "system",
          content: [
            "你是资深跨境电商竞品分析师，支持 Lazada、Shopee 和 TikTok Shop。",
            "基于结构化数据输出中文竞品分析，不要编造缺失字段。",
            "如果 report.discovery 存在，说明这是关键词销量 TOP5 竞品发现任务，请围绕 TOP5 链接的销量、评分、评论、价格带、SKU 覆盖、主图和规格完整度做选品/竞品结论。",
            "如果 report.discovery.referenceProduct 存在，可以使用产品描述作为搜索意图参考；上传图片仅作为报告参考图，当前文本模型不能视觉识别其内容，不要声称已看图。",
            "report.skuComparison 可能已经由 DeepSeek 翻译归一并匹配，SKU 模块要优先依据 normalizedName、matchReason、matchScore、价格差和覆盖缺口输出结论。",
            "必须只返回 JSON，不要 Markdown，不要代码块。",
            "JSON 结构固定为：",
            "{",
            '  "titleShop": ["..."],',
            '  "images": ["..."],',
            '  "ratingReviews": ["..."],',
            '  "sales": ["..."],',
            '  "skuComparison": ["..."],',
            '  "productDetails": ["..."],',
            '  "recommendations": ["..."]',
            "}",
            "每个数组内 2-5 条高信号中文结论。SKU 模块要说明谁低价、差多少、是否可直接横向对比。Product Specifications 模块要说明优势方和需要补充的字段。",
          ].join("\n"),
        },
        { role: "user", content: JSON.stringify(report, null, 2) },
      ],
    }),
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message || `DeepSeek API 请求失败：${response.status}`);
  const content = data.choices?.[0]?.message?.content || "";
  return { raw: content, modules: parseDeepSeekJson(content) };
}

async function callDeepSeekMainImage({ model, report }) {
  const key = getDeepSeekApiKey();
  if (!key) throw new Error("缺少 DeepSeek API Key。请在后端环境变量 DEEPSEEK_API_KEY 中配置。");

  const compactReport = {
    products: (report.products || []).map((product, index) => ({
      role: index === 0 ? "mine" : `competitor_${index}`,
      platform: product.platform,
      title: product.title,
      shopName: product.shopName,
      mainImage: product.mainImage,
      rating: product.rating,
      reviewCount: product.reviewCount,
      soldCount: product.soldCount,
      skuNames: (product.skus || []).slice(0, 20).map((sku) => sku.name),
      productSpecifications: product.productSpecifications || product.productDetails || {},
    })),
    skuComparison: report.skuComparison || [],
    productDetailsComparison: report.productDetailsComparison || [],
  };

  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: model || "deepseek-chat",
      stream: false,
      messages: [
        {
          role: "system",
          content: [
            "你是电商主图点击率分析师，支持 Lazada、Shopee 和 TikTok Shop 主图分析。",
            "分析目标：第一秒理解、产品清晰度、点击理由、与竞品主图区别、下一版具体修改。",
            "如果没有真实图片像素内容，只能说明视觉判断基于主图链接和结构化信息推断，不要声称看见图片细节。",
            "必须只返回 JSON，不要 Markdown，不要代码块。",
            "JSON 结构固定为：",
            "{",
            '  "summary": ["..."],',
            '  "productUser": [{"item":"Product type","conclusion":"..."}],',
            '  "firstSecond": [{"dimension":"Visual focus","current":"...","problem":"...","recommendation":"..."}],',
            '  "clickReasons": ["..."],',
            '  "headlineOptions": ["..."],',
            '  "composition": ["..."],',
            '  "competitorComparison": [{"item":"First visual focus","mine":"...","competitor":"...","opportunity":"..."}],',
            '  "checklist": {"mustChange":["..."],"niceToImprove":["..."],"keep":["..."],"abTests":["..."]},',
            '  "template": [{"module":"Suitable category","template":"..."}],',
            '  "scores": [{"item":"Product recognition","score":"1-5","note":"..."}]',
            "}",
          ].join("\n"),
        },
        { role: "user", content: JSON.stringify(compactReport, null, 2) },
      ],
    }),
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message || `DeepSeek API 请求失败：${response.status}`);
  const content = data.choices?.[0]?.message?.content || "";
  return { raw: content, modules: parseDeepSeekJson(content) };
}

async function handleApi(req, res, url) {
  const authResponse = authenticationApiResponse({
    method: req.method,
    pathname: url.pathname,
    headers: req.headers,
  }, accessPolicy);
  if (authResponse) return json(res, authResponse.status, authResponse.body);

  const accessResponse = protectedApiAccessResponse(req.headers, accessPolicy);
  if (accessResponse) return json(res, accessResponse.status, accessResponse.body);

  const auditHandled = await handleAuditApi(req, res, url);
  if (auditHandled) return true;

  const reviewHandled = await handleFileReviewApi(req, res, url);
  if (reviewHandled) return true;

  const lifecycleHandled = await handleFileLifecycleApi(req, res, url);
  if (lifecycleHandled) return true;

  const fileHandled = await handleFileApi(req, res, url);
  if (fileHandled) return true;

  if (url.pathname.startsWith("/api/ads/")) {
    return proxyAdServiceRequest(req, res, url, "api");
  }

  const schedulerHandled = await handleMabangSchedulerApi(req, res, url);
  if (schedulerHandled) return true;

  if (url.pathname === "/api/chrome/status") {
    try {
      const targets = await getChromeTargets();
      return json(res, 200, {
        ok: true,
        targets: targets
          .filter((target) => target.type === "page")
          .map((target) => ({ title: target.title, url: safeChromeTargetUrl(target.url) }))
          .filter((target) => target.url),
      });
    } catch {
      return json(res, 200, { ok: false, needsChrome: true, error: "Chrome 调试浏览器未连接。" });
    }
  }

  if (url.pathname === "/api/chrome/open") {
    if (req.method !== "POST") return json(res, 405, { ok: false, error: "Method not allowed" });
    const body = await readBody(req);
    try {
      const result = await navigateChromeBrowser(body.url || "https://www.lazada.com.ph/");
      return json(res, 200, { ok: true, mode: result.mode });
    } catch (error) {
      req.auditContext?.annotate({ errorStage: "chrome_navigation", errorCode: error.code || "CHROME_NAVIGATION_FAILED", errorSummary: error });
      return securityErrorResponse(res, error, {
        code: "CHROME_NAVIGATION_FAILED",
        message: "Chrome 导航失败。",
      });
    }
  }

  if (url.pathname === "/api/chrome/navigate") {
    if (req.method !== "POST") return json(res, 405, { ok: false, error: "Method not allowed" });
    const body = await readBody(req);
    try {
      const result = await navigateChromeBrowser(body.url || "https://www.lazada.com.ph/");
      return json(res, 200, { ok: true, mode: result.mode });
    } catch (error) {
      req.auditContext?.annotate({ errorStage: "chrome_navigation", errorCode: error.code || "CHROME_NAVIGATION_FAILED", errorSummary: error });
      return securityErrorResponse(res, error, {
        code: "CHROME_NAVIGATION_FAILED",
        message: "Chrome 导航失败。",
      });
    }
  }

  if (url.pathname === "/api/deepseek/status") {
    return json(res, 200, { ok: true, configured: Boolean(getDeepSeekApiKey()) });
  }

  if (url.pathname === "/api/ad-analyzer/status") {
    const status = await ensureAdAnalyzerServer();
    return json(res, status.ok ? 200 : 503, {
      ...status,
      url: "/ads/",
    });
  }

  if (url.pathname === "/api/mabang-data/login-test") {
    if (req.method !== "POST") return json(res, 405, { ok: false, error: "Method not allowed" });
    const body = await readBody(req);
    req.auditContext?.annotate({ actorIdentifier: body.username });
    try {
      const result = await runMabangWorker({
        action: "test-login",
        username: body.username,
        password: body.password,
      }, 90 * 1000);
      return json(res, 200, result);
    } catch (error) {
      req.auditContext?.annotate({ errorStage: "mabang_login", errorCode: error.code || "AUTH_FAILED", errorSummary: error });
      return json(res, 400, { ok: false, error: error.message });
    }
  }

  if (url.pathname === "/api/mabang-data/fields") {
    if (req.method !== "GET") return json(res, 405, { ok: false, error: "Method not allowed" });
    const kind = url.searchParams.get("kind") === "inventory" ? "inventory" : "orders";
    try {
      const result = await runMabangWorker({ action: "fields", kind }, 30 * 1000);
      return json(res, 200, result);
    } catch (error) {
      return json(res, 500, { ok: false, error: error.message });
    }
  }

  if (url.pathname === "/api/mabang-data/collect") {
    if (req.method !== "POST") return json(res, 405, { ok: false, error: "Method not allowed" });
    const body = await readBody(req);
    const kind = body.kind === "inventory" ? "inventory" : body.kind === "orders" ? "orders" : "";
    if (kind) {
      req.auditContext?.setOperation("mabang", kind === "inventory" ? "mabang.inventory.fetch" : "mabang.orders.fetch");
      req.auditContext?.annotate({ actorIdentifier: body.username, metadata: { kind } });
    }
    if (!kind) return json(res, 400, { ok: false, error: "请选择订单信息或库存信息。" });
    try {
      const result = await runMabangWorker({
        action: kind,
        username: body.username,
        password: body.password,
        startDate: body.startDate,
        endDate: body.endDate,
        orderFilters: kind === "orders" ? body.orderFilters : undefined,
      });
      const taskId = randomUUID();
      const task = {
        id: taskId,
        kind,
        columns: Array.isArray(result.columns) ? result.columns : [],
        records: Array.isArray(result.records) ? result.records : [],
        summary: result.summary || {},
        message: result.message || "采集完成。",
        createdAt: Date.now(),
      };
      mabangTasks.set(taskId, task);
      pruneMabangTasks();
      return json(res, 200, {
        ok: true,
        message: task.message,
        ...paginateMabangTask(task),
      });
    } catch (error) {
      req.auditContext?.annotate({ errorStage: kind === "inventory" ? "fetch_inventory" : "fetch_orders", errorCode: error.code || "MABANG_FETCH_FAILED", errorSummary: error });
      return json(res, 400, { ok: false, error: error.message });
    }
  }

  if (url.pathname === "/api/mabang-data/result") {
    if (req.method !== "GET") return json(res, 405, { ok: false, error: "Method not allowed" });
    try {
      const task = getMabangTask(url.searchParams.get("taskId"));
      const result = paginateMabangTask(task, {
        page: url.searchParams.get("page"),
        pageSize: url.searchParams.get("pageSize"),
        query: url.searchParams.get("query"),
        field: url.searchParams.get("field"),
      });
      return json(res, 200, { ok: true, message: task.message, ...result });
    } catch (error) {
      return json(res, 404, { ok: false, error: error.message });
    }
  }

  const manualExportDownloadMatch = url.pathname.match(/^\/api\/mabang-data\/export-files\/([^/]+)\/download$/);
  if (manualExportDownloadMatch) {
    if (req.method !== "GET") return json(res, 405, { ok: false, error: "Method not allowed" });
    const fileId = encodeURIComponent(decodeURIComponent(manualExportDownloadMatch[1]));
    return handleFileApi(req, res, new URL(`/api/files/${fileId}/download`, url.origin));
  }

  if (url.pathname === "/api/mabang-data/export") {
    if (req.method !== "POST") return json(res, 405, { ok: false, error: "Method not allowed" });
    const body = await readBody(req);
    req.auditContext?.annotate({ taskId: body.taskId, metadata: { kind: "manual_export" } });
    let temporaryFile = null;
    try {
      const task = getMabangTask(body.taskId);
      const requestId = validateFileId(body.requestId || randomUUID());
      const requestKey = `mabang_manual:${task.kind}:${requestId}`;
      const existing = exportFileService.getByRequestKey(requestKey);
      if (existing) {
        if (existing.status !== "available") throw new FilePolicyError(FILE_ERROR_CODES.FILE_NOT_AVAILABLE);
        req.auditContext?.annotate({ fileId: existing.id });
        return json(res, 200, {
          ok: true,
          reused: true,
          fileId: existing.id,
          filename: existing.originalFilename,
          exportedRows: Number(existing.metadata?.exportedRows || 0),
          downloadUrl: `/api/files/${existing.id}/download`,
        });
      }
      const filterField = task.columns.includes(body.field) ? body.field : "__all__";
      const records = filterMabangRecords(task.records, body.query, filterField);
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      const filename = sanitizeFilename(`mabang-${task.kind}-${stamp}.xlsx`, { fallback: "mabang-data.xlsx" });
      const fileId = randomUUID();
      const monthFolder = stamp.slice(0, 7);
      const relativePath = `manual/${monthFolder}/${fileId}.xlsx`;
      temporaryFile = await createTemporaryFilePath(fileStorageConfig.tempRoot, {
        prefix: `mabang-manual-${fileId}`,
        extension: ".xlsx",
      });
      const writeResult = await runMabangWorker({
        action: "write-xlsx",
        outputPath: temporaryFile.path,
        kind: task.kind,
        columns: task.columns,
        records,
        summary: {
          ...task.summary,
          sourceRows: task.records.length,
          exportedRows: records.length,
          filterField: filterField === "__all__" ? "全部字段" : filterField,
          filterQuery: String(body.query || "").trim() || "无",
        },
      }, 3 * 60 * 1000);
      const sanitizationCounts = normalizedSanitizationCounts(writeResult.sanitizedCells);
      for (const item of sanitizationCounts) {
        console.info(`Excel cell sanitization: fileId=${fileId} sheet=${item.sheet} count=${item.count}`);
      }
      const persisted = await exportFileService.persistTemporaryExport({
        id: fileId,
        requestKey,
        temporaryPath: temporaryFile.path,
        sourceType: task.kind === "inventory" ? "mabang_manual_inventory" : "mabang_manual_order",
        originalFilename: filename,
        storageFilename: path.basename(relativePath),
        relativePath,
        metadata: {
          exportedRows: records.length,
          sourceRows: task.records.length,
          generatedBy: "manual",
          sanitizedCellCount: sanitizationCounts.reduce((total, item) => total + item.count, 0),
        },
      });
      temporaryFile = null;
      req.auditContext?.annotate({ fileId: persisted.file.id });
      return json(res, 201, {
        ok: true,
        reused: persisted.reused,
        fileId: persisted.file.id,
        filename: persisted.file.originalFilename,
        exportedRows: records.length,
        downloadUrl: `/api/files/${persisted.file.id}/download`,
      });
    } catch (error) {
      req.auditContext?.annotate({ errorStage: "generate_excel", errorCode: error.code || FILE_ERROR_CODES.TEMP_FILE_ERROR, errorSummary: error });
      req.auditContext?.addRelated("file", "file.export.failed", {
        status: "failed",
        errorCode: error.code || FILE_ERROR_CODES.TEMP_FILE_ERROR,
      });
      if (temporaryFile?.path) await removeFileInsideRoot(fileStorageConfig.tempRoot, temporaryFile.path);
      return securityErrorResponse(res, publicFileError(error, FILE_ERROR_CODES.TEMP_FILE_ERROR));
    }
  }

  if (url.pathname === "/api/discover-top5-and-analyze") {
    const body = await readBody(req);
    try {
      const productDescription = sanitizeProductDescription(body.productDescription);
      const productImage = sanitizeProductImage(body.productImage);
      const keywordPlan = await optimizeDiscoveryKeyword({
        keyword: body.keyword,
        productDescription,
        productImage,
        country: body.country,
        site: body.site,
        model: body.model,
      });
      const discovery = await discoverTopLinks({
        keyword: keywordPlan.keyword,
        country: body.country,
        site: body.site,
        limit: 5,
      });
      discovery.originalKeyword = String(body.keyword || "").trim();
      discovery.optimizedKeyword = keywordPlan.keyword;
      discovery.keywordOptimizationReason = keywordPlan.reason;
      discovery.referenceProduct = {
        description: productDescription,
        image: productImage,
      };
      if (discovery.blocked) {
        return json(res, 200, {
          ok: true,
          needsVerification: true,
          message: "搜索页进入验证码页。请在主服务器 Chrome 完成验证后重新收集 TOP5。",
          discovery,
          blockedProducts: [{
            index: 0,
            role: "search",
            platform: discovery.platform,
            inputUrl: discovery.searchUrl,
            currentUrl: discovery.finalUrl,
            verificationUrl: discovery.finalUrl || discovery.searchUrl,
            title: "搜索页验证码拦截",
          }],
        });
      }
      if (!discovery.links.length) {
        return json(res, 500, { ok: false, error: "没有在搜索页找到商品链接。请确认关键词、国家和站点，或先在验证浏览器里完成平台验证。" });
      }

      const products = await extractProducts(discovery.links);
      products.forEach((product, index) => {
        product.role = "top";
        product.rank = index + 1;
        product.discoverySoldText = discovery.results[index]?.soldText || "";
        product.discoverySoldValue = discovery.results[index]?.soldValue || 0;
      });
      const blockedProducts = getBlockedProducts(products);
      if (blockedProducts.length) {
        return json(res, 200, {
          ok: true,
          needsVerification: true,
          message: "部分 TOP5 商品链接进入验证码页。请在主服务器 Chrome 完成验证后重新收集。",
          discovery,
          products,
          blockedProducts,
        });
      }

      const report = {
        ...buildDeterministicReport(products),
        discovery,
      };
      const analysis = await callDeepSeek({ model: body.model, report });
      return json(res, 200, { ok: true, ...report, analysis });
    } catch (error) {
      if (error instanceof NetworkPolicyError) return securityErrorResponse(res, error);
      return json(res, 500, { ok: false, error: error.message });
    }
  }

  if (url.pathname === "/api/extract" || url.pathname === "/api/extract-and-analyze") {
    const body = await readBody(req);
    const links = [body.myUrl, ...(body.competitorUrls || [])].filter(Boolean);
    if (links.length < 1) return json(res, 400, { ok: false, error: "至少需要 1 个 Lazada、Shopee 或 TikTok Shop 商品链接。" });
    try {
      const products = await extractProducts(links);
      const blockedProducts = getBlockedProducts(products);
      if (blockedProducts.length) {
        return json(res, 200, {
          ok: true,
          needsVerification: true,
          message: "部分链接进入验证码页。请在主服务器 Chrome 完成验证后重新获取。",
          products,
          blockedProducts,
        });
      }
      const smartSkuComparison = await buildSmartSkuComparison(products, body.model);
      const report = buildDeterministicReport(products, { skuComparison: smartSkuComparison });
      if (url.pathname === "/api/extract") return json(res, 200, { ok: true, ...report });
      const analysis = await callDeepSeek({ model: body.model, report });
      return json(res, 200, { ok: true, ...report, analysis });
    } catch (error) {
      if (error instanceof NetworkPolicyError) return securityErrorResponse(res, error);
      return json(res, 500, { ok: false, error: error.message });
    }
  }

  if (url.pathname === "/api/analyze") {
    const body = await readBody(req);
    try {
      const analysis = await callDeepSeek({ model: body.model, report: body.report });
      return json(res, 200, { ok: true, analysis });
    } catch (error) {
      return json(res, 500, { ok: false, error: error.message });
    }
  }

  if (url.pathname === "/api/analyze-main-images") {
    const body = await readBody(req);
    try {
      const analysis = await callDeepSeekMainImage({ model: body.model, report: body.report });
      return json(res, 200, { ok: true, analysis });
    } catch (error) {
      return json(res, 500, { ok: false, error: error.message });
    }
  }

  if (url.pathname === "/api/image") {
    if (req.method !== "GET") return json(res, 405, { ok: false, error: "Method not allowed" });
    const imageUrl = url.searchParams.get("url");
    if (!imageUrl) return json(res, 400, { ok: false, code: "URL_INVALID", error: "URL 格式无效。" });
    try {
      const image = await fetchSecureImage(imageUrl);
      res.writeHead(200, {
        "content-type": image.contentType,
        "content-length": image.bytes.length,
        "cache-control": "private, max-age=3600",
        "x-content-type-options": "nosniff",
      });
      return res.end(image.bytes);
    } catch (error) {
      req.auditContext?.annotate({ errorStage: "image_proxy", errorCode: error.code || "IMAGE_PROXY_FAILED", errorSummary: error });
      return securityErrorResponse(res, error, {
        code: "IMAGE_PROXY_FAILED",
        message: "图片代理请求失败。",
      });
    }
  }

  return false;
}

async function serveStatic(req, res, url) {
  if (url.pathname === "/excel-cell-policy.mjs") {
    try {
      const data = await fs.readFile(excelCellPolicyModulePath);
      res.writeHead(200, {
        "content-type": mimeTypes[".mjs"],
        "cache-control": "no-store",
      });
      return res.end(data);
    } catch {
      res.writeHead(404);
      return res.end("Not found");
    }
  }
  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = path.normalize(path.join(publicDir, requested));
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, {
      "content-type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const auditContext = createHttpAuditContext(req, url, { trustedProxies: trustedAuditProxies });
  res.setHeader("x-request-id", auditContext.requestId);
  let requestError = null;
  try {
    if (url.pathname.startsWith("/api/")) {
      const handled = await handleApi(req, res, url);
      if (handled === false) json(res, 404, { ok: false, error: "API not found" });
      return;
    }
    if (url.pathname === "/ads" || url.pathname.startsWith("/ads/")) {
      if (url.pathname === "/ads" || url.pathname === "/ads/") {
        const status = await ensureAdAnalyzerServer();
        if (!status.ok) return json(res, 503, { ok: false, error: status.error || "广告服务未启动或不可用" });
      }
      await proxyAdServiceRequest(req, res, url, "static");
      return;
    }
    await serveStatic(req, res, url);
  } catch (error) {
    requestError = error;
    auditContext.annotate({ errorStage: "request", errorCode: error.code || "REQUEST_FAILED", errorSummary: error });
    json(res, 500, { ok: false, error: error.message });
  } finally {
    completeHttpAudit(auditService, auditContext, { httpStatus: res.statusCode || 500, error: requestError });
  }
});

function getLanUrls() {
  const urls = [];
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const item of interfaces || []) {
      if (item.family === "IPv4" && !item.internal) urls.push(`http://${item.address}:${port}`);
    }
  }
  return urls;
}

server.listen(port, host, () => {
  for (const message of appStartupMessages(appConfig, accessPolicy)) console.log(message);
  console.log(`Network policy: ${chromeAllowedHosts.length} Chrome hosts, ${imageProxyAllowedHosts.length} image hosts`);
  if (!isLoopbackBindHost(host)) {
    for (const lanUrl of getLanUrls()) console.log(`LAN: ${lanUrl}`);
  }
  ensureAdAnalyzerServer().then((status) => {
    if (status.ok) console.log(`Ad analyzer internal service: ${adServiceConfig.baseUrl}`);
    else console.warn(`Ad analyzer unavailable: ${status.error}`);
  });
});
