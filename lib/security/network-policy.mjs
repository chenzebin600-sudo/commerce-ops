import { lookup as defaultDnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

export const NETWORK_ERROR_CODES = Object.freeze({
  URL_INVALID: "URL_INVALID",
  PROTOCOL_NOT_ALLOWED: "PROTOCOL_NOT_ALLOWED",
  HOST_NOT_ALLOWED: "HOST_NOT_ALLOWED",
  IP_ADDRESS_NOT_ALLOWED: "IP_ADDRESS_NOT_ALLOWED",
  PRIVATE_NETWORK_BLOCKED: "PRIVATE_NETWORK_BLOCKED",
  DNS_RESOLUTION_FAILED: "DNS_RESOLUTION_FAILED",
  REDIRECT_BLOCKED: "REDIRECT_BLOCKED",
  NAVIGATION_TIMEOUT: "NAVIGATION_TIMEOUT",
});

export const DEFAULT_CHROME_ALLOWED_HOSTS_BY_PLATFORM = Object.freeze({
  lazada: Object.freeze([
    "lazada.com.ph",
    "lazada.co.th",
    "lazada.com.my",
    "lazada.sg",
    "lazada.vn",
    "lazada.co.id",
  ]),
  shopee: Object.freeze([
    "shopee.ph",
    "shopee.co.th",
    "shopee.com.my",
    "shopee.sg",
    "shopee.vn",
    "shopee.co.id",
  ]),
  tiktokShop: Object.freeze(["shop.tiktok.com"]),
  mabang: Object.freeze(["mabangerp.com"]),
});

export const DEFAULT_IMAGE_PROXY_ALLOWED_HOSTS = Object.freeze([
  ...DEFAULT_CHROME_ALLOWED_HOSTS_BY_PLATFORM.lazada,
  ...DEFAULT_CHROME_ALLOWED_HOSTS_BY_PLATFORM.shopee,
  ...DEFAULT_CHROME_ALLOWED_HOSTS_BY_PLATFORM.tiktokShop,
  "lazcdn.com",
  "alicdn.com",
  "slatic.net",
  "susercontent.com",
  "ibyteimg.com",
  "byteimg.com",
  "ttwstatic.com",
  "tiktokcdn.com",
]);

const GENERIC_SECOND_LEVEL_LABELS = new Set(["ac", "co", "com", "edu", "gov", "net", "org"]);
const PUBLIC_ERROR_MESSAGES = Object.freeze({
  URL_INVALID: "URL 格式无效。",
  PROTOCOL_NOT_ALLOWED: "仅允许 HTTP 或 HTTPS 地址。",
  HOST_NOT_ALLOWED: "目标域名不在允许范围内。",
  IP_ADDRESS_NOT_ALLOWED: "不允许直接访问 IP 地址。",
  PRIVATE_NETWORK_BLOCKED: "目标地址属于禁止访问的网络范围。",
  DNS_RESOLUTION_FAILED: "目标域名解析失败。",
  REDIRECT_BLOCKED: "目标跳转未通过安全校验。",
  NAVIGATION_TIMEOUT: "页面导航超时。",
});

export class NetworkPolicyError extends Error {
  constructor(code, options = {}) {
    super(PUBLIC_ERROR_MESSAGES[code] || "网络目标未通过安全校验。", options.cause ? { cause: options.cause } : undefined);
    this.name = "NetworkPolicyError";
    this.code = code;
    this.status = options.status || (code === NETWORK_ERROR_CODES.DNS_RESOLUTION_FAILED ? 502 : 400);
  }
}

export function normalizeHostname(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
}

function isValidConfiguredHostname(hostname) {
  if (!hostname || hostname.length > 253 || isIP(hostname)) return false;
  if (!/^[a-z0-9.-]+$/.test(hostname) || hostname.startsWith(".") || hostname.endsWith(".") || hostname.indexOf("..") >= 0) return false;
  const labels = hostname.split(".");
  if (labels.length < 2) return false;
  if (labels.some((label) => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) return false;
  if (labels.length === 2 && GENERIC_SECOND_LEVEL_LABELS.has(labels[0]) && labels[1].length === 2) return false;
  return true;
}

function configuredHost(value, environmentName) {
  const raw = String(value || "").trim();
  if (!raw || raw.indexOf("*") >= 0 || raw.indexOf("://") >= 0 || /[/?#@\s]/.test(raw)) {
    throw new Error(`${environmentName} 包含无效域名配置。`);
  }
  const hostname = normalizeHostname(raw);
  if (!isValidConfiguredHostname(hostname)) throw new Error(`${environmentName} 包含无效或过宽的域名配置。`);
  return hostname;
}

export function resolveAllowedHosts(defaultHosts, extensionValue = "", environmentName = "ALLOWED_HOSTS") {
  const hosts = new Set(defaultHosts.map((host) => configuredHost(host, environmentName)));
  for (const value of String(extensionValue || "").split(/[,;\n]/)) {
    if (value.trim()) hosts.add(configuredHost(value, environmentName));
  }
  return Object.freeze([...hosts].sort());
}

export function hostnameMatchesAllowedHost(hostname, allowedHost) {
  const candidate = normalizeHostname(hostname);
  const allowed = normalizeHostname(allowedHost);
  return candidate === allowed || candidate.endsWith(`.${allowed}`);
}

function ipv4ToNumber(address) {
  return address.split(".").reduce((value, octet) => ((value << 8) | Number(octet)) >>> 0, 0);
}

function ipv4InCidr(address, base, prefixLength) {
  const value = ipv4ToNumber(address);
  const baseValue = ipv4ToNumber(base);
  const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
  return (value & mask) === (baseValue & mask);
}

function expandIpv6(address) {
  let source = normalizeHostname(address).split("%")[0];
  if (source.indexOf(".") >= 0) {
    const lastColon = source.lastIndexOf(":");
    const ipv4 = source.slice(lastColon + 1);
    if (isIP(ipv4) !== 4) return null;
    const value = ipv4ToNumber(ipv4);
    source = `${source.slice(0, lastColon)}:${((value >>> 16) & 0xffff).toString(16)}:${(value & 0xffff).toString(16)}`;
  }
  const halves = source.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const parts = [...left, ...Array(missing).fill("0"), ...right];
  if (parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{1,4}$/i.test(part))) return null;
  return parts.map((part) => Number.parseInt(part, 16));
}

function ipv6ToBigInt(address) {
  const parts = expandIpv6(address);
  if (!parts) return null;
  return parts.reduce((value, part) => (value << 16n) | BigInt(part), 0n);
}

function ipv6InCidr(value, baseAddress, prefixLength) {
  const base = ipv6ToBigInt(baseAddress);
  if (value == null || base == null) return false;
  const shift = BigInt(128 - prefixLength);
  return (value >> shift) === (base >> shift);
}

function mappedIpv4Address(address) {
  const parts = expandIpv6(address);
  if (!parts) return null;
  const mapped = parts.slice(0, 5).every((part) => part === 0) && parts[5] === 0xffff;
  if (!mapped) return null;
  return `${parts[6] >>> 8}.${parts[6] & 0xff}.${parts[7] >>> 8}.${parts[7] & 0xff}`;
}

function isBlockedIpv4(address) {
  return [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ].some(([base, prefix]) => ipv4InCidr(address, base, prefix));
}

export function isBlockedIpAddress(address) {
  const normalized = normalizeHostname(address);
  const family = isIP(normalized);
  if (family === 4) return isBlockedIpv4(normalized);
  if (family !== 6) return true;
  const mappedIpv4 = mappedIpv4Address(normalized);
  if (mappedIpv4) return isBlockedIpv4(mappedIpv4);
  const value = ipv6ToBigInt(normalized);
  if (value == null) return true;
  if (!ipv6InCidr(value, "2000::", 3)) return true;
  return ipv6InCidr(value, "2001::", 32)
    || ipv6InCidr(value, "2001:10::", 28)
    || ipv6InCidr(value, "2001:20::", 28)
    || ipv6InCidr(value, "2001:db8::", 32)
    || ipv6InCidr(value, "2002::", 16);
}

function normalizeLookupResults(results) {
  const list = Array.isArray(results) ? results : [results];
  return list.map((entry) => {
    const address = normalizeHostname(typeof entry === "string" ? entry : entry?.address);
    const family = Number(typeof entry === "object" ? entry?.family : isIP(address));
    if (!address || (family !== 4 && family !== 6) || isIP(address) !== family) {
      throw new NetworkPolicyError(NETWORK_ERROR_CODES.DNS_RESOLUTION_FAILED, { status: 502 });
    }
    return Object.freeze({ address, family });
  });
}

export function createNetworkPolicy({
  name = "network target",
  allowedHosts,
  dnsLookup = defaultDnsLookup,
  allowedProtocols = ["https:", "http:"],
} = {}) {
  const hosts = resolveAllowedHosts(allowedHosts || [], "", `${name} allowed hosts`);
  const protocols = new Set(allowedProtocols);
  if (!hosts.length) throw new Error(`${name} 必须至少配置一个允许域名。`);

  async function validateUrl(input) {
    let parsed;
    try {
      parsed = new URL(String(input || ""));
    } catch (cause) {
      throw new NetworkPolicyError(NETWORK_ERROR_CODES.URL_INVALID, { cause });
    }
    if (!protocols.has(parsed.protocol)) throw new NetworkPolicyError(NETWORK_ERROR_CODES.PROTOCOL_NOT_ALLOWED);
    if (parsed.username || parsed.password) throw new NetworkPolicyError(NETWORK_ERROR_CODES.URL_INVALID);

    const hostname = normalizeHostname(parsed.hostname);
    if (!hostname) throw new NetworkPolicyError(NETWORK_ERROR_CODES.URL_INVALID);
    if (isIP(hostname)) throw new NetworkPolicyError(NETWORK_ERROR_CODES.IP_ADDRESS_NOT_ALLOWED);
    if (hostname === "localhost" || hostname.endsWith(".localhost")) {
      throw new NetworkPolicyError(NETWORK_ERROR_CODES.PRIVATE_NETWORK_BLOCKED);
    }
    if (!hosts.some((allowedHost) => hostnameMatchesAllowedHost(hostname, allowedHost))) {
      throw new NetworkPolicyError(NETWORK_ERROR_CODES.HOST_NOT_ALLOWED, { status: 403 });
    }

    let addresses;
    try {
      addresses = normalizeLookupResults(await dnsLookup(hostname, { all: true, verbatim: true }));
    } catch (error) {
      if (error instanceof NetworkPolicyError) throw error;
      throw new NetworkPolicyError(NETWORK_ERROR_CODES.DNS_RESOLUTION_FAILED, { status: 502, cause: error });
    }
    if (!addresses.length) throw new NetworkPolicyError(NETWORK_ERROR_CODES.DNS_RESOLUTION_FAILED, { status: 502 });
    if (addresses.some(({ address }) => isBlockedIpAddress(address))) {
      throw new NetworkPolicyError(NETWORK_ERROR_CODES.PRIVATE_NETWORK_BLOCKED, { status: 403 });
    }

    parsed.hostname = hostname;
    return Object.freeze({
      url: parsed.href,
      hostname,
      protocol: parsed.protocol,
      addresses,
    });
  }

  return Object.freeze({ name, allowedHosts: hosts, allowedProtocols: Object.freeze([...protocols]), validateUrl });
}

export function publicNetworkError(error, fallbackCode = NETWORK_ERROR_CODES.URL_INVALID) {
  if (error instanceof NetworkPolicyError) return error;
  return new NetworkPolicyError(fallbackCode, { cause: error });
}
