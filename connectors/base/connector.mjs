import { ConnectorCapabilityError } from "./errors.mjs";

export const CONNECTOR_OPERATIONS = Object.freeze([
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

function normalizedCapabilities(values) {
  const result = new Set(values || []);
  for (const value of result) {
    if (!CONNECTOR_OPERATIONS.includes(value)) throw new TypeError(`Unknown connector capability: ${value}`);
  }
  return result;
}

export class BaseConnector {
  constructor({ platform, apiVersion, shop, authorization, capabilities = [] } = {}) {
    if (!platform?.type) throw new TypeError("Connector platform is required");
    if (!shop?.id || !shop?.sellerId) throw new TypeError("Connector shop is required");
    this.platform = Object.freeze({ ...platform });
    this.apiVersion = String(apiVersion || platform.apiVersion || "");
    this.shop = Object.freeze({ ...shop });
    this.authorization = authorization ? Object.freeze({ ...authorization }) : null;
    this.capabilities = normalizedCapabilities(capabilities);
  }

  supports(operation) {
    return this.capabilities.has(operation);
  }

  assertCapability(operation) {
    if (!this.supports(operation)) throw new ConnectorCapabilityError(this.platform.type, operation);
  }

  authenticate(_input) { throw new ConnectorCapabilityError(this.platform.type, "authenticate"); }
  refreshToken(_input) { throw new ConnectorCapabilityError(this.platform.type, "refresh_token"); }
  getShop(_input) { throw new ConnectorCapabilityError(this.platform.type, "get_shop"); }
  getOrders(_input) { throw new ConnectorCapabilityError(this.platform.type, "get_orders"); }
  getOrderItems(_input) { throw new ConnectorCapabilityError(this.platform.type, "get_order_items"); }
  readyToShip(_input) { throw new ConnectorCapabilityError(this.platform.type, "ready_to_ship"); }
  getProducts(_input) { throw new ConnectorCapabilityError(this.platform.type, "get_products"); }
  updateProduct(_input) { throw new ConnectorCapabilityError(this.platform.type, "update_product"); }
  getInventory(_input) { throw new ConnectorCapabilityError(this.platform.type, "get_inventory"); }
  updateInventory(_input) { throw new ConnectorCapabilityError(this.platform.type, "update_inventory"); }
}
