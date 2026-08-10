import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SqliteProvider } from "../lib/data/sqlite/sqlite-provider.mjs";
import { CommerceShopRegistryRepository } from "../lib/shops/commerce-shop-registry-repository.mjs";
import { CommerceShopRegistryService } from "../lib/shops/commerce-shop-registry-service.mjs";
import { CommerceShopDirectoryService } from "../lib/shops/commerce-shop-directory-service.mjs";

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(`
    CREATE TABLE foundation_integration_accounts (id TEXT PRIMARY KEY);
    CREATE TABLE growth_shops (id TEXT PRIMARY KEY);
    CREATE TABLE growth_shop_source_mappings (
      id TEXT PRIMARY KEY,source_system TEXT NOT NULL,normalized_source_shop_name TEXT NOT NULL,
      internal_shop_id TEXT,platform TEXT NOT NULL
    );
    INSERT INTO foundation_integration_accounts(id) VALUES ('foundation:account:mabang:test');
    INSERT INTO growth_shops(id) VALUES ('growth-shop-1');
    INSERT INTO growth_shop_source_mappings(
      id,source_system,normalized_source_shop_name,internal_shop_id,platform
    ) VALUES ('mapping-1','mabang','alpha mall','growth-shop-1','lazada');
  `);
  db.exec(fs.readFileSync(new URL("../migrations/027_commerce_shop_registry.sql", import.meta.url), "utf8"));
  db.exec(fs.readFileSync(new URL("../migrations/031_commerce_shop_directory.sql", import.meta.url), "utf8"));
  const provider = new SqliteProvider({ connection: db });
  const repository = new CommerceShopRegistryRepository({ provider });
  const service = new CommerceShopRegistryService({
    repository,
    now: () => new Date("2026-08-06T12:00:00.000Z"),
  });
  return { db, provider, repository, service };
}

test("commerce shop registry persists provider country evidence and account bindings", async (t) => {
  const { db, provider, repository, service } = fixture();
  t.after(() => provider.close());
  const first = await service.synchronize({
    accountId: "foundation:account:mabang:test",
    platform: "lazada",
    capabilities: ["price", "special_price"],
    shops: [
      { id: 101, name: "Alpha Mall", site: "th", shop_type: 1 },
      { id: 102, name: "Beta Home", site: "MY", shop_type: 1 },
      { id: "", name: "Broken", site: "MY" },
    ],
  });
  assert.deepEqual(
    { seen: first.seen, inserted: first.inserted, linked: first.linkedGrowthShops, rejected: first.rejected.length },
    { seen: 2, inserted: 2, linked: 1, rejected: 1 },
  );
  const shops = await service.list({ accountId: "foundation:account:mabang:test", status: "ACTIVE" });
  assert.equal(shops.length, 2);
  assert.deepEqual(shops.map((shop) => [shop.countryCode, shop.executionProvider, shop.controlShopType]), [
    ["MY", "MABANG_LISTING", "UNKNOWN"],
    ["TH", "MABANG_LISTING", "UNKNOWN"],
  ]);
  assert.equal(shops.find((shop) => shop.shopName === "Alpha Mall").growthShopId, "growth-shop-1");
  assert.equal(db.prepare("SELECT COUNT(*) total FROM commerce_shop_account_bindings WHERE status='ACTIVE'").get().total, 2);
  assert.equal(
    await repository.findCommonActiveAccount(
      shops.map((shop) => shop.id),
      "mabang",
      ["price", "special_price"],
    ),
    "foundation:account:mabang:test",
  );

  const second = await service.synchronize({
    accountId: "foundation:account:mabang:test",
    platform: "LAZADA",
    capabilities: ["price"],
    shops: [{ id: 101, name: "Alpha Mall Renamed", site: "TH", shop_type: 1 }],
  });
  assert.equal(second.updated, 1);
  assert.equal(second.deactivated, 1);
  assert.equal((await repository.list({ status: "INACTIVE" })).length, 1);
  assert.equal((await repository.list({ countryCode: "TH" }))[0].shopName, "Alpha Mall Renamed");
  assert.equal(
    await repository.findCommonActiveAccount([shops.find((shop) => shop.countryCode === "TH").id], "mabang", ["price"]),
    "foundation:account:mabang:test",
  );
  assert.equal(
    await repository.findCommonActiveAccount([shops.find((shop) => shop.countryCode === "TH").id], "mabang", ["special_price"]),
    null,
  );
});

