# Commerce Ops SQLite Tables 02

Snapshot date: 2026-08-05

This appendix records exact SQLite fields, keys, foreign keys, indexes, and row counts.

## foundation_source_systems

- Rows: 7
- Primary key: `code`

Columns:

```text
code | type=TEXT | not_null=false | default=(none) | pk_order=1
source_type | type=TEXT | not_null=true | default=(none) | pk_order=0
display_name | type=TEXT | not_null=true | default=(none) | pk_order=0
status | type=TEXT | not_null=true | default='active' | pk_order=0
metadata_json | type=TEXT | not_null=true | default='{}' | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
updated_at | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- none

Indexes:
- `sqlite_autoindex_foundation_source_systems_1` (unique=true, origin=pk, partial=false): [code]; (implicit)

## foundation_task_events

- Rows: 223
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
task_id | type=TEXT | not_null=true | default=(none) | pk_order=0
event_type | type=TEXT | not_null=true | default=(none) | pk_order=0
from_state | type=TEXT | not_null=false | default=(none) | pk_order=0
to_state | type=TEXT | not_null=true | default=(none) | pk_order=0
source_state | type=TEXT | not_null=false | default=(none) | pk_order=0
actor_type | type=TEXT | not_null=true | default=(none) | pk_order=0
actor_id | type=TEXT | not_null=true | default=(none) | pk_order=0
reason_code | type=TEXT | not_null=false | default=(none) | pk_order=0
message | type=TEXT | not_null=false | default=(none) | pk_order=0
evidence_json | type=TEXT | not_null=true | default='{}' | pk_order=0
idempotency_key | type=TEXT | not_null=true | default=(none) | pk_order=0
task_version | type=INTEGER | not_null=true | default=(none) | pk_order=0
occurred_at | type=TEXT | not_null=true | default=(none) | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- `task_id` -> `foundation_tasks.id` (id=0, seq=0, on_update=NO ACTION, on_delete=CASCADE)

Indexes:
- `idx_foundation_task_events_history` (unique=false, origin=c, partial=false): [task_id, task_version DESC]; CREATE INDEX idx_foundation_task_events_history   ON foundation_task_events(task_id, task_version DESC)
- `sqlite_autoindex_foundation_task_events_3` (unique=true, origin=u, partial=false): [task_id, task_version]; (implicit)
- `sqlite_autoindex_foundation_task_events_2` (unique=true, origin=u, partial=false): [task_id, idempotency_key]; (implicit)
- `sqlite_autoindex_foundation_task_events_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## foundation_task_leases

- Rows: 0
- Primary key: `task_id`

Columns:

