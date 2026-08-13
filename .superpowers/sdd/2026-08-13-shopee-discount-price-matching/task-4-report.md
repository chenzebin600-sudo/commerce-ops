# Task 4 report: Shopee read/write adapters and console lockdown

## Status

Implemented the Task 4 scope with local fixtures only. No live Shopee call, network lookup, credential use, or platform write was performed.

## Delivered behavior

- Locked `POST /api/shopee-console/call` to exact `method: "GET"` and a named allowlist containing the five Task 4 product/Discount GET paths plus the existing tested `/api/v2/shop/get_shop_info` read path.
- Rejects malformed JSON, oversized bodies, unknown envelope fields, missing/alternate methods, absolute URLs, query-bearing paths, encoded paths, path-normalization attempts, and non-allowlisted paths before `fetch`.
- Rebuilds the relay envelope from validated `shop_id`, `api_path`, `method`, and `params`; the raw browser body is never forwarded.
- Added `ShopeeReadAdapter` with only the six fixed public operations. It validates canonical string IDs, documented pagination/list bounds, Discount statuses and 30-day update windows, normalizes request IDs/contracts, and classifies stable auth/rate/business/unavailable/malformed errors.
- Read retries are injected and bounded. Only explicit safe transient conditions (`429`, `5xx`/`SHOPEE_UNAVAILABLE`, abort, reset, refusal, timeout) may retry; auth, business, malformed contracts, and unclassified transport failures do not.
- Added `ShopeeWriteAdapter` with only create/add/update operations and fixed official paths/schemas. The transport is injected and credential-bound; callers cannot provide a token, relay URL, method, path, arbitrary body, or retry count.
- Write payload validation rejects unknown fields, invalid UUID/request IDs, non-canonical IDs/prices, invalid PM activity names/timestamps, empty/oversized lists, invalid stocks/limits, duplicate item identities, and duplicate model identities before dispatch.
- Minor-unit strings are range/step checked using `BigInt` and formatted at the injected site scale without JavaScript floating-point arithmetic.
- Every write dispatch is single-attempt. Timeout, reset, response loss, malformed/incomplete response, 429, and 5xx become `SHOPEE_WRITE_UNKNOWN` with only the original operation UUID and a safe request ID. Definite auth/business responses use stable redacted errors.
- Added fail-closed `resolveShopeeWriteSecurity` / `assertShopeeWriteAuthorized` behavior for `trusted_single_role` and `separate_execute_identity`, protected real-write switch, attestation, listener topology, whitelists/caps, privileged approval+execution, HTTPS/mTLS or fully bound signed HTTP, and replay cache declaration. `safeStatus` contains only booleans, mode, and reason codes.

## TDD evidence

RED observations were made before each implementation slice:

1. Console forbidden method/path tests failed because the existing proxy forwarded them and returned `503` from the local fake instead of rejecting with `400`.
2. Read-adapter tests first failed with `ERR_MODULE_NOT_FOUND` for `shopee-read-adapter.mjs`.
3. Fixed-surface, batch-validation, retry, stable classification, malformed-contract, and input-validation slices each failed on the absent behavior before their minimal implementation.
4. Write-adapter tests first failed with `ERR_MODULE_NOT_FOUND` for `shopee-write-adapter.mjs`.
5. Write schema mapping, exact fixed-point formatting, zero-retry UNKNOWN classification, redacted definite failures, duplicate/bounds/schema validation, and pre-send validation slices each failed before implementation.
6. Write-security tests first failed with `ERR_MODULE_NOT_FOUND` for `write-security.mjs`; both mode matrices and fail-closed branches then failed before implementation.

GREEN command:

```powershell
node --test tests/shopee-console-proxy.test.mjs tests/shopee-discount-shopee-adapter.test.mjs tests/shopee-discount-write-security.test.mjs
```

The pre-report combined run passed 28 tests with 0 failures. The fresh final syntax and combined test run passed 29 tests with 0 failures.

## Local official snapshot facts used

- `get_item_list`: `page_size` maximum 100.
- `get_item_base_info`: `item_id_list` maximum 50.
- `get_discount_list`: `page_size` maximum 100 and update-time range maximum 30 days.
- `update_discount_item`: maximum 50 items.
- `add_discount`: starts at least one hour after now, ends at least one hour after start, duration less than 180 days.
- Request fields and fixed paths for all eight product/Discount endpoints were taken from `frontend/commerce-ops-vue/public/data/shopee-official-docs.generated.json`.

## Relay/capability gaps and conservative gates

- The local snapshot does not state a maximum for `add_discount_item`; the adapter therefore requires an injected `maxAddItems` capability and fail-closes above 50.
- The local snapshot does not state a maximum for `get_discount` detail `page_size`; the adapter conservatively caps it at 100.
- The endpoint snapshot does not provide per-site price scale, minimum, maximum, or step. The write adapter requires those as validated injected site capabilities and will not infer them.
- The repository's current default relay URL is plain HTTP, and the inspected local code/docs do not prove relay mTLS, complete request signing, short clock-window enforcement, nonce replay cache, or signed responses. `resolveShopeeWriteSecurity` therefore leaves writes disabled unless HTTPS/mTLS or the complete signed-request/replay capability is explicitly declared. Relay-side signing/replay enforcement still has to exist outside this adapter; a declaration alone is not an implementation.
- No Shopee idempotency guarantee was found for these POST endpoints. The adapter performs zero automatic write retries; UNKNOWN must be reconciled by the later executor/reconciliation tasks.