test("commerce shop registry rejects missing country evidence instead of guessing", async (t) => {
  const { provider, service } = fixture();
  t.after(() => provider.close());
  const result = await service.synchronize({
    accountId: "foundation:account:mabang:test",
    platform: "shopee",
    shops: [{ id: 201, name: "Unknown Country", site: "" }],
  });
  assert.equal(result.seen, 0);
  assert.equal(result.rejected[0].reason, "SHOP_ID_NAME_OR_SITE_INVALID");
  assert.equal((await service.list({})).length, 0);
});

test("shop directory imports business fields and projects live Connector authorization", async (t) => {
  const { provider, repository, service } = fixture();
  t.after(() => provider.close());
  await service.synchronize({
    accountId: "foundation:account:mabang:test",
    platform: "lazada",
    shops: [{ id: 101, name: "Alpha Mall", site: "TH", shop_type: 1 }],
  });
  const connectorShop = {
    id: "connector-alpha",
    platformId: "lazada",
    shopName: "Alpha Mall",
    sellerId: "9001",
    country: "TH",
    region: "Thailand",
    status: "active",
    metadata: { shortCode: "THALPHA" },
    authorization: {
      applicationId: "app-1",
      expiresAt: "2026-09-01T00:00:00.000Z",
      tokenStatus: "active",
    },
  };
  const directory = new CommerceShopDirectoryService({
    repository,
    now: () => new Date("2026-08-08T12:00:00.000Z"),
    platformGatewayService: {
      listShops: () => [connectorShop],
      listPlatforms: () => [{ id: "lazada", status: "active", connectorRegistered: true }],
    },
  });
  const imported = await directory.synchronize({
    source: "SPREADSHEET",
    shops: [{
      shopCode: "BS0001",
      shopName: "Alpha Mall",
      country: "泰国",
      platform: "Lazada",
      manager: "Manager A",
      seniorManager: "Lead A",
      category: "家具",
      shortCode: "LOCAL-CODE",
      sellerId: "9001",
      shopType: "Mall店",
    }],
  });
  assert.equal(imported.updated, 1);
  assert.equal(imported.created, 0);
  const shops = await directory.list({});
  assert.equal(shops.length, 1);
  assert.deepEqual({
    shopCode: shops[0].shopCode,
    sellerId: shops[0].sellerId,
    shopType: shops[0].shopType,
    authorizationStatus: shops[0].authorizationStatus,
    callable: shops[0].callable,
    connectorShopId: shops[0].platformConnectorShopId,
    platformShortCode: shops[0].platformShortCode,
  }, {
    shopCode: "THALPHA",
    sellerId: "9001",
    shopType: "MALL",
    authorizationStatus: "AUTHORIZED",
    callable: true,
    connectorShopId: "connector-alpha",
    platformShortCode: "THALPHA",
  });
  const persisted = await repository.getById(shops[0].directoryShopId);
  assert.equal(persisted.platformConnectorShopId, "connector-alpha");
  assert.equal(persisted.managerName, "Manager A");
});

