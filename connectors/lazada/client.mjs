import { ConnectorAuthenticationError, ConnectorError } from "../base/errors.mjs";
import { lazadaApiBaseUrl } from "./config.mjs";
import { signLazadaRequest } from "./signing.mjs";

const API_PATH = /^\/[A-Za-z0-9/_-]+$/;

function serialized(value) {
  if (Array.isArray(value) || (value && typeof value === "object")) return JSON.stringify(value);
  return String(value);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class LazadaClient {
  constructor({ app, shop, authorization, fetchImpl = fetch, timeoutMs = 20_000, maxReadRetries = 2, sleeper = sleep } = {}) {
    if (!app?.appKey || !app?.appSecret) throw new TypeError("Lazada app credentials are required");
    if (!shop?.country) throw new TypeError("Lazada shop country is required");
    if (!authorization?.accessToken) throw new ConnectorAuthenticationError("Lazada access token is missing", { platform: "lazada" });
    this.app = app;
    this.shop = shop;
    this.authorization = authorization;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = Math.max(1000, Number(timeoutMs) || 20_000);
    this.maxReadRetries = Math.max(0, Math.min(5, Number(maxReadRetries) || 0));
    this.sleeper = sleeper;
    this.baseUrl = lazadaApiBaseUrl(shop.country);
  }

  async request({ path, method = "GET", parameters = {}, operation = path } = {}) {
    if (!API_PATH.test(String(path || ""))) throw new TypeError("Lazada API path is invalid");
    const normalizedMethod = String(method).toUpperCase();
    if (!["GET", "POST"].includes(normalizedMethod)) throw new TypeError("Lazada API method is invalid");
    const business = Object.fromEntries(
      Object.entries(parameters).filter(([, value]) => value !== undefined && value !== null && String(value) !== "")
        .map(([key, value]) => [key, serialized(value)]),
    );
    const attempts = normalizedMethod === "GET" ? this.maxReadRetries + 1 : 1;
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const common = {
        app_key: this.app.appKey,
        access_token: this.authorization.accessToken,
        sign_method: "sha256",
        timestamp: String(Date.now()),
      };
      const sign = signLazadaRequest({
        apiPath: path,
        parameters: { ...common, ...business },
        appSecret: this.app.appSecret,
      });
      const endpoint = new URL(`${this.baseUrl}${path}`);
      for (const [key, value] of Object.entries(common)) endpoint.searchParams.set(key, value);
      endpoint.searchParams.set("sign", sign);
      const options = { method: normalizedMethod, headers: {}, signal: AbortSignal.timeout(this.timeoutMs) };
      if (normalizedMethod === "GET") {
        for (const [key, value] of Object.entries(business)) endpoint.searchParams.set(key, value);
      } else {
        options.headers["content-type"] = "application/x-www-form-urlencoded";
        options.body = new URLSearchParams(business);
      }
      try {
        const response = await this.fetchImpl(endpoint, options);
        const payload = await response.json().catch(() => ({}));
        const providerCode = String(payload.code ?? (response.ok ? "0" : response.status));
        if (response.ok && providerCode === "0") return payload;
        const rateLimited = response.status === 429 || providerCode === "ApiCallLimit";
        const authFailed = response.status === 401 || /InvalidAccessToken|IllegalAccessToken|Unauthorized/i.test(providerCode);
        const ErrorType = authFailed ? ConnectorAuthenticationError : ConnectorError;
        lastError = new ErrorType(payload.message || payload.detail || `Lazada API failed with HTTP ${response.status}`, {
          code: authFailed ? "CONNECTOR_ACCESS_TOKEN_REJECTED" : rateLimited ? "CONNECTOR_RATE_LIMITED" : "CONNECTOR_PROVIDER_ERROR",
          status: authFailed ? 401 : rateLimited ? 429 : 502,
          retryable: rateLimited || response.status >= 500,
          platform: "lazada",
          operation,
          providerCode,
          providerRequestId: payload.request_id || null,
        });
      } catch (error) {
        lastError = error instanceof ConnectorError ? error : new ConnectorError("Lazada API request failed", {
          code: error?.name === "TimeoutError" ? "CONNECTOR_TIMEOUT" : "CONNECTOR_NETWORK_ERROR",
          status: error?.name === "TimeoutError" ? 504 : 502,
          retryable: true,
          platform: "lazada",
          operation,
          cause: error,
        });
      }
      if (!lastError.retryable || attempt === attempts) throw lastError;
      await this.sleeper(Math.min(2000, 250 * (2 ** (attempt - 1))));
    }
    throw lastError;
  }
}
