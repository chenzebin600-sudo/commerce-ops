# Commerce Ops SQLite Schema Inventory

Snapshot date: 2026-08-05

Source: read-only inspection of `storage/commerce-ops.sqlite`.

## Snapshot Summary

- Main database: 1,746,882,560 bytes (1665.96 MiB), excluding the live WAL.
- Tables: 88; columns: 1,527; views: 15; triggers: 0.
- Rows across application tables: 2,000,771.
- Explicit and implicit indexes: 301; foreign-key declarations: 148.
- Integrity: `ok`; foreign-key violations: 0.

## Detailed Table Appendices

- [Tables 01](./COMMERCE-OPS-SQLITE-SCHEMA-TABLES-01-20260805.md)
- [Tables 02](./COMMERCE-OPS-SQLITE-SCHEMA-TABLES-02-20260805.md)
- [Tables 03](./COMMERCE-OPS-SQLITE-SCHEMA-TABLES-03-20260805.md)
- [Tables 04](./COMMERCE-OPS-SQLITE-SCHEMA-TABLES-04-20260805.md)
- [Tables 05](./COMMERCE-OPS-SQLITE-SCHEMA-TABLES-05-20260805.md)
- [Tables 06](./COMMERCE-OPS-SQLITE-SCHEMA-TABLES-06-20260805.md)
- [Tables 07](./COMMERCE-OPS-SQLITE-SCHEMA-TABLES-07-20260805.md)
- [Tables 08](./COMMERCE-OPS-SQLITE-SCHEMA-TABLES-08-20260805.md)

## Migration Chain

- `001_mabang_scheduler.sql` - applied at 2026-07-14T07:20:16.982Z
- `002_operation_audit_events.sql` - applied at 2026-07-16T04:31:24.921Z
- `003_scheduled_task_soft_delete.sql` - applied at 2026-07-16T05:04:17.917Z
- `004_export_file_persistence.sql` - applied at 2026-07-16T06:33:28.251Z
- `005_file_lifecycle_scanning.sql` - applied at 2026-07-16T07:50:25.890Z
- `006_file_quarantine_and_review.sql` - applied at 2026-07-16T09:03:59.899Z
- `007_product_center_g1a2.sql` - applied at 2026-07-20T09:36:50.992Z
- `008_product_center_country_identity.sql` - applied at 2026-07-20T12:40:26.697Z
- `009_product_package_lossless_rows.sql` - applied at 2026-07-21T06:38:28.608Z
- `010_product_catalog_soft_delete_ai_content.sql` - applied at 2026-07-21T07:48:03.839Z
- `011_product_listing_workbench.sql` - applied at 2026-07-21T08:49:56.229Z
- `012_product_listing_ai_content_images.sql` - applied at 2026-07-21T10:20:15.564Z
- `013_deterministic_growth_radar_foundation.sql` - applied at 2026-07-22T01:34:04.462Z
- `014_deterministic_growth_radar_scope_and_linkage.sql` - applied at 2026-07-22T01:34:04.490Z
- `015_mabang_sku_image_collector.sql` - applied at 2026-07-24T03:07:15.227Z
- `017_mabang_full_image_sync.sql` - applied at 2026-07-24T10:28:28.248Z
- `018_mabang_image_collection_performance.sql` - applied at 2026-07-24T12:01:42.578Z
- `019_growth_radar_v2_analysis.sql` - applied at 2026-07-28T05:41:16.627Z
- `020_growth_radar_direction_contract.sql` - applied at 2026-07-28T05:41:16.631Z
- `021_growth_radar_task_lifecycle.sql` - applied at 2026-07-28T05:41:16.633Z
- `022_commerce_ops_foundation_v1.sql` - applied at 2026-07-28T05:41:16.885Z
- `023_price_control_change_module.sql` - applied at 2026-08-05T09:20:56.296Z
- `024_price_control_automation.sql` - applied at 2026-08-05T10:45:36.184Z

## Views

- `foundation_open_tasks_v`
- `foundation_owner_master_v`
- `foundation_product_master_v`
- `foundation_sku_master_v`
- `foundation_store_master_v`
- `foundation_task_domain_summary_v`
- `foundation_warehouse_master_v`
- `growth_latest_country_supply_summary_v`
- `growth_latest_published_run_v`
- `growth_latest_shop_metrics_v`
- `growth_latest_shop_sku_metrics_v`
- `growth_latest_signals_v`
- `growth_latest_sku_metrics_v`
- `growth_latest_sku_warehouse_metrics_v`
- `growth_open_focus_items_v`

## Table Catalog

