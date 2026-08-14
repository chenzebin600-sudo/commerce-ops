# Shopee Discount Price Matching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 Commerce Ops 模块化单体内交付 Shopee Discount 折扣价匹配、人工确认纠价与下一期 30 天活动续期，并以 fail-closed 方式保护所有平台写入。

**Architecture:** 新建 `lib/shopee-discount` 深模块，外部接口只暴露预览、批准、执行、协调和查询；数仓、Shopee、通知与持久化都作为内部 seam 的 adapter 注入。Foundation 保存任务外壳与根哈希，领域仓储保存不可变分片、dispatch intent 和回读状态；Vue 页面只调用固定业务接口，不接触任意 Shopee 路径或凭证。

**Tech Stack:** Node.js ESM、Node test runner、SQLite（开发/1 店 10 变体试点）、PostgreSQL（生产）、Vue 3、TypeScript、Element Plus。

## Global Constraints

- 业务真源和全部规则以仓库根目录 `PLAN.md` 为准；本计划只规定实现顺序与接口，不得放宽其中任何 fail-closed 门禁。
- 匹配键固定为 `country + SKU + platform=SHOPEE`；SKU 只去除首尾 Unicode 空白，不改大小写、符号或前导零。
- 金额只允许十进制字符串与整数最小货币单位，禁止以 JavaScript `number` 进行价格运算。
- 价格档位固定为 `DAILY | EVENT | MEGA`，覆盖优先级固定为链接级 > 店铺级 > 国家默认，覆盖仅对当前方案有效。
- 数仓请求失败禁止批准或执行；只有经完整性与异常率校验后的成功缺价才能使用 `floor(original_minor * 99 / 100)`，再按站点步长向下归一化。
- 数仓目标价大于或等于 Shopee 原价时仅跳过该变体并告警；一个异常变体不得阻断其他正常变体。
- 所有 Shopee 写入必须经过不可变预览、人工批准、执行前漂移校验、dispatch intent、写后官方回读。
- 非幂等写端点不自动重试；已派发但未完成官方回读的操作进入 `UNKNOWN`，接管者不得重新派发。
- 通用 `/api/shopee-console/call` 仅允许服务端固定 GET 路径白名单；Discount 写入只能走后端固定 schema adapter。
- SQLite 真实写硬限制为 1 店且 10 变体；生产全量写必须使用 PostgreSQL，并显式启用 `trusted_single_role` 或 `separate_execute_identity`。
- 当前只允许单国家方案；默认覆盖所选店铺全部在售商品（含零库存），下架/禁售/删除/审核失败商品排除。
- 不实现自动识别 8.8/9.9/Payday、变体倍率/加价、自动结束重叠活动、自动删除重建变体、多级审批、个人账号/RBAC 或无人确认写入。

---

### Task 1: Deterministic pricing and approval kernel

**Files:**
- Create: `lib/shopee-discount/contracts.mjs`
- Create: `lib/shopee-discount/pricing-engine.mjs`
- Create: `lib/shopee-discount/approval-hash.mjs`
- Test: `tests/shopee-discount-pricing.test.mjs`
- Test: `tests/shopee-discount-approval-hash.test.mjs`

**Interfaces:**
- Produces: `parseMinorUnits(text, scale) -> bigint`, `formatMinorUnits(value, scale) -> string`, `decideVariantPrice(input) -> PriceDecision`, `resolvePriceTier(scope) -> DAILY|EVENT|MEGA`, `buildApprovalRoot(items, options) -> { version, root, shardHashes }`.
- `PriceDecision` is one of `{ status:"READY", targetMinor:string, source:"WAREHOUSE"|"ORIGINAL_1_PERCENT_OFF" }` or `{ status:"SKIPPED", code, message }`.

