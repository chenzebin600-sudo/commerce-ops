# Commerce Ops SQLite Tables 03

Snapshot date: 2026-08-05

This appendix records exact SQLite fields, keys, foreign keys, indexes, and row counts.

## growth_inventory_snapshots

- Rows: 61,548
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
batch_id | type=TEXT | not_null=true | default=(none) | pk_order=0
source_row_number | type=INTEGER | not_null=true | default=(none) | pk_order=0
source_sku | type=TEXT | not_null=true | default=(none) | pk_order=0
normalized_source_sku | type=TEXT | not_null=true | default=(none) | pk_order=0
mapped_product_id | type=TEXT | not_null=false | default=(none) | pk_order=0
warehouse_name | type=TEXT | not_null=false | default=(none) | pk_order=0
available_quantity | type=NUMERIC | not_null=false | default=(none) | pk_order=0
physical_quantity | type=NUMERIC | not_null=false | default=(none) | pk_order=0
locked_quantity | type=NUMERIC | not_null=false | default=(none) | pk_order=0
in_transit_quantity | type=NUMERIC | not_null=false | default=(none) | pk_order=0
pending_shipment_quantity | type=NUMERIC | not_null=false | default=(none) | pk_order=0
sellable_quantity | type=NUMERIC | not_null=false | default=(none) | pk_order=0
sellable_quantity_status | type=TEXT | not_null=true | default='unconfirmed' | pk_order=0
source_predicted_daily_sales | type=NUMERIC | not_null=false | default=(none) | pk_order=0
predicted_daily_sales_semantic_status | type=TEXT | not_null=true | default='unconfirmed' | pk_order=0
days_of_supply | type=NUMERIC | not_null=false | default=(none) | pk_order=0
days_of_supply_status | type=TEXT | not_null=true | default='unavailable' | pk_order=0
snapshot_at | type=TEXT | not_null=false | default=(none) | pk_order=0
mapping_status | type=TEXT | not_null=true | default=(none) | pk_order=0
quality_status | type=TEXT | not_null=true | default=(none) | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
normalized_warehouse_name | type=TEXT | not_null=true | default='' | pk_order=0
product_status | type=TEXT | not_null=false | default=(none) | pk_order=0
category_level_1 | type=TEXT | not_null=false | default=(none) | pk_order=0
category_level_2 | type=TEXT | not_null=false | default=(none) | pk_order=0
category_level_3 | type=TEXT | not_null=false | default=(none) | pk_order=0
source_visible_sales_7d | type=NUMERIC | not_null=false | default=(none) | pk_order=0
source_visible_sales_28d | type=NUMERIC | not_null=false | default=(none) | pk_order=0
source_visible_sales_42d | type=NUMERIC | not_null=false | default=(none) | pk_order=0
source_scope_status | type=TEXT | not_null=true | default='unconfirmed' | pk_order=0
```

Foreign keys:
- `mapped_product_id` -> `product_skus.id` (id=0, seq=0, on_update=NO ACTION, on_delete=RESTRICT)
- `batch_id` -> `growth_source_batches.id` (id=1, seq=0, on_update=NO ACTION, on_delete=RESTRICT)

Indexes:
- `idx_growth_inventory_snapshots_warehouse` (unique=false, origin=c, partial=false): [normalized_warehouse_name, snapshot_at]; CREATE INDEX idx_growth_inventory_snapshots_warehouse    ON growth_inventory_snapshots(normalized_warehouse_name, snapshot_at)
- `uq_growth_inventory_snapshot_grain` (unique=true, origin=c, partial=true): [snapshot_at, normalized_source_sku, normalized_warehouse_name]; CREATE UNIQUE INDEX uq_growth_inventory_snapshot_grain    ON growth_inventory_snapshots(snapshot_at, normalized_source_sku, normalized_warehouse_name)    WHERE normalized_source_sku <> '' AND normalized_warehouse_name <> ''
- `idx_growth_inventory_snapshots_sku` (unique=false, origin=c, partial=false): [normalized_source_sku, snapshot_at]; CREATE INDEX idx_growth_inventory_snapshots_sku    ON growth_inventory_snapshots(normalized_source_sku, snapshot_at)
- `sqlite_autoindex_growth_inventory_snapshots_2` (unique=true, origin=u, partial=false): [batch_id, source_row_number]; (implicit)
- `sqlite_autoindex_growth_inventory_snapshots_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## growth_mapping_events

