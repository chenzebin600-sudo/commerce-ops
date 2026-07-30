# COM-GROWTH-RADAR-V2.2 INT-1-B Report

> Date: 2026-07-27
> Branch: `master`
> Baseline HEAD: `a8327c524764f89eda8127e32b4aa48e38c3fac6`
> Scope: candidate migrations 019/020/021 only

## 1. Result

INT-1-B passed the candidate-migration technical gate.

- 020 now activates `GRV2-METRICS-1.2.0`.
- Valid order statuses are `已发货`, `待处理`, `配货中`, and `已完成`.
- The low-capture threshold is `10%`.
- Inventory risk is modeled at country + warehouse + SKU grain.
- Signals and operation tasks carry source and normalized warehouse dimensions.
- Migration 016 remains intentionally unused; no empty migration was created.

The candidates may re-enter the formal gate. They are not approved for formal-database application yet.

## 2. Migration changes

### 019 - analysis schema

- Added `growth_sku_warehouse_daily_metrics` at country + warehouse + SKU grain.
- Added warehouse-level source sellable days, inventory, sales, supply status, slow-moving status, quality, and evidence fields.
- Added `ASSORTMENT_VERIFIED_*` country-SKU fields and warehouse risk summary fields.
- Added a database constraint that prevents `GRV2-METRICS-1.2.0` rows from storing country-level computed sellable days.
- Added warehouse dimensions to `growth_signals`.
- Added warehouse metrics and country-only aggregate views.

Legacy country supply columns remain only for existing `1.1.0` runtime regression coverage. The `1.2.0` constraint prevents their use by the formal successor contract.

### 020 - formal metrics contract

- Retires the initial 019 rule and activates `GRV2-METRICS-1.2.0`.
- Stores all four approved order statuses.
- Stores the `GRV2-THRESHOLDS-1.2.0-DEFAULT` profile with 32 versioned configuration leaves.
- Sets the low-capture ratio to `0.10`.
- Stores and verifies a SHA-256 hash of the exact contract JSON.

### 021 - task lifecycle

- Added source and normalized warehouse columns to `growth_focus_items`.
- Added `warehouse_sku` as a valid task subject.
- Added warehouse consistency constraints and an indexed warehouse lookup path.

## 3. Migration number governance

`docs/design/COMMERCE-OPS-MIGRATION-NUMBER-GOVERNANCE.md` records that 016 is intentionally unused. The migration runner accepts recorded numeric gaps, tests reject any future `016_*.sql`, and the next candidate number is 022 unless separately approved.

## 4. Formal-database copy rehearsal

The formal source was opened read-only and copied with SQLite Online Backup.

- Source highest migration: `018_mabang_image_collection_performance.sql`
- Applied to copy: 019, 020, 021
- Copy highest migration: `021_growth_radar_task_lifecycle.sql`
- Active rule: `GRV2-METRICS-1.2.0`
- Protected existing tables checked: 60
- Changed protected tables: 0
- `integrity_check`: `ok`
- Foreign-key violations: 0
- Temporary copy retained: no

Formal source content hashes were unchanged:

| File | SHA-256 |
| --- | --- |
| SQLite | `5aa3ad56465f2602f899e3bb7c20e59dd327a3a13824811de48d464c47acec84` |
| WAL | `3c4cec0291896401e104a9026ea58d8b82844a3e15e4d7deddafe7e3cb0b694a` |
| SHM | `205f3438f59b36d21a18c58ecd4d16def4aa6c9e63d8831dd9af354455befea6` |

The SHM modification timestamp changed when the read-only SQLite connection opened it; its bytes and SHA-256 remained unchanged.

## 5. Empty-database and idempotency rehearsal

- Full migration files applied: 20 (016 is intentionally absent)
- Second migration run applied: 0
- Candidate tables: 11
- Growth V2 views: 8
- Candidate indexes: 26
- Candidate foreign keys: 23
- Active rule: `GRV2-METRICS-1.2.0`
- Valid order statuses: all four approved values
- Low-capture ratio: `0.10`
- `integrity_check`: `ok`
- Foreign-key violations: 0

## 6. Tests

`node --test tests/growth-radar-v2.test.mjs`

- Tests: 11
- Passed: 11
- Failed: 0

The migration test verifies the 1.2.0 contract, JSON hash, 32 configuration leaves, warehouse schema, country-level supply guard, task warehouse dimension, and 016 governance. Existing runtime behavior is exercised through an explicit isolated-test adapter for the legacy 1.1.0 contract; production code was not changed.

Full-suite tests, Build, and Doctor were not run because this node changed only candidate migrations, migration tests, and design/report documents.

## 7. Safety and gate decision

No formal migration was executed. No formal data, A2 logic, COM-015 logic, or frontend integration was modified.

Candidate-migration gate: **PASS**.

Formal application gate: **BLOCKED** until a separately approved runtime-alignment node updates the Growth Radar V2 engine, repository, service, API, and frontend contract use from legacy 1.1.0 semantics to `GRV2-METRICS-1.2.0`. After that alignment, rerun the full suite, Build, Doctor, and this formal-copy rehearsal before requesting formal migration approval.
