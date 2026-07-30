# Commerce Ops Foundation V1 Migration Runbook

> Status: prepared, not executed
> Target database: `storage/commerce-ops.sqlite`
> Required start version: `018_mabang_image_collection_performance.sql`
> Required end version: `022_commerce_ops_foundation_v1.sql`

## 1. Safety gate

This runbook is executable only after explicit user approval.

Before approval:

- Do not move candidate migration `022` into the automatic migration directory.
- Do not start the application, scheduler, migration command, or analysis runner against the formal database.
- Do not update store owners or warehouse mappings in the formal database.
- Do not delete or edit historical migrations.

The formal migration must be performed during a write freeze. The main server,
scheduler, Mabang data service, image workers, Listing service, and any ad-hoc
database clients must be stopped before backup.

## 2. Frozen migration set

Apply the following migrations without starting the application between them:

| Order | Migration | SHA-256 | Purpose |
|---:|---|---|---|
| 1 | `019_growth_radar_v2_analysis.sql` | `f626eb7b601b3913197a3209b4c709e24ec9413ea66349ce530b49f00f4178a3` | Growth Radar V2 run, metric, signal, mapping, and rule structures |
| 2 | `020_growth_radar_direction_contract.sql` | `8e5403c6163e41a270a35b4dee5356bc50a76926b3177639f7ed6f895fcccd9b` | Retire the bootstrap rule and activate `GRV2-METRICS-1.2.0` |
| 3 | `021_growth_radar_task_lifecycle.sql` | `823e9086477432ba6e36a64a2f70a7925dbc85e32bfdef895a53dd77b8bb5bc3` | Growth Radar focus task lifecycle and event history |
| 4 | `022_commerce_ops_foundation_v1.sql` | `650b12fa75a0dfdc08d4c6379df3beeade76706639dfd8778b4550c5e59cc836` | Foundation accounts, master references, tasks, leases, events, and views |

Migration `019` temporarily inserts the historical bootstrap rule. Migration
`020` immediately retires it and activates `GRV2-METRICS-1.2.0`. Therefore
`019` and `020` are one indivisible cutover unit.

Candidate `022` stays in `migrations/candidates/` until approval. At cutover,
promote the exact file bytes to `migrations/022_commerce_ops_foundation_v1.sql`
and verify the SHA-256 before opening the migration runner.

## 3. Pre-migration evidence

The preflight must record:

1. Branch, HEAD, and `git status`.
2. No listener on ports `3101`, `3193`, `4173`, and `9222`.
3. No scheduler, worker, or background service that can write SQLite.
4. Formal database latest migration is exactly `018`.
5. `PRAGMA integrity_check` returns `ok`.
6. `PRAGMA foreign_key_check` returns zero rows.
7. Main, WAL, and SHM sizes and SHA-256 values.
8. Baseline row counts for every protected table in section 6.
9. Exact SHA-256 values for migrations `019` through `022`.
10. Mapping manifest SHA-256 matches the approved local manifest.

Current approved local mapping manifest:

`storage/go-live/foundation-v1-go-live-mappings.json`

Expected SHA-256:

`327f9f5e6a8bb0bd69f52c7af283fdca60eed9d788dc9431000f99f81713f015`

The manifest is under the ignored `storage/` directory because it contains
store-to-owner operational data. It must not be committed.

## 4. Backup plan

Create a timestamped directory outside the live database directory:

`backups/foundation-v1/<UTC timestamp>/`

With every writer stopped:

1. Capture SHA-256 and byte size for:
   - `commerce-ops.sqlite`
   - `commerce-ops.sqlite-wal`
   - `commerce-ops.sqlite-shm`
2. Use the Node SQLite online backup API to create
   `commerce-ops-pre-019.sqlite`.
3. Copy the stopped raw main/WAL/SHM triplet into a `raw/` subdirectory.
4. Generate `backup-manifest.json` containing source paths, sizes, hashes,
   latest migration, integrity result, foreign-key result, and protected row
   counts.
5. Open the online backup read-only and verify:
   - latest migration is `018`;
   - integrity is `ok`;
   - foreign-key violations are zero;
   - protected row counts match the live preflight.
6. Mark the backup immutable for the duration of the cutover.