```text
task_id | type=TEXT | not_null=false | default=(none) | pk_order=1
lease_owner | type=TEXT | not_null=true | default=(none) | pk_order=0
lease_token | type=TEXT | not_null=true | default=(none) | pk_order=0
acquired_at | type=TEXT | not_null=true | default=(none) | pk_order=0
renewed_at | type=TEXT | not_null=true | default=(none) | pk_order=0
expires_at | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- `task_id` -> `foundation_tasks.id` (id=0, seq=0, on_update=NO ACTION, on_delete=CASCADE)

Indexes:
- `idx_foundation_task_leases_expiry` (unique=false, origin=c, partial=false): [expires_at]; CREATE INDEX idx_foundation_task_leases_expiry   ON foundation_task_leases(expires_at)
- `sqlite_autoindex_foundation_task_leases_2` (unique=true, origin=u, partial=false): [lease_token]; (implicit)
- `sqlite_autoindex_foundation_task_leases_1` (unique=true, origin=pk, partial=false): [task_id]; (implicit)

## foundation_tasks

- Rows: 217
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
domain | type=TEXT | not_null=true | default=(none) | pk_order=0
task_kind | type=TEXT | not_null=true | default=(none) | pk_order=0
execution_mode | type=TEXT | not_null=true | default=(none) | pk_order=0
authority_mode | type=TEXT | not_null=true | default='projection' | pk_order=0
domain_ref_type | type=TEXT | not_null=true | default=(none) | pk_order=0
domain_ref_id | type=TEXT | not_null=true | default=(none) | pk_order=0
source_state | type=TEXT | not_null=false | default=(none) | pk_order=0
state | type=TEXT | not_null=true | default=(none) | pk_order=0
priority | type=TEXT | not_null=true | default='P2' | pk_order=0
account_id | type=TEXT | not_null=false | default=(none) | pk_order=0
source_run_id | type=TEXT | not_null=false | default=(none) | pk_order=0
owner_id | type=TEXT | not_null=false | default=(none) | pk_order=0
store_id | type=TEXT | not_null=false | default=(none) | pk_order=0
warehouse_id | type=TEXT | not_null=false | default=(none) | pk_order=0
sku_id | type=TEXT | not_null=false | default=(none) | pk_order=0
idempotency_key | type=TEXT | not_null=true | default=(none) | pk_order=0
attempt_count | type=INTEGER | not_null=true | default=0 | pk_order=0
max_attempts | type=INTEGER | not_null=true | default=3 | pk_order=0
available_at | type=TEXT | not_null=false | default=(none) | pk_order=0
started_at | type=TEXT | not_null=false | default=(none) | pk_order=0
finished_at | type=TEXT | not_null=false | default=(none) | pk_order=0
input_json | type=TEXT | not_null=true | default='{}' | pk_order=0
evidence_json | type=TEXT | not_null=true | default='{}' | pk_order=0
result_json | type=TEXT | not_null=true | default='{}' | pk_order=0
last_error_code | type=TEXT | not_null=false | default=(none) | pk_order=0
last_error_message | type=TEXT | not_null=false | default=(none) | pk_order=0
state_version | type=INTEGER | not_null=true | default=1 | pk_order=0
created_by | type=TEXT | not_null=true | default=(none) | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
updated_at | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- `sku_id` -> `product_skus.id` (id=0, seq=0, on_update=NO ACTION, on_delete=SET NULL)
- `warehouse_id` -> `foundation_warehouses.id` (id=1, seq=0, on_update=NO ACTION, on_delete=SET NULL)
- `store_id` -> `growth_shops.id` (id=2, seq=0, on_update=NO ACTION, on_delete=SET NULL)
- `owner_id` -> `foundation_owners.id` (id=3, seq=0, on_update=NO ACTION, on_delete=SET NULL)
- `source_run_id` -> `foundation_source_runs.id` (id=4, seq=0, on_update=NO ACTION, on_delete=SET NULL)
- `account_id` -> `foundation_integration_accounts.id` (id=5, seq=0, on_update=NO ACTION, on_delete=SET NULL)

Indexes:
- `idx_foundation_tasks_owner` (unique=false, origin=c, partial=false): [owner_id, state, priority, updated_at DESC]; CREATE INDEX idx_foundation_tasks_owner   ON foundation_tasks(owner_id, state, priority, updated_at DESC)
- `idx_foundation_tasks_domain` (unique=false, origin=c, partial=false): [domain, task_kind, state, updated_at DESC]; CREATE INDEX idx_foundation_tasks_domain   ON foundation_tasks(domain, task_kind, state, updated_at DESC)
- `idx_foundation_tasks_queue` (unique=false, origin=c, partial=false): [state, priority, available_at, created_at]; CREATE INDEX idx_foundation_tasks_queue   ON foundation_tasks(state, priority, available_at, created_at)
- `sqlite_autoindex_foundation_tasks_3` (unique=true, origin=u, partial=false): [domain, idempotency_key]; (implicit)
- `sqlite_autoindex_foundation_tasks_2` (unique=true, origin=u, partial=false): [domain, domain_ref_type, domain_ref_id]; (implicit)
- `sqlite_autoindex_foundation_tasks_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## foundation_warehouses

