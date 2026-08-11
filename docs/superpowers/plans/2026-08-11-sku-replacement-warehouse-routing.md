# SKU Replacement Warehouse Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every SKU replacement finish in a deterministic warehouse: keep the original single warehouse when feasible, otherwise move the whole order to an automatically selected or manually chosen shop-allowed warehouse.

**Architecture:** Add a pure routing module that evaluates the prospective final order against inventory, item warehouse support, and the shop allowlist. Extend replacement preview/plan records with a hashed warehouse decision, then coordinate the existing SKU write and existing whole-order warehouse-transfer service behind one confirmed plan and final readback.

**Tech Stack:** Node.js ES modules, Python Mabang worker boundary, Vue 3/TypeScript/Element Plus, `node:test`, Python `unittest`.

## Global Constraints

- Mabang's automatically selected warehouse is never accepted as the source of truth.
- Prefer `KEEP_CURRENT`; use `MOVE_WHOLE_ORDER` only when the original single warehouse cannot satisfy the prospective final item set.
- Move targets come only from the order shop's fulfillment `allowedWarehouses`.
- Do not retry either Mabang write, and do not automatically roll back a confirmed SKU change.
- Final success requires the replacement SKU and every active order item to match the hashed target warehouse.
- Keep buyer-facing Shopee order data unchanged.

---

### Task 1: Pure prospective-order warehouse routing

**Files:**
- Create: `fulfillment-service/sku-warehouse-routing.mjs`
- Test: `tests/sku-warehouse-routing.test.mjs`

**Interfaces:**
- Consumes: `{ items, replacementItemId, replacementSku, allowedWarehouses, inventory }` where items contain current warehouses, quantities, SKUs, and `warehouseOptions`.
- Produces: `evaluateSkuWarehouseRoutes(input)` returning `{ originalWarehouse, prospectiveItems, selected, alternatives }`; each route is `{ mode, warehouse, remaining, stock }`.

- [ ] **Step 1: Write failing routing tests**

Add literal fixtures proving:

```js
assert.equal(evaluateSkuWarehouseRoutes(keepFixture).selected.mode, "KEEP_CURRENT");
assert.equal(evaluateSkuWarehouseRoutes(moveFixture).selected.warehouse, "允许仓B");
assert.deepEqual(evaluateSkuWarehouseRoutes(moveFixture).alternatives.map((item) => item.warehouse), ["允许仓B", "允许仓A"]);
assert.equal(evaluateSkuWarehouseRoutes(multiWarehouseFixture).alternatives.some((item) => item.mode === "KEEP_CURRENT"), false);
assert.equal(evaluateSkuWarehouseRoutes(emptyAllowlistFixture).selected, null);
```

The move fixture must include another order line so the test fails if routing checks only the replacement SKU.

- [ ] **Step 2: Verify the new tests fail**

Run: `node --test tests/sku-warehouse-routing.test.mjs`

Expected: FAIL because the routing module does not exist.

- [ ] **Step 3: Implement the pure evaluator**

Export:

```js
export function warehouseScope(value) {
  return String(value ?? "").trim().replace(/\/[-\d.]+$/, "").trim();
}
export function warehouseKey(value) {
  return warehouseScope(value).replace(/\s+/g, "").toUpperCase();
}
```

Implement `evaluateSkuWarehouseRoutes({ items, replacementItemId, replacementSku, allowedWarehouses, inventory })` by building the prospective item list first. A warehouse is eligible only when inventory covers aggregated quantity for every prospective SKU; non-replaced lines must also expose that warehouse in `warehouseOptions`. Evaluate the unique original warehouse before allowlisted moves. Sort move alternatives by `remaining` descending and Chinese warehouse name ascending, and return `{ originalWarehouse, prospectiveItems, selected, alternatives }`.

- [ ] **Step 4: Verify routing tests pass**

Run: `node --test tests/sku-warehouse-routing.test.mjs`

Expected: all routing tests pass.

---

### Task 2: Replacement previews and hashed plans carry warehouse routes

**Files:**
- Modify: `fulfillment-service/sku-replacement.mjs`
- Modify: `fulfillment-service/server.mjs`
- Modify: `fulfillment-service/sku-replacement-batch.mjs`
- Modify: `lib/fulfillment-dashboard-proxy.mjs`
- Test: `tests/sku-replacement.test.mjs`
- Test: `tests/fulfillment-dashboard-proxy.test.mjs`

