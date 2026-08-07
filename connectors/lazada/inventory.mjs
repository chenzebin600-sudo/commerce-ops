import { normalizeLazadaProduct } from "./products.mjs";

function escapeXml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;",
  }[character]));
}

function tag(name, value) { return `<${name}>${escapeXml(value)}</${name}>`; }

export function buildLazadaInventoryPayload(input = {}) {
  if (!Array.isArray(input.items) || !input.items.length) throw new TypeError("update_inventory requires at least one item");
  const skus = input.items.map((item) => {
    if (!item.sellerSku && !item.skuId) throw new TypeError("Inventory item requires sellerSku or skuId");
    if (!Number.isFinite(Number(item.quantity)) || Number(item.quantity) < 0) throw new TypeError("Inventory quantity must be zero or greater");
    return `<Sku>${item.itemId ? tag("ItemId", item.itemId) : ""}${item.skuId ? tag("SkuId", item.skuId) : ""}${item.sellerSku ? tag("SellerSku", item.sellerSku) : ""}${tag("Quantity", Math.floor(Number(item.quantity)))}</Sku>`;
  }).join("");
  return `<Request><Product><Skus>${skus}</Skus></Product></Request>`;
}

export class LazadaInventoryApi {
  constructor(client) { this.client = client; }

  async getInventory(input = {}) {
    const limit = Math.min(500, Math.max(1, Number(input.limit) || 50));
    const offset = Math.max(0, Number(input.offset) || 0);
    const payload = await this.client.request({
      path: "/products/get",
      operation: "get_inventory",
      parameters: {
        filter: input.filter || "all",
        sku_seller_list: input.sellerSkus,
        limit,
        offset,
      },
    });
    const products = Array.isArray(payload.data?.products) ? payload.data.products.map(normalizeLazadaProduct) : [];
    const records = products.flatMap((product) => product.skus.map((sku) => ({
      productId: product.id,
      skuId: sku.id,
      sellerSku: sku.sellerSku,
      status: sku.status,
      quantity: sku.quantity,
      available: sku.available,
      warehouses: sku.inventories.warehouses,
      fbl: sku.inventories.fbl,
      channels: sku.inventories.channels,
    })));
    return {
      records,
      page: { offset, limit, count: records.length, productCount: products.length, totalProducts: Number(payload.data?.total_products || products.length) },
      providerRequestId: payload.request_id || null,
    };
  }

  async updateInventory(input) {
    const payload = await this.client.request({
      path: "/product/price_quantity/update",
      method: "POST",
      operation: "update_inventory",
      parameters: { payload: buildLazadaInventoryPayload(input) },
    });
    return { accepted: true, providerRequestId: payload.request_id || null, providerData: payload.data || null };
  }
}
