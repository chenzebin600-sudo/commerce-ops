# Shopee Discount Warehouse Relay Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect Shopee Discount price matching to the deployed internal `控价` data relay without exposing the warehouse key or enabling Shopee writes.

**Architecture:** Keep `WarehouseControlPriceClient` as the domain boundary and replace its fictional HTTP contract with the documented relay contract. The client validates through `/api/data/me`, reads paginated `/api/data/query` responses, normalizes top-level Chinese metadata into the existing warehouse snapshot contract, and permits plaintext HTTP only for the exact internal relay origin.

**Tech Stack:** Node.js 24 ESM, built-in `fetch`, `node:test`, existing Shopee Discount service and Vue API.

## Global Constraints

- Fixed internal origin: `http://10.110.80.95:8788`; arbitrary HTTP origins remain forbidden.
- Authentication uses `X-Data-Key`; the key never appears in returned data, errors, logs, or committed configuration.
- Verification is read-only `GET /api/data/me`; price reads are `POST /api/data/query` with product `控价`.
- Pagination is serial and bounded; only top-level `源最新` is the warehouse watermark.
- No Shopee write, approval, or execution policy changes.

---

### Task 1: Implement the deployed relay contract

**Files:**
- Modify: `lib/shopee-discount/warehouse-client.mjs`
- Modify: `tests/shopee-discount-warehouse.test.mjs`

**Interfaces:**
- Consumes: `new WarehouseControlPriceClient({ fetchImpl, baseUrl, getKey, ... })`
- Produces: `verifyKey({ requestId }) -> { status: "READY", evidence }` and `scanPrices({ country, category, skus, watermark, requestId }) -> WarehouseSnapshot`

- [x] **Step 1: Write failing contract tests**

Add tests asserting `GET /api/data/me`, `POST /api/data/query`, `X-Data-Key`, Chinese request body, exact internal HTTP allowlist, `源最新` watermark injection, cursor pagination, bounded 429 retry, and secret redaction.

- [x] **Step 2: Run RED**

Run: `node --disable-warning=ExperimentalWarning --test tests/shopee-discount-warehouse.test.mjs`

Expected: existing client still calls `/control-prices/*`, uses `x-api-key`, and rejects the internal HTTP origin.

- [x] **Step 3: Implement the minimal adapter**

Use the exact request shapes:

```js
await fetch(`${baseUrl}/api/data/me`, { method: "GET", headers: { "X-Data-Key": key, "x-request-id": requestId } });
await fetch(`${baseUrl}/api/data/query`, {
  method: "POST",
  headers: { "X-Data-Key": key, "x-request-id": requestId, "content-type": "application/json" },
  body: JSON.stringify({ 产品: "控价", 参数: { 平台: "SHOPEE", 国家: country, 大品类: category, ...(singleSku ? { SKU: singleSku } : {}) }, 页大小: pageSize, ...(cursor ? { 游标: cursor } : {}) }),
});
```

Normalize `rows`, `游标`, `还有更多`, `源最新`; inject `源最新` as every normalized row watermark. Cache a multi-SKU country/category snapshot only within the current request ID and filter exact requested SKUs.

- [x] **Step 4: Run GREEN**

Run: `node --disable-warning=ExperimentalWarning --test tests/shopee-discount-warehouse.test.mjs`

Expected: all warehouse contract and validator tests pass.

### Task 2: Wire and configure the production server

**Files:**
- Modify: `server.mjs`
- Modify: `.env`
- Test: `tests/shopee-discount-integration.test.mjs`

**Interfaces:**
- Consumes: `SHOPEE_DISCOUNT_WAREHOUSE_BASE_URL`
- Produces: a configured `WarehouseControlPriceClient` at the exact relay origin; otherwise the existing explicit unconfigured client

- [x] **Step 1: Write failing startup tests**

Assert the exact private HTTP origin is accepted and a different HTTP origin remains disabled. Assert HTTPS configuration remains supported.

- [x] **Step 2: Run RED**

Run: `node --disable-warning=ExperimentalWarning --test tests/shopee-discount-integration.test.mjs`

Expected: the existing startup resolver rejects the documented internal HTTP origin.

- [x] **Step 3: Implement configuration wiring**

Use one shared origin validator for scheduler startup and `WarehouseControlPriceClient`. Add only this non-secret line to local `.env`:

```dotenv
SHOPEE_DISCOUNT_WAREHOUSE_BASE_URL=http://10.110.80.95:8788
```

- [x] **Step 4: Run GREEN and related regressions**

Run: `node --disable-warning=ExperimentalWarning --test tests/shopee-discount-integration.test.mjs tests/shopee-discount-service.test.mjs tests/shopee-discount-api.test.mjs`

Expected: all pass with no network access.

### Task 3: Restart and verify the read-only live path

**Files:**
- Verify only; no source changes unless a regression is found

**Interfaces:**
- Consumes: user-saved encrypted `zndr_...` key through the existing settings UI
- Produces: a verified settings state and a bounded read-only control-price response

- [x] **Step 1: Run static and focused verification**

Run `node --check server.mjs`, `git diff --check`, and the Shopee Discount warehouse/service/API/integration tests.

- [x] **Step 2: Restart only the process listening on 3101**

Resolve the exact PID, stop it, wait for the existing supervisor to restart it, and confirm `/api/shopee-discount/status` returns HTTP 200.

- [x] **Step 3: Verify behavior without a stored key**

Call `POST /api/shopee-discount/settings/verify`; expect a safe 4xx warehouse-key error, never a generic 500 and never a Shopee write.

- [ ] **Step 4: Verify with the user-saved key when available (waiting for the operator to save the secret in the UI)**

After the user saves the key in the UI, call the application verification route and one smallest authorized `控价` query. Report only status, row count, country/category, and watermark; redact request headers and row values.

- [x] **Step 5: Commit scoped source and tests**

Stage only the adapter, server wiring, tests, and plan. Exclude unrelated dirty files and generated frontend assets.
