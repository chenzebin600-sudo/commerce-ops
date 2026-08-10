# Commerce Ops SQLite Tables 08

Snapshot date: 2026-08-05

This appendix records exact SQLite fields, keys, foreign keys, indexes, and row counts.

## product_packaging_profiles

- Rows: 18,347
- Primary key: `sku_id`

Columns:

```text
sku_id | type=TEXT | not_null=false | default=(none) | pk_order=1
source_row_id | type=TEXT | not_null=true | default=(none) | pk_order=0
item_dimensions_raw | type=TEXT | not_null=false | default=(none) | pk_order=0
item_net_weight_g | type=NUMERIC | not_null=false | default=(none) | pk_order=0
item_gross_weight_g | type=NUMERIC | not_null=false | default=(none) | pk_order=0
carton_length_cm | type=NUMERIC | not_null=false | default=(none) | pk_order=0
carton_width_cm | type=NUMERIC | not_null=false | default=(none) | pk_order=0
carton_height_cm | type=NUMERIC | not_null=false | default=(none) | pk_order=0
carton_quantity | type=INTEGER | not_null=false | default=(none) | pk_order=0
shipping_method | type=TEXT | not_null=false | default=(none) | pk_order=0
updated_at | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- `source_row_id` -> `product_import_rows.id` (id=0, seq=0, on_update=NO ACTION, on_delete=RESTRICT)
- `sku_id` -> `product_skus.id` (id=1, seq=0, on_update=NO ACTION, on_delete=RESTRICT)

Indexes:
- `sqlite_autoindex_product_packaging_profiles_1` (unique=true, origin=pk, partial=false): [sku_id]; (implicit)

## product_price_change_events

- Rows: 0
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
sync_run_id | type=TEXT | not_null=true | default=(none) | pk_order=0
source_apply_no | type=TEXT | not_null=true | default=(none) | pk_order=0
price_key | type=TEXT | not_null=true | default=(none) | pk_order=0
country_code | type=TEXT | not_null=true | default=(none) | pk_order=0
category_name | type=TEXT | not_null=false | default=(none) | pk_order=0
sku | type=TEXT | not_null=true | default=(none) | pk_order=0
product_name_cn | type=TEXT | not_null=false | default=(none) | pk_order=0
platform | type=TEXT | not_null=true | default=(none) | pk_order=0
shop_type | type=TEXT | not_null=true | default=(none) | pk_order=0
price_type | type=TEXT | not_null=true | default=(none) | pk_order=0
old_price | type=TEXT | not_null=false | default=(none) | pk_order=0
new_price | type=TEXT | not_null=false | default=(none) | pk_order=0
delta_value | type=TEXT | not_null=false | default=(none) | pk_order=0
delta_percent | type=REAL | not_null=false | default=(none) | pk_order=0
direction | type=TEXT | not_null=true | default=(none) | pk_order=0
change_text | type=TEXT | not_null=true | default=(none) | pk_order=0
change_fingerprint | type=TEXT | not_null=true | default=(none) | pk_order=0
foundation_task_id | type=TEXT | not_null=false | default=(none) | pk_order=0
detected_at | type=TEXT | not_null=true | default=(none) | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- `foundation_task_id` -> `foundation_tasks.id` (id=0, seq=0, on_update=NO ACTION, on_delete=SET NULL)
- `source_apply_no` -> `price_control_source_batches.apply_no` (id=1, seq=0, on_update=NO ACTION, on_delete=RESTRICT)
- `sync_run_id` -> `price_control_sync_runs.id` (id=2, seq=0, on_update=NO ACTION, on_delete=RESTRICT)

Indexes:
- `idx_product_price_changes_batch` (unique=false, origin=c, partial=false): [source_apply_no, detected_at DESC]; CREATE INDEX idx_product_price_changes_batch   ON product_price_change_events(source_apply_no,detected_at DESC)
- `idx_product_price_changes_scope` (unique=false, origin=c, partial=false): [country_code, category_name, sku, direction, detected_at DESC]; CREATE INDEX idx_product_price_changes_scope   ON product_price_change_events(country_code,category_name,sku,direction,detected_at DESC)
- `idx_product_price_changes_detected` (unique=false, origin=c, partial=false): [detected_at DESC, id]; CREATE INDEX idx_product_price_changes_detected   ON product_price_change_events(detected_at DESC,id)
- `sqlite_autoindex_product_price_change_events_2` (unique=true, origin=u, partial=false): [change_fingerprint]; (implicit)
- `sqlite_autoindex_product_price_change_events_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## product_sku_current_prices

