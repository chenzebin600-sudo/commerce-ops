# Product Center interaction, soft delete, and AI content framework

## 1. Import page simplification

The product package import flow still preserves the fixed-field mapping, validation, streaming parser, raw values, raw types, normalized values, row evidence, and automated tests. The page now presents the operational decision first:

1. Upload the workbook.
2. Parse and validate it.
3. Review the import summary.
4. Inspect field changes when needed.
5. Confirm the import.
6. Review the result in import history.

The visible summary contains the filename, worksheet, source row count, importable row count, added/updated/unchanged counts, changed-field count, reminder count, blocker count, full SHA-256, and parse duration. A zero-blocker batch is labelled `可以导入`. Blockers remain directly accessible; reminders, field changes, field mapping, and row-level parser evidence use separate disclosures. Field mapping and parsed rows are under the closed `查看技术信息` disclosure by default.

No product package row, mapping rule, normalization rule, or import transaction behavior was removed.

## 2. Detail, edit, and AI responsibilities

| Surface | Responsibility | Persistence |
|---|---|---|
| Detail drawer | Read-only facts, packaging, warehouse inventory, images, source/manual differences, confirmed AI content, and source evidence | No writes |
| Product information editor | Explicit human corrections and clearing an existing correction | `product_field_overrides` and its change events |
| Product images editor | Human-managed product images | Existing image metadata and managed file layer |
| AI selling-points editor | Generate, review, copy, edit, save a draft, confirm, and inspect history | `product_ai_contents` only after an explicit save or confirm |

The detail drawer has no input, textarea, or select controls. Editing never changes `product_package_rows`. Re-importing the source workbook updates source facts while an active manual override remains the effective displayed value. Clearing an override restores the latest source value.

## 3. Delete and restore rules

The product identity remains one `country + SKU` record in `product_skus`. Deleting a product affects only that record ID. It does not cascade to the same SKU in another country or remove individual warehouse facts.

Before deletion, the confirmation dialog shows:

- Chinese product name, SKU, and country
- level-one and level-two categories
- associated warehouse count and image count
- whether manual overrides exist
- whether AI content exists
- the effect on normal search results and retained history

The optional reason is limited to 500 characters. Delete and restore operations are audited with the product ID, country, SKU, result, operator context, and bounded reason where applicable.

The list excludes deleted products by default. A session with `product.restore` can filter for normal, deleted, or all products and restore a deleted record. Restoration reveals the original overrides, images, and AI history again.

## 4. Soft-delete data structure

Migration `010_product_catalog_soft_delete_ai_content.sql` adds these columns to `product_skus`:

- `deleted_at`
- `deleted_by`
- `delete_reason`
- `restored_at`
- `restored_by`

Index `idx_product_skus_deleted` supports normal/deleted listing by delete state, country, and normalized SKU. Soft deletion does not delete:

- `product_package_rows`
- import batches, imported rows, issues, or field changes
- `product_field_overrides` or override events
- product images or managed files
- `product_ai_contents`

The `product_ai_contents.product_sku_id` foreign key uses `ON DELETE RESTRICT` as an additional guard against physical product deletion.

## 5. Permission model

The product access policy defines:

- `product.view`
- `product.edit`
- `product.delete`
- `product.restore`
- `product.ai.generate`
- `product.ai.confirm`
- `product.ai.view_history`

Permissions are independent. For example, edit does not imply delete, and AI generation does not imply confirmation. The policy is enforced by the backend and used by the frontend only to hide unavailable actions.

All product operations also obey optional country, level-one category, and level-two category scopes. List queries are scoped server-side; item operations load the product and enforce the same scope before acting.

## 6. AI module page structure

The third edit tab is `AI卖点与场景`. It automatically receives the current effective product context and allows the operator to provide:

- target platform: Shopee, Lazada, TikTok Shop, or general ecommerce
- target country and output language
- target users and positioning
- content style
- selling-point and scenario counts, each limited to 1-10
- special requirements and prohibited content

Actions are Generate/Regenerate, Cancel wait, Copy all, Copy one selling point, Copy one scenario, edit generated content, Save draft, Confirm, and View history.

Generated content exists only in page memory until Save draft or Confirm is explicitly selected. Closing the dialog without saving does not write AI content.

## 7. DeepSeek configuration

The backend reads:

```env
DEEPSEEK_API_KEY=
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4
```

`DEEPSEEK_API_KEY` must be set only in the ignored local `.env` or the deployment secret manager. The base URL resolver accepts either the service root or a complete chat-completions endpoint. The selected model and prompt version are exposed as non-secret status metadata so the page can explain what will be used.

When the key is absent, the module remains visible, generation is disabled, and the page displays exactly:

`尚未配置 DeepSeek API Key，请联系管理员完成配置。`

## 8. API key security

- The browser never calls DeepSeek directly.
- The key is not returned by status, generate, content, or history APIs.
- The key is not stored in localStorage, sessionStorage, cookies, IndexedDB, product tables, or audit events.
- The example environment file contains no real credential.
- Provider errors redact bearer credentials before they can reach application errors.
- Product AI audit events record bounded identifiers and status, not prompts, generated content, product facts, or credentials.

