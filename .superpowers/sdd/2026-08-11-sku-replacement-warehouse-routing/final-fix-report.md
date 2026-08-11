# Final fix report: deterministic SKU warehouse routing

## Status

All Critical and Important final-review findings are resolved in one fix wave. No live Mabang service was called; all service behavior was exercised through local fakes and the repository safety suites.

## Finding-to-change/test mapping

### 1. Critical: full pre-write route revalidation

Changes:

- Added hashed `preWriteEvidence` to every SKU replacement plan. It contains normalized active item identities, SKUs, quantities, current warehouses and warehouse options; the explicit shop allowlist; hashed inventory scopes; inventory for every prospective active-order SKU in every relevant scope; the replacement eligibility evidence; all eligible routes; and the operator-selected target/mode.
- Execution consumes the one-shot plan, independently re-inspects the order, reloads the shop allowlist, refreshes inventory across the hashed and freshly observed scopes, rebuilds the exact route evidence, and compares it with the hashed plan before `order-sku-change`.
- Any order/policy/support/inventory/route difference now fails closed with `SKU_REPLACEMENT_PRECONDITION_CHANGED` before the irreversible SKU write.
- Post-write SKU/warehouse inspection, final independent verification, one-shot plan semantics, no retry, and no rollback remain unchanged.

Tests:

- `SKU 写入前会重验全部商品行、店铺白名单和完整目标仓库存`
  - non-selected item quantity change rejects with zero SKU writes;
  - explicit allowlist change rejects with zero SKU writes;
  - non-selected prospective SKU target-stock change rejects with zero SKU writes.
- Existing two-phase, final mixed-warehouse, one-shot, no-retry, and diagnostic tests remain green.

### 2. Important: same-order multi-line batch selections

Changes:

- Added an order-level duplicate check before per-item plan creation.
- Different lines from the same order deterministically fail with `SKU_REPLACEMENT_BATCH_ORDER_DUPLICATE` / `同一批次每个订单只能选择一个商品行`.
- The existing same-item duplicate check runs first and retains its original code/message.

Test:

- `批量更换计划确定性拒绝同一订单的多个商品行` proves rejection happens before any single-item plan is created.
- Existing serial continuation and same-item duplicate tests remain green.

### 3. Important: KEEP_CURRENT auto-hop reconciliation

Changes:

- Added `previewKeepCurrentReconciliation`, an internal warehouse-transfer entry point that accepts only an already-hashed prospective item set whose original warehouse for every line equals the requested target.
- The internal preview still performs the existing whole-order item identity, common warehouse-option, and inventory checks, then creates a normally hashed transfer plan and uses the existing single-write executor.
- Only a hashed transfer plan carrying `reconciliation: { mode: "KEEP_CURRENT", originalWarehouse }` may bypass the shop move allowlist during execution.
- Normal `MOVE_WHOLE_ORDER`, public preview/batch preview, and any-single-warehouse behavior remain allowlist-gated.

Tests:

- `空白名单的 KEEP_CURRENT 计划自动跳仓后通过内部路径恢复哈希原仓` is an end-to-end service test covering plan creation, pre-write revalidation, one SKU write, simulated Mabang auto-hop, exact whole-order restoration, and final independent verification.
- `公开换仓预览不会使用 KEEP_CURRENT 的内部空白名单授权` proves the public path still rejects an empty allowlist.

### 4. Important: frontend warehouse-phase diagnostics

Changes:

- Split diagnostics into a typed legacy/warehouse union.
- Added warehouse-phase rendering for phase, bounded safe message, observed/target SKU, target/final warehouses, all attempt/confirmation flags, and safe cause code.
- Warehouse verification errors now emit a phase-specific safe message without copying arbitrary downstream error text.
- Optional message/cause typing remains compatible with older persisted warehouse diagnostics.

Tests:

- Existing `接口诊断会转换为固定、可读且无 HTML 的字段行` protects legacy SKU rendering.
- `仓库阶段诊断会显示安全说明、尝试状态和目标与最终仓库` protects the new manual-review rows.