- Rows: 29
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
canonical_key | type=TEXT | not_null=true | default=(none) | pk_order=0
display_name | type=TEXT | not_null=true | default=(none) | pk_order=0
normalized_name | type=TEXT | not_null=true | default=(none) | pk_order=0
country_code | type=TEXT | not_null=false | default=(none) | pk_order=0
country_name | type=TEXT | not_null=false | default=(none) | pk_order=0
identity_status | type=TEXT | not_null=true | default='review_required' | pk_order=0
metadata_json | type=TEXT | not_null=true | default='{}' | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
updated_at | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- none

Indexes:
- `idx_foundation_warehouses_country_status` (unique=false, origin=c, partial=false): [country_code, identity_status, display_name]; CREATE INDEX idx_foundation_warehouses_country_status   ON foundation_warehouses(country_code, identity_status, display_name)
- `sqlite_autoindex_foundation_warehouses_2` (unique=true, origin=u, partial=false): [canonical_key]; (implicit)
- `sqlite_autoindex_foundation_warehouses_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## growth_analysis_runs

- Rows: 0
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
analysis_date | type=TEXT | not_null=true | default=(none) | pk_order=0
inventory_batch_id | type=TEXT | not_null=true | default=(none) | pk_order=0
order_watermark_at | type=TEXT | not_null=true | default=(none) | pk_order=0
rule_set_id | type=TEXT | not_null=true | default=(none) | pk_order=0
country_mapping_set_id | type=TEXT | not_null=true | default=(none) | pk_order=0
shop_scope_fingerprint | type=TEXT | not_null=true | default=(none) | pk_order=0
input_fingerprint | type=TEXT | not_null=true | default=(none) | pk_order=0
status | type=TEXT | not_null=true | default=(none) | pk_order=0
quality_status | type=TEXT | not_null=true | default=(none) | pk_order=0
quality_summary_json | type=TEXT | not_null=true | default='{}' | pk_order=0
global_sku_count | type=INTEGER | not_null=true | default=0 | pk_order=0
country_sku_count | type=INTEGER | not_null=true | default=0 | pk_order=0
shop_count | type=INTEGER | not_null=true | default=0 | pk_order=0
shop_sku_count | type=INTEGER | not_null=true | default=0 | pk_order=0
signal_count | type=INTEGER | not_null=true | default=0 | pk_order=0
started_at | type=TEXT | not_null=false | default=(none) | pk_order=0
validated_at | type=TEXT | not_null=false | default=(none) | pk_order=0
published_at | type=TEXT | not_null=false | default=(none) | pk_order=0
finished_at | type=TEXT | not_null=false | default=(none) | pk_order=0
error_code | type=TEXT | not_null=false | default=(none) | pk_order=0
error_summary | type=TEXT | not_null=false | default=(none) | pk_order=0
created_by | type=TEXT | not_null=true | default=(none) | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
updated_at | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- `country_mapping_set_id` -> `growth_country_mapping_sets.id` (id=0, seq=0, on_update=NO ACTION, on_delete=RESTRICT)
- `rule_set_id` -> `growth_rule_sets.id` (id=1, seq=0, on_update=NO ACTION, on_delete=RESTRICT)
- `inventory_batch_id` -> `growth_source_batches.id` (id=2, seq=0, on_update=NO ACTION, on_delete=RESTRICT)

Indexes:
- `idx_growth_analysis_runs_inventory` (unique=false, origin=c, partial=false): [inventory_batch_id, created_at DESC]; CREATE INDEX idx_growth_analysis_runs_inventory   ON growth_analysis_runs(inventory_batch_id, created_at DESC)
- `idx_growth_analysis_runs_published` (unique=false, origin=c, partial=false): [status, analysis_date DESC, published_at DESC]; CREATE INDEX idx_growth_analysis_runs_published   ON growth_analysis_runs(status, analysis_date DESC, published_at DESC)
- `sqlite_autoindex_growth_analysis_runs_2` (unique=true, origin=u, partial=false): [input_fingerprint]; (implicit)
- `sqlite_autoindex_growth_analysis_runs_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## growth_country_mapping_sets

