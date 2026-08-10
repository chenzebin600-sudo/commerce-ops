# Commerce Ops SQLite Tables 07

Snapshot date: 2026-08-05

This appendix records exact SQLite fields, keys, foreign keys, indexes, and row counts.

## product_import_field_changes

- Rows: 3
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
import_batch_id | type=TEXT | not_null=true | default=(none) | pk_order=0
import_row_id | type=TEXT | not_null=true | default=(none) | pk_order=0
product_package_row_id | type=TEXT | not_null=false | default=(none) | pk_order=0
source_row_number | type=INTEGER | not_null=true | default=(none) | pk_order=0
country_raw | type=TEXT | not_null=false | default=(none) | pk_order=0
sku_code | type=TEXT | not_null=false | default=(none) | pk_order=0
warehouse_raw | type=TEXT | not_null=false | default=(none) | pk_order=0
chinese_name | type=TEXT | not_null=false | default=(none) | pk_order=0
source_header | type=TEXT | not_null=true | default=(none) | pk_order=0
field_name | type=TEXT | not_null=true | default=(none) | pk_order=0
old_value_json | type=TEXT | not_null=false | default=(none) | pk_order=0
new_value_json | type=TEXT | not_null=false | default=(none) | pk_order=0
old_type | type=TEXT | not_null=false | default=(none) | pk_order=0
new_type | type=TEXT | not_null=false | default=(none) | pk_order=0
has_manual_override | type=INTEGER | not_null=true | default=0 | pk_order=0
changed_at | type=TEXT | not_null=true | default=(none) | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
updated_at | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- `product_package_row_id` -> `product_package_rows.id` (id=0, seq=0, on_update=NO ACTION, on_delete=RESTRICT)
- `import_row_id` -> `product_import_rows.id` (id=1, seq=0, on_update=NO ACTION, on_delete=RESTRICT)
- `import_batch_id` -> `product_import_batches.id` (id=2, seq=0, on_update=NO ACTION, on_delete=RESTRICT)

Indexes:
- `idx_product_import_field_changes_filter` (unique=false, origin=c, partial=false): [import_batch_id, country_raw, sku_code, field_name]; CREATE INDEX idx_product_import_field_changes_filter   ON product_import_field_changes(import_batch_id, country_raw, sku_code, field_name)
- `idx_product_import_field_changes_batch` (unique=false, origin=c, partial=false): [import_batch_id, source_row_number, field_name]; CREATE INDEX idx_product_import_field_changes_batch   ON product_import_field_changes(import_batch_id, source_row_number, field_name)
- `sqlite_autoindex_product_import_field_changes_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## product_import_files

- Rows: 5
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
batch_id | type=TEXT | not_null=true | default=(none) | pk_order=0
export_file_id | type=TEXT | not_null=true | default=(none) | pk_order=0
file_role | type=TEXT | not_null=true | default='source' | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- `export_file_id` -> `export_files.id` (id=0, seq=0, on_update=NO ACTION, on_delete=RESTRICT)
- `batch_id` -> `product_import_batches.id` (id=1, seq=0, on_update=NO ACTION, on_delete=RESTRICT)

Indexes:
- `sqlite_autoindex_product_import_files_3` (unique=true, origin=u, partial=false): [export_file_id]; (implicit)
- `sqlite_autoindex_product_import_files_2` (unique=true, origin=u, partial=false): [batch_id, file_role]; (implicit)
- `sqlite_autoindex_product_import_files_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## product_import_issues

- Rows: 2,153
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
batch_id | type=TEXT | not_null=true | default=(none) | pk_order=0
row_id | type=TEXT | not_null=false | default=(none) | pk_order=0
source_row_number | type=INTEGER | not_null=false | default=(none) | pk_order=0
issue_code | type=TEXT | not_null=true | default=(none) | pk_order=0
severity | type=TEXT | not_null=true | default=(none) | pk_order=0
field_code | type=TEXT | not_null=false | default=(none) | pk_order=0
current_value_json | type=TEXT | not_null=false | default=(none) | pk_order=0
suggested_value_json | type=TEXT | not_null=false | default=(none) | pk_order=0
message | type=TEXT | not_null=true | default=(none) | pk_order=0
suggestion | type=TEXT | not_null=false | default=(none) | pk_order=0
status | type=TEXT | not_null=true | default='open' | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
updated_at | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- `row_id` -> `product_import_rows.id` (id=0, seq=0, on_update=NO ACTION, on_delete=RESTRICT)
- `batch_id` -> `product_import_batches.id` (id=1, seq=0, on_update=NO ACTION, on_delete=RESTRICT)

