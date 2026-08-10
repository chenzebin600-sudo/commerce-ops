# Commerce Ops SQLite Tables 04

Snapshot date: 2026-08-05

This appendix records exact SQLite fields, keys, foreign keys, indexes, and row counts.

## growth_shop_sku_observations

- Rows: 11,846
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
observation_key | type=TEXT | not_null=true | default=(none) | pk_order=0
coverage_semantic | type=TEXT | not_null=true | default='historical_observed' | pk_order=0
platform | type=TEXT | not_null=true | default=(none) | pk_order=0
source_shop_name | type=TEXT | not_null=true | default=(none) | pk_order=0
normalized_source_shop_name | type=TEXT | not_null=true | default=(none) | pk_order=0
internal_shop_id | type=TEXT | not_null=false | default=(none) | pk_order=0
source_sku | type=TEXT | not_null=true | default=(none) | pk_order=0
normalized_source_sku | type=TEXT | not_null=true | default=(none) | pk_order=0
mapped_product_id | type=TEXT | not_null=false | default=(none) | pk_order=0
first_observed_at | type=TEXT | not_null=false | default=(none) | pk_order=0
last_observed_at | type=TEXT | not_null=false | default=(none) | pk_order=0
observed_order_count | type=INTEGER | not_null=true | default=0 | pk_order=0
observed_line_count | type=INTEGER | not_null=true | default=0 | pk_order=0
observed_quantity | type=NUMERIC | not_null=true | default=0 | pk_order=0
first_source_batch_id | type=TEXT | not_null=true | default=(none) | pk_order=0
last_source_batch_id | type=TEXT | not_null=true | default=(none) | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
updated_at | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- `last_source_batch_id` -> `growth_source_batches.id` (id=0, seq=0, on_update=NO ACTION, on_delete=RESTRICT)
- `first_source_batch_id` -> `growth_source_batches.id` (id=1, seq=0, on_update=NO ACTION, on_delete=RESTRICT)
- `mapped_product_id` -> `product_skus.id` (id=2, seq=0, on_update=NO ACTION, on_delete=RESTRICT)
- `internal_shop_id` -> `growth_shops.id` (id=3, seq=0, on_update=NO ACTION, on_delete=RESTRICT)

Indexes:
- `idx_growth_shop_sku_observations_shop` (unique=false, origin=c, partial=false): [internal_shop_id, normalized_source_sku, last_observed_at DESC]; CREATE INDEX idx_growth_shop_sku_observations_shop    ON growth_shop_sku_observations(internal_shop_id, normalized_source_sku, last_observed_at DESC)
- `sqlite_autoindex_growth_shop_sku_observations_2` (unique=true, origin=u, partial=false): [observation_key]; (implicit)
- `sqlite_autoindex_growth_shop_sku_observations_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## growth_shop_source_mappings

- Rows: 131
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
source_system | type=TEXT | not_null=true | default=(none) | pk_order=0
source_shop_name | type=TEXT | not_null=true | default=(none) | pk_order=0
normalized_source_shop_name | type=TEXT | not_null=true | default=(none) | pk_order=0
internal_shop_id | type=TEXT | not_null=false | default=(none) | pk_order=0
platform | type=TEXT | not_null=true | default=(none) | pk_order=0
country_code | type=TEXT | not_null=false | default=(none) | pk_order=0
mapping_status | type=TEXT | not_null=true | default=(none) | pk_order=0
mapping_source | type=TEXT | not_null=true | default=(none) | pk_order=0
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
- `internal_shop_id` -> `growth_shops.id` (id=2, seq=0, on_update=NO ACTION, on_delete=RESTRICT)

Indexes:
- `idx_growth_shop_mappings_status` (unique=false, origin=c, partial=false): [mapping_status, platform, updated_at DESC]; CREATE INDEX idx_growth_shop_mappings_status    ON growth_shop_source_mappings(mapping_status, platform, updated_at DESC)
- `sqlite_autoindex_growth_shop_source_mappings_2` (unique=true, origin=u, partial=false): [source_system, platform, normalized_source_shop_name]; (implicit)
- `sqlite_autoindex_growth_shop_source_mappings_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## growth_shops

