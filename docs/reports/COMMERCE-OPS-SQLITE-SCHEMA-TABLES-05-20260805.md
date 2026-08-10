# Commerce Ops SQLite Tables 05

Snapshot date: 2026-08-05

This appendix records exact SQLite fields, keys, foreign keys, indexes, and row counts.

## mabang_sku_image_batches

- Rows: 210
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
account_id | type=TEXT | not_null=true | default=(none) | pk_order=0
source_batch_id | type=TEXT | not_null=false | default=(none) | pk_order=0
mode | type=TEXT | not_null=true | default=(none) | pk_order=0
status | type=TEXT | not_null=true | default=(none) | pk_order=0
started_at | type=TEXT | not_null=false | default=(none) | pk_order=0
completed_at | type=TEXT | not_null=false | default=(none) | pk_order=0
paused_at | type=TEXT | not_null=false | default=(none) | pk_order=0
current_page | type=INTEGER | not_null=true | default=0 | pk_order=0
total_pages | type=INTEGER | not_null=false | default=(none) | pk_order=0
discovered_skus | type=INTEGER | not_null=true | default=0 | pk_order=0
downloaded_images | type=INTEGER | not_null=true | default=0 | pk_order=0
missing_images | type=INTEGER | not_null=true | default=0 | pk_order=0
duplicate_images | type=INTEGER | not_null=true | default=0 | pk_order=0
failed_images | type=INTEGER | not_null=true | default=0 | pk_order=0
linked_products | type=INTEGER | not_null=true | default=0 | pk_order=0
shared_country_links | type=INTEGER | not_null=true | default=0 | pk_order=0
filename_mismatches | type=INTEGER | not_null=true | default=0 | pk_order=0
interface_profile_json | type=TEXT | not_null=true | default='{}' | pk_order=0
last_error_code | type=TEXT | not_null=false | default=(none) | pk_order=0
last_error_message | type=TEXT | not_null=false | default=(none) | pk_order=0
created_by | type=TEXT | not_null=true | default=(none) | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
updated_at | type=TEXT | not_null=true | default=(none) | pk_order=0
sync_run_id | type=TEXT | not_null=false | default=(none) | pk_order=0
segment_no | type=INTEGER | not_null=false | default=(none) | pk_order=0
start_page | type=INTEGER | not_null=false | default=(none) | pk_order=0
end_page | type=INTEGER | not_null=false | default=(none) | pk_order=0
```

Foreign keys:
- `source_batch_id` -> `mabang_sku_image_batches.id` (id=0, seq=0, on_update=NO ACTION, on_delete=RESTRICT)
- `account_id` -> `mabang_account_profiles.id` (id=1, seq=0, on_update=NO ACTION, on_delete=RESTRICT)
- `sync_run_id` -> `mabang_sku_image_sync_runs.id` (id=2, seq=0, on_update=NO ACTION, on_delete=RESTRICT)

Indexes:
- `idx_mabang_sku_image_batches_sync_run` (unique=false, origin=c, partial=false): [sync_run_id, segment_no]; CREATE INDEX idx_mabang_sku_image_batches_sync_run   ON mabang_sku_image_batches(sync_run_id, segment_no)
- `uq_mabang_sku_image_batches_sync_segment` (unique=true, origin=c, partial=true): [sync_run_id, segment_no]; CREATE UNIQUE INDEX uq_mabang_sku_image_batches_sync_segment   ON mabang_sku_image_batches(sync_run_id, segment_no)   WHERE sync_run_id IS NOT NULL
- `idx_mabang_sku_image_batches_account` (unique=false, origin=c, partial=false): [account_id, created_at DESC]; CREATE INDEX idx_mabang_sku_image_batches_account    ON mabang_sku_image_batches(account_id, created_at DESC)
- `idx_mabang_sku_image_batches_status` (unique=false, origin=c, partial=false): [status, created_at DESC]; CREATE INDEX idx_mabang_sku_image_batches_status    ON mabang_sku_image_batches(status, created_at DESC)
- `sqlite_autoindex_mabang_sku_image_batches_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## mabang_sku_image_checkpoints