Indexes:
- `idx_product_import_issues_batch` (unique=false, origin=c, partial=false): [batch_id, severity, status, source_row_number]; CREATE INDEX idx_product_import_issues_batch   ON product_import_issues(batch_id, severity, status, source_row_number)
- `sqlite_autoindex_product_import_issues_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## product_import_rows

- Rows: 21,981
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
batch_id | type=TEXT | not_null=true | default=(none) | pk_order=0
source_row_number | type=INTEGER | not_null=true | default=(none) | pk_order=0
source_sku | type=TEXT | not_null=false | default=(none) | pk_order=0
row_sha256 | type=TEXT | not_null=true | default=(none) | pk_order=0
raw_payload_json | type=TEXT | not_null=true | default=(none) | pk_order=0
normalized_payload_json | type=TEXT | not_null=true | default=(none) | pk_order=0
validation_codes_json | type=TEXT | not_null=true | default='[]' | pk_order=0
outcome | type=TEXT | not_null=true | default=(none) | pk_order=0
target_sku_id | type=TEXT | not_null=false | default=(none) | pk_order=0
applied_at | type=TEXT | not_null=false | default=(none) | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
source_country_raw | type=TEXT | not_null=false | default=(none) | pk_order=0
product_key | type=TEXT | not_null=false | default=(none) | pk_order=0
product_sha256 | type=TEXT | not_null=false | default=(none) | pk_order=0
source_warehouse_raw | type=TEXT | not_null=false | default=(none) | pk_order=0
source_row_key | type=TEXT | not_null=false | default=(none) | pk_order=0
row_occurrence | type=INTEGER | not_null=true | default=1 | pk_order=0
raw_types_json | type=TEXT | not_null=true | default='{}' | pk_order=0
package_row_id | type=TEXT | not_null=false | default=(none) | pk_order=0
```

Foreign keys:
- `batch_id` -> `product_import_batches.id` (id=0, seq=0, on_update=NO ACTION, on_delete=RESTRICT)

Indexes:
- `idx_product_import_rows_source_identity` (unique=false, origin=c, partial=false): [batch_id, source_row_key, source_row_number]; CREATE INDEX idx_product_import_rows_source_identity   ON product_import_rows(batch_id, source_row_key, source_row_number)
- `idx_product_import_rows_product_key` (unique=false, origin=c, partial=false): [product_key, batch_id]; CREATE INDEX idx_product_import_rows_product_key   ON product_import_rows(product_key, batch_id)
- `idx_product_import_rows_source_sku` (unique=false, origin=c, partial=false): [source_sku]; CREATE INDEX idx_product_import_rows_source_sku   ON product_import_rows(source_sku)
- `idx_product_import_rows_batch_outcome` (unique=false, origin=c, partial=false): [batch_id, outcome, source_row_number]; CREATE INDEX idx_product_import_rows_batch_outcome   ON product_import_rows(batch_id, outcome, source_row_number)
- `sqlite_autoindex_product_import_rows_2` (unique=true, origin=u, partial=false): [batch_id, source_row_number]; (implicit)
- `sqlite_autoindex_product_import_rows_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## product_inventory_snapshots

- Rows: 21,978
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
sku_id | type=TEXT | not_null=true | default=(none) | pk_order=0
batch_id | type=TEXT | not_null=true | default=(none) | pk_order=0
warehouse_raw | type=TEXT | not_null=true | default=(none) | pk_order=0
warehouse_stock | type=NUMERIC | not_null=false | default=(none) | pk_order=0
planned_warehouse_raw | type=TEXT | not_null=false | default=(none) | pk_order=0
captured_at | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- `batch_id` -> `product_import_batches.id` (id=0, seq=0, on_update=NO ACTION, on_delete=RESTRICT)
- `sku_id` -> `product_skus.id` (id=1, seq=0, on_update=NO ACTION, on_delete=RESTRICT)

Indexes:
- `idx_product_inventory_snapshots_sku` (unique=false, origin=c, partial=false): [sku_id, captured_at DESC]; CREATE INDEX idx_product_inventory_snapshots_sku   ON product_inventory_snapshots(sku_id, captured_at DESC)
- `sqlite_autoindex_product_inventory_snapshots_2` (unique=true, origin=u, partial=false): [sku_id, batch_id, warehouse_raw]; (implicit)
- `sqlite_autoindex_product_inventory_snapshots_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## product_listing_drafts

