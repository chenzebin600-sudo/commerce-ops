# Task 5A report: close SQLite transaction ownership escapes

## Status

Implemented the fresh shared-SQLite infrastructure fix. The synchronous transaction manager now exposes only `run(callback)`, the native `DatabaseSync` instance and native statements are private, and every synchronous or asynchronous terminal operation verifies the exact connection owner before it can finish or clear transaction state.

No external database, Shopee, warehouse, credential, network, or production write was used. All verification used repository fixtures and temporary local SQLite databases.

## Delivered behavior

- `TransactionManager` stores begin/commit/rollback callbacks in JavaScript private fields. Its public interface is only `run(callback)`; the private callbacks receive the opaque synchronous transaction token returned by begin.
- `SqliteProvider` stores the real connection, provider capability, guarded facade, ownership flag, transaction manager, and transaction state in JavaScript private fields. `_connection`, symbols, the compatibility facade, transaction manager, and returned statement executors do not expose the native connection or its unforgeable capability.
- The compatibility `connection` facade is frozen and exposes only `prepare` and guarded `exec`. Prepared statements are frozen executor facades exposing only `get`, `all`, `iterate`, and guarded `run`; native session, changeset, close, extension, function-registration, backup/configuration, statement configuration, and unknown methods are not forwarded.
- Synchronous transactions reserve a unique connection-scoped token bound to the provider capability before `BEGIN IMMEDIATE`. Begin, commit, and rollback validate that token, reject active/queued async ownership, and clear state only after successful terminal cleanup by the same token. A failed commit retains ownership long enough for the private rollback path.
- Async transactions validate the exact active token, its matching async-local context, and the provider capability immediately before `BEGIN IMMEDIATE`, `COMMIT`, and `ROLLBACK`. A second provider invoked inside the owner's callback cannot inherit ambient transaction authority. Final cleanup clears only the same active token after a successful commit/rollback.
- A connection-scoped SQLite authorizer denies public transaction/savepoint control while a managed transaction is active. Only a short-lived private terminal token can authorize the provider's exact `BEGIN`, `COMMIT`, or `ROLLBACK`, so even the owner facade cannot finish its managed transaction early.
- Public preparation of transaction/savepoint control is rejected unconditionally by a scoped SQLite authorizer flag, preventing statements compiled while idle—including comment-prefixed SQL—from being cached and invoked after a managed transaction starts.
- Async provider mutation executors reject while a synchronous token is active, so a promise started inside `transactionManager.run()` cannot resume after the manager rolls back and escape as an out-of-transaction write.
- Failed rollback cleanup poisons the shared connection with `SQLITE_TRANSACTION_POISONED`; ownership is retained and subsequent reads/writes/transactions fail closed instead of admitting work into an uncertain native transaction.
- Shared providers continue to serialize async transactions through one connection-scoped queue. Live nesting rejects with `SQLITE_TRANSACTION_REENTRANT`; a synchronous `run()` rejects active or queued async work with `SQLITE_TRANSACTION_BUSY`; detached post-commit context may start a new transaction.
- Cached prepared mutations and cached `exec` validate ownership at invocation time. Prepared `run` is always guarded. `get`, `all`, and `iterate` are unguarded only for `SELECT`, `EXPLAIN`, or an explicit read-only PRAGMA allow-list.
- Assignment PRAGMAs, argument forms not explicitly known to be introspection, action PRAGMAs such as `optimize`, and every `exec` invocation are guarded and fail foreign active/queued access with `SQLITE_RAW_WRITE_BLOCKED`.
- During a paused Foundation approval, all public transaction-manager terminal capabilities are absent, synchronous `run()` is busy, foreign raw/audit/issue writes are rejected, and the approval state plus exact event remain one atomic commit.
- The existing injected event-insert failure regression still proves approval rollback to `PREVIEWED`, no retained `APPROVED` event, and a concurrent retry that succeeds exactly once.

## TDD evidence

The public seams were pre-agreed by the Task 5A brief: `TransactionManager.run()`, `SqliteProvider.connection`, provider async transactions, and the existing repository/service behavior.

Observed RED before each production slice:

1. `transaction manager exposes only the run capability` failed because `transactionManager.begin` was an exposed function instead of `undefined`. After moving all terminal callbacks to private fields, the focused test passed.
2. `SQLite provider hides the native connection behind a minimal compatibility facade` failed because `provider._connection` returned the real `DatabaseSync`. After private-field ownership and the explicit frozen facade, the focused test passed.
3. `cached SQLite writes and mutating PRAGMAs cannot enter queued or active async transactions` failed with `Missing expected exception` because assignment PRAGMA reads were classified as read-only. The focused test passed after explicit PRAGMA classification.
4. The same regression was extended with `PRAGMA optimize` and again failed with `Missing expected exception` because no-argument PRAGMAs were assumed read-only. It passed after switching to an explicit read-only PRAGMA allow-list.

The independent pre-commit review then found two missing adversarial cases: a second provider called from inside the owner's async context could inherit ambient authority, and public transaction-control SQL could finish a managed synchronous transaction. The implementation was held, provider-bound capability checks plus SQLite authorizer gating were added, and new inside-callback regressions now prove both paths reject while owner writes commit normally. The same review identified fail-open rollback-state cleanup; rollback failure now poisons the connection rather than clearing ownership.

