export const DEFAULT_SHOPEE_RELAY_BASE_URL = "http://10.110.80.95:8788";
export const DEFAULT_SHOPEE_PROXY_REQUEST_LIMIT = 1024 * 1024;
export const DEFAULT_SHOPEE_PROXY_RESPONSE_LIMIT = 8 * 1024 * 1024;

const ROUTES = Object.freeze({
  "/api/shopee-console/shops": Object.freeze({
    method: "GET",
    upstreamPath: "/api/token/shops",
  }),
  "/api/shopee-console/call": Object.freeze({
    method: "POST",
    upstreamPath: "/api/shopee/call",
  }),
});

function normalizeBaseUrl(value) {
  const url = new URL(String(value || DEFAULT_SHOPEE_RELAY_BASE_URL));
  if (!new Set(["http:", "https:"]).has(url.protocol)) {
    throw new Error("SHOPEE_RELAY_BASE_URL 只允许 http 或 https 协议");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("SHOPEE_RELAY_BASE_URL 不得包含凭证、查询参数或片段");
  }
  if (url.pathname !== "/") {
    throw new Error("SHOPEE_RELAY_BASE_URL 不得包含路径");
  }
  return url.toString().replace(/\/$/, "");
}

async function readLimitedRequestBody(req, maxBytes) {
  const declaredLength = Number(req.headers?.["content-length"] || 0);
  if (declaredLength > maxBytes) {
    const error = new Error("请求内容超过限制");
    error.status = 413;
    throw error;
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) {
      const error = new Error("请求内容超过限制");
      error.status = 413;
      throw error;
    }
    chunks.push(bytes);
  }
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

async function readLimitedResponseBody(response, maxBytes) {
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > maxBytes) throw new Error("Shopee 中转响应超过限制");
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
      await reader.cancel().catch(() => undefined);
      throw new Error("Shopee 中转响应超过限制");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function jsonResponse(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
  return true;
}

export function createShopeeConsoleProxy({
  baseUrl = DEFAULT_SHOPEE_RELAY_BASE_URL,
  fetchImpl = globalThis.fetch,
  timeoutMs = 60_000,
  requestLimitBytes = DEFAULT_SHOPEE_PROXY_REQUEST_LIMIT,
  responseLimitBytes = DEFAULT_SHOPEE_PROXY_RESPONSE_LIMIT,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  const fixedBaseUrl = normalizeBaseUrl(baseUrl);

  return async function handleShopeeConsoleApi(req, res, requestUrl) {
    const route = ROUTES[requestUrl.pathname];
    if (!route) return false;
    if (req.method !== route.method) {
      return jsonResponse(res, 405, { ok: false, error: "Method not allowed" });
    }

    const tokenKey = String(req.headers?.["x-token-key"] || "").trim();
    if (!tokenKey) {
      return jsonResponse(res, 400, { ok: false, error: "请填写 X-Token-Key" });
    }
    if (tokenKey.length > 512) {
      return jsonResponse(res, 400, { ok: false, error: "X-Token-Key 格式不正确" });
    }

    let timeout;
    try {
      const body = route.method === "POST"
        ? await readLimitedRequestBody(req, requestLimitBytes)
        : undefined;
      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), timeoutMs);
      const headers = new Headers({
        accept: "application/json",
        "x-token-key": tokenKey,
      });
      if (body) headers.set("content-type", "application/json; charset=utf-8");
      const requestId = req.auditContext?.requestId || req.headers?.["x-request-id"];
      if (requestId) headers.set("x-request-id", String(requestId));

      const upstream = await fetchImpl(`${fixedBaseUrl}${route.upstreamPath}`, {
        method: route.method,
        headers,
        body,
        redirect: "manual",
        signal: controller.signal,
      });
      if (upstream.status >= 300 && upstream.status < 400) {
        return jsonResponse(res, 502, { ok: false, error: "Shopee 中转返回了不允许的重定向" });
      }

      const responseBody = await readLimitedResponseBody(upstream, responseLimitBytes);
      res.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
        "content-length": String(responseBody.length),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      res.end(responseBody);
      return true;
    } catch (error) {
      if (error?.status === 413) {
        return jsonResponse(res, 413, { ok: false, error: "请求内容超过 1MB 限制" });
      }
      if (error?.name === "AbortError") {
        return jsonResponse(res, 504, { ok: false, error: "Shopee 中转请求超时，请稍后重试" });
      }
      return jsonResponse(res, 503, {
        ok: false,
        error: "无法连接 Shopee 内网中转服务，请确认当前网络可访问 10.110.80.95",
      });
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };
}
