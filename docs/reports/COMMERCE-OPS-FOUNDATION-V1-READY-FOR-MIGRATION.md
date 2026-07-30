# COMMERCE-OPS-FOUNDATION-V1 READY FOR MIGRATION

> Date: 2026-07-28
> Branch: `master`
> HEAD: `a8327c524764f89eda8127e32b4aa48e38c3fac6`
> Gate status: ready for explicit migration approval; formal migration not executed

## 1. Current formal state

- Formal database latest migration:
  `018_mabang_image_collection_performance.sql`.
- Migration rows: 17 (`016` is intentionally absent; no empty migration was
  created).
- SQLite integrity: `ok`.
- Foreign-key violations: 0.
- Ports `3101`, `3193`, `4173`, and `9222`: no listeners during this audit.
- Formal database main, WAL, and SHM files were opened read-only only.

Formal file evidence:

| File | Bytes | SHA-256 |
|---|---:|---|
| `commerce-ops.sqlite` | 454,479,872 | `5aa3ad56465f2602f899e3bb7c20e59dd327a3a13824811de48d464c47acec84` |
| `commerce-ops.sqlite-wal` | 70,798,112 | `3c4cec0291896401e104a9026ea58d8b82844a3e15e4d7deddafe7e3cb0b694a` |
| `commerce-ops.sqlite-shm` | 32,768 | `205f3438f59b36d21a18c58ecd4d16def4aa6c9e63d8831dd9af354455befea6` |

The same hashes were observed before and after the isolated rehearsal.

## 2. Owner readiness

The formal `growth_shops` table contains 107 stores and currently has 107
missing `owner_user_id` values.

The user-provided order workbook is the approved owner evidence:

- workbook rows: 57,915;
- source shops: 131;
- distinct owners: 21;
- shops with conflicting owners: 0;
- formal stores resolved: 107/107;
- ambiguous formal stores: 0;
- unresolved formal stores: 0.

The system is not a single-owner environment, so a blanket default Owner must
not be used. Store assignment will use exact shop-name evidence from the
approved order workbook.

Order workbook SHA-256:

`37d652fada35cdc7e4e408740372a4fb7ebc9efcbeddd9a81e52e6376704c2c2`

## 3. Warehouse readiness

The latest inventory workbook contains 24 clean warehouse names. The formal
database historical union contains 29 names:

- 27 have a deterministic country result from an explicit country prefix;
- 2 contain damaged source text and are explicitly excluded;
- 0 remain without a decision.

The two excluded source names do not enter country analysis. They remain
traceable and can be remapped later after the source text is corrected.

Inventory workbook SHA-256:

`54fc3df7f8bf300a367bface3b3887d543bfb0bdbb2450e9bb330cc7bbbc69cd`

The local owner and warehouse manifest is:

`storage/go-live/foundation-v1-go-live-mappings.json`

Manifest SHA-256:

`327f9f5e6a8bb0bd69f52c7af283fdca60eed9d788dc9431000f99f81713f015`

The manifest is ignored by Git because it contains operational Owner data.

## 4. Migration audit

### 019

Creates Growth Radar V2 mapping sets, rule sets, analysis runs, SKU metrics,
warehouse-SKU supply metrics, store metrics, signals, indexes, and published
views. Supply risk is modeled at country + warehouse + SKU grain. Existing
A2 fact tables are referenced but not altered.

### 020

Retires the bootstrap rule created by `019` and activates
`GRV2-METRICS-1.2.0`. It freezes the four valid order statuses, 10% low-capture
threshold, P80 assortment threshold, 30-row minimum sample, warehouse-level
supply semantics, and the approved task limit.

Risk: the application must not start between `019` and `020`.

### 021

Creates the Growth Radar focus-task lifecycle, immutable event history,
warehouse-aware task identity, and open-task view. It does not write tasks
during migration.

### 022

Creates the Foundation account registry, capabilities, owners, warehouses,
identity links, source runs, unified task envelope, task events, leases, and
master views. It references existing encrypted Mabang accounts but does not
copy usernames, passwords, cookies, or tokens.