- Rows: 573
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
batch_id | type=TEXT | not_null=true | default=(none) | pk_order=0
page_number | type=INTEGER | not_null=true | default=(none) | pk_order=0
page_hash | type=TEXT | not_null=true | default=(none) | pk_order=0
row_count | type=INTEGER | not_null=true | default=0 | pk_order=0
discovered_count | type=INTEGER | not_null=true | default=0 | pk_order=0
failed_count | type=INTEGER | not_null=true | default=0 | pk_order=0
status | type=TEXT | not_null=true | default=(none) | pk_order=0
error_code | type=TEXT | not_null=false | default=(none) | pk_order=0
completed_at | type=TEXT | not_null=false | default=(none) | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
updated_at | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- `batch_id` -> `mabang_sku_image_batches.id` (id=0, seq=0, on_update=NO ACTION, on_delete=CASCADE)

Indexes:
- `idx_mabang_sku_image_checkpoints_batch` (unique=false, origin=c, partial=false): [batch_id, page_number]; CREATE INDEX idx_mabang_sku_image_checkpoints_batch    ON mabang_sku_image_checkpoints(batch_id, page_number)
- `sqlite_autoindex_mabang_sku_image_checkpoints_2` (unique=true, origin=u, partial=false): [batch_id, page_number]; (implicit)
- `sqlite_autoindex_mabang_sku_image_checkpoints_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## mabang_sku_image_discoveries

- Rows: 22,687
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
batch_id | type=TEXT | not_null=true | default=(none) | pk_order=0
source_sku | type=TEXT | not_null=true | default=(none) | pk_order=0
source_sku_normalized | type=TEXT | not_null=true | default=(none) | pk_order=0
product_name | type=TEXT | not_null=false | default=(none) | pk_order=0
warehouse_name | type=TEXT | not_null=false | default=(none) | pk_order=0
source_image_url | type=TEXT | not_null=false | default=(none) | pk_order=0
image_src | type=TEXT | not_null=false | default=(none) | pk_order=0
image_data_src | type=TEXT | not_null=false | default=(none) | pk_order=0
image_srcset | type=TEXT | not_null=false | default=(none) | pk_order=0
image_background_url | type=TEXT | not_null=false | default=(none) | pk_order=0
source_kind | type=TEXT | not_null=true | default=(none) | pk_order=0
source_page | type=INTEGER | not_null=true | default=(none) | pk_order=0
source_row_number | type=INTEGER | not_null=true | default=(none) | pk_order=0
filename_sku | type=TEXT | not_null=false | default=(none) | pk_order=0
validation_status | type=TEXT | not_null=true | default='pending' | pk_order=0
quality_issue_code | type=TEXT | not_null=false | default=(none) | pk_order=0
download_status | type=TEXT | not_null=true | default='pending' | pk_order=0
asset_id | type=TEXT | not_null=false | default=(none) | pk_order=0
download_attempts | type=INTEGER | not_null=true | default=0 | pk_order=0
http_status | type=INTEGER | not_null=false | default=(none) | pk_order=0
discovered_at | type=TEXT | not_null=true | default=(none) | pk_order=0
last_checked_at | type=TEXT | not_null=true | default=(none) | pk_order=0
error_code | type=TEXT | not_null=false | default=(none) | pk_order=0
error_message | type=TEXT | not_null=false | default=(none) | pk_order=0
```

Foreign keys:
- `asset_id` -> `product_media_assets.id` (id=0, seq=0, on_update=NO ACTION, on_delete=SET NULL)
- `batch_id` -> `mabang_sku_image_batches.id` (id=1, seq=0, on_update=NO ACTION, on_delete=CASCADE)

