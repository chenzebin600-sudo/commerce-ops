const WRITE_PATHS = Object.freeze({
  createDiscount: "/api/v2/discount/add_discount",
  addDiscountItems: "/api/v2/discount/add_discount_item",
  updateDiscountItems: "/api/v2/discount/update_discount_item",
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function inputError(message) {
  const error = new TypeError(message);
  error.code = "SHOPEE_INPUT_INVALID";
  return error;
}

function positiveId(value, field) {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) throw inputError(`${field} must be a canonical positive integer string`);
  return value;
}

function operationUuid(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw inputError("operationUuid must be a UUID");
  return value;
}

function boundedInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) throw inputError(`${field} must be a non-negative int32`);
  return value;
}

function capability(options) {
  const value = options?.siteCapability;
  if (!value || !Number.isSafeInteger(value.priceScale) || value.priceScale < 0 || value.priceScale > 8) throw new TypeError("siteCapability.priceScale is invalid");
  for (const field of ["minPriceMinor", "maxPriceMinor", "priceStepMinor"]) {
    if (typeof value[field] !== "string" || !/^(0|[1-9]\d*)$/.test(value[field])) throw new TypeError(`siteCapability.${field} must be a canonical decimal string`);
  }
  const min = BigInt(value.minPriceMinor);
  const max = BigInt(value.maxPriceMinor);
  const step = BigInt(value.priceStepMinor);
  if (min < 1n || max < min || step < 1n || !Number.isSafeInteger(value.maxAddItems) || value.maxAddItems < 1 || value.maxAddItems > 50) {
    throw new TypeError("siteCapability is invalid");
  }
  return { ...value, min, max, step };
}

function fixedPrice(value, siteCapability, field) {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) throw inputError(`${field} must be a canonical minor-unit string`);
  const minor = BigInt(value);
  if (minor < siteCapability.min || minor > siteCapability.max || minor % siteCapability.step !== 0n) throw inputError(`${field} violates site price capability`);
  if (siteCapability.priceScale === 0) return minor.toString();
  const digits = minor.toString().padStart(siteCapability.priceScale + 1, "0");
  return `${digits.slice(0, -siteCapability.priceScale)}.${digits.slice(-siteCapability.priceScale)}`;
}

function validateRequestId(value) {
  if (safeRequestId(value, null) !== value) throw inputError("requestId is invalid");
  return value;
}

function normalizeResult(result, fallbackRequestId) {
  const payload = result?.body;
  const data = payload?.data ?? payload;
  return { data: data?.response ?? data, requestId: safeRequestId(data?.request_id, safeRequestId(payload?.request_id, fallbackRequestId)) };
}

function definiteError(code, message, requestId) {
  const error = new Error(message);
  error.code = code;
  error.requestId = requestId;
  return error;
}

function unknownWrite(operationId, requestId) {
  const error = new Error("Shopee write outcome is unknown; reconcile before any new dispatch");
  error.code = "SHOPEE_WRITE_UNKNOWN";
  error.operationUuid = operationId;
  error.requestId = requestId;
  return error;
}

function classifyWriteResult(result, operationId, fallbackRequestId) {
  const status = result?.status;
  if (!validHttpStatus(status)) throw unknownWrite(operationId, fallbackRequestId);
  if (status === 429 || status >= 500) throw unknownWrite(operationId, fallbackRequestId);
  if (status === 401 || status === 403) throw definiteError("SHOPEE_AUTH_ERROR", "Shopee write authentication was rejected", fallbackRequestId);
  let payload = result?.body;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      throw unknownWrite(operationId, fallbackRequestId);
    }
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw unknownWrite(operationId, fallbackRequestId);
  const data = payload.data ?? payload;
  const requestId = safeRequestId(data?.request_id, safeRequestId(payload.request_id, fallbackRequestId));
  const platformCode = platformErrorCode(data, payload);
  if (TECHNICAL_CODES.has(platformCode)) throw unknownWrite(operationId, requestId);
  if (status < 200 || status >= 300) throw unknownWrite(operationId, requestId);
  if (isDefiniteBusinessCode(platformCode)) {
    throw definiteError("SHOPEE_BUSINESS_ERROR", "Shopee rejected the write request", requestId);
  }
  if (payload.ok === false || platformCode) throw unknownWrite(operationId, requestId);
  if (!data || typeof data !== "object" || !data.response || typeof data.response !== "object" || Array.isArray(data.response)) {
    throw unknownWrite(operationId, requestId);
  }
  return { ...result, body: payload };
}

export class ShopeeWriteAdapter {
  constructor(options = {}) {
    if (typeof options.transport !== "function") throw new TypeError("transport must be a function");
    this.transport = options.transport;
    this.siteCapability = capability(options);
    this.nowEpochSeconds = options.nowEpochSeconds || (() => Math.floor(Date.now() / 1000));
  }

