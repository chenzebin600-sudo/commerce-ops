# PostgreSQL Shadow Migration

This directory contains the versioned, non-production PostgreSQL Shadow contract.

## Safety boundary

- Target database: `commerce_ops_shadow`.
- Source SQLite is copied with the online backup API and read only through the snapshot.
- These migrations do not switch the application provider.
- The script refuses production and migration-test database names.
- Existing SQLite data and local file assets are never deleted or changed.

## Migrations

1. `001_legacy_tables.sql` creates the compatibility tables in `app`.
2. `002_ai_observability.sql` creates first-class AI observability tables in `ai_shadow`.
3. `003_legacy_constraints_indexes_views.sql` applies deferred foreign keys, indexes, and views.
4. `004_incremental_sync_control.sql` creates resumable sync state and batch ledgers in `shadow_meta`.
5. `005_fulfillment_provider.sql` adds the provider-backed fulfillment tables in `app`.
6. `006_price_control_provider.sql` adds Price Control validity and adjustment workflow fields and indexes.

Applied migration hashes and table-load markers are stored in `shadow_meta`.

## Run

Generate or refresh the contract without creating a database:

```powershell
node --env-file=.env --env-file=.env.postgres.local --disable-warning=ExperimentalWarning scripts/postgresql-shadow-phase1.mjs
```

Create or resume the isolated Shadow load:

```powershell
node --env-file=.env --env-file=.env.postgres.local --disable-warning=ExperimentalWarning scripts/postgresql-shadow-phase1.mjs --apply
```

The load is resumable. Migration and table hashes must match before an existing Shadow database is reused.