test("shop directory list is API-authoritative and never overlays a name-only registry candidate", async (t) => {
  const { provider, repository } = fixture();
  t.after(() => provider.close());
  await new CommerceShopDirectoryService({
    repository,
    now: () => new Date("2026-08-08T12:00:00.000Z"),
    platformGatewayService: { listShops: () => [], listPlatforms: () => [] },
  }).createManual({ shopCode: "NAME-1", shopName: "Name Match", country: "TH", platform: "tiktok", shopType: "C店" });
  const directory = new CommerceShopDirectoryService({
    repository,
    now: () => new Date("2026-08-08T12:00:00.000Z"),
    platformGatewayService: {
      listShops: () => [{
        id: "connector-name-only", platformId: "tiktok-shop", shopName: "Name Match", sellerId: "seller-1",
        country: "TH", status: "active", authorization: {
          applicationId: "app-1", expiresAt: "2026-09-01T00:00:00.000Z", tokenStatus: "active",
        },
      }],
      listPlatforms: () => [{ id: "tiktok-shop", type: "tiktok-shop", status: "active", connectorRegistered: true }],
    },
  });
  const before = (await repository.list({}))[0];
  const rows = await directory.list({});
  const after = await repository.getById(before.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].directoryShopId, null);
  assert.equal(rows[0].identityIssue, null);
  assert.equal(rows[0].authorizationStatus, "AUTHORIZED");
  assert.equal(rows[0].callable, true);
  assert.equal(after.platformConnectorShopId, null);
  assert.equal(after.connectorSyncedAt, before?.connectorSyncedAt || null);
});

test("explicit directory sync adopts Platform Gateway identities and status without copying tokens", async (t) => {
  const { db, provider, repository } = fixture();
  t.after(() => provider.close());
  const connectorShops = [{
    id: "connector-api-1",
    platformId: "lazada",
    shopName: "API Shop",
    sellerId: "seller-api-1",
    country: "TH",
    region: "Thailand",
    status: "inactive",
    accessToken: "top-level-secret",
    metadata: { providerShortCode: "TH-API", accessToken: "metadata-secret", refreshToken: "refresh-secret" },
    authorization: {
      applicationId: "app-api-1",
      expiresAt: "2026-09-01T00:00:00.000Z",
      tokenStatus: "active",
      accessToken: "authorization-secret",
      refreshToken: "authorization-refresh-secret",
    },
  }];
  const directory = new CommerceShopDirectoryService({
    repository,
    now: () => new Date("2026-08-08T12:00:00.000Z"),
    platformGatewayService: {
      listShops: () => connectorShops,
      listPlatforms: () => [{ id: "lazada", status: "active", connectorRegistered: true }],
    },
  });

  const result = await directory.synchronize();
  assert.deepEqual({ source: result.source, observed: result.observed, created: result.created, rejected: result.rejected.length }, {
    source: "API", observed: 1, created: 1, rejected: 0,
  });
  const persisted = (await repository.list({}))[0];
  assert.deepEqual({
    platform: persisted.platform,
    sellerId: persisted.platformShopId,
    connectorShopId: persisted.platformConnectorShopId,
    status: persisted.status,
    source: persisted.directorySource,
  }, {
    platform: "LAZADA",
    sellerId: "seller-api-1",
    connectorShopId: "connector-api-1",
    status: "INACTIVE",
    source: "API",
  });
  assert.equal(persisted.currency, "THB");
  assert.deepEqual(persisted.sourceMetadata.currencyEvidence, {
    source: "SITE_DEFAULT",
    version: "SHOP_SITE_DEFAULT_CURRENCY_V1",
    countryCode: "TH",
    isOrderSettlementCurrency: false,
  });
  const listed = await directory.list({});
  assert.deepEqual({
    currency: listed[0].currency,
    siteDefaultCurrency: listed[0].siteDefaultCurrency,
    currencySource: listed[0].currencySource,
    currencySourceVersion: listed[0].currencySourceVersion,
    isOrderSettlementCurrency: listed[0].currencyIsOrderSettlementCurrency,
  }, {
    currency: "THB",
    siteDefaultCurrency: "THB",
    currencySource: "SITE_DEFAULT",
    currencySourceVersion: "SHOP_SITE_DEFAULT_CURRENCY_V1",
    isOrderSettlementCurrency: false,
  });
  const serialized = JSON.stringify(listed);
  assert.equal(serialized.includes("top-level-secret"), false);
  assert.equal(serialized.includes("metadata-secret"), false);
  assert.equal(serialized.includes("refresh-secret"), false);
  const persistedJson = JSON.stringify(db.prepare("SELECT * FROM commerce_shop_registry").all());
  assert.equal(persistedJson.includes("secret"), false);
});