- [ ] **Step 1: Write failing price tests** covering literal warehouse prices, link/shop/country priority, Unicode-edge whitespace SKU normalization, exact minor-unit comparison, 1% floor plus step normalization, zero/below-minimum fallback, and `target >= original` isolated skip.
- [ ] **Step 2: Run `node --test tests/shopee-discount-pricing.test.mjs`** and verify failure is caused by missing module exports.
- [ ] **Step 3: Implement the pricing interface** with `BigInt`; parse by splitting the decimal string, reject exponent notation and excessive fractional digits, and return stable error codes instead of throwing for item-level business skips.
- [ ] **Step 4: Run the price test** and verify all cases pass.
- [ ] **Step 5: Write failing approval-hash tests** using hand-authored golden vectors for stable item ordering, duplicate key rejection, odd-leaf duplication, mutable execution-state exclusion, UTF-8 strings and canonical integer amount strings.
- [ ] **Step 6: Run `node --test tests/shopee-discount-approval-hash.test.mjs`** and verify the missing implementation failure.
- [ ] **Step 7: Implement `SHOPEE_DISCOUNT_APPROVAL_V1`** with leaf key `shop_id\u001fitem_id\u001fmodel_id`, SHA-256 leaves, sorted unique keys, fixed shard size, odd-node duplication and a root that binds shard hashes.
- [ ] **Step 8: Run both Task 1 tests** and verify green.

### Task 2: Domain persistence and Foundation registration

**Files:**
- Create: `migrations/027_shopee_discount.sql`
- Create: `migrations/postgresql/027_shopee_discount.sql`
- Create: `lib/shopee-discount/repository.mjs`
- Create: `lib/shopee-discount/postgresql-repository.mjs`
- Modify: `lib/data/data-access.mjs`
- Modify: `lib/foundation/foundation-contracts.mjs`
- Test: `tests/shopee-discount-repository.test.mjs`
- Test: `tests/shopee-discount-postgresql-contract.test.mjs`

**Interfaces:**
- Consumes: canonical item keys and hashes from Task 1.
- Produces: `ShopeeDiscountRepository` and `PostgresqlShopeeDiscountRepository` with identical async interface: settings, activities, plans, immutable shards/items, approvals, jobs, dispatch intents, events, notifications and reconciliation updates.

- [ ] **Step 1: Write failing SQLite repository tests** proving approved item payloads cannot be updated, duplicate item keys are rejected, `(shop_id,time_window)` plan locking is unique, dispatch intents are inserted before completion, epoch compare-and-set rejects stale workers, and `UNKNOWN` cannot return to pending.
- [ ] **Step 2: Run `node --test tests/shopee-discount-repository.test.mjs`** and verify missing migration/repository failures.
- [ ] **Step 3: Add normalized SQLite tables and indexes**; store minor units as canonical text, variant details as rows, and use database constraints for state and identity invariants.
- [ ] **Step 4: Implement the SQLite adapter** using the existing provider transaction interface and parameterized statements.
- [ ] **Step 5: Run the SQLite repository test** and verify green.
- [ ] **Step 6: Write failing PostgreSQL contract tests** that inspect parameterized SQL behavior through the existing provider fake and require production-only claim/lease operations to use row locks or conditional updates.
- [ ] **Step 7: Implement the PostgreSQL migration and adapter** with bigint-safe text mapping, plan/item indexes, due-job index, UNKNOWN-age index and batch insertion.
- [ ] **Step 8: Register `shopeeDiscount` in Commerce Data Access and add Foundation capabilities `discount.read` and `discount.write`** without treating them as user permissions.
- [ ] **Step 9: Run Task 2 tests plus `tests/foundation-contracts.test.mjs` and `tests/data-access.test.mjs`**.

### Task 3: Warehouse control-price adapter and anomaly gate

**Files:**
- Create: `lib/shopee-discount/warehouse-client.mjs`
- Create: `lib/shopee-discount/warehouse-validator.mjs`
- Test: `tests/shopee-discount-warehouse.test.mjs`

