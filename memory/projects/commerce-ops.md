---
memory_type: project
project: commerce-ops
updated_at: 2026-08-10
---

# Commerce Ops Project Profile

## Stable Profile

<!-- fact-id: project.commerce-ops.root -->
- Workspace root: the repository root containing `AGENTS.md`.

<!-- fact-id: project.commerce-ops.mission -->
- Commerce Ops is a unified cross-border ecommerce operations workspace that
  connects source data, product operations, analysis, tasks, and execution.

<!-- fact-id: project.commerce-ops.modules -->
- Main capabilities include Product Center, Mabang Data, product publishing,
  image assets, Sales and Assortment, Growth Radar, Listing workflows,
  advertising analysis, approved price-control change tracking, scheduling,
  notifications, and fulfillment.

<!-- fact-id: project.commerce-ops.liaoliao-ai-assistant -->
- The standalone `integrations/liaoliao-ai-assistant` module is the phase-one
  ChatPlusAI (乐聊) edge adapter. It uses Python, Playwright, and its own SQLite
  database to retain the browser session, collect unread conversations and
  right-panel observations, and optionally synchronize them to the main
  Customer Service control plane. In central mode it consumes only bounded
  `FILL_DRAFT` commands: before filling it reopens the uniquely identified
  conversation and revalidates the account, latest inbound message, route and
  editor content. It fills but never sends, never overwrites a different draft,
  and immediately proceeds to another conversation without waiting for the
  first customer to be handled. Passwords, cookies and browser storage state
  remain on the edge machine. Port 8876 is its optional local compatibility
  workbench; port 8765 remains reserved for Mabang. Its Fleet supervisor runs
  each enabled account in an isolated process with a unique central account,
  Worker ID, Browser Context, Session, SQLite and log directory, caps one
  machine shard at twelve visible browsers, and forcibly disables the legacy
  local programmatic-send compatibility flag. A central short-lived account
  lease permits only one primary Worker to observe and consume commands for a
  LiaoLiao account at a time; duplicate Workers fail before opening a browser,
  while lease expiry permits bounded standby takeover.

<!-- fact-id: project.commerce-ops.customer-service-ai-center-target -->
- The Commerce Ops customer-service architecture makes the
  main Node.js/PostgreSQL application the control plane for customer-service
  accounts, conversations, stable upstream references, immutable Context
  snapshots, AI suggestions, review and audit. Customer Service does not own
  or copy order, inventory, shop configuration, product-package or product-
  knowledge truth; its Context Assembler consumes versioned snapshots through
  the corresponding shared-domain Facades.
  Per-account Python/Playwright workers remain isolated edge adapters that own
  local LiaoLiao Sessions, collect page observations and fill drafts only.
  The Reply Agent is created by AgentRuntime and uses a versioned immutable
  Customer Service Context plus the unified AI Gateway; local worker SQLite is
  an offline outbox/cache rather than the business source of truth.

<!-- fact-id: project.commerce-ops.customer-service-control-plane-phase1 -->
- Customer Service control-plane Phase 1 is implemented in the main system as
  an additive SQLite/PostgreSQL schema, provider-neutral repository/service,
  separately authenticated Edge Worker API, encrypted message ingestion,
  encrypted browser-routing envelopes, per-conversation latest-message queue,
  stale-suggestion and draft-command cancellation, immutable evidence-backed
  Context snapshots, the AgentRuntime Reply Agent, a central generation runner,
  fill-only commands, and a Vue Customer Service workbench with editable
  accept/reject/fill review. The server forces every new account to
  `OBSERVE_ONLY` even if a client requests a higher mode. Upgrades are strictly
  sequential: at least one observed inbound message, a configured Reply Agent,
  a ready Product Knowledge registry and at least one published SUPPORT Release
  are required for `SUGGEST_ONLY`; at least one generated suggestion with an
  ACCEPT/EDIT review is required for `DRAFT_FILL`. Downgrades remain immediately
  available. The API and Vue account cards expose the same stage, evidence
  counts, blockers and next transition, and `CS_DEPLOYMENT_READINESS_V1` provides
  a read-only observe/suggest/draft preflight. Global AI and Draft
  Fill gates also default off. The Context Assembler uses exact Product Core and read-only
  order, inventory, product-package and confirmed-shop Facades. Only a
  confirmed shop plus an exact Mabang order may trigger a read-only Platform
  Gateway order-item lookup for authoritative Lazada/Shopee logistics;
  LiaoLiao right-panel logistics remains separate non-authoritative observation.
  Node and Python share the fail-closed `CS_FILL_DRAFT_V1` contract, Fleet mode
  disables programmatic sending, and a deterministic post-model gate blocks
  auto-fill for unrecognized evidence, low confidence, unsupported order,
  inventory or logistics claims, unknown tracking identifiers and risky
  promises. High-risk manual fills require explicit human acknowledgement; the
  workbench exposes confidence, gate reasons, primary account leases, actual
  model/Prompt/Token usage, controlled review reasons, normalized edit size,
  and human accept/edit/reject quality by country, category, intent, risk,
  account, shop and model. A central draft-content digest now lets an observed
  outbound LiaoLiao message prove exact post-fill human adoption without adding
  send capability; unmatched human replies remain unassigned to the AI draft.
  Observed message sequences also produce bounded first-response P50/P95 and
  exact-match share metrics without persisting plaintext in analytics fields.
  Explicit mark-handled episodes produce idempotent handling P50/P95 and a
  current OPEN/HANDLED handling share, explicitly not a claimed resolution rate.
  `CS_REPLY_EVALUATION_V1` provides deterministic
  JSONL replay without a model call. No central automatic-send capability exists.
  Both human-requested and automatic draft-fill commands are fail-closed at
  command creation and Worker lease time: the global Draft Fill gate must be
  enabled and the exact account must still be `ACTIVE` and `DRAFT_FILL`.
  Unauthorized pending or leased fill commands are canceled before delivery.
  Database deployment and real-account activation are separate gates: applying
  the schema never activates a LiaoLiao account or enables AI/Draft Fill.

