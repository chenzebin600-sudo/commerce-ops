import { apiJson, authorizedFetch } from "@/services/api";

export interface ProductImageSummary {
  status: string;
  count: number;
  primaryImageId: string | null;
  mabangCount: number;
  mabangAssetId: string | null;
}

export interface ProductSummary {
  id: string;
  sku: string;
  normalizedSku: string;
  country: string | null;
  productName: string;
  mainSku: string | null;
  styleCode: string | null;
  styleName: string | null;
  salesSpec: string | null;
  sourceStatus: string;
  lifecycleStatus: string | null;
  categoryL1: string | null;
  categoryL2: string | null;
  sourcePeriod: string | null;
  sourceFilename: string | null;
  updatedAt: string;
  deletedAt: string | null;
  operationalEligible: boolean;
  image: ProductImageSummary;
  manualOverrideCount: number;
  aiContentCount: number;
  aiContentStatus: string;
  latestChangeCount: number;
  sourceDatabaseValues: Record<string, unknown>;
  manualOverrides?: Record<string, unknown>;
}

export interface ProductTableField {
  code: string;
  label: string;
  group: "summary" | "source_database";
  sourceColumn: string | null;
}

export interface ProductTableFieldConfig {
  fields: ProductTableField[];
  visibleFields: string[];
  preferenceRevision: number;
}

export interface ProductField {
  code: string;
  label: string;
  type: "string" | "number" | "integer";
  group: string;
  groupLabel: string;
  editable: boolean;
  source: string;
}

export interface ProductInventory {
  warehouse: string;
  stock: number;
  plannedWarehouse: string | null;
}

export interface ProductOverrideEvent {
  fieldCode: string;
  previousValue: unknown;
  nextValue: unknown;
  operatorLabel: string;
  occurredAt: string;
}

export interface ProductMabangImage {
  linkId: string;
  assetId: string;
  sourceSku: string;
  countryCode: string | null;
  sourceSystem: string;
  originalFilename: string;
  mimeType: string;
  width: number;
  height: number;
  fileSize: number;
  mediaRole: string;
  mappingStatus: string;
  linkedAt: string;
  isPrimary: boolean;
}

export interface ProductDetail extends ProductSummary {
  fields: ProductField[];
  visibleFields: string[];
  fieldValues: Record<string, unknown>;
  sourceFieldValues: Record<string, unknown>;
  sourceDatabaseFields?: Array<{ code: string; label: string; value: unknown }>;
  mabangImages?: ProductMabangImage[];
  inventories?: ProductInventory[];
  overrideEvents?: ProductOverrideEvent[];
  confirmedAiContent?: {
    version?: number;
    model?: string;
    confirmedAt?: string;
    outputContent?: {
      product_summary?: string;
      selling_points?: Array<{ title: string; description: string; source_field?: string }>;
      usage_scenarios?: Array<{ scene: string; user: string; benefit: string }>;
      risk_notes?: string[];
    };
  } | null;
}

export interface ProductFilters {
  categories: Array<{ categoryL1?: string; categoryL2?: string }>;
  lifecycleStatuses: string[];
  countries: string[];
}

export interface ProductListResponse {
  products: ProductSummary[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface ProductQuery {
  page: number;
  pageSize: number;
  keyword?: string;
  country?: string;
  categoryL1?: string;
  lifecycleStatus?: string;
  deleted?: string;
}

function productParams(query: ProductQuery) {
  const params = new URLSearchParams({
    page: String(query.page),
    page_size: String(query.pageSize),
    sort_by: "updated_at",
    sort_direction: "desc",
  });
  const optional = {
    keyword: query.keyword,
    country: query.country,
    category_l1: query.categoryL1,
    lifecycle_status: query.lifecycleStatus,
    deleted: query.deleted,
  };
  for (const [key, value] of Object.entries(optional)) {
    if (value) params.set(key, value);
  }
  return params;
}

export function listProducts(query: ProductQuery) {
  return apiJson<ProductListResponse>(`/api/product-center/products?${productParams(query)}`);
}

export async function loadProductWorkspace() {
  const [filters, capabilities, tableFields] = await Promise.all([
    apiJson<{ filters: ProductFilters }>("/api/product-center/products/filters"),
    apiJson<{ permissions: Record<string, boolean> }>("/api/product-center/capabilities"),
    apiJson<ProductTableFieldConfig>("/api/product-center/products/table-fields"),
  ]);
  return { filters: filters.filters, permissions: capabilities.permissions || {}, tableFields };
}

export function saveProductTableFieldPreference(visibleFields: string[]) {
  return apiJson<{ preference: { visibleFields: string[]; revision: number } }>("/api/product-center/products/table-preferences", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ visibleFields }),
  });
}

export function loadMabangImageCapabilities() {
  return apiJson<{ permissions: Record<string, boolean> }>("/api/mabang-images/capabilities");
}

export function matchMabangProductImages() {
  return apiJson<{ result: { matchedSkus: number; matchedProducts: number; linksCreated: number; unmatchedSkus: number } }>(
    "/api/mabang-images/match-products",
    { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
  );
}

export function updateMabangImageLink(linkId: string, action: "confirm-gallery" | "confirm-primary" | "reject") {
  return apiJson<{ link: Record<string, unknown> }>(`/api/mabang-images/links/${encodeURIComponent(linkId)}/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

export async function uploadMabangProductImage(productId: string, file: File) {
  const response = await authorizedFetch(`/api/mabang-images/products/${encodeURIComponent(productId)}/assets`, {
    method: "POST",
    headers: {
      "content-type": file.type,
      "x-file-name": encodeURIComponent(file.name),
    },
    body: file,
  });
  const payload = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(payload.error || `图片上传失败 (${response.status})`);
  return payload;
}

export async function getProduct(id: string) {
  const response = await apiJson<{ product: ProductDetail }>(`/api/product-center/products/${encodeURIComponent(id)}`);
  return response.product;
}

export function updateProduct(id: string, fields: Record<string, unknown>, clearFields: string[]) {
  return apiJson<{ product: ProductSummary }>(`/api/product-center/products/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fields, clearFields }),
  });
}

export function deleteProduct(id: string, reason: string) {
  return apiJson<{ product: ProductSummary }>(`/api/product-center/products/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason }),
  });
}

export function restoreProduct(id: string) {
  return apiJson<{ product: ProductSummary }>(`/api/product-center/products/${encodeURIComponent(id)}/restore`, {
    method: "POST",
  });
}

const mabangAssetBlobCache = new Map<string, Promise<Blob>>();
const mabangAssetBlobCacheLimit = 80;

async function loadMabangAssetBlob(assetId: string) {
  const cached = mabangAssetBlobCache.get(assetId);
  if (cached) {
    mabangAssetBlobCache.delete(assetId);
    mabangAssetBlobCache.set(assetId, cached);
    return cached;
  }
  const pending = authorizedFetch(`/api/mabang-images/assets/${encodeURIComponent(assetId)}/content`)
    .then(async (response) => {
      if (!response.ok) throw new Error(`图片加载失败 (${response.status})`);
      return response.blob();
    })
    .catch((error) => {
      mabangAssetBlobCache.delete(assetId);
      throw error;
    });
  mabangAssetBlobCache.set(assetId, pending);
  while (mabangAssetBlobCache.size > mabangAssetBlobCacheLimit) {
    mabangAssetBlobCache.delete(mabangAssetBlobCache.keys().next().value as string);
  }
  return pending;
}

export async function loadMabangAssetUrl(assetId: string) {
  return URL.createObjectURL(await loadMabangAssetBlob(assetId));
}