Indexes:
- `idx_mabang_sku_image_discoveries_failed` (unique=false, origin=c, partial=false): [batch_id, download_status, error_code]; CREATE INDEX idx_mabang_sku_image_discoveries_failed    ON mabang_sku_image_discoveries(batch_id, download_status, error_code)
- `idx_mabang_sku_image_discoveries_sku` (unique=false, origin=c, partial=false): [source_sku_normalized, download_status]; CREATE INDEX idx_mabang_sku_image_discoveries_sku    ON mabang_sku_image_discoveries(source_sku_normalized, download_status)
- `idx_mabang_sku_image_discoveries_batch` (unique=false, origin=c, partial=false): [batch_id, source_page, source_row_number]; CREATE INDEX idx_mabang_sku_image_discoveries_batch    ON mabang_sku_image_discoveries(batch_id, source_page, source_row_number)
- `sqlite_autoindex_mabang_sku_image_discoveries_2` (unique=true, origin=u, partial=false): [batch_id, source_page, source_row_number, source_sku_normalized]; (implicit)
- `sqlite_autoindex_mabang_sku_image_discoveries_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## mabang_sku_image_discovery_images

- Rows: 40,039
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
discovery_id | type=TEXT | not_null=true | default=(none) | pk_order=0
image_index | type=INTEGER | not_null=true | default=(none) | pk_order=0
source_url | type=TEXT | not_null=true | default=(none) | pk_order=0
source_url_hash | type=TEXT | not_null=true | default=(none) | pk_order=0
source_kind | type=TEXT | not_null=true | default=(none) | pk_order=0
download_status | type=TEXT | not_null=true | default='pending' | pk_order=0
asset_id | type=TEXT | not_null=false | default=(none) | pk_order=0
download_attempts | type=INTEGER | not_null=true | default=0 | pk_order=0
http_status | type=INTEGER | not_null=false | default=(none) | pk_order=0
error_code | type=TEXT | not_null=false | default=(none) | pk_order=0
error_message | type=TEXT | not_null=false | default=(none) | pk_order=0
discovered_at | type=TEXT | not_null=true | default=(none) | pk_order=0
last_checked_at | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- `asset_id` -> `product_media_assets.id` (id=0, seq=0, on_update=NO ACTION, on_delete=SET NULL)
- `discovery_id` -> `mabang_sku_image_discoveries.id` (id=1, seq=0, on_update=NO ACTION, on_delete=CASCADE)

Indexes:
- `idx_mabang_sku_image_discovery_images_url_asset` (unique=false, origin=c, partial=false): [source_url_hash, asset_id]; CREATE INDEX idx_mabang_sku_image_discovery_images_url_asset   ON mabang_sku_image_discovery_images(source_url_hash, asset_id)
- `idx_mabang_sku_image_discovery_images_asset` (unique=false, origin=c, partial=false): [asset_id]; CREATE INDEX idx_mabang_sku_image_discovery_images_asset   ON mabang_sku_image_discovery_images(asset_id)
- `idx_mabang_sku_image_discovery_images_status` (unique=false, origin=c, partial=false): [download_status, last_checked_at]; CREATE INDEX idx_mabang_sku_image_discovery_images_status   ON mabang_sku_image_discovery_images(download_status, last_checked_at)
- `idx_mabang_sku_image_discovery_images_discovery` (unique=false, origin=c, partial=false): [discovery_id, image_index]; CREATE INDEX idx_mabang_sku_image_discovery_images_discovery   ON mabang_sku_image_discovery_images(discovery_id, image_index)
- `sqlite_autoindex_mabang_sku_image_discovery_images_2` (unique=true, origin=u, partial=false): [discovery_id, source_url_hash]; (implicit)
- `sqlite_autoindex_mabang_sku_image_discovery_images_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## mabang_sku_image_sync_runs

- Rows: 2
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
account_id | type=TEXT | not_null=true | default=(none) | pk_order=0
status | type=TEXT | not_null=true | default=(none) | pk_order=0
next_page | type=INTEGER | not_null=true | default=1 | pk_order=0
total_pages | type=INTEGER | not_null=false | default=(none) | pk_order=0
segment_count | type=INTEGER | not_null=true | default=0 | pk_order=0
discovered_skus | type=INTEGER | not_null=true | default=0 | pk_order=0
discovered_images | type=INTEGER | not_null=true | default=0 | pk_order=0
downloaded_images | type=INTEGER | not_null=true | default=0 | pk_order=0
duplicate_images | type=INTEGER | not_null=true | default=0 | pk_order=0
failed_images | type=INTEGER | not_null=true | default=0 | pk_order=0
matched_skus | type=INTEGER | not_null=true | default=0 | pk_order=0
unmatched_skus | type=INTEGER | not_null=true | default=0 | pk_order=0
last_batch_id | type=TEXT | not_null=false | default=(none) | pk_order=0
last_error_code | type=TEXT | not_null=false | default=(none) | pk_order=0
last_error_message | type=TEXT | not_null=false | default=(none) | pk_order=0
created_by | type=TEXT | not_null=true | default=(none) | pk_order=0
started_at | type=TEXT | not_null=false | default=(none) | pk_order=0
completed_at | type=TEXT | not_null=false | default=(none) | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
updated_at | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- `account_id` -> `mabang_account_profiles.id` (id=0, seq=0, on_update=NO ACTION, on_delete=RESTRICT)