| Table | Rows | Columns | PK | FKs | Indexes | Storage incl. indexes |
|---|---:|---:|---|---:|---:|---:|
| `dingtalk_robot_configs` | 4 | 12 | `id` | 0 | 1 | 0.01 MiB |
| `export_files` | 20 | 18 | `id` | 2 | 10 | 0.06 MiB |
| `file_lifecycle_items` | 14 | 39 | `id` | 1 | 5 | 0.04 MiB |
| `file_lifecycle_protected_files` | 2 | 3 | `file_id` | 1 | 1 | 0.01 MiB |
| `file_lifecycle_scans` | 1 | 14 | `id` | 1 | 3 | 0.02 MiB |
| `file_quarantine_records` | 0 | 16 | `id` | 2 | 3 | 0.02 MiB |
| `foundation_account_capabilities` | 10 | 6 | `account_id`, `capability_code` | 1 | 2 | 0.01 MiB |
| `foundation_identity_links` | 24,983 | 15 | `id` | 1 | 3 | 13.77 MiB |
| `foundation_integration_accounts` | 3 | 10 | `id` | 1 | 3 | 0.02 MiB |
| `foundation_owners` | 22 | 8 | `id` | 1 | 3 | 0.02 MiB |
| `foundation_source_runs` | 5 | 14 | `id` | 2 | 3 | 0.02 MiB |
| `foundation_source_systems` | 7 | 7 | `code` | 0 | 1 | 0.01 MiB |
| `foundation_task_events` | 223 | 15 | `id` | 1 | 4 | 0.18 MiB |
| `foundation_task_leases` | 0 | 6 | `task_id` | 1 | 3 | 0.02 MiB |
| `foundation_tasks` | 217 | 31 | `id` | 6 | 6 | 0.29 MiB |
| `foundation_warehouses` | 29 | 10 | `id` | 0 | 3 | 0.03 MiB |
| `growth_analysis_runs` | 0 | 25 | `id` | 3 | 4 | 0.02 MiB |
| `growth_country_mapping_sets` | 2 | 11 | `id` | 0 | 4 | 0.02 MiB |
| `growth_data_quality_issues` | 36,671 | 12 | `id` | 1 | 3 | 23.43 MiB |
| `growth_focus_item_events` | 0 | 16 | `id` | 3 | 5 | 0.02 MiB |
| `growth_focus_items` | 0 | 36 | `id` | 4 | 6 | 0.03 MiB |
| `growth_inventory_raw_rows` | 61,560 | 10 | `id` | 1 | 3 | 131.59 MiB |
| `growth_inventory_snapshots` | 61,548 | 31 | `id` | 2 | 5 | 38.46 MiB |
| `growth_mapping_events` | 0 | 9 | `id` | 0 | 2 | 0.01 MiB |
| `growth_mapping_issues` | 8,935 | 14 | `id` | 2 | 3 | 6.80 MiB |
| `growth_order_headers` | 79,768 | 24 | `id` | 3 | 4 | 60.83 MiB |
| `growth_order_inventory_links` | 344,576 | 14 | `id` | 4 | 3 | 179.08 MiB |
| `growth_order_lines` | 115,868 | 28 | `id` | 4 | 5 | 99.61 MiB |
| `growth_order_raw_rows` | 150,374 | 10 | `id` | 1 | 3 | 331.21 MiB |
| `growth_rule_sets` | 2 | 12 | `id` | 0 | 4 | 0.02 MiB |
| `growth_shop_daily_metrics` | 0 | 30 | `id` | 3 | 3 | 0.02 MiB |
| `growth_shop_sku_coverage_snapshots` | 0 | 9 | `id` | 2 | 3 | 0.02 MiB |
| `growth_shop_sku_daily_metrics` | 0 | 33 | `id` | 3 | 4 | 0.02 MiB |
| `growth_shop_sku_observations` | 11,846 | 19 | `id` | 4 | 3 | 6.22 MiB |
| `growth_shop_source_mappings` | 131 | 15 | `id` | 3 | 3 | 0.07 MiB |
| `growth_shops` | 131 | 13 | `id` | 0 | 3 | 0.06 MiB |
| `growth_signals` | 0 | 19 | `id` | 2 | 6 | 0.03 MiB |
| `growth_sku_daily_metrics` | 0 | 44 | `id` | 2 | 6 | 0.03 MiB |
| `growth_sku_warehouse_daily_metrics` | 0 | 29 | `id` | 2 | 5 | 0.02 MiB |
| `growth_sku_warehouse_sales_metrics` | 60,110 | 20 | `id` | 3 | 3 | 28.31 MiB |
| `growth_source_batches` | 11 | 23 | `id` | 1 | 4 | 0.06 MiB |
| `growth_warehouse_country_mappings` | 29 | 13 | `id` | 1 | 3 | 0.03 MiB |
| `mabang_account_profiles` | 2 | 10 | `id` | 0 | 1 | 0.01 MiB |
| `mabang_filter_option_cache` | 9,060 | 11 | `id` | 1 | 1 | 3.03 MiB |
| `mabang_sku_image_batches` | 210 | 28 | `id` | 3 | 5 | 0.23 MiB |
| `mabang_sku_image_checkpoints` | 573 | 12 | `id` | 1 | 3 | 0.22 MiB |
| `mabang_sku_image_discoveries` | 22,687 | 25 | `id` | 2 | 5 | 18.46 MiB |
| `mabang_sku_image_discovery_images` | 40,039 | 14 | `id` | 2 | 6 | 30.94 MiB |
| `mabang_sku_image_sync_runs` | 2 | 21 | `id` | 1 | 3 | 0.02 MiB |
| `managed_files` | 7 | 16 | `id` | 2 | 5 | 0.02 MiB |
| `operation_audit_events` | 41,994 | 21 | `id` | 0 | 5 | 28.81 MiB |
| `price_control_automation_settings` | 1 | 15 | `id` | 1 | 2 | 0.01 MiB |
| `price_control_price_snapshots` | 396,815 | 17 | `id` | 2 | 3 | 258.00 MiB |
| `price_control_source_batches` | 71 | 12 | `apply_no` | 1 | 2 | 0.03 MiB |
| `price_control_sync_runs` | 1 | 26 | `id` | 1 | 4 | 0.02 MiB |
| `product_ai_contents` | 0 | 29 | `id` | 1 | 6 | 0.03 MiB |
| `product_categories` | 78 | 13 | `id` | 3 | 3 | 0.05 MiB |
| `product_cost_snapshots` | 18,602 | 14 | `id` | 2 | 3 | 8.03 MiB |
| `product_detail_preferences` | 1 | 7 | `scope_key` | 0 | 1 | 0.01 MiB |
| `product_field_override_events` | 102 | 8 | `id` | 1 | 2 | 0.05 MiB |
| `product_field_overrides` | 81 | 9 | `sku_id`, `field_code` | 1 | 2 | 0.04 MiB |
| `product_identity_mappings` | 0 | 18 | `id` | 3 | 3 | 0.02 MiB |
| `product_image_generation_items` | 0 | 17 | `id` | 1 | 4 | 0.02 MiB |
| `product_image_generation_tasks` | 0 | 17 | `id` | 2 | 3 | 0.02 MiB |
| `product_images` | 1 | 16 | `id` | 1 | 3 | 0.02 MiB |
| `product_import_batches` | 5 | 30 | `id` | 0 | 3 | 0.04 MiB |
| `product_import_field_changes` | 3 | 19 | `id` | 3 | 3 | 0.02 MiB |
| `product_import_files` | 5 | 5 | `id` | 2 | 3 | 0.02 MiB |
| `product_import_issues` | 2,153 | 14 | `id` | 2 | 2 | 1.03 MiB |
| `product_import_rows` | 21,981 | 20 | `id` | 1 | 6 | 94.79 MiB |
| `product_inventory_snapshots` | 21,978 | 7 | `id` | 2 | 3 | 8.90 MiB |
| `product_listing_drafts` | 0 | 47 | `id` | 1 | 4 | 0.02 MiB |
| `product_listing_publish_records` | 0 | 13 | `id` | 1 | 2 | 0.01 MiB |
| `product_media_assets` | 6,583 | 15 | `id` | 0 | 6 | 6.03 MiB |
| `product_media_links` | 33,764 | 12 | `id` | 2 | 4 | 16.48 MiB |
| `product_models` | 6,500 | 12 | `id` | 3 | 2 | 2.29 MiB |
| `product_package_rows` | 21,714 | 57 | `id` | 4 | 4 | 98.52 MiB |
| `product_packaging_profiles` | 18,347 | 11 | `sku_id` | 2 | 1 | 3.57 MiB |
| `product_price_change_events` | 0 | 21 | `id` | 3 | 5 | 0.02 MiB |
| `product_sku_current_prices` | 324,962 | 16 | `price_key` | 2 | 2 | 134.99 MiB |
| `product_sku_lifecycle` | 18,347 | 11 | `sku_id` | 2 | 2 | 6.43 MiB |
| `product_sku_lifecycle_events` | 18,393 | 10 | `id` | 2 | 2 | 6.51 MiB |
| `product_skus` | 18,347 | 26 | `id` | 5 | 8 | 17.49 MiB |
| `scheduled_export_run_events` | 216 | 11 | `id` | 1 | 1 | 0.05 MiB |
| `scheduled_export_runs` | 16 | 21 | `id` | 1 | 4 | 0.03 MiB |
| `scheduled_export_tasks` | 4 | 24 | `id` | 2 | 3 | 0.02 MiB |
| `scheduler_leases` | 1 | 4 | `name` | 0 | 1 | 0.01 MiB |
| `schema_migrations` | 23 | 2 | `version` | 0 | 1 | 0.01 MiB |

