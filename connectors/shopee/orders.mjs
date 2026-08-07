import { ConnectorError } from "../base/errors.mjs";

const MAX_ORDER_WINDOW_SECONDS = 15 * 24 * 60 * 60;
const ORDER_DETAIL_FIELDS = Object.freeze([
  "item_list",
  "package_list",
  "total_amount",
  "currency",
  "payment_method",
  "create_time",
  "update_time",
]);

function required(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw new ConnectorError(`${label} is required`, {
      code: "COMMERCE_PLATFORM_REQUEST_INVALID",
      status: 400,
      platform: "shopee",
    });
  }
  return normalized;
}

function pageSize(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(100, parsed) : 50;
}

function unixSeconds(value, label) {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new ConnectorError(`${label} is invalid`, {
      code: "COMMERCE_PLATFORM_REQUEST_INVALID",
      status: 400,
      platform: "shopee",
    });
  }
  return Math.floor(milliseconds / 1000);
}

function isoTime(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
}

function amount(value) {
  return value === undefined || value === null || value === "" ? null : String(value);
}

function responseOf(call) {
  return call?.data?.response && typeof call.data.response === "object" ? call.data.response : {};
}

function timeRange(input, clock) {
  const usesUpdated = Boolean(input.updatedAfter || input.updatedBefore);
  if (usesUpdated && (input.createdAfter || input.createdBefore)) {
    throw new ConnectorError("Shopee order query cannot mix created and updated time ranges", {
      code: "COMMERCE_PLATFORM_REQUEST_INVALID",
      status: 400,
      platform: "shopee",
    });
  }
  const now = Math.floor(clock().getTime() / 1000);
  const afterValue = usesUpdated ? input.updatedAfter : input.createdAfter;
  const beforeValue = usesUpdated ? input.updatedBefore : input.createdBefore;
  const timeTo = beforeValue ? unixSeconds(beforeValue, usesUpdated ? "updated_before" : "created_before") : now;
  const timeFrom = afterValue
    ? unixSeconds(afterValue, usesUpdated ? "updated_after" : "created_after")
    : timeTo - MAX_ORDER_WINDOW_SECONDS;
  if (timeFrom > timeTo || timeTo - timeFrom > MAX_ORDER_WINDOW_SECONDS) {
    throw new ConnectorError("Shopee order time range must be between 0 and 15 days", {
      code: "SHOPEE_ORDER_TIME_RANGE_INVALID",
      status: 400,
      platform: "shopee",
    });
  }
  return {
    time_range_field: usesUpdated ? "update_time" : "create_time",
    time_from: timeFrom,
    time_to: timeTo,
  };
}

export function normalizeShopeeOrder(order = {}) {
  const status = order.order_status ? String(order.order_status) : null;
  return {
    id: String(order.order_sn || ""),
    orderNumber: String(order.order_sn || ""),
    status,
    statuses: status ? [status] : [],
    createdAt: isoTime(order.create_time),
    updatedAt: isoTime(order.update_time),
    total: amount(order.total_amount),
    paymentMethod: order.payment_method || null,
    itemsCount: Array.isArray(order.item_list)
      ? order.item_list.reduce((total, item) => total + (Number(item.model_quantity_purchased) || 1), 0)
      : 0,
    shippingFee: null,
    voucherAmount: null,
    warehouseCode: null,
    isCancelPending: status === "IN_CANCEL",
  };
}

function packageForItem(packages, item) {
  if (!packages.length) return null;
  const packageNumber = String(item?.package_number || "");
  return packages.find((entry) => String(entry?.package_number || "") === packageNumber) || packages[0];
}

export function normalizeShopeeOrderItems(order = {}) {
  const packages = Array.isArray(order.package_list) ? order.package_list : [];
  const items = Array.isArray(order.item_list) ? order.item_list : [];
  return items.map((item, index) => {
    const shipment = packageForItem(packages, item);
    const itemId = String(item.item_id || "");
    const modelId = String(item.model_id || "");
    return {
      id: `${order.order_sn || "order"}:${itemId || "item"}:${modelId || index}`,
      orderId: String(order.order_sn || ""),
      status: order.order_status ? String(order.order_status) : null,
      packageId: shipment?.package_number ? String(shipment.package_number) : null,
      trackingCode: shipment?.tracking_number ? String(shipment.tracking_number) : null,
      shipmentProvider: shipment?.shipping_carrier || null,
      shippingType: shipment?.logistics_status || null,
      deliveryOptionSof: 0,
      warehouseCode: null,
      sellerSku: item.model_sku || item.item_sku || null,
      shopSku: null,
      productId: itemId || null,
      modelId: modelId || null,
      name: item.model_name || item.item_name || null,
      quantity: Number(item.model_quantity_purchased || 0),
      originalPrice: amount(item.model_original_price),
      discountedPrice: amount(item.model_discounted_price),
      image: item.image_info?.image_url || null,
    };
  });
}

export class ShopeeOrdersApi {
  constructor(client, { shopId, clock = () => new Date() } = {}) {
    this.client = client;
    this.shopId = required(shopId, "shop_id");
    this.clock = clock;
  }

  async getOrders(input = {}) {
    const limit = pageSize(input.limit);
    const call = await this.client.call("get_order_list", {
      shopId: this.shopId,
      params: {
        ...timeRange(input, this.clock),
        page_size: limit,
        cursor: input.cursor || undefined,
        order_status: input.status || undefined,
        response_optional_fields: "order_status",
      },
    });
    const response = responseOf(call);
    const rows = Array.isArray(response.order_list) ? response.order_list : [];
    return {
      records: rows.map(normalizeShopeeOrder),
      page: {
        cursor: input.cursor || null,
        limit,
        count: rows.length,
        hasMore: response.more === true,
        nextCursor: response.next_cursor || null,
      },
      providerRequestId: call.providerRequestId,
    };
  }

  async getOrderItems(input = {}) {
    const orderId = required(input.orderId, "order_id");
    const call = await this.client.call("get_order_detail", {
      shopId: this.shopId,
      params: {
        order_sn_list: orderId,
        response_optional_fields: ORDER_DETAIL_FIELDS.join(","),
      },
    });
    const response = responseOf(call);
    const order = Array.isArray(response.order_list)
      ? response.order_list.find((row) => String(row?.order_sn || "") === orderId) || response.order_list[0]
      : null;
    return {
      records: order ? normalizeShopeeOrderItems(order) : [],
      providerRequestId: call.providerRequestId,
    };
  }
}
