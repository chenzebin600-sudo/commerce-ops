import { BaseConnector } from "../base/connector.mjs";
import { ShopeeOrdersApi } from "./orders.mjs";
import { ShopeeProductsApi } from "./products.mjs";
import { ShopeeFinanceApi } from "./finance.mjs";

const CAPABILITIES = Object.freeze([
  "get_shop",
  "get_orders",
  "get_order_items",
  "get_products",
  "get_inventory",
  "get_finance_transactions",
  "get_expense_transactions",
]);

export class ShopeeConnector extends BaseConnector {
  constructor({ platform, shop, relayClient, clock, modelConcurrency } = {}) {
    super({ platform, apiVersion: "2.0", shop, authorization: null, capabilities: CAPABILITIES });
    if (!relayClient || typeof relayClient.call !== "function") {
      throw new TypeError("Shopee relay client is required");
    }
    this.relayClient = relayClient;
    this.orders = new ShopeeOrdersApi(relayClient, { shopId: shop.sellerId, clock });
    this.products = new ShopeeProductsApi(relayClient, { shopId: shop.sellerId, modelConcurrency });
    this.finance = new ShopeeFinanceApi(relayClient, { shopId: shop.sellerId, countryCode: shop.country });
  }

  async getShop() {
    this.assertCapability("get_shop");
    const call = await this.relayClient.call("get_shop_info", { shopId: this.shop.sellerId });
    const data = call.data?.response && typeof call.data.response === "object" ? call.data.response : call.data;
    return {
      record: {
        id: this.shop.id,
        sellerId: this.shop.sellerId,
        name: data.shop_name || this.shop.shopName,
        companyName: null,
        country: data.region || this.shop.country,
        status: "active",
        providerStatus: data.status || null,
        verified: null,
        shortCode: call.relayMetadata?.shopCode || null,
        crossBorder: null,
        marketplaceEaseMode: null,
      },
      providerRequestId: call.providerRequestId,
    };
  }

  getOrders(input) { this.assertCapability("get_orders"); return this.orders.getOrders(input); }
  getOrderItems(input) { this.assertCapability("get_order_items"); return this.orders.getOrderItems(input); }
  getProducts(input) { this.assertCapability("get_products"); return this.products.getProducts(input); }
  getInventory(input) { this.assertCapability("get_inventory"); return this.products.getInventory(input); }
  getFinanceTransactions(input) { this.assertCapability("get_finance_transactions"); return this.finance.getTransactions(input); }
  getExpenseTransactions(input) { this.assertCapability("get_expense_transactions"); return this.finance.getExpenseTransactions(input); }
}
