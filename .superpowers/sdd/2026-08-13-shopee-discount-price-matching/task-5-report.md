# Task 5 report: preview, immutable approval and API module

## Status

Implemented Task 5 with local fixtures and a real temporary SQLite repository/Foundation service. No live Shopee or warehouse request, platform write, configured credential use, or external database write was performed.

## Delivered

- `ShopeeDiscountService` exposes the requested small operations for status, shops, preview creation/detail/item paging, immutable approval, execution enqueueing, runs, activities, issues and manual scans.
- Preview input is exact-schema validated. Country/shop authorization, explicit default scope, tier/workflow values, nested override schemas, duplicate/conflicting overrides and override scope are fail-closed.
- The preview pipeline pages active listings, keeps zero-stock variants, filters inactive item/model states, shares warehouse results by normalized SKU, validates warehouse snapshots through Task 3 and prices through Task 1.
- Per-variant fallback uses each variant's original price. Abnormal targets, duplicate normalized SKUs, external activities without a declared tier, overlapping Discounts and near-end newly active items are isolated without blocking unrelated variants.
- Overlap issues persist bounded safe evidence containing the original Discount identity and time. Preview summaries contain counts/codes only; item payloads are returned solely through bounded cursor paging.
- Ready items are sorted deterministically, appended in immutable shards using Task 2, sealed with the Task 1 approval root, and bound to a Foundation plan carrying the same Merkle root. A Foundation bind failure leaves a non-approvable `BLOCKED` domain plan.
- SQLite enforces the one-shop/ten-variant pilot limit before persistence; PostgreSQL uses the repository's production-scale mode and provider-neutral bounded read queries.
- Approval requires the exact root, confirmation text, `PREVIEWED` state, current policy and unexpired TTL. Identical repeats are idempotent; changes to root, text, operator label or trusted actor identity fail.
- Separate-identity mode requires a privileged identity supplied by trusted server context and a final approval object binding plan/root/policy/expiry. Ordinary body/header values cannot create that trusted identity.
- Execution revalidates approval, root, TTL, policy, write security, whitelist and per-shop batch limits, then creates one deterministic durable `PENDING` job. Concurrent/repeated requests reuse the same job and invoke zero Shopee writes.
- `createShopeeDiscountApi` owns only fixed `/api/shopee-discount/*` routes, bounded JSON/query parsing, method/body/schema rejection, safe stable error mapping and safe audit annotations.
- `server.mjs` registers one module handler using the existing data access, Foundation, Shopee token, injected read adapter and fail-closed warehouse/write-security configuration. No network operation occurs during composition/startup.

## TDD evidence

Service RED began with `ERR_MODULE_NOT_FOUND` for `lib/shopee-discount/service.mjs`. Each subsequent regression was observed failing before its implementation, including near-end age isolation, trusted actor binding, exact-expiry rejection, concurrent execution deduplication, override scope, Foundation failure blocking and persisted overlap evidence.

API RED began with `ERR_MODULE_NOT_FOUND` for `lib/shopee-discount/api.mjs`. Fixed routes, method/body/query bounds, route/body plan binding, trusted-context derivation and safe error/audit behavior were then implemented to GREEN.

Fresh required verification:

```powershell
node --check lib/shopee-discount/service.mjs
node --check lib/shopee-discount/api.mjs
node --check server.mjs
node --test tests/shopee-discount-service.test.mjs tests/shopee-discount-api.test.mjs tests/app-access.test.mjs
```

Result: 30 passed, 0 failed.

Fresh complete Shopee Discount verification:

```powershell
$taskTests = Get-ChildItem -Path tests -Filter 'shopee-discount-*.test.mjs' | Sort-Object Name | Select-Object -ExpandProperty FullName
node --test $taskTests
```

Result: 101 passed, 0 failed.

## Concerns and deployment prerequisites

- Production warehouse preview remains fail-closed unless `SHOPEE_DISCOUNT_WAREHOUSE_BASE_URL` is HTTPS and an encrypted warehouse key is configured. Vault-reference resolution is not invented in this task.
- Real writes remain disabled unless Task 4's complete deployment security contract passes. In separate-identity mode, trusted middleware still must supply the privileged server context; client headers and bodies are intentionally ignored.
- Scale behavior is provider-neutral, but Task 5's real-repository behavioral suite is SQLite as required. PostgreSQL adapter/provider contracts remain covered by the complete Shopee Discount suite without contacting a live database.
- The pre-existing unrelated `server.mjs` startup-policy edit and all other dirty workspace files were preserved outside this task's staged patch.
