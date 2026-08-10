# Commerce Ops SQLite Tables 06

Snapshot date: 2026-08-05

This appendix records exact SQLite fields, keys, foreign keys, indexes, and row counts.

## product_ai_contents

- Rows: 0
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
product_sku_id | type=TEXT | not_null=true | default=(none) | pk_order=0
country | type=TEXT | not_null=true | default=(none) | pk_order=0
sku | type=TEXT | not_null=true | default=(none) | pk_order=0
provider | type=TEXT | not_null=true | default=(none) | pk_order=0
model | type=TEXT | not_null=true | default=(none) | pk_order=0
content_type | type=TEXT | not_null=true | default='selling_points_and_scenarios' | pk_order=0
input_context_json | type=TEXT | not_null=true | default=(none) | pk_order=0
output_content_json | type=TEXT | not_null=true | default=(none) | pk_order=0
prompt_version | type=TEXT | not_null=true | default=(none) | pk_order=0
status | type=TEXT | not_null=true | default=(none) | pk_order=0
version | type=INTEGER | not_null=true | default=(none) | pk_order=0
created_by | type=TEXT | not_null=true | default=(none) | pk_order=0
request_id | type=TEXT | not_null=false | default=(none) | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
updated_at | type=TEXT | not_null=true | default=(none) | pk_order=0
confirmed_at | type=TEXT | not_null=false | default=(none) | pk_order=0
confirmed_by | type=TEXT | not_null=false | default=(none) | pk_order=0
archived_at | type=TEXT | not_null=false | default=(none) | pk_order=0
listing_draft_id | type=TEXT | not_null=false | default=(none) | pk_order=0
platform | type=TEXT | not_null=false | default=(none) | pk_order=0
shop_name | type=TEXT | not_null=false | default=(none) | pk_order=0
context_hash | type=TEXT | not_null=false | default=(none) | pk_order=0
previous_content_id | type=TEXT | not_null=false | default=(none) | pk_order=0
adopted_at | type=TEXT | not_null=false | default=(none) | pk_order=0
adopted_by | type=TEXT | not_null=false | default=(none) | pk_order=0
adopted_content_json | type=TEXT | not_null=false | default=(none) | pk_order=0
is_manually_modified | type=INTEGER | not_null=true | default=0 | pk_order=0
manual_content_json | type=TEXT | not_null=false | default=(none) | pk_order=0
```

Foreign keys:
- `product_sku_id` -> `product_skus.id` (id=0, seq=0, on_update=NO ACTION, on_delete=RESTRICT)

Indexes:
- `idx_product_ai_contents_context` (unique=false, origin=c, partial=false): [product_sku_id, context_hash, created_at DESC]; CREATE INDEX idx_product_ai_contents_context   ON product_ai_contents(product_sku_id, context_hash, created_at DESC)
- `idx_product_ai_contents_listing_type` (unique=false, origin=c, partial=false): [listing_draft_id, content_type, created_at DESC]; CREATE INDEX idx_product_ai_contents_listing_type   ON product_ai_contents(listing_draft_id, content_type, created_at DESC)
- `idx_product_ai_contents_country_sku` (unique=false, origin=c, partial=false): [country, sku, status, updated_at DESC]; CREATE INDEX idx_product_ai_contents_country_sku   ON product_ai_contents(country, sku, status, updated_at DESC)
- `idx_product_ai_contents_product_status` (unique=false, origin=c, partial=false): [product_sku_id, content_type, status, version DESC]; CREATE INDEX idx_product_ai_contents_product_status   ON product_ai_contents(product_sku_id, content_type, status, version DESC)
- `sqlite_autoindex_product_ai_contents_2` (unique=true, origin=u, partial=false): [product_sku_id, content_type, version]; (implicit)
- `sqlite_autoindex_product_ai_contents_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## product_categories

