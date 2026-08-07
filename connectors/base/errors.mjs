export class ConnectorError extends Error {
  constructor(message, {
    code = "CONNECTOR_ERROR",
    status = 502,
    retryable = false,
    platform = null,
    operation = null,
    providerCode = null,
    providerRequestId = null,
    cause = null,
  } = {}) {
    super(String(message || "Platform connector request failed"), cause ? { cause } : undefined);
    this.name = "ConnectorError";
    this.code = code;
    this.status = status;
    this.retryable = Boolean(retryable);
    this.platform = platform;
    this.operation = operation;
    this.providerCode = providerCode;
    this.providerRequestId = providerRequestId;
  }
}

export class ConnectorConfigurationError extends ConnectorError {
  constructor(message, details = {}) {
    super(message, { code: "CONNECTOR_NOT_CONFIGURED", status: 503, ...details });
    this.name = "ConnectorConfigurationError";
  }
}

export class ConnectorAuthenticationError extends ConnectorError {
  constructor(message, details = {}) {
    super(message, { code: "CONNECTOR_AUTHENTICATION_FAILED", status: 401, ...details });
    this.name = "ConnectorAuthenticationError";
  }
}

export class ConnectorCapabilityError extends ConnectorError {
  constructor(platform, operation) {
    super(`${platform} connector does not support ${operation}`, {
      code: "CONNECTOR_CAPABILITY_UNAVAILABLE",
      status: 501,
      platform,
      operation,
    });
    this.name = "ConnectorCapabilityError";
  }
}

export function publicConnectorError(error) {
  const safe = error instanceof ConnectorError;
  return {
    status: safe ? Number(error.status || 500) : 500,
    body: {
      ok: false,
      code: safe ? error.code : "COMMERCE_PLATFORM_GATEWAY_FAILED",
      error: safe ? String(error.message).slice(0, 300) : "Commerce platform request failed",
      retryable: safe ? error.retryable : false,
      provider_request_id: safe ? error.providerRequestId || undefined : undefined,
    },
  };
}
