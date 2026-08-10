---
memory_type: permanent
canonical_scope: user
updated_at: 2026-08-08
---

# Permanent Memory

Only stable attributes belong here. Project status, branch names, ports, test
counts, temporary decisions, and daily progress belong elsewhere.

## Identity And Context

<!-- fact-id: user.role.commerce-ops-owner -->
- The user is the product and business decision-maker for Commerce Ops and uses
  Codex as a long-running engineering collaborator.

<!-- fact-id: user.business.cross-border-commerce -->
- The user's operating context is cross-border ecommerce across multiple
  countries, stores, warehouses, categories, and the Shopee, Lazada, and TikTok
  platforms.

## Business Terms

<!-- fact-id: term.own-performance -->
- `Our performance` means sales facts from the stores managed by the user's
  team, derived from order data under an explicitly confirmed valid-order rule.

<!-- fact-id: term.assortment-performance -->
- `Assortment performance` means the Mabang inventory/assortment view. Its
  predicted daily sales are a market-validated reference within the visible
  source scope, not the user's own sales and not an unconditional company-wide
  truth.

<!-- fact-id: term.reference-image -->
- A Mabang SKU image is reference material. It must not automatically replace a
  user-confirmed product image or become a primary image without an explicit
  user action.

## Durable Data Sources

<!-- fact-id: data-source.mabang-orders -->
- Mabang order exports and scheduled order collection are the source for the
  team's order and sales facts.

<!-- fact-id: data-source.mabang-inventory -->
- Mabang inventory exports and scheduled inventory collection are the source
  for SKU, warehouse, predicted sales, stock, in-transit quantity, and sellable
  days facts.

<!-- fact-id: data-source.product-package -->
- The product package is the source for product/SKU mapping, country-specific
  product attributes, category/style structure, costs, and explicitly present
  reference fields. The current database-synchronized product package does not
  supply the former tier-20/25/35/45 prices. Sales amounts must therefore come
  from Mabang order facts or a separately approved, versioned allocation or
  estimate rule; a missing product-package price must remain unknown.

<!-- fact-id: data-source.shop-details -->
- Platform API / Connector is the canonical source for shop technical
  identity, platform, seller ID, provider shop name/code, country, provider
  status, authorization, and callability. `commerce_shop_registry` is its
  governed non-secret projection plus business enrichment for ownership,
  category, and confirmed price-control shop type. Provider credentials remain
  in the Connector control plane; names and provider codes alone must never
  create an authorization-grade identity link.

<!-- fact-id: data-source.price-control -->
- The external `price_control` table is the source for country/SKU control
  prices. `apply_no` identifies an application batch, each row is one SKU
  application detail, and only `CA` (approved) batches may become effective or
  generate Commerce Ops price-change reminders; review states such as `BA` are
  not effective prices. A null price field means that price dimension was not
  maintained in the batch, so Commerce Ops carries the prior non-null price
  forward and emits no change. Removal requires an explicit source deletion
  marker; absent to numeric is a new price, and numeric to a different numeric
  value is an increase or decrease.

## Working Rules

<!-- fact-id: work-rule.copyable-codex-instruction -->
- When the user asks what to do next or how to instruct another Codex task, the
  answer must include a complete block that can be copied directly into Codex.

<!-- fact-id: work-rule.high-risk-confirmation -->
- Production database changes, formal migrations, destructive data operations,
  history rewrites, branch merges, and real bulk external actions require clear
  user confirmation before execution.

<!-- fact-id: work-rule.no-invented-data -->
- Missing or unavailable business data must remain unknown or visibly
  insufficient; it must never be silently converted to zero or guessed.

<!-- fact-id: work-rule.explainable-decisions -->
- Core operational metrics, opportunities, and risks must be deterministic and
  explainable with inputs, rules, and evidence. AI may summarize and recommend,
  but it must not fabricate source facts or replace the metric contract.

<!-- fact-id: work-rule.preserve-user-work -->
- Existing uncommitted user work and unrelated in-progress changes must be
  preserved and kept outside the current task's edit boundary.

## Detail Pointers

- Commerce Ops-specific architecture, modules, and contracts live in the project
  profile rather than this permanent file.
  <!-- memory-pointer: memory/projects/commerce-ops.md -->
