import { apiJson } from "@/services/api";

const BASE = "/api/mabang-listing";

export interface ListingSession { connected: boolean; username: string; account_host: string; connected_at: string }
export interface ListingShop { id: string | number; name: string; site: string; currency?: string }
export interface ListingPlatform { key: string; name: string; states: Array<{ key: string; label: string; count?: number; count_field?: string }>; shops?: ListingShop[]; write_enabled?: boolean; listing_count?: number }
export interface ListingVariant { sku: string; stock_sku: string; price: string | number; sale_price: string | number; stock: string | number }
export interface ListingItem {
  platform: string; platform_name: string; state: string; internal_id: string | number; product_id: string | number; product_url: string;
  title: string; parent_sku: string; currency: string; image: string; shop_id: string | number; shop_name: string; site: string;
  category_id: string | number; create_time: string; update_time: string; publish_time: string; variants: ListingVariant[];
}

export function loadListingHealth() { return apiJson<{ session: ListingSession }>(`${BASE}/health`); }
export function loginListing(username: string, password: string) {
  return apiJson<{ session: ListingSession }>(`${BASE}/session/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password, account_host: "900445.private.mabangerp.com" }) });
}
export function logoutListing() { return apiJson(`${BASE}/session`, { method: "DELETE" }); }
export function loadListingPlatforms() { return apiJson<{ session: ListingSession; platforms: ListingPlatform[] }>(`${BASE}/platforms`); }
export function loadListingShops(platform: string) { return apiJson<{ shops: ListingShop[] }>(`${BASE}/shops?platform=${encodeURIComponent(platform)}`); }
export function loadListings(input: { platform: string; state: string; page: number; pageSize: number; query?: string; searchType?: string; shopIds?: string[] }) {
  const params = new URLSearchParams({ platform: input.platform, state: input.state, page: String(input.page), page_size: String(input.pageSize) });
  if (input.query) { params.set("search_type", input.searchType || "title"); params.set("search_value", input.query); }
  if (input.shopIds?.length) params.set("shop_id", input.shopIds.join(","));
  return apiJson<{ items: ListingItem[]; page: number; page_size: number; total: number; totals: Record<string, number>; fetched_at: string; cached?: boolean }>(`${BASE}/listings?${params}`);
}