- Rows: 0
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
mapping_type | type=TEXT | not_null=true | default=(none) | pk_order=0
mapping_id | type=TEXT | not_null=true | default=(none) | pk_order=0
action | type=TEXT | not_null=true | default=(none) | pk_order=0
before_json | type=TEXT | not_null=true | default='{}' | pk_order=0
after_json | type=TEXT | not_null=true | default='{}' | pk_order=0
actor_label | type=TEXT | not_null=true | default=(none) | pk_order=0
request_id | type=TEXT | not_null=false | default=(none) | pk_order=0
occurred_at | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- none

Indexes:
- `idx_growth_mapping_events_mapping` (unique=false, origin=c, partial=false): [mapping_type, mapping_id, occurred_at DESC]; CREATE INDEX idx_growth_mapping_events_mapping    ON growth_mapping_events(mapping_type, mapping_id, occurred_at DESC)
- `sqlite_autoindex_growth_mapping_events_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## growth_mapping_issues

- Rows: 8,935
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
issue_key | type=TEXT | not_null=true | default=(none) | pk_order=0
issue_type | type=TEXT | not_null=true | default=(none) | pk_order=0
source_batch_id | type=TEXT | not_null=true | default=(none) | pk_order=0
source_row_id | type=TEXT | not_null=false | default=(none) | pk_order=0
source_value | type=TEXT | not_null=true | default=(none) | pk_order=0
candidate_values_json | type=TEXT | not_null=true | default='[]' | pk_order=0
reason | type=TEXT | not_null=true | default=(none) | pk_order=0
status | type=TEXT | not_null=true | default='open' | pk_order=0
resolved_value | type=TEXT | not_null=false | default=(none) | pk_order=0
resolved_by | type=TEXT | not_null=false | default=(none) | pk_order=0
resolved_at | type=TEXT | not_null=false | default=(none) | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
updated_at | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- `source_row_id` -> `growth_order_raw_rows.id` (id=0, seq=0, on_update=NO ACTION, on_delete=RESTRICT)
- `source_batch_id` -> `growth_source_batches.id` (id=1, seq=0, on_update=NO ACTION, on_delete=RESTRICT)

Indexes:
- `idx_growth_mapping_issues_status` (unique=false, origin=c, partial=false): [issue_type, status, created_at DESC]; CREATE INDEX idx_growth_mapping_issues_status    ON growth_mapping_issues(issue_type, status, created_at DESC)
- `sqlite_autoindex_growth_mapping_issues_2` (unique=true, origin=u, partial=false): [issue_key]; (implicit)
- `sqlite_autoindex_growth_mapping_issues_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## growth_order_headers