- Rows: 131
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
internal_shop_code | type=TEXT | not_null=true | default=(none) | pk_order=0
display_name | type=TEXT | not_null=true | default=(none) | pk_order=0
platform | type=TEXT | not_null=true | default=(none) | pk_order=0
country_code | type=TEXT | not_null=true | default=(none) | pk_order=0
country_name | type=TEXT | not_null=true | default=(none) | pk_order=0
owner_user_id | type=TEXT | not_null=false | default=(none) | pk_order=0
primary_category_scope_json | type=TEXT | not_null=true | default='[]' | pk_order=0
status | type=TEXT | not_null=true | default='active' | pk_order=0
identity_status | type=TEXT | not_null=true | default='confirmed' | pk_order=0
revision | type=INTEGER | not_null=true | default=1 | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
updated_at | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- none

Indexes:
- `idx_growth_shops_platform_country` (unique=false, origin=c, partial=false): [platform, country_code, status]; CREATE INDEX idx_growth_shops_platform_country    ON growth_shops(platform, country_code, status)
- `sqlite_autoindex_growth_shops_2` (unique=true, origin=u, partial=false): [internal_shop_code]; (implicit)
- `sqlite_autoindex_growth_shops_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## growth_signals

- Rows: 0
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
analysis_run_id | type=TEXT | not_null=true | default=(none) | pk_order=0
dedupe_key | type=TEXT | not_null=true | default=(none) | pk_order=0
signal_type | type=TEXT | not_null=true | default=(none) | pk_order=0
rule_code | type=TEXT | not_null=true | default=(none) | pk_order=0
rule_version | type=TEXT | not_null=true | default=(none) | pk_order=0
subject_type | type=TEXT | not_null=true | default=(none) | pk_order=0
country_code | type=TEXT | not_null=false | default=(none) | pk_order=0
source_warehouse_name | type=TEXT | not_null=false | default=(none) | pk_order=0
normalized_warehouse_name | type=TEXT | not_null=false | default=(none) | pk_order=0
normalized_source_sku | type=TEXT | not_null=false | default=(none) | pk_order=0
internal_shop_id | type=TEXT | not_null=false | default=(none) | pk_order=0
severity | type=TEXT | not_null=true | default=(none) | pk_order=0
reason_code | type=TEXT | not_null=true | default=(none) | pk_order=0
recommended_action_code | type=TEXT | not_null=true | default=(none) | pk_order=0
availability_status | type=TEXT | not_null=true | default=(none) | pk_order=0
quality_status | type=TEXT | not_null=true | default=(none) | pk_order=0
evidence_json | type=TEXT | not_null=true | default='{}' | pk_order=0
detected_at | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- `internal_shop_id` -> `growth_shops.id` (id=0, seq=0, on_update=NO ACTION, on_delete=RESTRICT)
- `analysis_run_id` -> `growth_analysis_runs.id` (id=1, seq=0, on_update=NO ACTION, on_delete=RESTRICT)

Indexes:
- `idx_growth_signals_warehouse` (unique=false, origin=c, partial=false): [analysis_run_id, country_code, normalized_warehouse_name, normalized_source_sku, signal_type]; CREATE INDEX idx_growth_signals_warehouse   ON growth_signals(     analysis_run_id,     country_code,     normalized_warehouse_name,     normalized_source_sku,     signal_type   )
- `idx_growth_signals_shop` (unique=false, origin=c, partial=false): [analysis_run_id, internal_shop_id, signal_type, severity]; CREATE INDEX idx_growth_signals_shop   ON growth_signals(analysis_run_id, internal_shop_id, signal_type, severity)
- `idx_growth_signals_sku` (unique=false, origin=c, partial=false): [analysis_run_id, normalized_source_sku, internal_shop_id]; CREATE INDEX idx_growth_signals_sku   ON growth_signals(analysis_run_id, normalized_source_sku, internal_shop_id)
- `idx_growth_signals_type` (unique=false, origin=c, partial=false): [analysis_run_id, signal_type, severity, rule_code]; CREATE INDEX idx_growth_signals_type   ON growth_signals(analysis_run_id, signal_type, severity, rule_code)
- `sqlite_autoindex_growth_signals_2` (unique=true, origin=u, partial=false): [analysis_run_id, dedupe_key]; (implicit)
- `sqlite_autoindex_growth_signals_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## growth_sku_daily_metrics

