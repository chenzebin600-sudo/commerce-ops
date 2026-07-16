import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import {
  DEFAULT_CHROME_ALLOWED_HOSTS_BY_PLATFORM,
  NETWORK_ERROR_CODES,
  NetworkPolicyError,
  hostnameMatchesAllowedHost,
} from "./network-policy.mjs";

export const DEFAULT_IMAGE_PROXY_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_IMAGE_PROXY_MAX_REDIRECTS = 3;
export const DEFAULT_NETWORK_REQUEST_TIMEOUT_MS = 20_000;

export const IMAGE_PROXY_ERROR_CODES = Object.freeze({
  CONTENT_TYPE_NOT_ALLOWED: "IMAGE_CONTENT_TYPE_NOT_ALLOWED",
  RESPONSE_TOO_LARGE: "IMAGE_RESPONSE_TOO_LARGE",
  REDIRECT_LIMIT: "IMAGE_REDIRECT_LIMIT",
  UPSTREAM_FAILED: "IMAGE_UPSTREAM_FAILED",
  REQUEST_TIMEOUT: "NETWORK_REQUEST_TIMEOUT",
});

const ALLOWED_IMAGE_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
]);

const SHOPEE_IMAGE_HOSTS = Object.freeze([
  ...DEFAULT_CHROME_ALLOWED_HOSTS_BY_PLATFORM.shopee,
  "susercontent.com",
]);
const TIKTOK_IMAGE_HOSTS = Object.freeze([
  ...DEFAULT_CHROME_ALLOWED_HOSTS_BY_PLATFORM.tiktokShop,
  "ibyteimg.com",
  "byteimg.com",
  "ttwstatic.com",
  "tiktokcdn.com",
]);

const IMAGE_ERROR_MESSAGES = Object.freeze({
  IMAGE_CONTENT_TYPE_NOT_ALLOWED: "目标响应不是允许的图片类型。",
  IMAGE_RESPONSE_TOO_LARGE: "图片响应超过大小限制。",
  IMAGE_REDIRECT_LIMIT: "图片地址跳转次数过多。",
  IMAGE_UPSTREAM_FAILED: "图片服务暂时不可用。",
  NETWORK_REQUEST_TIMEOUT: "图片请求超时。",
});

export class ImageProxyError extends Error {
  constructor(code, options = {}) {
    super(IMAGE_ERROR_MESSAGES[code] || "图片代理请求失败。", options.cause ? { cause: options.cause } : undefined);
    this.name = "ImageProxyError";
    this.code = code;
    this.status = options.status || 502;
  }
}