It backfills references only. The isolated rehearsal proved no protected
business table changed.

## 5. Isolated rehearsal

The formal database was backed up through the SQLite online-backup API and the
rehearsal ran on a temporary copy.

Result:

- start migration: `018`;
- applied: `019`, `020`, `021`, `022`;
- end migration: `022`;
- integrity: `ok`;
- foreign-key violations: 0;
- protected tables checked: 14;
- changed protected tables: 0;
- temporary copy retained: no;
- formal main/WAL/SHM hashes unchanged.

Initial Foundation projection counts:

| Object | Rows |
|---|---:|
| Source systems | 6 |
| Integration account references | 2 |
| Account capabilities | 10 |
| Owners before assignment | 1 |
| Warehouse identities | 29 |
| Identity links | 24,983 |
| Foundation tasks before projection | 0 |

## 6. Focused validation

- Foundation and Growth Radar focused tests: `17/17` passed.
- Migration contract, account security, task lifecycle, leases, idempotent
  projections, warehouse supply grain, published fallback, and configuration
  validation are covered.
- `git diff --check`: passed; only existing Windows line-ending warnings were
  reported.

Full Build, Doctor, A2, COM-015, Listing, and complete regression remain
mandatory after formal migration and initialization.

## 7. Worktree and safe commit boundary

The worktree is not clean. It contains concurrent changes from multiple
completed or in-progress streams. A whole-worktree commit is unsafe.

### Foundation-owned files

- `lib/foundation/**`
- `migrations/candidates/022_commerce_ops_foundation_v1.sql`
- `scripts/foundation-v1-isolated-migration-rehearsal.mjs`
- `tests/foundation-v1.test.mjs`
- Foundation V1 implementation, phase, validation, runbook, and final reports

### Growth Radar-owned files

- `lib/growth-radar/v2/**`
- `frontend/growth-radar-v2/**`
- `public/growth-radar-v2*`
- `migrations/019_*`, `020_*`, and `021_*`
- Growth Radar V2 tests, assets, design documents, and reports

### COM-015-owned files

- `lib/mabang-images/**`
- `public/mabang-images-page.mjs`
- `migrations/017_*` and `018_*`
- COM-015 worker, tests, and reports

### Mabang data and Listing-owned files

- `lib/mabang-data/**`
- `integrations/**`
- `frontend/mabang-listing/**`
- Mabang Listing loaders, service managers, tests, and assets
- scheduler and Mabang source integration changes

### Shared or mixed files

- `lib/data/data-access.mjs`
- `server.mjs`
- `package.json`
- `public/app.js`
- `public/index.html`
- shared audit, runtime configuration, build, Doctor, and PostgreSQL-readiness
  files

Shared files must be staged by patch after reviewing each hunk. Do not stage
them by path. Recommended commit order:

1. COM-015 and Mabang data integration;
2. Growth Radar V2 plus `019` through `021`;
3. Foundation V1 plus candidate `022`;
4. architecture, showcase, and delivery documents.

Run focused and full validation after each commit boundary. No files were
staged, committed, pushed, deleted, or reverted during this readiness audit.

## 8. Backup and rollback

The complete procedure is frozen in:

`docs/design/COMMERCE-OPS-FOUNDATION-V1-MIGRATION-RUNBOOK.md`

The cutover requires:

1. write freeze;
2. online SQLite backup;
3. raw main/WAL/SHM triplet backup;
4. SHA-256 manifest;
5. protected row-count baseline;
6. uninterrupted `019` through `022` migration;
7. immediate integrity, foreign-key, schema, row-count, and secret checks.

There are no reverse SQL migrations. Rollback restores the validated
pre-migration database files while every writer is stopped.

## 9. Decision

Technical migration preparation is complete.

The formal database is unchanged and remains at `018`. Candidate `022` remains
outside automatic migration discovery.

The next action requires explicit human approval:

> Freeze writers, create and verify the full backup, promote the exact candidate
> `022`, apply migrations `019` through `022`, then initialize the approved
> Owner and warehouse mappings.

No formal migration or master-data write is authorized by this report alone.
