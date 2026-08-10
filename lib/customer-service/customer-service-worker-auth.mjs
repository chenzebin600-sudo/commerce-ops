import { bearerTokenFromHeaders, constantTimeTokenEquals } from "../app-access.mjs";

function headerValue(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") return String(headers.get(name) || "");
  const value = headers[name] ?? headers[name.toLowerCase()];
  return String(Array.isArray(value) ? value[0] || "" : value || "");
}

export function createCustomerServiceWorkerAuth({
  token = process.env.CUSTOMER_SERVICE_WORKER_TOKEN,
} = {}) {
  const expectedToken = String(token || "").trim();
  return Object.freeze({
    configured: Boolean(expectedToken),
    authenticate(headers) {
      if (!expectedToken) {
        return {
          ok: false,
          status: 503,
          code: "CS_WORKER_AUTH_NOT_CONFIGURED",
          error: "Customer-service worker authentication is not configured",
        };
      }
      const workerId = headerValue(headers, "x-cs-worker-id").trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{1,119}$/.test(workerId)) {
        return { ok: false, status: 401, code: "CS_WORKER_ID_INVALID", error: "Worker identity is invalid" };
      }
      if (!constantTimeTokenEquals(expectedToken, bearerTokenFromHeaders(headers))) {
        return { ok: false, status: 401, code: "CS_WORKER_UNAUTHORIZED", error: "Worker authentication failed" };
      }
      return { ok: true, workerId };
    },
  });
}