- Rows: 324,962
- Primary key: `price_key`

Columns:

```text
price_key | type=TEXT | not_null=false | default=(none) | pk_order=1
country_code | type=TEXT | not_null=true | default=(none) | pk_order=0
category_name | type=TEXT | not_null=false | default=(none) | pk_order=0
sku | type=TEXT | not_null=true | default=(none) | pk_order=0
product_name_cn | type=TEXT | not_null=false | default=(none) | pk_order=0
sku_status | type=TEXT | not_null=false | default=(none) | pk_order=0
platform | type=TEXT | not_null=true | default=(none) | pk_order=0
shop_type | type=TEXT | not_null=true | default=(none) | pk_order=0
price_type | type=TEXT | not_null=true | default=(none) | pk_order=0
price_value | type=TEXT | not_null=true | default=(none) | pk_order=0
source_apply_no | type=TEXT | not_null=true | default=(none) | pk_order=0
source_snapshot_id | type=TEXT | not_null=true | default=(none) | pk_order=0
effective_at | type=TEXT | not_null=true | default=(none) | pk_order=0
revision | type=INTEGER | not_null=true | default=1 | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
updated_at | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- `source_snapshot_id` -> `price_control_price_snapshots.id` (id=0, seq=0, on_update=NO ACTION, on_delete=RESTRICT)
- `source_apply_no` -> `price_control_source_batches.apply_no` (id=1, seq=0, on_update=NO ACTION, on_delete=RESTRICT)

Indexes:
- `idx_product_sku_current_prices_scope` (unique=false, origin=c, partial=false): [country_code, sku, platform, shop_type, price_type]; CREATE INDEX idx_product_sku_current_prices_scope   ON product_sku_current_prices(country_code,sku,platform,shop_type,price_type)
- `sqlite_autoindex_product_sku_current_prices_1` (unique=true, origin=pk, partial=false): [price_key]; (implicit)

## product_sku_lifecycle

- Rows: 18,347
- Primary key: `sku_id`

Columns:

```text
sku_id | type=TEXT | not_null=false | default=(none) | pk_order=1
status_code | type=TEXT | not_null=true | default=(none) | pk_order=0
revision | type=INTEGER | not_null=true | default=1 | pk_order=0
decision_source | type=TEXT | not_null=true | default=(none) | pk_order=0
source_status_raw | type=TEXT | not_null=false | default=(none) | pk_order=0
source_batch_id | type=TEXT | not_null=true | default=(none) | pk_order=0
reason_code | type=TEXT | not_null=true | default=(none) | pk_order=0
operator_label | type=TEXT | not_null=true | default=(none) | pk_order=0
request_id | type=TEXT | not_null=false | default=(none) | pk_order=0
effective_at | type=TEXT | not_null=true | default=(none) | pk_order=0
updated_at | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- `source_batch_id` -> `product_import_batches.id` (id=0, seq=0, on_update=NO ACTION, on_delete=RESTRICT)
- `sku_id` -> `product_skus.id` (id=1, seq=0, on_update=NO ACTION, on_delete=RESTRICT)

Indexes:
- `idx_product_sku_lifecycle_status` (unique=false, origin=c, partial=false): [status_code, updated_at DESC]; CREATE INDEX idx_product_sku_lifecycle_status   ON product_sku_lifecycle(status_code, updated_at DESC)
- `sqlite_autoindex_product_sku_lifecycle_1` (unique=true, origin=pk, partial=false): [sku_id]; (implicit)

## product_sku_lifecycle_events

