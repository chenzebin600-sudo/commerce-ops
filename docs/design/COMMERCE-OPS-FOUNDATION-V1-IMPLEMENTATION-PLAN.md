# Commerce Ops Foundation V1 Implementation Plan

Status: implementation baseline

## 1. Objective

Foundation V1 adds a shared operating-system kernel beneath the existing Commerce Ops
modules. It does not replace the Product Center, Growth Radar, Mabang image collector,
Mabang data scheduler, or Listing publisher.

The kernel owns four cross-module concerns:

1. Source and integration account registration.
2. Canonical identity and source-to-master links.
3. A normalized task envelope, event history, retry metadata, and leases.
4. Read-only master-data projections for products, SKUs, stores, warehouses, and owners.

## 2. Protected Boundaries

- `product_models` and `product_skus` remain the Product and SKU masters.
- `growth_shops` remains the Store master.
- Mabang encrypted credentials remain only in `mabang_account_profiles`.
- Growth Radar keeps its deterministic signal and `growth_focus_items` lifecycle.
- COM-015 keeps its image batches, sync runs, assets, and links.
- Listing publishing keeps its isolated sidecar database and publisher workflow.
- Existing migrations are immutable.
- The formal SQLite database is not migrated in this implementation node.

## 3. Additive Architecture

```mermaid
flowchart LR
    Sources["Source systems and accounts"] --> Facts["Existing fact and domain tables"]
    Facts --> Identity["Foundation identity registry"]
    Identity --> Domains["Growth / Images / Listing / Product Center"]
    Domains --> Work["Foundation task envelope"]
    Work --> Events["Events, retries, leases, audit evidence"]
```

Foundation records reference domain records. They do not copy business facts or become
the system of record for domain-specific workflow state.

## 4. Canonical Masters

| Master | Canonical source | Foundation responsibility |
| --- | --- | --- |
| Product | `product_models` | Stable read view and external identity links |
| SKU | `product_skus` | Stable read view and external identity links |
| Store | `growth_shops` | Stable read view and source identity links |
| Warehouse | `foundation_warehouses` | Canonical normalized warehouse identity |
| Owner | `foundation_owners` | Canonical operator/manager identity |

This deliberately avoids parallel Product, SKU, or Store tables.

## 5. Account Registry

`foundation_integration_accounts` points to the existing credential owner using
`credential_ref_type` and `credential_ref_id`. No password, cookie, token, or secret URL
is copied into Foundation tables.

Capabilities are explicit records such as:

- `orders.read`
- `inventory.read`
- `images.read`
- `listing.read`
- `listing.write`

An account is resolved by source system and capability. Existing modules may continue to
load credentials from their current secure owner while adoption is incremental.

## 6. Unified Task Contract

`foundation_tasks` is an orchestration envelope with:

- normalized state and priority;
- domain record reference;
- idempotency key;
- retry counters and next-available time;
- evidence, input, and result JSON;
- optional account, source run, owner, store, warehouse, and SKU context.

Domain tables remain authoritative. Projection adapters translate existing states into
the Foundation state vocabulary. New Foundation-owned work can use guarded transitions
and leases directly.

## 7. Migration Strategy

The candidate migration is:

`migrations/candidates/022_commerce_ops_foundation_v1.sql`

It is intentionally outside the top-level migrations directory so application startup
cannot apply it to the formal database. Validation uses:

1. a temporary database built from the existing migration chain;
2. a read-only online backup of the formal SQLite database;
3. protected-table row counts and content fingerprints before and after;
4. `integrity_check`, `foreign_key_check`, schema, index, and second-run checks.

Formal application requires a separate user approval.

## 8. Delivery Phases

### F1 - Foundation schema and contracts

- Candidate migration.
- State, capability, identity, and validation contracts.
- Repository and services.

### F2 - Compatibility projections

- Scheduled Mabang runs.
- COM-015 image sync runs and batches.
- Growth Radar focus items when migration 021 is present.
- Listing publisher jobs supplied through an isolated sidecar adapter.

### F3 - Validation

- Focused unit and integration tests.
- Full automated test suite.
- Build and Doctor.
- Isolated formal-copy migration rehearsal.

## 9. Explicit Non-Goals

- No formal database migration.
- No deletion or rewrite of historical data.
- No replacement of A2 or COM-015 workflow logic.
- No cross-database transaction with the Listing sidecar.
- No frontend redesign.
- No automatic credentials migration.
- No physical data consolidation before identity evidence is confirmed.

