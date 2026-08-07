function escapeXml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;",
  }[character]));
}

function xmlTag(name, value) {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) throw new TypeError(`Invalid Lazada XML field: ${name}`);
  return `<${name}>${escapeXml(value)}</${name}>`;
}

function normalizeSku(sku = {}) {
  return {
    id: String(sku.SkuId || ""),
    sellerSku: String(sku.SellerSku || ""),
    shopSku: String(sku.ShopSku || ""),
    status: sku.Status || null,
    price: sku.price == null ? null : String(sku.price),
    specialPrice: sku.special_price == null ? null : String(sku.special_price),
    quantity: Number(sku.quantity ?? sku.Available ?? 0),
    available: Number(sku.Available ?? sku.quantity ?? 0),
    images: Array.isArray(sku.Images) ? sku.Images : [],
    inventories: {
      warehouses: Array.isArray(sku.multiWarehouseInventories) ? sku.multiWarehouseInventories : [],
      fbl: Array.isArray(sku.fblWarehouseInventories) ? sku.fblWarehouseInventories : [],
      channels: Array.isArray(sku.channelInventories) ? sku.channelInventories : [],
    },
  };
}

export function normalizeLazadaProduct(product = {}) {
  return {
    id: String(product.item_id || ""),
    name: product.attributes?.name || null,
    status: product.status || null,
    categoryId: product.primary_category == null ? null : String(product.primary_category),
    createdAt: product.created_time || null,
    updatedAt: product.updated_time || null,
    images: Array.isArray(product.images) ? product.images : [],
    attributes: product.attributes && typeof product.attributes === "object" ? product.attributes : {},
    skus: Array.isArray(product.skus) ? product.skus.map(normalizeSku) : [],
  };
}

export function buildLazadaProductPayload(input = {}) {
  if (!input.itemId) throw new TypeError("update_product requires itemId");
  const attributes = Object.entries(input.attributes || {}).map(([key, value]) => xmlTag(key, value)).join("");
  const images = (input.images || []).map((value) => xmlTag("Image", value)).join("");
  const skus = (input.skus || []).map((sku) => {
    const fields = [
      sku.sellerSku && xmlTag("SellerSku", sku.sellerSku),
      sku.skuId && xmlTag("SkuId", sku.skuId),
      sku.price != null && xmlTag("price", sku.price),
      sku.specialPrice != null && xmlTag("special_price", sku.specialPrice),
      sku.quantity != null && xmlTag("quantity", sku.quantity),
    ].filter(Boolean).join("");
    return `<Sku>${fields}</Sku>`;
  }).join("");
  return `<Request><Product>${xmlTag("ItemId", input.itemId)}${attributes ? `<Attributes>${attributes}</Attributes>` : ""}${images ? `<Images>${images}</Images>` : ""}${skus ? `<Skus>${skus}</Skus>` : ""}</Product></Request>`;
}

export class LazadaProductsApi {
  constructor(client) { this.client = client; }

  async getProducts(input = {}) {
    const limit = Math.min(500, Math.max(1, Number(input.limit) || 50));
    const offset = Math.max(0, Number(input.offset) || 0);
    const payload = await this.client.request({
      path: "/products/get",
      operation: "get_products",
      parameters: {
        filter: input.filter || "all",
        search: input.search,
        sku_seller_list: input.sellerSkus,
        update_before: input.updatedBefore,
        update_after: input.updatedAfter,
        create_before: input.createdBefore,
        create_after: input.createdAfter,
        limit,
        offset,
      },
    });
    const rows = Array.isArray(payload.data?.products) ? payload.data.products : [];
    return {
      records: rows.map(normalizeLazadaProduct),
      page: { offset, limit, count: rows.length, total: Number(payload.data?.total_products || rows.length) },
      providerRequestId: payload.request_id || null,
    };
  }

  async updateProduct(input) {
    const payload = await this.client.request({
      path: "/product/update",
      method: "POST",
      operation: "update_product",
      parameters: { payload: buildLazadaProductPayload(input) },
    });
    return { accepted: true, providerRequestId: payload.request_id || null, providerData: payload.data || null };
  }
}
