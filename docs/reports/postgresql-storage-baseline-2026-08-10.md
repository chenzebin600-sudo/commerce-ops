# PostgreSQL storage baseline — 2026-08-10

## Scope and safety

This is a read-only baseline of the current Commerce Ops production database.
No service was stopped, no business row was changed, and no WAL was deleted.
Credentials and the configured archive command are deliberately redacted.

## Server and cluster

| Item | Observed value |
| --- | --- |
| PostgreSQL | 18.4, 64-bit Windows |
| Data directory | `D:\postgreSQL\data` |
| Formal database | `commerce_ops` |
| Formal database size | 7.139 GiB |
| `app` base tables | 141 |
| Local `pg_wal` | `D:\postgreSQL\data\pg_wal`, 64 files, 1.00 GiB |
| Archived WAL | `D:\PostgreSQLBackups\wal`, 5,102 files, 79.72 GiB |
| Archived WAL time range | 2026-08-06 19:13:55 through 2026-08-10 09:28:12 Asia/Shanghai |
| Current LSN at inventory | `19/3A1695E0` |
| Current WAL file at inventory | `00000001000000190000003A` |
| D-drive free space | 39.52 GiB |

The archived sequence was independently checked as continuous with no missing
segment between its first and last file. PostgreSQL reported 5,102 successful
archives and zero failures.

## Databases

| Database | Size (GiB) |
| --- | ---: |
| `commerce_ops` | 7.139 |
| `commerce_ops_cutover_rehearsal` | 3.388 |
| `commerce_ops_shadow` | 2.343 |
| `commerce_ops_staging` | 1.431 |
| `commerce_ops_staging_restore_20260806` | 1.214 |
| `commerce_ops_shadow_attempt_20260805_2020` | 0.388 |
| `commerce_ops_migration_test` | 0.023 |
| `commerce_ops_shadow_attempt_20260805_2017` | 0.012 |
| `postgres` | 0.008 |

The non-production rehearsal, shadow, staging, restore and migration databases
occupy about 8.80 GiB. They were not dropped or modified during this task.

## Largest formal tables

| Table | Total size (GiB) |
| --- | ---: |
| `app.price_control_price_snapshots` | 1.913 |
| `app.product_package_rows` | 1.256 |
| `app.product_price_change_events` | 0.804 |
| `app.product_import_rows` | 0.679 |
| `app.growth_inventory_raw_rows` | 0.417 |
| `app.product_sku_current_prices` | 0.357 |
| `app.product_import_field_changes` | 0.188 |
| `app.growth_sku_warehouse_sales_metrics` | 0.140 |
| `app.product_skus` | 0.121 |
| `app.growth_inventory_snapshots` | 0.121 |

## Connections and replication

- The inventory observed one active connection: the monitoring query itself.
- `pg_stat_replication` returned no replicas or streaming standbys.
- Only the existing `postgres` login currently has `REPLICATION`; no dedicated
  physical-backup role exists.

## WAL and archive settings

| Setting | Value |
| --- | --- |
| `archive_mode` | `on` |
| `archive_command` | configured; redacted |
| `wal_level` | `replica` |
| `wal_compression` | `off` |
| `full_page_writes` | `on` |
| `checkpoint_timeout` | 300 seconds |
| `max_wal_size` | 1,024 MiB |
| `min_wal_size` | 80 MiB |
| WAL segment size | 16 MiB |

`max_wal_size` constrains the local working WAL area, not the external archive.
The existing 30-day implementation prunes logical dumps only and contains no
archived-WAL retention operation. The archive therefore grows without a
recovery-bound cleanup boundary.

## Baseline conclusion

The production cluster is online and queryable, and WAL archiving is healthy,
but the archive lacks a verified physical base backup. The existing logical
`pg_dump` artifacts cannot serve as the base for WAL replay. A compressed
`pg_basebackup` plus independent restore validation is required before any WAL
cleanup recommendation can be considered executable.