- Rows: 0
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
product_sku_id | type=TEXT | not_null=true | default=(none) | pk_order=0
country | type=TEXT | not_null=true | default=(none) | pk_order=0
sku | type=TEXT | not_null=true | default=(none) | pk_order=0
platform | type=TEXT | not_null=true | default=(none) | pk_order=0
shop_id | type=TEXT | not_null=false | default=(none) | pk_order=0
shop_key | type=TEXT | not_null=true | default=(none) | pk_order=0
shop_name | type=TEXT | not_null=false | default=(none) | pk_order=0
marketplace | type=TEXT | not_null=false | default=(none) | pk_order=0
platform_category_id | type=TEXT | not_null=false | default=(none) | pk_order=0
platform_category_name | type=TEXT | not_null=false | default=(none) | pk_order=0
listing_mode | type=TEXT | not_null=true | default='standard' | pk_order=0
title | type=TEXT | not_null=false | default=(none) | pk_order=0
subtitle | type=TEXT | not_null=false | default=(none) | pk_order=0
description | type=TEXT | not_null=false | default=(none) | pk_order=0
search_keywords_json | type=TEXT | not_null=true | default='[]' | pk_order=0
brand | type=TEXT | not_null=false | default=(none) | pk_order=0
model | type=TEXT | not_null=false | default=(none) | pk_order=0
target_users | type=TEXT | not_null=false | default=(none) | pk_order=0
content_language | type=TEXT | not_null=true | default='中文' | pk_order=0
selling_points_json | type=TEXT | not_null=true | default='[]' | pk_order=0
usage_scenarios_json | type=TEXT | not_null=true | default='[]' | pk_order=0
platform_attributes_json | type=TEXT | not_null=true | default='[]' | pk_order=0
variants_json | type=TEXT | not_null=true | default='[]' | pk_order=0
pricing_json | type=TEXT | not_null=true | default='{}' | pk_order=0
media_json | type=TEXT | not_null=true | default='{}' | pk_order=0
logistics_json | type=TEXT | not_null=true | default='{}' | pk_order=0
compliance_json | type=TEXT | not_null=true | default='{}' | pk_order=0
status | type=TEXT | not_null=true | default='draft' | pk_order=0
validation_result_json | type=TEXT | not_null=true | default='{}' | pk_order=0
revision | type=INTEGER | not_null=true | default=1 | pk_order=0
created_by | type=TEXT | not_null=true | default=(none) | pk_order=0
updated_by | type=TEXT | not_null=true | default=(none) | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
updated_at | type=TEXT | not_null=true | default=(none) | pk_order=0
deleted_at | type=TEXT | not_null=false | default=(none) | pk_order=0
country_code | type=TEXT | not_null=false | default=(none) | pk_order=0
country_name | type=TEXT | not_null=false | default=(none) | pk_order=0
marketplace_code | type=TEXT | not_null=false | default=(none) | pk_order=0
product_positioning | type=TEXT | not_null=false | default=(none) | pk_order=0
content_style | type=TEXT | not_null=false | default=(none) | pk_order=0
price_positioning | type=TEXT | not_null=false | default=(none) | pk_order=0
primary_scenarios | type=TEXT | not_null=false | default=(none) | pk_order=0
special_requirements | type=TEXT | not_null=false | default=(none) | pk_order=0
forbidden_content | type=TEXT | not_null=false | default=(none) | pk_order=0
ai_context_hash | type=TEXT | not_null=false | default=(none) | pk_order=0
ai_adoptions_json | type=TEXT | not_null=true | default='{}' | pk_order=0
```

Foreign keys:
- `product_sku_id` -> `product_skus.id` (id=0, seq=0, on_update=NO ACTION, on_delete=RESTRICT)

Indexes:
- `idx_product_listing_drafts_target` (unique=false, origin=c, partial=false): [platform, country, shop_key, status]; CREATE INDEX idx_product_listing_drafts_target   ON product_listing_drafts(platform, country, shop_key, status)
- `idx_product_listing_drafts_product` (unique=false, origin=c, partial=false): [product_sku_id, status, updated_at DESC]; CREATE INDEX idx_product_listing_drafts_product   ON product_listing_drafts(product_sku_id, status, updated_at DESC)
- `uq_product_listing_drafts_active_target` (unique=true, origin=c, partial=true): [product_sku_id, platform, country, shop_key]; CREATE UNIQUE INDEX uq_product_listing_drafts_active_target   ON product_listing_drafts(product_sku_id, platform, country, shop_key)   WHERE deleted_at IS NULL
- `sqlite_autoindex_product_listing_drafts_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## product_listing_publish_records

