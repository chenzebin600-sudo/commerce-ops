const PLATFORM_HOSTS = Object.freeze({
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
  tiktok: Object.freeze(["tiktok.com"]),
});

function hostMatches(hostname, domain) {
  const candidate = String(hostname || "").toLowerCase();
  return candidate === domain || candidate.endsWith(`.${domain}`);
}

function firstUrlCandidate(input) {
  const value = String(input || "").trim();
  const embedded = value.match(/https?:\/\/[\x21-\x7e]+/i)?.[0];
  const bareMarketplace = value.match(/(?:[a-z\d-]+\.)*(?:lazada\.(?:com\.ph|co\.th|com\.my|sg|vn|co\.id)|shopee\.(?:ph|co\.th|com\.my|sg|vn|co\.id)|tiktok\.com)(?:[/?][\x21-\x7e]*)?/i)?.[0];
  const candidate = embedded || bareMarketplace || value.split(/\s+/)[0] || "";
  return candidate.replace(/[，。,.;；:：!！?？)）\]】}>]+$/g, "");
}

export function normalizeMarketplaceUrl(input) {
  let candidate = firstUrlCandidate(input);
  if (!candidate) throw new TypeError("请输入商品链接。");
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(candidate)) candidate = `https://${candidate}`;

  const parsed = new URL(candidate);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new TypeError("商品链接必须使用 HTTP 或 HTTPS。");
  }
  parsed.hash = "";
  return parsed.href;
}

export function detectMarketplacePlatform(input) {
  let parsed;
  try {
    parsed = new URL(normalizeMarketplaceUrl(input));
  } catch {
    return "unknown";
  }
  const hostname = parsed.hostname.toLowerCase();
  for (const [platform, domains] of Object.entries(PLATFORM_HOSTS)) {
    if (domains.some((domain) => hostMatches(hostname, domain))) return platform;
  }
  return "unknown";
}

export function normalizeMarketplaceLink(input) {
  const url = normalizeMarketplaceUrl(input);
  const platform = detectMarketplacePlatform(url);
  if (platform === "unknown") throw new TypeError("暂不支持这个平台链接。");
  return Object.freeze({ url, platform });
}
