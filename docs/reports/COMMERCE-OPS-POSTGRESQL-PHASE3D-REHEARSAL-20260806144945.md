# Commerce Ops PostgreSQL Phase 3D Cutover/Rollback Rehearsal

Status: **PASS**  
Production provider: `sqlite`  
Rehearsal target: `commerce_ops_cutover_rehearsal`  
`is_switch_ready`: **false**

## Safety boundary

- Formal SQLite remained the production provider and was accessed through a pinned online-backup snapshot for transfer and validation.
- Formal `commerce_ops`, Shadow, migration-test, and staging databases were not rebuilt or used as the rehearsal target.
- Provider switching was process-scoped; no persistent `DATABASE_PROVIDER` change occurred.
- No external action or business Agent was developed or invoked.

## Source snapshot

- Tables: 92
- Views: 15
- Rows: 3875429
- Snapshot SHA-256: `7e6f4cd5c004bdaf15e28681ab58bfbdac0294464742d7b6780b39135ffe6321`
- Snapshot integrity: `ok`
- Snapshot creation: 60064 ms

## Gates

| Gate | Status | Evidence |
|---|---|---|
| Independent rehearsal database | PASS | commerce_ops_cutover_rehearsal |
| Complete source scope | PASS | 92/92 tables, 15 views |
| Row and digest parity | PASS | 92/92 tables |
| Bidirectional primary-key EXCEPT | PASS | zero source-only and target-only keys |
| Foreign keys, indexes, and views | PASS | 156 validated FKs, 319 indexes, 15 views |
| Business totals and deterministic samples | PASS | 10 totals, 42 samples |
| Application role boundary | PASS | CRUD allowed; CREATE/ownership/system role flags denied |
| Full write path | PASS | 7 core domains plus provider repositories |
| Process-scoped switch, health, and SQLite rollback | PASS | PostgreSQL child health passed; SQLite read-only startup probe passed |

## Synchronization timing

- Operation: REFRESH
- Total rehearsal: 431502 ms
- Full pre-validation and reconcile: 186542 ms
- Final full validation: 179097 ms
- Rows inserted: 18
- Rows updated: 42360
- Rows deleted: 0
- Rows skipped: 3833051
- Successful reconcile runs: 4
- Reconcile durations: 104, 3831, 3941, 4754 ms
- Measured reconcile p95: 4754 ms

## Remaining blockers

- SQLite feature development is still active; the rehearsal snapshot is not the final frozen source snapshot.
- The formal PostgreSQL candidate commerce_ops remains uninitialized and requires separate production-mutation approval.
- A final writer freeze, pinned snapshot, full-source reconcile, zero-difference validation, and explicit provider-switch approval have not occurred.
- PostgreSQL-to-SQLite reverse synchronization is not implemented; rollback after PostgreSQL-only writes remains unsafe.

## Cutover position

This run proves the independent rehearsal path against a consistent current snapshot. It does not authorize production cutover. Because SQLite feature development remains active, the final gate is a separately approved write freeze, final pinned snapshot, full-source reconcile, zero-difference validation, and provider switch.