- Rows: 78
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
parent_id | type=TEXT | not_null=false | default=(none) | pk_order=0
parent_key | type=TEXT | not_null=true | default=(none) | pk_order=0
level | type=INTEGER | not_null=true | default=(none) | pk_order=0
source_system | type=TEXT | not_null=true | default=(none) | pk_order=0
source_name | type=TEXT | not_null=true | default=(none) | pk_order=0
normalized_name | type=TEXT | not_null=true | default=(none) | pk_order=0
status | type=TEXT | not_null=true | default='active' | pk_order=0
first_seen_batch_id | type=TEXT | not_null=true | default=(none) | pk_order=0
last_seen_batch_id | type=TEXT | not_null=true | default=(none) | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
updated_at | type=TEXT | not_null=true | default=(none) | pk_order=0
inactive_at | type=TEXT | not_null=false | default=(none) | pk_order=0
```

Foreign keys:
- `last_seen_batch_id` -> `product_import_batches.id` (id=0, seq=0, on_update=NO ACTION, on_delete=RESTRICT)
- `first_seen_batch_id` -> `product_import_batches.id` (id=1, seq=0, on_update=NO ACTION, on_delete=RESTRICT)
- `parent_id` -> `product_categories.id` (id=2, seq=0, on_update=NO ACTION, on_delete=RESTRICT)

Indexes:
- `idx_product_categories_parent` (unique=false, origin=c, partial=false): [parent_id, status, normalized_name]; CREATE INDEX idx_product_categories_parent   ON product_categories(parent_id, status, normalized_name)
- `sqlite_autoindex_product_categories_2` (unique=true, origin=u, partial=false): [source_system, level, parent_key, normalized_name]; (implicit)
- `sqlite_autoindex_product_categories_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## product_cost_snapshots

- Rows: 18,602
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
sku_id | type=TEXT | not_null=true | default=(none) | pk_order=0
batch_id | type=TEXT | not_null=true | default=(none) | pk_order=0
country_raw | type=TEXT | not_null=false | default=(none) | pk_order=0
cost_cny | type=NUMERIC | not_null=true | default=(none) | pk_order=0
exchange_rate | type=NUMERIC | not_null=true | default=(none) | pk_order=0
exchange_direction | type=TEXT | not_null=true | default=(none) | pk_order=0
cost_local | type=NUMERIC | not_null=true | default=(none) | pk_order=0
price_tier_20 | type=NUMERIC | not_null=false | default=(none) | pk_order=0
price_tier_25 | type=NUMERIC | not_null=false | default=(none) | pk_order=0
price_tier_35 | type=NUMERIC | not_null=false | default=(none) | pk_order=0
price_tier_45 | type=NUMERIC | not_null=false | default=(none) | pk_order=0
attach_rate | type=NUMERIC | not_null=false | default=(none) | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- `batch_id` -> `product_import_batches.id` (id=0, seq=0, on_update=NO ACTION, on_delete=RESTRICT)
- `sku_id` -> `product_skus.id` (id=1, seq=0, on_update=NO ACTION, on_delete=RESTRICT)

Indexes:
- `idx_product_cost_snapshots_sku` (unique=false, origin=c, partial=false): [sku_id, created_at DESC]; CREATE INDEX idx_product_cost_snapshots_sku   ON product_cost_snapshots(sku_id, created_at DESC)
- `sqlite_autoindex_product_cost_snapshots_2` (unique=true, origin=u, partial=false): [sku_id, batch_id]; (implicit)
- `sqlite_autoindex_product_cost_snapshots_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## product_detail_preferences

- Rows: 1
- Primary key: `scope_key`

Columns:

```text
scope_key | type=TEXT | not_null=false | default=(none) | pk_order=1
visible_fields_json | type=TEXT | not_null=true | default=(none) | pk_order=0
revision | type=INTEGER | not_null=true | default=1 | pk_order=0
operator_label | type=TEXT | not_null=true | default=(none) | pk_order=0
request_id | type=TEXT | not_null=false | default=(none) | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
updated_at | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- none

Indexes:
- `sqlite_autoindex_product_detail_preferences_1` (unique=true, origin=pk, partial=false): [scope_key]; (implicit)

## product_field_override_events

- Rows: 102
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
sku_id | type=TEXT | not_null=true | default=(none) | pk_order=0
field_code | type=TEXT | not_null=true | default=(none) | pk_order=0
previous_value_json | type=TEXT | not_null=false | default=(none) | pk_order=0
next_value_json | type=TEXT | not_null=false | default=(none) | pk_order=0
operator_label | type=TEXT | not_null=true | default=(none) | pk_order=0
request_id | type=TEXT | not_null=false | default=(none) | pk_order=0
occurred_at | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- `sku_id` -> `product_skus.id` (id=0, seq=0, on_update=NO ACTION, on_delete=RESTRICT)

