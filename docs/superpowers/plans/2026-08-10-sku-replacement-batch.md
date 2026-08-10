# SKU Replacement Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add category filtering, deferred multi-item selection, and a recoverable serial background job for batch Mabang SKU replacement.

**Architecture:** Keep candidate filtering and selection as a pure frontend state module. Add a focused `SkuReplacementBatchService` that composes the existing single-item `SkuReplacementService`, persists immutable batch plans and per-item execution state, and exposes short-lived submit plus polling APIs. The 3112 operation-drain controller tracks the detached execution promise so safe restart waits for active writes.

**Tech Stack:** Node.js 24 ESM, built-in `node:test`, Vue 3 Composition API, TypeScript 5.9, Element Plus, existing 3101 proxy and 3112 fulfillment service.

## Global Constraints

- Do not add shop or warehouse filters.
- Filter by replacement type, risk level, and processing status only.
- Clicking a candidate changes local selection only and must not call a plan or execute API.
- Each order item can select at most one replacement SKU.
- A batch contains at most 100 selected order items.
- Confirmation text is exactly `确认批量更换SKU N项`, where N is the server-validated executable count.
- Execute items serially; a failed item never blocks later items and is never automatically retried.
- Persist progress after each item and expose recovery by task ID.
- Continue modifying only the Mabang fulfillment SKU; never modify the platform buyer item.

---

### Task 1: Pure candidate filter and selection model

**Files:**
- Create: `frontend/commerce-ops-vue/src/services/sku-replacement-selection.ts`
- Create: `tests/sku-replacement-selection.test.mjs`

**Interfaces:**
- Consumes: `SkuReplacementPlan`, `SkuReplacementKind`, and `SkuReplacementCandidate` from `frontend/commerce-ops-vue/src/services/warehouse-transfer.ts`.
- Produces: `toggleSkuSelection`, `filterSkuReplacementPlans`, `summarizeSkuSelections`, `replacementItemStatus`, and filter/status types used by `WarehouseTransferPage.vue`.

- [ ] **Step 1: Write failing selection tests**

```js
import { toggleSkuSelection, filterSkuReplacementPlans, summarizeSkuSelections } from "../frontend/commerce-ops-vue/src/services/sku-replacement-selection.ts";

test("one item keeps at most one candidate and a second click cancels it", () => {
  const key = "ORDER_1\u00001";
  assert.deepEqual(toggleSkuSelection({}, key, "SKU-A"), { [key]: "SKU-A" });
  assert.deepEqual(toggleSkuSelection({ [key]: "SKU-A" }, key, "SKU-B"), { [key]: "SKU-B" });
  assert.deepEqual(toggleSkuSelection({ [key]: "SKU-A" }, key, "SKU-A"), {});
});

test("filters compose without clearing hidden selections", () => {
  const result = filterSkuReplacementPlans(plans, { kind: "COLOR", risk: "MEDIUM", status: "SELECTED" }, selections, {});
  assert.deepEqual(result.map(({ order, items }) => [order.platformOrderId, items.map((item) => item.itemId)]), [["ORDER_1", ["1"]]]);
  assert.equal(summarizeSkuSelections(plans, selections).selectedItems, 2);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `node --disable-warning=ExperimentalWarning --test tests/sku-replacement-selection.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `sku-replacement-selection.ts`.

- [ ] **Step 3: Implement the pure model**

```ts
export type ReplacementKindFilter = "ALL" | SkuReplacementKind;
export type ReplacementRiskFilter = "ALL" | "LOW" | "MEDIUM" | "HIGH";
export type ReplacementStatusFilter = "ALL" | "UNSELECTED" | "SELECTED" | "NO_CANDIDATE" | "RUNNING" | "COMPLETED" | "FAILED" | "MANUAL_REVIEW";
export type SkuSelections = Record<string, string>;

export function toggleSkuSelection(current: SkuSelections, key: string, sku: string): SkuSelections {
  const next = { ...current };
  if (next[key] === sku) delete next[key]; else next[key] = sku;
  return next;
}
```