test("Platform Gateway name candidates stay separate while the API identity remains authoritative", async (t) => {
  const { provider, repository, service } = fixture();
  t.after(() => provider.close());
  await service.synchronize({
    accountId: "foundation:account:mabang:test",
    platform: "lazada",
    shops: [{ id: 101, name: "Candidate Shop", site: "TH", shop_type: 1 }],
  });
  const directory = new CommerceShopDirectoryService({
    repository,
    now: () => new Date("2026-08-08T12:00:00.000Z"),
    platformGatewayService: {
      listShops: () => [{
        id: "connector-candidate", platformId: "lazada", shopName: "Candidate Shop",
        sellerId: "seller-candidate", country: "TH", status: "active",
        authorization: { applicationId: "app-1", expiresAt: "2026-09-01T00:00:00.000Z", tokenStatus: "active" },
      }],
      listPlatforms: () => [{ id: "lazada", status: "active", connectorRegistered: true }],
    },
  });

  const result = await directory.synchronizeFromPlatformGateway();
  assert.equal(result.created, 1);
  assert.equal(result.reviewRequired, 1);
  const persisted = await repository.list({});
  assert.equal(persisted.length, 2);
  const legacy = persisted.find((shop) => shop.providerShopId === "101");
  const api = persisted.find((shop) => shop.platformConnectorShopId === "connector-candidate");
  assert.equal(legacy.identityStatus, "REVIEW_REQUIRED");
  assert.equal(api.identityStatus, "CONFIRMED");
  const listed = await directory.list({});
  assert.equal(listed.length, 1);
  assert.equal(listed[0].directoryShopId, api.id);
  assert.equal(listed[0].authorizationStatus, "AUTHORIZED");
  assert.equal(listed[0].callable, true);
});

test("API shop list returns the 134 Connector shops, including four API-only rows and excluding nine legacy-only rows", async (t) => {
  const { provider, repository } = fixture();
  t.after(() => provider.close());
  const countries = ["MY", "TH", "PH", "SG", "VN", "ID", "TW"];
  const allConnectorShops = Array.from({ length: 134 }, (_, index) => ({
    id: `connector-${String(index + 1).padStart(3, "0")}`,
    platformId: "lazada",
    shopName: `API Authority ${index + 1}`,
    sellerId: `seller-${String(index + 1).padStart(3, "0")}`,
    country: countries[index % countries.length],
    status: "active",
    metadata: { providerShortCode: `API${String(index + 1).padStart(3, "0")}` },
    authorization: {
      applicationId: "app-authority",
      expiresAt: "2026-09-01T00:00:00.000Z",
      tokenStatus: "active",
    },
  }));
  let visibleConnectorShops = allConnectorShops.slice(0, 130);
  const directory = new CommerceShopDirectoryService({
    repository,
    now: () => new Date("2026-08-08T12:00:00.000Z"),
    platformGatewayService: {
      listShops: () => visibleConnectorShops,
      listPlatforms: () => [{ id: "lazada", status: "active", connectorRegistered: true }],
    },
  });
  await directory.synchronizeFromPlatformGateway();
  await directory.synchronize({
    source: "MANUAL",
    shops: Array.from({ length: 9 }, (_, index) => ({
      shopCode: `LEGACY-${index + 1}`,
      shopName: `Legacy Only ${index + 1}`,
      country: countries[index % countries.length],
      platform: "lazada",
    })),
  });
  assert.equal((await repository.list({})).length, 139);

  visibleConnectorShops = allConnectorShops;
  const listed = await directory.list({});
  assert.equal(listed.length, 134);
  assert.equal(listed.filter((shop) => shop.directoryShopId === null).length, 4);
  assert.equal(listed.some((shop) => String(shop.shopCode).startsWith("LEGACY-")), false);
  assert.equal(listed.every((shop) => shop.platformConnectorShopId?.startsWith("connector-")), true);
  assert.deepEqual(Object.fromEntries(countries.map((country) => {
    const row = listed.find((shop) => shop.country === country);
    return [country, [row.siteDefaultCurrency, row.currencySource, row.currencySourceVersion]];
  })), {
    MY: ["MYR", "SITE_DEFAULT", "SHOP_SITE_DEFAULT_CURRENCY_V1"],
    TH: ["THB", "SITE_DEFAULT", "SHOP_SITE_DEFAULT_CURRENCY_V1"],
    PH: ["PHP", "SITE_DEFAULT", "SHOP_SITE_DEFAULT_CURRENCY_V1"],
    SG: ["SGD", "SITE_DEFAULT", "SHOP_SITE_DEFAULT_CURRENCY_V1"],
    VN: ["VND", "SITE_DEFAULT", "SHOP_SITE_DEFAULT_CURRENCY_V1"],
    ID: ["IDR", "SITE_DEFAULT", "SHOP_SITE_DEFAULT_CURRENCY_V1"],
    TW: ["TWD", "SITE_DEFAULT", "SHOP_SITE_DEFAULT_CURRENCY_V1"],
  });
});

