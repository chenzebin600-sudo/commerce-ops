# Commerce Ops PostgreSQL Production Migration Roadmap

Status: planning only  
Current production provider: `sqlite`  
Current PostgreSQL target: `commerce_ops_shadow`  
Production switch approved: no

## 1. Current position

Completed:

- PostgreSQL Shadow schema conversion and baseline load.
- Phase 1 consistency verification.
- Provider factory and dual-provider read repositories for Product, Sales, Inventory, Task, Audit,
  Context, and Agent Monitoring.
- One-way SQLite-to-Shadow INSERT/UPDATE synchronization.
- Migration state, pause/resume, difference reporting, and independent revalidation.
- Read-only SQLite and PostgreSQL startup probes for Vue, Foundation, Daily Report Agent, Runtime,
  Context, and Monitoring.

Not completed:

- A PostgreSQL-capable full-server composition root.
- Production write-path parity.
- DELETE/tombstone semantics.
- Scheduler, file lifecycle, Price Control, synchronous audit, and fulfillment provider migration.
- Production credentials, HA, backup/restore, observability, and cutover approval.

Therefore `is_switch_ready` must remain `false`.

## 2. Remaining SQLite dependencies

| Boundary | Current state | Required change |
| --- | --- | --- |
| Full application composition | `openCommerceDataAccess` owns SQLite migrations and synchronous repositories | Introduce an async provider-aware composition root while preserving the SQLite default |
| Scheduler and scheduled exports | SQLite-specific mutation repository | Move leases, retries, runs, and export metadata behind async provider repositories |
| File lifecycle, export, and review | Metadata and lifecycle SQL are SQLite-bound | Port metadata repositories; keep binaries under `LocalStorageProvider` |
| Operation audit writes | Existing public contract is synchronous | Convert callers to awaited async writes through `AuditRepository` |
| Price Control | Provider-specific SQL and mutation flow | Port SQL, transactions, idempotency, and verification to PostgreSQL |
| Fulfillment | Independent SQLite ownership | Decide whether to absorb into the common provider or retain an explicit bounded database |
| DELETE semantics | Not synchronized | Add soft-delete/tombstone contract or approved CDC before cutover |

## 3. Delivery phases

### Phase 3A: complete provider-neutral write contracts

1. Inventory every direct `node:sqlite`, `DatabaseSync`, SQLite repository, and direct connection
   import in runtime code.
2. Replace synchronous repository contracts with awaited async interfaces.
3. Port Scheduler, Audit, file metadata, Price Control, and the selected fulfillment boundary.
4. Run write-contract tests in isolated SQLite and PostgreSQL test databases.
5. Keep `DATABASE_PROVIDER=sqlite` in all production launch paths.

### Phase 3B: writable PostgreSQL rehearsal

1. Create an isolated writable rehearsal database separate from Shadow.
2. Execute realistic create/update/retry/idempotency cases for each write domain.
3. Verify transaction rollback, unique constraints, JSON, timestamps, pagination, and UPSERT behavior.
4. Re-run Daily Report and Agent Runtime with delivery and external calls disabled.
5. Measure query latency and add only evidence-backed indexes.

### Phase 3C: operational readiness

1. Provision production PostgreSQL with least-privilege app, migrator, backup, and monitoring roles.
2. Configure encrypted backups, point-in-time recovery, retention, and a tested restore runbook.
3. Add connection-pool, lock, replication, disk, and slow-query monitoring.
4. Define the final database name independently of `commerce_ops_shadow`.
5. Add immutable deployment configuration and secret rotation.

### Phase 3D: cutover rehearsal

1. Clone the production SQLite database and production-like PostgreSQL target.
2. Run baseline plus repeated incremental batches until the delta is small.
3. Exercise freeze, final synchronization, full validation, provider switch, startup verification, and
   rollback as one timed runbook.
4. Prove that rollback does not require copying PostgreSQL writes back into SQLite by keeping the
   migration window read-only or by defining an explicit dual-write/change-capture policy first.

## 4. Production cutover gates

All gates must pass before requesting approval:

- No direct SQLite access remains in the selected production composition except explicitly deferred
  bounded systems.
- Every production write repository has SQLite/PostgreSQL contract parity and rollback tests.
- Repeated incremental validation passes with no target-only rows.
- DELETE/tombstone policy is approved and tested.
- PostgreSQL backup restore has been rehearsed.
- Full tests, Vue build, Doctor, Daily Report, Agent Runtime, Monitoring, scheduler, and integrations
  pass against PostgreSQL.
- Performance and capacity meet an approved baseline.
- A named operator, maintenance window, communication plan, and rollback owner are assigned.
- A separate human approval authorizes formal SQLite freeze and provider switch.

## 5. Proposed cutover runbook

1. Announce the maintenance window and stop mutating scheduler/integration jobs.
2. Set Commerce Ops to maintenance/read-only mode.
3. Back up formal SQLite, WAL, local media manifest, and configuration; verify hashes and integrity.
4. Take the final pinned SQLite online-backup snapshot.
5. Run the final incremental synchronization.
6. Run counts, primary-key differences, business totals, deterministic samples, foreign keys, and
   application smoke tests.
7. Require the migration state to be unpaused, latest batch successful, latest validation PASS, and
   all external cutover gates approved.
8. Change deployment configuration to PostgreSQL and start one controlled application instance.
9. Verify Product, Sales, Inventory, Task, Audit, Daily Report, Agent Runtime, Monitoring, scheduler,
   Vue, and critical integrations.
10. Re-enable jobs gradually and monitor errors, locks, latency, and business counts.

No current command is authorized to perform steps 8-10 in production.

## 6. Rollback plan

Rollback is straightforward only while no PostgreSQL-only production writes have occurred:

1. Stop the PostgreSQL-backed application and all mutating jobs.
2. Restore `DATABASE_PROVIDER=sqlite` from the immutable pre-cutover configuration.
3. Verify the frozen SQLite database, WAL pairing, hashes, integrity, and foreign keys.
4. Start one SQLite-backed instance and run critical smoke checks.
5. Re-enable jobs and integrations gradually.
6. Preserve PostgreSQL for forensic comparison; do not delete or overwrite it.

If PostgreSQL has accepted production writes, rollback requires an approved reverse change capture or
manual reconciliation plan. The present system intentionally has no reverse synchronization, so the
initial cutover window must prevent that ambiguity.

## 7. Migration window estimate

The first-load rehearsal took about two minutes because it loaded large raw fact tables. Steady-state
final synchronization should be measured over several daily runs before scheduling cutover. A
provisional maintenance window is 30-60 minutes, covering freeze, final snapshot, synchronization,
validation, startup smoke tests, and a rollback decision point. This is a planning range, not a
promise; measured p95 run time plus operational buffer must set the final window.

## 8. Immediate next step

Start Phase 3A with an audit-only inventory of remaining SQLite write boundaries, then migrate one
bounded write domain at a time. Do not switch production, enable automatic Shadow scheduling, or add
reverse synchronization as part of that audit.