- Rows: 0
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
listing_draft_id | type=TEXT | not_null=true | default=(none) | pk_order=0
platform | type=TEXT | not_null=true | default=(none) | pk_order=0
shop_id | type=TEXT | not_null=false | default=(none) | pk_order=0
request_payload_json | type=TEXT | not_null=true | default='{}' | pk_order=0
response_payload_json | type=TEXT | not_null=true | default='{}' | pk_order=0
platform_product_id | type=TEXT | not_null=false | default=(none) | pk_order=0
platform_listing_id | type=TEXT | not_null=false | default=(none) | pk_order=0
publish_status | type=TEXT | not_null=true | default=(none) | pk_order=0
error_code | type=TEXT | not_null=false | default=(none) | pk_order=0
error_message | type=TEXT | not_null=false | default=(none) | pk_order=0
published_at | type=TEXT | not_null=false | default=(none) | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- `listing_draft_id` -> `product_listing_drafts.id` (id=0, seq=0, on_update=NO ACTION, on_delete=RESTRICT)

Indexes:
- `idx_product_listing_publish_records_draft` (unique=false, origin=c, partial=false): [listing_draft_id, created_at DESC]; CREATE INDEX idx_product_listing_publish_records_draft   ON product_listing_publish_records(listing_draft_id, created_at DESC)
- `sqlite_autoindex_product_listing_publish_records_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## product_media_assets

- Rows: 6,583
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
source_system | type=TEXT | not_null=true | default=(none) | pk_order=0
source_url | type=TEXT | not_null=false | default=(none) | pk_order=0
storage_file_id | type=TEXT | not_null=true | default=(none) | pk_order=0
original_filename | type=TEXT | not_null=true | default=(none) | pk_order=0
storage_filename | type=TEXT | not_null=true | default=(none) | pk_order=0
relative_path | type=TEXT | not_null=true | default=(none) | pk_order=0
sha256 | type=TEXT | not_null=true | default=(none) | pk_order=0
mime_type | type=TEXT | not_null=true | default=(none) | pk_order=0
width | type=INTEGER | not_null=true | default=(none) | pk_order=0
height | type=INTEGER | not_null=true | default=(none) | pk_order=0
file_size | type=INTEGER | not_null=true | default=(none) | pk_order=0
status | type=TEXT | not_null=true | default='available' | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
updated_at | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- none

Indexes:
- `idx_product_media_assets_status` (unique=false, origin=c, partial=false): [status, created_at DESC]; CREATE INDEX idx_product_media_assets_status    ON product_media_assets(status, created_at DESC)
- `idx_product_media_assets_source` (unique=false, origin=c, partial=false): [source_system, created_at DESC]; CREATE INDEX idx_product_media_assets_source    ON product_media_assets(source_system, created_at DESC)
- `sqlite_autoindex_product_media_assets_4` (unique=true, origin=u, partial=false): [sha256]; (implicit)
- `sqlite_autoindex_product_media_assets_3` (unique=true, origin=u, partial=false): [relative_path]; (implicit)
- `sqlite_autoindex_product_media_assets_2` (unique=true, origin=u, partial=false): [storage_file_id]; (implicit)
- `sqlite_autoindex_product_media_assets_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## product_media_links

