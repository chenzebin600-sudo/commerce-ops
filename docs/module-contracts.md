# Commerce Ops Module Contracts

## Boundary rules

- Stable module IDs are defined in `lib/contracts/module-ids.mjs`.
- New operations use UUID identifiers for `request_id`, `task_id`, `run_id`, `file_id`, `analysis_id`, and `job_id`. Existing IDs are never rewritten.
- Missing historical links remain `null`; the system must not invent relationships.
- Every contract accepts general JavaScript values. Persistence format belongs to the database adapter.
- `confidence` is optional, ranges from `0` to `1`, and describes mapping confidence rather than business quality.
- Validation errors use a stable code and bounded message. A failed downstream handoff must not modify the source record.

## Contract matrix

| Flow | Source -> target | Required fields | Optional fields | Current support | Future node |
|---|---|---|---|---|---|
| Keyword result -> competitor link | `competitor_keyword` -> `competitor_link` | `request_id`, `platform`, `country`, `keyword`, `listing_url` | `search_rank`, `sold_text`, `sold_value`, `confidence`, `source_url` | Partial: the current discovery response can feed link extraction in one request, but results are not persisted | F2 |
| Mabang SKU -> competitor search | `mabang_inventory` -> `competitor_keyword` | `request_id`, `mabang_sku`, `platform`, `country` | `product_name`, `description`, `image_file_id`, `confidence` | Not connected | F2 |
| Advertising record -> listing/SKU | `advertising` -> `competitor_link` | `request_id`, `platform`, `advertising_record_id` | `listing_id`, `listing_url`, `platform_sku_id`, `mabang_sku`, `confidence` | Partial: uploaded reports expose promoted link IDs, but no canonical listing/SKU mapping exists | F2 |
| Advertising anomaly -> todo | `advertising` -> `operation_tasks` (future) | `request_id`, `advertising_record_id`, `anomaly_code`, `severity` | `listing_id`, `evidence`, `suggestion`, `confidence` | Not connected; operation audit is not a todo store | F3 |
| Inventory -> advertising suggestion | `mabang_inventory` -> `advertising` | `request_id`, `mabang_sku`, `available_quantity`, `observed_at` | `listing_id`, `days_of_supply`, `suggestion`, `confidence` | Not connected | F3 |
| Competitor result -> opportunity | `competitor_link` -> `opportunity_products` (future) | `request_id`, `analysis_id`, `platform`, `country` | `listing_ids`, `opportunity_score`, `evidence`, `confidence` | Not connected | F3 |
| Opportunity -> listing task | `opportunity_products` -> `listing_tasks` (future) | `request_id`, `opportunity_id`, `platform`, `country` | `shop_id`, `product_id`, `sku_ids`, `priority`, `confidence` | Not connected | F4 |

## Accuracy caveats

1. Keyword TOP5 reflects the current search-page extraction order and is not guaranteed to be a true platform sales ranking.
2. Current image analysis is text-model reasoning over links and structured data, not real pixel-level vision analysis.
3. Advertising data currently comes mainly from uploaded Lazada Excel files.
4. Mabang SKU to platform listing/SKU mapping is incomplete.

## Advertising HTTP protocol

Managed mode uses `browser -> Commerce Ops /api/ads/* -> loopback advertising service`. The main service validates the user Bearer token and forwards only its internal service token. `x-request-id` is forwarded unchanged and returned as `request_id` in new advertising analysis/chat payloads. No token or request ID is carried in a URL.

External mode remains an independent advertising service with its existing access policy. Both modes use the same advertising AI result contract: `success`, `requestId`, `provider`, `model`, `content`, `usage`, `durationMs`, `errorCode`, and `errorMessage`. Existing browser response fields remain compatible.

## API response compatibility

New common endpoints may use `{ success, data, request_id, error }`. Pagination is nested under `data.pagination`; asynchronous operations expose `task_id`, `run_id`, and `status`. Existing endpoints keep their legacy fields such as `ok`, `jobId`, and `analysis`; additive fields must not break current pages.
