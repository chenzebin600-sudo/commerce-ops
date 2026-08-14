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

- [ ] **Step 1: Write failing tests** for legacy rejection and production draft cancellation followed by a successful same-shop renewal preview.
- [ ] **Step 2: Run the focused service tests** and verify both new assertions fail because an empty plan currently reaches `PREVIEWED`.
- [ ] **Step 3: Add the minimal lifecycle guard** before legacy plan creation and before production metadata/Foundation sealing.
- [ ] **Step 4: Run focused and full Shopee Discount tests** and confirm zero failures.
- [ ] **Step 5: Verify the original live overlap query** still reports no active plans for the repaired shop.
