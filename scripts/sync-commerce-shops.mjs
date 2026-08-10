import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "../lib/env.mjs";
import { openProviderRuntimeDataAccess } from "../lib/data/provider-runtime-data-access.mjs";
import { resolveMabangListingProxyConfig, MABANG_LISTING_INTERNAL_HEADER } from "../lib/mabang-listing-proxy.mjs";
import { resolveMabangListingInternalToken } from "../lib/mabang-listing-token.mjs";
import { resolveRuntimeConfig } from "../lib/runtime-config.mjs";
import { createOperationAuditService } from "../lib/security/audit-service.mjs";
import { CommerceShopRegistryService } from "../lib/shops/commerce-shop-registry-service.mjs";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
loadLocalEnv(rootDir);

function argument(name) {
  const prefix = `--${name}=`;
  const raw = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return raw ? raw.slice(prefix.length).trim() : "";
}

async function upstreamJson(baseUrl, token, pathname) {
  const response = await fetch(new URL(pathname, baseUrl), {
    headers: { [MABANG_LISTING_INTERNAL_HEADER]: token, accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.success === false) {
    const error = new Error(String(body?.message || `Mabang Listing returned HTTP ${response.status}`));
    error.code = "MABANG_LISTING_SHOP_SYNC_FAILED";
    throw error;
  }
  return body;
}

const accountId = argument("account-id");
const actor = argument("actor") || "commerce-shop-sync";
const apply = process.argv.includes("--apply");
if (!accountId) throw new Error("--account-id is required");
if (!apply) throw new Error("Shop synchronization is write-enabled only with explicit --apply");

const runtimeConfig = resolveRuntimeConfig({ bootstrapRoot: rootDir, env: process.env });
const proxyConfig = resolveMabangListingProxyConfig({
  MABANG_LISTING_BASE_URL: runtimeConfig.mabangListingBaseUrl,
  MABANG_LISTING_HOST: runtimeConfig.mabangListingHost,
  MABANG_LISTING_PORT: runtimeConfig.mabangListingPort,
});
const token = await resolveMabangListingInternalToken({
  configuredToken: process.env.MABANG_LISTING_INTERNAL_TOKEN,
  tokenFile: runtimeConfig.mabangListingTokenFile,
});
const platformResponse = await upstreamJson(proxyConfig.baseUrl, token, "/api/platforms");
if (!platformResponse?.session?.connected) throw new Error("Mabang Listing session is not connected");

const platforms = (platformResponse.platforms || []).filter((item) =>
  ["lazada", "shopee", "tiktokshop"].includes(String(item?.key || "").toLowerCase()));
const liveScopes = [];
for (const platform of platforms) {
  const key = String(platform.key).toLowerCase();
  const response = await upstreamJson(proxyConfig.baseUrl, token, `/api/shops?platform=${encodeURIComponent(key)}`);
  liveScopes.push({ key, shops: response.shops || [], capabilities: platform.write_fields || [] });
}

const dataAccess = openProviderRuntimeDataAccess({
  rootDir: runtimeConfig.appRoot,
  databasePath: runtimeConfig.databasePath,
  env: process.env,
});
const service = new CommerceShopRegistryService({ repository: dataAccess.repositories.commerceShops });
const audit = createOperationAuditService({ repository: dataAccess.repositories.audit, env: process.env });
const results = [];
try {
  for (const scope of liveScopes) {
    results.push(await service.synchronize({
      accountId,
      sourceSystem: "mabang",
      platform: scope.key,
      shops: scope.shops,
      capabilities: scope.capabilities,
    }));
  }
  const totals = results.reduce((acc, item) => ({
    rows: acc.rows + item.seen,
    created: acc.created + item.inserted,
    updated: acc.updated + item.updated,
    linked: acc.linked + item.linkedGrowthShops,
    rejected: acc.rejected + item.rejected.length,
    deactivated: acc.deactivated + item.deactivated,
  }), { rows: 0, created: 0, updated: 0, linked: 0, rejected: 0, deactivated: 0 });
  await audit.recordSafely({
    module: "price_control",
    action: "product.price_control.shops.synchronized",
    status: "success",
    actorType: "service",
    actorIdentifier: actor,
    metadata: {
      accountId,
      provider: "mabang_listing",
      rowCount: totals.rows,
      createdCount: totals.created,
      updatedCount: totals.updated,
      ignoredCount: totals.rejected,
    },
  });
  console.log(JSON.stringify({ success: true, accountId, results, totals }, null, 2));
} catch (error) {
  await audit.recordSafely({
    module: "price_control",
    action: "product.price_control.shops.synchronized",
    status: "failed",
    actorType: "service",
    actorIdentifier: actor,
    errorStage: "shop_registry_sync",
    errorCode: error?.code || "COMMERCE_SHOP_SYNC_FAILED",
    errorSummary: error,
    metadata: { accountId, provider: "mabang_listing" },
  });
  throw error;
} finally {
  await dataAccess.close();
}
