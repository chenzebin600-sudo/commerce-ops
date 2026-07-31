import { apiJson } from "@/services/api";

const BASE = "/api/mabang-listing";

export interface ListingSession {
  connected: boolean;
  username: string;
  account_host: string;
  connected_at: string;
}

export interface ListingShop {
  id: string | number;
  name: string;
  site: string;
  currency?: string;
  shop_type?: string | number;
}

export interface ListingPlatformState {
  key: string;
  label: string;
  count?: number;
  count_field?: string;
}

export interface ListingPlatform {
  key: string;
  name: string;
  states: ListingPlatformState[];
  shops?: ListingShop[];
  write_enabled?: boolean;
  write_fields?: string[];
  write_note?: string;
  shop_count?: number;
  listing_count?: number;
}

export interface WarehouseStock {
  stock?: number | string;
  location_id?: string | number;
  warehouse_id?: string | number;
  warehouse_code?: string;
  warehouse_name?: string;
  _warehouse_name?: string;
  code?: string;
  name?: string;
}

export interface ListingVariant {
  variant_id: string | number;
  sku: string;
  stock_sku: string;
  price: string | number;
  sale_price: string | number;
  stock: string | number;
  warehouse_stock: WarehouseStock[];
  supply_price: string | number;
  specification_name?: string;
  specification_value?: string;
  variation_name?: string;
  variation_value?: string;
  properties?: Record<string, unknown> | Array<Record<string, unknown>>;
}

export interface ListingItem {
  platform: string;
  platform_name: string;
  state: string;
  internal_id: string | number;
  product_id: string | number;
  product_url: string;
  title: string;
  parent_sku: string;
  currency: string;
  image: string;
  shop_id: string | number;
  shop_name: string;
  site: string;
  category_id: string | number;
  create_time: string;
  update_time: string;
  publish_time: string;
  variants: ListingVariant[];
}

export interface ListingPage {
  items: ListingItem[];
  page: number;
  page_size: number;
  total: number;
  totals: Record<string, number | string>;
  fetched_at: string;
  cached?: boolean;
}

export interface AiStatus {
  provider: "deepseek" | string;
  configured: boolean;
  base_url: string;
  model: string;
  phase: string;
  execution_allowed: boolean;
}

export interface BatchOperation {
  id: string;
  field: string;
  mode: string;
  value: string;
  spec_name: string;
  warehouse_key: string;
}

export interface WarehouseOption {
  key: string;
  label: string;
  matched_variations: number;
  available_for_all: boolean;
  stock_min: number;
  stock_max: number;
}

export interface PreviewChange {
  change_id: string;
  platform: string;
  internal_id: string;
  product_id: string;
  shop_name: string;
  title: string;
  variation_key: string;
  sku_id: string;
  sku: string;
  requested_sku: string;
  matched_sku: string;
  sku_match_type: "exact" | "virtual" | "all";
  virtual_suffix: string;
  field: string;
  spec_name?: string;
  warehouse_key?: string;
  warehouse_label?: string;
  warehouse_managed?: boolean;
  field_label: string;
  old_value: string | number;
  new_value: string | number;
  affected_skus?: string[];
  source_command_index?: number;
}

export interface BatchPreview {
  preview_token: string;
  created_at: string;
  expires_in_seconds: number;
  target_count: number;
  change_count: number;
  virtual_sku_count: number;
  command_count: number;
  match_sku: string;
  changes: PreviewChange[];
  warnings: string[];
  capability_note: string;
}

export interface JobResult {
  platform: string;
  internal_id: string;
  product_id: string;
  shop_name: string;
  title: string;
  status: "submitting" | "verifying" | "success" | "failed";
  message: string;
  verified_changes: number;
  feedback_source?: "mabang_batch_status" | "detail_readback" | "";
  mabang_batch_id?: string;
  mabang_status?: "submitting" | "accepted" | "success" | "failed";
  verification_status?: "pending" | "verified" | "pending_refresh" | "failed";
}

export interface BatchJob {
  job_id: string;
  state: "queued" | "running" | "completed" | "partial" | "failed";
  message: string;
  created_at: string;
  updated_at: string;
  total_products: number;
  submitted_products: number;
  processed_products: number;
  successful_products: number;
  failed_products: number;
  change_count: number;
  results: JobResult[];
}

