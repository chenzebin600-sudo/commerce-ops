# Task 4 Report: Preview warehouse selector and operator diagnostics

## Status

Completed with strict RED/GREEN TDD. No generated `public/vue-preview` asset was built or modified, and no live Mabang operation was performed.

## Implemented behavior

- SKU replacement candidate contracts now expose `warehouseMode`, `targetWarehouse`, and typed `warehouseAlternatives` entries containing `warehouse`, `mode`, and `remaining`.
- Per-order-item selection state stores both the selected SKU and target warehouse.
- Selecting a candidate adopts its automatically recommended warehouse; changing the warehouse preserves the SKU; changing the SKU resets the target to the new candidate's automatic warehouse.
- Filtering plans preserves the complete hidden selection state.
- Batch selection payloads include `targetWarehouse` and discard stale SKUs or warehouses not present in that candidate's verified alternatives.
- Candidate cards show `保持原仓` / `整单换仓`, the automatic warehouse, and remaining route inventory.
- The Element Plus warehouse selector is rendered for the selected candidate and contains only that candidate's `warehouseAlternatives`.
- SKU and warehouse changes clear the existing pending approval text.
- The destructive confirmation warns that each item may require two verified Mabang operations: SKU replacement and, when needed, whole-order warehouse transfer.
- Buyer-facing Shopee data remains explicitly unchanged in the operator warning.

## TDD evidence

### RED

Command:

```text
node --test tests/sku-replacement-selection.test.mjs
```

Observed exit code: `1`.

Observed summary:

```text
tests 8
pass 5
fail 3
cancelled 0
skipped 0
todo 0
```

Expected failures:

1. `选择候选采用自动仓，切换仓库保留 SKU，切换 SKU 重置自动仓` received the entire candidate object because the old string-only toggle stored its third argument verbatim instead of a typed `{ sku, targetWarehouse }` state.
2. `替换类型、风险和已选择状态组合筛选不会清除隐藏选择` returned no plans because the old filter compared candidate SKUs to the new state object.
3. `批量请求只包含仍存在于完整预览中的有效选择` returned an empty payload because the old builder expected a string and did not validate or emit target warehouses.

### GREEN

Fresh final command:

```text
node --test tests/sku-replacement-selection.test.mjs
```

Observed exit code: `0`.

Exact summary:

```text
tests 8
pass 8
fail 0
cancelled 0
skipped 0
todo 0
duration_ms 157.6823
```

## Typecheck evidence

Required command, run from the worktree with the main-repository compiler binary:

```text
D:\znwx-ai\frontend\commerce-ops-vue\node_modules\.bin\tsc.cmd --noEmit --strict --skipLibCheck --moduleResolution Bundler --module ESNext --target ES2022 frontend\commerce-ops-vue\src\services\sku-replacement-selection.ts frontend\commerce-ops-vue\src\services\warehouse-transfer.ts
```

Observed exit code: `0`; the compiler emitted no diagnostics.

The changed Vue page and its service imports were also checked with a narrowed temporary `vue-tsc --noEmit` project. Observed exit code: `0`; the temporary config and temporary `node_modules` junction were removed after verification.

## Files changed

- `frontend/commerce-ops-vue/src/services/warehouse-transfer.ts`
- `frontend/commerce-ops-vue/src/services/sku-replacement-selection.ts`
- `frontend/commerce-ops-vue/src/pages/WarehouseTransferPage.vue`
- `tests/sku-replacement-selection.test.mjs`
- `.superpowers/sdd/2026-08-11-sku-replacement-warehouse-routing/task-4-report.md`

## Self-review

- Scope: only the four named implementation/test files and this required report changed.
- Selection safety: the UI can only choose warehouses supplied by the selected candidate, and the payload builder independently revalidates the target against the complete preview rather than trusting filtered UI state.
- Routing policy: automatic `KEEP_CURRENT` remains visible and selected when feasible; `MOVE_WHOLE_ORDER` is presented only from backend-provided alternatives.
- State behavior: filters are pure and do not mutate selections; changing candidates resets the warehouse; changing only the warehouse retains the SKU.
- Operator clarity: candidate cards distinguish original-warehouse and whole-order routes and show automatic target plus remaining inventory before confirmation.
- Irreversibility: the warning now states that two separately verified Mabang operations may occur, without suggesting retry or rollback.
- Scope boundaries: no backend write path, Shopee buyer-facing data, or generated preview asset was changed.
- Hygiene: `git diff --check` reported no whitespace errors.

## Concerns

The full worktree-wide Vue check still encounters unrelated existing errors because `src/data/shopee-shops` is absent in this worktree; the changed page was therefore verified with a narrowed Vue TypeScript project and passed. No known correctness concern remains in the scoped Task 4 changes.
