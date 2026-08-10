# Commerce Ops PostgreSQL Incremental Sync Report

Status: **PASS**  
Direction: `SQLite -> PostgreSQL Shadow`  
Production provider: `sqlite`

## Safety

- Formal SQLite was opened read-only and copied with the SQLite online backup API.
- The only write target was `commerce_ops_shadow` through the migrator role.
- No reverse synchronization, production provider switch, DELETE propagation, business-Agent development, or file migration occurred.
- `is_switch_ready` remains false even when validation passes.

## Baseline

- Phase 1 snapshot: `<workspace>\tmp\postgresql-shadow-phase1\commerce-ops-shadow-source.sqlite`
- Phase 1 snapshot time: `2026-08-05T12:20:45.780Z`
- Phase 1 SHA-256: `46704f2d4f2c6792cedb870658a8fdb020bb4a2b3edba33a0e12e0424f8c11db`
- Control migration: `004_incremental_sync_control.sql` (ALREADY_APPLIED)

## Current snapshot

- Path: `<workspace>\tmp\postgresql-incremental-sync\commerce-ops-incremental-20260806022032-07b95bd3.sqlite`
- Snapshot time: `2026-08-06T02:20:47.373Z`
- SHA-256: `8e36b5438ce1c10ff3fed00957ba4e9156643ff7986faf150a04dcc0e2456a8d`
- Integrity: `ok`
- Foreign-key violations: 0

## Synchronization

- Batch: `62d92fe3-bfce-41d5-ada0-2d728769cee9`
- Tables: 47
- Rows examined: 629254
- INSERT: 390928
- UPDATE: 204562
- Skipped by full-table digest: 33764

| Table | Domain | Examined | Inserted | Updated | Skipped |
|---|---|---:|---:|---:|---:|
| `dingtalk_robot_configs` | dependency | 1 | 0 | 1 | 0 |
| `foundation_source_systems` | task | 1 | 0 | 1 | 0 |
| `foundation_warehouses` | task | 29 | 0 | 29 | 0 |
| `growth_country_mapping_sets` | dependency | 1 | 0 | 1 | 0 |
| `growth_shops` | sales | 70 | 69 | 1 | 0 |
| `mabang_account_profiles` | dependency | 1 | 0 | 1 | 0 |
| `operation_audit_events` | audit | 203 | 166 | 37 | 0 |
| `product_detail_preferences` | product | 1 | 0 | 1 | 0 |
| `product_import_batches` | product | 1 | 0 | 1 | 0 |
| `product_media_assets` | product | 26 | 0 | 26 | 0 |
| `foundation_identity_links` | task | 24983 | 0 | 24983 | 0 |
| `foundation_integration_accounts` | task | 1 | 0 | 1 | 0 |
| `foundation_owners` | task | 21 | 0 | 21 | 0 |
| `growth_warehouse_country_mappings` | sales | 29 | 0 | 29 | 0 |
| `product_categories` | product | 2 | 0 | 2 | 0 |
| `product_import_rows` | product | 2 | 0 | 2 | 0 |
| `scheduled_export_tasks` | dependency | 3 | 0 | 3 | 0 |
| `foundation_account_capabilities` | task | 10 | 0 | 10 | 0 |
| `foundation_source_runs` | task | 15 | 14 | 1 | 0 |
| `product_models` | product | 1 | 0 | 1 | 0 |
| `product_package_rows` | product | 2 | 0 | 2 | 0 |
| `scheduled_export_runs` | dependency | 4 | 3 | 1 | 0 |
| `export_files` | dependency | 4 | 2 | 2 | 0 |
| `product_skus` | product | 5 | 0 | 5 | 0 |
| `foundation_tasks` | task | 159 | 124 | 35 | 0 |
| `growth_source_batches` | sales | 3 | 2 | 1 | 0 |
| `product_ai_contents` | product | 0 | 0 | 0 | 0 |
| `product_cost_snapshots` | product | 1 | 0 | 1 | 0 |
| `product_field_override_events` | product | 2 | 0 | 2 | 0 |
| `product_field_overrides` | product | 1 | 0 | 1 | 0 |
| `product_images` | product | 1 | 0 | 1 | 0 |
| `product_import_files` | product | 1 | 0 | 1 | 0 |
| `product_inventory_snapshots` | product | 2 | 0 | 2 | 0 |
| `product_media_links` | product | 33764 | 0 | 0 | 33764 |
| `product_packaging_profiles` | product | 2 | 0 | 2 | 0 |
| `product_sku_lifecycle` | product | 2 | 0 | 2 | 0 |
| `product_sku_lifecycle_events` | product | 18131 | 0 | 18131 | 0 |
| `foundation_task_events` | task | 161 | 126 | 35 | 0 |
| `foundation_task_leases` | task | 0 | 0 | 0 | 0 |
| `growth_inventory_raw_rows` | inventory | 81721 | 81721 | 0 | 0 |
| `growth_inventory_snapshots` | inventory | 40204 | 20155 | 20049 | 0 |
| `growth_order_headers` | sales | 2456 | 372 | 2084 | 0 |
| `growth_order_raw_rows` | sales | 150813 | 150813 | 0 | 0 |
| `growth_shop_source_mappings` | sales | 195 | 69 | 126 | 0 |
| `growth_order_lines` | sales | 3441 | 425 | 3016 | 0 |
| `growth_sku_warehouse_sales_metrics` | inventory | 40204 | 20155 | 20049 | 0 |
| `growth_order_inventory_links` | sales | 232574 | 116712 | 115862 | 0 |

## Validation

- Result: **PASS**
- Tables checked: 47
- Count differences: 0
- Deterministic random samples: 42
- Sample failures: 0
- Business counts: {"productSkus":{"source":18347,"target":18347,"match":true},"orderHeaders":{"source":80140,"target":80140,"match":true},"orderLines":{"source":116293,"target":116293,"match":true},"inventorySnapshots":{"source":81703,"target":81703,"match":true},"tasks":{"source":376,"target":376,"match":true},"auditEvents":{"source":42197,"target":42197,"match":true}}
- Differences: none

DELETE synchronization remains intentionally unsupported. Any target-only row is reported and blocks switch readiness rather than being removed.