<!-- fact-id: project.commerce-ops.customer-service-local-account-onboarding -->
- The main Customer Service workbench owns a three-step local onboarding flow:
  account metadata, human login in a visible isolated Google Chrome window
  controlled through Playwright, and continuous monitoring. The local-runtime
  manager selects the installed stable Chrome channel and never attaches to or
  reuses the user's default Chrome profile. It never accepts a LiaoLiao password,
  Cookie, OTP or Session. The manager starts fixed Python module commands with
  `shell:false`, per-account Session/SQLite/log paths and a minimal environment;
  login is serialized globally, monitoring defaults to four concurrent accounts
  with a hard maximum of twelve, and every new account remains `OBSERVE_ONLY`.
  The worker credential is generated or reused from a local secret file and is
  never returned by an API. Session writes are atomic, and no component may
  click Send or synthesize Enter.

<!-- fact-id: project.commerce-ops.product-knowledge-center-target -->
- Product knowledge is an implemented shared Product Domain boundary rather than
  a Customer Service submodule. Approved immutable Knowledge Releases bind
  claims and source passages to category/model/product/SKU, country, language,
  consumer scope, visibility and risk. Customer Service consumes the SUPPORT
  view, future Listing consumes the LISTING view, and neither may create a
  duplicate knowledge truth or silently override Product Core/package facts.
  Offline packages import only candidates; runtime resolution is fail-closed
  to approved claims in published Releases, so review, mapping, source-read and
  conflict records cannot become AI evidence.

<!-- fact-id: project.commerce-ops.product-knowledge-governance-phase1 -->
- Product Knowledge governance Phase 1 supports explicit review and immutable
  publication of product claims, accessory relations, Customer Service policies,
  and Customer Service playbooks. Governance is disabled by default and uses
  separate reviewer and publisher allowlists until main-system RBAC is connected;
  a release creator cannot publish the same release, and sensitive or high-risk
  content requires explicit risk acknowledgement plus a compliance reviewer.
  Runtime Customer Service Context resolves only approved entities included in
  a published SUPPORT release and excludes internal-only content.

<!-- fact-id: project.commerce-ops.shared-product-knowledge-import-policy -->
- Shared product-knowledge imports use the implemented V1 offline
  standardization contract. Product names and specifications route to Product
  Core candidates; installation, FAQ, selling points, materials, and similar
  claims route to Product Knowledge; compensation rules and reply templates
  remain separate Customer Service Policy and Playbook candidates. Product
  identity and the formal first-level category are resolved read-only from
  Product Core, source-folder country is evidence only, and unapproved,
  unmapped, conflicted, risky, or unread source records cannot enter an AI
  Knowledge Release.

<!-- fact-id: project.commerce-ops.frontend-policy -->
- The active main-workbench frontend uses Vue 3, TypeScript, Vue Router, Pinia,
  Element Plus, and ECharts under `frontend/commerce-ops-vue`; new mainline
  frontend modules follow this stack unless the user explicitly changes the
  policy.

<!-- fact-id: project.commerce-ops.backend-policy -->
- The main backend uses Node.js ES modules and PostgreSQL `commerce_ops` as the
  production system of record behind the guarded Database Provider abstraction.
  The final pre-cutover SQLite snapshot is retained for recovery evidence but
  is no longer the active provider. Python remains where browser/data-
  collection or analysis integrations require it.

<!-- fact-id: project.commerce-ops.postgresql-physical-backup-policy -->
- PostgreSQL production recovery uses weekly online physical base backups under
  `D:\PostgreSQLBackups\base_backup`, tar plus client Zstandard level 6,
  streamed WAL, SHA-256 manifests, `pg_verifybackup`, and an independent
  restore start. The latest four VERIFIED weekly bases are retained, archived
  WAL is retained for seven days, and 50/80 GiB are the warning/critical WAL
  thresholds. Backup, restore-copy and WAL deletion are never automatic and
  require an explicit human-confirmed batch after recovery-chain verification.

<!-- fact-id: project.commerce-ops.source-flow -->
- The intended flow is source-specific evidence into registered datasets,
  canonical product/shop identities, versioned semantic contracts and quality
  gates, then deterministic analysis and operational tasks, then guarded
  execution. Different business grains remain separate facts rather than one
  duplicated wide table.

<!-- fact-id: project.commerce-ops.unified-data-foundation -->
- The shared global data contracts are Mabang order facts, current Mabang
  inventory, the database-synchronized product package/product master,
  approved current price-control facts, and the Platform API shop identity
  contract with its governed business enrichment. Sales and Assortment binds
  orders, inventory and product data; Product Center binds product data; Price
  Control binds price and confirmed shop data. Future datasets are registered
  as `GLOBAL` or `MODULE_LOCAL`, with explicit grain, business key, version,
  freshness, module bindings, lineage and quality rules; modules do not
  hardcode source-system filters or copy a shared dataset.

<!-- fact-id: project.commerce-ops.unified-field-governance -->
- Unified field governance catalogues all 241 declared fields across Mabang
  orders, Mabang inventory, the database product package, price control, the
  Commerce Shop master, and Platform Connector/API data. Cross-source joins use
  six versioned identity/relationship rules over canonical product, warehouse,
  shop, and API identities; ordinary value fields are not treated as join keys.
  Contract V2 and its field mappings remain `DRAFT` until the current contract
  version, materialized relation, and successful quality run all validate.
  Candidate migration 014 is governance-only: it does not alter facts, publish
  V2 views, perform backfill, or change module bindings.

