# Commerce Ops Foundation V1 - F2 Adapter Review

Date: 2026-07-28

## What Changed

- Added a source/account capability registry.
- Added incremental Product, SKU, Store, Warehouse, and Owner identity synchronization.
- Added Foundation-owned task transitions, retry metadata, events, and leases.
- Added read-only domain projections for:
  - scheduled Mabang data runs;
  - COM-015 image sync runs and bounded image batches;
  - Growth Radar focus items when migration 021 exists;
  - Listing sidecar publish jobs supplied by the sidecar boundary.
- Added a secure Listing account bridge.

## Architecture

Domain tables remain authoritative. Foundation stores a normalized envelope with the
original `source_state` and domain reference. Projected tasks are read-only in
Foundation; their state must be changed in the owning module.

The Listing bridge resolves the Foundation account to `mabang_account_profiles`, reads
the encrypted password through the existing account repository, decrypts in memory, and
passes it to the local Listing connector. It does not persist or return the secret.

## Data Impact

- No domain record is changed by projection.
- Repeated projection with unchanged data performs no task-version update.
- Manually confirmed identity links and warehouse mappings are preserved during refresh.

## Tests

- Capability resolution and missing-capability behavior.
- Secret non-persistence.
- Listing in-memory credential bridge.
- Task idempotency and guarded transitions.
- Retry and lease contention.
- Scheduler, image, and Listing projection.

## Risks

- Listing projection is eventually consistent because its database is intentionally
  isolated; there is no cross-database atomic transaction.
- Runtime API activation waits for formal migration approval.