export interface AiParsedCommand {
  action: "price_update" | "promotion_update" | "stock_update" | "sku_replace" | "variation_update" | "unsupported";
  target: { sku: string; parent_sku: string; category: string };
  scope: { platforms: string[]; countries: string[]; shop_ids: string[]; shop_names: string[]; categories: string[] };
  operation: { field: string; mode: string; value: unknown; unit: string };
  need_confirm: true;
  risks: string[];
  clarifications: string[];
  confidence: number;
}

export interface AiIntentPreview {
  phase: "AI_PARSE_ONLY";
  operation_type: string;
  risk_level: "low" | "medium" | "high";
  ready_for_scope_query: boolean;
  execution_allowed: false;
}

export interface AiResolvedScope {
  platform: string;
  countries: string[];
  shops: Array<{ id: string; name: string; site: string }>;
  sku: string;
  parent_sku: string;
  category_ids: string[];
}

export interface AiPreviewResult {
  provider?: AiStatus;
  command: AiParsedCommand;
  commands?: AiParsedCommand[];
  intent_preview: AiIntentPreview;
  intent_previews?: AiIntentPreview[];
  resolved_scope: AiResolvedScope;
  resolved_scopes?: AiResolvedScope[];
  batch_preview: BatchPreview;
  warehouse_selection_required?: boolean;
}

export interface BatchTarget {
  platform: string;
  internal_id: string | number;
  product_id: string | number;
  shop_name: string;
  title: string;
}

export type BatchTargetScope =
  | { targets: BatchTarget[] }
  | { target_query: { platform: string; state: string; shop_ids: string[]; search_type: string; search_value: string } };

export interface PublisherDraftVariant {
  id?: string | number;
  sku: string;
  specification_name: string;
  specification_value: string;
  price: string | number;
  special_price?: string | number;
  stock: string | number;
  product_sku_id?: string | number;
  properties?: Record<string, unknown>;
  images?: string[];
  warehouse_stock?: WarehouseStock[];
}

export interface PublisherDraftAsset { id?: string | number; url: string }

export interface PublisherDraft {
  id: string;
  platform: string;
  shop_id: string | number;
  shop_name: string;
  site: string;
  title: string;
  category_id: string | number;
  category_name?: string;
  brand?: string;
  brand_id?: string | number;
  brand_name?: string;
  description: string;
  attributes?: Record<string, unknown>;
  extended?: Record<string, unknown>;
  weight?: string | number;
  package_length?: string | number;
  package_width?: string | number;
  package_height?: string | number;
  status: string;
  version: number;
  confirmed_version?: number;
  mabang_task_id?: string | number;
  last_error?: string;
  updated_at: string;
  variants: PublisherDraftVariant[];
  assets: PublisherDraftAsset[];
}

export interface ProductModelVariant {
  productSkuId: string;
  sku: string;
  productName: string;
  salesSpec: string | null;
  country: string | null;
  stock: number;
  priceTier20: number | null;
  priceTier25: number | null;
  priceTier35: number | null;
  weightG: number | null;
  packageLengthCm: number | null;
  packageWidthCm: number | null;
  packageHeightCm: number | null;
  externalImageUrl: string | null;
}

export interface ProductModel {
  id: string;
  mainSku: string;
  name: string;
  categoryL1: string | null;
  categoryL2: string | null;
  variantCount: number;
  countryCount: number;
  variants: ProductModelVariant[];
}

export function loadListingHealth() {
  return apiJson<{ session: ListingSession; ai?: AiStatus }>(`${BASE}/health`);
}