<!-- fact-id: project.commerce-ops.inventory-pending-shipment-separation -->
- Mabang inventory `未发货量` and `分仓调拨未发货量` are independent source
  facts. They persist as `pending_shipment_quantity` and
  `transfer_pending_shipment_quantity`; neither field may be used as a fallback
  for the other when one is absent.

<!-- fact-id: project.commerce-ops.shop-api-binding-policy -->
- Platform API application metadata reuses Foundation Integration Accounts and
  binds to `commerce_shop_registry` through validated account-shop bindings and
  confirmed external shop identities. Application platform, canonical shop
  platform and Connector identity platform must agree. Provider tokens and
  secrets remain in the encrypted Connector control plane; PostgreSQL stores
  only non-secret profiles, references, status and verification evidence.

<!-- fact-id: project.commerce-ops.shop-directory-connector-projection -->
- Platform Connections reads the Platform Gateway shop catalog as the
  authoritative technical shop set. `commerce_shop_registry` is a non-secret
  materialized projection and business-enrichment layer, not a competing
  identity source. Local ownership, category, and confirmed price-control shop
  type may overlay only through Connector shop ID or unique platform + country
  + seller ID. Provider code and name are display/review evidence only. GET is
  read-only; explicit projection sync is idempotent, copies a strict non-secret
  allowlist, preserves business enrichment, and fails closed on strong-ID
  conflicts. Country-derived site currency uses the versioned
  `SHOP_SITE_DEFAULT_CURRENCY_V1` rule and is never order-settlement evidence.

<!-- fact-id: project.commerce-ops.product-package-database-sync -->
- Product Center reads `AI_Project_A.product_package` through a read-only
  source connection and performs a durable daily sync at 09:00 Asia/Shanghai.
  `product_package_rows` retains only the latest source row for each stable
  source identity, changed source fields are audited in
  `product_import_field_changes`, and an unchanged snapshot is not replaced.
  The source `picture` value remains a product-package fact only and is not
  automatically linked or persisted as a Product Center image asset.

<!-- fact-id: project.commerce-ops.sales-assortment-target-list-price -->
- Sales and Assortment contract `SALES-ASSORTMENT-1.5.0` uses a modeled 50%
  target-profit list price because the current database-synchronized product
  package no longer supplies the former 45% tier price. The deterministic rule
  is `target list price = cost / (1 - 50%)`: country-currency display values use
  product-package local cost, while CNY operating metrics use product-package
  CNY cost. Amounts derived from that price are explicitly published as
  standardized estimates, not sales or GMV. Actual sales amount uses the order
  header `订单核算金额（人民币）` once per canonical order-header ID; when that
  field is absent, `订单核算金额（原始货币） × 汇率（原始货币）` is the only
  deterministic fallback. A category or SKU filter that matches only part of
  an order never receives or prorates the whole-order amount. Confirmed orders
  may form an explicitly partial subtotal with order-level coverage, while
  missing amounts remain unknown rather than zero. Legacy `ownAmount` and
  `assortmentAmount` remain only as estimated compatibility aliases during
  consumer migration.

<!-- fact-id: project.commerce-ops.product-center-column-policy -->
- Product Center's SKU master table lets the frontend select and persist the
  five original summary columns plus all 62 `AI_Project_A.product_package`
  source fields. Its default header order is image, SKU/product, country/main
  SKU, category/specification, lifecycle status, data status, updated time,
  and operations. Image and SKU/product remain fixed at the start, operations
  remains fixed at the end, and selected source fields appear before
  operations. The SKU master-data panel appears before the package-sync change
  panel so the canonical product table is the primary Product Center view.
  Product detail, product edit, Mabang exact SKU image matching,
  image upload, and image management remain canonical workflows and must not
  be omitted by frontend migrations.

<!-- fact-id: project.commerce-ops.agent-runtime-policy -->
- Production business Agents must be created by AI Agent Foundation 1.3
  `AgentRuntime`. Runtime requires the Context Registry, versioned Tool
  Registry, AI Gateway, Foundation Task Service, and Audit Service; Agents
  declare exact Context/Tool versions and can use only the branded Runtime
  Context/Tool interface. They cannot receive repositories, services, database
  or network clients, providers, or filesystem access.

<!-- fact-id: project.commerce-ops.platform-connector-policy -->
- Marketplace and ERP integrations use the Commerce API Gateway and registered
  Platform Connector Layer. Business modules never construct provider API
  clients directly, and Agent tools that read platform data declare
  `external_access: gateway_only`. Provider application secrets remain in the
  local secret environment, shop tokens are encrypted in the connector control
  plane, and provider write capabilities remain fail-closed until explicitly
  enabled.

<!-- fact-id: project.commerce-ops.shopee-token-broker -->
- Shopee authorization and signing use the company-internal Mac mini broker,
  which owns `partner_id`, `partner_key`, access tokens, and one-time refresh
  tokens. Commerce Ops may retain its already approved encrypted token cache,
  but business reads should use the broker's organization-scoped Shopee relay
  through an explicit read-only Connector allowlist; business modules and
  Agents never receive provider credentials or a generic passthrough. The
  upstream relay permits writes, so Commerce Ops write operations remain
  fail-closed behind the existing Gateway controls.