test("Platform Gateway identity keeps the same seller id in different countries as separate shops", async (t) => {
  const { provider, repository } = fixture();
  t.after(() => provider.close());
  const connectorShops = ["TH", "MY"].map((country) => ({
    id: `connector-shared-${country}`,
    platformId: "lazada",
    shopName: `Shared Seller ${country}`,
    sellerId: "shared-seller",
    country,
    status: "active",
    authorization: {
      applicationId: "app-shared",
      expiresAt: "2026-09-01T00:00:00.000Z",
      tokenStatus: "active",
    },
  }));
  const directory = new CommerceShopDirectoryService({
    repository,
    now: () => new Date("2026-08-08T12:00:00.000Z"),
    platformGatewayService: {
      listShops: () => connectorShops,
      listPlatforms: () => [{ id: "lazada", status: "active", connectorRegistered: true }],
    },
  });
  const result = await directory.synchronizeFromPlatformGateway();
  assert.equal(result.created, 2);
  assert.equal(result.reviewRequired, 0);
  const listed = await directory.list({});
  assert.deepEqual(listed.map((shop) => [shop.country, shop.sellerId, shop.authorizationStatus]), [
    ["TH", "shared-seller", "AUTHORIZED"],
    ["MY", "shared-seller", "AUTHORIZED"],
  ]);
});

test("API provider codes remain display-only candidates and never merge a different seller identity", async (t) => {
  const { provider, repository } = fixture();
  t.after(() => provider.close());
  let connectorShops = [];
  const directory = new CommerceShopDirectoryService({
    repository,
    now: () => new Date("2026-08-08T12:00:00.000Z"),
    platformGatewayService: {
      listShops: () => connectorShops,
      listPlatforms: () => [{ id: "lazada", status: "active", connectorRegistered: true }],
    },
  });
  await directory.createManual({
    shopCode: "PROVIDER-CODE",
    shopName: "Legacy Code Owner",
    country: "TH",
    platform: "lazada",
    sellerId: "legacy-seller",
  });
  connectorShops = [{
    id: "connector-code-candidate",
    platformId: "lazada",
    shopName: "API Code Owner",
    sellerId: "api-seller",
    country: "TH",
    status: "active",
    metadata: { providerShortCode: "PROVIDER-CODE" },
    authorization: {
      applicationId: "app-code",
      expiresAt: "2026-09-01T00:00:00.000Z",
      tokenStatus: "active",
    },
  }];

  const beforeSync = await directory.list({});
  assert.equal(beforeSync[0].shopCode, "PROVIDER-CODE");
  assert.equal(beforeSync[0].directoryShopId, null);
  const result = await directory.synchronizeFromPlatformGateway();
  assert.equal(result.created, 1);
  assert.equal(result.reviewRequired, 1);
  const persisted = await repository.list({});
  assert.equal(persisted.length, 2);
  assert.equal(persisted.find((shop) => shop.shopCode === "PROVIDER-CODE").identityStatus, "REVIEW_REQUIRED");
  const apiProjection = persisted.find((shop) => shop.platformConnectorShopId === "connector-code-candidate");
  assert.equal(apiProjection.identityStatus, "CONFIRMED");
  assert.notEqual(apiProjection.shopCode, "PROVIDER-CODE");
  const listed = await directory.list({});
  assert.equal(listed.length, 1);
  assert.equal(listed[0].directoryShopId, apiProjection.id);
  assert.equal(listed[0].shopCode, "PROVIDER-CODE");
  assert.equal(listed[0].authorizationStatus, "AUTHORIZED");
});

