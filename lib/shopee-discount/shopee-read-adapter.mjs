const READ_PATHS = Object.freeze({
  items: "/api/v2/product/get_item_list",
  itemBaseInfo: "/api/v2/product/get_item_base_info",
  models: "/api/v2/product/get_model_list",
  discounts: "/api/v2/discount/get_discount_list",
  discount: "/api/v2/discount/get_discount",
});

function positiveId(value, field) {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    const error = new TypeError(`${field} must be a canonical positive integer string`);
    error.code = "SHOPEE_INPUT_INVALID";
    throw error;
  }
  return value;
}

function positivePage(value, field, maximum) {
  if (!Number.isSafeInteger(value) || value < 1) {
    const error = new TypeError(`${field} must be a positive safe integer`);
    error.code = "SHOPEE_INPUT_INVALID";
    throw error;
  }
  return Math.min(value, maximum);
}

function invalidInput(message) {
  const error = new TypeError(message);
  error.code = "SHOPEE_INPUT_INVALID";
  return error;
}

function rejectUnknownFields(fields) {
  if (Object.keys(fields).length) throw invalidInput(`unknown field: ${Object.keys(fields)[0]}`);
}

function validateRequestId(value) {
  if (safeRequestId(value, null) !== value) throw invalidInput("requestId is invalid");
  return value;
}

function normalizeSuccess(result, fallbackRequestId, attempts) {
  const payload = result?.body;
  const data = payload?.data ?? payload;
  const requestId = safeRequestId(data?.request_id, safeRequestId(payload?.request_id, fallbackRequestId));
  return {
    data: data?.response ?? data,
    requestId,
    attempts,
  };
}

function adapterError(code, message, { requestId = null, status } = {}) {
  const error = new Error(message);
  error.code = code;
  error.requestId = requestId;
  if (status !== undefined) error.status = status;
  return error;
}

function parseTransportResult(result, fallbackRequestId, relayPath) {
  let payload = result?.body;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      throw adapterError("SHOPEE_MALFORMED_CONTRACT", "Shopee relay returned malformed JSON", { requestId: fallbackRequestId });
    }
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw adapterError("SHOPEE_MALFORMED_CONTRACT", "Shopee relay returned an invalid response contract", { requestId: fallbackRequestId });
  }
  const data = payload.data ?? payload;
  const requestId = safeRequestId(data?.request_id, safeRequestId(payload.request_id, fallbackRequestId));
  const status = result?.status;
  const platformCode = platformErrorCode(data, payload);
  const errorText = [data?.error, payload?.error, data?.message, payload?.message].filter((value) => typeof value === "string").join(" ");
  if (status === 401 || status === 403 || /auth|token|permission|forbidden|unauthori[sz]ed/i.test(errorText)) {
    throw adapterError("SHOPEE_AUTH_ERROR", "Shopee authentication failed", { requestId, status });
  }
  if (status === 429 || READ_RATE_CODES.has(platformCode) || /rate.?limit|too many requests/i.test(errorText)) {
    throw adapterError("SHOPEE_RATE_LIMITED", "Shopee rate limit reached", { requestId, status });
  }
  if (status >= 500 || TECHNICAL_CODES.has(platformCode)) throw adapterError("SHOPEE_UNAVAILABLE", "Shopee relay is unavailable", { requestId, status });
  if (status < 200 || status >= 300 || payload.ok === false || (typeof data?.error === "string" && data.error.length > 0)) {
    throw adapterError("SHOPEE_BUSINESS_ERROR", "Shopee rejected the read request", { requestId, status });
  }
  if (relayPath === "/api/shopee/call" && (!data || typeof data !== "object" || !data.response || typeof data.response !== "object" || Array.isArray(data.response))) {
    throw adapterError("SHOPEE_MALFORMED_CONTRACT", "Shopee relay returned an incomplete platform contract", { requestId });
  }
  if (relayPath === "/api/token/shops" && !Array.isArray(data.shops)) {
    throw adapterError("SHOPEE_MALFORMED_CONTRACT", "Shopee relay returned an incomplete shop contract", { requestId });
  }
  return { ...result, body: payload };
}

