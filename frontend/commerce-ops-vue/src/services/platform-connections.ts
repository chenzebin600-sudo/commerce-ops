import { apiJson } from "./api";

export interface PlatformRuntimeStatus {
  enabled: boolean;
  storage?: string;
  registeredConnectors: string[];
  configuredApplications: string[];
  shopCount: number;
  writesEnabled: boolean;
}

export interface CommercePlatform {
  id: string;
  name: string;
  type: string;
  apiVersion: string;
  status: string;
  connectorRegistered: boolean;
  writesEnabled: boolean;
}

export interface ShopAuthorizationMetadata {
  shopId: string;
  applicationId: string;
  credentialGroupId?: string;
  expiresAt: string;
  refreshExpiresAt?: string | null;
  tokenStatus: string;
  lastRefreshTime?: string | null;
  version?: number;
  updatedAt?: string;
}

export interface PlatformConnectionShop {
  id: string;
  directoryShopId?: string;
  platformId: string;
  shopCode?: string | null;
  shopName: string;
  sellerId: string | null;
  country: string;
  siteDefaultCurrency?: string | null;
  currencySource?: string | null;
  region?: string;
  status: string;
  managerName?: string | null;
  seniorManagerName?: string | null;
  categoryName?: string | null;
  shopType?: string;
  shopTypeLabel?: string;
  platformShortCode?: string | null;
  platformConnectorShopId?: string | null;
  identityStatus?: string;
  identityIssue?: string | null;
  authorizationStatus?: string;
  authorizationLabel?: string;
  authorizationDelegated?: boolean;
  callable?: boolean;
  authorizationSyncedAt?: string;
  metadata: Record<string, unknown>;
  authorization: ShopAuthorizationMetadata | null;
  createdAt?: string;
  updatedAt?: string;
}

export function loadPlatformRuntimeStatus(signal?: AbortSignal) {
  return apiJson<PlatformRuntimeStatus>("/api/platform/status", { signal });
}

export async function loadCommercePlatforms(signal?: AbortSignal) {
  const response = await apiJson<{ platforms: CommercePlatform[] }>("/api/platforms", { signal });
  return response.platforms || [];
}

export async function loadPlatformConnectionShops(signal?: AbortSignal) {
  const response = await apiJson<{ shops: PlatformConnectionShop[] }>("/api/platform/shops", { signal });
  return response.shops || [];
}

export function synchronizePlatformApiShops() {
  return apiJson<{
    observed: number;
    total: number;
    created: number;
    updated: number;
    reviewRequired: number;
    rejected: Array<{ connectorShopId?: string | null; reason: string }>;
  }>("/api/platform/shops/sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
}