- Rows: 0
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
analysis_run_id | type=TEXT | not_null=true | default=(none) | pk_order=0
analysis_date | type=TEXT | not_null=true | default=(none) | pk_order=0
scope_type | type=TEXT | not_null=true | default=(none) | pk_order=0
scope_key | type=TEXT | not_null=true | default=(none) | pk_order=0
country_code | type=TEXT | not_null=false | default=(none) | pk_order=0
normalized_source_sku | type=TEXT | not_null=true | default=(none) | pk_order=0
source_sku | type=TEXT | not_null=true | default=(none) | pk_order=0
product_name | type=TEXT | not_null=false | default=(none) | pk_order=0
product_status | type=TEXT | not_null=true | default=(none) | pk_order=0
category_l1 | type=TEXT | not_null=false | default=(none) | pk_order=0
category_l2 | type=TEXT | not_null=false | default=(none) | pk_order=0
mapped_product_id | type=TEXT | not_null=false | default=(none) | pk_order=0
mapping_status | type=TEXT | not_null=true | default=(none) | pk_order=0
warehouse_count | type=INTEGER | not_null=true | default=(none) | pk_order=0
available_quantity | type=NUMERIC | not_null=false | default=(none) | pk_order=0
in_transit_quantity | type=NUMERIC | not_null=false | default=(none) | pk_order=0
source_predicted_daily_sales_country_sku | type=NUMERIC | not_null=false | default=(none) | pk_order=0
source_visible_sales_7d | type=NUMERIC | not_null=false | default=(none) | pk_order=0
source_visible_sales_28d | type=NUMERIC | not_null=false | default=(none) | pk_order=0
source_visible_sales_42d | type=NUMERIC | not_null=false | default=(none) | pk_order=0
effective_daily_sales_28d | type=NUMERIC | not_null=false | default=(none) | pk_order=0
computed_days_of_supply | type=NUMERIC | not_null=false | default=(none) | pk_order=0
days_of_supply_status | type=TEXT | not_null=true | default=(none) | pk_order=0
demand_percentile_28d | type=NUMERIC | not_null=false | default=(none) | pk_order=0
assortment_percentile | type=NUMERIC | not_null=false | default=(none) | pk_order=0
inventory_percentile | type=NUMERIC | not_null=false | default=(none) | pk_order=0
comparison_scope | type=TEXT | not_null=false | default=(none) | pk_order=0
comparison_sample_size | type=INTEGER | not_null=false | default=(none) | pk_order=0
assortment_status | type=TEXT | not_null=false | default=(none) | pk_order=0
warehouse_supply_summary_json | type=TEXT | not_null=true | default='{}' | pk_order=0
supply_risk_warehouse_count | type=INTEGER | not_null=true | default=0 | pk_order=0
supply_critical_warehouse_count | type=INTEGER | not_null=true | default=0 | pk_order=0
supply_warning_warehouse_count | type=INTEGER | not_null=true | default=0 | pk_order=0
supply_data_issue_warehouse_count | type=INTEGER | not_null=true | default=0 | pk_order=0
is_source_high_performance | type=INTEGER | not_null=true | default=0 | pk_order=0
is_new | type=INTEGER | not_null=true | default=0 | pk_order=0
new_age_days | type=INTEGER | not_null=false | default=(none) | pk_order=0
availability_status | type=TEXT | not_null=true | default=(none) | pk_order=0
quality_status | type=TEXT | not_null=true | default=(none) | pk_order=0
reason_code | type=TEXT | not_null=true | default=(none) | pk_order=0
metrics_version | type=TEXT | not_null=true | default=(none) | pk_order=0
evidence_json | type=TEXT | not_null=true | default='{}' | pk_order=0
calculated_at | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- `mapped_product_id` -> `product_skus.id` (id=0, seq=0, on_update=NO ACTION, on_delete=RESTRICT)
- `analysis_run_id` -> `growth_analysis_runs.id` (id=1, seq=0, on_update=NO ACTION, on_delete=RESTRICT)