**Interfaces:**
- Produces: `WarehouseControlPriceClient.verifyKey()`, `scanPrices({country,category,skus,watermark})`, and `validateWarehouseSnapshot(snapshot, baseline, policy)`.
- Normalized row fields are `sku,country,category,platform,status,dailyMinor,eventMinor,megaMinor,dailyApprovedAt,eventApprovedAt,megaApprovedAt,watermark`.

- [ ] **Step 1: Write failing tests** for request failure versus successful missing price, pagination completeness, platform/country filtering, conflicting duplicate SKU rows, watermark change during scan, pipeline watermark older than 35 days, old approval warning, batch old-approval ratio over 20%, and anomalously empty/missing results blocking fallback.
- [ ] **Step 2: Run `node --test tests/shopee-discount-warehouse.test.mjs`** and verify missing implementation failure.
- [ ] **Step 3: Implement the client seam** with injected `fetch`, request ID propagation, bounded pages, encrypted-key callback and no key-bearing errors/logs.
- [ ] **Step 4: Implement the validator** returning `{status:"READY"|"BLOCKED", rows, warnings, evidence}` and explicit codes such as `WAREHOUSE_UNAVAILABLE`, `WAREHOUSE_WATERMARK_CHANGED`, `WAREHOUSE_EMPTY_ANOMALY`, and `WAREHOUSE_DUPLICATE_SKU`.
- [ ] **Step 5: Run Task 3 tests** and verify green.

### Task 4: Shopee read adapter, console lockdown and gated write adapter

**Files:**
- Modify: `lib/shopee-console-proxy.mjs`
- Create: `lib/shopee-discount/shopee-read-adapter.mjs`
- Create: `lib/shopee-discount/shopee-write-adapter.mjs`
- Create: `lib/shopee-discount/write-security.mjs`
- Test: `tests/shopee-console-proxy.test.mjs`
- Test: `tests/shopee-discount-shopee-adapter.test.mjs`
- Test: `tests/shopee-discount-write-security.test.mjs`

**Interfaces:**
- Read adapter exposes fixed operations for shops, active items/models, Discount list/detail and post-write readback.
- Write adapter exposes only `createDiscount`, `addDiscountItems`, and `updateDiscountItems`; V1 does not expose delete/end to automatic workflows.

- [ ] **Step 1: Extend failing console proxy tests** so POST bodies containing non-GET method or paths outside the fixed read allowlist are rejected locally and never reach `fetch`.
- [ ] **Step 2: Run `node --test tests/shopee-console-proxy.test.mjs`** and verify the current proxy incorrectly forwards forbidden calls.
- [ ] **Step 3: Implement service-side read allowlisting** for the product and Discount GET paths required by this module.
- [ ] **Step 4: Write failing adapter/security tests** from the local official Shopee snapshot for `/api/v2/product/get_item_list`, `/api/v2/product/get_item_base_info`, `/api/v2/product/get_model_list`, `/api/v2/discount/get_discount_list`, `/api/v2/discount/get_discount`, `/api/v2/discount/add_discount`, `/api/v2/discount/add_discount_item`, and `/api/v2/discount/update_discount_item`.
- [ ] **Step 5: Add tests proving POST has no hidden retry** on timeout, connection reset, malformed JSON or response loss; each ambiguous result must become `UNKNOWN` with the original operation UUID.
- [ ] **Step 6: Implement fixed request schemas and error classification**; inject relay transport and prohibit caller-supplied paths/methods.
- [ ] **Step 7: Implement startup write-security validation** for `trusted_single_role` attestation or `separate_execute_identity`; require HTTPS/mTLS or signed method/path/timestamp/nonce/body-hash/request-ID requests with replay protection capability declaration.
- [ ] **Step 8: Run all Task 4 tests** and verify green.

### Task 5: Preview, immutable approval and API module

**Files:**
- Create: `lib/shopee-discount/service.mjs`
- Create: `lib/shopee-discount/api.mjs`
- Modify: `server.mjs`
- Test: `tests/shopee-discount-service.test.mjs`
- Test: `tests/shopee-discount-api.test.mjs`

