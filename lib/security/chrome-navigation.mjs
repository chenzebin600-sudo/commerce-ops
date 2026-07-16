import {
  NETWORK_ERROR_CODES,
  NetworkPolicyError,
  publicNetworkError,
} from "./network-policy.mjs";

export const DEFAULT_CHROME_MAX_REDIRECTS = 5;
export const DEFAULT_CHROME_NAVIGATION_TIMEOUT_MS = 20_000;

function boundedInteger(value, fallback, { minimum, maximum, name }) {
  const parsed = value == null || String(value).trim() === "" ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} 必须是 ${minimum} 到 ${maximum} 之间的整数。`);
  }
  return parsed;
}

export function resolveChromeNavigationConfig(env = process.env) {
  return Object.freeze({
    timeoutMs: boundedInteger(env.NETWORK_REQUEST_TIMEOUT_MS, DEFAULT_CHROME_NAVIGATION_TIMEOUT_MS, {
      minimum: 1000,
      maximum: 120_000,
      name: "NETWORK_REQUEST_TIMEOUT_MS",
    }),
    maxRedirects: boundedInteger(env.CHROME_MAX_REDIRECTS, DEFAULT_CHROME_MAX_REDIRECTS, {
      minimum: 0,
      maximum: 20,
      name: "CHROME_MAX_REDIRECTS",
    }),
  });
}

function redirectError(error) {
  if (error instanceof NetworkPolicyError && error.code === NETWORK_ERROR_CODES.REDIRECT_BLOCKED) return error;
  return new NetworkPolicyError(NETWORK_ERROR_CODES.REDIRECT_BLOCKED, { status: 403, cause: error });
}

function navigationTimeoutError() {
  return new NetworkPolicyError(NETWORK_ERROR_CODES.NAVIGATION_TIMEOUT, { status: 504 });
}

export async function createChromeNavigationGuard({
  cdp,
  policy,
  timeoutMs = DEFAULT_CHROME_NAVIGATION_TIMEOUT_MS,
  maxRedirects = DEFAULT_CHROME_MAX_REDIRECTS,
} = {}) {
  if (!cdp?.send || !cdp?.on) throw new TypeError("Chrome 导航保护需要支持事件订阅的 CDP 客户端。");
  if (!policy?.validateUrl) throw new TypeError("Chrome 导航保护必须配置网络安全策略。");

  let disposed = false;
  let blockedError = null;
  let activeNavigation = null;
  let hasNavigated = false;
  const redirectCounts = new Map();
  const networkRedirectCounts = new Map();
  const pendingValidations = new Set();

  function settleBlocked(error) {
    if (!blockedError) blockedError = error;
    if (activeNavigation) activeNavigation.reject(blockedError);
  }

  function track(task) {
    pendingValidations.add(task);
    task.finally(() => pendingValidations.delete(task));
  }

  async function validateDocumentRequest(params) {
    if (!hasNavigated) {
      await cdp.send("Fetch.continueRequest", { requestId: params.requestId });
      return;
    }
    if (params.resourceType && params.resourceType !== "Document") {
      await cdp.send("Fetch.continueRequest", { requestId: params.requestId });
      return;
    }

    const networkRedirectCount = params.networkId ? (networkRedirectCounts.get(params.networkId) || 0) : 0;
    const previousRedirects = params.redirectedRequestId ? (redirectCounts.get(params.redirectedRequestId) || 0) : 0;
    const redirectCount = Math.max(
      networkRedirectCount,
      params.redirectedRequestId ? previousRedirects + 1 : 0,
    );
    redirectCounts.set(params.requestId, redirectCount);
    try {
      if (redirectCount > maxRedirects) throw redirectError(new Error("redirect limit"));
      await policy.validateUrl(params.request?.url);
      await cdp.send("Fetch.continueRequest", { requestId: params.requestId });
    } catch (error) {
      const safeError = redirectCount > 0 ? redirectError(error) : publicNetworkError(error);
      await cdp.send("Fetch.failRequest", {
        requestId: params.requestId,
        errorReason: "BlockedByClient",
      }).catch(() => {});
      settleBlocked(safeError);
    }
  }

  async function validateCommittedFrame(params) {
    if (!hasNavigated) return;
    const frame = params.frame || {};
    if (!frame.url) return;
    try {
      await policy.validateUrl(frame.url);
      if (!frame.parentId && activeNavigation) activeNavigation.resolve({ frameId: frame.id, url: frame.url });
    } catch (error) {
      settleBlocked(redirectError(error));
    }
  }

  const removeRequestListener = cdp.on("Fetch.requestPaused", (params) => {
    track(validateDocumentRequest(params));
  });
  const removeFrameListener = cdp.on("Page.frameNavigated", (params) => {
    track(validateCommittedFrame(params));
  });
  const removeNetworkListener = cdp.on("Network.requestWillBeSent", (params) => {
    if (hasNavigated && params.type === "Document" && params.redirectResponse && params.requestId) {
      networkRedirectCounts.set(params.requestId, (networkRedirectCounts.get(params.requestId) || 0) + 1);
    }
  });

  await cdp.send("Page.enable");
  await cdp.send("Network.enable");
  await cdp.send("Fetch.enable", {
    patterns: [{ resourceType: "Document", requestStage: "Request" }],
  });

  async function throwIfBlocked() {
    if (pendingValidations.size) await Promise.allSettled([...pendingValidations]);
    if (blockedError) throw blockedError;
  }

  async function navigate(inputUrl) {
    if (disposed) throw new Error("Chrome 导航保护已经关闭。");
    await throwIfBlocked();
    const target = await policy.validateUrl(inputUrl);
    hasNavigated = true;

    let timeout;
    const completion = new Promise((resolve, reject) => {
      activeNavigation = { resolve, reject };
      timeout = setTimeout(() => reject(navigationTimeoutError()), timeoutMs);
    });
    try {
      const result = await cdp.send("Page.navigate", { url: target.url });
      if (result?.error || result?.result?.errorText) {
        throw new NetworkPolicyError(NETWORK_ERROR_CODES.URL_INVALID, { cause: new Error("navigation failed") });
      }
      const committed = await completion;
      await throwIfBlocked();
      return committed;
    } finally {
      clearTimeout(timeout);
      activeNavigation = null;
    }
  }

  async function dispose() {
    if (disposed) return;
    disposed = true;
    removeRequestListener?.();
    removeFrameListener?.();
    removeNetworkListener?.();
    await Promise.allSettled([...pendingValidations]);
    await cdp.send("Fetch.disable").catch(() => {});
    await cdp.send("Network.disable").catch(() => {});
  }

  return Object.freeze({
    navigate,
    throwIfBlocked,
    dispose,
    get blockedError() {
      return blockedError;
    },
  });
}