  async #dispatch({ operationUuid: operationId, shopId, requestId, apiPath, params }) {
    const uuid = operationUuid(operationId);
    const validatedRequestId = validateRequestId(requestId);
    const validatedShopId = positiveId(shopId, "shopId");
    let result;
    try {
      result = await this.transport({
        relayPath: "/api/shopee/call",
        relayMethod: "POST",
        headers: { "x-operation-uuid": uuid, "x-request-id": validatedRequestId },
        body: { shop_id: validatedShopId, api_path: apiPath, method: "POST", params },
      });
    } catch (error) {
      if (error?.code === "SHOPEE_AUTH_ERROR") {
        throw definiteError("SHOPEE_AUTH_ERROR", "Shopee write authentication was rejected", safeRequestId(error.requestId, validatedRequestId));
      }
      if (error?.code === "SHOPEE_BUSINESS_ERROR") {
        throw definiteError("SHOPEE_BUSINESS_ERROR", "Shopee rejected the write request", safeRequestId(error.requestId, validatedRequestId));
      }
      throw unknownWrite(uuid, validatedRequestId);
    }
    result = classifyWriteResult(result, uuid, validatedRequestId);
    return normalizeResult(result, validatedRequestId);
  }

  async createDiscount({ operationUuid: operationId, shopId, discountName, startTime, endTime, requestId, ...unknown } = {}) {
    if (Object.keys(unknown).length) throw inputError(`unknown field: ${Object.keys(unknown)[0]}`);
    if (typeof discountName !== "string" || !/^PM-[A-Z]{2,3}-(?:DAILY|EVENT|MEGA)-\d{4}-\d{2}-\d{2}-[A-Z0-9]{4,16}$/.test(discountName)) throw inputError("discountName is invalid");
    if (typeof startTime !== "string" || typeof endTime !== "string" || !/^[1-9]\d*$/.test(startTime) || !/^[1-9]\d*$/.test(endTime)) throw inputError("timestamps must be canonical positive integer strings");
    const start = BigInt(startTime);
    const end = BigInt(endTime);
    const now = BigInt(this.nowEpochSeconds());
    if (start < now + 3_600n || end < start + 3_600n || end - start >= 180n * 86_400n) throw inputError("discount timestamps violate the official window");
    if (start > BigInt(Number.MAX_SAFE_INTEGER) || end > BigInt(Number.MAX_SAFE_INTEGER)) throw inputError("timestamps exceed the safe relay range");
    return this.#dispatch({ operationUuid: operationId, shopId, requestId, apiPath: WRITE_PATHS.createDiscount, params: { discount_name: discountName, start_time: Number(start), end_time: Number(end) } });
  }

  async addDiscountItems({ operationUuid: operationId, shopId, discountId, items, requestId, ...unknown } = {}) {
    if (Object.keys(unknown).length) throw inputError(`unknown field: ${Object.keys(unknown)[0]}`);
    return this.#dispatch({ operationUuid: operationId, shopId, requestId, apiPath: WRITE_PATHS.addDiscountItems, params: { discount_id: positiveId(discountId, "discountId"), item_list: this.#items(items, true) } });
  }

  async updateDiscountItems({ operationUuid: operationId, shopId, discountId, items, requestId, ...unknown } = {}) {
    if (Object.keys(unknown).length) throw inputError(`unknown field: ${Object.keys(unknown)[0]}`);
    return this.#dispatch({ operationUuid: operationId, shopId, requestId, apiPath: WRITE_PATHS.updateDiscountItems, params: { discount_id: positiveId(discountId, "discountId"), item_list: this.#items(items, false) } });
  }

  #items(items, add) {
    const maximum = add ? this.siteCapability.maxAddItems : 50;
    if (!Array.isArray(items) || items.length < 1 || items.length > maximum) throw inputError(`items must contain between 1 and ${maximum} entries`);
    const normalizedItems = items.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw inputError("item must be an object");
      const allowed = new Set(add
        ? ["itemId", "itemPromotionPriceMinor", "itemPromotionStock", "models", "purchaseLimit"]
        : ["itemId", "itemPromotionPriceMinor", "models", "purchaseLimit"]);
      if (Object.keys(item).some((field) => !allowed.has(field))) throw inputError("item contains an unknown field");
      const output = { item_id: positiveId(item.itemId, "itemId") };
      if (item.itemPromotionPriceMinor !== undefined) output.item_promotion_price = fixedPrice(item.itemPromotionPriceMinor, this.siteCapability, "itemPromotionPriceMinor");
      if (add && item.itemPromotionStock !== undefined) output.item_promotion_stock = boundedInteger(item.itemPromotionStock, "itemPromotionStock");
      if (item.models !== undefined) {
        if (!Array.isArray(item.models) || item.models.length < 1 || item.models.length > 50) throw inputError("models must contain between 1 and 50 entries");
        output.model_list = item.models.map((model) => {
          const allowedModel = new Set(add ? ["modelId", "modelPromotionPriceMinor", "modelPromotionStock"] : ["modelId", "modelPromotionPriceMinor"]);
          if (!model || typeof model !== "object" || Object.keys(model).some((field) => !allowedModel.has(field))) throw inputError("model contains an unknown field");
          const normalized = { model_id: positiveId(model.modelId, "modelId"), model_promotion_price: fixedPrice(model.modelPromotionPriceMinor, this.siteCapability, "modelPromotionPriceMinor") };
          if (add && model.modelPromotionStock !== undefined) normalized.model_promotion_stock = boundedInteger(model.modelPromotionStock, "modelPromotionStock");
          return normalized;
        });
        const modelIds = output.model_list.map((model) => model.model_id);
        if (new Set(modelIds).size !== modelIds.length) throw inputError("model identities must be unique within an item");
      }
      if (item.itemPromotionPriceMinor === undefined && item.models === undefined) throw inputError("item or model promotion price is required");
      if (add && item.purchaseLimit === undefined) throw inputError("purchaseLimit is required for add");
      if (item.purchaseLimit !== undefined) output.purchase_limit = boundedInteger(item.purchaseLimit, "purchaseLimit");
      return output;
    });
    const itemIds = normalizedItems.map((item) => item.item_id);
    if (new Set(itemIds).size !== itemIds.length) throw inputError("item identities must be unique");
    return normalizedItems;
  }
}

export function createShopeeWriteAdapter(options) {
  return new ShopeeWriteAdapter(options);
}
import { isDefiniteBusinessCode, platformErrorCode, safeRequestId, TECHNICAL_CODES, validHttpStatus } from "./response-boundary.mjs";
