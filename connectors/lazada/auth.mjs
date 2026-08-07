import { ConnectorAuthenticationError, ConnectorConfigurationError } from "../base/errors.mjs";
import { signLazadaRequest } from "./signing.mjs";

const AUTH_PATH = "/oauth/authorize";
const TOKEN_CREATE_PATH = "/auth/token/create";
const TOKEN_REFRESH_PATH = "/auth/token/refresh";

function required(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new ConnectorConfigurationError(`${label} is not configured`, { platform: "lazada" });
  return normalized;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function normalizedToken(payload, clock = () => new Date()) {
  const countryUserInfo = Array.isArray(payload.country_user_info)
    ? payload.country_user_info
    : Array.isArray(payload.country_user_info_list) ? payload.country_user_info_list : [];
  const shopId = String(countryUserInfo[0]?.seller_id || payload.account_id || "").trim();
  if (!shopId || !payload.access_token || !payload.refresh_token) {
    throw new ConnectorAuthenticationError("Lazada token response is incomplete", {
      platform: "lazada",
      providerCode: payload.code,
      providerRequestId: payload.request_id,
    });
  }
  const now = clock();
  const current = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const expiresIn = positiveInteger(payload.expires_in);
  const refreshExpiresIn = positiveInteger(payload.refresh_expires_in);
  return {
    shopId,
    accountId: String(payload.account_id || ""),
    country: String(payload.country || countryUserInfo[0]?.country || "").toUpperCase(),
    accountPlatform: String(payload.account_platform || ""),
    account: String(payload.account || ""),
    accessToken: String(payload.access_token),
    refreshToken: String(payload.refresh_token),
    expireTime: new Date(current + expiresIn * 1000).toISOString(),
    refreshExpireTime: refreshExpiresIn ? new Date(current + refreshExpiresIn * 1000).toISOString() : "",
    countryUserInfo,
    providerRequestId: payload.request_id || null,
  };
}

async function tokenRequest({ path, parameterName, credential, app, fetchImpl, timeoutMs, clock }) {
  const parameters = {
    app_key: required(app.appKey, "Lazada app key"),
    [parameterName]: required(credential, `Lazada ${parameterName}`),
    sign_method: "sha256",
    timestamp: String(Date.now()),
  };
  const sign = signLazadaRequest({ apiPath: path, parameters, appSecret: app.appSecret });
  const endpoint = new URL(`${String(app.apiBaseUrl || "https://auth.lazada.com/rest").replace(/\/$/, "")}${path}`);
  for (const key of ["app_key", "sign_method", "timestamp"]) endpoint.searchParams.set(key, parameters[key]);
  endpoint.searchParams.set("sign", sign);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(timeoutMs || app.requestTimeoutMs || 20_000));
  timeout.unref?.();
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ [parameterName]: parameters[parameterName] }),
      signal: controller.signal,
    });
  } catch (error) {
    throw new ConnectorAuthenticationError("Lazada token endpoint is unavailable", {
      platform: "lazada",
      retryable: error?.name === "AbortError",
      cause: error,
    });
  } finally {
    clearTimeout(timeout);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || String(payload.code ?? "0") !== "0") {
    throw new ConnectorAuthenticationError(
      payload.message || payload.detail || `Lazada token request failed with HTTP ${response.status}`,
      {
        platform: "lazada",
        providerCode: payload.code,
        providerRequestId: payload.request_id,
        retryable: response.status >= 500,
      },
    );
  }
  return normalizedToken(payload, clock);
}

export function buildLazadaAuthorizationUrl(app, state) {
  const endpoint = new URL(AUTH_PATH, `${String(app.authBaseUrl || "https://auth.lazada.com").replace(/\/$/, "")}/`);
  endpoint.searchParams.set("response_type", "code");
  endpoint.searchParams.set("force_auth", "true");
  endpoint.searchParams.set("redirect_uri", required(app.callbackUrl, "Lazada callback URL"));
  endpoint.searchParams.set("client_id", required(app.appKey, "Lazada app key"));
  endpoint.searchParams.set("state", required(state, "OAuth state"));
  return endpoint.toString();
}

export function exchangeLazadaAuthorizationCode({ code, app, fetchImpl = fetch, timeoutMs, clock }) {
  return tokenRequest({
    path: TOKEN_CREATE_PATH,
    parameterName: "code",
    credential: code,
    app,
    fetchImpl,
    timeoutMs,
    clock,
  });
}

export function refreshLazadaAccessToken({ refreshToken, app, fetchImpl = fetch, timeoutMs, clock }) {
  return tokenRequest({
    path: TOKEN_REFRESH_PATH,
    parameterName: "refresh_token",
    credential: refreshToken,
    app,
    fetchImpl,
    timeoutMs,
    clock,
  });
}