- Rows: 33,764
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
asset_id | type=TEXT | not_null=true | default=(none) | pk_order=0
source_sku | type=TEXT | not_null=true | default=(none) | pk_order=0
source_sku_normalized | type=TEXT | not_null=true | default=(none) | pk_order=0
product_id | type=TEXT | not_null=true | default=(none) | pk_order=0
country_code | type=TEXT | not_null=true | default='' | pk_order=0
media_role | type=TEXT | not_null=true | default='gallery' | pk_order=0
mapping_status | type=TEXT | not_null=true | default='suggested' | pk_order=0
linked_at | type=TEXT | not_null=true | default=(none) | pk_order=0
linked_by | type=TEXT | not_null=true | default=(none) | pk_order=0
confirmed_at | type=TEXT | not_null=false | default=(none) | pk_order=0
confirmed_by | type=TEXT | not_null=false | default=(none) | pk_order=0
```

Foreign keys:
- `product_id` -> `product_skus.id` (id=0, seq=0, on_update=NO ACTION, on_delete=RESTRICT)
- `asset_id` -> `product_media_assets.id` (id=1, seq=0, on_update=NO ACTION, on_delete=RESTRICT)

Indexes:
- `idx_product_media_links_sku` (unique=false, origin=c, partial=false): [source_sku_normalized, country_code, mapping_status]; CREATE INDEX idx_product_media_links_sku    ON product_media_links(source_sku_normalized, country_code, mapping_status)
- `idx_product_media_links_product` (unique=false, origin=c, partial=false): [product_id, mapping_status, media_role, linked_at]; CREATE INDEX idx_product_media_links_product    ON product_media_links(product_id, mapping_status, media_role, linked_at)
- `sqlite_autoindex_product_media_links_2` (unique=true, origin=u, partial=false): [asset_id, product_id]; (implicit)
- `sqlite_autoindex_product_media_links_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## product_models

- Rows: 6,500
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
source_system | type=TEXT | not_null=true | default=(none) | pk_order=0
source_main_sku | type=TEXT | not_null=true | default=(none) | pk_order=0
category_id | type=TEXT | not_null=true | default=(none) | pk_order=0
canonical_name | type=TEXT | not_null=false | default=(none) | pk_order=0
identity_status | type=TEXT | not_null=true | default='confirmed' | pk_order=0
first_seen_batch_id | type=TEXT | not_null=true | default=(none) | pk_order=0
last_seen_batch_id | type=TEXT | not_null=true | default=(none) | pk_order=0
revision | type=INTEGER | not_null=true | default=1 | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
updated_at | type=TEXT | not_null=true | default=(none) | pk_order=0
inactive_at | type=TEXT | not_null=false | default=(none) | pk_order=0
```

Foreign keys:
- `last_seen_batch_id` -> `product_import_batches.id` (id=0, seq=0, on_update=NO ACTION, on_delete=RESTRICT)
- `first_seen_batch_id` -> `product_import_batches.id` (id=1, seq=0, on_update=NO ACTION, on_delete=RESTRICT)
- `category_id` -> `product_categories.id` (id=2, seq=0, on_update=NO ACTION, on_delete=RESTRICT)

Indexes:
- `sqlite_autoindex_product_models_2` (unique=true, origin=u, partial=false): [source_system, source_main_sku]; (implicit)
- `sqlite_autoindex_product_models_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## product_package_rows