Follow-up review found two timing variants. The cached-terminal and sync-to-async escape regressions were written and both observed failing: idle `prepare("COMMIT")` returned a statement, and `provider.execute()` begun inside synchronous `run()` later resolved instead of rejecting. Unconditional public transaction-control preparation rejection and synchronous-token checks in async mutation access made both focused tests pass, with the synchronous owner write rolled back and zero escaped rows.

Final adversarial review tried comment-prefixed transaction control. That extension failed because the lexical pre-check did not see `/* cached */ COMMIT`; the scoped SQLite authorizer now denies public preparation by transaction/savepoint opcode, independent of comments, and all comment-prefixed COMMIT/ROLLBACK/SAVEPOINT/RELEASE cases pass.

Existing pre-fix behaviors that already had protection were retained and expanded as permanent regressions: active/queued synchronous busy rejection, shared-provider serialization, event-write rollback/retry, live nested rejection, and detached post-commit success.

## Fresh verification

Syntax and focused infrastructure/Foundation verification:

```powershell
node --check lib/data/transaction-manager.mjs
node --check lib/data/sqlite/sqlite-provider.mjs
node --check tests/data-access-boundary.test.mjs
node --check tests/operation-plan.test.mjs
node --disable-warning=ExperimentalWarning --test tests/data-access-boundary.test.mjs tests/operation-plan.test.mjs
```

Result: syntax checks exited 0; 28 tests passed, 0 failed.

Required core boundary, Foundation, audit, repository, service, and API verification:

```powershell
node --disable-warning=ExperimentalWarning --test tests/data-access-boundary.test.mjs tests/operation-plan.test.mjs tests/audit-service.test.mjs tests/shopee-discount-repository.test.mjs tests/shopee-discount-service.test.mjs tests/shopee-discount-api.test.mjs
```

Result: 74 tests passed, 0 failed.

Synchronous file, Shopee Health, provider, export-file, scheduled-task, and scheduler compatibility:

```powershell
node --disable-warning=ExperimentalWarning --test tests/file-review-and-quarantine.test.mjs tests/file-lifecycle-service.test.mjs tests/shopee-health.test.mjs tests/database-provider-compatibility.test.mjs tests/export-file-persistence.test.mjs tests/scheduled-task-soft-delete.test.mjs tests/scheduler-integration.test.mjs
```

Result: 102 tests passed, 0 failed.

Complete Shopee Discount verification:

```powershell
node --disable-warning=ExperimentalWarning --test tests/shopee-discount-*.test.mjs
```

Result: 115 tests passed, 0 failed.

## Compatibility notes and concerns

- Repository call-site inspection found no synchronous consumer of public begin/commit/rollback; current SQLite repositories use only `transactionManager.run()`.
- Current raw connection call sites require only `prepare` and `exec`, and current prepared-statement call sites require only `get`, `all`, `iterate`, and `run`. Native statement configuration methods are intentionally no longer reachable.
- Raw prepared reads remain synchronous by the existing compatibility policy and can observe an owner's uncommitted data on the shared connection. This task prevents mutation/terminal escapes; it does not change that documented read visibility.
- PRAGMA handling is intentionally conservative. A new read-only introspection PRAGMA not present in the allow-list is treated as mutation during foreign active/queued work until explicitly reviewed and added.
- Provider-owned `close()` remains the lifecycle method used by data-access shutdown; a provider wrapping another provider's facade does not own or close that connection, and the native facade itself exposes no `close` capability.
- All unrelated dirty workspace files were preserved and excluded from the scoped commit.

## Review round 1: native ownership, read contracts, poison and lifecycle

All five findings from `task-5a-review.md` were addressed through the existing provider/facade/lifecycle seams:

- The public constructor no longer accepts arbitrary `DatabaseSync` or lookalike `prepare`/`exec` objects. A provider creates and owns the native handle from `databasePath`; sharing accepts only a facade minted and registered by another `SqliteProvider`. `resolveSqliteProvider()` applies the same rule. This removes retained-native terminal escapes and leaves one provider-owned authorizer lifecycle per native connection.
- `query()` is strictly read-only. It rejects non-read lexical forms before its first await and prepares accepted SELECT/EXPLAIN/read-PRAGMA SQL under a SQLite authorizer mode that denies DML, DDL, transaction/savepoint operations, attachment, reindex/analyze, and mutating PRAGMAs. INSERT/UPDATE/DELETE `RETURNING` and assignment PRAGMAs therefore cannot resume after synchronous rollback.
- Connection health is checked when acquiring the facade/transaction manager, preparing facade statements, invoking cached statement reads/writes, using raw `exec`, calling `hasColumn`, and entering provider query/write/transaction paths. An `INSERT OR ROLLBACK` conflict forces native rollback cleanup failure; the shared state becomes `SQLITE_TRANSACTION_POISONED`, and every tested public database surface fails closed. Poison clears managed ownership tokens because health becomes the stronger permanent gate, allowing the owner to close the unusable native handle.
- Owner `close()` is idempotent and rejects synchronous, active async, or queued async work with `SQLITE_TRANSACTION_BUSY`. After a successful close, database surfaces fail consistently with `SQLITE_CONNECTION_CLOSED`. Closing a non-owner wrapper remains a no-op and cannot affect the owner or shared authorizer.
- Shared facade construction reuses the connection-scoped state and authorizer; it does not install or overwrite an authorizer. Only the provider that created the native handle can close it, and only while idle.