<!-- fact-id: project.commerce-ops.profit-module-boundary -->
- Profit Analysis is a source-aware, platform-versioned pipeline rather than a
  browser-side formula. Lazada contract `LAZADA-PROFIT-1.0.0` reads official
  finance details only through the Commerce API Gateway, reuses canonical shop
  identity, Mabang order evidence and current country/SKU/warehouse product-
  package cost, then persists finance facts and auditable shop/run snapshots.
  Cross-currency selections are never summed. Missing Mabang orders or
  ambiguous/missing cost remains visibly partial. Country and multi-shop
  aggregates treat completeness as a quality signal rather than an all-or-
  nothing gate: each amount sums shops where that exact field is known, while
  each profit rate uses only shops with all inputs required by that formula;
  per-metric contributing-shop counts remain visible. Cross-country CNY totals
  use versioned rule `PRODUCT_PACKAGE_COUNTRY_FX-1.0.0` and the current product-
  package `国家汇率` plus direction: each shop is converted to CNY before totals
  and margins are recomputed, while source date and country coverage remain
  visible. Missing or genuinely conflicting rates fail closed instead of being
  guessed or zero-filled. Date selection is coverage-aware at shop-day grain:
  a fully covered range is recalculated from cached finance facts without a
  Lazada call, uncovered ranges fetch only their missing shop/date intervals,
  and a 09:30 Asia/Shanghai runner fills the preceding business date. Cached
  previews explicitly use the current product-package cost basis, while exact
  completed runs remain auditable snapshots. Mabang byte-identical rows
  rejected by the general importer are restored as separate product units only
  when their row hash also has a valid row in the same authoritative batch;
  other rejected rows remain excluded. Shopee now supplies its own official
  Income Report adapter, country fee dictionaries and versioned calculation
  rules behind the same boundary rather than reusing Lazada fee semantics.
  Its scheduled refresh requests only the preceding Shanghai business date and
  skips a shop when any successful existing snapshot window already covers that
  date. Calendar-month Shopee totals combine only contiguous, non-overlapping
  successful windows that fully cover the requested range, then sum amounts and
  counts and recompute all three profit margins; a range with a gap is not
  published as a complete shop total. Profit and Expense share the same
  normalized provider-bill facts in `profit_finance_transactions`; bill rows
  are never imported or persisted twice. Lazada Account Payment and Shopee
  wallet advertising rows are separate source facts because they are absent
  from the provider bill. Versioned Expense rules materialize one
  `profit_shop_daily_expenses` fact per canonical shop and marketplace-local
  transaction date, and the Profit dashboard sums those facts through the same
  platform, country, shop and date filters used by Profit. Missing daily source,
  pagination, exact Summary fields or currency evidence remains partial with a
  null expense value. GMV and expense rate follow the separately versioned,
  source-backed contract below.

<!-- fact-id: project.commerce-ops.profit-gmv-expense-rate -->
- Profit Analysis GMV uses one current Mabang canonical order header per
  business key and the shop-local formula `原始商品总金额 - 优惠金额（原始货币）`
  for `effective_status='valid'` orders, filtered by Mabang payment date in
  `Asia/Shanghai`. The two source components and their `CONFIRMED`, `MISSING`
  or `CONFLICT` status live on `growth_order_headers` and update with every
  Mabang order import; there is no independently maintained shop-GMV snapshot.
  GMV first uses the canonical Growth Shop link and may use normalized shop
  name only when it is an exact unique analytical match within the platform.
  An unfiltered Mabang date-range batch is explicit whole-visible-shop source
  coverage, including shops with no orders in that range; a filtered batch
  proves coverage only for its declared shop scope. Zero-order shops therefore
  publish complete zero GMV when every requested source day is covered, rather
  than being mislabeled as missing source data.
  Store expense rate is total expense divided by store GMV; country expense
  rate is country total expense divided by country total GMV, never an average
  of store rates. Cross-country totals convert each shop's expense and GMV to
  CNY before recomputing the rate. Rule `MABANG-ORDER-GMV-1.1.0` treats an
  order with missing, conflicting, or negative GMV components as a zero GMV
  contribution once every requested source day is covered; confirmed orders
  still contribute their calculated values, and unresolved-order counts and
  issue codes remain visible. Missing source-day coverage still fails closed.
  A shop with total GMV zero has no shop expense rate because division by zero
  is undefined, while the country rate continues to use country total expense
  divided by country total GMV.