- Rows: 18,393
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
sku_id | type=TEXT | not_null=true | default=(none) | pk_order=0
from_status_code | type=TEXT | not_null=false | default=(none) | pk_order=0
to_status_code | type=TEXT | not_null=true | default=(none) | pk_order=0
decision_source | type=TEXT | not_null=true | default=(none) | pk_order=0
source_batch_id | type=TEXT | not_null=true | default=(none) | pk_order=0
reason_code | type=TEXT | not_null=true | default=(none) | pk_order=0
operator_label | type=TEXT | not_null=true | default=(none) | pk_order=0
request_id | type=TEXT | not_null=false | default=(none) | pk_order=0
occurred_at | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- `source_batch_id` -> `product_import_batches.id` (id=0, seq=0, on_update=NO ACTION, on_delete=RESTRICT)
- `sku_id` -> `product_skus.id` (id=1, seq=0, on_update=NO ACTION, on_delete=RESTRICT)

Indexes:
- `idx_product_lifecycle_events_sku` (unique=false, origin=c, partial=false): [sku_id, occurred_at DESC]; CREATE INDEX idx_product_lifecycle_events_sku   ON product_sku_lifecycle_events(sku_id, occurred_at DESC)
- `sqlite_autoindex_product_sku_lifecycle_events_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## product_skus

- Rows: 18,347
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
source_system | type=TEXT | not_null=true | default=(none) | pk_order=0
source_sku | type=TEXT | not_null=true | default=(none) | pk_order=0
normalized_sku | type=TEXT | not_null=true | default=(none) | pk_order=0
category_id | type=TEXT | not_null=true | default=(none) | pk_order=0
model_id | type=TEXT | not_null=false | default=(none) | pk_order=0
source_product_name | type=TEXT | not_null=true | default=(none) | pk_order=0
source_main_sku | type=TEXT | not_null=false | default=(none) | pk_order=0
source_style_code | type=TEXT | not_null=false | default=(none) | pk_order=0
source_style_name | type=TEXT | not_null=false | default=(none) | pk_order=0
source_sales_spec | type=TEXT | not_null=false | default=(none) | pk_order=0
source_status_raw | type=TEXT | not_null=true | default=(none) | pk_order=0
current_source_row_id | type=TEXT | not_null=true | default=(none) | pk_order=0
first_seen_batch_id | type=TEXT | not_null=true | default=(none) | pk_order=0
last_seen_batch_id | type=TEXT | not_null=true | default=(none) | pk_order=0
revision | type=INTEGER | not_null=true | default=1 | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
updated_at | type=TEXT | not_null=true | default=(none) | pk_order=0
archived_at | type=TEXT | not_null=false | default=(none) | pk_order=0
country_raw | type=TEXT | not_null=true | default='' | pk_order=0
sku_code_normalized | type=TEXT | not_null=true | default='' | pk_order=0
deleted_at | type=TEXT | not_null=false | default=(none) | pk_order=0
deleted_by | type=TEXT | not_null=false | default=(none) | pk_order=0
delete_reason | type=TEXT | not_null=false | default=(none) | pk_order=0
restored_at | type=TEXT | not_null=false | default=(none) | pk_order=0
restored_by | type=TEXT | not_null=false | default=(none) | pk_order=0
```

Foreign keys:
- `last_seen_batch_id` -> `product_import_batches.id` (id=0, seq=0, on_update=NO ACTION, on_delete=RESTRICT)
- `first_seen_batch_id` -> `product_import_batches.id` (id=1, seq=0, on_update=NO ACTION, on_delete=RESTRICT)
- `current_source_row_id` -> `product_import_rows.id` (id=2, seq=0, on_update=NO ACTION, on_delete=RESTRICT)
- `model_id` -> `product_models.id` (id=3, seq=0, on_update=NO ACTION, on_delete=SET NULL)
- `category_id` -> `product_categories.id` (id=4, seq=0, on_update=NO ACTION, on_delete=RESTRICT)