**Interfaces:**
- `new SkuReplacementService({ rootDir, credentials, hasShopAccess, allowedWarehouses, warehouseTransferService, runWorker, now })` receives a replacement-specific resolver that returns `policy.allowedWarehouses` only for explicit `allowlist` policies and returns `[]` for `any_single_warehouse`.
- `createPlan({ orderReference, itemId, replacementSku, targetWarehouse = "" })` hashes `warehouseMode`, `targetWarehouse`, `warehouseAlternatives`, and `prospectiveItems`.
- Batch selections become `{ orderReference, itemId, replacementSku, targetWarehouse?: string }`.

- [ ] **Step 1: Write failing preview and plan tests**

Add cases asserting:

```js
assert.equal(previewCandidate.warehouseMode, "KEEP_CURRENT");
assert.equal(moveCandidate.targetWarehouse, "允许仓B");
assert.deepEqual(moveCandidate.warehouseAlternatives.map((item) => item.warehouse), ["允许仓B", "允许仓A"]);
assert.match(plan.approvalText, /确认更换SKU并整单定仓 .* -> 允许仓A$/);
await assert.rejects(service.createPlan({ ...selection, targetWarehouse: "任意仓" }), /目标仓库不在可选范围/);
```

Also assert an empty shop allowlist permits a feasible keep-current plan but returns no move candidate.

- [ ] **Step 2: Verify the focused tests fail**

Run: `node --test tests/sku-replacement.test.mjs`

Expected: FAIL because previews and plans do not expose warehouse routing.

- [ ] **Step 3: Integrate route evaluation into preview and plan creation**

Load inventory for the union of current warehouses and the explicit `allowedWarehouses(order.shopId)`. Discover matching replacement SKUs across those scopes, group by SKU, and attach the pure evaluator's selected route and alternatives. Preserve existing same-product/color/smaller-spec classification and combination-SKU blocking. Configure the resolver in `server.mjs` so an `any_single_warehouse` policy cannot silently broaden replacement move targets.

Generate confirmation text exactly as:

```js
`确认更换SKU并整单定仓 ${orderId} ${originalSku} -> ${replacementSku} -> ${targetWarehouse}`
```

- [ ] **Step 4: Pass target warehouses through batch and proxy boundaries**

Normalize `targetWarehouse` to at most 160 characters, reject control characters, include it in batch hashing, and pass it unchanged to `createPlan`. Do not accept a target during execution.

- [ ] **Step 5: Verify service and proxy tests pass**

Run: `node --test tests/sku-replacement.test.mjs tests/fulfillment-dashboard-proxy.test.mjs`

Expected: all focused tests pass.

---

### Task 3: Two-phase execution and final SKU-plus-warehouse verification

**Files:**
- Modify: `fulfillment-service/sku-replacement.mjs`
- Modify: `fulfillment-service/sku-replacement-batch.mjs`
- Modify: `fulfillment-service/server.mjs`
- Test: `tests/sku-replacement.test.mjs`

**Interfaces:**
- The SKU service calls `warehouseTransferService.preview({ orderReference, targetWarehouse })` and `warehouseTransferService.execute({ planHash, approvalText })` only after a confirmed SKU write and only when readback is not already at the target.
- Completed results add `warehouseRouting: { mode, targetWarehouse, transferSkipped, finalWarehouses }`.
- Post-SKU warehouse uncertainty throws `SKU_REPLACEMENT_WAREHOUSE_VERIFY_FAILED` with safe phase diagnostics.

- [ ] **Step 1: Write failing execution tests**

Cover these observable call sequences:

```js
assert.deepEqual(actions, ["order-sku-change", "order-warehouse-inspect", "warehouse-preview", "warehouse-execute", "order-warehouse-inspect"]);
assert.equal(completed.result.warehouseRouting.targetWarehouse, "深圳仓");
assert.equal(completed.result.warehouseRouting.transferSkipped, false);
```

Add separate tests for: Mabang auto-hop reconciled back to original; already-at-target skips warehouse write; warehouse failure after confirmed SKU becomes `SKU_REPLACEMENT_WAREHOUSE_VERIFY_FAILED`; no retry and no SKU rollback; final mixed warehouses fail verification.

- [ ] **Step 2: Verify execution tests fail**

Run: `node --test tests/sku-replacement.test.mjs`

Expected: FAIL because execution stops after SKU readback.

- [ ] **Step 3: Implement deterministic reconciliation**

