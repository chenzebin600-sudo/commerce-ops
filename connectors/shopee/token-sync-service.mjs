import { ConnectorError } from "../base/errors.mjs";

function nowIso(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("Shopee token sync clock returned an invalid date");
  return date.toISOString();
}

async function mapConcurrent(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }
  const settled = await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, items.length) }, () => run()),
  );
  const failure = settled.find((item) => item.status === "rejected");
  if (failure) throw failure.reason;
  return results;
}

export class ShopeeTokenSyncService {
  constructor({ repository, client, clock = () => new Date(), concurrency = 1 } = {}) {
    if (!repository?.db || typeof repository.upsertShop !== "function") {
      throw new TypeError("Shopee token sync repository is required");
    }
    if (!client || typeof client.listShops !== "function" || typeof client.getAccessToken !== "function") {
      throw new TypeError("Shopee token service client is required");
    }
    this.repository = repository;
    this.client = client;
    this.clock = clock;
    this.concurrency = Math.max(1, Math.min(10, Number(concurrency) || 1));
  }

  async inspect() {
    const listing = await this.client.listShops();
    return {
      owner: listing.owner,
      total: listing.shops.length,
      authorized: listing.shops.filter((shop) => shop.hasToken).length,
      unbound: listing.shops.filter((shop) => !shop.hasToken).map((shop) => ({
        shopCode: shop.shopCode,
        shopName: shop.shopName,
        shopId: shop.shopId,
        country: shop.countryCode,
      })),
    };
  }

  async synchronize() {
    const listing = await this.client.listShops();
    const authorizedShops = listing.shops.filter((shop) => shop.hasToken);
    const tokens = await mapConcurrent(authorizedShops, this.concurrency, async (shop) => {
      const token = await this.client.getAccessToken(shop.shopId);
      if (token.shopId !== shop.shopId) {
        throw new ConnectorError("Shopee token response does not match the requested shop", {
          code: "SHOPEE_TOKEN_SHOP_MISMATCH",
          status: 502,
          platform: "shopee",
        });
      }
      return [shop.shopId, token];
    });
    const tokenByShopId = new Map(tokens);
    const syncedAt = nowIso(this.clock);
    const result = { owner: listing.owner, total: listing.shops.length, authorized: 0, unbound: 0, shops: [] };

    this.repository.db.exec("BEGIN IMMEDIATE");
    try {
      for (const sourceShop of listing.shops) {
        const existing = this.repository.findShop({ platformId: "shopee", identifier: sourceShop.shopId });
        const shop = this.repository.upsertShop({
          platformId: "shopee",
          id: existing?.id || `shopee:${sourceShop.shopId}`,
          shopName: sourceShop.shopName || sourceShop.shopCode || `Shopee ${sourceShop.shopId}`,
          sellerId: sourceShop.shopId,
          country: sourceShop.countryCode,
          region: sourceShop.countryName,
          status: "active",
          metadata: {
            ...(existing?.metadata || {}),
            source: "internal_shopee_token_service",
            owner: listing.owner,
            shopCode: sourceShop.shopCode || null,
            tokenAvailable: sourceShop.hasToken,
            accessValid: sourceShop.accessValid,
            sourceAccessRemainingSeconds: sourceShop.accessRemainingSeconds,
            tokenServiceSyncedAt: syncedAt,
          },
        });
        const token = tokenByShopId.get(sourceShop.shopId);
        if (token) {
          this.repository.saveAuthorization({
            shopId: shop.id,
            applicationId: token.partnerId || "shopee-token-service",
            credentialGroupId: `shopee-token-service:${sourceShop.shopId}`,
            accessToken: token.accessToken,
            refreshToken: "",
            expiresAt: token.expireTime,
            refreshExpiresAt: null,
            tokenStatus: "active",
            lastRefreshTime: syncedAt,
          });
          result.authorized += 1;
        } else {
          this.repository.deleteAuthorization(shop.id);
          result.unbound += 1;
        }
        result.shops.push({
          shopId: sourceShop.shopId,
          connectorShopId: shop.id,
          shopCode: sourceShop.shopCode,
          country: sourceShop.countryCode,
          authorizationStored: Boolean(token),
          expiresAt: token?.expireTime || null,
        });
      }
      this.repository.db.exec("COMMIT");
    } catch (error) {
      this.repository.db.exec("ROLLBACK");
      throw error;
    }
    return result;
  }
}