Indexes:
- `idx_product_skus_deleted` (unique=false, origin=c, partial=false): [deleted_at, country_raw, sku_code_normalized]; CREATE INDEX idx_product_skus_deleted   ON product_skus(deleted_at, country_raw, sku_code_normalized)
- `idx_product_skus_sku_code` (unique=false, origin=c, partial=false): [sku_code_normalized, country_raw]; CREATE INDEX idx_product_skus_sku_code   ON product_skus(sku_code_normalized, country_raw)
- `idx_product_skus_country_sku` (unique=true, origin=c, partial=false): [source_system, country_raw, sku_code_normalized]; CREATE UNIQUE INDEX idx_product_skus_country_sku   ON product_skus(source_system, country_raw, sku_code_normalized)
- `idx_product_skus_name` (unique=false, origin=c, partial=false): [source_product_name]; CREATE INDEX idx_product_skus_name   ON product_skus(source_product_name)
- `idx_product_skus_category` (unique=false, origin=c, partial=false): [category_id, archived_at]; CREATE INDEX idx_product_skus_category   ON product_skus(category_id, archived_at)
- `idx_product_skus_model` (unique=false, origin=c, partial=false): [model_id, archived_at]; CREATE INDEX idx_product_skus_model   ON product_skus(model_id, archived_at)
- `sqlite_autoindex_product_skus_2` (unique=true, origin=u, partial=false): [source_system, normalized_sku]; (implicit)
- `sqlite_autoindex_product_skus_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## scheduled_export_run_events

- Rows: 216
- Primary key: `id`

Columns:

```text
id | type=INTEGER | not_null=false | default=(none) | pk_order=1
run_id | type=TEXT | not_null=true | default=(none) | pk_order=0
stage | type=TEXT | not_null=true | default=(none) | pk_order=0
status | type=TEXT | not_null=true | default=(none) | pk_order=0
attempt | type=INTEGER | not_null=true | default=1 | pk_order=0
started_at | type=TEXT | not_null=true | default=(none) | pk_order=0
finished_at | type=TEXT | not_null=false | default=(none) | pk_order=0
duration_ms | type=INTEGER | not_null=false | default=(none) | pk_order=0
message | type=TEXT | not_null=false | default=(none) | pk_order=0
error_code | type=TEXT | not_null=false | default=(none) | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- `run_id` -> `scheduled_export_runs.id` (id=0, seq=0, on_update=NO ACTION, on_delete=CASCADE)

Indexes:
- `idx_run_events_run` (unique=false, origin=c, partial=false): [run_id, id]; CREATE INDEX idx_run_events_run ON scheduled_export_run_events(run_id, id)

## scheduled_export_runs

- Rows: 16
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
task_id | type=TEXT | not_null=true | default=(none) | pk_order=0
trigger_type | type=TEXT | not_null=true | default=(none) | pk_order=0
scheduled_run_at | type=TEXT | not_null=true | default=(none) | pk_order=0
started_at | type=TEXT | not_null=false | default=(none) | pk_order=0
finished_at | type=TEXT | not_null=false | default=(none) | pk_order=0
status | type=TEXT | not_null=true | default=(none) | pk_order=0
payment_start_date | type=TEXT | not_null=false | default=(none) | pk_order=0
payment_end_date | type=TEXT | not_null=false | default=(none) | pk_order=0
raw_order_count | type=INTEGER | not_null=true | default=0 | pk_order=0
filtered_order_count | type=INTEGER | not_null=true | default=0 | pk_order=0
detail_row_count | type=INTEGER | not_null=true | default=0 | pk_order=0
export_file_id | type=TEXT | not_null=false | default=(none) | pk_order=0
notification_status | type=TEXT | not_null=false | default=(none) | pk_order=0
retry_count | type=INTEGER | not_null=true | default=0 | pk_order=0
error_stage | type=TEXT | not_null=false | default=(none) | pk_order=0
error_code | type=TEXT | not_null=false | default=(none) | pk_order=0
error_message | type=TEXT | not_null=false | default=(none) | pk_order=0
log_summary_json | type=TEXT | not_null=true | default='{}' | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
updated_at | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- `task_id` -> `scheduled_export_tasks.id` (id=0, seq=0, on_update=NO ACTION, on_delete=CASCADE)

