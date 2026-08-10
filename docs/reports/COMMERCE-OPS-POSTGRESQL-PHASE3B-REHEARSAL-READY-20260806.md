# Commerce Ops PostgreSQL Phase 3B Rehearsal Result

Date: 2026-08-06  
Status: **PASS - EXECUTED AFTER EXPLICIT APPROVAL**  
Production provider: `sqlite`  
Rehearsal target: `commerce_ops_migration_test`  
Rehearsal role: `commerce_migrator`  
Production `is_switch_ready`: **false**

## 1. Outcome

After the user explicitly confirmed the exact database name, Phase 3B atomically rebuilt only
`app`, `ai_shadow`, and `shadow_meta` in `commerce_ops_migration_test`. The complete rehearsal passed.
Its default mode remains a read-only plan, and write mode still requires both `--apply` and the exact
database-name confirmation.

Production remains on SQLite. The production PostgreSQL candidate and `commerce_ops_shadow` were
not connected to or modified by the rehearsal.

## 2. Before and after

| Evidence | Before | After |
| --- | ---: | ---: |
| `app` tables | 38 | 112 |
| `app` views | 0 | 15 |
| `ai_shadow` tables | 0 | 5 |
| `shadow_meta` tables | 0 | 6 |
| Versioned Shadow migrations recorded | 0 of 6 | 6 of 6, matching checksums |
| `commerce_app` connection privilege | false | false |
| Migrator database-level `CREATE` | false | false |
| Read-only plan says rebuild required | true | false |

## 3. Executed rehearsal

The guarded runner executed the following after exact confirmation:

1. verify that the production Provider is still SQLite;
2. verify the connected database and role inside the write transaction;
3. acquire a transaction-scoped advisory lock;
4. drop and recreate only `app`, `ai_shadow`, and `shadow_meta` in
   `commerce_ops_migration_test`;
5. apply migrations `001` through `006` and record each SHA-256 in the migration ledger;
6. restore least-privilege schema/table/sequence grants without granting the application role
   database connection access;
7. run the F4 SQLite/PostgreSQL repository-compatibility contract;
8. run all eight Phase 3A domain write boundaries against the test database, with dependency-ordered
   cleanup;
9. verify 105-row stable pagination, `ON CONFLICT` UPSERT, unique rejection, transaction rollback,
   JSONB, timestamptz normalization, cleanup, and measured query latency;
10. run the Daily Report and Agent Runtime in-memory safety suites with delivery and external calls
    disabled.

The reset DDL is one PostgreSQL transaction, so a DDL or migration failure rolls that reset back.
Failures after the reset commits leave only the dedicated test database in its newly versioned,
rebuildable state; production and Shadow remain outside the connection target.

The first approved attempt exposed a missing database-level `CREATE` privilege. The reset
transaction rolled back before changing the schema. The runner now verifies an administrator
connection to the exact test database, grants `CREATE` to the migrator only for the reset, revokes it
in `finally`, and verifies that the final privilege equals its original value. The successful run
reported `before=false`, `temporarilyGranted=true`, `restored=true`, and `after=false`.

The next gate exposed the deliberate Shadow compatibility representation of boolean flags as
constrained integers. F4 now reads target column metadata and encodes those 26 columns as integers
while preserving JavaScript boolean semantics and SQLite/PostgreSQL value/type parity. This does not
change the separate F3 production-target rule that converts checked 0/1 fields to native PostgreSQL
`boolean`.

## 4. Guard and validation evidence

| Gate | Result |
| --- | --- |
| Missing exact apply confirmation | Refused before opening a writable Provider |
| Default Phase 3B command | Read-only plan |
| Final independent plan | Read-only; 112/15/5/6 objects, 6/6 checksums, rebuild not required |
| Phase 3B guard/unit tests | PASS, 5/5 |
| F4 repository compatibility | PASS; 9 modules, CRUD, transaction/error/value/type parity |
| Phase 3A controlled domain writes | PASS, 8/8; cleanup verified |
| Advanced write contract | PASS; 105 rows, page size 20, UPSERT, unique rejection, rollback, JSONB, timestamptz |
| Runtime safety suites | PASS; no delivery or external calls |
| Repository-wide Node tests | PASS, 940/940 |
| Full `npm run build` | PASS |
| Doctor | PASS; only expected already-listening port warnings |
| Production Provider | `sqlite` |
| Production touched by rehearsal/tests | No |
| Shadow touched by rehearsal/tests | No |

The plan command is:

```powershell
npm run postgres:phase3b:plan
```

After explicit approval, the exact destructive test-database command is:

```powershell
npm run postgres:phase3b:rehearse -- --apply --confirm-database=commerce_ops_migration_test
```

## 5. Formal-scale F3 recovery

The legacy F3 runner had been proven only against a 260 MB, 167,307-row snapshot. The current formal
SQLite inventory is 88 tables, 15 views, 3,875,103 rows, and 304 source indexes. The old runner read
all source and target rows into JavaScript arrays and sorted them, so executing it now would carry an
unacceptable memory and runtime risk.

F3 now uses:

- SQLite iterator batches instead of table-wide `.all()` reads;
- bounded multi-row PostgreSQL inserts capped below 60,000 bind parameters;
- PostgreSQL cursors for target validation;
- order-independent, row-count- and duplicate-sensitive `sha256-multiset-v1` streaming digests;
- snapshot-value-aware UUID classification with foreign-key type propagation, preserving real
  namespace/hash/platform identifiers as text;
- explicit conversion of the Price Control singleton expression index;
- dependency-ordered migration and verification of all 15 SQLite views;
- the same exact test-database apply confirmation used by other destructive rehearsal paths.

A fresh complete read-only scan normalized all 3,875,110 rows in 15,547 batches of 250. It covered
all 88 tables, 15 views, 304 source indexes, 306 generated target indexes, 215 snapshot-verified UUID
columns, and 26 checked/name-declared boolean columns. Snapshot integrity was `ok` with zero foreign
key violations. The separately destructive F3 full-data write path has not run; the user's approval
was specifically for the Phase 3B rehearsal.

## 6. Remaining gates

The core Phase 3B migrator-role rehearsal is complete. The application role intentionally cannot
connect to the migration test database, so exact
application-role runtime parity still requires a separately approved staging database with the same
least-privilege contract. This runner does not weaken the F1 role boundary to manufacture a pass.

The previously open hard-delete policy is now implemented but not destructively executed: ordinary
sync remains `BLOCK`; a full reconcile can run exact primary-key `DETECT`; and `APPLY` additionally
requires a dedicated delete environment gate plus exact confirmation of `commerce_ops_shadow`.
Application is child-first and transactional per table. A separately approved Shadow rehearsal must
still prove the new path before the delete/tombstone gate can be marked complete.

Daily Report and Agent Runtime are currently covered by their no-delivery, no-external-call in-memory
safety suites plus migrator-role repository contracts. A future staging run must exercise their
actual PostgreSQL application-role composition. Phase 3C operational readiness, backup/restore,
monitoring, cutover rehearsal, and final human switch approval also remain open.

No current evidence supports setting `is_switch_ready=true`.