- Rows: 79,768
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
business_key | type=TEXT | not_null=true | default=(none) | pk_order=0
business_key_version | type=TEXT | not_null=true | default=(none) | pk_order=0
platform | type=TEXT | not_null=true | default=(none) | pk_order=0
source_shop_name | type=TEXT | not_null=true | default=(none) | pk_order=0
normalized_source_shop_name | type=TEXT | not_null=true | default=(none) | pk_order=0
internal_shop_id | type=TEXT | not_null=false | default=(none) | pk_order=0
mapped_country | type=TEXT | not_null=false | default=(none) | pk_order=0
source_order_id | type=TEXT | not_null=true | default=(none) | pk_order=0
order_status | type=TEXT | not_null=true | default=(none) | pk_order=0
paid_at | type=TEXT | not_null=false | default=(none) | pk_order=0
cancelled_at | type=TEXT | not_null=false | default=(none) | pk_order=0
order_currency | type=TEXT | not_null=false | default=(none) | pk_order=0
order_amount | type=NUMERIC | not_null=false | default=(none) | pk_order=0
order_amount_source_field | type=TEXT | not_null=false | default=(none) | pk_order=0
effective_status | type=TEXT | not_null=true | default=(none) | pk_order=0
first_source_batch_id | type=TEXT | not_null=true | default=(none) | pk_order=0
source_batch_id | type=TEXT | not_null=true | default=(none) | pk_order=0
source_quality_status | type=TEXT | not_null=true | default=(none) | pk_order=0
first_seen_at | type=TEXT | not_null=true | default=(none) | pk_order=0
last_seen_at | type=TEXT | not_null=true | default=(none) | pk_order=0
revision | type=INTEGER | not_null=true | default=1 | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
updated_at | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- `source_batch_id` -> `growth_source_batches.id` (id=0, seq=0, on_update=NO ACTION, on_delete=RESTRICT)
- `first_source_batch_id` -> `growth_source_batches.id` (id=1, seq=0, on_update=NO ACTION, on_delete=RESTRICT)
- `internal_shop_id` -> `growth_shops.id` (id=2, seq=0, on_update=NO ACTION, on_delete=RESTRICT)

Indexes:
- `idx_growth_order_headers_shop` (unique=false, origin=c, partial=false): [platform, normalized_source_shop_name, paid_at]; CREATE INDEX idx_growth_order_headers_shop    ON growth_order_headers(platform, normalized_source_shop_name, paid_at)
- `idx_growth_order_headers_batch` (unique=false, origin=c, partial=false): [source_batch_id, effective_status]; CREATE INDEX idx_growth_order_headers_batch    ON growth_order_headers(source_batch_id, effective_status)
- `sqlite_autoindex_growth_order_headers_2` (unique=true, origin=u, partial=false): [business_key_version, business_key]; (implicit)
- `sqlite_autoindex_growth_order_headers_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## growth_order_inventory_links

- Rows: 344,576
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
order_line_id | type=TEXT | not_null=true | default=(none) | pk_order=0
order_source_batch_id | type=TEXT | not_null=true | default=(none) | pk_order=0
inventory_snapshot_id | type=TEXT | not_null=false | default=(none) | pk_order=0
inventory_source_batch_id | type=TEXT | not_null=true | default=(none) | pk_order=0
match_key_version | type=TEXT | not_null=true | default=(none) | pk_order=0
normalized_source_sku | type=TEXT | not_null=true | default=(none) | pk_order=0
normalized_source_warehouse_name | type=TEXT | not_null=true | default=(none) | pk_order=0
match_status | type=TEXT | not_null=true | default=(none) | pk_order=0
unmatched_reason | type=TEXT | not_null=false | default=(none) | pk_order=0
order_effective_status | type=TEXT | not_null=true | default=(none) | pk_order=0
is_current | type=INTEGER | not_null=true | default=1 | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
updated_at | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- `inventory_source_batch_id` -> `growth_source_batches.id` (id=0, seq=0, on_update=NO ACTION, on_delete=RESTRICT)
- `inventory_snapshot_id` -> `growth_inventory_snapshots.id` (id=1, seq=0, on_update=NO ACTION, on_delete=RESTRICT)
- `order_source_batch_id` -> `growth_source_batches.id` (id=2, seq=0, on_update=NO ACTION, on_delete=RESTRICT)
- `order_line_id` -> `growth_order_lines.id` (id=3, seq=0, on_update=NO ACTION, on_delete=RESTRICT)

Indexes:
- `idx_growth_order_inventory_links_batch_status` (unique=false, origin=c, partial=false): [inventory_source_batch_id, match_status, is_current]; CREATE INDEX idx_growth_order_inventory_links_batch_status    ON growth_order_inventory_links(inventory_source_batch_id, match_status, is_current)
- `sqlite_autoindex_growth_order_inventory_links_2` (unique=true, origin=u, partial=false): [order_line_id, inventory_source_batch_id]; (implicit)
- `sqlite_autoindex_growth_order_inventory_links_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## growth_order_lines