export class ShopeeReadAdapter {
  constructor({ transport, retryPolicy = { maxAttempts: 1, delaysMs: [] }, sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay)) } = {}) {
    if (typeof transport !== "function") throw new TypeError("transport must be a function");
    if (!Number.isSafeInteger(retryPolicy?.maxAttempts) || retryPolicy.maxAttempts < 1 || retryPolicy.maxAttempts > 5) {
      throw new TypeError("retryPolicy.maxAttempts must be between 1 and 5");
    }
    if (!Array.isArray(retryPolicy.delaysMs) || typeof sleep !== "function") throw new TypeError("retry policy is invalid");
    this.transport = transport;
    this.retryPolicy = retryPolicy;
    this.sleep = sleep;
  }

  async #dispatch(request) {
    let lastError;
    for (let attempt = 1; attempt <= this.retryPolicy.maxAttempts; attempt += 1) {
      try {
        const result = parseTransportResult(await this.transport(request), request.requestId || null, request.relayPath);
        return { result, attempts: attempt };
      } catch (cause) {
        lastError = cause;
        const stableCodes = new Set(["SHOPEE_AUTH_ERROR", "SHOPEE_RATE_LIMITED", "SHOPEE_BUSINESS_ERROR", "SHOPEE_UNAVAILABLE", "SHOPEE_MALFORMED_CONTRACT"]);
        let retryable = new Set(["SHOPEE_RATE_LIMITED", "SHOPEE_UNAVAILABLE"]).has(cause?.code);
        if (!stableCodes.has(cause?.code)) {
          lastError = adapterError("SHOPEE_UNAVAILABLE", "Shopee relay is unavailable", { requestId: request.requestId || null });
          retryable = cause?.name === "AbortError" || new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT"]).has(cause?.code);
        }
        if (!retryable) throw lastError;
        if (attempt >= this.retryPolicy.maxAttempts) break;
        const delay = this.retryPolicy.delaysMs[Math.min(attempt - 1, this.retryPolicy.delaysMs.length - 1)] ?? 0;
        await this.sleep(delay);
      }
    }
    throw lastError;
  }

  async listShops({ requestId, ...unknown } = {}) {
    rejectUnknownFields(unknown);
    const cleanRequestId = requestId === undefined ? null : validateRequestId(requestId);
    const { result, attempts } = await this.#dispatch({ relayPath: "/api/token/shops", relayMethod: "GET", requestId: cleanRequestId });
    return normalizeSuccess(result, cleanRequestId, attempts);
  }

  async #call({ shopId, apiPath, params, requestId }) {
    const cleanRequestId = requestId === undefined ? null : validateRequestId(requestId);
    const { result, attempts } = await this.#dispatch({
      relayPath: "/api/shopee/call",
      relayMethod: "POST",
      requestId: cleanRequestId,
      body: { shop_id: positiveId(shopId, "shopId"), api_path: apiPath, method: "GET", params },
    });
    return normalizeSuccess(result, cleanRequestId, attempts);
  }

  async listActiveItems({ shopId, cursor = "0", pageSize, requestId, ...unknown } = {}) {
    rejectUnknownFields(unknown);
    if (typeof cursor !== "string" || !/^(0|[1-9]\d*)$/.test(cursor)) {
      const error = new TypeError("cursor must be a canonical non-negative integer string");
      error.code = "SHOPEE_INPUT_INVALID";
      throw error;
    }
    return this.#call({ shopId, apiPath: READ_PATHS.items, requestId, params: { offset: cursor, page_size: positivePage(pageSize, "pageSize", 100), item_status: ["NORMAL"] } });
  }

  async getItemBaseInfo({ shopId, itemIds, requestId, ...unknown } = {}) {
    rejectUnknownFields(unknown);
    if (!Array.isArray(itemIds) || itemIds.length < 1 || itemIds.length > 50) {
      throw invalidInput("itemIds must contain between 1 and 50 IDs");
    }
    const normalizedIds = itemIds.map((id) => positiveId(id, "itemId"));
    if (new Set(normalizedIds).size !== normalizedIds.length) throw invalidInput("itemIds must be unique");
    return this.#call({ shopId, apiPath: READ_PATHS.itemBaseInfo, requestId, params: { item_id_list: normalizedIds } });
  }

  async getModelList({ shopId, itemId, requestId, ...unknown } = {}) {
    rejectUnknownFields(unknown);
    return this.#call({ shopId, apiPath: READ_PATHS.models, requestId, params: { item_id: positiveId(itemId, "itemId") } });
  }

  async listDiscounts({ shopId, status, pageNo, pageSize, updatedFrom, updatedTo, requestId, ...unknown } = {}) {
    rejectUnknownFields(unknown);
    if (!new Set(["upcoming", "ongoing", "expired", "all"]).has(status)) {
      throw invalidInput("status must be upcoming, ongoing, expired, or all");
    }
    if ((updatedFrom === undefined) !== (updatedTo === undefined)) {
      throw invalidInput("updatedFrom and updatedTo must be provided together");
    }
    if (updatedFrom !== undefined) {
      if (typeof updatedFrom !== "string" || typeof updatedTo !== "string" || !/^[1-9]\d*$/.test(updatedFrom) || !/^[1-9]\d*$/.test(updatedTo)) {
        throw invalidInput("update timestamps must be canonical positive integer strings");
      }
      const from = BigInt(updatedFrom);
      const to = BigInt(updatedTo);
      if (to < from || to - from > 2_592_000n) throw invalidInput("discount update range must be at most 30 days");
    }
    const params = {
      discount_status: status,
      page_no: positivePage(pageNo, "pageNo", Number.MAX_SAFE_INTEGER),
      page_size: positivePage(pageSize, "pageSize", 100),
    };
    if (updatedFrom !== undefined) params.update_time_from = updatedFrom;
    if (updatedTo !== undefined) params.update_time_to = updatedTo;
    return this.#call({ shopId, apiPath: READ_PATHS.discounts, requestId, params });
  }

  async getDiscount({ shopId, discountId, pageNo, pageSize, requestId, ...unknown } = {}) {
    rejectUnknownFields(unknown);
    return this.#call({
      shopId,
      apiPath: READ_PATHS.discount,
      requestId,
      params: {
        discount_id: positiveId(discountId, "discountId"),
        page_no: positivePage(pageNo, "pageNo", Number.MAX_SAFE_INTEGER),
        page_size: positivePage(pageSize, "pageSize", 100),
      },
    });
  }
}

export function createShopeeReadAdapter(options) {
  return new ShopeeReadAdapter(options);
}
import { platformErrorCode, READ_RATE_CODES, safeRequestId, TECHNICAL_CODES } from "./response-boundary.mjs";
