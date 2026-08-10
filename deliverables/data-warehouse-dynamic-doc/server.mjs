import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { validateKey, validateQueryPayload } from "./shared/query-model.mjs";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const MAX_REQUEST_BODY_BYTES = 64 * 1024;
const MAX_UPSTREAM_BODY_BYTES = 8 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 60_000;
const SECURITY_HEADERS = Object.freeze({
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
});

const PROXY_ROUTES = Object.freeze({
  "GET /proxy/me": { upstreamPath: "/api/data/me", method: "GET" },
  "GET /proxy/catalog": { upstreamPath: "/api/data/catalog", method: "GET" },
  "POST /proxy/query": { upstreamPath: "/api/data/query", method: "POST" },
});

const STATIC_ROUTES = Object.freeze({
  "/": { file: "public/index.html", contentType: "text/html; charset=utf-8" },
  "/index.html": { file: "public/index.html", contentType: "text/html; charset=utf-8" },
  "/app.css": { file: "public/app.css", contentType: "text/css; charset=utf-8" },
  "/app.js": { file: "public/app.js", contentType: "text/javascript; charset=utf-8" },
  "/shared/query-model.mjs": { file: "shared/query-model.mjs", contentType: "text/javascript; charset=utf-8" },
  "/shared/csv.mjs": { file: "shared/csv.mjs", contentType: "text/javascript; charset=utf-8" },
});

export function createApp({ upstreamBaseUrl, fetchImpl = fetch, logger = console }) {
  const upstream = new URL(upstreamBaseUrl);

  return createServer(async (request, response) => {
    try {
      if (hasPathTraversal(request.url)) return sendJson(response, 404, { error: "Not found" });
      const url = new URL(request.url, "http://127.0.0.1");
      const routeKey = `${request.method} ${url.pathname}`;
      const proxyRoute = PROXY_ROUTES[routeKey];

      if (request.method === "GET" && url.pathname === "/health") {
        return sendJson(response, 200, { ok: true });
      }
      if (proxyRoute) return await proxyRequest(request, response, proxyRoute, upstream, fetchImpl);
      if (isKnownProxyPath(url.pathname)) {
        return sendJson(response, 405, { error: "Method not allowed" }, { Allow: allowedMethodsFor(url.pathname) });
      }
      if (url.pathname.startsWith("/proxy/")) return sendJson(response, 404, { error: "Not found" });
      if ((request.method === "GET" || request.method === "HEAD") && STATIC_ROUTES[url.pathname]) {
        return await serveStatic(response, request.method, STATIC_ROUTES[url.pathname]);
      }
      if (STATIC_ROUTES[url.pathname]) return sendJson(response, 405, { error: "Method not allowed" }, { Allow: "GET, HEAD" });
      return sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      logger.error?.("Warehouse tool request failed");
      if (!response.headersSent) sendJson(response, 500, { error: "Internal server error" });
      else response.destroy(error);
    }
  });
}

export async function listenOnAvailablePort(server, { host = "127.0.0.1", preferredPort = 4788, attempts = 10 } = {}) {
  if (host !== "127.0.0.1") throw new Error("Only 127.0.0.1 is allowed");
  const firstPort = preferredPort;
  const finalPort = firstPort + Math.max(0, attempts - 1);

  for (let port = firstPort; port <= finalPort; port += 1) {
    try {
      await listen(server, port, host);
      return { host, port };
    } catch (error) {
      if (error?.code !== "EADDRINUSE" || port === finalPort) throw error;
    }
  }

  throw new Error("No loopback port available");
}

