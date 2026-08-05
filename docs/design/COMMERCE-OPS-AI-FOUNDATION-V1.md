# Commerce Ops AI Foundation V1

Status: implementation baseline
Scope: shared AI infrastructure only; no business Agent is implemented here.

## 1. Current Architecture Audit

### Data model

- Canonical product and SKU data live in `product_models`, `product_skus`, and
  the `foundation_product_master_v` / `foundation_sku_master_v` views.
- Canonical stores live in `growth_shops` and `foundation_store_master_v`.
- Warehouses and owners are normalized by Foundation V1.
- Orders and inventory are structured facts in `growth_order_headers`,
  `growth_order_lines`, and `growth_inventory_snapshots`.
- Deterministic analysis output is stored in the Growth Radar V2 metric,
  signal, and focus-item tables introduced by migrations 019 through 021.
- Listing state is stored in `product_listing_drafts` and
  `product_listing_publish_records`.

The formal database is currently on migration 022. It contains canonical
products, SKUs, and stores, but no published Growth Radar V2 analysis run.
AI Context therefore needs a deterministic fallback from published analysis
views to structured facts. Reading source Excel files is not permitted.

### Repository structure

`lib/data/data-access.mjs` is the composition root for provider-backed
repositories. Domain repositories own SQL and services own normalization and
business contracts. The AI Context Layer will follow the same boundary.

### Task system

Foundation V1 already provides the shared task envelope:

- `foundation_tasks`
- `foundation_task_events`
- `foundation_task_leases`
- `FoundationTaskService`

Agent work must use this envelope. A second Agent-specific queue or lifecycle
is prohibited. Agent definitions map to an existing Foundation domain and use
`agent_request` as the domain reference type.

### Audit system

`operation_audit_events` and `createOperationAuditService` are the canonical
audit path. AI request telemetry must be written as sanitized audit metadata;
prompts, model output, credentials, customer PII, and secrets must not be
stored in request logs.

### AI entry points

All current DeepSeek calls already pass through `AiGateway`, but Gateway
construction and logging are repeated in the server and scheduler. The current
Gateway supports provider isolation, timeout, retry, safe errors, and a logger
callback. It does not yet provide a complete prompt-version contract,
normalized token metrics, or output-schema validation.

## 2. Target Components

### AI Context Layer

Versioned read-only contexts:

- `shop`: profile, platform/country/owner, sales trend, inventory status,
  risks, and open tasks.
- `product`: product profile, SKUs, sales, inventory, risks, Listing state,
  and open tasks.
- `sku`: SKU profile, sales trend, warehouse supply, standard-price history,
  Listing state, risks, and open tasks.

Every response includes context version, generation time, source freshness,
quality/limitations, and the evidence source (`published_analysis` or
`structured_facts`).

### AI Gateway

The shared Gateway owns:

- provider invocation and request policy;
- prompt identifier and version metadata;
- normalized input/output/total token usage;
- sanitized request telemetry through the audit service;
- optional output validation with the stable `AI_OUTPUT_INVALID` error code.

Existing callers remain compatible and are reported as legacy unversioned
prompts until migrated. Agent execution must require a versioned prompt.

### Agent framework

An Agent definition contains:

- `name`
- `description`
- `input_context`
- `tools`
- `output_schema`
- `permission`

Definitions are validated and registered, but no Daily Report, Shop,
Inventory, or other business Agent is created in this phase. Agent task
requests are wrapped by Foundation tasks and remain pending until a later
approved execution runtime is introduced. The detailed contract is recorded in
`docs/design/COMMERCE-OPS-AGENT-FRAMEWORK-V1.md`.

## 3. API Boundary

Read-only diagnostic endpoints:

- `GET /api/ai/context/shop/:id`
- `GET /api/ai/context/product/:id`
- `GET /api/ai/context/sku/:id`

They inherit the main API authentication and audit boundary. No context API
performs a database write or model call.

## 4. Database Decision

No migration is required for AI Foundation V1:

- contexts are projections over existing structured tables;
- request telemetry reuses the canonical audit store;
- Agent task envelopes reuse Foundation V1.

This avoids changing the formal database and prevents duplicate task and log
models. A future migration is justified only if full prompt bodies, model
artifacts, or cost-ledger retention becomes an explicitly approved product
requirement.

## 5. Incremental Delivery

1. Implement and test the AI Context repository, service, and read-only API.
2. Extend AI Gateway contracts and centralize sanitized audit logging.
3. Add Agent definition, registry, and Foundation task bridge.
4. Run focused tests, full tests, Build, and Doctor; verify no formal database
   changes and document the integration contract.

Each component is committed independently so it can be reviewed or reverted
without disturbing Product Center, Sales and Assortment, Growth Radar, Mabang,
fulfillment, Listing, or audit behavior.