- Rows: 21,714
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
source_system | type=TEXT | not_null=true | default='company_product_center' | pk_order=0
source_row_key | type=TEXT | not_null=true | default=(none) | pk_order=0
product_key | type=TEXT | not_null=true | default=(none) | pk_order=0
country_normalized | type=TEXT | not_null=true | default=(none) | pk_order=0
sku_normalized | type=TEXT | not_null=true | default=(none) | pk_order=0
warehouse_normalized | type=TEXT | not_null=true | default=(none) | pk_order=0
row_occurrence | type=INTEGER | not_null=true | default=(none) | pk_order=0
source_row_sha256 | type=TEXT | not_null=true | default=(none) | pk_order=0
semantic_row_sha256 | type=TEXT | not_null=true | default=(none) | pk_order=0
raw_payload_json | type=TEXT | not_null=true | default=(none) | pk_order=0
raw_types_json | type=TEXT | not_null=true | default=(none) | pk_order=0
normalized_payload_json | type=TEXT | not_null=true | default=(none) | pk_order=0
raw_source_period_json | type=TEXT | not_null=false | default=(none) | pk_order=0
raw_sku_code_json | type=TEXT | not_null=false | default=(none) | pk_order=0
raw_product_name_json | type=TEXT | not_null=false | default=(none) | pk_order=0
raw_main_sku_code_json | type=TEXT | not_null=false | default=(none) | pk_order=0
raw_country_raw_json | type=TEXT | not_null=false | default=(none) | pk_order=0
raw_category_l1_json | type=TEXT | not_null=false | default=(none) | pk_order=0
raw_category_l2_json | type=TEXT | not_null=false | default=(none) | pk_order=0
raw_source_created_date_json | type=TEXT | not_null=false | default=(none) | pk_order=0
raw_new_product_month_json | type=TEXT | not_null=false | default=(none) | pk_order=0
raw_new_product_age_months_json | type=TEXT | not_null=false | default=(none) | pk_order=0
raw_gift_raw_json | type=TEXT | not_null=false | default=(none) | pk_order=0
raw_source_status_json | type=TEXT | not_null=false | default=(none) | pk_order=0
raw_style_code_json | type=TEXT | not_null=false | default=(none) | pk_order=0
raw_style_name_json | type=TEXT | not_null=false | default=(none) | pk_order=0
raw_sales_spec_json | type=TEXT | not_null=false | default=(none) | pk_order=0
raw_item_dimensions_raw_json | type=TEXT | not_null=false | default=(none) | pk_order=0
raw_item_net_weight_g_json | type=TEXT | not_null=false | default=(none) | pk_order=0
raw_item_gross_weight_g_json | type=TEXT | not_null=false | default=(none) | pk_order=0
raw_carton_length_cm_json | type=TEXT | not_null=false | default=(none) | pk_order=0
raw_carton_width_cm_json | type=TEXT | not_null=false | default=(none) | pk_order=0
raw_carton_height_cm_json | type=TEXT | not_null=false | default=(none) | pk_order=0
raw_carton_quantity_json | type=TEXT | not_null=false | default=(none) | pk_order=0
raw_shipping_method_json | type=TEXT | not_null=false | default=(none) | pk_order=0
raw_warehouse_raw_json | type=TEXT | not_null=false | default=(none) | pk_order=0
raw_warehouse_stock_json | type=TEXT | not_null=false | default=(none) | pk_order=0
raw_planned_warehouse_raw_json | type=TEXT | not_null=false | default=(none) | pk_order=0
raw_cost_cny_json | type=TEXT | not_null=false | default=(none) | pk_order=0
raw_exchange_rate_json | type=TEXT | not_null=false | default=(none) | pk_order=0
raw_cost_local_json | type=TEXT | not_null=false | default=(none) | pk_order=0
raw_price_tier_20_json | type=TEXT | not_null=false | default=(none) | pk_order=0
raw_price_tier_25_json | type=TEXT | not_null=false | default=(none) | pk_order=0
raw_price_tier_35_json | type=TEXT | not_null=false | default=(none) | pk_order=0
raw_price_tier_45_json | type=TEXT | not_null=false | default=(none) | pk_order=0
raw_attach_rate_json | type=TEXT | not_null=false | default=(none) | pk_order=0
raw_forecast_daily_sales_json | type=TEXT | not_null=false | default=(none) | pk_order=0
import_batch_id | type=TEXT | not_null=true | default=(none) | pk_order=0
source_row_number | type=INTEGER | not_null=true | default=(none) | pk_order=0
first_seen_batch_id | type=TEXT | not_null=true | default=(none) | pk_order=0
latest_batch_id | type=TEXT | not_null=true | default=(none) | pk_order=0
latest_import_row_id | type=TEXT | not_null=true | default=(none) | pk_order=0
latest_source_row_number | type=INTEGER | not_null=true | default=(none) | pk_order=0
revision | type=INTEGER | not_null=true | default=1 | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
updated_at | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- `latest_import_row_id` -> `product_import_rows.id` (id=0, seq=0, on_update=NO ACTION, on_delete=RESTRICT)
- `latest_batch_id` -> `product_import_batches.id` (id=1, seq=0, on_update=NO ACTION, on_delete=RESTRICT)
- `import_batch_id` -> `product_import_batches.id` (id=2, seq=0, on_update=NO ACTION, on_delete=RESTRICT)
- `first_seen_batch_id` -> `product_import_batches.id` (id=3, seq=0, on_update=NO ACTION, on_delete=RESTRICT)

Indexes:
- `idx_product_package_rows_latest_batch` (unique=false, origin=c, partial=false): [latest_batch_id, latest_source_row_number]; CREATE INDEX idx_product_package_rows_latest_batch   ON product_package_rows(latest_batch_id, latest_source_row_number)
- `idx_product_package_rows_product` (unique=false, origin=c, partial=false): [country_normalized, sku_normalized, warehouse_normalized, row_occurrence]; CREATE INDEX idx_product_package_rows_product   ON product_package_rows(country_normalized, sku_normalized, warehouse_normalized, row_occurrence)
- `sqlite_autoindex_product_package_rows_2` (unique=true, origin=u, partial=false): [source_system, source_row_key]; (implicit)
- `sqlite_autoindex_product_package_rows_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