**Interfaces:**
- Produces fixed HTTP routes under `/api/shopee-discount`: settings/status, shops, previews, preview detail/items, approve, execute, runs, activities, issues and manual scan.
- Approval requires `operatorName`, exact confirmation text, `planId`, `merkleRoot` and a non-expired preview.

- [ ] **Step 1: Write failing service tests** for one-country scope, default all active products including zero stock, tier override priority, overlapping activity blocking, external activity tier selection, new-item exclusion inside 24 hours, drift isolation, immutable approval and SQLite pilot limits.
- [ ] **Step 2: Run `node --test tests/shopee-discount-service.test.mjs`** and verify missing implementation failure.
- [ ] **Step 3: Implement the deep module interface** so preview streams normalized items to shards, writes the Merkle root to Foundation, and exposes summaries without loading every item into memory.
- [ ] **Step 4: Write failing API tests** for bounded JSON input, authenticated access inherited from the app shell, actor name treated as a declaration only, privileged approval in `separate_execute_identity`, settings redaction and execution rejection while the real-write gate is closed.
- [ ] **Step 5: Run the API test** and verify missing routes.
- [ ] **Step 6: Implement `createShopeeDiscountApi` and register one handler in `server.mjs`**; keep route parsing and error mapping in the module.
- [ ] **Step 7: Run Task 5 tests and `tests/app-access.test.mjs`**.

### Task 6: Durable execution, fencing and UNKNOWN reconciliation

**Files:**
- Create: `lib/shopee-discount/executor.mjs`
- Create: `lib/shopee-discount/reconciliation.mjs`
- Test: `tests/shopee-discount-executor.test.mjs`
- Test: `tests/shopee-discount-reconciliation.test.mjs`

**Interfaces:**
- Produces `runApprovedPlan(planId, workerContext)` and `reconcileIntent(intentId, resolution, auditContext)`.
- Closed resolutions are exactly `LINK_VERIFIED_OBJECT`, `CONFIRMED_NOT_SENT`, and `ABANDONED`; none requeue the original intent.

- [ ] **Step 1: Write failing executor tests** proving continuous lease renewal, epoch validation immediately before dispatch, transactionally durable intent-before-send, shop isolation, partial success, exact post-write readback, no whole-batch rollback, no retry of non-idempotent writes, and restart behavior that coordinates `DISPATCHED` intents instead of resending.
- [ ] **Step 2: Run `node --test tests/shopee-discount-executor.test.mjs`** and verify missing implementation failure.
- [ ] **Step 3: Implement bounded per-shop execution** with injected clock/lease/Shopee adapters, persisted checkpoints and late-response evidence that cannot advance state after fencing loss.
- [ ] **Step 4: Write failing reconciliation tests** for all three closed resolutions, evidence requirements for `CONFIRMED_NOT_SENT`, and replacement work requiring a new operation UUID, preview and approval.
- [ ] **Step 5: Implement reconciliation and run both Task 6 tests**.

### Task 7: Scheduler, reminders, tasks and DingTalk summaries

**Files:**
- Create: `lib/shopee-discount/scheduler.mjs`
- Create: `lib/shopee-discount/notifications.mjs`
- Modify: `scheduler.mjs`
- Test: `tests/shopee-discount-scheduler.test.mjs`
- Test: `tests/shopee-discount-notifications.test.mjs`

**Interfaces:**
- Produces daily scan jobs, manual scan enqueueing, dynamic renewal generation, and unique UTC due-jobs for T-24h/T-6h/T-1h using each shop IANA timezone.