Indexes:
- `idx_growth_sku_metrics_product` (unique=false, origin=c, partial=false): [mapped_product_id, analysis_date DESC]; CREATE INDEX idx_growth_sku_metrics_product   ON growth_sku_daily_metrics(mapped_product_id, analysis_date DESC)
- `idx_growth_sku_metrics_status` (unique=false, origin=c, partial=false): [analysis_run_id, product_status, quality_status]; CREATE INDEX idx_growth_sku_metrics_status   ON growth_sku_daily_metrics(analysis_run_id, product_status, quality_status)
- `idx_growth_sku_metrics_supply_summary` (unique=false, origin=c, partial=false): [analysis_run_id, scope_type, scope_key, supply_risk_warehouse_count DESC]; CREATE INDEX idx_growth_sku_metrics_supply_summary   ON growth_sku_daily_metrics(     analysis_run_id, scope_type, scope_key, supply_risk_warehouse_count DESC   )
- `idx_growth_sku_metrics_demand` (unique=false, origin=c, partial=false): [analysis_run_id, scope_type, scope_key, category_l2, assortment_percentile DESC]; CREATE INDEX idx_growth_sku_metrics_demand   ON growth_sku_daily_metrics(     analysis_run_id, scope_type, scope_key, category_l2, assortment_percentile DESC   )
- `sqlite_autoindex_growth_sku_daily_metrics_2` (unique=true, origin=u, partial=false): [analysis_run_id, scope_type, scope_key, normalized_source_sku]; (implicit)
- `sqlite_autoindex_growth_sku_daily_metrics_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## growth_sku_warehouse_daily_metrics

- Rows: 0
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
analysis_run_id | type=TEXT | not_null=true | default=(none) | pk_order=0
analysis_date | type=TEXT | not_null=true | default=(none) | pk_order=0
country_code | type=TEXT | not_null=true | default=(none) | pk_order=0
source_warehouse_name | type=TEXT | not_null=true | default=(none) | pk_order=0
normalized_warehouse_name | type=TEXT | not_null=true | default=(none) | pk_order=0
normalized_source_sku | type=TEXT | not_null=true | default=(none) | pk_order=0
source_sku | type=TEXT | not_null=true | default=(none) | pk_order=0
product_name | type=TEXT | not_null=false | default=(none) | pk_order=0
product_status | type=TEXT | not_null=true | default=(none) | pk_order=0
category_l1 | type=TEXT | not_null=false | default=(none) | pk_order=0
category_l2 | type=TEXT | not_null=false | default=(none) | pk_order=0
mapped_product_id | type=TEXT | not_null=false | default=(none) | pk_order=0
mapping_status | type=TEXT | not_null=true | default=(none) | pk_order=0
available_quantity | type=NUMERIC | not_null=false | default=(none) | pk_order=0
in_transit_quantity | type=NUMERIC | not_null=false | default=(none) | pk_order=0
source_current_sellable_days | type=NUMERIC | not_null=false | default=(none) | pk_order=0
source_predicted_daily_sales | type=NUMERIC | not_null=false | default=(none) | pk_order=0
source_visible_sales_7d | type=NUMERIC | not_null=false | default=(none) | pk_order=0
source_visible_sales_28d | type=NUMERIC | not_null=false | default=(none) | pk_order=0
source_visible_sales_42d | type=NUMERIC | not_null=false | default=(none) | pk_order=0
supply_status | type=TEXT | not_null=true | default=(none) | pk_order=0
slow_moving_status | type=TEXT | not_null=true | default=(none) | pk_order=0
availability_status | type=TEXT | not_null=true | default=(none) | pk_order=0
quality_status | type=TEXT | not_null=true | default=(none) | pk_order=0
reason_code | type=TEXT | not_null=true | default=(none) | pk_order=0
metrics_version | type=TEXT | not_null=true | default=(none) | pk_order=0
evidence_json | type=TEXT | not_null=true | default='{}' | pk_order=0
calculated_at | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- `mapped_product_id` -> `product_skus.id` (id=0, seq=0, on_update=NO ACTION, on_delete=RESTRICT)
- `analysis_run_id` -> `growth_analysis_runs.id` (id=1, seq=0, on_update=NO ACTION, on_delete=RESTRICT)

Indexes:
- `idx_growth_sku_warehouse_metrics_product` (unique=false, origin=c, partial=false): [mapped_product_id, analysis_date DESC]; CREATE INDEX idx_growth_sku_warehouse_metrics_product   ON growth_sku_warehouse_daily_metrics(mapped_product_id, analysis_date DESC)
- `idx_growth_sku_warehouse_metrics_sku` (unique=false, origin=c, partial=false): [analysis_run_id, country_code, normalized_source_sku, normalized_warehouse_name]; CREATE INDEX idx_growth_sku_warehouse_metrics_sku   ON growth_sku_warehouse_daily_metrics(     analysis_run_id,     country_code,     normalized_source_sku,     normalized_warehouse_name   )
- `idx_growth_sku_warehouse_metrics_risk` (unique=false, origin=c, partial=false): [analysis_run_id, country_code, supply_status, source_current_sellable_days, normalized_warehouse_name]; CREATE INDEX idx_growth_sku_warehouse_metrics_risk   ON growth_sku_warehouse_daily_metrics(     analysis_run_id,     country_code,     supply_status,     source_current_sellable_days,     normalized_warehouse_name   )
- `sqlite_autoindex_growth_sku_warehouse_daily_metrics_2` (unique=true, origin=u, partial=false): [analysis_run_id, country_code, normalized_warehouse_name, normalized_source_sku]; (implicit)
- `sqlite_autoindex_growth_sku_warehouse_daily_metrics_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## growth_sku_warehouse_sales_metrics