Indexes:
- `idx_mabang_sku_image_sync_runs_account` (unique=false, origin=c, partial=false): [account_id, created_at DESC]; CREATE INDEX idx_mabang_sku_image_sync_runs_account   ON mabang_sku_image_sync_runs(account_id, created_at DESC)
- `idx_mabang_sku_image_sync_runs_status` (unique=false, origin=c, partial=false): [status, created_at DESC]; CREATE INDEX idx_mabang_sku_image_sync_runs_status   ON mabang_sku_image_sync_runs(status, created_at DESC)
- `sqlite_autoindex_mabang_sku_image_sync_runs_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## managed_files

- Rows: 7
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
lifecycle_item_id | type=TEXT | not_null=true | default=(none) | pk_order=0
scan_id | type=TEXT | not_null=true | default=(none) | pk_order=0
root_key | type=TEXT | not_null=true | default=(none) | pk_order=0
relative_path | type=TEXT | not_null=true | default=(none) | pk_order=0
source_type | type=TEXT | not_null=true | default=(none) | pk_order=0
job_id | type=TEXT | not_null=false | default=(none) | pk_order=0
mime_type | type=TEXT | not_null=true | default=(none) | pk_order=0
file_size | type=INTEGER | not_null=true | default=(none) | pk_order=0
file_hash | type=TEXT | not_null=true | default=(none) | pk_order=0
file_created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
status | type=TEXT | not_null=true | default='available' | pk_order=0
metadata_json | type=TEXT | not_null=true | default='{}' | pk_order=0
registered_at | type=TEXT | not_null=true | default=(none) | pk_order=0
updated_at | type=TEXT | not_null=true | default=(none) | pk_order=0
deleted_at | type=TEXT | not_null=false | default=(none) | pk_order=0
```

Foreign keys:
- `scan_id` -> `file_lifecycle_scans.id` (id=0, seq=0, on_update=NO ACTION, on_delete=RESTRICT)
- `lifecycle_item_id` -> `file_lifecycle_items.id` (id=1, seq=0, on_update=NO ACTION, on_delete=RESTRICT)

Indexes:
- `idx_managed_files_job` (unique=false, origin=c, partial=false): [job_id, source_type]; CREATE INDEX idx_managed_files_job   ON managed_files(job_id, source_type)
- `idx_managed_files_source` (unique=false, origin=c, partial=false): [source_type, status, registered_at DESC]; CREATE INDEX idx_managed_files_source   ON managed_files(source_type, status, registered_at DESC)
- `sqlite_autoindex_managed_files_3` (unique=true, origin=u, partial=false): [root_key, relative_path]; (implicit)
- `sqlite_autoindex_managed_files_2` (unique=true, origin=u, partial=false): [lifecycle_item_id]; (implicit)
- `sqlite_autoindex_managed_files_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## operation_audit_events

- Rows: 41,994
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
request_id | type=TEXT | not_null=true | default=(none) | pk_order=0
occurred_at | type=TEXT | not_null=true | default=(none) | pk_order=0
module | type=TEXT | not_null=true | default=(none) | pk_order=0
action | type=TEXT | not_null=true | default=(none) | pk_order=0
http_method | type=TEXT | not_null=false | default=(none) | pk_order=0
request_path | type=TEXT | not_null=false | default=(none) | pk_order=0
status | type=TEXT | not_null=true | default=(none) | pk_order=0
http_status | type=INTEGER | not_null=false | default=(none) | pk_order=0
duration_ms | type=INTEGER | not_null=false | default=(none) | pk_order=0
source_ip | type=TEXT | not_null=false | default=(none) | pk_order=0
actor_type | type=TEXT | not_null=false | default=(none) | pk_order=0
actor_identifier | type=TEXT | not_null=false | default=(none) | pk_order=0
task_id | type=TEXT | not_null=false | default=(none) | pk_order=0
run_id | type=TEXT | not_null=false | default=(none) | pk_order=0
file_id | type=TEXT | not_null=false | default=(none) | pk_order=0
error_stage | type=TEXT | not_null=false | default=(none) | pk_order=0
error_code | type=TEXT | not_null=false | default=(none) | pk_order=0
error_summary | type=TEXT | not_null=false | default=(none) | pk_order=0
metadata_json | type=TEXT | not_null=true | default='{}' | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- none

Indexes:
- `idx_operation_audit_status` (unique=false, origin=c, partial=false): [status, occurred_at DESC]; CREATE INDEX idx_operation_audit_status ON operation_audit_events(status, occurred_at DESC)
- `idx_operation_audit_action` (unique=false, origin=c, partial=false): [action, occurred_at DESC]; CREATE INDEX idx_operation_audit_action ON operation_audit_events(action, occurred_at DESC)
- `idx_operation_audit_module` (unique=false, origin=c, partial=false): [module, occurred_at DESC]; CREATE INDEX idx_operation_audit_module ON operation_audit_events(module, occurred_at DESC)
- `idx_operation_audit_occurred_at` (unique=false, origin=c, partial=false): [occurred_at DESC]; CREATE INDEX idx_operation_audit_occurred_at ON operation_audit_events(occurred_at DESC)
- `sqlite_autoindex_operation_audit_events_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## price_control_automation_settings