export function loginListing(username: string, password: string) {
  return apiJson<{ session: ListingSession }>(`${BASE}/session/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password, account_host: "900445.private.mabangerp.com" }),
  });
}

export function logoutListing() {
  return apiJson(`${BASE}/session`, { method: "DELETE" });
}

export function loadListingPlatforms() {
  return apiJson<{ session: ListingSession; platforms: ListingPlatform[] }>(`${BASE}/platforms`);
}

export function loadAiStatus() {
  return apiJson<{ ai: AiStatus }>(`${BASE}/ai/status`);
}

export function loadListingShops(platform: string) {
  return apiJson<{ shops: ListingShop[] }>(`${BASE}/shops?platform=${encodeURIComponent(platform)}`);
}

export function loadListings(input: { platform: string; state: string; page: number; pageSize: number; query?: string; searchType?: string; shopIds?: string[]; refresh?: boolean }) {
  const params = new URLSearchParams({
    platform: input.platform,
    state: input.state,
    page: String(input.page),
    page_size: String(input.pageSize),
  });
  if (input.query) {
    params.set("search_type", input.searchType || "title");
    params.set("search_value", input.query);
  }
  if (input.shopIds?.length) params.set("shop_id", input.shopIds.join(","));
  if (input.refresh) params.set("refresh", "1");
  return apiJson<ListingPage>(`${BASE}/listings?${params}`);
}

function postJson<T>(path: string, payload: unknown) {
  return apiJson<T>(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function createAiPreview(command: string, activePlatform: string) {
  return postJson<AiPreviewResult>("/ai/preview", { command, active_platform: activePlatform });
}

export function loadWarehouseOptions(scope: BatchTargetScope, matchSku: string) {
  return postJson<{ warehouses: WarehouseOption[]; recommended_warehouse_key: string; target_count: number; matched_variation_count: number }>(
    "/batch/warehouse-options",
    { ...scope, match_sku: matchSku },
  );
}

export function createBatchPreview(scope: BatchTargetScope, matchSku: string, operations: BatchOperation[]) {
  return postJson<BatchPreview>("/batch/preview", {
    ...scope,
    match_sku: matchSku,
    operations: operations.map(({ field, mode, value, spec_name, warehouse_key }) => ({ field, mode, value, spec_name, warehouse_key })),
  });
}

export function executeBatchPreview(previewToken: string, selectedChangeIds: string[]) {
  return postJson<BatchJob>("/batch/execute", { preview_token: previewToken, selected_change_ids: selectedChangeIds });
}

export function loadBatchJob(jobId: string) {
  return apiJson<BatchJob>(`${BASE}/jobs/${encodeURIComponent(jobId)}`);
}

export function loadPublisherDrafts() {
  return apiJson<{ drafts: PublisherDraft[] }>(`${BASE}/publisher/drafts?limit=100`);
}

export function loadPublisherEvents(draftId: string) {
  return apiJson<{ events: Array<{ id: number; event_type: string; status: string; message: string; created_at: string }> }>(
    `${BASE}/publisher/drafts/${encodeURIComponent(draftId)}/events`,
  );
}

export function createPublisherDraft(payload: Partial<PublisherDraft>) {
  return postJson<{ draft: PublisherDraft }>("/publisher/drafts", payload);
}

export function updatePublisherDraft(draftId: string, payload: Partial<PublisherDraft>) {
  return postJson<{ draft: PublisherDraft }>(`/publisher/drafts/${encodeURIComponent(draftId)}/update`, payload);
}

export function createDraftFromListing(listing: ListingItem) {
  return postJson<{ draft: PublisherDraft }>("/publisher/drafts/from-listing", {
    platform: listing.platform,
    internal_id: listing.internal_id,
    listing_hint: listing,
  });
}

export function runPublisherAction(draftId: string, action: "clone" | "validate" | "save-to-mabang" | "confirm" | "publish", payload: Record<string, unknown> = {}) {
  return postJson<Record<string, unknown>>(`/publisher/drafts/${encodeURIComponent(draftId)}/${action}`, payload);
}

export function refreshPublisherJob(jobId: string) {
  return postJson<{ draft: PublisherDraft; job: Record<string, unknown>; listing: Record<string, unknown> | null }>(
    `/publisher/jobs/${encodeURIComponent(jobId)}/refresh`,
    {},
  );
}

export function generatePublisherAiMaterial(prompt: string) {
  return postJson<{ material: Record<string, unknown> }>("/publisher/ai/generate", { prompt });
}

export function loadPublisherCategories(input: { shopId: string | number; site: string; parentId?: string | number; query?: string }) {
  const params = new URLSearchParams({
    platform: "lazada",
    shop_id: String(input.shopId),
    site: input.site,
    parent_id: String(input.parentId ?? -1),
  });
  if (input.query) params.set("q", input.query);
  return apiJson<{ categories: Array<Record<string, unknown>> }>(`${BASE}/publisher/categories?${params}`);
}

export function loadPublisherCategorySchema(site: string, categoryId: string | number) {
  const params = new URLSearchParams({ platform: "lazada", site, category_id: String(categoryId) });
  return apiJson<{ schema: Record<string, unknown> }>(`${BASE}/publisher/category-schema?${params}`);
}

export function loadProductModels(query: string) {
  const params = new URLSearchParams({ keyword: query.trim(), page: "1", page_size: "12" });
  return apiJson<{ models: ProductModel[] }>(`/api/product-center/product-models?${params}`);
}
