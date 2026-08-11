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

## Fix round: current-warehouse availability isolation

Review finding: loading allowlisted warehouse inventory made the product-metadata fallback eligible to supply the original SKU's current availability. Quantity evidence now comes exclusively from the row matching the item's current warehouse; the any-warehouse fallback remains only for the Chinese product name and classification metadata.

### RED

Command:

```text
node --test tests/sku-replacement.test.mjs tests/fulfillment-dashboard-proxy.test.mjs
```

Exact output:

```text
✔ SKU replacement plan proxy forwards only the normalized target warehouse (21.4672ms)
✔ SKU replacement batch proxy retains targets and rejects control characters (2.3543ms)
✔ SKU replacement execution proxy never accepts a target warehouse (1.0528ms)
✔ 仅推荐同仓同款的换色或更小规格 SKU (2.5322ms)
✔ 批量建议只拉取一次涉及仓库的完整库存 (7.8927ms)
✔ 替换预览优先保留当前仓并只从店铺白名单提供整单换仓路线 (6.449ms)
✔ 空店铺仓库白名单允许保留当前仓但不会产生整单换仓候选 (4.1144ms)
✖ 允许仓中的原 SKU 库存不能掩盖当前仓缺货 (3.9493ms)
✔ 库存不足的候选不会进入建议 (0.1893ms)
✔ 更换计划需精确确认、可从持久化记录恢复且只能执行一次 (7.4637ms)
✔ 更换计划绑定选定仓库、路线备选和预期商品集合 (4.6295ms)
✔ 单项更换失败会持久化马帮诊断 (7.6471ms)
✔ 批量更换计划拒绝同一商品行选择多个目标 SKU (1.4461ms)
✔ 批量更换计划保留有效项并记录逐项预验证失败 (3.9729ms)
✔ 批量更换计划透传目标仓库并将其绑定到批量哈希 (7.0738ms)
✔ 批量 SKU 执行要求精确确认且同一计划只能创建一个任务 (9.6922ms)
✔ 批量 SKU 执行拒绝内容被篡改的持久化计划 (5.449ms)
✔ 批量 SKU 串行执行且单项失败后继续后续项目 (44.8099ms)
✔ an uncertain SKU write is persisted as manual review and is not retried (14.3769ms)
✔ 服务重启会把状态不确定项标记为人工核对且不重放待执行项 (4.8268ms)
ℹ tests 20
ℹ suites 0
ℹ pass 19
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 320.1912

✖ failing tests:

test at tests\sku-replacement.test.mjs:124:1
✖ 允许仓中的原 SKU 库存不能掩盖当前仓缺货 (3.9493ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

  50 !== 0

      at TestContext.<anonymous> (file:///D:/znwx-ai/.worktrees/sku-warehouse-routing/tests/sku-replacement.test.mjs:129:10)
```

Result: exit code 1.

### GREEN

Command:

```text
node --test tests/sku-replacement.test.mjs tests/fulfillment-dashboard-proxy.test.mjs
```

Exact output:

```text
✔ SKU replacement plan proxy forwards only the normalized target warehouse (20.5195ms)
✔ SKU replacement batch proxy retains targets and rejects control characters (1.4479ms)
✔ SKU replacement execution proxy never accepts a target warehouse (0.7205ms)
✔ 仅推荐同仓同款的换色或更小规格 SKU (3.0914ms)
✔ 批量建议只拉取一次涉及仓库的完整库存 (7.9368ms)
✔ 替换预览优先保留当前仓并只从店铺白名单提供整单换仓路线 (4.932ms)
✔ 空店铺仓库白名单允许保留当前仓但不会产生整单换仓候选 (5.161ms)
✔ 允许仓中的原 SKU 库存不能掩盖当前仓缺货 (6.5329ms)
✔ 库存不足的候选不会进入建议 (0.1849ms)
✔ 更换计划需精确确认、可从持久化记录恢复且只能执行一次 (8.5285ms)
✔ 更换计划绑定选定仓库、路线备选和预期商品集合 (4.9333ms)
✔ 单项更换失败会持久化马帮诊断 (11.3432ms)
✔ 批量更换计划拒绝同一商品行选择多个目标 SKU (1.1024ms)
✔ 批量更换计划保留有效项并记录逐项预验证失败 (3.8197ms)
✔ 批量更换计划透传目标仓库并将其绑定到批量哈希 (5.2993ms)
✔ 批量 SKU 执行要求精确确认且同一计划只能创建一个任务 (9.3919ms)
✔ 批量 SKU 执行拒绝内容被篡改的持久化计划 (5.6016ms)
✔ 批量 SKU 串行执行且单项失败后继续后续项目 (44.1513ms)
✔ an uncertain SKU write is persisted as manual review and is not retried (17.3046ms)
✔ 服务重启会把状态不确定项标记为人工核对且不重放待执行项 (4.8843ms)
ℹ tests 20
ℹ suites 0
ℹ pass 20
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 328.2746
```

Result: exit code 0.

### Fix-round self-review

- The quantity path has no any-warehouse fallback in either preview or plan creation.
- The metadata fallback is retained, so a missing current-warehouse row does not lose the product name needed for same-product/color/spec classification.
- The regression covers both public outcomes: preview reports `available: 0` and exposes the move candidate; plan creation succeeds for an allowlisted target.

### Final fix-round verification

Command:

```text
node --test tests/sku-replacement.test.mjs tests/fulfillment-dashboard-proxy.test.mjs
```

Exact output after final self-review adjustment:

```text
✔ SKU replacement plan proxy forwards only the normalized target warehouse (28.0709ms)
✔ SKU replacement batch proxy retains targets and rejects control characters (1.9007ms)
✔ SKU replacement execution proxy never accepts a target warehouse (0.8825ms)
✔ 仅推荐同仓同款的换色或更小规格 SKU (2.8616ms)
✔ 批量建议只拉取一次涉及仓库的完整库存 (17.8747ms)
✔ 替换预览优先保留当前仓并只从店铺白名单提供整单换仓路线 (5.1938ms)
✔ 空店铺仓库白名单允许保留当前仓但不会产生整单换仓候选 (6.5175ms)
✔ 允许仓中的原 SKU 库存不能掩盖当前仓缺货 (8.3955ms)
✔ 库存不足的候选不会进入建议 (0.2149ms)
✔ 更换计划需精确确认、可从持久化记录恢复且只能执行一次 (10.9759ms)
✔ 更换计划绑定选定仓库、路线备选和预期商品集合 (6.1666ms)
✔ 单项更换失败会持久化马帮诊断 (9.7757ms)
✔ 批量更换计划拒绝同一商品行选择多个目标 SKU (1.2723ms)
✔ 批量更换计划保留有效项并记录逐项预验证失败 (4.9932ms)
✔ 批量更换计划透传目标仓库并将其绑定到批量哈希 (5.6852ms)
✔ 批量 SKU 执行要求精确确认且同一计划只能创建一个任务 (10.8543ms)
✔ 批量 SKU 执行拒绝内容被篡改的持久化计划 (7.7741ms)
✔ 批量 SKU 串行执行且单项失败后继续后续项目 (49.7389ms)
✔ an uncertain SKU write is persisted as manual review and is not retried (18.3448ms)
✔ 服务重启会把状态不确定项标记为人工核对且不重放待执行项 (5.7808ms)
ℹ tests 20
ℹ suites 0
ℹ pass 20
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 392.8384
```

Result: exit code 0.
