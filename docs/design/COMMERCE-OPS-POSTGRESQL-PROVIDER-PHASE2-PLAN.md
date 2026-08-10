# Commerce Ops PostgreSQL Provider Abstraction Phase 2 Plan

## Objective

Prove that the application domain layer can select SQLite or the existing PostgreSQL Shadow database
for Product, Sales, Inventory, Task, Audit, AI Context, and Agent observability without changing the
formal SQLite production runtime.

## Slice 1: Provider selection

- Add `lib/data/database-provider-factory.mjs`.
- Default to SQLite when `DATABASE_PROVIDER` is absent.
- Accept `sqlite`, `postgres`, and `postgresql` aliases.
- PostgreSQL is allowed only when an explicit Shadow guard is enabled and the target is
  `commerce_ops_shadow`.
- Never infer or silently use a production PostgreSQL database.

## Slice 2: Provider-aware repository SQL

- Add a small helper for schema-qualified tables and numbered placeholders.
- Update `SalesAssortmentRepository` for Sales and Inventory reads.
- Update `FoundationRepository` for task/account/master-data operations.
- Update `AgentObservabilityRepository` for audit/monitoring reads.
- Preserve the already provider-aware `ProductCatalogRepository` and `AiContextRepository` behavior.
- Add an async provider audit repository with the current audit row contract.

## Slice 3: Stable domain bundle

Expose the same domain-level entry points regardless of provider:

- `products.getProducts(...)`
- `sales.getSalesSummary(...)`
- `inventory.getInventorySnapshot(...)`
- `tasks.listTasks(...)`
- `audit.listEvents(...)`

The bundle must not expose driver connections to business callers.

## Slice 4: Dual-database parity

Use a read-only snapshot of the formal SQLite database and the existing Shadow PostgreSQL database.
Compare:

- Product count, IDs, and representative core fields.
- Sales latest day, selected rows, and aggregate quantities.
- Inventory current/previous batch rows and aggregate quantities.
- Task count, IDs, states, and priorities.
- Audit count, IDs, actions, statuses, and monitoring summaries.

Do not insert fixtures into the formal SQLite database. Any write-contract verification uses isolated
test databases and cleans up its fixtures.

## Slice 5: Startup and Agent probes

SQLite mode:

- provider factory selects SQLite;
- current full test/build/doctor behavior remains unchanged.

PostgreSQL Shadow mode:

- factory selects PostgreSQL with `app` schema;
- Product/Sales/Inventory/Task/Audit repositories initialize;
- Context Registry reads structured context;
- Agent Runtime loads the existing daily-report definition in a controlled, non-delivery probe;
- Agent monitoring queries execute;
- Vue production artifacts are present and build remains green.

The probe must not send DingTalk messages, call DeepSeek, write operation tasks, or mutate either
database.

## Explicitly deferred boundaries

- Scheduler mutation/runtime repository async migration.
- File/export/lifecycle repository async migration.
- Price Control SQL portability.
- Fulfillment service PostgreSQL provider.
- Production configuration switch.
- MinIO and file-asset migration.

## Completion gates

- Factory tests pass and fail closed for unsafe PostgreSQL targets.
- The five requested domain repositories return equivalent normalized results.
- PostgreSQL Shadow startup probe passes without writes.
- SQLite full tests, Vue build, and Doctor remain green.
- Documentation reports unsupported boundaries without claiming full production cutover.