<!-- fact-id: project.commerce-ops.lazada-shop-advertising-expense-rule -->
- Lazada shop advertising-related expense uses one shop, one currency, and the
  same inclusive local-site date range for both sources. Its signed advertising
  ledger amount is the sum of Account Transactions where `type=Payment`. Its
  signed billing amount is the sum of Finance Details in these user-confirmed
  categories: Sponsored Affiliates and refund, Product 360 Boost and refund,
  Marketing Solutions / Social Media Ads, Strategic Seller Program
  participation fee, Sponsored Max fee and refund, and Sponsored Solutions
  Top-up. Lazada's provider labels `Free Shipping Max Fee` and `Reversal of
  Free Shipping Max Fee` are the charge/refund aliases for the confirmed Max
  marketing-fee category, and `Marketing solution /social media advertising`
  is an accepted exact provider spelling. Refund signs are preserved. The
  current materialization contract is `LAZADA-EXPENSE-1.1.0`. The signed shop amount is advertising
  ledger plus billing amount; because expenses are negative, the displayed
  positive expense value is the negation of that signed total. Source rows,
  ranges, currencies, and category mappings must remain auditable rather than
  guessed or silently zero-filled. `Premium Package` and `Reverse - Premium
  Package` are explicitly excluded from this expense metric because they are
  platform program-package rows; they remain in the Lazada profit-module
  calculation instead. Finance API request boundaries must not be treated as
  local calendar-day boundaries: fetch a padded UTC window and then strictly
  filter the returned Finance `transactionDate` to the shop site's inclusive
  local date range before calculating or exporting totals. Adjacent Finance
  request windows can both return the shared boundary, so exact rows repeated
  across different windows must be deduplicated by the complete transaction
  identity before calculation; do not remove identical rows repeated within a
  single provider response without separate evidence.

<!-- fact-id: project.commerce-ops.shopee-my-income-formula -->
- Shopee Malaysia official Income Report workbooks are governed as five-sheet
  finance evidence: `Summary`, `Service Fee Details`, `Adjustment`, `Shipping
  Fee Discrepancy`, and `Income`. This contract is Malaysia-only; every other
  country, including Vietnam, requires its own user-confirmed source contract.
  Malaysia calculations first restrict `Income` to rows whose `View By` is
  `Order`. Real received income is
  `sum(Total Released Amount) + Adjustment.Total Amount - sum(AMS Commission
  Fee) - sum(Ads Escrow Top Up Fee)`; source signs are preserved, so a negative
  Adjustment reduces income and a negative AMS Commission Fee is added back by
  the subtraction. List-price income is the sum of `Product Price`, `Refund
  Amount`, `Rebate Provided by Shopee`, `Voucher Sponsored by Seller`, `Cofund
  Voucher Sponsored by Seller`, `Coin Cashback Sponsored by Seller`, and
  `Cofund Coin Cashback Sponsored by Seller` over those Order rows. Missing
  fields remain unavailable rather than zero-filled outside a source workbook
  that explicitly contains numeric zero. Order count is the count of distinct,
  nonblank `Order ID` values in those Order rows. Total cost deduplicates those
  identifiers, matches them to current Mabang actual order lines to obtain the
  shipped SKU and quantity, and sums `quantity * cost_local` from Malaysia
  product-package rows. Product cost prefers an exact warehouse match; without
  one, it is usable only when every Malaysia candidate for that SKU has one
  unique cost. Missing Mabang orders, missing costs, and ambiguous costs block a
  complete total. The three published margins are `(list-price income - total
  cost) / list-price income`, `(real received income - total cost) / real
  received income`, and `(real received income - total cost) / list-price
  income` respectively.

<!-- fact-id: project.commerce-ops.shopee-normal-expense-rule -->
- The user-confirmed Shopee `normal expense` metric is the positive expense
  magnitude of three source components over one identical shop transaction-date
  range: Seller Balance Payment advertising spend from
  `payment.get_wallet_transaction_list` with
  `transaction_tab_type=wallet_wallet_payment`, `Summary.AMS Commission Fee`
  (affiliate deduction), and `Summary.Ads Escrow Top Up Fee`. The source amounts
  are negative when charged, so the published rule is
  `normal expense = -(advertising + affiliate deduction + ads escrow top-up
  fee)`. Sources may be aligned by the exact shop display name only within one
  platform and country when the name is unique; technical authorization and
  execution identity still require the canonical Connector shop ID.

<!-- fact-id: project.commerce-ops.shopee-expense-corrupt-workbook-policy -->
- A Shopee MY daily Income Report whose labels are unreadable may contribute
  only the two Summary expense components, and only when its currency, date,
  section, invariant English-label and component-cell geometry match the
  versioned MY template fingerprint exactly. The expense-only path may combine
  those Summary values with a complete wallet page, but it must not treat an
  unreadable Income or Adjustment sheet as zero, replace shared Profit finance
  facts, or publish a complete Profit result. Any fingerprint change remains a
  visible parse failure.

<!-- fact-id: project.commerce-ops.shopee-profit-platform-contract -->
- Profit Analysis supports Shopee Malaysia, Vietnam, Thailand, Indonesia and
  Philippines under rule set `SHOPEE-PROFIT-1.0.0`, with country rules
  `SHOPEE-{MY,VN,TH,ID,PH}-PROFIT-1.0.0`. Vietnam currently uses the
  user-confirmed Malaysia formula while retaining a separate version for future
  schema changes. Thailand, Indonesia and Philippines use their confirmed
  country-specific Summary, Income and Adjustment fields; Indonesia deduplicates
  `Seller Adjustment - 1` by Order ID. Shopee calendar-month periods and Lazada
  complete-week periods remain separate even in the unified country/platform
  view. Official Shopee XLSX acquisition uses read-only Payment API
  `generate_income_report` then `get_income_report`; manual XLSX import is the
  fail-closed fallback. Every run persists a snapshot and requires exact Mabang
  shipped order/SKU/quantity plus country product-package local cost before a
  complete total cost or profit rate is published. Shopee profit refreshes query
  the authoritative Mabang facts already stored in Commerce Ops and never
  trigger a second Mabang import; unresolved orders remain a partial result.
  Official MY/VN exports may omit Adjustment when its total is zero, and any
  supported country may emit a Summary-only zero-order workbook; the latter is
  accepted only when Summary explicitly reports Total Released Amount zero.
  Authorized shops in countries without a confirmed rule remain visible as
  unsupported and are never calculated with another country's formula.

<!-- fact-id: project.commerce-ops.lazada-ready-to-ship-policy -->
- The Lazada Connector supports normalized order-item reads and guarded
  ReadyToShip execution through the Commerce API Gateway. ReadyToShip remains
  behind the global provider-write gate, validates each package-level result,
  is never automatically retried, and records the provider request outcome in
  the connector audit log.

<!-- fact-id: project.commerce-ops.price-control-detection-policy -->
- Price Control change detection is a source-data concern independent of
  Mabang Listing and future marketplace write APIs. Each hourly round reads
  only the latest approved batch for every country/category scope and compares
  the composite identity `country + SKU + platform + shop type + price type`.
  An event is emitted only when both the previous and current values are
  numeric and different; a missing previous value establishes a silent
  baseline, and a later NULL carries the prior value without creating a
  removal. Overlapping source scopes keep the newest concrete value. Frontend
  copy and DingTalk notifications project the resulting multi-platform event
  round, and bounded DingTalk samples rotate across changed platforms instead
  of taking the first array slice.

<!-- fact-id: project.commerce-ops.price-control-execution-policy -->
- Price Control execution must resolve explicit same-platform, same-country
  shops with `identityStatus = CONFIRMED`, obtain a live provider-side listing
  diff, keep provider preview capabilities server-side, and require an
  unexpired matching fingerprint plus explicit human selection and
  confirmation before any price write. Shop identity is rechecked immediately
  before execution, so a later `REVIEW_REQUIRED` state blocks an existing
  preview. Ambiguous execution outcomes are never automatically resubmitted.
  Mabang Listing is the first adapter; future marketplace API adapters must
  preserve the same preview, confirmation, idempotency, readback, and Audit
  boundary.
  Source synchronization uses bounded MySQL query timeouts and persistent run
  heartbeats. Before a new sync is admitted, a run stale beyond the configured
  threshold is failed atomically together with its paired Foundation source
  run and recorded in Audit, so an abandoned read cannot block later hourly
  rounds indefinitely.

<!-- fact-id: project.commerce-ops.postgresql-cutover-full-sync-policy -->
- Before any formal PostgreSQL provider switch, all SQLite writers must be
  frozen, a final pinned online-backup snapshot must be taken, and the complete
  inventoried SQLite scope must be synchronized and validated against the
  PostgreSQL production candidate. The switch is forbidden when any table,
  view, row, primary key, digest, foreign key, business total, or deterministic
  sample has an unexplained difference; the existing 47-table incremental
  domain scope alone is not sufficient evidence for the full-source cutover.

## Canonical Project Documents

- AI operations target architecture: [建议AI运营系统架构说明.md](../../建议AI运营系统架构说明.md)
- System map: [COMMERCE-OPS-SYSTEM-MAP.md](../../docs/design/COMMERCE-OPS-SYSTEM-MAP.md)
- Foundation plan: [COMMERCE-OPS-FOUNDATION-V1-IMPLEMENTATION-PLAN.md](../../docs/design/COMMERCE-OPS-FOUNDATION-V1-IMPLEMENTATION-PLAN.md)
- Current Growth Radar metric contract: [COM-GROWTH-RADAR-V2.2-METRICS-1.2.0.md](../../docs/design/COM-GROWTH-RADAR-V2.2-METRICS-1.2.0.md)
- Mabang source-data contract: [COM-GROWTH-RADAR-V2.2-MABANG-SOURCE-DATA-CONTRACT.md](../../docs/design/COM-GROWTH-RADAR-V2.2-MABANG-SOURCE-DATA-CONTRACT.md)
- Architecture optimization audit: [COMMERCE-OPS-ARCHITECTURE-OPTIMIZATION-20260727.md](../../docs/design/COMMERCE-OPS-ARCHITECTURE-OPTIMIZATION-20260727.md)
- AI Foundation design: [COMMERCE-OPS-AI-FOUNDATION-V1.md](../../docs/design/COMMERCE-OPS-AI-FOUNDATION-V1.md)
- Agent framework contract: [COMMERCE-OPS-AGENT-FRAMEWORK-V1.md](../../docs/design/COMMERCE-OPS-AGENT-FRAMEWORK-V1.md)
- AI Agent Foundation 1.1 design: [COMMERCE-OPS-AI-AGENT-FOUNDATION-1.1.md](../../docs/design/COMMERCE-OPS-AI-AGENT-FOUNDATION-1.1.md)
- AI Agent Foundation 1.1 final report: [COMMERCE-OPS-AI-AGENT-FOUNDATION-1.1-FINAL.md](../../docs/reports/COMMERCE-OPS-AI-AGENT-FOUNDATION-1.1-FINAL.md)
- AI Agent Foundation 1.2 design: [COMMERCE-OPS-AI-AGENT-FOUNDATION-1.2.md](../../docs/design/COMMERCE-OPS-AI-AGENT-FOUNDATION-1.2.md)
- AI Agent Foundation 1.2 final report: [COMMERCE-OPS-AI-AGENT-FOUNDATION-1.2-FINAL.md](../../docs/reports/COMMERCE-OPS-AI-AGENT-FOUNDATION-1.2-FINAL.md)
- AI Agent Foundation 1.3 design: [COMMERCE-OPS-AI-AGENT-FOUNDATION-1.3.md](../../docs/design/COMMERCE-OPS-AI-AGENT-FOUNDATION-1.3.md)
- AI Agent Foundation 1.3 final report: [COMMERCE-OPS-AI-AGENT-FOUNDATION-1.3-FINAL.md](../../docs/reports/COMMERCE-OPS-AI-AGENT-FOUNDATION-1.3-FINAL.md)
- AI Agent Foundation 1.4 design: [COMMERCE-OPS-AI-AGENT-FOUNDATION-1.4.md](../../docs/design/COMMERCE-OPS-AI-AGENT-FOUNDATION-1.4.md)
- AI Agent Foundation 1.4 final report: [COMMERCE-OPS-AI-AGENT-FOUNDATION-1.4-FINAL.md](../../docs/reports/COMMERCE-OPS-AI-AGENT-FOUNDATION-1.4-FINAL.md)
- AI Agent Foundation 1.4.1 monitoring-center design: [COMMERCE-OPS-AI-AGENT-FOUNDATION-1.4.1.md](../../docs/design/COMMERCE-OPS-AI-AGENT-FOUNDATION-1.4.1.md)
- AI Agent Foundation 1.4.1 final report: [COMMERCE-OPS-AI-AGENT-FOUNDATION-1.4.1-FINAL.md](../../docs/reports/COMMERCE-OPS-AI-AGENT-FOUNDATION-1.4.1-FINAL.md)
- Daily Report Agent Context-boundary production fix: [COMMERCE-OPS-AI-AGENT-CONTEXT-BOUNDARY-FIX-20260805.md](../../docs/reports/COMMERCE-OPS-AI-AGENT-CONTEXT-BOUNDARY-FIX-20260805.md)
- AI Foundation final report: [COMMERCE-OPS-AI-FOUNDATION-V1-FINAL.md](../../docs/reports/COMMERCE-OPS-AI-FOUNDATION-V1-FINAL.md)
- Daily Report Agent V2 design: [COMMERCE-OPS-DAILY-REPORT-AGENT-V2.md](../../docs/design/COMMERCE-OPS-DAILY-REPORT-AGENT-V2.md)
- Daily Report Agent V2 final report: [COMMERCE-OPS-DAILY-REPORT-AGENT-V2-FINAL.md](../../docs/reports/COMMERCE-OPS-DAILY-REPORT-AGENT-V2-FINAL.md)
- Daily Report Agent V2.1 design: [COMMERCE-OPS-DAILY-REPORT-AGENT-V2.1.md](../../docs/design/COMMERCE-OPS-DAILY-REPORT-AGENT-V2.1.md)
- Daily Report Agent V2.1 final report: [COMMERCE-OPS-DAILY-REPORT-AGENT-V2.1-FINAL.md](../../docs/reports/COMMERCE-OPS-DAILY-REPORT-AGENT-V2.1-FINAL.md)
- PostgreSQL migration architecture audit: [COMMERCE-OPS-POSTGRESQL-MIGRATION-AUDIT-FINAL-20260805.md](../../docs/reports/COMMERCE-OPS-POSTGRESQL-MIGRATION-AUDIT-FINAL-20260805.md)
- SQLite migration feasibility audit: [COMMERCE-OPS-SQLITE-MIGRATION-FEASIBILITY-20260805.md](../../docs/reports/COMMERCE-OPS-SQLITE-MIGRATION-FEASIBILITY-20260805.md)
- SQLite schema inventory: [COMMERCE-OPS-SQLITE-SCHEMA-INVENTORY-20260805.md](../../docs/reports/COMMERCE-OPS-SQLITE-SCHEMA-INVENTORY-20260805.md)
- PostgreSQL target architecture: [COMMERCE-OPS-POSTGRESQL-TARGET-ARCHITECTURE.md](../../docs/design/COMMERCE-OPS-POSTGRESQL-TARGET-ARCHITECTURE.md)
- PostgreSQL migration runbook V2: [COMMERCE-OPS-POSTGRESQL-MIGRATION-RUNBOOK-V2.md](../../docs/design/COMMERCE-OPS-POSTGRESQL-MIGRATION-RUNBOOK-V2.md)
- PostgreSQL Shadow Phase 1 report: [COMMERCE-OPS-POSTGRESQL-SHADOW-PHASE1-20260805.md](../../docs/reports/COMMERCE-OPS-POSTGRESQL-SHADOW-PHASE1-20260805.md)
- PostgreSQL Provider Phase 2 plan: [COMMERCE-OPS-POSTGRESQL-PROVIDER-PHASE2-PLAN.md](../../docs/design/COMMERCE-OPS-POSTGRESQL-PROVIDER-PHASE2-PLAN.md)
- PostgreSQL Provider Phase 2 audit: [COMMERCE-OPS-POSTGRESQL-PROVIDER-PHASE2-AUDIT-20260805.md](../../docs/reports/COMMERCE-OPS-POSTGRESQL-PROVIDER-PHASE2-AUDIT-20260805.md)
- PostgreSQL Provider Phase 2 final report: [COMMERCE-OPS-POSTGRESQL-PROVIDER-PHASE2-20260806.md](../../docs/reports/COMMERCE-OPS-POSTGRESQL-PROVIDER-PHASE2-20260806.md)
- PostgreSQL Production Readiness Phase 3A report: [COMMERCE-OPS-POSTGRESQL-PHASE3A-READINESS-20260806.md](../../docs/reports/COMMERCE-OPS-POSTGRESQL-PHASE3A-READINESS-20260806.md)
- PostgreSQL Phase 3B rehearsal result: [COMMERCE-OPS-POSTGRESQL-PHASE3B-REHEARSAL-READY-20260806.md](../../docs/reports/COMMERCE-OPS-POSTGRESQL-PHASE3B-REHEARSAL-READY-20260806.md)
- PostgreSQL Phase 3C readiness report: [COMMERCE-OPS-POSTGRESQL-PHASE3C-READINESS-20260806.md](../../docs/reports/COMMERCE-OPS-POSTGRESQL-PHASE3C-READINESS-20260806.md)
- PostgreSQL Phase 3C operations runbook: [COMMERCE-OPS-POSTGRESQL-PHASE3C-OPERATIONS-RUNBOOK.md](../../docs/design/COMMERCE-OPS-POSTGRESQL-PHASE3C-OPERATIONS-RUNBOOK.md)
- PostgreSQL production hardening checklist: [COMMERCE-OPS-POSTGRESQL-PRODUCTION-READINESS-CHECKLIST-20260806.md](../../docs/reports/COMMERCE-OPS-POSTGRESQL-PRODUCTION-READINESS-CHECKLIST-20260806.md)
- PostgreSQL Phase 3D cutover runbook: [COMMERCE-OPS-POSTGRESQL-PHASE3D-CUTOVER-RUNBOOK.md](../../docs/design/COMMERCE-OPS-POSTGRESQL-PHASE3D-CUTOVER-RUNBOOK.md)
- PostgreSQL Phase 3D readiness report: [COMMERCE-OPS-POSTGRESQL-PHASE3D-READINESS-20260806.md](../../docs/reports/COMMERCE-OPS-POSTGRESQL-PHASE3D-READINESS-20260806.md)
- PostgreSQL final pre-cutover readiness: [COMMERCE-OPS-POSTGRESQL-FINAL-PRECUTOVER-READINESS-20260806.md](../../docs/reports/COMMERCE-OPS-POSTGRESQL-FINAL-PRECUTOVER-READINESS-20260806.md)
- PostgreSQL production cutover final report: [COMMERCE-OPS-POSTGRESQL-PRODUCTION-CUTOVER-FINAL-20260807.md](../../docs/reports/COMMERCE-OPS-POSTGRESQL-PRODUCTION-CUTOVER-FINAL-20260807.md)
- PostgreSQL physical backup policy: [postgresql-backup-policy.md](../../docs/reports/postgresql-backup-policy.md)
- PostgreSQL storage governance final report: [postgresql-storage-governance-final.md](../../docs/reports/postgresql-storage-governance-final.md)
- PostgreSQL backup-space cleanup final report: [postgresql-storage-cleanup-final.md](../../docs/reports/postgresql-storage-cleanup-final.md)
- PostgreSQL Repository compatibility boundary: [COMMERCE-OPS-POSTGRESQL-REPOSITORY-COMPATIBILITY.md](../../docs/design/COMMERCE-OPS-POSTGRESQL-REPOSITORY-COMPATIBILITY.md)
- Storage Provider V1 contract: [COMMERCE-OPS-STORAGE-PROVIDER-V1.md](../../docs/design/COMMERCE-OPS-STORAGE-PROVIDER-V1.md)
- PostgreSQL incremental sync design: [COMMERCE-OPS-INCREMENTAL-SYNC-DESIGN.md](../../docs/design/COMMERCE-OPS-INCREMENTAL-SYNC-DESIGN.md)
- PostgreSQL production migration roadmap: [COMMERCE-OPS-POSTGRESQL-PRODUCTION-MIGRATION-ROADMAP.md](../../docs/design/COMMERCE-OPS-POSTGRESQL-PRODUCTION-MIGRATION-ROADMAP.md)
- PostgreSQL incremental sync final report: [COMMERCE-OPS-POSTGRESQL-INCREMENTAL-SYNC-FINAL-20260806.md](../../docs/reports/COMMERCE-OPS-POSTGRESQL-INCREMENTAL-SYNC-FINAL-20260806.md)
- Price Control change-module design and activation gates: [COMMERCE-OPS-PRICE-CONTROL-CHANGE-MODULE.md](../../docs/design/COMMERCE-OPS-PRICE-CONTROL-CHANGE-MODULE.md)
- Platform Connector Center architecture and extension contract: [COMMERCE-OPS-PLATFORM-CONNECTOR-CENTER-V1.md](../../docs/design/COMMERCE-OPS-PLATFORM-CONNECTOR-CENTER-V1.md)
- Customer Service AI Center target architecture: [COMMERCE-OPS-CUSTOMER-SERVICE-AI-CENTER-V1.md](../../docs/design/COMMERCE-OPS-CUSTOMER-SERVICE-AI-CENTER-V1.md)
- Customer Service complete connection and implementation plan: [COMMERCE-OPS-CUSTOMER-SERVICE-END-TO-END-IMPLEMENTATION-PLAN.md](../../docs/design/COMMERCE-OPS-CUSTOMER-SERVICE-END-TO-END-IMPLEMENTATION-PLAN.md)
- Shared Product Knowledge Center target architecture: [COMMERCE-OPS-PRODUCT-KNOWLEDGE-CENTER-V1.md](../../docs/design/COMMERCE-OPS-PRODUCT-KNOWLEDGE-CENTER-V1.md)
- Shared product-knowledge import contract: [COMMERCE-OPS-SHARED-PRODUCT-KNOWLEDGE-IMPORT-CONTRACT-V1.md](../../docs/design/COMMERCE-OPS-SHARED-PRODUCT-KNOWLEDGE-IMPORT-CONTRACT-V1.md)
- Lazada and Shopee shared Gateway architecture and validation: [COMMERCE-OPS-LAZADA-SHOPEE-API-ARCHITECTURE-20260807.md](../../docs/reports/COMMERCE-OPS-LAZADA-SHOPEE-API-ARCHITECTURE-20260807.md)
- Unified data foundation V1: [COMMERCE-OPS-UNIFIED-DATA-FOUNDATION-V1.md](../../docs/design/COMMERCE-OPS-UNIFIED-DATA-FOUNDATION-V1.md)
- Unified data gap audit: [COMMERCE-OPS-UNIFIED-DATA-GAP-AUDIT-20260808.md](../../docs/reports/COMMERCE-OPS-UNIFIED-DATA-GAP-AUDIT-20260808.md)
- Unified field mapping V2: [COMMERCE-OPS-UNIFIED-FIELD-MAPPING-V2.md](../../docs/design/COMMERCE-OPS-UNIFIED-FIELD-MAPPING-V2.md)
- Unified field gap preview: [COMMERCE-OPS-UNIFIED-FIELD-GAP-PREVIEW-20260808.md](../../docs/reports/COMMERCE-OPS-UNIFIED-FIELD-GAP-PREVIEW-20260808.md)
- Platform API shop authority and gap-resolution report: [COMMERCE-OPS-PLATFORM-API-SHOP-GAP-RESOLUTION-20260808.md](../../docs/reports/COMMERCE-OPS-PLATFORM-API-SHOP-GAP-RESOLUTION-20260808.md)
- Profit GMV and expense-rate contract: [COMMERCE-OPS-PROFIT-GMV-EXPENSE-RATE-V1.md](../../docs/design/COMMERCE-OPS-PROFIT-GMV-EXPENSE-RATE-V1.md)
- Governance 014 isolated rehearsal: [COMMERCE-OPS-UNIFIED-GOVERNANCE-014-REHEARSAL-20260808.md](../../docs/reports/COMMERCE-OPS-UNIFIED-GOVERNANCE-014-REHEARSAL-20260808.md)

## Current State

Current branch, HEAD, worktree, runtime, validation, and daily decisions are not
duplicated here. Read the latest dated record:

<!-- memory-pointer: memory/daily/2026-08-10.md -->

## User And Source Semantics

User working rules, durable data-source meanings, and shared business terms are
canonical in:

<!-- memory-pointer: memory/PERMANENT.md -->