Indexes:
- `idx_scheduled_export_runs_task` (unique=false, origin=c, partial=false): [task_id, created_at DESC]; CREATE INDEX idx_scheduled_export_runs_task ON scheduled_export_runs(task_id, created_at DESC)
- `idx_scheduled_export_runs_status` (unique=false, origin=c, partial=false): [status, scheduled_run_at]; CREATE INDEX idx_scheduled_export_runs_status ON scheduled_export_runs(status, scheduled_run_at)
- `sqlite_autoindex_scheduled_export_runs_2` (unique=true, origin=u, partial=false): [task_id, scheduled_run_at]; (implicit)
- `sqlite_autoindex_scheduled_export_runs_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## scheduled_export_tasks

- Rows: 4
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
task_type | type=TEXT | not_null=true | default='order_export' | pk_order=0
name | type=TEXT | not_null=true | default=(none) | pk_order=0
description | type=TEXT | not_null=false | default=(none) | pk_order=0
account_profile_id | type=TEXT | not_null=true | default=(none) | pk_order=0
dingtalk_config_id | type=TEXT | not_null=false | default=(none) | pk_order=0
schedule_type | type=TEXT | not_null=true | default=(none) | pk_order=0
schedule_config_json | type=TEXT | not_null=true | default=(none) | pk_order=0
timezone | type=TEXT | not_null=true | default='Asia/Shanghai' | pk_order=0
payment_date_mode | type=TEXT | not_null=true | default=(none) | pk_order=0
payment_date_config_json | type=TEXT | not_null=true | default='{}' | pk_order=0
filters_json | type=TEXT | not_null=true | default='[]' | pk_order=0
enabled | type=INTEGER | not_null=true | default=1 | pk_order=0
file_retention_days | type=INTEGER | not_null=false | default=(none) | pk_order=0
notify_enabled | type=INTEGER | not_null=true | default=1 | pk_order=0
catch_up_enabled | type=INTEGER | not_null=true | default=1 | pk_order=0
last_run_at | type=TEXT | not_null=false | default=(none) | pk_order=0
last_run_status | type=TEXT | not_null=false | default=(none) | pk_order=0
next_run_at | type=TEXT | not_null=false | default=(none) | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
updated_at | type=TEXT | not_null=true | default=(none) | pk_order=0
deleted_at | type=TEXT | not_null=false | default=(none) | pk_order=0
deleted_by | type=TEXT | not_null=false | default=(none) | pk_order=0
delete_reason | type=TEXT | not_null=false | default=(none) | pk_order=0
```

Foreign keys:
- `dingtalk_config_id` -> `dingtalk_robot_configs.id` (id=0, seq=0, on_update=NO ACTION, on_delete=SET NULL)
- `account_profile_id` -> `mabang_account_profiles.id` (id=1, seq=0, on_update=NO ACTION, on_delete=RESTRICT)

Indexes:
- `idx_scheduled_export_tasks_deleted_at` (unique=false, origin=c, partial=false): [deleted_at]; CREATE INDEX idx_scheduled_export_tasks_deleted_at   ON scheduled_export_tasks(deleted_at)
- `idx_scheduled_export_tasks_due` (unique=false, origin=c, partial=false): [enabled, next_run_at]; CREATE INDEX idx_scheduled_export_tasks_due ON scheduled_export_tasks(enabled, next_run_at)
- `sqlite_autoindex_scheduled_export_tasks_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## scheduler_leases

- Rows: 1
- Primary key: `name`

Columns:

```text
name | type=TEXT | not_null=false | default=(none) | pk_order=1
owner_id | type=TEXT | not_null=true | default=(none) | pk_order=0
lease_until | type=TEXT | not_null=true | default=(none) | pk_order=0
updated_at | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- none

Indexes:
- `sqlite_autoindex_scheduler_leases_1` (unique=true, origin=pk, partial=false): [name]; (implicit)

## schema_migrations

- Rows: 23
- Primary key: `version`

Columns:

```text
version | type=TEXT | not_null=false | default=(none) | pk_order=1
applied_at | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- none

Indexes:
- `sqlite_autoindex_schema_migrations_1` (unique=true, origin=pk, partial=false): [version]; (implicit)