Indexes:
- `idx_product_override_events_sku` (unique=false, origin=c, partial=false): [sku_id, occurred_at DESC]; CREATE INDEX idx_product_override_events_sku   ON product_field_override_events(sku_id, occurred_at DESC)
- `sqlite_autoindex_product_field_override_events_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## product_field_overrides

- Rows: 81
- Primary key: `sku_id`, `field_code`

Columns:

```text
sku_id | type=TEXT | not_null=true | default=(none) | pk_order=1
field_code | type=TEXT | not_null=true | default=(none) | pk_order=2
value_json | type=TEXT | not_null=false | default=(none) | pk_order=0
operator_label | type=TEXT | not_null=true | default=(none) | pk_order=0
request_id | type=TEXT | not_null=false | default=(none) | pk_order=0
revision | type=INTEGER | not_null=true | default=1 | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
updated_at | type=TEXT | not_null=true | default=(none) | pk_order=0
deleted_at | type=TEXT | not_null=false | default=(none) | pk_order=0
```

Foreign keys:
- `sku_id` -> `product_skus.id` (id=0, seq=0, on_update=NO ACTION, on_delete=RESTRICT)

Indexes:
- `idx_product_field_overrides_active` (unique=false, origin=c, partial=false): [sku_id, deleted_at, field_code]; CREATE INDEX idx_product_field_overrides_active   ON product_field_overrides(sku_id, deleted_at, field_code)
- `sqlite_autoindex_product_field_overrides_1` (unique=true, origin=pk, partial=false): [sku_id, field_code]; (implicit)

## product_identity_mappings

- Rows: 0
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
source_system | type=TEXT | not_null=true | default=(none) | pk_order=0
source_sku | type=TEXT | not_null=true | default=(none) | pk_order=0
normalized_source_sku | type=TEXT | not_null=true | default=(none) | pk_order=0
platform | type=TEXT | not_null=true | default=(none) | pk_order=0
country_code | type=TEXT | not_null=true | default=(none) | pk_order=0
internal_product_id | type=TEXT | not_null=false | default=(none) | pk_order=0
internal_sku | type=TEXT | not_null=false | default=(none) | pk_order=0
main_sku | type=TEXT | not_null=false | default=(none) | pk_order=0
mapping_status | type=TEXT | not_null=true | default=(none) | pk_order=0
mapping_source | type=TEXT | not_null=true | default=(none) | pk_order=0
confidence | type=NUMERIC | not_null=false | default=(none) | pk_order=0
first_source_batch_id | type=TEXT | not_null=false | default=(none) | pk_order=0
last_source_batch_id | type=TEXT | not_null=false | default=(none) | pk_order=0
confirmed_by | type=TEXT | not_null=false | default=(none) | pk_order=0
confirmed_at | type=TEXT | not_null=false | default=(none) | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
updated_at | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- `last_source_batch_id` -> `growth_source_batches.id` (id=0, seq=0, on_update=NO ACTION, on_delete=RESTRICT)
- `first_source_batch_id` -> `growth_source_batches.id` (id=1, seq=0, on_update=NO ACTION, on_delete=RESTRICT)
- `internal_product_id` -> `product_skus.id` (id=2, seq=0, on_update=NO ACTION, on_delete=RESTRICT)

Indexes:
- `idx_product_identity_mappings_status` (unique=false, origin=c, partial=false): [mapping_status, platform, country_code, updated_at DESC]; CREATE INDEX idx_product_identity_mappings_status    ON product_identity_mappings(mapping_status, platform, country_code, updated_at DESC)
- `sqlite_autoindex_product_identity_mappings_2` (unique=true, origin=u, partial=false): [source_system, platform, country_code, normalized_source_sku]; (implicit)
- `sqlite_autoindex_product_identity_mappings_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## product_image_generation_items