function boundedInteger(value, fallback, { minimum, maximum, name }) {
  const parsed = value == null || String(value).trim() === "" ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} 必须是 ${minimum} 到 ${maximum} 之间的整数。`);
  }
  return parsed;
}

export function resolveImageProxyConfig(env = process.env) {
  return Object.freeze({
    timeoutMs: boundedInteger(env.NETWORK_REQUEST_TIMEOUT_MS, DEFAULT_NETWORK_REQUEST_TIMEOUT_MS, {
      minimum: 1000,
      maximum: 120_000,
      name: "NETWORK_REQUEST_TIMEOUT_MS",
    }),
    maxBytes: boundedInteger(env.IMAGE_PROXY_MAX_BYTES, DEFAULT_IMAGE_PROXY_MAX_BYTES, {
      minimum: 1024,
      maximum: 50 * 1024 * 1024,
      name: "IMAGE_PROXY_MAX_BYTES",
    }),
    maxRedirects: boundedInteger(env.IMAGE_PROXY_MAX_REDIRECTS, DEFAULT_IMAGE_PROXY_MAX_REDIRECTS, {
      minimum: 0,
      maximum: 10,
      name: "IMAGE_PROXY_MAX_REDIRECTS",
    }),
  });
}

export function createPinnedLookup(addresses) {
  const vetted = addresses.map(({ address, family }) => ({ address, family }));
  if (!vetted.length) throw new Error("至少需要一个已验证的 DNS 地址。");
  return (_hostname, options, callback) => {
    const normalizedOptions = typeof options === "number" ? { family: options } : (options || {});
    const matching = normalizedOptions.family
      ? vetted.filter(({ family }) => family === normalizedOptions.family)
      : vetted;
    if (!matching.length) {
      const error = new Error("没有符合地址族要求的已验证 DNS 地址。");
      error.code = "ENOTFOUND";
      callback(error);
      return;
    }
    if (normalizedOptions.all) callback(null, matching);
    else callback(null, matching[0].address, matching[0].family);
  };
}

export function imageRefererForHostname(hostname) {
  if (SHOPEE_IMAGE_HOSTS.some((allowed) => hostnameMatchesAllowedHost(hostname, allowed))) return "https://shopee.ph/";
  if (TIKTOK_IMAGE_HOSTS.some((allowed) => hostnameMatchesAllowedHost(hostname, allowed))) return "https://shop.tiktok.com/";
  return "https://www.lazada.com.ph/";
}

export function requestPinnedImage({ url, addresses, headers, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request(url, {
      method: "GET",
      headers,
      lookup: createPinnedLookup(addresses),
    }, (response) => {
      response.setTimeout(timeoutMs, () => {
        response.destroy(new ImageProxyError(IMAGE_PROXY_ERROR_CODES.REQUEST_TIMEOUT, { status: 504 }));
      });
      resolve({
        statusCode: response.statusCode || 502,
        headers: response.headers,
        body: response,
        destroy(error) {
          response.destroy(error);
        },
      });
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(new ImageProxyError(IMAGE_PROXY_ERROR_CODES.REQUEST_TIMEOUT, { status: 504 }));
    });
    request.on("error", reject);
    request.end();
  });
}

function responseHeader(headers, name) {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function discardResponse(response) {
  if (typeof response.body?.resume === "function") response.body.resume();
  else if (typeof response.destroy === "function") response.destroy();
}

async function readLimitedBody(response, maxBytes) {
  const declaredLength = Number(responseHeader(response.headers, "content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    discardResponse(response);
    throw new ImageProxyError(IMAGE_PROXY_ERROR_CODES.RESPONSE_TOO_LARGE, { status: 413 });
  }

  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of response.body || Readable.from([])) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > maxBytes) {
        response.destroy?.();
        throw new ImageProxyError(IMAGE_PROXY_ERROR_CODES.RESPONSE_TOO_LARGE, { status: 413 });
      }
      chunks.push(bytes);
    }
  } catch (error) {
    if (error instanceof ImageProxyError) throw error;
    throw new ImageProxyError(IMAGE_PROXY_ERROR_CODES.UPSTREAM_FAILED, { cause: error });
  }
  return Buffer.concat(chunks);
}

function redirectLocation(response) {
  return String(responseHeader(response.headers, "location") || "").trim();
}

function isRedirect(statusCode) {
  return [301, 302, 303, 307, 308].indexOf(statusCode) >= 0;
}

export function createSecureImageFetcher({
  policy,
  requestImpl = requestPinnedImage,
  timeoutMs = DEFAULT_NETWORK_REQUEST_TIMEOUT_MS,
  maxBytes = DEFAULT_IMAGE_PROXY_MAX_BYTES,
  maxRedirects = DEFAULT_IMAGE_PROXY_MAX_REDIRECTS,
} = {}) {
  if (!policy?.validateUrl) throw new TypeError("图片代理必须配置网络安全策略。");

  return async function fetchImage(inputUrl) {
    let currentUrl = String(inputUrl || "");
    let redirectCount = 0;
    while (true) {
      let target;
      try {
        target = await policy.validateUrl(currentUrl);
      } catch (error) {
        if (redirectCount > 0 && error instanceof NetworkPolicyError) {
          throw new NetworkPolicyError(NETWORK_ERROR_CODES.REDIRECT_BLOCKED, { status: 403, cause: error });
        }
        throw error;
      }

      let response;
      try {
        response = await requestImpl({
          url: new URL(target.url),
          addresses: target.addresses,
          timeoutMs,
          headers: {
            accept: "image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1",
            referer: imageRefererForHostname(target.hostname),
            "user-agent": "Mozilla/5.0 (compatible; CommerceOpsImageProxy/1.0)",
          },
        });
      } catch (error) {
        if (error instanceof ImageProxyError) throw error;
        throw new ImageProxyError(IMAGE_PROXY_ERROR_CODES.UPSTREAM_FAILED, { cause: error });
      }

      const statusCode = Number(response.statusCode || 0);
      if (isRedirect(statusCode)) {
        const location = redirectLocation(response);
        discardResponse(response);
        if (!location) throw new ImageProxyError(IMAGE_PROXY_ERROR_CODES.UPSTREAM_FAILED);
        if (redirectCount >= maxRedirects) throw new ImageProxyError(IMAGE_PROXY_ERROR_CODES.REDIRECT_LIMIT, { status: 502 });
        currentUrl = new URL(location, target.url).href;
        redirectCount += 1;
        continue;
      }
      if (statusCode < 200 || statusCode >= 300) {
        discardResponse(response);
        throw new ImageProxyError(IMAGE_PROXY_ERROR_CODES.UPSTREAM_FAILED);
      }

      const contentType = String(responseHeader(response.headers, "content-type") || "")
        .split(";", 1)[0]
        .trim()
        .toLowerCase();
      if (!ALLOWED_IMAGE_CONTENT_TYPES.has(contentType)) {
        discardResponse(response);
        throw new ImageProxyError(IMAGE_PROXY_ERROR_CODES.CONTENT_TYPE_NOT_ALLOWED, { status: 415 });
      }
      const bytes = await readLimitedBody(response, maxBytes);
      return Object.freeze({ bytes, contentType, redirectCount });
    }
  };
}
