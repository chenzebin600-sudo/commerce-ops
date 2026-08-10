# Commerce Ops PostgreSQL Production Readiness Phase 3A

Date: 2026-08-06  
Status: **PHASE 3A COMPLETE - PRODUCTION CUTOVER NOT APPROVED**  
Production provider: `sqlite`  
Formal SQLite migration: `026_price_control_adjustment_workflow.sql`  
PostgreSQL validation target: `commerce_ops_shadow.app`  
Shadow migration: `006_price_control_provider.sql`  
Production `is_switch_ready`: **false**

## 1. Outcome

Phase 3A is complete as a provider-neutral write-boundary implementation and validation phase. The
main application, scheduler, files, Audit, Foundation Tasks, Price Control, and Fulfillment now have
provider-backed write paths, and the selected boundaries passed controlled PostgreSQL
write/read/cleanup checks.

This result does not authorize a production provider switch. Formal SQLite remains the only
production source of truth, and the existing services continue to run with `DATABASE_PROVIDER=sqlite`.

## 2. Recovered starting point

The recovered candidate already contained:

- provider-aware runtime composition for the main server and scheduler;
- async Scheduler, Task, Audit, file metadata, lifecycle, and review repositories;
- a bounded Fulfillment provider repository and factory;
- Price Control provider adaptation;
- Local Storage Provider wiring;
- Shadow migration 005 for the Fulfillment schema;
- focused SQLite/PostgreSQL tests and an initial controlled Shadow write check.

The open gates were a clean-path timeout, a repository-wide green run, final Build and Doctor,
readiness evidence, and a fresh `is_switch_ready` decision.

## 3. Gaps found and completed

1. The clean-path copy filter treated `lib/storage/` as runtime `storage/`, omitted the Storage
   Provider source, and then waited for an already-exited child process. The filter is now
   root-aware, process cleanup is race-safe, and the smoke test completes in about two seconds.
2. `.gitignore` also treated `lib/storage/` as runtime data. The runtime rule is now anchored to the
   repository-root `/storage/`, so all three Storage Provider modules are visible to Git.
3. The E2 PostgreSQL-driver isolation check recognized only ESM imports. It now also recognizes the
   intentionally lazy `require("pg")` used to keep SQLite-only clean-path startup independent of the
   PostgreSQL package.
4. Provider parity defaulted to the Phase 1 snapshot after incremental synchronization had advanced
   Shadow. A resolver now selects the newest existing snapshot from a successful incremental-sync
   report, while retaining the explicit environment override and Phase 1 fallback.
5. PostgreSQL JSONB metadata returned as an object was discarded by export-file serialization. The
   shared serializer now accepts both PostgreSQL objects and SQLite JSON strings.
6. Scheduler and lifecycle flags were emitted as PostgreSQL booleans although the versioned Shadow
   compatibility schema stores these fields as constrained integers. Provider writes now preserve
   the schema contract in both dialects.
7. Shadow lacked the Price Control validity and operator-adjustment columns introduced by formal
   SQLite migrations 025 and 026. Versioned Shadow migration 006 adds the equivalent columns and
   indexes and is applied with checksum
   `560325698fbfe88023a10c1246431845291e86c4be859d735ee7edc1d96a5859`.
8. The prior write check covered only a Scheduler lease, Audit, Foundation Task, and one Fulfillment
   row. It now exercises eight boundaries: Scheduler task/run/event, Scheduler lease, export-file
   metadata, file lifecycle/review metadata, Audit, Foundation Task/event, Price Control
   change/adjustment, and Fulfillment Agent Run. All generated rows are removed and independently
   verified absent at the end.
9. The full Build path was blocked because dated migration/recovery memory intentionally contains
   historical absolute paths. The centralized path-policy registry now has one narrowly scoped
   `memory/daily/` evidence exception; product and runtime source paths remain checked.

## 4. Verification evidence

| Gate | Result |
| --- | --- |
| Repository-wide Node tests | PASS, 921/921 |
| Phase 3A focused provider tests | PASS |
| Clean neutral-directory startup | PASS, about 1.8 seconds |
| Full `npm run build` | PASS: portable paths, frontend policy, Vue type checks/build, built-asset checks |
| Doctor | PASS; formal SQLite integrity `ok`; only expected already-listening port warnings |
| Formal SQLite state | Read-only verification: migration 026 remains latest |
| Shadow migration plan | PASS; migrations 001-006 already applied with matching checksums |
| Controlled PostgreSQL write contract | PASS, 8/8 boundaries, cleanup verified |
| External calls during write contract | 0 |
| Real fulfillment actions | 0 |
| Price execution actions | 0 |
| SQLite/PostgreSQL startup probes | PASS for both providers, read-only, zero writes and zero external calls |
| Six-domain provider parity | PASS against pinned incremental snapshot |

Six-domain parity evidence:

| Domain | Evidence |
| --- | ---: |
| Product | 18,347 identities |
| Sales | 66,635 valid orders; 80,140 header keys; 116,293 line keys |
| Inventory | 20,155 current rows |
| Foundation Task | 376 tasks |
| Audit | 42,197 events |
| Agent | 3 runs; 15 Tool calls in startup/monitoring projection |

## 5. Safety result

- Formal SQLite was not migrated, rewritten, frozen, or replaced during Phase 3A completion.
- No production service configuration was changed to PostgreSQL.
- No scheduler, DingTalk, MySQL Price Control, AI provider, Mabang, or fulfillment external action
  was called by the controlled PostgreSQL write contract.
- Shadow test rows used unique Phase 3A identifiers and were deleted in dependency order; final
  cleanup assertions returned zero rows for every checked boundary.
- Local file bytes were not moved to object storage. `LocalStorageProvider` remains the active file
  boundary; MinIO remains design-only.

## 6. Readiness decision

Phase 3A implementation readiness is **true**. Production cutover readiness remains **false**.

The remaining gates belong to later approved phases:

1. define and test DELETE/tombstone behavior for all synchronized domains;
2. run Phase 3B against a separate writable PostgreSQL rehearsal database with realistic multi-step
   transactions, rollback, idempotency, JSON, timestamp, pagination, UPSERT, and performance cases;
3. expand or explicitly defer the migration/data-sync scope for Price Control, Fulfillment, file
   metadata, Scheduler, and every other table needed by the production composition;
4. refresh Shadow from a new pinned formal SQLite snapshot and repeat full validation, because the
   current six-domain parity is intentionally tied to the successful 2026-08-06 10:20 snapshot;
5. provision production roles, secrets, monitoring, HA, backup/PITR, and execute a verified restore;
6. rehearse freeze, final sync, switch, smoke tests, and rollback as one timed runbook;
7. obtain a separate explicit human approval before changing `DATABASE_PROVIDER`, freezing formal
   SQLite, or enabling production PostgreSQL writes.

No current evidence supports setting `is_switch_ready=true`.
