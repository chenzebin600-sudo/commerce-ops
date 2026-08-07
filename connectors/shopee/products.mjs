function integer(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum ? Math.min(maximum, parsed) : fallback;
}

function amount(value) {
  return value === undefined || value === null || value === "" ? null : String(value);
}

function isoTime(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
}

function responseOf(call) {
  return call?.data?.response && typeof call.data.response === "object" ? call.data.response : {};
}

function imageList(item) {
  if (Array.isArray(item?.image?.image_url_list)) return item.image.image_url_list.filter(Boolean);
  if (Array.isArray(item?.image_info?.image_url_list)) return item.image_info.image_url_list.filter(Boolean);
  return [];
}

function attributes(item) {
  const rows = Array.isArray(item?.attribute_list) ? item.attribute_list : [];
  return Object.fromEntries(rows.map((row) => {
    const name = String(row.original_attribute_name || row.display_attribute_name || row.attribute_id || "attribute");
    const values = Array.isArray(row.attribute_value_list)
      ? row.attribute_value_list.map((value) => value.original_value_name || value.display_value_name || value.value_id).filter(Boolean)
      : [];
    return [name, values.length <= 1 ? values[0] ?? null : values];
  }));
}

function firstObject(value) {
  if (Array.isArray(value)) return value.find((item) => item && typeof item === "object") || {};
  return value && typeof value === "object" ? value : {};
}

export function normalizeShopeeModel(model = {}) {
  const price = firstObject(model.price_info);
  const stock = model.stock_info_v2 && typeof model.stock_info_v2 === "object" ? model.stock_info_v2 : {};
  const summary = stock.summary_info && typeof stock.summary_info === "object" ? stock.summary_info : {};
  const warehouses = Array.isArray(stock.seller_stock) ? stock.seller_stock : [];
  const available = Number(summary.total_available_stock ?? warehouses.reduce(
    (total, item) => total + (Number(item.stock) || 0),
    0,
  ));
  return {
    id: String(model.model_id || ""),
    sellerSku: String(model.model_sku || ""),
    shopSku: "",
    status: model.model_status || null,
    price: amount(price.original_price ?? price.current_price),
    specialPrice: amount(price.current_price),
    quantity: Number.isFinite(available) ? available : 0,
    available: Number.isFinite(available) ? available : 0,
    images: model.image_info?.image_url ? [model.image_info.image_url] : [],
    inventories: {
      warehouses,
      fbl: [],
      channels: [],
    },
  };
}

export function normalizeShopeeProduct(item = {}, models = []) {
  return {
    id: String(item.item_id || ""),
    name: item.item_name || null,
    status: item.item_status || null,
    categoryId: item.category_id == null ? null : String(item.category_id),
    createdAt: isoTime(item.create_time),
    updatedAt: isoTime(item.update_time),
    images: imageList(item),
    attributes: attributes(item),
    skus: models.map(normalizeShopeeModel),
  };
}

async function mapConcurrent(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => run()));
  return results;
}

function itemStatus(input) {
  const value = String(input.filter || "NORMAL").trim().toUpperCase();
  return ["NORMAL", "UNLIST", "BANNED", "DELETED"].includes(value) ? value : "NORMAL";
}

function matches(product, input) {
  const search = String(input.search || "").trim().toLowerCase();
  if (search && !String(product.name || "").toLowerCase().includes(search)) return false;
  if (Array.isArray(input.sellerSkus) && input.sellerSkus.length) {
    const requested = new Set(input.sellerSkus.map((value) => String(value).trim()).filter(Boolean));
    return product.skus.some((sku) => requested.has(sku.sellerSku));
  }
  return true;
}

export class ShopeeProductsApi {
  constructor(client, { shopId, modelConcurrency = 4 } = {}) {
    this.client = client;
    this.shopId = String(shopId || "").trim();
    this.modelConcurrency = integer(modelConcurrency, 4, 1, 8);
  }

  async getProducts(input = {}) {
    const limit = integer(input.limit, 20, 1, 20);
    const offset = integer(input.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const listingCall = await this.client.call("get_item_list", {
      shopId: this.shopId,
      params: {
        offset,
        page_size: limit,
        item_status: itemStatus(input),
      },
    });
    const listing = responseOf(listingCall);
    const listedItems = Array.isArray(listing.item) ? listing.item : [];
    const itemIds = listedItems.map((item) => String(item?.item_id || "")).filter(Boolean);
    if (!itemIds.length) {
      return {
        records: [],
        page: { offset, limit, count: 0, total: Number(listing.total_count || 0), hasMore: listing.has_next_page === true },
        providerRequestId: listingCall.providerRequestId,
      };
    }
    const baseCall = await this.client.call("get_item_base_info", {
      shopId: this.shopId,
      params: { item_id_list: itemIds },
    });
    const baseResponse = responseOf(baseCall);
    const baseItems = Array.isArray(baseResponse.item_list) ? baseResponse.item_list : [];
    const baseById = new Map(baseItems.map((item) => [String(item.item_id || ""), item]));
    const modelGroups = await mapConcurrent(itemIds, this.modelConcurrency, async (itemId) => {
      const modelCall = await this.client.call("get_model_list", {
        shopId: this.shopId,
        params: { item_id: itemId },
      });
      const modelResponse = responseOf(modelCall);
      return Array.isArray(modelResponse.model)
        ? modelResponse.model
        : Array.isArray(modelResponse.model_list) ? modelResponse.model_list : [];
    });
    const products = itemIds.map((itemId, index) => normalizeShopeeProduct(
      baseById.get(itemId) || listedItems.find((item) => String(item?.item_id || "") === itemId) || { item_id: itemId },
      modelGroups[index],
    )).filter((product) => matches(product, input));
    return {
      records: products,
      page: {
        offset,
        limit,
        count: products.length,
        total: Number(listing.total_count || products.length),
        hasMore: listing.has_next_page === true,
        nextOffset: listing.has_next_page === true ? offset + limit : null,
      },
      providerRequestId: listingCall.providerRequestId,
    };
  }

  async getInventory(input = {}) {
    const products = await this.getProducts(input);
    const records = products.records.flatMap((product) => product.skus.map((sku) => ({
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
      page: {
        ...products.page,
        count: records.length,
        productCount: products.records.length,
        totalProducts: products.page.total,
      },
      providerRequestId: products.providerRequestId,
    };
  }
}