- Rows: 60,110
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
inventory_snapshot_id | type=TEXT | not_null=true | default=(none) | pk_order=0
inventory_source_batch_id | type=TEXT | not_null=true | default=(none) | pk_order=0
order_source_batch_id | type=TEXT | not_null=false | default=(none) | pk_order=0
snapshot_at | type=TEXT | not_null=true | default=(none) | pk_order=0
normalized_source_sku | type=TEXT | not_null=true | default=(none) | pk_order=0
normalized_source_warehouse_name | type=TEXT | not_null=true | default=(none) | pk_order=0
own_sales_quantity_7d | type=NUMERIC | not_null=false | default=(none) | pk_order=0
own_sales_order_count_7d | type=INTEGER | not_null=false | default=(none) | pk_order=0
own_sales_effective_line_count_7d | type=INTEGER | not_null=false | default=(none) | pk_order=0
own_sales_window_started_at | type=TEXT | not_null=false | default=(none) | pk_order=0
own_sales_window_ended_at | type=TEXT | not_null=false | default=(none) | pk_order=0
own_sales_quantity_7d_status | type=TEXT | not_null=true | default=(none) | pk_order=0
source_visible_sales_7d | type=NUMERIC | not_null=false | default=(none) | pk_order=0
source_visible_sales_28d | type=NUMERIC | not_null=false | default=(none) | pk_order=0
source_visible_sales_42d | type=NUMERIC | not_null=false | default=(none) | pk_order=0
source_predicted_daily_sales | type=NUMERIC | not_null=false | default=(none) | pk_order=0
source_predicted_daily_sales_status | type=TEXT | not_null=true | default=(none) | pk_order=0
source_scope_status | type=TEXT | not_null=true | default='unconfirmed' | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- `order_source_batch_id` -> `growth_source_batches.id` (id=0, seq=0, on_update=NO ACTION, on_delete=RESTRICT)
- `inventory_source_batch_id` -> `growth_source_batches.id` (id=1, seq=0, on_update=NO ACTION, on_delete=RESTRICT)
- `inventory_snapshot_id` -> `growth_inventory_snapshots.id` (id=2, seq=0, on_update=NO ACTION, on_delete=RESTRICT)