- Rows: 0
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
task_id | type=TEXT | not_null=true | default=(none) | pk_order=0
slot_key | type=TEXT | not_null=true | default=(none) | pk_order=0
slot_type | type=TEXT | not_null=true | default=(none) | pk_order=0
slot_index | type=INTEGER | not_null=true | default=(none) | pk_order=0
label | type=TEXT | not_null=true | default=(none) | pk_order=0
aspect_ratio | type=TEXT | not_null=false | default=(none) | pk_order=0
prompt | type=TEXT | not_null=true | default=(none) | pk_order=0
negative_prompt | type=TEXT | not_null=false | default=(none) | pk_order=0
status | type=TEXT | not_null=true | default=(none) | pk_order=0
generated_file_id | type=TEXT | not_null=false | default=(none) | pk_order=0
error_code | type=TEXT | not_null=false | default=(none) | pk_order=0
error_message | type=TEXT | not_null=false | default=(none) | pk_order=0
adopted_at | type=TEXT | not_null=false | default=(none) | pk_order=0
adopted_by | type=TEXT | not_null=false | default=(none) | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
updated_at | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- `task_id` -> `product_image_generation_tasks.id` (id=0, seq=0, on_update=NO ACTION, on_delete=CASCADE)

Indexes:
- `idx_product_image_generation_items_status` (unique=false, origin=c, partial=false): [status, updated_at]; CREATE INDEX idx_product_image_generation_items_status   ON product_image_generation_items(status, updated_at)
- `idx_product_image_generation_items_task` (unique=false, origin=c, partial=false): [task_id, slot_index]; CREATE INDEX idx_product_image_generation_items_task   ON product_image_generation_items(task_id, slot_index)
- `sqlite_autoindex_product_image_generation_items_2` (unique=true, origin=u, partial=false): [task_id, slot_key]; (implicit)
- `sqlite_autoindex_product_image_generation_items_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## product_image_generation_tasks

- Rows: 0
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
product_sku_id | type=TEXT | not_null=true | default=(none) | pk_order=0
listing_draft_id | type=TEXT | not_null=false | default=(none) | pk_order=0
template_key | type=TEXT | not_null=true | default=(none) | pk_order=0
provider | type=TEXT | not_null=false | default=(none) | pk_order=0
model | type=TEXT | not_null=false | default=(none) | pk_order=0
context_hash | type=TEXT | not_null=true | default=(none) | pk_order=0
context_json | type=TEXT | not_null=true | default=(none) | pk_order=0
prompt_plan_json | type=TEXT | not_null=true | default='{}' | pk_order=0
status | type=TEXT | not_null=true | default=(none) | pk_order=0
error_code | type=TEXT | not_null=false | default=(none) | pk_order=0
error_message | type=TEXT | not_null=false | default=(none) | pk_order=0
created_by | type=TEXT | not_null=true | default=(none) | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
updated_at | type=TEXT | not_null=true | default=(none) | pk_order=0
finished_at | type=TEXT | not_null=false | default=(none) | pk_order=0
cancelled_at | type=TEXT | not_null=false | default=(none) | pk_order=0
```

Foreign keys:
- `listing_draft_id` -> `product_listing_drafts.id` (id=0, seq=0, on_update=NO ACTION, on_delete=SET NULL)
- `product_sku_id` -> `product_skus.id` (id=1, seq=0, on_update=NO ACTION, on_delete=RESTRICT)

Indexes:
- `idx_product_image_generation_tasks_status` (unique=false, origin=c, partial=false): [status, updated_at]; CREATE INDEX idx_product_image_generation_tasks_status   ON product_image_generation_tasks(status, updated_at)
- `idx_product_image_generation_tasks_product` (unique=false, origin=c, partial=false): [product_sku_id, created_at DESC]; CREATE INDEX idx_product_image_generation_tasks_product   ON product_image_generation_tasks(product_sku_id, created_at DESC)
- `sqlite_autoindex_product_image_generation_tasks_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## product_images

- Rows: 1
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
sku_id | type=TEXT | not_null=true | default=(none) | pk_order=0
original_filename | type=TEXT | not_null=true | default=(none) | pk_order=0
storage_filename | type=TEXT | not_null=true | default=(none) | pk_order=0
relative_path | type=TEXT | not_null=true | default=(none) | pk_order=0
mime_type | type=TEXT | not_null=true | default=(none) | pk_order=0
file_size | type=INTEGER | not_null=true | default=(none) | pk_order=0
file_hash | type=TEXT | not_null=true | default=(none) | pk_order=0
is_primary | type=INTEGER | not_null=true | default=0 | pk_order=0
sort_order | type=INTEGER | not_null=true | default=0 | pk_order=0
status | type=TEXT | not_null=true | default='available' | pk_order=0
operator_label | type=TEXT | not_null=true | default=(none) | pk_order=0
request_id | type=TEXT | not_null=false | default=(none) | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
updated_at | type=TEXT | not_null=true | default=(none) | pk_order=0
deleted_at | type=TEXT | not_null=false | default=(none) | pk_order=0
```