### 5. Minor: narrow preview DTO

Changes:

- Public batch-preview candidates no longer include internal `prospectiveItems` or per-route stock evidence.
- Full evidence remains server-side in the hashed execution plan and `preWriteEvidence`.

Test:

- `替换预览优先保留当前仓并只从店铺白名单提供整单换仓路线` asserts the public candidate omits both internal fields.

## TDD evidence

### RED

Command:

```powershell
node --test tests/sku-replacement.test.mjs tests/sku-replacement-selection.test.mjs
```

Result: exit 1; 39 tests, 31 passed, 8 failed. Expected failures were:

- warehouse-phase diagnostic rows returned `[]`;
- preview candidate still exposed `prospectiveItems`/route stock;
- the three pre-write mutation subtests completed instead of rejecting, so the expected rejection and zero-write boundary were absent;
- empty-allowlist KEEP_CURRENT failed at `WAREHOUSE_POLICY_EMPTY` after the SKU write;
- same-order different-line batch selection was accepted.

### GREEN

Initial focused command after the implementation:

```powershell
node --test tests/sku-replacement.test.mjs tests/sku-replacement-selection.test.mjs tests/warehouse-transfer.test.mjs
```

Result: exit 0; 47/47 passed. After the public-path preservation test and compatibility cleanup, the same command passed 48/48.

## Final verification

Required Node suite:

```powershell
node --test tests/sku-warehouse-routing.test.mjs tests/sku-replacement.test.mjs tests/sku-replacement-selection.test.mjs tests/warehouse-transfer.test.mjs tests/fulfillment-dashboard-proxy.test.mjs
```

Result: exit 0; 56/56 passed, 0 failed.

Required Python safety suite:

```powershell
D:\znwx-ai\.venv\Scripts\python.exe -m unittest tests.test_mabang_fulfillment_safety -v
```

Result: exit 0; 38/38 passed, `OK`.

Relevant strict TypeScript no-emit check:

```powershell
D:\znwx-ai\frontend\commerce-ops-vue\node_modules\.bin\tsc.cmd --noEmit --strict --skipLibCheck --moduleResolution Bundler --module ESNext --target ES2022 frontend\commerce-ops-vue\src\services\sku-replacement-selection.ts frontend\commerce-ops-vue\src\services\warehouse-transfer.ts
```

Result: exit 0; no diagnostics.

Repository hygiene:

```powershell
git diff --check
```

Result: exit 0; no whitespace errors.

## Files changed

- `fulfillment-service/sku-replacement.mjs`
- `fulfillment-service/sku-replacement-batch.mjs`
- `fulfillment-service/warehouse-transfer.mjs`
- `frontend/commerce-ops-vue/src/services/warehouse-transfer.ts`
- `frontend/commerce-ops-vue/src/services/sku-replacement-selection.ts`
- `tests/sku-replacement.test.mjs`
- `tests/warehouse-transfer.test.mjs`
- `tests/sku-replacement-selection.test.mjs`
- `.superpowers/sdd/2026-08-11-sku-replacement-warehouse-routing/final-fix-report.md`

## Self-review

- Confirmed the SKU plan is consumed before fresh revalidation, preserving concurrency-safe one-shot behavior, and no write occurs until the entire evidence comparison passes.
- Confirmed fresh evidence covers every prospective SKU, not only the selected line, and includes explicit policy and warehouse-option support.
- Confirmed KEEP_CURRENT authorization is generated only by the internal method, bound into the warehouse plan hash, and limited to the original target represented by every hashed prospective item.
- Confirmed the public HTTP service still invokes only normal `preview(payload)` and cannot supply the internal reconciliation context.
- Confirmed arbitrary downstream error messages are not copied into warehouse diagnostics.
- Confirmed no generated frontend assets, unrelated files, or live-service configuration were changed.

## Concerns

No blocking concerns. A replacement plan generated by an older process without `preWriteEvidence` will fail closed and require a fresh preview; plan TTL is ten minutes, so this affects only a short-lived in-flight plan during deployment and is the safe behavior.
