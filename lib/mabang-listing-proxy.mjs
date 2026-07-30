import { isLoopbackBindHost } from "./app-access.mjs";

export const MABANG_LISTING_INTERNAL_HEADER =
  "x-commerce-ops-internal-token";
export const DEFAULT_MABANG_LISTING_HOST = "127.0.0.1";
export const DEFAULT_MABANG_LISTING_PORT = 8877;
export const DEFAULT_MABANG_LISTING_REQUEST_LIMIT = 4 * 1024 * 1024;
export const DEFAULT_MABANG_LISTING_RESPONSE_LIMIT = 32 * 1024 * 1024;

function firstValue(...values) {
  return values.find((value) => String(value ?? "").trim() !== "");
}

function parsePort(value, name) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return port;
}

export function resolveMabangListingProxyConfig(env = process.env) {
  const host = String(
    firstValue(env.MABANG_LISTING_HOST, DEFAULT_MABANG_LISTING_HOST),
  ).trim();
  const configuredPort = parsePort(
    firstValue(env.MABANG_LISTING_PORT, DEFAULT_MABANG_LISTING_PORT),
    "MABANG_LISTING_PORT",
  );
  const configuredBaseUrl = String(
    env.MABANG_LISTING_BASE_URL || "",
  ).trim();
  const baseUrl = new URL(
    configuredBaseUrl || `http://${host}:${configuredPort}`,
  );

  if (baseUrl.protocol !== "http:") {
    throw new Error("MABANG_LISTING_BASE_URL must use http");
  }
  if (!isLoopbackBindHost(baseUrl.hostname)) {
    throw new Error("Mabang listing proxy target must be a loopback address");
  }
  if (
    baseUrl.username
    || baseUrl.password
    || baseUrl.search
    || baseUrl.hash
    || baseUrl.pathname !== "/"
  ) {
    throw new Error(
      "MABANG_LISTING_BASE_URL cannot contain credentials, a path, query, or fragment",
    );
  }

  const port = parsePort(baseUrl.port || 80, "MABANG_LISTING_BASE_URL port");
  const normalizedHost = baseUrl.hostname.includes(":")
    ? `[${baseUrl.hostname}]`
    : baseUrl.hostname;
  return Object.freeze({
    host: baseUrl.hostname,
    port,
    baseUrl: `http://${normalizedHost}:${port}`,
  });
}

export function buildMabangListingTarget(baseUrl, requestUrl) {
  const sourceUrl = requestUrl instanceof URL
    ? requestUrl
    : new URL(String(requestUrl), "http://commerce-ops.invalid");
  const prefix = "/api/mabang-listing/";
  if (!sourceUrl.pathname.startsWith(prefix)) {
    throw new Error("Invalid Mabang listing proxy path");
  }
  const relative = sourceUrl.pathname.slice(prefix.length);
  if (!relative || relative === "service/status") {
    throw new Error("Invalid Mabang listing upstream path");
  }
  const target = new URL(baseUrl);
  target.pathname = `/api/${relative}`;
  target.search = sourceUrl.search;
  return target;
}

async function readRequestBody(req, maxBytes) {
  const declaredLength = Number(req.headers?.["content-length"] || 0);
  if (declaredLength > maxBytes) {
    const error = new Error("Mabang listing request is too large");
    error.status = 413;
    throw error;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) {
      const error = new Error("Mabang listing request is too large");
      error.status = 413;
      throw error;
    }
    chunks.push(bytes);
  }
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

async function readResponseBody(response, maxBytes) {
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > maxBytes) {
    throw new Error("Mabang listing response is too large");
  }
  if (!response.body) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    size += chunk.length;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error("Mabang listing response is too large");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function jsonResponse(res, status, error) {
  const body = Buffer.from(JSON.stringify({ success: false, message: error }));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
  });
  res.end(body);
}

export function createMabangListingProxy({
  baseUrl,
  internalToken,
  fetchImpl = globalThis.fetch,
  requestLimitBytes = DEFAULT_MABANG_LISTING_REQUEST_LIMIT,
  responseLimitBytes = DEFAULT_MABANG_LISTING_RESPONSE_LIMIT,
  timeoutMs = 5 * 60_000,
  onResponse = null,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchImpl must be a function");
  }
  if (!String(internalToken || "")) {
    throw new Error("Mabang listing internal token cannot be empty");
  }
  const fixedBaseUrl = resolveMabangListingProxyConfig({
    MABANG_LISTING_BASE_URL: baseUrl,
  }).baseUrl;

  return async function proxyMabangListingRequest(req, res, requestUrl) {
    if (!new Set(["GET", "POST", "DELETE"]).has(req.method)) {
      jsonResponse(res, 405, "Method not allowed");
      return true;
    }

    let timeout;
    let target = null;
    try {
      target = buildMabangListingTarget(fixedBaseUrl, requestUrl);
      const body = ["GET", "HEAD"].includes(req.method)
        ? undefined
        : await readRequestBody(req, requestLimitBytes);
      const headers = new Headers();
      const contentType = req.headers?.["content-type"];
      const accept = req.headers?.accept;
      if (contentType) headers.set("content-type", String(contentType));
      if (accept) headers.set("accept", String(accept));
      if (body) headers.set("content-length", String(body.length));
      const requestId =
        req.auditContext?.requestId || req.headers?.["x-request-id"];
      if (requestId) headers.set("x-request-id", String(requestId));
      headers.set(MABANG_LISTING_INTERNAL_HEADER, internalToken);

      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), timeoutMs);
      const response = await fetchImpl(target, {
        method: req.method,
        headers,
        body,
        redirect: "manual",
        signal: controller.signal,
      });

      if (response.status >= 300 && response.status < 400) {
        onResponse?.({
          req,
          target,
          status: 502,
          upstreamStatus: response.status,
        });
        jsonResponse(res, 502, "Mabang listing service returned a redirect");
        return true;
      }
      if (response.status === 401 || response.status === 403) {
        onResponse?.({
          req,
          target,
          status: 502,
          upstreamStatus: response.status,
        });
        jsonResponse(res, 502, "Mabang listing internal authentication failed");
        return true;
      }

      const responseBody = await readResponseBody(
        response,
        responseLimitBytes,
      );
      onResponse?.({
        req,
        target,
        status: response.status,
        upstreamStatus: response.status,
      });
      res.writeHead(response.status, {
        "content-type":
          response.headers.get("content-type")
          || "application/octet-stream",
        "content-length": responseBody.length,
        "cache-control": "no-store",
      });
      res.end(responseBody);
      return true;
    } catch (error) {
      const status = error?.status === 413
        ? 413
        : error?.name === "AbortError"
          ? 504
          : 503;
      onResponse?.({
        req,
        target,
        status,
        upstreamStatus: null,
        error,
      });
      if (status === 413) {
        jsonResponse(res, status, "Mabang listing request is too large");
      } else if (status === 504) {
        jsonResponse(res, status, "Mabang listing service timed out");
      } else {
        jsonResponse(res, status, "Mabang listing service is unavailable");
      }
      return true;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };
}
