function amount(value) {
  return value === undefined || value === null || value === "" ? null : String(value);
}

function required(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new TypeError(`${label} is required`);
  return normalized;
}

function packageIds(values) {
  if (!Array.isArray(values)) throw new TypeError("packageIds must be an array");
  const normalized = [...new Set(values.map((value) => required(value, "package_id")))];
  if (!normalized.length) throw new TypeError("At least one package_id is required");
  if (normalized.length > 100) throw new TypeError("ReadyToShip accepts at most 100 packages per request");
  return normalized;
}

function providerBoolean(value, fallback = false) {
  if (value === true || String(value).toLowerCase() === "true") return true;
  if (value === false || String(value).toLowerCase() === "false") return false;
  return fallback;
}

function orderItemRows(payload) {
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.order_items)) return payload.data.order_items;
  if (Array.isArray(payload?.data?.items)) return payload.data.items;
  return [];
}

export function normalizeLazadaOrderItem(item = {}) {
  return {
    id: String(item.order_item_id || item.id || ""),
    orderId: String(item.order_id || ""),
    status: item.status ? String(item.status) : null,
    packageId: item.package_id ? String(item.package_id) : null,
    trackingCode: item.tracking_code ? String(item.tracking_code) : null,
    shipmentProvider: item.shipment_provider ? String(item.shipment_provider) : null,
    shippingType: item.shipping_type ? String(item.shipping_type) : null,
    deliveryOptionSof: Number(item.delivery_option_sof || 0),
    warehouseCode: item.warehouse_code ? String(item.warehouse_code) : null,
    sellerSku: item.sku || item.seller_sku || null,
    shopSku: item.shop_sku || null,
  };
}

export function normalizeLazadaOrder(order = {}) {
  const statuses = Array.isArray(order.statuses) ? order.statuses.map(String) : [];
  return {
    id: String(order.order_id || order.order_number || ""),
    orderNumber: String(order.order_number || order.order_id || ""),
    status: statuses[0] || null,
    statuses,
    createdAt: order.created_at || null,
    updatedAt: order.updated_at || null,
    total: amount(order.price),
    paymentMethod: order.payment_method || null,
    itemsCount: Number(order.items_count || 0),
    shippingFee: amount(order.shipping_fee),
    voucherAmount: amount(order.voucher),
    warehouseCode: order.warehouse_code || null,
    isCancelPending: Boolean(order.is_cancel_pending),
  };
}

export class LazadaOrdersApi {
  constructor(client) { this.client = client; }

  async getOrders(input = {}) {
    const limit = Math.min(100, Math.max(1, Number(input.limit) || 50));
    const offset = Math.max(0, Number(input.offset) || 0);
    const createdAfter = input.createdAfter || (!input.updatedAfter
      ? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
      : undefined);
    const payload = await this.client.request({
      path: "/orders/get",
      operation: "get_orders",
      parameters: {
        created_after: createdAfter,
        created_before: input.createdBefore,
        updated_after: input.updatedAfter,
        updated_before: input.updatedBefore,
        status: input.status,
        sort_by: input.sortBy,
        sort_direction: input.sortDirection,
        limit,
        offset,
      },
    });
    const rows = Array.isArray(payload.data?.orders) ? payload.data.orders : [];
    return {
      records: rows.map(normalizeLazadaOrder),
      page: { offset, limit, count: rows.length, total: Number(payload.data?.countTotal || rows.length) },
      providerRequestId: payload.request_id || null,
    };
  }

  async getOrderItems(input = {}) {
    const orderId = required(input.orderId, "order_id");
    const payload = await this.client.request({
      path: "/order/items/get",
      operation: "get_order_items",
      parameters: { order_id: orderId },
    });
    return {
      records: orderItemRows(payload).map(normalizeLazadaOrderItem),
      providerRequestId: payload.request_id || null,
    };
  }

  async readyToShip(input = {}) {
    const requestedPackageIds = packageIds(input.packageIds);
    const payload = await this.client.request({
      path: "/order/package/rts",
      method: "POST",
      operation: "ready_to_ship",
      parameters: {
        readyToShipReq: {
          packages: requestedPackageIds.map((packageId) => ({ package_id: packageId })),
        },
      },
    });
    const result = payload.result || {};
    const rows = Array.isArray(result.data?.packages)
      ? result.data.packages
      : Array.isArray(payload.data?.packages) ? payload.data.packages : [];
    const records = rows.map((row = {}) => ({
      packageId: String(row.package_id || ""),
      success: String(row.item_err_code ?? "") === "0",
      itemErrorCode: row.item_err_code === undefined || row.item_err_code === null
        ? null
        : String(row.item_err_code),
      message: row.msg ? String(row.msg) : null,
      retry: providerBoolean(row.retry),
    }));
    const confirmedPackageIds = new Set(records.map((record) => record.packageId).filter(Boolean));
    for (const packageId of requestedPackageIds) {
      if (!confirmedPackageIds.has(packageId)) {
        records.push({
          packageId,
          success: false,
          itemErrorCode: "MISSING_PROVIDER_RESULT",
          message: "Lazada did not return a per-package result",
          retry: false,
        });
      }
    }
    return {
      records,
      success: providerBoolean(result.success, true) && records.every((record) => record.success),
      providerRequestId: payload.request_id || null,
    };
  }
}
