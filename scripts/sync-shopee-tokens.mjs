import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "../lib/env.mjs";
import { SqlitePlatformRepository } from "../connectors/persistence/sqlite-platform-repository.mjs";
import { resolveConnectorEncryptionKey } from "../connectors/security/token-cipher.mjs";
import {
  resolveShopeeTokenServiceConfig,
  ShopeeTokenServiceClient,
} from "../connectors/shopee/token-service-client.mjs";
import { ShopeeTokenSyncService } from "../connectors/shopee/token-sync-service.mjs";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
loadLocalEnv(rootDir);

const apply = process.argv.includes("--apply");
const config = resolveShopeeTokenServiceConfig(process.env);
if (!config.enabled) {
  throw new Error("SHOPEE_TOKEN_SERVICE_BASE_URL and SHOPEE_TOKEN_SERVICE_API_KEY are required");
}

const client = new ShopeeTokenServiceClient(config);
if (!apply) {
  const listing = await new ShopeeTokenSyncService({
    repository: {
      db: {},
      upsertShop() {},
    },
    client,
  }).inspect();
  console.log(JSON.stringify({ success: true, apply: false, ...listing }, null, 2));
  process.exit(0);
}

const databasePath = path.resolve(
  rootDir,
  process.env.COMMERCE_CONNECTOR_DB_PATH || process.env.LAZADA_OAUTH_DB_PATH || "storage/lazada-oauth.sqlite",
);
const repository = new SqlitePlatformRepository({
  databasePath,
  encryptionKey: resolveConnectorEncryptionKey(process.env),
});
try {
  const result = await new ShopeeTokenSyncService({ repository, client }).synchronize();
  console.log(JSON.stringify({
    success: true,
    apply: true,
    database: path.relative(rootDir, databasePath),
    owner: result.owner,
    total: result.total,
    authorizationsStored: result.authorized,
    unbound: result.unbound,
    unavailableShops: result.shops.filter((shop) => !shop.authorizationStored),
  }, null, 2));
} finally {
  repository.close();
}
