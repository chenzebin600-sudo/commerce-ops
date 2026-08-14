# Shopee Empty Preview Overlap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent zero-variant previews from occupying a Shopee Discount activity window.

**Architecture:** Reject empty legacy previews before plan creation. In the production streaming path, cancel the recoverable `PREVIEWING` draft under its owner fence before returning a workflow-specific error message.

**Tech Stack:** Node.js, SQLite/PostgreSQL repository contracts, Vue 3 error display, `node:test`.

## Global Constraints

- Do not call live Shopee write endpoints.
- Preserve non-empty preview behavior.
- Keep cancelled empty drafts auditable but inactive.

---

### Task 1: Empty preview lifecycle

**Files:**
- Modify: `tests/shopee-discount-service.test.mjs`
- Modify: `lib/shopee-discount/service.mjs`

**Interfaces:**
- Consumes: `ShopeeDiscountService.createPreview(input, context)` and repository plan state transitions.
- Produces: `SHOPEE_DISCOUNT_NO_ACTIVE_VARIANTS` with no active target-window overlap.

- [x] **Step 1: Write failing tests** for legacy rejection and production draft cancellation followed by a successful same-shop renewal preview.
- [x] **Step 2: Run the focused service tests** and verify both new assertions fail because an empty plan currently reaches `PREVIEWED`.
- [x] **Step 3: Add the minimal lifecycle guard** before legacy plan creation and before production metadata/Foundation sealing.
- [x] **Step 4: Run focused and full Shopee Discount tests** and confirm zero failures.
- [x] **Step 5: Verify the original live overlap query** still reports no active plans for the repaired shop.

### Task 2: Official model status compatibility

**Files:**
- Modify: `tests/shopee-discount-service.test.mjs`
- Modify: `lib/shopee-discount/service.mjs`

**Interfaces:**
- Consumes: Shopee `get_model_list` payloads containing `model_status: "MODEL_NORMAL"`.
- Produces: an active preview variant with its SKU, price, and stock preserved.

- [x] **Step 1: Add a failing service test** using a literal `MODEL_NORMAL` model fixture and assert that a renewal preview contains one item.
- [x] **Step 2: Run the focused test** and verify it fails with `SHOPEE_DISCOUNT_NO_ACTIVE_VARIANTS`.
- [x] **Step 3: Extend active-status normalization** to accept `MODEL_NORMAL` without accepting unknown statuses.
- [x] **Step 4: Run the service and Shopee Discount suites**, then reproduce the selected live shop preview through the local API.

### Task 3: Match the deployed warehouse relay contract

**Files:**
- Modify: `tests/shopee-discount-warehouse.test.mjs`
- Modify: `lib/shopee-discount/warehouse-client.mjs`
- Modify: `lib/shopee-discount/warehouse-validator.mjs`

- [x] **Step 1: Reproduce the live failures** caused by the 5-second timeout, country price scale, differing row/source watermarks, and `引流款` control classification.
- [x] **Step 2: Add RED tests** for each deployed response shape and exact multi-SKU routing.
- [x] **Step 3: Implement bounded 60-second reads**, exact per-SKU queries with request-local reuse, site minor-unit scales, source-watermark normalization, and nonempty control classifications.
- [x] **Step 4: Verify focused suites** and a real read-only preview for shop `1603295665`.