After `order-sku-change`, re-inspect the order. Confirm the selected item has the target SKU. If all active lines already match the plan warehouse, skip transfer. Otherwise create and execute an exact whole-order warehouse plan through the injected service. Re-inspect independently and require the target SKU plus one target warehouse across all active lines.

Persist phase-safe diagnostics and use a `*_VERIFY_FAILED` code for every state where the SKU may be changed but the final warehouse is unconfirmed. Consume the outer plan before the first write and never retry it.

- [ ] **Step 4: Update batch manual-review classification**

Classify `SKU_REPLACEMENT_WAREHOUSE_VERIFY_FAILED` and every other `*_VERIFY_FAILED` result as `MANUAL_REVIEW`; preserve serial continuation for later items.

- [ ] **Step 5: Verify execution and batch tests pass**

Run: `node --test tests/sku-replacement.test.mjs tests/warehouse-transfer.test.mjs`

Expected: all focused tests pass.

---

### Task 4: Preview warehouse selector and operator diagnostics

**Files:**
- Modify: `frontend/commerce-ops-vue/src/services/warehouse-transfer.ts`
- Modify: `frontend/commerce-ops-vue/src/services/sku-replacement-selection.ts`
- Modify: `frontend/commerce-ops-vue/src/pages/WarehouseTransferPage.vue`
- Test: `tests/sku-replacement-selection.test.mjs`

**Interfaces:**
- Candidate types add `warehouseMode`, `targetWarehouse`, and `warehouseAlternatives: Array<{ warehouse, mode, remaining }>`.
- Selection state stores both SKU and target warehouse per order-item key.
- `buildSkuReplacementSelections` emits the selected target warehouse.

- [ ] **Step 1: Write failing selection-helper tests**

Assert that selecting a candidate adopts its automatic warehouse, changing the warehouse keeps the SKU selected, changing the SKU resets to that candidate's automatic warehouse, hidden filters preserve both values, and batch payloads contain only candidate-eligible warehouses.

- [ ] **Step 2: Verify UI helper tests fail**

Run: `node --test tests/sku-replacement-selection.test.mjs`

Expected: FAIL because selection state stores only an SKU string.

- [ ] **Step 3: Implement typed selection state and UI controls**

Show a `保持原仓` or `整单换仓` badge, the auto-selected warehouse, remaining inventory, and an Element Plus selector containing only `warehouseAlternatives`. Clear pending approval state whenever SKU or warehouse changes. Update the confirmation warning to state that two verified Mabang operations may occur.

- [ ] **Step 4: Verify helper tests and TypeScript**

Run:

```powershell
node --test tests/sku-replacement-selection.test.mjs
D:\znwx-ai\frontend\commerce-ops-vue\node_modules\.bin\tsc.cmd --noEmit --strict --skipLibCheck --moduleResolution Bundler --module ESNext --target ES2022 frontend\commerce-ops-vue\src\services\sku-replacement-selection.ts frontend\commerce-ops-vue\src\services\warehouse-transfer.ts
```

Expected: tests and type check pass.

---

### Task 5: Regression verification and operational handoff

**Files:**
- Modify only if required by final assertions: `tests/test_mabang_fulfillment_safety.py`
- Modify only if required by diagnostic shape: `tests/mabang-worker-runner.test.mjs`

**Interfaces:**
- No new production interface; this task validates the complete plan.

- [ ] **Step 1: Run safety and focused suites**

Run:

```powershell
D:\znwx-ai\.venv\Scripts\python.exe -m unittest tests.test_mabang_fulfillment_safety -v
node --test tests\sku-warehouse-routing.test.mjs tests\sku-replacement.test.mjs tests\sku-replacement-selection.test.mjs tests\warehouse-transfer.test.mjs tests\mabang-worker-runner.test.mjs
```

- [ ] **Step 2: Run the full Node suite with the configured Python runtime**

Run:

```powershell
$env:PYTHON_EXECUTABLE='D:\znwx-ai\.venv\Scripts\python.exe'; npm.cmd test
```

Expected: zero failures; the existing external-advertising skip may remain.

- [ ] **Step 3: Review the final diff and request independent code review**

Verify no credentials, cookies, headers, live order identifiers, generated frontend assets, or unrelated dirty-worktree files are included. Resolve every Critical or Important finding and rerun affected tests.

- [ ] **Step 4: Commit the implementation branch**

Stage only the files listed in this plan and commit with:

```powershell
git commit -m "feat: route SKU replacements to verified warehouses"
```

Do not perform another live Mabang write as part of automated verification.