test("directory import never overwrites a conflicting authoritative seller id by name", async (t) => {
  const { provider, repository, service } = fixture();
  t.after(() => provider.close());
  await service.synchronize({
    accountId: "foundation:account:mabang:test",
    platform: "lazada",
    shops: [{ id: 101, name: "Alpha Mall", site: "TH", shop_type: 1 }],
  });
  const directory = new CommerceShopDirectoryService({
    repository,
    now: () => new Date("2026-08-08T12:00:00.000Z"),
    platformGatewayService: { listShops: () => [], listPlatforms: () => [] },
  });
  const first = await directory.synchronize({
    source: "SPREADSHEET",
    shops: [{ shopCode: "CONFLICT-1", shopName: "Alpha Mall", country: "TH", platform: "lazada", sellerId: "9001" }],
  });
  assert.equal(first.updated, 1);
  const result = await directory.synchronize({
    source: "SPREADSHEET",
    shops: [{ shopCode: "CONFLICT-2", shopName: "Alpha Mall", country: "TH", platform: "lazada", sellerId: "999" }],
  });
  assert.equal(result.reviewRequired, 1);
  assert.equal(result.results[0].reason, "PLATFORM_SHOP_ID_CONFLICT");
  const shops = await repository.list({});
  assert.equal(shops.length, 1);
  assert.equal(shops[0].providerShopId, "101");
  assert.equal(shops[0].platformShopId, "9001");
  assert.equal(shops[0].identityStatus, "REVIEW_REQUIRED");
  assert.equal(shops[0].sourceMetadata.identityReview.reason, "PLATFORM_SHOP_ID_CONFLICT");
  const afterRestart = new CommerceShopDirectoryService({
    repository,
    now: () => new Date("2026-08-08T12:05:00.000Z"),
    platformGatewayService: {
      listShops: () => [{
        id: "connector-9001", platformId: "lazada", shopName: "Alpha Mall", sellerId: "9001",
        country: "TH", status: "active", authorization: {
          applicationId: "app-1", expiresAt: "2026-09-01T00:00:00.000Z", tokenStatus: "active",
        },
      }],
      listPlatforms: () => [{ id: "lazada", status: "active", connectorRegistered: true }],
    },
  });
  const rows = await afterRestart.list({});
  assert.equal(rows[0].authorizationStatus, "REVIEW_REQUIRED");
  assert.equal(rows[0].callable, false);
});

