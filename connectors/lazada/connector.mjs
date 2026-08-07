import { BaseConnector } from "../base/connector.mjs";
import { buildLazadaAuthorizationUrl, refreshLazadaAccessToken } from "./auth.mjs";
import { LazadaClient } from "./client.mjs";
import { LazadaOrdersApi } from "./orders.mjs";
import { LazadaProductsApi } from "./products.mjs";
import { LazadaInventoryApi } from "./inventory.mjs";

const CAPABILITIES = Object.freeze([
  "authenticate",
  "refresh_token",
  "get_shop",
  "get_orders",
  "get_order_items",
  "ready_to_ship",
  "get_products",
  "update_product",
  "get_inventory",
  "update_inventory",
]);

export class LazadaConnector extends BaseConnector {
  constructor({ platform, shop, authorization, app, fetchImpl = fetch, timeoutMs, maxReadRetries, sleeper } = {}) {
    super({ platform, apiVersion: "2.0", shop, authorization, capabilities: CAPABILITIES });
    this.app = app;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.client = authorization ? new LazadaClient({
      app,
      shop,
      authorization,
      fetchImpl,
      timeoutMs,
      maxReadRetries,
      sleeper,
    }) : null;
    this.orders = this.client ? new LazadaOrdersApi(this.client) : null;
    this.products = this.client ? new LazadaProductsApi(this.client) : null;
    this.inventory = this.client ? new LazadaInventoryApi(this.client) : null;
  }

  authenticate({ state }) {
    this.assertCapability("authenticate");
    return { authorizationUrl: buildLazadaAuthorizationUrl(this.app, state) };
  }

  refreshToken() {
    this.assertCapability("refresh_token");
    return refreshLazadaAccessToken({
      refreshToken: this.authorization?.refreshToken,
      app: this.app,
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
    });
  }

  async getShop() {
    this.assertCapability("get_shop");
    const payload = await this.client.request({ path: "/seller/get", operation: "get_shop" });
    const data = payload.data || {};
    return {
      record: {
        id: this.shop.id,
        sellerId: String(data.seller_id || this.shop.sellerId),
        name: data.name || this.shop.shopName,
        companyName: data.name_company || null,
        country: this.shop.country,
        status: data.status || this.shop.status,
        verified: Boolean(data.verified),
        shortCode: data.short_code || null,
        crossBorder: Boolean(data.cb),
        marketplaceEaseMode: Boolean(data.marketplaceEaseMode),
      },
      providerRequestId: payload.request_id || null,
    };
  }

  getOrders(input) { this.assertCapability("get_orders"); return this.orders.getOrders(input); }
  getOrderItems(input) { this.assertCapability("get_order_items"); return this.orders.getOrderItems(input); }
  readyToShip(input) { this.assertCapability("ready_to_ship"); return this.orders.readyToShip(input); }
  getProducts(input) { this.assertCapability("get_products"); return this.products.getProducts(input); }
  updateProduct(input) { this.assertCapability("update_product"); return this.products.updateProduct(input); }
  getInventory(input) { this.assertCapability("get_inventory"); return this.inventory.getInventory(input); }
  updateInventory(input) { this.assertCapability("update_inventory"); return this.inventory.updateInventory(input); }
}
