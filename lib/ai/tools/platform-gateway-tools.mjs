const PLATFORM_SHOP_SCHEMA = Object.freeze({
  type: "object",
  required: ["platform", "shop_id"],
  additionalProperties: true,
  properties: {
    platform: { type: "string", minLength: 2, maxLength: 50 },
    shop_id: { type: "string", minLength: 1, maxLength: 200 },
  },
});

const GATEWAY_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  required: ["ok", "data", "meta"],
});

function registerReadTool(registry, service, { name, description, permission, method }) {
  registry.register({
    name,
    version: "1.0.0",
    description,
    access: "read",
    permission,
    database_access: "service_only",
    external_access: "gateway_only",
    input_schema: PLATFORM_SHOP_SCHEMA,
    output_schema: GATEWAY_OUTPUT_SCHEMA,
    execute: ({ input, requestId }) => service[method]({
      platform: input.platform,
      shopId: input.shop_id,
      requestId,
      input,
    }),
  });
}

export function registerPlatformGatewayTools({ registry, service } = {}) {
  if (!registry || typeof registry.register !== "function") throw new TypeError("Agent Tool Registry is required");
  if (!service) throw new TypeError("Commerce Platform Gateway service is required");
  registerReadTool(registry, service, {
    name: "platform.shop.get",
    description: "Read one connected shop through the Commerce Platform Gateway.",
    permission: "platform.shop.read",
    method: "getShop",
  });
  registerReadTool(registry, service, {
    name: "platform.orders.query",
    description: "Read bounded normalized shop orders through the Commerce Platform Gateway.",
    permission: "platform.orders.read",
    method: "getOrders",
  });
  registerReadTool(registry, service, {
    name: "platform.products.query",
    description: "Read bounded normalized shop products through the Commerce Platform Gateway.",
    permission: "platform.products.read",
    method: "getProducts",
  });
  registerReadTool(registry, service, {
    name: "platform.inventory.query",
    description: "Read bounded normalized shop inventory through the Commerce Platform Gateway.",
    permission: "platform.inventory.read",
    method: "getInventory",
  });
  return registry;
}