Indexes:
- `idx_growth_sku_warehouse_sales_metrics_grain` (unique=false, origin=c, partial=false): [snapshot_at, normalized_source_sku, normalized_source_warehouse_name]; CREATE INDEX idx_growth_sku_warehouse_sales_metrics_grain    ON growth_sku_warehouse_sales_metrics(snapshot_at, normalized_source_sku, normalized_source_warehouse_name)
- `sqlite_autoindex_growth_sku_warehouse_sales_metrics_2` (unique=true, origin=u, partial=false): [inventory_snapshot_id]; (implicit)
- `sqlite_autoindex_growth_sku_warehouse_sales_metrics_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## growth_source_batches

- Rows: 11
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
source_type | type=TEXT | not_null=true | default=(none) | pk_order=0
source_module | type=TEXT | not_null=true | default=(none) | pk_order=0
source_file_id | type=TEXT | not_null=false | default=(none) | pk_order=0
source_filename | type=TEXT | not_null=false | default=(none) | pk_order=0
source_sha256 | type=TEXT | not_null=true | default=(none) | pk_order=0
source_account_id | type=TEXT | not_null=false | default=(none) | pk_order=0
idempotency_key | type=TEXT | not_null=true | default=(none) | pk_order=0
query_started_at | type=TEXT | not_null=false | default=(none) | pk_order=0
query_ended_at | type=TEXT | not_null=false | default=(none) | pk_order=0
collected_at | type=TEXT | not_null=false | default=(none) | pk_order=0
imported_at | type=TEXT | not_null=false | default=(none) | pk_order=0
source_scope_json | type=TEXT | not_null=true | default='{}' | pk_order=0
source_headers_json | type=TEXT | not_null=true | default='[]' | pk_order=0
redacted_headers_json | type=TEXT | not_null=true | default='[]' | pk_order=0
row_count | type=INTEGER | not_null=true | default=0 | pk_order=0
status | type=TEXT | not_null=true | default=(none) | pk_order=0
error_code | type=TEXT | not_null=false | default=(none) | pk_order=0
created_by | type=TEXT | not_null=true | default=(none) | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
updated_at | type=TEXT | not_null=true | default=(none) | pk_order=0
source_scope_status | type=TEXT | not_null=true | default='unconfirmed' | pk_order=0
pii_filtered_field_count | type=INTEGER | not_null=true | default=0 | pk_order=0
```

Foreign keys:
- `source_file_id` -> `export_files.id` (id=0, seq=0, on_update=NO ACTION, on_delete=RESTRICT)

