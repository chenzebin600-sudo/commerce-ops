import { createHash } from "node:crypto";
import { normalizeCanonicalShopName } from "../data-foundation/unified-normalizers.mjs";

const PLATFORM_MAP = Object.freeze({ lazada: "LAZADA", shopee: "SHOPEE", tiktokshop: "TIKTOK", tiktok: "TIKTOK" });
const SOURCE_SYSTEMS = new Set(["mabang", "platform_gateway"]);

function text(value) { return String(value ?? "").trim(); }
function normalizedName(value) { return normalizeCanonicalShopName(value); }
function idFor(platform, providerShopId) {
  return `shop:${createHash("sha256").update(`${platform}\u001f${providerShopId}`).digest("hex").slice(0, 32)}`;
}

export class CommerceShopRegistryService {
  constructor({ repository, now = () => new Date() }) {
    if (!repository) throw new TypeError("Commerce shop repository is required");
    this.repository = repository;
    this.now = now;
  }

  async synchronize({ accountId, sourceSystem = "mabang", platform, shops, capabilities = [] }) {
    if (!await this.repository.isReady()) throw Object.assign(new Error("Commerce shop registry migration is required."), { code: "COMMERCE_SHOP_MIGRATION_REQUIRED" });
    const normalizedSource = text(sourceSystem).toLowerCase();
    if (!SOURCE_SYSTEMS.has(normalizedSource)) throw new TypeError("Unsupported shop source system");
    const normalizedPlatform = PLATFORM_MAP[text(platform).toLowerCase()] || text(platform).toUpperCase();
    if (!new Set(Object.values(PLATFORM_MAP)).has(normalizedPlatform)) throw new TypeError("Unsupported commerce shop platform");
    if (!text(accountId)) throw new TypeError("Commerce shop account ID is required");
    if (!Array.isArray(shops)) throw new TypeError("Commerce shops must be an array");
    const observedAt = this.now().toISOString();
    const normalized = [];
    const rejected = [];
    for (const raw of shops) {
      const providerShopId = text(raw?.id || raw?.shop_id);
      const shopName = text(raw?.name || raw?.shop_name);
      const siteCode = text(raw?.site || raw?.site_code).toUpperCase();
      if (!providerShopId || !shopName || !/^[A-Z]{2}$/.test(siteCode) || ["ZZ", "XX"].includes(siteCode)) {
        rejected.push({ providerShopId: providerShopId || null, shopName: shopName || null, reason: "SHOP_ID_NAME_OR_SITE_INVALID" });
        continue;
      }
      const growthShopId = await this.repository.findGrowthShop({
        platform: normalizedPlatform,
        normalizedShopName: normalizedName(shopName),
      });
      normalized.push({
        id: idFor(normalizedPlatform, providerShopId),
        platform: normalizedPlatform,
        providerShopId,
        shopName,
        normalizedShopName: normalizedName(shopName),
        countryCode: siteCode,
        siteCode,
        currency: text(raw?.currency) || null,
        providerShopType: text(raw?.shop_type || raw?.type) || null,
        controlShopType: "UNKNOWN",
        growthShopId,
        executionProvider: normalizedSource === "mabang" ? "MABANG_LISTING" : "PLATFORM_GATEWAY",
        platformConnectorShopId: text(raw?.platform_connector_shop_id) || null,
        identityStatus: "CONFIRMED",
        sourceMetadata: { countryEvidence: "provider_site", sourceSystem: normalizedSource },
      });
    }
    const result = await this.repository.synchronizeAccountScope({
      accountId: text(accountId), sourceSystem: normalizedSource, platform: normalizedPlatform,
      shops: normalized, capabilities: [...new Set(capabilities.map(text).filter(Boolean))], observedAt,
    });
    return { ...result, rejected, observedAt };
  }

  list(filters) { return this.repository.list(filters); }
  summary() { return this.repository.summary(); }
}
