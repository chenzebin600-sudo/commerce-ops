export const CUSTOMER_SERVICE_CONTEXT_REGISTRY_VERSION = "1.0.0";

const INPUT_SCHEMA = Object.freeze({
  type: "object",
  required: ["snapshot_id"],
  additionalProperties: false,
  properties: {
    snapshot_id: { type: "string", minLength: 1, maxLength: 120 },
  },
});

export function registerCustomerServiceContext({ registry, contextService } = {}) {
  if (!registry || typeof registry.register !== "function") {
    throw new TypeError("Context Registry is required");
  }
  if (!contextService || typeof contextService.resolveSnapshot !== "function") {
    throw new TypeError("Customer-service Context service is required");
  }
  return registry.register({
    type: "customer_service",
    version: CUSTOMER_SERVICE_CONTEXT_REGISTRY_VERSION,
    description: "Immutable encrypted customer-service evidence snapshot for one current inbound message.",
    inputSchema: INPUT_SCHEMA,
    resolve: (input) => contextService.resolveSnapshot(input.snapshot_id),
  });
}