export function openBrowser(url, platform = process.platform) {
  const command = platform === "win32"
    ? { file: "cmd.exe", args: ["/c", "start", "", url] }
    : platform === "darwin"
      ? { file: "open", args: [url] }
      : platform === "linux"
        ? { file: "xdg-open", args: [url] }
        : undefined;
  if (!command) return undefined;

  const child = spawn(command.file, command.args, { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
  return child;
}

async function proxyRequest(request, response, route, upstream, fetchImpl) {
  const key = request.headers["x-data-key"];
  if (!validateKey(key).ok) return sendJson(response, 400, { error: "Invalid data key" });

  let body;
  if (route.method === "POST") {
    const parsed = await parseJsonBody(request);
    if (!parsed.ok) return sendJson(response, parsed.status, { error: parsed.error });
    const validated = validateQueryPayload(parsed.value);
    if (!validated.ok) return sendJson(response, 400, { error: "Invalid query payload", details: validated.errors });
    body = JSON.stringify(validated.value);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const headers = { "X-Data-Key": key };
    if (body) headers["Content-Type"] = "application/json";
    const upstreamResponse = await fetchImpl(new URL(route.upstreamPath, upstream).toString(), {
      method: route.method,
      headers,
      body,
      signal: controller.signal,
      redirect: "error",
    });
    const responseBody = await readResponseBody(upstreamResponse, MAX_UPSTREAM_BODY_BYTES);
    if (!responseBody.ok) return sendJson(response, 502, { error: "Upstream response too large" });
    return send(response, validStatus(upstreamResponse.status) ? upstreamResponse.status : 502, responseBody.value, {
      "Content-Type": upstreamResponse.headers.get("content-type") || "application/json; charset=utf-8",
    });
  } catch {
    return sendJson(response, 502, { error: "Unable to reach data warehouse" });
  } finally {
    clearTimeout(timeout);
  }
}

async function parseJsonBody(request) {
  const contentLength = Number(request.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BODY_BYTES) {
    request.resume();
    return { ok: false, status: 413, error: "Request body too large" };
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BODY_BYTES) return { ok: false, status: 413, error: "Request body too large" };
    chunks.push(chunk);
  }
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { ok: false, status: 400, error: "Invalid JSON body" };
  }
}

async function readResponseBody(upstreamResponse, limit) {
  if (!upstreamResponse.body) return { ok: true, value: Buffer.alloc(0) };
  const reader = upstreamResponse.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return { ok: false };
      }
      chunks.push(Buffer.from(value));
    }
    return { ok: true, value: Buffer.concat(chunks) };
  } finally {
    reader.releaseLock();
  }
}

async function serveStatic(response, method, route) {
  try {
    const content = await readFile(join(MODULE_DIR, route.file));
    if (method === "HEAD") return send(response, 200, undefined, { "Content-Type": route.contentType, "Content-Length": content.length });
    return send(response, 200, content, { "Content-Type": route.contentType });
  } catch (error) {
    if (error?.code === "ENOENT") return sendJson(response, 404, { error: "Not found" });
    throw error;
  }
}

function isKnownProxyPath(pathname) {
  return Object.keys(PROXY_ROUTES).some((key) => key.endsWith(` ${pathname}`));
}

function hasPathTraversal(requestUrl) {
  try {
    const rawPath = requestUrl.split("?", 1)[0];
    return /(^|[\\/])\.\.([\\/]|$)/.test(decodeURIComponent(rawPath));
  } catch {
    return true;
  }
}

function allowedMethodsFor(pathname) {
  return Object.keys(PROXY_ROUTES)
    .filter((key) => key.endsWith(` ${pathname}`))
    .map((key) => key.split(" ")[0])
    .join(", ");
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function validStatus(status) {
  return Number.isInteger(status) && status >= 200 && status <= 599;
}

function sendJson(response, status, value, headers) {
  return send(response, status, JSON.stringify(value), { "Content-Type": "application/json; charset=utf-8", ...headers });
}

function send(response, status, body, headers = {}) {
  response.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  response.end(body);
}

async function main() {
  const upstreamBaseUrl = process.env.DATA_WAREHOUSE_UPSTREAM_BASE_URL;
  if (!upstreamBaseUrl) throw new Error("DATA_WAREHOUSE_UPSTREAM_BASE_URL is required");
  const server = createApp({ upstreamBaseUrl });
  const { host, port } = await listenOnAvailablePort(server, {});
  const url = `http://${host}:${port}/`;
  console.log(`Data warehouse tool: ${url}`);
  console.log("Press Ctrl+C to stop.");
  openBrowser(url);
  const stop = () => server.close(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error("Unable to start data warehouse tool.");
    process.exitCode = 1;
  });
}