Round-one RED evidence was observed before implementation:

1. Raw `DatabaseSync` construction and raw `resolveSqliteProvider()` calls succeeded instead of throwing.
2. The sync-rollback regression reported a missing rejection because mutation-shaped `query()` promises executed afterward.
3. The poison regression first failed at `provider.connection`, which remained readable after rollback cleanup failure.
4. The owner-close regression closed active work and later failed with `database is not open`; repeated close also raised that native error.

The independent round-one review found remaining resolver disguises: a forged object with `dialect: "sqlite"` and a retained native connection passed the old duck-typed early return, an `instanceof` replacement could itself be forged through the prototype chain or an overriding subclass, and a genuine instance's inherited getter could be shadowed after registration. Focused regressions observed the missing exceptions. Resolution now accepts only exact `SqliteProvider` instances registered after successful construction, exact registered nested providers, or registered provider-owned facades. Construction installs the guarded connection as a non-configurable own accessor. Top-level, nested, prototype-forged, overriding-subclass, and post-construction shadowing shapes are rejected.

Fresh round-one verification:

```powershell
node --check lib/data/sqlite/sqlite-provider.mjs
node --disable-warning=ExperimentalWarning --test tests/data-access-boundary.test.mjs tests/operation-plan.test.mjs
```

Result: syntax passed; 33 tests passed, 0 failed.

```powershell
node --disable-warning=ExperimentalWarning --test tests/data-access-boundary.test.mjs tests/operation-plan.test.mjs tests/audit-service.test.mjs tests/shopee-discount-repository.test.mjs tests/shopee-discount-service.test.mjs tests/shopee-discount-api.test.mjs
```

Result: 79 tests passed, 0 failed.

```powershell
node --disable-warning=ExperimentalWarning --test tests/file-review-and-quarantine.test.mjs tests/file-lifecycle-service.test.mjs tests/shopee-health.test.mjs tests/database-provider-compatibility.test.mjs tests/export-file-persistence.test.mjs tests/scheduled-task-soft-delete.test.mjs tests/scheduler-integration.test.mjs
```

Result: 102 tests passed, 0 failed.

```powershell
node --disable-warning=ExperimentalWarning --test tests/shopee-discount-*.test.mjs
```

Result: 115 tests passed, 0 failed.

After the final non-configurable-accessor hardening, the focused infrastructure/Foundation suite was rerun: 33 tests passed, 0 failed. The broader compatibility and Discount suites above had already passed after the resolver registry change and were not redundantly repeated for the accessor-only follow-up.

Round-one compatibility concern: callers that retained and passed an arbitrary native `DatabaseSync` into repositories are intentionally no longer supported. Current production construction uses `databasePath` or an existing provider, and current shared-provider tests use the registered compatibility facade.

## Review round 2: asynchronous operation reservations

The two round-one re-review findings are fixed with a connection-scoped `inFlight` reservation:

- `query()`, `execute()`, and `executeScript()` reserve the shared connection synchronously before their first await and release exactly once in `finally`. This covers success, access rejection, poison, and native failures.
- Each executor rechecks shared health immediately after transaction-access awaits and immediately before its native statement invocation. A rollback-cleanup poison transition therefore makes already-started calls reject with the stable `SQLITE_TRANSACTION_POISONED` error without touching the native handle.
- Owner `close()` treats any `inFlight` reservation as `SQLITE_TRANSACTION_BUSY`. It cannot overtake an already-started query, statement, or script and expose Node's native `ERR_INVALID_STATE`.
- Managed transactions retain their existing active/pending ownership reservation. Calls through the owner transaction executor reserve only the individual native operation, so transaction queueing is unchanged and no second queue wait is introduced.

Strict RED evidence was observed first. The close interleaving allowed close to win and all three started operations reached a closed native handle. The poison interleaving allowed already-started mutations to resume after rollback cleanup failure. After the reservation change, the exact focused interleavings and all prior boundary/Foundation cases pass.

Fresh round-two focused verification:

```powershell
node --check lib/data/sqlite/sqlite-provider.mjs
node --disable-warning=ExperimentalWarning --test tests/data-access-boundary.test.mjs tests/operation-plan.test.mjs
```

Result: syntax passed; 35 tests passed, 0 failed.

Fresh round-two broader verification:

- Core boundary, Foundation, audit, repository, service, and API: 81 tests passed, 0 failed.
- File lifecycle, Shopee Health, provider, export, scheduled-task, and scheduler compatibility: 102 tests passed, 0 failed.
- Complete Shopee Discount suite: 115 tests passed, 0 failed.

The independent round-two review reported no remaining Critical or Important findings and marked the reservation slice ready.