Implement filtering by candidate `kind` and `riskLevel`, then by item status derived from selections and execution results. Return cloned plans containing only visible shortage items; do not mutate the preview data.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `node --disable-warning=ExperimentalWarning --test tests/sku-replacement-selection.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit the model**

```powershell
git add frontend/commerce-ops-vue/src/services/sku-replacement-selection.ts tests/sku-replacement-selection.test.mjs
git commit -m "feat: add SKU replacement selection model"
```

### Task 2: Persistent batch plan and execution service

**Files:**
- Create: `fulfillment-service/sku-replacement-batch.mjs`
- Modify: `fulfillment-service/sku-replacement.mjs`
- Modify: `tests/sku-replacement.test.mjs`

**Interfaces:**
- Consumes: `SkuReplacementService.createPlan(selection)`, `SkuReplacementService.execute({ planHash, approvalText })`, and new `SkuReplacementService.restorePlan(record)`.
- Produces: `SkuReplacementBatchService.createPlan({ selections })`, `createExecution({ batchHash, approvalText })`, `runExecution(taskId)`, `getExecution(taskId)`, and `reconcileInterruptedExecutions()`.

- [ ] **Step 1: Write failing batch-plan tests**

```js
test("batch plan rejects duplicate item targets and preserves per-item validation failures", async () => {
  const batchService = new SkuReplacementBatchService({ rootDir, skuReplacementService: fakeSingleService, now, randomUUID });
  await assert.rejects(batchService.createPlan({ selections: [
    { orderReference: "ORDER_1", itemId: "1", replacementSku: "SKU-A" },
    { orderReference: "ORDER_1", itemId: "1", replacementSku: "SKU-B" },
  ] }), /每个商品行只能选择一个替换 SKU/);
  const plan = await batchService.createPlan({ selections: validAndInvalidSelections });
  assert.equal(plan.summary.executable, 1);
  assert.equal(plan.summary.failed, 1);
  assert.equal(plan.approvalText, "确认批量更换SKU 1项");
});
```

- [ ] **Step 2: Run batch-plan tests and verify RED**

Run: `node --disable-warning=ExperimentalWarning --test tests/sku-replacement.test.mjs`

Expected: FAIL because `SkuReplacementBatchService` is not exported.

- [ ] **Step 3: Implement immutable batch plans**

Create `storage/sku-replacements/batch-plans/<batchHash>.json`. Validate 1–100 selections, exact field formats, and duplicate `orderReference + itemId` keys. Call the single-item plan service serially and store successful plan records plus normalized failures. Hash the persisted semantic content and set a 10-minute expiry.

Add this narrow restoration seam to the existing service:

```js
restorePlan(record) {
  const expected = hash(Object.fromEntries(Object.entries(record).filter(([key]) => !["planHash", "approvalText"].includes(key))));
  if (record.planHash !== expected) throw coded("SKU_REPLACEMENT_PLAN_HASH_INVALID", "更换计划校验失败");
  if (this.now().getTime() >= Date.parse(record.expiresAt)) throw coded("SKU_REPLACEMENT_PLAN_EXPIRED", "更换计划已过期，请重新读取");
  this.plans.set(record.planHash, record);
  return record;
}
```

- [ ] **Step 4: Run batch-plan tests and verify GREEN**

Run: `node --disable-warning=ExperimentalWarning --test tests/sku-replacement.test.mjs`

Expected: PASS.

- [ ] **Step 5: Write failing execution lifecycle tests**

Test exact confirmation, one-time submission, strict maximum concurrency of one, continuation after a middle failure, atomic persisted progress after every item, and restart reconciliation of `RUNNING` to `MANUAL_REVIEW` while pending items become `NOT_EXECUTED`.

```js
const accepted = batchService.createExecution({ batchHash: plan.batchHash, approvalText: plan.approvalText });
await batchService.runExecution(accepted.taskId);
const result = batchService.getExecution(accepted.taskId);
assert.deepEqual(result.items.map((item) => item.status), ["COMPLETED", "FAILED", "COMPLETED"]);
assert.equal(maxConcurrentWrites, 1);
assert.equal(result.status, "COMPLETED_WITH_FAILURES");
assert.equal(batchService.createExecution({ batchHash: plan.batchHash, approvalText: plan.approvalText }).taskId, accepted.taskId);
```

- [ ] **Step 6: Run lifecycle tests and verify RED**

Run: `node --disable-warning=ExperimentalWarning --test tests/sku-replacement.test.mjs`

Expected: FAIL because execution lifecycle methods do not exist.

- [ ] **Step 7: Implement execution lifecycle**

Persist tasks under `storage/sku-replacements/batch-executions/<taskId>.json` using temporary-file rename. Before each write mark the item `RUNNING`, restore its single plan, then invoke single execution. On success mark `COMPLETED`; on ordinary error mark `FAILED`; on an error code ending in `VERIFY_FAILED` mark `MANUAL_REVIEW`. Persist after every transition and finalize as `COMPLETED` or `COMPLETED_WITH_FAILURES`.

- [ ] **Step 8: Run lifecycle tests and verify GREEN**

Run: `node --disable-warning=ExperimentalWarning --test tests/sku-replacement.test.mjs`

Expected: PASS.

- [ ] **Step 9: Commit the batch domain service**

```powershell
git add fulfillment-service/sku-replacement.mjs fulfillment-service/sku-replacement-batch.mjs tests/sku-replacement.test.mjs
git commit -m "feat: add persistent batch SKU replacement jobs"
```

### Task 3: Expose 3112 and 3101 batch APIs

**Files:**
- Modify: `fulfillment-service/server.mjs`
- Modify: `lib/fulfillment-dashboard-proxy.mjs`
- Modify: `tests/fulfillment-dashboard-proxy.test.mjs`
- Modify: `tests/operation-drain.test.mjs`

**Interfaces:**
- Consumes: Task 2 `SkuReplacementBatchService` methods.
- Produces: `POST /batch-plan`, `POST /batch-execute`, and `GET /batch-executions/:taskId` on both 3112 and the 3101 dashboard proxy.

- [ ] **Step 1: Write failing proxy routing and validation tests**

Add tests that send the new paths through the proxy, assert a maximum of 100 selections, reject invalid task IDs, preserve the actor assertion on batch execute, and confirm the GET status route has no body.

- [ ] **Step 2: Run proxy tests and verify RED**

Run: `node --disable-warning=ExperimentalWarning --test tests/fulfillment-dashboard-proxy.test.mjs`

Expected: FAIL with 404 or wrong upstream path.

- [ ] **Step 3: Implement proxy paths and request validators**

Add exact mappings and body helpers:

```js
if (method === "POST" && pathname === "/api/fulfillment-dashboard/sku-replacements/batch-plan") return "/api/fulfillment/sku-replacements/batch-plan";
if (method === "POST" && pathname === "/api/fulfillment-dashboard/sku-replacements/batch-execute") return "/api/fulfillment/sku-replacements/batch-execute";
const match = pathname.match(/^\/api\/fulfillment-dashboard\/sku-replacements\/batch-executions\/([A-Za-z0-9-]{1,80})$/);
```

The batch plan accepts `selections`; batch execute accepts `batchHash` and `approvalText`. Add the new invalid-body codes to the 400 response set.

- [ ] **Step 4: Run proxy tests and verify GREEN**

Run: `node --disable-warning=ExperimentalWarning --test tests/fulfillment-dashboard-proxy.test.mjs`

Expected: PASS.

- [ ] **Step 5: Write failing 3112 lifecycle/drain tests**

Assert batch execution responds with a task before its worker promise finishes, `activeWriteOperations` remains one while the job runs, and drain waits until the serial task resolves.

- [ ] **Step 6: Run drain tests and verify RED**

Run: `node --disable-warning=ExperimentalWarning --test tests/operation-drain.test.mjs`

Expected: FAIL because the batch execution is not registered with operation drain.

- [ ] **Step 7: Wire service routes and detached tracked execution**

Instantiate `SkuReplacementBatchService`, reconcile interrupted task files at startup, and add routes. On execute, synchronously create the task, then launch and retain the promise through `trackedOperation("sku-batch-execute", { write: true }, () => batchService.runExecution(taskId))`; attach a terminal catch for logging without awaiting it in the HTTP response. Return HTTP 202 with the task record. The GET route returns the persisted current state.

- [ ] **Step 8: Run service and proxy regression tests**

Run: `node --disable-warning=ExperimentalWarning --test tests/operation-drain.test.mjs tests/fulfillment-dashboard-proxy.test.mjs tests/sku-replacement.test.mjs tests/warehouse-transfer.test.mjs`

Expected: PASS.

- [ ] **Step 9: Commit API wiring**

```powershell
git add fulfillment-service/server.mjs lib/fulfillment-dashboard-proxy.mjs tests/fulfillment-dashboard-proxy.test.mjs tests/operation-drain.test.mjs
git commit -m "feat: expose batch SKU replacement APIs"
```

### Task 4: Vue filters, batch selection, confirmation, and progress recovery

**Files:**
- Modify: `frontend/commerce-ops-vue/src/services/warehouse-transfer.ts`
- Modify: `frontend/commerce-ops-vue/src/pages/WarehouseTransferPage.vue`
- Modify: `tests/sku-replacement-selection.test.mjs`
- Modify: `tests/commerce-ops-vue-workspace.test.mjs`

**Interfaces:**
- Consumes: Task 1 pure selection helpers and Task 3 APIs.
- Produces: category filter controls, local-only candidate selection, one batch confirmation dialog, polling, persisted task ID, and result rendering.

- [ ] **Step 1: Write failing UI contract tests**

Extend pure tests for all status filters and execution-result mapping. Add source-level workspace assertions that candidate cards call `toggleReplacementCandidate`, the old `replaceSku(plan, item)` handler is absent, and exactly one batch action invokes `createSkuReplacementBatchPlan`.

- [ ] **Step 2: Run UI tests and verify RED**

Run: `node --disable-warning=ExperimentalWarning --test tests/sku-replacement-selection.test.mjs tests/commerce-ops-vue-workspace.test.mjs`

Expected: FAIL because batch client functions and batch UI do not exist.

- [ ] **Step 3: Add typed API clients**

Define `SkuReplacementSelection`, `SkuReplacementBatchPlan`, `SkuReplacementBatchExecution`, and item status types. Add:

```ts
createSkuReplacementBatchPlan(selections)
executeSkuReplacementBatch(batchHash, approvalText)
getSkuReplacementBatchExecution(taskId)
```

- [ ] **Step 4: Replace immediate execution with local selection**

Remove the single-item prompt/execute path from the page. Candidate clicks call the pure toggle helper and show “已加入批量替换” on the selected card. Keep `aria-pressed`; disable selection only for bundle review or while planning/executing.

- [ ] **Step 5: Add filters and empty state**

Add replacement-type chips plus risk and status selectors. Render `filteredReplacementPlans`. Show displayed/total item counts and a “清除筛选” action when no items match. Filters must not mutate `selectedReplacementSkus`.

- [ ] **Step 6: Add batch action and confirmation**

The action bar shows selected item and order counts. Submit selections to batch-plan, then prompt once with the server `approvalText`. On confirmation call batch-execute, save `taskId` to session storage under `commerce-ops-sku-replacement-task-id`, and begin polling every two seconds.

- [ ] **Step 7: Add progress and recovery**

Render processed/total, current item, and final per-item statuses. On mount, if a task ID exists, fetch it and resume polling while status is `QUEUED` or `RUNNING`. Stop polling on unmount and on terminal status. Map completed results into the status filter without erasing the original preview.

- [ ] **Step 8: Run UI tests and type checks**

Run: `node --disable-warning=ExperimentalWarning --test tests/sku-replacement-selection.test.mjs tests/commerce-ops-vue-workspace.test.mjs`

Run: `npm.cmd run check` from `frontend/commerce-ops-vue`.

Expected: all PASS.

- [ ] **Step 9: Commit frontend workflow**

```powershell
git add frontend/commerce-ops-vue/src/services/sku-replacement-selection.ts frontend/commerce-ops-vue/src/services/warehouse-transfer.ts frontend/commerce-ops-vue/src/pages/WarehouseTransferPage.vue tests/sku-replacement-selection.test.mjs tests/commerce-ops-vue-workspace.test.mjs
git commit -m "feat: add filtered batch SKU replacement UI"
```

### Task 5: Full verification and safe activation

**Files:**
- Modify generated assets under `public/vue-preview/` through the existing build only.

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: built frontend assets and a live 3112 service with the new routes.

- [ ] **Step 1: Run focused and full tests**

Run: `node --disable-warning=ExperimentalWarning --test tests/sku-replacement-selection.test.mjs tests/sku-replacement.test.mjs tests/fulfillment-dashboard-proxy.test.mjs tests/operation-drain.test.mjs tests/warehouse-transfer.test.mjs tests/commerce-ops-vue-workspace.test.mjs`

Run: `npm.cmd test`.

Expected: all PASS with no new warnings or unhandled rejections.

- [ ] **Step 2: Build frontend**

Run: `npm.cmd run build` from `frontend/commerce-ops-vue`.

Expected: type checks and Vite build PASS; if the existing Windows index-file lock recurs after Vite succeeds, rerun `node scripts/normalize-vue-build.mjs` from the repository root and verify the served chunk directly.

- [ ] **Step 3: Inspect diff integrity**

Run: `git diff --check` and inspect only files in this plan. Preserve unrelated dirty-worktree changes.

- [ ] **Step 4: Activate 3112 safely**

Use `npm.cmd run restart:fulfillment:safe`. Do not use `Stop-Process`. Verify `/health` reports `success: true`, `draining: false`, and zero active writes after restart.

- [ ] **Step 5: Run non-writing live smoke checks**

Verify the three new routes reject invalid input correctly, the 3101-served asset contains the filter and batch labels, and clicking a candidate in the page causes no network request. Do not confirm or execute a real SKU replacement during smoke testing.

- [ ] **Step 6: Commit generated assets and final integration**

```powershell
git add public/vue-preview/index.html public/vue-preview/assets/WarehouseTransferPage-* public/vue-preview/assets/index-* frontend/commerce-ops-vue/src/services/sku-replacement-selection.ts frontend/commerce-ops-vue/src/services/warehouse-transfer.ts frontend/commerce-ops-vue/src/pages/WarehouseTransferPage.vue fulfillment-service/sku-replacement.mjs fulfillment-service/sku-replacement-batch.mjs fulfillment-service/server.mjs lib/fulfillment-dashboard-proxy.mjs tests/sku-replacement-selection.test.mjs tests/sku-replacement.test.mjs tests/fulfillment-dashboard-proxy.test.mjs tests/operation-drain.test.mjs tests/commerce-ops-vue-workspace.test.mjs
git commit -m "feat: ship batch SKU replacement workflow"
```
