export const DEFAULT_SHOPEE_RELAY_BASE_URL = "http://10.110.80.95:8788";
export const DEFAULT_SHOPEE_PROXY_REQUEST_LIMIT = 1024 * 1024;
export const DEFAULT_SHOPEE_PROXY_RESPONSE_LIMIT = 8 * 1024 * 1024;

export const SHOPEE_CONSOLE_ALLOWED_GET_PATHS = Object.freeze([
  "/api/v2/shop/get_shop_info",
  "/api/v2/product/get_item_list",
  "/api/v2/product/get_item_base_info",
  "/api/v2/product/get_model_list",
  "/api/v2/discount/get_discount_list",
  "/api/v2/discount/get_discount",
]);

const SHOPEE_CONSOLE_ALLOWED_GET_PATH_SET = new Set(SHOPEE_CONSOLE_ALLOWED_GET_PATHS);
const SHOPEE_CONSOLE_CALL_FIELDS = new Set(["shop_id", "api_path", "method", "params"]);

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

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function parseConsoleCallBody(body) {
  if (!body?.length) throw badRequest("请求正文必须是 JSON 对象");
  let value;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch {
    throw badRequest("请求正文不是有效 JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("请求正文必须是 JSON 对象");
  }
  if (Object.keys(value).some((field) => !SHOPEE_CONSOLE_CALL_FIELDS.has(field))) {
    throw badRequest("请求正文包含不允许的字段");
  }
  if (value.method !== "GET") throw badRequest("Shopee 控制台只允许 GET 调用");
  if (typeof value.api_path !== "string" || !SHOPEE_CONSOLE_ALLOWED_GET_PATH_SET.has(value.api_path)) {
    throw badRequest("Shopee API 路径不在只读白名单中");
  }
  if (!/^[1-9]\d*$/.test(String(value.shop_id ?? ""))) throw badRequest("shop_id 格式不正确");
  if (!value.params || typeof value.params !== "object" || Array.isArray(value.params)) {
    throw badRequest("params 必须是 JSON 对象");
  }
  return Buffer.from(JSON.stringify({
    shop_id: value.shop_id,
    api_path: value.api_path,
    method: "GET",
    params: value.params,
  }), "utf8");
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
      const rawBody = route.method === "POST"
        ? await readLimitedRequestBody(req, requestLimitBytes)
        : undefined;
      const body = route.upstreamPath === "/api/shopee/call"
        ? parseConsoleCallBody(rawBody)
        : rawBody;
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
      if (error?.status === 400) {
        return jsonResponse(res, 400, { ok: false, error: error.message });
      }
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
