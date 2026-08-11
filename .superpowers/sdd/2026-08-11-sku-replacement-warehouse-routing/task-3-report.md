# Task 3 Report: Two-phase execution and final SKU-plus-warehouse verification

## Status

Completed with strict RED/GREEN TDD. No live Mabang request or write was performed.

## Implemented behavior

- The outer SKU plan is consumed before inventory revalidation and before either write can start.
- Pre-write replacement inventory is revalidated at the hashed target warehouse, which supports both `KEEP_CURRENT` and `MOVE_WHOLE_ORDER` plans.
- After the single confirmed `order-sku-change`, the order is independently re-inspected and the selected line must contain the target SKU.
- When every active line is already at the hashed target warehouse, warehouse transfer is skipped.
- Otherwise execution calls only the injected warehouse service's public contracts:
  - `preview({ orderReference, targetWarehouse })`
  - `execute({ planHash, approvalText })` using the exact values returned by preview.
- After warehouse execution, the order is independently re-inspected again. Success requires the selected line to retain the target SKU and all active lines to resolve to exactly one warehouse equal to the hashed target.
- Completed results now include `result.warehouseRouting` with `mode`, `targetWarehouse`, `transferSkipped`, and `finalWarehouses`.
- Every failure after a confirmed SKU write is converted to `SKU_REPLACEMENT_WAREHOUSE_VERIFY_FAILED`, persisted as `MANUAL_REVIEW`, and carries phase-safe diagnostics. Raw dependency diagnostics and raw messages are not copied.
- Neither SKU nor warehouse writes are retried, and no SKU rollback path exists.
- Batch execution continues serially after warehouse verification uncertainty. Its existing `/_VERIFY_FAILED$/` classification already covered the new code, so no production edit to `sku-replacement-batch.mjs` was necessary.
- `server.mjs` already injected the shared `warehouseTransferService` from Task 2, so no additional wiring edit was necessary.

## TDD evidence

### RED

Command:

```text
node --test tests/sku-replacement.test.mjs
```

Observed exit code: `1`.

Observed summary:

```text
tests 22
pass 17
fail 5
```

The five new execution tests failed for the expected missing behavior:

1. Whole-order routing stopped at `SKU_REPLACEMENT_INVENTORY_CHANGED` because execution revalidated only the original warehouse.
2. The `KEEP_CURRENT` auto-hop test observed no warehouse preview.
3. The already-at-target test observed no post-SKU order inspection.
4. Warehouse-failure translation observed `SKU_REPLACEMENT_INVENTORY_CHANGED` instead of `SKU_REPLACEMENT_WAREHOUSE_VERIFY_FAILED`.
5. Final mixed-warehouse verification observed `SKU_REPLACEMENT_INVENTORY_CHANGED` instead of the required verification failure.

### GREEN

Targeted command after implementation:

```text
node --test tests/sku-replacement.test.mjs
```

Observed exit code: `0`.

Observed summary:

```text
tests 22
pass 22
fail 0
```

Required cross-service verification command:

```text
node --test tests/sku-replacement.test.mjs tests/warehouse-transfer.test.mjs
```

Observed exit code: `0`.

Observed summary:

```text
tests 30
pass 30
fail 0
```

## Call-sequence coverage

The transfer-required success test asserts the exact observable sequence:

```text
order-sku-change
order-warehouse-inspect
warehouse-preview
warehouse-execute
order-warehouse-inspect
```

It also asserts that warehouse preview receives the order reference and hashed target warehouse, warehouse execute receives the preview's exact `planHash` and `approvalText`, and the completed routing result reports the planned mode/target, `transferSkipped: false`, and the final single warehouse.

Separate tests cover:

- Mabang auto-hopping a `KEEP_CURRENT` replacement and transfer back to the original warehouse.
- An already-at-target readback that performs no warehouse preview or execute.
- A warehouse write uncertainty after confirmed SKU change, with one SKU write, one warehouse write attempt, no retry, no rollback, sanitized diagnostics, and persisted manual review.
- A final mixed-warehouse readback that fails verification.
- Batch manual-review classification for `SKU_REPLACEMENT_WAREHOUSE_VERIFY_FAILED` while a later serial item still completes.

## Files changed

