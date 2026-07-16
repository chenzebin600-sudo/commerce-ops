import { isLoopbackBindHost } from "./app-access.mjs";

export const AD_SERVICE_INTERNAL_HEADER = "x-commerce-ops-internal-token";
export const DEFAULT_AD_SERVICE_HOST = "127.0.0.1";
export const DEFAULT_AD_SERVICE_PORT = 4173;
export const DEFAULT_AD_PROXY_REQUEST_LIMIT = 32 * 1024 * 1024;
export const DEFAULT_AD_PROXY_RESPONSE_LIMIT = 64 * 1024 * 1024;

function firstValue(...values) {
  return values.find((value) => String(value ?? "").trim() !== "");
}

function parsePort(value, name) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} 必须是 1 到 65535 之间的整数`);
  }
  return port;
}

export function resolveAdServiceProxyConfig(env = process.env) {
  const configuredHost = String(firstValue(env.AD_SERVICE_HOST, DEFAULT_AD_SERVICE_HOST)).trim();
  const configuredPort = parsePort(
    firstValue(env.AD_SERVICE_PORT, env.AD_ANALYZER_PORT, DEFAULT_AD_SERVICE_PORT),
    "AD_SERVICE_PORT",
  );
  const configuredBaseUrl = String(env.AD_SERVICE_BASE_URL || "").trim();
  const baseUrl = new URL(configuredBaseUrl || `http://${configuredHost}:${configuredPort}`);

  if (baseUrl.protocol !== "http:") {
    throw new Error("AD_SERVICE_BASE_URL 必须使用 http 协议");
  }
  if (!isLoopbackBindHost(baseUrl.hostname)) {
    throw new Error("广告服务代理目标必须是本机回环地址");
  }
  if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw new Error("AD_SERVICE_BASE_URL 不得包含凭证、查询参数或片段");
  }
  if (baseUrl.pathname !== "/") {
    throw new Error("AD_SERVICE_BASE_URL 不得包含路径");
  }

  const port = parsePort(baseUrl.port || 80, "AD_SERVICE_BASE_URL 端口");
  return Object.freeze({
    host: baseUrl.hostname,
    port,
    baseUrl: `http://${baseUrl.hostname.includes(":") ? `[${baseUrl.hostname}]` : baseUrl.hostname}:${port}`,
  });
}

export function buildAdServiceTarget(baseUrl, requestUrl, kind) {
  const sourceUrl = requestUrl instanceof URL ? requestUrl : new URL(String(requestUrl), "http://commerce-ops.invalid");
  let targetPath;
  if (kind === "static") {
    if (sourceUrl.pathname === "/ads" || sourceUrl.pathname === "/ads/") targetPath = "/";
    else if (sourceUrl.pathname.startsWith("/ads/")) targetPath = sourceUrl.pathname.slice(4);
    else throw new Error("无效的广告页面代理路径");
  } else if (kind === "api") {
    if (!sourceUrl.pathname.startsWith("/api/ads/")) throw new Error("无效的广告接口代理路径");
    targetPath = `/api/${sourceUrl.pathname.slice("/api/ads/".length)}`;
  } else {
    throw new Error("无效的广告代理类型");
  }

  const target = new URL(baseUrl);
  target.pathname = targetPath;
  target.search = sourceUrl.search;
  return target;
}

async function readRequestBody(req, maxBytes) {
  const declaredLength = Number(req.headers?.["content-length"] || 0);
  if (declaredLength > maxBytes) {
    const error = new Error("广告请求内容过大");
    error.status = 413;
    throw error;
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) {
      const error = new Error("广告请求内容过大");
      error.status = 413;
      throw error;
    }
    chunks.push(bytes);
  }
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