test("directory-first and Mabang identities stay separated for review until a crosswalk is confirmed", async (t) => {
  const { provider, repository, service } = fixture();
  t.after(() => provider.close());
  const directory = new CommerceShopDirectoryService({
    repository,
    now: () => new Date("2026-08-08T12:00:00.000Z"),
    platformGatewayService: { listShops: () => [], listPlatforms: () => [] },
  });
  await directory.createManual({
    shopCode: "BEFORE-1", shopName: "Directory First", country: "TH", platform: "lazada", sellerId: "101",
  });
  await service.synchronize({
    accountId: "foundation:account:mabang:test",
    platform: "lazada",
    shops: [{ id: 101, name: "Directory First", site: "TH", shop_type: 1 }],
  });
  const shops = await repository.list({});
  assert.equal(shops.length, 2);
  assert.equal(shops.every((shop) => shop.identityStatus === "REVIEW_REQUIRED"), true);
  assert.equal(shops.some((shop) => shop.providerShopId === "101"), true);
  assert.equal(shops.some((shop) => shop.providerShopId === "directory:BEFORE-1"), true);
});

test("a bound Connector row cannot authorize when another persisted strong id disagrees", async (t) => {
  const { provider, repository } = fixture();
  t.after(() => provider.close());
  const directory = new CommerceShopDirectoryService({
    repository,
    now: () => new Date("2026-08-08T12:00:00.000Z"),
    platformGatewayService: {
      listShops: () => [{
        id: "connector-a", platformId: "lazada", shopName: "Strong Conflict", sellerId: "999",
        country: "TH", status: "active", authorization: {
          applicationId: "app-1", expiresAt: "2026-09-01T00:00:00.000Z", tokenStatus: "active",
        },
      }],
      listPlatforms: () => [{ id: "lazada", status: "active", connectorRegistered: true }],
    },
  });
  await directory.createManual({
    shopCode: "STRONG-1", shopName: "Strong Conflict", country: "TH", platform: "lazada", sellerId: "9001",
  });
  await repository.synchronizeConnectorProjection({
    bindings: [{
      id: (await repository.list({}))[0].id,
      connectorShopId: "connector-a",
      platformShopId: null,
      platformShortCode: null,
      reviewRequired: false,
      clearBinding: false,
    }],
    observedAt: "2026-08-08T12:01:00.000Z",
  });
  const rows = await directory.list({});
  assert.equal(rows[0].authorizationStatus, "REVIEW_REQUIRED");
  assert.equal(rows[0].callable, false);
  assert.equal(rows[0].identityIssue, "STRONG_CONNECTOR_ID_CONFLICT");
});

test("directory identity keys never rewrite a shop country", async (t) => {
  const { provider, repository } = fixture();
  t.after(() => provider.close());
  const directory = new CommerceShopDirectoryService({
    repository,
    now: () => new Date("2026-08-08T12:00:00.000Z"),
    platformGatewayService: { listShops: () => [], listPlatforms: () => [] },
  });
  await directory.createManual({
    shopCode: "COUNTRY-1", shopName: "Country Locked", country: "TH", platform: "lazada", sellerId: "7001",
  });
  const result = await directory.synchronize({
    source: "SPREADSHEET",
    shops: [{ shopCode: "COUNTRY-1", shopName: "Country Locked", country: "MY", platform: "lazada", sellerId: "7001" }],
  });
  assert.equal(result.reviewRequired, 1);
  assert.equal(result.results[0].reason, "SHOP_IDENTITY_COUNTRY_CONFLICT");
  const rows = await repository.list({});
  assert.equal(rows[0].countryCode, "TH");
  assert.equal(rows[0].identityStatus, "REVIEW_REQUIRED");
});

test("shop directory supports manual creation without platform credentials", async (t) => {
  const { provider, repository } = fixture();
  t.after(() => provider.close());
  const directory = new CommerceShopDirectoryService({
    repository,
    now: () => new Date("2026-08-08T12:00:00.000Z"),
    platformGatewayService: { listShops: () => [], listPlatforms: () => [] },
  });
  const result = await directory.createManual({
    shopCode: "MS9999",
    shopName: "New Manual Shop",
    country: "MY",
    platform: "lazada",
    shopType: "C店",
  });
  assert.equal(result.created, 1);
  const shops = await directory.list({});
  assert.equal(shops.length, 0);
  const persisted = await repository.list({});
  assert.equal(persisted[0].directorySource, "MANUAL");
});