- [ ] **Step 1: Write failing scheduler tests** for daily once-only jobs, manual immediate jobs, persistent catch-up, duplicate notification suppression, full 30-day cycle after promotion, seamless normal renewal, missed-window nearest start without backfill, and SLO-based early generation/range rejection.
- [ ] **Step 2: Run `node --test tests/shopee-discount-scheduler.test.mjs`** and verify missing implementation failure.
- [ ] **Step 3: Implement scheduler integration** using repository due-jobs and Foundation tasks rather than in-memory timers.
- [ ] **Step 4: Write failing notification tests** proving one configured DingTalk group receives only summary/counts/entry link, secrets and complete price tables are absent, and notification failure does not change business outcome.
- [ ] **Step 5: Implement notification adapter and run Task 7 tests**.

### Task 8: Vue operations page

**Files:**
- Create: `frontend/commerce-ops-vue/src/services/shopee-discount.ts`
- Create: `frontend/commerce-ops-vue/src/pages/ShopeeDiscountPage.vue`
- Modify: `frontend/commerce-ops-vue/src/router/index.ts`
- Modify: `frontend/commerce-ops-vue/src/components/OpsSidebar.vue`
- Test: `tests/shopee-discount-frontend-contract.test.mjs`

**Interfaces:**
- Page supports status/gate display, country and shop selection, DAILY/EVENT/MEGA selection, shop/link overrides, batch upload validation, preview summaries and paged items, confirmation, execution progress, issues, UNKNOWN coordination and renewal reminders.

- [ ] **Step 1: Write failing frontend contract tests** that import the TypeScript service, verify fixed route construction, and assert router/sidebar registration plus required accessible labels and confirmation controls.
- [ ] **Step 2: Run `node --test tests/shopee-discount-frontend-contract.test.mjs`** and verify missing files/routes.
- [ ] **Step 3: Implement typed client models and fixed requests** with no platform path or credential fields.
- [ ] **Step 4: Implement the page** using existing shell tokens/components; paginate item detail, show source/rule/conflict per row, keep write buttons disabled when backend gates are closed, and require exact confirmation text.
- [ ] **Step 5: Run the frontend contract test and `npm --prefix frontend/commerce-ops-vue run check`**.

### Task 9: Integration, capacity gates and operator documentation

**Files:**
- Create: `tests/shopee-discount-integration.test.mjs`
- Create: `scripts/shopee-discount-capacity-check.mjs`
- Create: `docs/shopee-discount-operations.md`
- Modify: `package.json`

**Interfaces:**
- Produces `npm run shopee-discount:capacity-check` and an operator runbook with rollout stages, write-security modes, stop-write thresholds and UNKNOWN procedures.

- [ ] **Step 1: Write a failing integration test** covering preview → approval → drift isolation → partial write → readback → restart → UNKNOWN coordination with in-memory external adapters and real SQLite persistence.
- [ ] **Step 2: Run `node --test tests/shopee-discount-integration.test.mjs`** and verify the first missing integration behavior.
- [ ] **Step 3: Complete only the glue required for the integration test** and run it green.
- [ ] **Step 4: Write a failing capacity-check test mode** generating 1,000 shops, 1,000,000 links and 10,000,000 lightweight variant records in streaming batches, asserting bounded heap growth and database pagination rather than browser materialization.
- [ ] **Step 5: Implement the capacity script and package command**; default to dry-run and require explicit database configuration for PostgreSQL benchmark mode.
- [ ] **Step 6: Write the operator runbook** with read-only → 1 shop/10 variants → 10 shops → 100 shops → authorized shops rollout, three clean-batch gate, emergency write switch, security-mode startup checks and recovery rules.
- [ ] **Step 7: Run targeted Shopee Discount tests, full `npm test`, frontend type-check/build, and the dry-run capacity check**; record any unrelated baseline failures separately and do not modify unrelated user work.

## Coverage check

- `PLAN.md` sections 1–2 map to Tasks 1–2 and 5–6.
- Sections 3–5 map to Tasks 1, 3 and 4.
- Sections 6–9 map to Tasks 5–7.
- Section 10 maps to Task 7 and Task 9.
- Section 11 maps to every TDD task and the final integration/capacity gates.
- All stated out-of-scope items remain absent from the interfaces above.