- Rows: 115,868
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
order_header_id | type=TEXT | not_null=true | default=(none) | pk_order=0
first_source_batch_id | type=TEXT | not_null=true | default=(none) | pk_order=0
source_batch_id | type=TEXT | not_null=true | default=(none) | pk_order=0
source_row_number | type=INTEGER | not_null=true | default=(none) | pk_order=0
source_line_key | type=TEXT | not_null=true | default=(none) | pk_order=0
source_line_key_version | type=TEXT | not_null=true | default=(none) | pk_order=0
line_occurrence | type=INTEGER | not_null=true | default=(none) | pk_order=0
dedupe_confidence | type=TEXT | not_null=true | default=(none) | pk_order=0
source_sku | type=TEXT | not_null=true | default=(none) | pk_order=0
normalized_source_sku | type=TEXT | not_null=true | default=(none) | pk_order=0
platform_sku | type=TEXT | not_null=false | default=(none) | pk_order=0
mapped_product_id | type=TEXT | not_null=false | default=(none) | pk_order=0
mapped_country | type=TEXT | not_null=false | default=(none) | pk_order=0
quantity | type=NUMERIC | not_null=true | default=(none) | pk_order=0
line_amount | type=NUMERIC | not_null=false | default=(none) | pk_order=0
line_amount_status | type=TEXT | not_null=true | default=(none) | pk_order=0
product_name | type=TEXT | not_null=false | default=(none) | pk_order=0
mapping_status | type=TEXT | not_null=true | default=(none) | pk_order=0
effective_status | type=TEXT | not_null=true | default=(none) | pk_order=0
is_current | type=INTEGER | not_null=true | default=1 | pk_order=0
first_seen_at | type=TEXT | not_null=true | default=(none) | pk_order=0
last_seen_at | type=TEXT | not_null=true | default=(none) | pk_order=0
revision | type=INTEGER | not_null=true | default=1 | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
updated_at | type=TEXT | not_null=true | default=(none) | pk_order=0
source_warehouse_name | type=TEXT | not_null=false | default=(none) | pk_order=0
normalized_source_warehouse_name | type=TEXT | not_null=false | default=(none) | pk_order=0
```

Foreign keys:
- `mapped_product_id` -> `product_skus.id` (id=0, seq=0, on_update=NO ACTION, on_delete=RESTRICT)
- `source_batch_id` -> `growth_source_batches.id` (id=1, seq=0, on_update=NO ACTION, on_delete=RESTRICT)
- `first_source_batch_id` -> `growth_source_batches.id` (id=2, seq=0, on_update=NO ACTION, on_delete=RESTRICT)
- `order_header_id` -> `growth_order_headers.id` (id=3, seq=0, on_update=NO ACTION, on_delete=RESTRICT)

Indexes:
- `idx_growth_order_lines_sku_warehouse` (unique=false, origin=c, partial=false): [normalized_source_sku, normalized_source_warehouse_name, is_current]; CREATE INDEX idx_growth_order_lines_sku_warehouse    ON growth_order_lines(normalized_source_sku, normalized_source_warehouse_name, is_current)
- `idx_growth_order_lines_sku` (unique=false, origin=c, partial=false): [normalized_source_sku, mapped_country, mapping_status]; CREATE INDEX idx_growth_order_lines_sku    ON growth_order_lines(normalized_source_sku, mapped_country, mapping_status)
- `idx_growth_order_lines_order` (unique=false, origin=c, partial=false): [order_header_id, is_current, source_row_number]; CREATE INDEX idx_growth_order_lines_order    ON growth_order_lines(order_header_id, is_current, source_row_number)
- `sqlite_autoindex_growth_order_lines_2` (unique=true, origin=u, partial=false): [source_line_key_version, source_line_key]; (implicit)
- `sqlite_autoindex_growth_order_lines_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## growth_order_raw_rows