- Rows: 2
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
version | type=TEXT | not_null=true | default=(none) | pk_order=0
status | type=TEXT | not_null=true | default=(none) | pk_order=0
description | type=TEXT | not_null=true | default=(none) | pk_order=0
content_sha256 | type=TEXT | not_null=true | default=(none) | pk_order=0
created_by | type=TEXT | not_null=true | default=(none) | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
activated_by | type=TEXT | not_null=false | default=(none) | pk_order=0
activated_at | type=TEXT | not_null=false | default=(none) | pk_order=0
retired_by | type=TEXT | not_null=false | default=(none) | pk_order=0
retired_at | type=TEXT | not_null=false | default=(none) | pk_order=0
```

Foreign keys:
- none

Indexes:
- `uq_growth_country_mapping_sets_active` (unique=true, origin=c, partial=true): [status]; CREATE UNIQUE INDEX uq_growth_country_mapping_sets_active   ON growth_country_mapping_sets(status)   WHERE status = 'active'
- `sqlite_autoindex_growth_country_mapping_sets_3` (unique=true, origin=u, partial=false): [content_sha256]; (implicit)
- `sqlite_autoindex_growth_country_mapping_sets_2` (unique=true, origin=u, partial=false): [version]; (implicit)
- `sqlite_autoindex_growth_country_mapping_sets_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## growth_data_quality_issues

- Rows: 36,671
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
issue_key | type=TEXT | not_null=true | default=(none) | pk_order=0
batch_id | type=TEXT | not_null=true | default=(none) | pk_order=0
entity_type | type=TEXT | not_null=true | default=(none) | pk_order=0
entity_id | type=TEXT | not_null=false | default=(none) | pk_order=0
issue_code | type=TEXT | not_null=true | default=(none) | pk_order=0
severity | type=TEXT | not_null=true | default=(none) | pk_order=0
message | type=TEXT | not_null=true | default=(none) | pk_order=0
source_context_json | type=TEXT | not_null=true | default='{}' | pk_order=0
status | type=TEXT | not_null=true | default='open' | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
resolved_at | type=TEXT | not_null=false | default=(none) | pk_order=0
```

Foreign keys:
- `batch_id` -> `growth_source_batches.id` (id=0, seq=0, on_update=NO ACTION, on_delete=RESTRICT)

Indexes:
- `idx_growth_data_quality_status` (unique=false, origin=c, partial=false): [status, severity, created_at DESC]; CREATE INDEX idx_growth_data_quality_status    ON growth_data_quality_issues(status, severity, created_at DESC)
- `sqlite_autoindex_growth_data_quality_issues_2` (unique=true, origin=u, partial=false): [issue_key]; (implicit)
- `sqlite_autoindex_growth_data_quality_issues_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## growth_focus_item_events

- Rows: 0
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
focus_item_id | type=TEXT | not_null=true | default=(none) | pk_order=0
event_type | type=TEXT | not_null=true | default=(none) | pk_order=0
task_revision | type=INTEGER | not_null=true | default=(none) | pk_order=0
from_status | type=TEXT | not_null=false | default=(none) | pk_order=0
to_status | type=TEXT | not_null=true | default=(none) | pk_order=0
actor_user_id | type=TEXT | not_null=true | default=(none) | pk_order=0
actor_type | type=TEXT | not_null=true | default=(none) | pk_order=0
reason_code | type=TEXT | not_null=false | default=(none) | pk_order=0
note | type=TEXT | not_null=false | default=(none) | pk_order=0
signal_id | type=TEXT | not_null=false | default=(none) | pk_order=0
analysis_run_id | type=TEXT | not_null=false | default=(none) | pk_order=0
evidence_snapshot_json | type=TEXT | not_null=true | default='{}' | pk_order=0
idempotency_key | type=TEXT | not_null=true | default=(none) | pk_order=0
occurred_at | type=TEXT | not_null=true | default=(none) | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- `analysis_run_id` -> `growth_analysis_runs.id` (id=0, seq=0, on_update=NO ACTION, on_delete=RESTRICT)
- `signal_id` -> `growth_signals.id` (id=1, seq=0, on_update=NO ACTION, on_delete=RESTRICT)
- `focus_item_id` -> `growth_focus_items.id` (id=2, seq=0, on_update=NO ACTION, on_delete=RESTRICT)

