# Commerce Ops PostgreSQL Repository Compatibility

Date: 2026-08-05  
Status: Phase 1 assessment

## Conclusion

The schema and selected business data are portable to PostgreSQL, but the current production composition root is not dual-provider capable. `DATABASE_PROVIDER=postgres` must remain disabled for production.

## Current capability

- A shared provider contract exists.
- A PostgreSQL provider implementation exists for infrastructure-level operations.
- Ten repository contract modules provide useful domain boundaries.
- The production composition root still constructs SQLite directly.
- SQLite-specific audit, scheduler, and provider implementations remain in the data layer.

## Required provider boundary

Introduce one production composition-root factory:

```text
DATABASE_PROVIDER=sqlite   -> SqliteProvider + SQLite repositories
DATABASE_PROVIDER=postgres -> PostgresqlProvider + PostgreSQL repositories
```

The default must remain `sqlite` until every required domain has parity tests.

## Porting order

1. Task, lease, and audit repositories.
2. Product and SKU master repositories.
3. Sales and inventory fact repositories.
4. Growth Radar read models.
5. Scheduler, import, and listing write paths.

## Required parity tests

- Transaction commit and rollback.
- Task state transitions and idempotency.
- Lease acquisition, renewal, and expiration.
- JSON and date filtering.
- Unique and partial-index behavior.
- Pagination and deterministic ordering.
- Agent Monitoring queries.
- Concurrent scheduler and import behavior.

Phase 1 proves data portability only. It does not authorize a provider switch.

