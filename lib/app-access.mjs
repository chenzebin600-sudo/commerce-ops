import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

export const DEFAULT_APP_HOST = "127.0.0.1";
export const DEFAULT_APP_PORT = 3101;

function firstValue(...values) {
  return values.find((value) => String(value ?? "").trim() !== "");
}

export function isLoopbackBindHost(host) {
  const value = String(host || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (value === "localhost" || value === "::1") return true;
  if (value.startsWith("::ffff:")) return isLoopbackBindHost(value.slice(7));
  if (isIP(value) === 4) return Number(value.split(".")[0]) === 127;
  return false;
}

export function resolveAppConfig(env = process.env) {
  const host = String(firstValue(env.APP_HOST, env.HOST, DEFAULT_APP_HOST)).trim();
  const rawPort = firstValue(env.APP_PORT, env.PORT, DEFAULT_APP_PORT);
  const port = Number(rawPort);
  const accessToken = String(env.APP_ACCESS_TOKEN || "").trim();

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("APP_PORT 必须是 1 到 65535 之间的整数");
  }
  if (!isLoopbackBindHost(host) && !accessToken) {
    throw new Error("外部监听必须配置 APP_ACCESS_TOKEN");
  }

  return {
    host,
    port,
    accessToken,
    authenticationEnabled: Boolean(accessToken),
    localCompatibilityMode: isLoopbackBindHost(host) && !accessToken,
  };
}

function headerValue(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") return headers.get(name) || "";
  const direct = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(direct) ? direct[0] || "" : direct || "";
}

export function bearerTokenFromHeaders(headers) {
  const authorization = String(headerValue(headers, "authorization") || "");
  const match = authorization.match(/^Bearer ([^\s]+)$/i);
  return match ? match[1] : "";
}

export function constantTimeTokenEquals(expectedToken, candidateToken) {
  const expected = Buffer.from(String(expectedToken || ""), "utf8");
  const candidate = Buffer.from(String(candidateToken || ""), "utf8");
  if (!expected.length || !candidate.length) return false;

  const candidateForComparison = Buffer.alloc(expected.length);
  candidate.copy(candidateForComparison, 0, 0, Math.min(candidate.length, expected.length));
  const equal = timingSafeEqual(expected, candidateForComparison);
  return equal && candidate.length === expected.length;
}

export function createAccessPolicy({ host, accessToken }) {
  const expectedToken = String(accessToken || "").trim();
  const authenticationEnabled = Boolean(expectedToken);
  const localCompatibilityMode = isLoopbackBindHost(host) && !authenticationEnabled;

  return Object.freeze({
    authenticationEnabled,
    localCompatibilityMode,
    isAuthenticated(headers) {
      if (!authenticationEnabled) return localCompatibilityMode;
      return constantTimeTokenEquals(expectedToken, bearerTokenFromHeaders(headers));
    },
    status(headers) {
      return {
        authenticationEnabled,
        authenticated: authenticationEnabled ? this.isAuthenticated(headers) : localCompatibilityMode,
        localCompatibilityMode,
      };
    },
  });
}

export function isPublicApiPath(pathname) {
  return pathname === "/api/health"
    || pathname === "/api/auth/status"
    || pathname === "/api/auth/verify";
}

export function protectedApiAccessResponse(headers, policy) {
  if (policy.isAuthenticated(headers)) return null;
  return { status: 401, body: { ok: false, error: "未授权访问" } };
}

export function appStartupMessages({ host, port }, policy) {
  const displayHost = String(host).includes(":") ? `[${host}]` : host;
  const messages = [`Commerce Ops listening on http://${displayHost}:${port}`];
  if (policy.localCompatibilityMode) messages.push("当前未启用访问Token，仅允许本机访问");
  return messages;
}

export function authenticationApiResponse({ method, pathname, headers }, policy) {
  if (!isPublicApiPath(pathname)) return null;

  if (pathname === "/api/health") {
    if (method !== "GET") return { status: 405, body: { ok: false, error: "Method not allowed" } };
    return { status: 200, body: { ok: true } };
  }

  if (pathname === "/api/auth/status") {
    if (method !== "GET") return { status: 405, body: { ok: false, error: "Method not allowed" } };
    return { status: 200, body: policy.status(headers) };
  }

  if (method !== "POST") return { status: 405, body: { ok: false, error: "Method not allowed" } };
  if (!policy.isAuthenticated(headers)) {
    return { status: 401, body: { ok: false, error: "访问密钥错误" } };
  }
  return { status: 200, body: { ok: true, authenticated: true } };
}
