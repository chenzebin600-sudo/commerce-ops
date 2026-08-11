# Fulfillment Preview Safety Hardening Implementation Plan

> **Execution:** implement locally with test-driven development; do not perform live Mabang writes.

**Goal:** eliminate false SKU candidates, bind whole-order warehouse changes to each line's exact Mabang option, fully revalidate before irreversible writes, and recover long-running previews across transient disconnects and page refreshes.

**Architecture:** harden the existing parser and pure routing seams, version persisted previews/plans at the service boundary, add exact line-level warehouse bindings to route plans, and introduce a persisted preview-task coordinator used by both batch preview APIs and the Vue page.

---

## Task 1: Fail-closed inventory names and SKU matching

**Files:**
- Modify: `scripts/mabang_inventory_source.py`
- Modify: `fulfillment-service/sku-replacement.mjs`
- Test: `tests/test_mabang_inventory_columns.py`
- Test: `tests/sku-replacement.test.mjs`

1. Add failing fixture tests proving sales status cannot become `中文名称` and that parser output carries name source/confidence.
2. Add failing matcher tests proving missing/ambiguous names and unspecified specifications are excluded rather than labeled `SAME`.
3. Parse the explicit product-name cell/field and keep sales state separate; emit `名称来源` and `名称置信度`.
4. Require verified name provenance and positive product/spec evidence in automatic candidate discovery.
5. Run the focused Python and Node tests.

## Task 2: Invalidate unsafe persisted previews and plans

**Files:**
- Modify: `fulfillment-service/sku-replacement.mjs`
- Modify: `fulfillment-service/sku-replacement-batch.mjs`
- Test: `tests/sku-replacement.test.mjs`

1. Add failing tests for old batch preview, selection, and plan execution.
2. Add a schema/version constant to new preview, batch, and plan records and include it in hashes.
3. Reject missing/old versions with `PREVIEW_SCHEMA_OBSOLETE` before any write.
4. Preserve old files for audit; do not migrate them into executable records.
5. Run focused tests.

## Task 3: Exact per-line warehouse bindings

**Files:**
- Modify: `fulfillment-service/sku-warehouse-routing.mjs`
- Modify: `fulfillment-service/warehouse-transfer.mjs`
- Modify: `scripts/mabang_order_source.py`
- Modify: `scripts/mabang_worker.py`
- Test: `tests/sku-warehouse-routing.test.mjs`
- Test: `tests/warehouse-transfer.test.mjs`
- Test: `tests/test_mabang_fulfillment_safety.py`

1. Add failing tests where two items share one canonical warehouse but expose different option values/text.
2. Make routes return `itemBindings` for every active prospective item.
3. Persist/hash bindings in plans and re-inspect them before execution.
4. Send line-level bindings through the worker boundary; select exact value first, text second.
5. Reject changed/missing bindings before warehouse write.
6. Run routing, transfer, and Python safety tests.

## Task 4: Full pre-write recomputation and same-order consistency

**Files:**
- Modify: `fulfillment-service/sku-replacement.mjs`
- Modify: `fulfillment-service/sku-replacement-batch.mjs`
- Test: `tests/sku-replacement.test.mjs`

1. Add failing tests proving execution re-reads the full order, explicit allowlist, all target inventory, and candidate evidence before the SKU write.
2. Recompute the complete prospective route and compare it with the hashed plan; return `PLAN_STALE` on any mismatch.
3. Group selections by order and prevent later line writes from using the order's initial stale snapshot.
4. Preserve existing no-retry/no-rollback/manual-review behavior after confirmed writes.
5. Run focused tests.

## Task 5: Durable background preview tasks

**Files:**
- Create: `fulfillment-service/preview-task-store.mjs`
- Modify: `fulfillment-service/server.mjs`
- Modify: `lib/fulfillment-dashboard-proxy.mjs`
- Modify: `frontend/commerce-ops-vue/src/services/warehouse-transfer.ts`
- Modify: `frontend/commerce-ops-vue/src/pages/WarehouseTransferPage.vue`
- Test: `tests/preview-task-store.test.mjs`
- Test: `tests/fulfillment-dashboard-proxy.test.mjs`
- Test: `tests/sku-preview-recovery.test.mjs`

1. Add failing tests for task persistence, request fingerprint idempotency, state transitions, polling, and missing-task errors.
2. Implement file-backed `QUEUED/RUNNING/SUCCEEDED/FAILED` tasks with sanitized errors.
3. Add start/status endpoints for warehouse and SKU batch previews while retaining completed-result recovery.
4. Proxy only fixed routes and bounded task IDs.
5. Persist active task ID in session storage, resume polling after refresh, and distinguish transient timeout from confirmed missing service/task.
6. Run service, proxy, and frontend helper tests.

## Task 6: Diagnostics, regression, and restart

**Files:**
- Modify as needed: `frontend/commerce-ops-vue/src/services/sku-replacement-selection.ts`
- Modify as needed: `frontend/commerce-ops-vue/src/pages/WarehouseTransferPage.vue`

1. Extend typed diagnostics to render parser provenance, match rejection, line bindings, task stages, and sanitized HTTP details.
2. Run focused suites after every task.
3. Run Python safety tests, full Node tests with the configured Python executable, Vue type check, and production build.
4. Review the diff for credentials, generated noise, and unrelated user files.
5. Restart service 3112 and perform only health and read-only preview verification.
6. Report exact test results and any remaining manual-review/live-test boundary.