- Rows: 1
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
enabled | type=INTEGER | not_null=true | default=0 | pk_order=0
interval_minutes | type=INTEGER | not_null=true | default=60 | pk_order=0
dingtalk_config_id | type=TEXT | not_null=false | default=(none) | pk_order=0
notify_on_change | type=INTEGER | not_null=true | default=1 | pk_order=0
notify_on_failure | type=INTEGER | not_null=true | default=1 | pk_order=0
last_run_at | type=TEXT | not_null=false | default=(none) | pk_order=0
last_run_status | type=TEXT | not_null=false | default=(none) | pk_order=0
last_notification_at | type=TEXT | not_null=false | default=(none) | pk_order=0
last_notification_status | type=TEXT | not_null=false | default=(none) | pk_order=0
next_run_at | type=TEXT | not_null=false | default=(none) | pk_order=0
last_error_code | type=TEXT | not_null=false | default=(none) | pk_order=0
last_error_message | type=TEXT | not_null=false | default=(none) | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
updated_at | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- `dingtalk_config_id` -> `dingtalk_robot_configs.id` (id=0, seq=0, on_update=NO ACTION, on_delete=SET NULL)

Indexes:
- `idx_price_control_automation_due` (unique=false, origin=c, partial=false): [enabled, next_run_at]; CREATE INDEX idx_price_control_automation_due   ON price_control_automation_settings(enabled,next_run_at)
- `sqlite_autoindex_price_control_automation_settings_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## price_control_price_snapshots

- Rows: 396,815
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
sync_run_id | type=TEXT | not_null=true | default=(none) | pk_order=0
apply_no | type=TEXT | not_null=true | default=(none) | pk_order=0
source_row_key | type=TEXT | not_null=true | default=(none) | pk_order=0
price_key | type=TEXT | not_null=true | default=(none) | pk_order=0
country_code | type=TEXT | not_null=true | default=(none) | pk_order=0
category_name | type=TEXT | not_null=false | default=(none) | pk_order=0
sku | type=TEXT | not_null=true | default=(none) | pk_order=0
product_name_cn | type=TEXT | not_null=false | default=(none) | pk_order=0
sku_status | type=TEXT | not_null=false | default=(none) | pk_order=0
platform | type=TEXT | not_null=true | default=(none) | pk_order=0
shop_type | type=TEXT | not_null=true | default=(none) | pk_order=0
price_type | type=TEXT | not_null=true | default=(none) | pk_order=0
price_value | type=TEXT | not_null=true | default=(none) | pk_order=0
effective_at | type=TEXT | not_null=true | default=(none) | pk_order=0
row_fingerprint | type=TEXT | not_null=true | default=(none) | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- `apply_no` -> `price_control_source_batches.apply_no` (id=0, seq=0, on_update=NO ACTION, on_delete=RESTRICT)
- `sync_run_id` -> `price_control_sync_runs.id` (id=1, seq=0, on_update=NO ACTION, on_delete=RESTRICT)

Indexes:
- `idx_price_control_snapshots_lookup` (unique=false, origin=c, partial=false): [country_code, sku, effective_at DESC]; CREATE INDEX idx_price_control_snapshots_lookup   ON price_control_price_snapshots(country_code,sku,effective_at DESC)
- `sqlite_autoindex_price_control_price_snapshots_2` (unique=true, origin=u, partial=false): [apply_no, price_key]; (implicit)
- `sqlite_autoindex_price_control_price_snapshots_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## price_control_source_batches

