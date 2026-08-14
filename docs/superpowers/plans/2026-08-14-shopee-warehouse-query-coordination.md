# Shopee Warehouse Query Coordination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent concurrent Shopee Discount previews from failing each other at the warehouse relay's one-query-per-user gate.

**Architecture:** Add instance-local in-flight scan coalescing keyed by canonical scope and serialize only outbound warehouse query requests. Keep verification, validation, timeouts, and Shopee write behavior unchanged.

**Tech Stack:** Node.js ESM, native Promise coordination, `node:test`.

## Global Constraints

- Do not call live Shopee write endpoints.
- Do not cache completed warehouse scans through this coordinator.
- Preserve caller-specific request evidence and all existing fail-closed validation.

---

### Task 1: Coordinate concurrent warehouse scans

**Files:**
- Modify: `tests/shopee-discount-warehouse.test.mjs`
- Modify: `lib/shopee-discount/warehouse-client.mjs`

**Interfaces:**
- Consumes: `WarehouseControlPriceClient.scanPrices({ country, category, skus, watermark, requestId })`.
- Produces: the existing warehouse snapshot contract with caller-specific `evidence.requestId` and `evidence.scope`.

- [ ] **Step 1: Write failing concurrency tests**

Add deferred-fetch tests that call `scanPrices` twice before resolving the relay response. Assert identical canonical scopes produce one fetch; different SKU scopes never have more than one active fetch; and a shared blocked result is followed by a new fetch on retry.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `node --test --test-name-pattern="concurrent identical|different concurrent|failed shared" tests/shopee-discount-warehouse.test.mjs`

Expected: duplicate fetches or overlapping fetches prove coordination is absent.

- [ ] **Step 3: Implement minimal instance-local coordination**

Add an in-flight map keyed by canonical scope, a query queue whose tail is always released in `finally`, and a private uncoordinated scan method used by the public coalescing wrapper. Clone only evidence bindings for each waiter; do not retain settled promises.

- [ ] **Step 4: Run focused and module tests**

Run: `node --test tests/shopee-discount-warehouse.test.mjs tests/shopee-discount-service.test.mjs`

Expected: all tests pass.

- [ ] **Step 5: Verify the live page path**

Restart 3101 with SQLite, start two identical local preview requests concurrently, and assert both return HTTP 200 while relay queries never overlap. Cancel any diagnostic preview drafts afterward.

- [ ] **Step 6: Commit scoped files**

Stage only the client, tests, design, and plan; run `git diff --cached --check`; commit with `fix: coordinate warehouse preview queries`.