The online backup is the logical recovery source. The raw triplet is retained
for byte-exact incident recovery because the formal database currently has a
non-empty WAL.

## 5. Migration execution

After backup validation:

1. Recheck that no writer has restarted.
2. Promote candidate `022` to the top-level migration directory without
   changing its bytes.
3. Recalculate all four migration hashes.
4. Run the migration process once against the explicit formal database path.
5. Do not start the web application between migrations.
6. Confirm `schema_migrations` added exactly `019`, `020`, `021`, and `022` in
   lexical order.
7. Confirm the latest active Growth Radar rule is
   `GRV2-METRICS-1.2.0`.

No formal Growth Radar analysis, operation-task generation, image crawl,
Listing publication, or scheduled export is started by the migration.

## 6. Immediate post-migration verification

The protected baseline for the current formal database is:

| Table | Pre-migration rows |
|---|---:|
| `mabang_account_profiles` | 2 |
| `scheduled_export_tasks` | 1 |
| `scheduled_export_runs` | 2 |
| `product_models` | 6,500 |
| `product_skus` | 18,347 |
| `product_package_rows` | 21,714 |
| `product_media_assets` | 6,583 |
| `product_media_links` | 33,759 |
| `mabang_sku_image_batches` | 210 |
| `mabang_sku_image_sync_runs` | 2 |
| `growth_shops` | 107 |
| `growth_order_headers` | 2,043 |
| `growth_order_lines` | 2,726 |
| `growth_inventory_snapshots` | 21,460 |
| `product_listing_drafts` | 0 |
| `product_listing_publish_records` | 0 |

Immediately verify:

- `PRAGMA integrity_check = ok`;
- `PRAGMA foreign_key_check` returns zero rows;
- all protected row counts still match;
- latest migration is `022`;
- all expected Foundation and Growth Radar schema objects exist;
- no credential value exists in a Foundation table;
- Foundation initial counts match the isolated rehearsal:
  - 6 source systems;
  - 2 integration-account references;
  - 10 account capabilities;
  - 1 unassigned owner before owner initialization;
  - 29 warehouse identities before country initialization;
  - 24,983 identity links;
  - 0 Foundation tasks before projection.

## 7. Post-migration master-data initialization

This step occurs only after migration verification.

Use the approved local mapping manifest:

- Create or update 21 Foundation Owner references.
- Assign all 107 canonical stores to their confirmed owner.
- Create one versioned Growth Radar warehouse-country mapping set.
- Confirm 27 warehouse-country mappings.
- Explicitly exclude 2 encoding-damaged warehouse names.
- Synchronize Foundation Product, SKU, Store, Warehouse, and Owner references.
- Project existing scheduler, COM-015, Growth Radar, and Listing tasks without
  copying business facts.

After initialization, verify:

- 107/107 stores have one owner;
- no store has multiple owners;
- 29/29 warehouse names have either `confirmed` or `excluded` status;
- confirmed Foundation warehouse countries match the active Growth Radar
  mapping set;
- repeated projection is idempotent and does not increase task versions.

Do not start the first formal Growth Radar analysis automatically. That remains
a separate user-approved operation.

## 8. Rollback

There are no reverse SQL migrations. Rollback is file restoration.

If any migration or immediate validation fails:

1. Keep all services stopped.
2. Preserve the failed main/WAL/SHM files and migration log in an incident
   directory.
3. Restore the complete pre-migration raw triplet, or restore the validated
   online backup as a new database file while removing stale WAL/SHM files.
4. Verify the restored main/WAL/SHM hashes against `backup-manifest.json`.
5. Open the restored database read-only.
6. Verify latest migration `018`, integrity `ok`, zero foreign-key violations,
   and all protected row counts.
7. Start Doctor before any application service.
8. Do not retry until the failure has a written root-cause analysis.

If migration succeeds but master-data initialization fails, prefer restoring
the pre-migration backup rather than manually deleting Foundation rows.

## 9. Final acceptance

After migration and initialization, run:

- Foundation focused tests;
- Growth Radar focused tests;
- full test suite;
- Build;
- Doctor;
- A2 isolation gates;
- COM-015 image tests;
- Listing integration tests.

Production activation is accepted only when all checks pass and the formal
database remains integrity-clean with zero foreign-key violations.
