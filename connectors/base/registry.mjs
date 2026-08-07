import { ConnectorConfigurationError } from "./errors.mjs";

function platformKey(value) {
  const key = String(value || "").trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{1,49}$/.test(key)) throw new TypeError("Platform connector type is invalid");
  return key;
}

export class ConnectorRegistry {
  constructor() {
    this.factories = new Map();
  }

  register(platformType, factory) {
    const key = platformKey(platformType);
    if (typeof factory !== "function") throw new TypeError("Connector factory is required");
    if (this.factories.has(key)) throw new TypeError(`Connector ${key} is already registered`);
    this.factories.set(key, factory);
    return this;
  }

  has(platformType) {
    return this.factories.has(platformKey(platformType));
  }

  create(platformType, context) {
    const key = platformKey(platformType);
    const factory = this.factories.get(key);
    if (!factory) throw new ConnectorConfigurationError(`Platform connector ${key} is not registered`, { platform: key });
    const connector = factory(context);
    if (!connector || typeof connector.getOrders !== "function") {
      throw new ConnectorConfigurationError(`Platform connector ${key} factory returned an invalid connector`, { platform: key });
    }
    return connector;
  }

  list() {
    return [...this.factories.keys()].sort();
  }
}
