import {
  ConnectorAuthenticationError,
  ConnectorConfigurationError,
  ConnectorError,
} from "../base/errors.mjs";

const COUNTRY_CODES = Object.freeze({
  "印尼": "ID",
  "印度尼西亚": "ID",
  "马来": "MY",
  "马来西亚": "MY",
  "菲律宾": "PH",
  "新加坡": "SG",
  "泰国": "TH",
  "台湾": "TW",
  "越南": "VN",
});

function required(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw new ConnectorConfigurationError(`${label} is not configured`, {
      code: "SHOPEE_TOKEN_SERVICE_NOT_CONFIGURED",
      platform: "shopee",
    });
  }
  return normalized;
}

function positiveInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function serviceUrl(value) {
  let url;
  try { url = new URL(required(value, "Shopee token service base URL")); } catch (error) {
    if (error instanceof ConnectorConfigurationError) throw error;
    throw new ConnectorConfigurationError("Shopee token service base URL is invalid", {
      code: "SHOPEE_TOKEN_SERVICE_URL_INVALID",
      platform: "shopee",
      cause: error,
    });
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new ConnectorConfigurationError("Shopee token service base URL must be HTTP(S) without embedded credentials", {
      code: "SHOPEE_TOKEN_SERVICE_URL_INVALID",
      platform: "shopee",
    });
  }
  url.pathname = url.pathname.replace(/\/*$/, "/");
  url.search = "";
  url.hash = "";
  return url;
}

function dateValue(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("Shopee token client clock returned an invalid date");
  return date;
}

function countryCode(value) {
  const normalized = String(value || "").trim();
  return COUNTRY_CODES[normalized] || (/^[A-Za-z]{2}$/.test(normalized) ? normalized.toUpperCase() : "");
}

function tokenServiceError(status) {
  if (status === 401 || status === 403) {
    return new ConnectorAuthenticationError("Shopee token service rejected the API key", {
      code: "SHOPEE_TOKEN_SERVICE_KEY_INVALID",
      status,
      platform: "shopee",
    });
  }
  if (status === 404) {
    return new ConnectorAuthenticationError("Shopee shop token is not available", {
      code: "SHOPEE_TOKEN_NOT_FOUND",
      status,
      platform: "shopee",
    });
  }
  return new ConnectorError("Shopee token service request failed", {
    code: "SHOPEE_TOKEN_SERVICE_REQUEST_FAILED",
    status: 502,
    retryable: status >= 500,
    platform: "shopee",
    providerCode: status ? `HTTP_${status}` : null,
  });
}

export function resolveShopeeTokenServiceConfig(env = process.env) {
  const baseUrl = String(env.SHOPEE_TOKEN_SERVICE_BASE_URL || "").trim();
  const apiKey = String(env.SHOPEE_TOKEN_SERVICE_API_KEY || "").trim();
  return {
    enabled: Boolean(baseUrl && apiKey),
    baseUrl,
    apiKey,
    timeoutMs: positiveInteger(env.SHOPEE_TOKEN_SERVICE_TIMEOUT_MS, 20_000, 1_000, 120_000),
  };
}

export class ShopeeTokenServiceClient {
  constructor({ baseUrl, apiKey, fetchImpl = fetch, timeoutMs = 20_000, clock = () => new Date() } = {}) {
    this.baseUrl = serviceUrl(baseUrl);
    this.apiKey = required(apiKey, "Shopee token service API key");
    if (typeof fetchImpl !== "function") throw new TypeError("Shopee token service fetch implementation is required");
    this.fetchImpl = fetchImpl;
    this.timeoutMs = positiveInteger(timeoutMs, 20_000, 1_000, 120_000);
    this.clock = clock;
  }

  async #get(pathname) {
    let response;
    try {
      response = await this.fetchImpl(new URL(pathname.replace(/^\//, ""), this.baseUrl), {
        method: "GET",
        headers: {
          "X-Token-Key": this.apiKey,
          accept: "application/json",
          connection: "close",
        },
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new ConnectorError("Shopee token service is unreachable", {
        code: "SHOPEE_TOKEN_SERVICE_UNREACHABLE",
        status: 503,
        retryable: true,
        platform: "shopee",
        cause: error,
      });
    }
    let payload;
    try { payload = await response.json(); } catch {
      throw new ConnectorError("Shopee token service returned invalid JSON", {
        code: "SHOPEE_TOKEN_SERVICE_RESPONSE_INVALID",
        status: 502,
        retryable: response.status >= 500,
        platform: "shopee",
      });
    }
    if (!response.ok) throw tokenServiceError(response.status);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new ConnectorError("Shopee token service response is invalid", {
        code: "SHOPEE_TOKEN_SERVICE_RESPONSE_INVALID",
        status: 502,
        platform: "shopee",
      });
    }
    return payload;
  }

  async listShops() {
    const payload = await this.#get("api/token/shops");
    if (!Array.isArray(payload.shops)) {
      throw new ConnectorError("Shopee token service shop list is invalid", {
        code: "SHOPEE_TOKEN_SERVICE_RESPONSE_INVALID",
        status: 502,
        platform: "shopee",
      });
    }
    const shops = payload.shops.map((item) => {
      const shopId = String(item?.shop_id || "").trim();
      if (!/^\d{4,30}$/.test(shopId)) {
        throw new ConnectorError("Shopee token service returned an invalid shop_id", {
          code: "SHOPEE_TOKEN_SERVICE_RESPONSE_INVALID",
          status: 502,
          platform: "shopee",
        });
      }
      const countryName = String(item?.["国家"] || "").trim();
      const normalizedCountry = countryCode(countryName);
      if (!normalizedCountry) {
        throw new ConnectorError("Shopee token service returned an unsupported country", {
          code: "SHOPEE_TOKEN_SERVICE_RESPONSE_INVALID",
          status: 502,
          platform: "shopee",
        });
      }
      return {
        shopId,
        shopCode: String(item?.["店编"] || "").trim(),
        shopName: String(item?.["店名"] || "").trim(),
        countryName,
        countryCode: normalizedCountry,
        hasToken: item?.["有令牌"] === true,
        accessValid: item?.["access可用"] === true,
        accessRemainingSeconds: Number.isFinite(Number(item?.["access剩余秒"]))
          ? Math.max(0, Math.trunc(Number(item["access剩余秒"])))
          : null,
      };
    });
    return {
      owner: String(payload["人"] || "").trim() || null,
      total: Number(payload["店数"] ?? shops.length),
      authorized: Number(payload["有令牌"] ?? shops.filter((item) => item.hasToken).length),
      shops,
    };
  }

  async getAccessToken(shopId) {
    const normalizedShopId = String(shopId || "").trim();
    if (!/^\d{4,30}$/.test(normalizedShopId)) {
      throw new ConnectorError("Shopee shop_id is invalid", {
        code: "SHOPEE_SHOP_ID_INVALID",
        status: 400,
        platform: "shopee",
      });
    }
    const payload = await this.#get(`api/token/get?shop_id=${encodeURIComponent(normalizedShopId)}`);
    const accessToken = String(payload.access_token || "").trim();
    const responseShopId = String(payload.shop_id || normalizedShopId).trim();
    const remainingSeconds = Math.trunc(Number(payload["access剩余秒"]));
    if (!accessToken || responseShopId !== normalizedShopId || !Number.isInteger(remainingSeconds) || remainingSeconds <= 0) {
      throw new ConnectorError("Shopee token service returned an invalid access token response", {
        code: "SHOPEE_TOKEN_SERVICE_RESPONSE_INVALID",
        status: 502,
        platform: "shopee",
      });
    }
    return {
      accessToken,
      partnerId: String(payload.partner_id || "").trim(),
      shopId: responseShopId,
      shopCode: String(payload["店编"] || "").trim(),
      shopName: String(payload["店名"] || "").trim() || null,
      accessRemainingSeconds: remainingSeconds,
      expireTime: new Date(dateValue(this.clock).getTime() + remainingSeconds * 1000).toISOString(),
    };
  }
}
