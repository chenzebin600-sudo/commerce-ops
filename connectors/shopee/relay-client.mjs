import {
  ConnectorAuthenticationError,
  ConnectorConfigurationError,
  ConnectorError,
} from "../base/errors.mjs";

const READ_OPERATIONS = Object.freeze({
  get_shop_info: "/api/v2/shop/get_shop_info",
  get_order_list: "/api/v2/order/get_order_list",
  get_order_detail: "/api/v2/order/get_order_detail",
  get_item_list: "/api/v2/product/get_item_list",
  get_item_base_info: "/api/v2/product/get_item_base_info",
  get_model_list: "/api/v2/product/get_model_list",
  generate_income_report: "/api/v2/payment/generate_income_report",
  get_income_report: "/api/v2/payment/get_income_report",
  get_wallet_transaction_list: "/api/v2/payment/get_wallet_transaction_list",
});

function required(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw new ConnectorConfigurationError(`${label} is not configured`, {
      code: "SHOPEE_RELAY_NOT_CONFIGURED",
      platform: "shopee",
    });
  }
  return normalized;
}

function positiveInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function relayUrl(value) {
  let url;
  try { url = new URL(required(value, "Shopee relay base URL")); } catch (error) {
    if (error instanceof ConnectorConfigurationError) throw error;
    throw new ConnectorConfigurationError("Shopee relay base URL is invalid", {
      code: "SHOPEE_RELAY_URL_INVALID",
      platform: "shopee",
      cause: error,
    });
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new ConnectorConfigurationError("Shopee relay base URL must be HTTP(S) without embedded credentials", {
      code: "SHOPEE_RELAY_URL_INVALID",
      platform: "shopee",
    });
  }
  url.pathname = url.pathname.replace(/\/*$/, "/");
  url.search = "";
  url.hash = "";
  return url;
}

function normalizedShopId(value) {
  const shopId = String(value || "").trim();
  if (!/^\d{4,30}$/.test(shopId)) {
    throw new ConnectorError("Shopee shop_id is invalid", {
      code: "SHOPEE_SHOP_ID_INVALID",
      status: 400,
      platform: "shopee",
    });
  }
  return shopId;
}

function cleanParameters(value) {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ConnectorError("Shopee relay parameters must be an object", {
      code: "SHOPEE_RELAY_PARAMETERS_INVALID",
      status: 400,
      platform: "shopee",
    });
  }
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ""));
}

function httpError(status) {
  if (status === 401 || status === 403) {
    return new ConnectorAuthenticationError("Shopee relay denied the request", {
      code: "SHOPEE_RELAY_ACCESS_DENIED",
      status: 403,
      platform: "shopee",
    });
  }
  if (status === 404) {
    return new ConnectorAuthenticationError("Shopee shop is not bound in the company relay", {
      code: "SHOPEE_SHOP_NOT_BOUND",
      status: 404,
      platform: "shopee",
    });
  }
  if (status === 400) {
    return new ConnectorError("Shopee relay rejected the request", {
      code: "SHOPEE_RELAY_REQUEST_INVALID",
      status: 400,
      platform: "shopee",
    });
  }
  return new ConnectorError("Shopee relay request failed", {
    code: "SHOPEE_RELAY_REQUEST_FAILED",
    status: 502,
    retryable: status >= 500,
    platform: "shopee",
    providerCode: status ? `HTTP_${status}` : null,
  });
}

function providerRequestId(data) {
  return data?.request_id || data?.requestId || null;
}

function providerError(data) {
  const value = data?.error;
  if (value === undefined || value === null || value === "" || value === false) return null;
  return typeof value === "string" ? value.slice(0, 120) : "SHOPEE_PROVIDER_ERROR";
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function resolveShopeeRelayConfig(env = process.env) {
  const baseUrl = String(env.SHOPEE_RELAY_BASE_URL || env.SHOPEE_TOKEN_SERVICE_BASE_URL || "").trim();
  const apiKey = String(env.SHOPEE_RELAY_API_KEY || env.SHOPEE_TOKEN_SERVICE_API_KEY || "").trim();
  return {
    enabled: Boolean(baseUrl && apiKey),
    baseUrl,
    apiKey,
    timeoutMs: positiveInteger(
      env.SHOPEE_RELAY_TIMEOUT_MS || env.SHOPEE_TOKEN_SERVICE_TIMEOUT_MS,
      20_000,
      1_000,
      120_000,
    ),
  };
}

export class ShopeeRelayClient {
  constructor({
    baseUrl,
    apiKey,
    fetchImpl = fetch,
    timeoutMs = 20_000,
    maxReadRetries = 1,
    sleeper = delay,
  } = {}) {
    this.baseUrl = relayUrl(baseUrl);
    this.apiKey = required(apiKey, "Shopee relay API key");
    if (typeof fetchImpl !== "function") throw new TypeError("Shopee relay fetch implementation is required");
    if (typeof sleeper !== "function") throw new TypeError("Shopee relay sleeper is required");
    this.fetchImpl = fetchImpl;
    this.timeoutMs = positiveInteger(timeoutMs, 20_000, 1_000, 120_000);
    this.maxReadRetries = positiveInteger(maxReadRetries, 1, 0, 5);
    this.sleeper = sleeper;
  }

  async call(operation, { shopId, params = {} } = {}) {
    const apiPath = READ_OPERATIONS[String(operation || "")];
    if (!apiPath) {
      throw new ConnectorError("Shopee relay operation is not allowed", {
        code: "SHOPEE_RELAY_OPERATION_NOT_ALLOWED",
        status: 403,
        platform: "shopee",
        operation: String(operation || "unknown"),
      });
    }
    const request = {
      shop_id: normalizedShopId(shopId),
      api_path: apiPath,
      method: "GET",
      params: cleanParameters(params),
    };
    let lastError;
    for (let attempt = 0; attempt <= this.maxReadRetries; attempt += 1) {
      try {
        const response = await this.fetchImpl(new URL("api/shopee/call", this.baseUrl), {
          method: "POST",
          headers: {
            "X-Token-Key": this.apiKey,
            accept: "application/json",
            "content-type": "application/json",
            connection: "close",
          },
          body: JSON.stringify(request),
          redirect: "error",
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        let payload;
        try { payload = await response.json(); } catch {
          throw new ConnectorError("Shopee relay returned invalid JSON", {
            code: "SHOPEE_RELAY_RESPONSE_INVALID",
            status: 502,
            retryable: response.status >= 500,
            platform: "shopee",
            operation,
          });
        }
        if (!response.ok) throw httpError(response.status);
        if (!payload || typeof payload !== "object" || Array.isArray(payload) || payload.ok !== true || !payload.data) {
          throw new ConnectorError("Shopee relay response is invalid", {
            code: "SHOPEE_RELAY_RESPONSE_INVALID",
            status: 502,
            platform: "shopee",
            operation,
          });
        }
        const shopeeError = providerError(payload.data);
        if (shopeeError) {
          throw new ConnectorError(`Shopee rejected ${operation}`, {
            code: "SHOPEE_PROVIDER_REQUEST_FAILED",
            status: 502,
            retryable: false,
            platform: "shopee",
            operation,
            providerCode: shopeeError,
            providerRequestId: providerRequestId(payload.data),
          });
        }
        return {
          data: payload.data,
          providerRequestId: providerRequestId(payload.data),
          relayMetadata: {
            shopCode: payload["店编"] || null,
            durationMs: Number(payload["耗时ms"] || 0) || null,
          },
        };
      } catch (error) {
        lastError = error instanceof ConnectorError ? error : new ConnectorError("Shopee relay is unreachable", {
          code: "SHOPEE_RELAY_UNREACHABLE",
          status: 503,
          retryable: true,
          platform: "shopee",
          operation,
          cause: error,
        });
        if (!lastError.retryable || attempt >= this.maxReadRetries) throw lastError;
        await this.sleeper(Math.min(1000, 100 * (2 ** attempt)));
      }
    }
    throw lastError;
  }
}

export { READ_OPERATIONS as SHOPEE_RELAY_READ_OPERATIONS };