async function readResponseBody(response, maxBytes) {
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > maxBytes) throw new Error("广告服务响应内容过大");
  if (!response.body) return Buffer.alloc(0);

  const chunks = [];
  let size = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    size += chunk.length;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error("广告服务响应内容过大");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function proxyRequestHeaders(req, internalToken, body) {
  const headers = new Headers();
  const contentType = req.headers?.["content-type"];
  const accept = req.headers?.accept;
  if (contentType) headers.set("content-type", String(contentType));
  if (accept) headers.set("accept", String(accept));
  if (body) headers.set("content-length", String(body.length));
  const requestId = req.auditContext?.requestId || req.headers?.["x-request-id"];
  if (requestId) headers.set("x-request-id", String(requestId));
  headers.set(AD_SERVICE_INTERNAL_HEADER, internalToken);
  return headers;
}

function jsonResponse(res, status, error) {
  const body = Buffer.from(JSON.stringify({ ok: false, error }), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
  });
  res.end(body);
}

export function createAdServiceProxy({
  baseUrl,
  internalToken,
  fetchImpl = globalThis.fetch,
  requestLimitBytes = DEFAULT_AD_PROXY_REQUEST_LIMIT,
  responseLimitBytes = DEFAULT_AD_PROXY_RESPONSE_LIMIT,
  staticTimeoutMs = 10_000,
  apiTimeoutMs = 5 * 60_000,
  onResponse = null,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  if (!String(internalToken || "")) throw new Error("广告服务内部Token不能为空");
  const fixedBaseUrl = resolveAdServiceProxyConfig({ AD_SERVICE_BASE_URL: baseUrl }).baseUrl;

  return async function proxyAdServiceRequest(req, res, requestUrl, kind) {
    const allowedMethods = kind === "static" ? new Set(["GET", "HEAD"]) : new Set(["GET", "POST"]);
    if (!allowedMethods.has(req.method)) {
      jsonResponse(res, 405, "Method not allowed");
      return true;
    }

    let timeout;
    try {
      const target = buildAdServiceTarget(fixedBaseUrl, requestUrl, kind);
      const body = req.method === "GET" || req.method === "HEAD"
        ? undefined
        : await readRequestBody(req, requestLimitBytes);
      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), kind === "static" ? staticTimeoutMs : apiTimeoutMs);
      const response = await fetchImpl(target, {
        method: req.method,
        headers: proxyRequestHeaders(req, internalToken, body),
        body,
        redirect: "manual",
        signal: controller.signal,
      });

      if (response.status >= 300 && response.status < 400) {
        onResponse?.({ req, target, status: 502, upstreamStatus: response.status, kind, responseBody: Buffer.alloc(0) });
        jsonResponse(res, 502, "广告服务返回了不允许的重定向");
        return true;
      }
      if (response.status === 401 || response.status === 403) {
        onResponse?.({ req, target, status: 502, upstreamStatus: response.status, kind, responseBody: Buffer.alloc(0) });
        jsonResponse(res, 502, "广告服务内部认证失败");
        return true;
      }

      const responseBody = req.method === "HEAD" ? Buffer.alloc(0) : await readResponseBody(response, responseLimitBytes);
      onResponse?.({ req, target, status: response.status, upstreamStatus: response.status, kind, responseBody });
      const responseHeaders = {
        "content-type": response.headers.get("content-type") || "application/octet-stream",
        "content-length": responseBody.length,
        "cache-control": kind === "api" ? "no-store" : (response.headers.get("cache-control") || "no-store"),
      };
      res.writeHead(response.status, responseHeaders);
      res.end(responseBody);
      return true;
    } catch (error) {
      const failureStatus = error?.status === 413 ? 413 : error?.name === "AbortError" ? 504 : 503;
      onResponse?.({ req, target: null, status: failureStatus, upstreamStatus: null, kind, responseBody: Buffer.alloc(0), error });
      if (error?.status === 413) jsonResponse(res, 413, "广告请求内容过大");
      else if (error?.name === "AbortError") jsonResponse(res, 504, "广告服务连接超时");
      else jsonResponse(res, 503, "广告服务未启动或不可用");
      return true;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };
}