- Rows: 150,374
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
- `idx_growth_order_raw_rows_hash` (unique=false, origin=c, partial=false): [row_hash]; CREATE INDEX idx_growth_order_raw_rows_hash    ON growth_order_raw_rows(row_hash)
- `sqlite_autoindex_growth_order_raw_rows_2` (unique=true, origin=u, partial=false): [batch_id, source_row_number]; (implicit)
- `sqlite_autoindex_growth_order_raw_rows_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## growth_rule_sets

- Rows: 2
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
version | type=TEXT | not_null=true | default=(none) | pk_order=0
status | type=TEXT | not_null=true | default=(none) | pk_order=0
metrics_contract_version | type=TEXT | not_null=true | default=(none) | pk_order=0
parameters_json | type=TEXT | not_null=true | default=(none) | pk_order=0
content_sha256 | type=TEXT | not_null=true | default=(none) | pk_order=0
effective_from | type=TEXT | not_null=true | default=(none) | pk_order=0
effective_to | type=TEXT | not_null=false | default=(none) | pk_order=0
created_by | type=TEXT | not_null=true | default=(none) | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
activated_by | type=TEXT | not_null=false | default=(none) | pk_order=0
activated_at | type=TEXT | not_null=false | default=(none) | pk_order=0
```

Foreign keys:
- none

Indexes:
- `uq_growth_rule_sets_active` (unique=true, origin=c, partial=true): [status]; CREATE UNIQUE INDEX uq_growth_rule_sets_active   ON growth_rule_sets(status)   WHERE status = 'active'
- `sqlite_autoindex_growth_rule_sets_3` (unique=true, origin=u, partial=false): [content_sha256]; (implicit)
- `sqlite_autoindex_growth_rule_sets_2` (unique=true, origin=u, partial=false): [version]; (implicit)
- `sqlite_autoindex_growth_rule_sets_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## growth_shop_daily_metrics

- Rows: 0
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
analysis_run_id | type=TEXT | not_null=true | default=(none) | pk_order=0
analysis_date | type=TEXT | not_null=true | default=(none) | pk_order=0
internal_shop_id | type=TEXT | not_null=true | default=(none) | pk_order=0
display_name | type=TEXT | not_null=true | default=(none) | pk_order=0
platform | type=TEXT | not_null=true | default=(none) | pk_order=0
owner_user_id | type=TEXT | not_null=false | default=(none) | pk_order=0
country_code | type=TEXT | not_null=true | default=(none) | pk_order=0
own_sales_quantity_7d | type=NUMERIC | not_null=true | default=0 | pk_order=0
own_sales_quantity_28d | type=NUMERIC | not_null=true | default=0 | pk_order=0
valid_order_count_7d | type=INTEGER | not_null=true | default=0 | pk_order=0
valid_order_count_28d | type=INTEGER | not_null=true | default=0 | pk_order=0
eligible_saleable_sku_count | type=INTEGER | not_null=false | default=(none) | pk_order=0
sold_eligible_sku_count_28d | type=INTEGER | not_null=false | default=(none) | pk_order=0
saleable_coverage_rate_28d | type=NUMERIC | not_null=false | default=(none) | pk_order=0
eligible_high_performance_sku_count | type=INTEGER | not_null=false | default=(none) | pk_order=0
sold_high_performance_sku_count_28d | type=INTEGER | not_null=false | default=(none) | pk_order=0
high_performance_coverage_rate_28d | type=NUMERIC | not_null=false | default=(none) | pk_order=0
key_performer_count | type=INTEGER | not_null=true | default=0 | pk_order=0
growth_focus_count | type=INTEGER | not_null=true | default=0 | pk_order=0
new_opportunity_count | type=INTEGER | not_null=true | default=0 | pk_order=0
slow_risk_count | type=INTEGER | not_null=true | default=0 | pk_order=0
low_stock_risk_count | type=INTEGER | not_null=true | default=0 | pk_order=0
availability_status | type=TEXT | not_null=true | default=(none) | pk_order=0
quality_status | type=TEXT | not_null=true | default=(none) | pk_order=0
reason_code | type=TEXT | not_null=true | default=(none) | pk_order=0
metrics_version | type=TEXT | not_null=true | default=(none) | pk_order=0
country_mapping_set_id | type=TEXT | not_null=true | default=(none) | pk_order=0
evidence_json | type=TEXT | not_null=true | default='{}' | pk_order=0
calculated_at | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- `country_mapping_set_id` -> `growth_country_mapping_sets.id` (id=0, seq=0, on_update=NO ACTION, on_delete=RESTRICT)
- `internal_shop_id` -> `growth_shops.id` (id=1, seq=0, on_update=NO ACTION, on_delete=RESTRICT)
- `analysis_run_id` -> `growth_analysis_runs.id` (id=2, seq=0, on_update=NO ACTION, on_delete=RESTRICT)

Indexes:
- `idx_growth_shop_metrics_run` (unique=false, origin=c, partial=false): [analysis_run_id, platform, owner_user_id, display_name]; CREATE INDEX idx_growth_shop_metrics_run   ON growth_shop_daily_metrics(analysis_run_id, platform, owner_user_id, display_name)
- `sqlite_autoindex_growth_shop_daily_metrics_2` (unique=true, origin=u, partial=false): [analysis_run_id, internal_shop_id]; (implicit)
- `sqlite_autoindex_growth_shop_daily_metrics_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## growth_shop_sku_coverage_snapshots

