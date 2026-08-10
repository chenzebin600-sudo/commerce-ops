function normalizeBaseUrl(value) {
  const url = new URL(String(value || "http://10.110.80.95:8788"));
  if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("SHOPEE_RELAY_BASE_URL 配置无效。");
  }
  return url.toString().replace(/\/$/, "");
}

function messageFrom(payload, fallback) {
  if (typeof payload?.error === "string" && payload.error) return payload.error;
  if (typeof payload?.message === "string" && payload.message) return payload.message;
  if (typeof payload?.data?.error === "string" && payload.data.error) return payload.data.error;
  if (typeof payload?.data?.message === "string" && payload.data.message) return payload.data.message;
  return fallback;
}

function collectShopIds(value, output = new Set(), depth = 0) {
  if (depth > 8 || value == null) return output;
  if (Array.isArray(value)) {
    for (const item of value) collectShopIds(item, output, depth + 1);
  } else if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (["shop_id", "shopId"].includes(key) && ["string", "number"].includes(typeof item)) output.add(String(item));
      else collectShopIds(item, output, depth + 1);
    }
  }
  return output;
}

export class ShopeeHealthClient {
  constructor({ baseUrl, fetchImpl = globalThis.fetch, timeoutMs = 60_000, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.sleep = sleep;
  }

  async request(path, tokenKey, init = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: { accept: "application/json", "x-token-key": tokenKey, ...(init.headers || {}) },
        redirect: "manual",
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.ok === false) {
        const error = new Error(messageFrom(payload, `Shopee 中转请求失败 (${response.status})`));
        error.status = response.status;
        error.code = response.status === 401 || response.status === 403 ? "SHOPEE_KEY_INVALID" : "SHOPEE_RELAY_FAILED";
        throw error;
      }
      return payload;
    } catch (error) {
      if (error.name === "AbortError") {
        const timeout = new Error("Shopee 中转请求超时。");
        timeout.code = "SHOPEE_RELAY_TIMEOUT";
        throw timeout;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async verifyToken(tokenKey) {
    const payload = await this.request("/api/token/shops", tokenKey, { method: "GET" });
    return { payload, shopIds: [...collectShopIds(payload)] };
  }

  async call({ tokenKey, shopId, apiPath, params = {}, retryCount = 3 }) {
    const delays = [5_000, 15_000, 30_000];
    let lastError;
    for (let attempt = 0; attempt <= retryCount; attempt += 1) {
      try {
        const payload = await this.request("/api/shopee/call", tokenKey, {
          method: "POST",
          headers: { "content-type": "application/json; charset=utf-8" },
          body: JSON.stringify({ shop_id: String(shopId), api_path: apiPath, method: "GET", params }),
        });
        const data = payload?.data ?? payload;
        if (data?.error) {
          const error = new Error(messageFrom(data, "Shopee 返回业务错误。"));
          error.code = /auth|token|permission|linked/i.test(String(data.error)) ? "SHOPEE_AUTH_FAILED" : "SHOPEE_BUSINESS_ERROR";
          throw error;
        }
        return { data, attempts: attempt + 1 };
      } catch (error) {
        lastError = error;
        if (["SHOPEE_KEY_INVALID", "SHOPEE_AUTH_FAILED"].includes(error.code) || attempt >= retryCount) break;
        await this.sleep(delays[Math.min(attempt, delays.length - 1)]);
      }
    }
    throw lastError;
  }
}
