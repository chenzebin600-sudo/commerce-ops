# Mabang Current SKU Change Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make backend SKU replacement submit the same fields as Mabang's current ordinary-SKU replacement UI.

**Architecture:** Keep the existing read-before-write and readback verification flow. Change only the request payload at the Mabang boundary from the retired `type=2` contract to the current `IsChangeWarehouse=1` and `isChangeOrderItemPrice=2` contract, and keep diagnostics derived from the exact submitted fields.

**Tech Stack:** Python `requests`, Python `unittest`, Node.js service wrapper tests.

## Global Constraints

- Do not issue another live SKU-changing request while implementing or testing.
- Preserve exact-SKU resolution, stale-plan checks, combination-SKU blocking, and readback verification.
- Never log credentials, cookies, or authorization headers.

---

### Task 1: Current Mabang ordinary-SKU request contract

**Files:**
- Modify: `scripts/mabang_order_source.py`
- Modify: `lib/mabang-worker-runner.mjs`
- Modify: `frontend/commerce-ops-vue/src/services/warehouse-transfer.ts`
- Modify: `frontend/commerce-ops-vue/src/services/sku-replacement-selection.ts`
- Test: `tests/test_mabang_fulfillment_safety.py`
- Test: `tests/mabang-worker-runner.test.mjs`
- Test: `tests/sku-replacement-selection.test.mjs`

**Interfaces:**
- Consumes: `MabangClient.change_order_item_sku(order_reference, item_id, original_sku, replacement_sku, expected_quantity, expected_warehouse, expected_stock_id='')`
- Produces: POST fields `{orderItemId, stockId, IsChangeWarehouse: '1', isChangeOrderItemPrice: '2'}` and diagnostics listing those exact fields.

- [x] **Step 1: Write failing request-contract and diagnostic tests.**
- [x] **Step 2: Verify both tests fail because production still emits or preserves `type=2`.**
- [x] **Step 3: Change only the Mabang request payload and diagnostic allowlists.**
- [x] **Step 4: Run focused Python and Node tests.**
- [x] **Step 5: Run the full Node suite with the configured Python runtime and review the diff.**
- [x] **Step 6: Preserve and display the current request fields in the operator diagnostic UI.**
