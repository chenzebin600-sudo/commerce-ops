# Task 2 Report: Replacement previews and hashed plans carry warehouse routes

## Status

Implemented and verified.

## TDD evidence

### RED — service routing slice

Command:

```text
node --test tests/sku-replacement.test.mjs
```

Result: exit code 1; 15 tests, 12 passed, 3 failed.

The focused failures demonstrated the missing behavior:

```text
替换预览优先保留当前仓并只从店铺白名单提供整单换仓路线
  actual undefined; expected 'KEEP_CURRENT'

空店铺仓库白名单允许保留当前仓但不会产生整单换仓候选
  actual undefined; expected 'KEEP_CURRENT'

更换计划绑定选定仓库、路线备选和预期商品集合
  SKU_REPLACEMENT_CANDIDATE_CHANGED: 所选 SKU 已不满足同仓、同款及库存规则，请重新读取
```

### GREEN — service routing slice

Command:

```text
node --test tests/sku-replacement.test.mjs
```

Result: exit code 0; 15 tests, 15 passed, 0 failed.

### RED — batch and proxy boundary slice

Command:

```text
node --test tests/sku-replacement.test.mjs tests/fulfillment-dashboard-proxy.test.mjs
```

Result: exit code 1; 19 tests, 16 passed, 3 failed.

The focused failures demonstrated that `targetWarehouse` was missing at each intended boundary:

```text
SKU replacement plan proxy forwards only the normalized target warehouse
  forwarded body omitted targetWarehouse: '允许仓A'

SKU replacement batch proxy retains targets and rejects control characters
  forwarded selection omitted targetWarehouse: '允许仓A'

批量更换计划透传目标仓库并将其绑定到批量哈希
  createPlan received undefined; expected '允许仓A'
```

### Final GREEN

Required focused verification:

```text
node --test tests/sku-replacement.test.mjs tests/fulfillment-dashboard-proxy.test.mjs
```

Result: exit code 0; 19 tests, 19 passed, 0 failed.

Additional related regression verification:

```text
node --test tests/fulfillment-service.test.mjs
```

Result: exit code 0; 101 tests, 101 passed, 0 failed.

Syntax verification:

```text
node --check fulfillment-service/sku-replacement.mjs
node --check fulfillment-service/sku-replacement-batch.mjs
node --check fulfillment-service/server.mjs
node --check lib/fulfillment-dashboard-proxy.mjs
```

Result: all commands exited 0 with no output.

## Files

- `fulfillment-service/sku-replacement.mjs`
- `fulfillment-service/server.mjs`
- `fulfillment-service/sku-replacement-batch.mjs`
- `lib/fulfillment-dashboard-proxy.mjs`
- `tests/sku-replacement.test.mjs`
- `tests/fulfillment-dashboard-proxy.test.mjs`
- `.superpowers/sdd/2026-08-11-sku-replacement-warehouse-routing/task-2-report.md`

## Implementation summary

- Integrated `evaluateSkuWarehouseRoutes`, loading the union of current order warehouses and the shop's explicit replacement allowlist.
- Grouped matching replacement inventory by SKU across warehouse scopes, then attached the evaluator-selected route, ordered alternatives, and prospective final item set.
- Kept `KEEP_CURRENT` preferred by the Task 1 evaluator and allowed `MOVE_WHOLE_ORDER` only through the explicit shop allowlist.
- Added top-level hashed plan fields for `warehouseMode`, `targetWarehouse`, `warehouseAlternatives`, and `prospectiveItems`.
- Added exact whole-order warehouse confirmation text and rejected a requested target not present in the candidate alternatives.
- Configured `server.mjs` so `any_single_warehouse` resolves to no replacement move targets.
- Preserved optional target warehouses through batch/proxy plan boundaries, normalized surrounding whitespace, bounded length to 160 characters, rejected control characters, and left execution bodies target-free.

## Self-review

- Scope: only the six brief-listed source/test files plus this required report were changed.
- Routing safety: the existing pure evaluator remains the sole keep/move decision-maker; current Mabang auto-selection is not used as route truth.
- Allowlist safety: replacement moves use only `allowlist` policy warehouses; `any_single_warehouse` and missing policies resolve to `[]`.
- Hash integrity: direct mutation tests cover all four new plan fields; batch target changes produce different batch hashes.
- Compatibility: omitted/blank optional targets stay omitted through batch/proxy boundaries, and the prior fulfillment proxy suite remains green.
- Write safety: no live requests or Mabang writes were performed; tests use injected workers/fetchers only.

## Concerns

- Whole-order warehouse execution and final warehouse verification are intentionally deferred to Task 3. This task only carries and hashes the selected route; the injected `warehouseTransferService` is stored but not called here.