- Rows: 71
- Primary key: `apply_no`

Columns:

```text
apply_no | type=TEXT | not_null=false | default=(none) | pk_order=1
country_code | type=TEXT | not_null=true | default=(none) | pk_order=0
approval_status | type=TEXT | not_null=true | default=(none) | pk_order=0
source_row_count | type=INTEGER | not_null=true | default=0 | pk_order=0
batch_fingerprint | type=TEXT | not_null=true | default=(none) | pk_order=0
apply_created_at | type=TEXT | not_null=false | default=(none) | pk_order=0
submitted_at | type=TEXT | not_null=false | default=(none) | pk_order=0
approved_at | type=TEXT | not_null=false | default=(none) | pk_order=0
effective_at | type=TEXT | not_null=true | default=(none) | pk_order=0
first_seen_at | type=TEXT | not_null=true | default=(none) | pk_order=0
last_seen_at | type=TEXT | not_null=true | default=(none) | pk_order=0
last_sync_run_id | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- `last_sync_run_id` -> `price_control_sync_runs.id` (id=0, seq=0, on_update=NO ACTION, on_delete=RESTRICT)

Indexes:
- `idx_price_control_batches_effective` (unique=false, origin=c, partial=false): [country_code, effective_at DESC, apply_no]; CREATE INDEX idx_price_control_batches_effective   ON price_control_source_batches(country_code,effective_at DESC,apply_no)
- `sqlite_autoindex_price_control_source_batches_1` (unique=true, origin=pk, partial=false): [apply_no]; (implicit)

## price_control_sync_runs

- Rows: 1
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
foundation_source_run_id | type=TEXT | not_null=false | default=(none) | pk_order=0
trigger_type | type=TEXT | not_null=true | default=(none) | pk_order=0
sync_mode | type=TEXT | not_null=true | default=(none) | pk_order=0
status | type=TEXT | not_null=true | default=(none) | pk_order=0
source_version | type=TEXT | not_null=false | default=(none) | pk_order=0
source_checked_at | type=TEXT | not_null=false | default=(none) | pk_order=0
source_table_updated_at | type=TEXT | not_null=false | default=(none) | pk_order=0
source_business_updated_at | type=TEXT | not_null=false | default=(none) | pk_order=0
fetched_at | type=TEXT | not_null=false | default=(none) | pk_order=0
watermark_at | type=TEXT | not_null=false | default=(none) | pk_order=0
batches_seen | type=INTEGER | not_null=true | default=0 | pk_order=0
batches_applied | type=INTEGER | not_null=true | default=0 | pk_order=0
source_rows_seen | type=INTEGER | not_null=true | default=0 | pk_order=0
price_points_seen | type=INTEGER | not_null=true | default=0 | pk_order=0
change_count | type=INTEGER | not_null=true | default=0 | pk_order=0
input_fingerprint | type=TEXT | not_null=true | default=(none) | pk_order=0
error_code | type=TEXT | not_null=false | default=(none) | pk_order=0
error_message | type=TEXT | not_null=false | default=(none) | pk_order=0
started_at | type=TEXT | not_null=false | default=(none) | pk_order=0
finished_at | type=TEXT | not_null=false | default=(none) | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
updated_at | type=TEXT | not_null=true | default=(none) | pk_order=0
notification_status | type=TEXT | not_null=false | default=(none) | pk_order=0
notified_at | type=TEXT | not_null=false | default=(none) | pk_order=0
notification_error_code | type=TEXT | not_null=false | default=(none) | pk_order=0
```

Foreign keys:
- `foundation_source_run_id` -> `foundation_source_runs.id` (id=0, seq=0, on_update=NO ACTION, on_delete=SET NULL)

Indexes:
- `uq_price_control_one_running_sync` (unique=true, origin=c, partial=true): [<expression>]; CREATE UNIQUE INDEX uq_price_control_one_running_sync   ON price_control_sync_runs((1)) WHERE status='RUNNING'
- `idx_price_control_sync_runs_status` (unique=false, origin=c, partial=false): [status, created_at DESC]; CREATE INDEX idx_price_control_sync_runs_status   ON price_control_sync_runs(status,created_at DESC)
- `sqlite_autoindex_price_control_sync_runs_2` (unique=true, origin=u, partial=false): [foundation_source_run_id]; (implicit)
- `sqlite_autoindex_price_control_sync_runs_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