## 9. AI request and response contract

The browser sends generation options only to:

`POST /api/product-center/products/:productId/ai/generate`

The service builds the factual product context on the server, including effective product name, SKU, country, categories, style, sales specification, dimensions, weights, material when available, lifecycle status, image metadata, source fields, and manual overrides.

DeepSeek must return one JSON object with:

```json
{
  "product_summary": "One-sentence summary",
  "target_users": ["User group"],
  "user_pain_points": ["Pain point"],
  "selling_points": [
    { "title": "Title", "description": "Explanation", "source_field": "Evidence field" }
  ],
  "usage_scenarios": [
    { "scene": "Scene", "user": "User", "benefit": "Benefit" }
  ],
  "feature_benefit_map": [
    { "feature": "Feature", "benefit": "Benefit" }
  ],
  "risk_notes": ["Missing evidence or required manual confirmation"]
}
```

The response parser rejects empty, oversized, non-JSON, and schema-incomplete responses. The prompt prohibits invented functions, certifications, materials, dimensions, load ratings, warranties, inventory, sales, power, and platform guarantees. Unsupported claims belong in `risk_notes`.

## 10. `product_ai_contents`

The new table stores versioned AI content independently from product source facts and human overrides.

| Field group | Purpose |
|---|---|
| Identity | `id`, `product_sku_id`, `country`, `sku`, `content_type` |
| Model provenance | `provider`, `model`, `prompt_version`, `request_id` |
| Evidence and output | `input_context_json`, `output_content_json` |
| Lifecycle | `status`, `version`, `confirmed_at`, `confirmed_by`, `archived_at` |
| Audit | `created_by`, `created_at`, `updated_at` |

`status` is constrained to `draft`, `confirmed`, or `archived`. A product/content-type/version tuple is unique. Indexes support latest status/version lookup and country/SKU history lookup.

## 11. AI version rules

- Every explicit save creates the next version.
- Drafts do not replace the current confirmed version.
- Confirming content archives the previous confirmed version in the same transaction.
- The detail drawer displays only the latest confirmed version.
- History is read-only and ordered newest first.
- Confirming a saved draft retains its identity and version.
- AI versions never update source rows or manual overrides.

## 12. Prompt version management

The prompt is centralized in `lib/product-center/product-ai-prompt.mjs` with version `product-selling-points-v1`. The version is included in the request instruction and stored with every saved AI record. Future prompt changes must receive a new version, preserving the interpretation of historical content.

## 13. Error handling

The framework handles:

- missing API key: visible module, disabled generation, stable public message
- concurrent clicks for the same product: `PRODUCT_AI_GENERATION_IN_PROGRESS`
- browser cancellation and provider timeout
- provider networking, rate limiting, and server errors
- empty response and responses over 512 KiB
- non-JSON and missing/invalid JSON fields
- a failed generation without overwriting the last successful in-memory result
- validation before any draft or confirmed content is persisted

The API returns bounded public error codes/messages. Secrets, prompts, full product facts, and generated output are excluded from logs and audit metadata.

## 14. Test and runtime results

On 2026-07-21:

- Existing and updated full suite: **368 passed, 0 failed**
- New node test file: **25 passed, 0 failed**
- Frontend build/static validation: **passed** (`321` unique element IDs, `185` static bindings)
- Doctor: **passed** for runtime, dependencies, worker, advertising service, SQLite, storage, Chrome, access policy, and ports
- SQLite `PRAGMA integrity_check`: **ok**
- SQLite foreign-key violations: **0**
- Product business row counts before/after migration: unchanged
- Main health endpoint: `GET /api/health` returned `{"ok":true}`
- Main service: port `3101`; advertising service remained isolated on loopback port `4173`

The formal database contains 18,347 product SKU rows and zero AI-content rows at delivery time. No product was deleted and no real AI generation was triggered during browser regression.

## 15. Browser verification and screenshots

The page was exercised with an installed Chrome browser at 1440x1000. Regression verified:

- product list: 18,347 SKUs, server pagination, Detail/Edit/Delete ordering
- detail drawer: zero editable controls
- editor: Product Information, Product Images, and AI Selling Points/Scenarios tabs
- delete confirmation: complete country+SKU impact summary; cancelled without a write
- import summary: operational summary visible; technical details closed by default
- network recheck: no 4xx/5xx response reproduced

Screenshots are runtime artifacts excluded from Git:

- `storage/ui-check/product-center-catalog.png`
- `storage/ui-check/product-center-detail.png`
- `storage/ui-check/product-center-edit-ai.png`
- `storage/ui-check/product-center-delete-confirm.png`
- `storage/ui-check/product-center-import-summary.png`

The in-app browser bridge was unavailable because its bundled runtime could not initialize in this session. The same local page was therefore verified through the installed Chrome executable using the bundled Playwright automation package; this does not change the tested application path or browser engine.