Indexes:
- `idx_growth_source_batches_hash` (unique=false, origin=c, partial=false): [source_type, source_sha256]; CREATE INDEX idx_growth_source_batches_hash    ON growth_source_batches(source_type, source_sha256)
- `idx_growth_source_batches_type_created` (unique=false, origin=c, partial=false): [source_type, created_at DESC]; CREATE INDEX idx_growth_source_batches_type_created    ON growth_source_batches(source_type, created_at DESC)
- `sqlite_autoindex_growth_source_batches_2` (unique=true, origin=u, partial=false): [source_type, idempotency_key]; (implicit)
- `sqlite_autoindex_growth_source_batches_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## growth_warehouse_country_mappings

- Rows: 29
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
mapping_set_id | type=TEXT | not_null=true | default=(none) | pk_order=0
source_system | type=TEXT | not_null=true | default=(none) | pk_order=0
source_warehouse_name | type=TEXT | not_null=true | default=(none) | pk_order=0
normalized_warehouse_name | type=TEXT | not_null=true | default=(none) | pk_order=0
country_code | type=TEXT | not_null=true | default=(none) | pk_order=0
country_name | type=TEXT | not_null=true | default=(none) | pk_order=0
mapping_status | type=TEXT | not_null=true | default=(none) | pk_order=0
exclusion_reason | type=TEXT | not_null=false | default=(none) | pk_order=0
evidence_json | type=TEXT | not_null=true | default='{}' | pk_order=0
confirmed_by | type=TEXT | not_null=true | default=(none) | pk_order=0
confirmed_at | type=TEXT | not_null=true | default=(none) | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- `mapping_set_id` -> `growth_country_mapping_sets.id` (id=0, seq=0, on_update=NO ACTION, on_delete=RESTRICT)

Indexes:
- `idx_growth_warehouse_country_mappings_country` (unique=false, origin=c, partial=false): [mapping_set_id, country_code, mapping_status]; CREATE INDEX idx_growth_warehouse_country_mappings_country   ON growth_warehouse_country_mappings(mapping_set_id, country_code, mapping_status)
- `sqlite_autoindex_growth_warehouse_country_mappings_2` (unique=true, origin=u, partial=false): [mapping_set_id, source_system, normalized_warehouse_name]; (implicit)
- `sqlite_autoindex_growth_warehouse_country_mappings_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## mabang_account_profiles

- Rows: 2
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
name | type=TEXT | not_null=true | default=(none) | pk_order=0
username | type=TEXT | not_null=true | default=(none) | pk_order=0
encrypted_password | type=TEXT | not_null=true | default=(none) | pk_order=0
enabled | type=INTEGER | not_null=true | default=1 | pk_order=0
last_verified_at | type=TEXT | not_null=false | default=(none) | pk_order=0
last_verify_status | type=TEXT | not_null=false | default=(none) | pk_order=0
last_verify_message | type=TEXT | not_null=false | default=(none) | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
updated_at | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- none

Indexes:
- `sqlite_autoindex_mabang_account_profiles_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## mabang_filter_option_cache

- Rows: 9,060
- Primary key: `id`

Columns:

```text
id | type=INTEGER | not_null=false | default=(none) | pk_order=1
account_profile_id | type=TEXT | not_null=true | default=(none) | pk_order=0
manager | type=TEXT | not_null=true | default='' | pk_order=0
shop_name | type=TEXT | not_null=true | default='' | pk_order=0
platform | type=TEXT | not_null=true | default='' | pk_order=0
region | type=TEXT | not_null=true | default='' | pk_order=0
warehouse | type=TEXT | not_null=true | default='' | pk_order=0
order_status | type=TEXT | not_null=true | default='' | pk_order=0
sku | type=TEXT | not_null=true | default='' | pk_order=0
logistics_channel | type=TEXT | not_null=true | default='' | pk_order=0
updated_at | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- `account_profile_id` -> `mabang_account_profiles.id` (id=0, seq=0, on_update=NO ACTION, on_delete=CASCADE)

Indexes:
- `sqlite_autoindex_mabang_filter_option_cache_1` (unique=true, origin=u, partial=false): [account_profile_id, manager, shop_name, platform, region, warehouse, order_status, sku, logistics_channel]; (implicit)

