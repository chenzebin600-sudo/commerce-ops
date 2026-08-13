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