Indexes:
- `idx_growth_focus_item_events_analysis` (unique=false, origin=c, partial=false): [analysis_run_id, event_type, occurred_at DESC]; CREATE INDEX idx_growth_focus_item_events_analysis   ON growth_focus_item_events(analysis_run_id, event_type, occurred_at DESC)
- `idx_growth_focus_item_events_history` (unique=false, origin=c, partial=false): [focus_item_id, task_revision DESC]; CREATE INDEX idx_growth_focus_item_events_history   ON growth_focus_item_events(focus_item_id, task_revision DESC)
- `sqlite_autoindex_growth_focus_item_events_3` (unique=true, origin=u, partial=false): [focus_item_id, task_revision]; (implicit)
- `sqlite_autoindex_growth_focus_item_events_2` (unique=true, origin=u, partial=false): [focus_item_id, idempotency_key]; (implicit)
- `sqlite_autoindex_growth_focus_item_events_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## growth_focus_items

- Rows: 0
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
task_key | type=TEXT | not_null=true | default=(none) | pk_order=0
task_type | type=TEXT | not_null=true | default=(none) | pk_order=0
current_signal_id | type=TEXT | not_null=false | default=(none) | pk_order=0
first_analysis_run_id | type=TEXT | not_null=true | default=(none) | pk_order=0
last_analysis_run_id | type=TEXT | not_null=true | default=(none) | pk_order=0
owner_user_id | type=TEXT | not_null=false | default=(none) | pk_order=0
internal_shop_id | type=TEXT | not_null=false | default=(none) | pk_order=0
country_code | type=TEXT | not_null=false | default=(none) | pk_order=0
source_warehouse_name | type=TEXT | not_null=false | default=(none) | pk_order=0
normalized_warehouse_name | type=TEXT | not_null=false | default=(none) | pk_order=0
platform | type=TEXT | not_null=false | default=(none) | pk_order=0
category_l1 | type=TEXT | not_null=false | default=(none) | pk_order=0
category_l2 | type=TEXT | not_null=false | default=(none) | pk_order=0
subject_type | type=TEXT | not_null=true | default=(none) | pk_order=0
normalized_source_sku | type=TEXT | not_null=false | default=(none) | pk_order=0
priority | type=TEXT | not_null=true | default=(none) | pk_order=0
status | type=TEXT | not_null=true | default='NEW' | pk_order=0
reason_code | type=TEXT | not_null=true | default=(none) | pk_order=0
recommended_action_code | type=TEXT | not_null=true | default=(none) | pk_order=0
evidence_snapshot_json | type=TEXT | not_null=true | default='{}' | pk_order=0
consecutive_hit_count | type=INTEGER | not_null=true | default=1 | pk_order=0
is_hit_in_latest_run | type=INTEGER | not_null=true | default=1 | pk_order=0
first_detected_at | type=TEXT | not_null=true | default=(none) | pk_order=0
last_detected_at | type=TEXT | not_null=true | default=(none) | pk_order=0
acknowledged_at | type=TEXT | not_null=false | default=(none) | pk_order=0
started_at | type=TEXT | not_null=false | default=(none) | pk_order=0
due_at | type=TEXT | not_null=false | default=(none) | pk_order=0
snoozed_until | type=TEXT | not_null=false | default=(none) | pk_order=0
blocked_reason_code | type=TEXT | not_null=false | default=(none) | pk_order=0
resolution_code | type=TEXT | not_null=false | default=(none) | pk_order=0
resolution_note | type=TEXT | not_null=false | default=(none) | pk_order=0
resolved_at | type=TEXT | not_null=false | default=(none) | pk_order=0
revision | type=INTEGER | not_null=true | default=1 | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
updated_at | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- `internal_shop_id` -> `growth_shops.id` (id=0, seq=0, on_update=NO ACTION, on_delete=RESTRICT)
- `last_analysis_run_id` -> `growth_analysis_runs.id` (id=1, seq=0, on_update=NO ACTION, on_delete=RESTRICT)
- `first_analysis_run_id` -> `growth_analysis_runs.id` (id=2, seq=0, on_update=NO ACTION, on_delete=RESTRICT)
- `current_signal_id` -> `growth_signals.id` (id=3, seq=0, on_update=NO ACTION, on_delete=RESTRICT)

Indexes:
- `idx_growth_focus_items_warehouse` (unique=false, origin=c, partial=false): [country_code, normalized_warehouse_name, normalized_source_sku, status, priority]; CREATE INDEX idx_growth_focus_items_warehouse   ON growth_focus_items(     country_code,     normalized_warehouse_name,     normalized_source_sku,     status,     priority   )
- `idx_growth_focus_items_latest_run` (unique=false, origin=c, partial=false): [last_analysis_run_id, is_hit_in_latest_run, task_type]; CREATE INDEX idx_growth_focus_items_latest_run   ON growth_focus_items(last_analysis_run_id, is_hit_in_latest_run, task_type)
- `idx_growth_focus_items_shop_queue` (unique=false, origin=c, partial=false): [internal_shop_id, status, priority, last_detected_at DESC]; CREATE INDEX idx_growth_focus_items_shop_queue   ON growth_focus_items(     internal_shop_id,     status,     priority,     last_detected_at DESC   )
- `idx_growth_focus_items_owner_queue` (unique=false, origin=c, partial=false): [owner_user_id, status, priority, is_hit_in_latest_run, last_detected_at DESC]; CREATE INDEX idx_growth_focus_items_owner_queue   ON growth_focus_items(     owner_user_id,     status,     priority,     is_hit_in_latest_run,     last_detected_at DESC   )
- `uq_growth_focus_items_active_task` (unique=true, origin=c, partial=true): [task_key]; CREATE UNIQUE INDEX uq_growth_focus_items_active_task   ON growth_focus_items(task_key)   WHERE status IN (     'NEW',     'ACKNOWLEDGED',     'IN_PROGRESS',     'MONITORING',     'BLOCKED',     'REOPENED'   )
- `sqlite_autoindex_growth_focus_items_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## growth_inventory_raw_rows

- Rows: 61,560
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
batch_id | type=TEXT | not_null=true | default=(none) | pk_order=0
sheet_name | type=TEXT | not_null=true | default=(none) | pk_order=0
source_row_number | type=INTEGER | not_null=true | default=(none) | pk_order=0
raw_values_json | type=TEXT | not_null=true | default=(none) | pk_order=0
raw_types_json | type=TEXT | not_null=true | default=(none) | pk_order=0
redacted_fields_json | type=TEXT | not_null=true | default='[]' | pk_order=0
row_hash | type=TEXT | not_null=true | default=(none) | pk_order=0
parse_status | type=TEXT | not_null=true | default=(none) | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- `batch_id` -> `growth_source_batches.id` (id=0, seq=0, on_update=NO ACTION, on_delete=RESTRICT)

Indexes:
- `idx_growth_inventory_raw_rows_hash` (unique=false, origin=c, partial=false): [row_hash]; CREATE INDEX idx_growth_inventory_raw_rows_hash    ON growth_inventory_raw_rows(row_hash)
- `sqlite_autoindex_growth_inventory_raw_rows_2` (unique=true, origin=u, partial=false): [batch_id, source_row_number]; (implicit)
- `sqlite_autoindex_growth_inventory_raw_rows_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