- Rows: 0
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
internal_shop_id | type=TEXT | not_null=true | default=(none) | pk_order=0
product_sku_id | type=TEXT | not_null=true | default=(none) | pk_order=0
coverage_semantic | type=TEXT | not_null=true | default=(none) | pk_order=0
source_system | type=TEXT | not_null=true | default=(none) | pk_order=0
source_evidence_id | type=TEXT | not_null=true | default=(none) | pk_order=0
observed_at | type=TEXT | not_null=true | default=(none) | pk_order=0
expires_at | type=TEXT | not_null=true | default=(none) | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- `product_sku_id` -> `product_skus.id` (id=0, seq=0, on_update=NO ACTION, on_delete=RESTRICT)
- `internal_shop_id` -> `growth_shops.id` (id=1, seq=0, on_update=NO ACTION, on_delete=RESTRICT)

Indexes:
- `idx_growth_shop_sku_coverage_current` (unique=false, origin=c, partial=false): [internal_shop_id, expires_at DESC]; CREATE INDEX idx_growth_shop_sku_coverage_current    ON growth_shop_sku_coverage_snapshots(internal_shop_id, expires_at DESC)
- `sqlite_autoindex_growth_shop_sku_coverage_snapshots_2` (unique=true, origin=u, partial=false): [internal_shop_id, product_sku_id, source_system, observed_at]; (implicit)
- `sqlite_autoindex_growth_shop_sku_coverage_snapshots_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## growth_shop_sku_daily_metrics

- Rows: 0
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
analysis_run_id | type=TEXT | not_null=true | default=(none) | pk_order=0
analysis_date | type=TEXT | not_null=true | default=(none) | pk_order=0
internal_shop_id | type=TEXT | not_null=true | default=(none) | pk_order=0
country_code | type=TEXT | not_null=true | default=(none) | pk_order=0
normalized_source_sku | type=TEXT | not_null=true | default=(none) | pk_order=0
source_sku | type=TEXT | not_null=true | default=(none) | pk_order=0
product_name | type=TEXT | not_null=false | default=(none) | pk_order=0
category_l1 | type=TEXT | not_null=false | default=(none) | pk_order=0
category_l2 | type=TEXT | not_null=false | default=(none) | pk_order=0
mapped_product_id | type=TEXT | not_null=false | default=(none) | pk_order=0
own_sales_quantity_7d | type=NUMERIC | not_null=true | default=0 | pk_order=0
own_sales_quantity_28d | type=NUMERIC | not_null=true | default=0 | pk_order=0
valid_order_count_7d | type=INTEGER | not_null=true | default=0 | pk_order=0
valid_order_count_28d | type=INTEGER | not_null=true | default=0 | pk_order=0
last_sold_at | type=TEXT | not_null=false | default=(none) | pk_order=0
source_visible_sales_7d | type=NUMERIC | not_null=false | default=(none) | pk_order=0
source_visible_sales_28d | type=NUMERIC | not_null=false | default=(none) | pk_order=0
source_visible_sales_42d | type=NUMERIC | not_null=false | default=(none) | pk_order=0
shop_to_source_visible_ratio_28d | type=NUMERIC | not_null=false | default=(none) | pk_order=0
shop_to_source_visible_ratio_percentile_28d | type=NUMERIC | not_null=false | default=(none) | pk_order=0
shop_sales_percentile_28d | type=NUMERIC | not_null=false | default=(none) | pk_order=0
eligible_saleable | type=INTEGER | not_null=true | default=0 | pk_order=0
eligible_high_performance | type=INTEGER | not_null=true | default=0 | pk_order=0
is_key_performer | type=INTEGER | not_null=true | default=0 | pk_order=0
is_growth_focus_candidate | type=INTEGER | not_null=true | default=0 | pk_order=0
available_quantity | type=NUMERIC | not_null=false | default=(none) | pk_order=0
availability_status | type=TEXT | not_null=true | default=(none) | pk_order=0
quality_status | type=TEXT | not_null=true | default=(none) | pk_order=0
reason_code | type=TEXT | not_null=true | default=(none) | pk_order=0
metrics_version | type=TEXT | not_null=true | default=(none) | pk_order=0
evidence_json | type=TEXT | not_null=true | default='{}' | pk_order=0
calculated_at | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- `mapped_product_id` -> `product_skus.id` (id=0, seq=0, on_update=NO ACTION, on_delete=RESTRICT)
- `internal_shop_id` -> `growth_shops.id` (id=1, seq=0, on_update=NO ACTION, on_delete=RESTRICT)
- `analysis_run_id` -> `growth_analysis_runs.id` (id=2, seq=0, on_update=NO ACTION, on_delete=RESTRICT)

Indexes:
- `idx_growth_shop_sku_metrics_sales` (unique=false, origin=c, partial=false): [analysis_run_id, internal_shop_id, own_sales_quantity_28d DESC]; CREATE INDEX idx_growth_shop_sku_metrics_sales   ON growth_shop_sku_daily_metrics(     analysis_run_id, internal_shop_id, own_sales_quantity_28d DESC   )
- `idx_growth_shop_sku_metrics_focus` (unique=false, origin=c, partial=false): [analysis_run_id, internal_shop_id, is_growth_focus_candidate, is_key_performer]; CREATE INDEX idx_growth_shop_sku_metrics_focus   ON growth_shop_sku_daily_metrics(     analysis_run_id, internal_shop_id, is_growth_focus_candidate, is_key_performer   )
- `sqlite_autoindex_growth_shop_sku_daily_metrics_2` (unique=true, origin=u, partial=false): [analysis_run_id, internal_shop_id, normalized_source_sku]; (implicit)
- `sqlite_autoindex_growth_shop_sku_daily_metrics_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