Foreign keys:
- `sku_id` -> `product_skus.id` (id=0, seq=0, on_update=NO ACTION, on_delete=RESTRICT)

Indexes:
- `idx_product_images_sku` (unique=false, origin=c, partial=false): [sku_id, status, is_primary DESC, sort_order, created_at]; CREATE INDEX idx_product_images_sku   ON product_images(sku_id, status, is_primary DESC, sort_order, created_at)
- `sqlite_autoindex_product_images_2` (unique=true, origin=u, partial=false): [relative_path]; (implicit)
- `sqlite_autoindex_product_images_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## product_import_batches

- Rows: 5
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
source_system | type=TEXT | not_null=true | default='company_product_center' | pk_order=0
source_period | type=TEXT | not_null=false | default=(none) | pk_order=0
source_country_raw | type=TEXT | not_null=false | default=(none) | pk_order=0
file_sha256 | type=TEXT | not_null=true | default=(none) | pk_order=0
header_fingerprint | type=TEXT | not_null=false | default=(none) | pk_order=0
status | type=TEXT | not_null=true | default=(none) | pk_order=0
row_count | type=INTEGER | not_null=true | default=0 | pk_order=0
new_count | type=INTEGER | not_null=true | default=0 | pk_order=0
updated_count | type=INTEGER | not_null=true | default=0 | pk_order=0
unchanged_count | type=INTEGER | not_null=true | default=0 | pk_order=0
conflict_count | type=INTEGER | not_null=true | default=0 | pk_order=0
exception_count | type=INTEGER | not_null=true | default=0 | pk_order=0
blocker_count | type=INTEGER | not_null=true | default=0 | pk_order=0
reminder_count | type=INTEGER | not_null=true | default=0 | pk_order=0
information_count | type=INTEGER | not_null=true | default=0 | pk_order=0
mapping_json | type=TEXT | not_null=true | default='[]' | pk_order=0
unknown_fields_json | type=TEXT | not_null=true | default='[]' | pk_order=0
validation_summary_json | type=TEXT | not_null=true | default='{}' | pk_order=0
operator_label | type=TEXT | not_null=true | default=(none) | pk_order=0
request_id | type=TEXT | not_null=false | default=(none) | pk_order=0
revision | type=INTEGER | not_null=true | default=1 | pk_order=0
error_code | type=TEXT | not_null=false | default=(none) | pk_order=0
error_summary | type=TEXT | not_null=false | default=(none) | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
updated_at | type=TEXT | not_null=true | default=(none) | pk_order=0
applied_at | type=TEXT | not_null=false | default=(none) | pk_order=0
cancelled_at | type=TEXT | not_null=false | default=(none) | pk_order=0
unmatched_count | type=INTEGER | not_null=true | default=0 | pk_order=0
will_write_count | type=INTEGER | not_null=true | default=0 | pk_order=0
```

Foreign keys:
- none

Indexes:
- `idx_product_import_batches_status_created` (unique=false, origin=c, partial=false): [status, created_at DESC]; CREATE INDEX idx_product_import_batches_status_created   ON product_import_batches(status, created_at DESC)
- `idx_product_import_batches_file` (unique=true, origin=c, partial=false): [source_system, file_sha256]; CREATE UNIQUE INDEX idx_product_import_batches_file   ON product_import_batches(source_system, file_sha256)
- `sqlite_autoindex_product_import_batches_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