- `fulfillment-service/sku-replacement.mjs`
  - Added post-write state inspection, public warehouse-service orchestration, final verification, routing result metadata, and sanitized phase diagnostics.
  - Revalidated replacement inventory at the plan's target warehouse.
- `tests/sku-replacement.test.mjs`
  - Added RED/GREEN execution, reconciliation, skip, failure, mixed-warehouse, call-order, and batch-continuation coverage.
  - Updated the existing one-shot execution fixture to supply the now-required confirmed readback.
- `.superpowers/sdd/2026-08-11-sku-replacement-warehouse-routing/task-3-report.md`
  - This report.

## Self-review

- Scope: only the permitted SKU replacement source/test files plus this required report changed.
- Safety: the implementation delegates all warehouse planning and execution to `WarehouseTransferService`; it does not call the warehouse worker write action directly or bypass inventory/policy/hash/approval checks.
- Write cardinality: each execution path contains one SKU write call and at most one warehouse execute call; tests assert no repeat call.
- Irreversibility: no automatic SKU rollback was introduced.
- Verification boundary: Mabang's automatic post-SKU warehouse is treated only as a readback, never as the plan source of truth.
- Final invariant: selected replacement SKU plus one hashed target warehouse across all active lines is required before success.
- Diagnostics: only bounded phase flags, target/observed SKU and warehouse state, and a validated uppercase error code are persisted; nested dependency diagnostics and raw error messages are discarded.
- Buyer-facing Shopee order data remains outside this flow and unchanged.
- `git diff --check` reported no whitespace errors before final verification.

## Concerns

No known correctness concern remains in the scoped implementation. Per the task constraint, verification used deterministic service doubles and did not exercise live Mabang; production integration therefore still relies on the already-tested public warehouse transfer contracts and existing worker response shapes.

## Review-fix evidence

The Task 3 review findings were verified against commit `a7e8d8c` before production edits:

- The already-at-target branch returned from the first post-SKU readback instead of performing an independent final inspection.
- Final warehouse success was inferred from the deduplicated non-empty warehouse list, allowing an active line with a blank warehouse to disappear from validation.
- `warehousePreviewAttempted` was set before confirming that a warehouse service existed and before invoking `preview`.

### Review-fix RED

Command:

```text
node --test tests/sku-replacement.test.mjs
```

Observed exit code: `1`.

Exact summary:

```text
tests 24
pass 21
fail 3
cancelled 0
skipped 0
todo 0
```

Exact regression failures:

```text
SKU 写入后已经整单位于目标仓会跳过仓库写入
  expected: [order-sku-change, order-warehouse-inspect, order-warehouse-inspect]
  actual:   [order-sku-change, order-warehouse-inspect]

最终复核要求每个活动商品行都有精确目标仓库
  Missing expected rejection.

换仓服务不可用时诊断不会声称已经调用预览
  true !== false
```

### Review-fix implementation

- Both branches now converge on one independent `FINAL_VERIFY` inspection after the conditional warehouse transfer.
- `verifiedOrderState` now requires every active line to have a non-empty `warehouseKey` equal to the hashed target; `finalWarehouses` remains diagnostic/result metadata only.
- `warehousePreviewAttempted` is set immediately before `preview(...)`, after validating that the injected service exists.
- The already-at-target sequence is now exactly `order-sku-change`, `order-warehouse-inspect`, `order-warehouse-inspect`, with no warehouse preview or execute.

### Review-fix GREEN

Focused SKU command after the fix:

```text
node --test tests/sku-replacement.test.mjs
```

Observed exit code: `0`; exact summary: `tests 24`, `pass 24`, `fail 0`.

Required final command:

```text
node --test tests/sku-replacement.test.mjs tests/warehouse-transfer.test.mjs
```

Observed exit code: `0`.

Exact final summary:

```text
tests 32
pass 32
fail 0
cancelled 0
skipped 0
todo 0
duration_ms 484.9627
```

The combined run explicitly reported all three new regressions as passing:

```text
✔ SKU 写入后已经整单位于目标仓会跳过仓库写入 (10.0581ms)
✔ 最终复核要求每个活动商品行都有精确目标仓库 (11.5511ms)
✔ 换仓服务不可用时诊断不会声称已经调用预览 (9.4879ms)
```
