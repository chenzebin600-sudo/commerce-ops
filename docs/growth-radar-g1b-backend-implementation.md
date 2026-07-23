# Growth Radar G1B1 后端实现

## 范围与安全边界

G1B1 完成店铺范围、来源范围、订单/库存预览、确认应用、数据质量与语义状态的后端闭环。实现只复用迁移 013 和 014；没有修改迁移文件，没有创建 015 或更高迁移，也没有在运行时执行 `ALTER TABLE`。开发与验证只允许使用 fail-closed 的 G1B 隔离配置、隔离数据库或系统临时测试库。完整前端、正式导航、真实账号、客户数据、`current_online` 数据采集和 `company_sales` 数据采集均不在本节点范围内。

预览保存在服务进程内存中，默认 15 分钟过期；这避免把 013/014 未定义的 `preview_ready` 状态写入数据库，也不借助隐藏 JSON 绕过状态约束。服务重启后必须重新预览，这是当前已知限制。

## 013/014 结构审计

### 迁移 013：表、字段、状态、索引与外键

以下字段列表是 013 创建时的完整列集合；014 对其中两个表的增量列单独列在下一节。

| 表 | 完整字段 | 状态/确认字段 | 索引与唯一约束 | 外键 |
|---|---|---|---|---|
| `growth_source_batches` | `id`, `source_type`, `source_module`, `source_file_id`, `source_filename`, `source_sha256`, `source_account_id`, `idempotency_key`, `query_started_at`, `query_ended_at`, `collected_at`, `imported_at`, `source_scope_json`, `source_headers_json`, `redacted_headers_json`, `row_count`, `status`, `error_code`, `created_by`, `created_at`, `updated_at` | `source_type`: `mabang_order`/`mabang_inventory`/`shop_listing_import`; `status`: `applying`/`applied`/`failed` | `UNIQUE(source_type,idempotency_key)`；`idx_growth_source_batches_type_created`；`idx_growth_source_batches_hash` | `source_file_id → export_files.id` RESTRICT |
| `growth_shops` | `id`, `internal_shop_code`, `display_name`, `platform`, `country_code`, `country_name`, `owner_user_id`, `primary_category_scope_json`, `status`, `identity_status`, `revision`, `created_at`, `updated_at` | `status`: `active`/`inactive`; `identity_status`: `confirmed`/`review_required` | `UNIQUE(internal_shop_code)`；`idx_growth_shops_platform_country` | 无 |
| `growth_shop_source_mappings` | `id`, `source_system`, `source_shop_name`, `normalized_source_shop_name`, `internal_shop_id`, `platform`, `country_code`, `mapping_status`, `mapping_source`, `first_source_batch_id`, `last_source_batch_id`, `confirmed_by`, `confirmed_at`, `created_at`, `updated_at` | `mapping_status`: `matched`/`manually_confirmed`/`ambiguous`/`unmatched`/`revoked`; `mapping_source`: `exact`/`manual`/`unresolved`/`revoked`; 显式确认人和确认时间 | `UNIQUE(source_system,platform,normalized_source_shop_name)`；`idx_growth_shop_mappings_status` | `internal_shop_id → growth_shops.id`; 首末批次 → `growth_source_batches.id`，均 RESTRICT |
| `growth_order_headers` | `id`, `business_key`, `business_key_version`, `platform`, `source_shop_name`, `normalized_source_shop_name`, `internal_shop_id`, `mapped_country`, `source_order_id`, `order_status`, `paid_at`, `cancelled_at`, `order_currency`, `order_amount`, `order_amount_source_field`, `effective_status`, `first_source_batch_id`, `source_batch_id`, `source_quality_status`, `first_seen_at`, `last_seen_at`, `revision`, `created_at`, `updated_at` | `effective_status`: `valid`/`pending`/`invalid_cancelled`/`unconfirmed`; `source_quality_status`: `confirmed`/`review_required`/`invalid` | `UNIQUE(business_key_version,business_key)`；`idx_growth_order_headers_batch`；`idx_growth_order_headers_shop` | 店铺和首/当前批次 RESTRICT |
| `growth_order_raw_rows` | `id`, `batch_id`, `sheet_name`, `source_row_number`, `raw_values_json`, `raw_types_json`, `redacted_fields_json`, `row_hash`, `parse_status`, `created_at` | `parse_status`: `parsed`/`review_required`/`rejected` | `UNIQUE(batch_id,source_row_number)`；`idx_growth_order_raw_rows_hash` | `batch_id → growth_source_batches.id` RESTRICT |
| `product_identity_mappings` | `id`, `source_system`, `source_sku`, `normalized_source_sku`, `platform`, `country_code`, `internal_product_id`, `internal_sku`, `main_sku`, `mapping_status`, `mapping_source`, `confidence`, `first_source_batch_id`, `last_source_batch_id`, `confirmed_by`, `confirmed_at`, `created_at`, `updated_at` | 映射状态同店铺；`mapping_source`: `exact_country_sku`/`manual`/`unresolved`/`revoked`; 显式确认字段 | `UNIQUE(source_system,platform,country_code,normalized_source_sku)`；`idx_product_identity_mappings_status` | 产品和首/末批次 RESTRICT |
| `growth_order_lines` | `id`, `order_header_id`, `first_source_batch_id`, `source_batch_id`, `source_row_number`, `source_line_key`, `source_line_key_version`, `line_occurrence`, `dedupe_confidence`, `source_sku`, `normalized_source_sku`, `platform_sku`, `mapped_product_id`, `mapped_country`, `quantity`, `line_amount`, `line_amount_status`, `product_name`, `mapping_status`, `effective_status`, `is_current`, `first_seen_at`, `last_seen_at`, `revision`, `created_at`, `updated_at` | `dedupe_confidence`: `technical_occurrence`/`source_identifier`; `line_amount_status`: `confirmed`/`unconfirmed`/`unavailable`; 映射与订单有效状态有 CHECK；`is_current`: 0/1 | `UNIQUE(source_line_key_version,source_line_key)`；`idx_growth_order_lines_order`；`idx_growth_order_lines_sku` | 订单头、批次、产品均 RESTRICT |
| `growth_mapping_issues` | `id`, `issue_key`, `issue_type`, `source_batch_id`, `source_row_id`, `source_value`, `candidate_values_json`, `reason`, `status`, `resolved_value`, `resolved_by`, `resolved_at`, `created_at`, `updated_at` | `issue_type`: 店铺/SKU/国家/重复键八类；`status`: `open`/`resolved`/`revoked`/`ignored` | `UNIQUE(issue_key)`；`idx_growth_mapping_issues_status` | 批次、订单原始行 RESTRICT |
| `growth_inventory_raw_rows` | `id`, `batch_id`, `sheet_name`, `source_row_number`, `raw_values_json`, `raw_types_json`, `redacted_fields_json`, `row_hash`, `parse_status`, `created_at` | `parse_status`: `parsed`/`review_required`/`rejected` | `UNIQUE(batch_id,source_row_number)`；`idx_growth_inventory_raw_rows_hash` | `batch_id → growth_source_batches.id` RESTRICT |
| `growth_inventory_snapshots` | `id`, `batch_id`, `source_row_number`, `source_sku`, `normalized_source_sku`, `mapped_product_id`, `warehouse_name`, `available_quantity`, `physical_quantity`, `locked_quantity`, `in_transit_quantity`, `pending_shipment_quantity`, `sellable_quantity`, `sellable_quantity_status`, `source_predicted_daily_sales`, `predicted_daily_sales_semantic_status`, `days_of_supply`, `days_of_supply_status`, `snapshot_at`, `mapping_status`, `quality_status`, `created_at` | 库存/预测/周转状态均有 CHECK；映射与质量状态有 CHECK | `UNIQUE(batch_id,source_row_number)`；`idx_growth_inventory_snapshots_sku` | 批次、产品 RESTRICT |
| `growth_data_quality_issues` | `id`, `issue_key`, `batch_id`, `entity_type`, `entity_id`, `issue_code`, `severity`, `message`, `source_context_json`, `status`, `created_at`, `resolved_at` | `entity_type` 七类；`severity`: `blocker`/`warning`/`information`; `status`: `open`/`resolved`/`ignored` | `UNIQUE(issue_key)`；`idx_growth_data_quality_status` | `batch_id → growth_source_batches.id` RESTRICT |
| `growth_mapping_events` | `id`, `mapping_type`, `mapping_id`, `action`, `before_json`, `after_json`, `actor_label`, `request_id`, `occurred_at` | `mapping_type`: `shop`/`product`; `action`: `confirmed`/`revoked`; 服务端操作者和时间 | `idx_growth_mapping_events_mapping` | 无；逻辑关联由 `mapping_type + mapping_id` 表达 |
| `growth_shop_sku_observations` | `id`, `observation_key`, `coverage_semantic`, `platform`, `source_shop_name`, `normalized_source_shop_name`, `internal_shop_id`, `source_sku`, `normalized_source_sku`, `mapped_product_id`, `first_observed_at`, `last_observed_at`, `observed_order_count`, `observed_line_count`, `observed_quantity`, `first_source_batch_id`, `last_source_batch_id`, `created_at`, `updated_at` | `coverage_semantic` 只能为 `historical_observed` | `UNIQUE(observation_key)`；`idx_growth_shop_sku_observations_shop` | 店铺、产品、首/末批次 RESTRICT |
| `growth_shop_sku_coverage_snapshots` | `id`, `internal_shop_id`, `product_sku_id`, `coverage_semantic`, `source_system`, `source_evidence_id`, `observed_at`, `expires_at`, `created_at` | `coverage_semantic` 只能为 `current_online` | `UNIQUE(internal_shop_id,product_sku_id,source_system,observed_at)`；`idx_growth_shop_sku_coverage_current` | 店铺、产品 RESTRICT |

### 迁移 014：增量字段、表、索引与外键

014 是仓库中已有的正式迁移；G1B1 只消费它，没有再次执行运行时 DDL。

- `growth_source_batches` 增加 `source_scope_status`（`unconfirmed`/`confirmed`）和 `pii_filtered_field_count`（非负）。
- `growth_order_lines` 增加 `source_warehouse_name`、`normalized_source_warehouse_name`，并增加 `idx_growth_order_lines_sku_warehouse(normalized_source_sku,normalized_source_warehouse_name,is_current)`。
- `growth_inventory_snapshots` 增加 `normalized_warehouse_name`, `product_status`, `category_level_1`, `category_level_2`, `category_level_3`, `source_visible_sales_7d`, `source_visible_sales_28d`, `source_visible_sales_42d`, `source_scope_status`。增加按 `snapshot_at + normalized_source_sku + normalized_warehouse_name` 的非空部分唯一索引 `uq_growth_inventory_snapshot_grain`，以及 `idx_growth_inventory_snapshots_warehouse`。

014 新建表的完整结构：

| 表 | 完整字段 | 状态 | 索引与唯一约束 | 外键 |
|---|---|---|---|---|
| `growth_order_inventory_links` | `id`, `order_line_id`, `order_source_batch_id`, `inventory_snapshot_id`, `inventory_source_batch_id`, `match_key_version`, `normalized_source_sku`, `normalized_source_warehouse_name`, `match_status`, `unmatched_reason`, `order_effective_status`, `is_current`, `created_at`, `updated_at` | 键版本只能为 `source_sku_warehouse_v1`; `match_status`: `matched`/`unmatched`; 订单状态与 013 一致；`is_current`: 0/1 | `UNIQUE(order_line_id,inventory_source_batch_id)`；`idx_growth_order_inventory_links_batch_status` | 订单行、订单批次、库存快照、库存批次均 RESTRICT |
| `growth_sku_warehouse_sales_metrics` | `id`, `inventory_snapshot_id`, `inventory_source_batch_id`, `order_source_batch_id`, `snapshot_at`, `normalized_source_sku`, `normalized_source_warehouse_name`, `own_sales_quantity_7d`, `own_sales_order_count_7d`, `own_sales_effective_line_count_7d`, `own_sales_window_started_at`, `own_sales_window_ended_at`, `own_sales_quantity_7d_status`, `source_visible_sales_7d`, `source_visible_sales_28d`, `source_visible_sales_42d`, `source_predicted_daily_sales`, `source_predicted_daily_sales_status`, `source_scope_status`, `created_at` | 自有销量状态 `confirmed`/`unavailable`; 预测状态 `source_prediction_not_actual`/`unavailable`; 来源范围 `unconfirmed`/`confirmed` | `UNIQUE(inventory_snapshot_id)`；`idx_growth_sku_warehouse_sales_metrics_grain` | 库存快照、库存批次、可空订单批次均 RESTRICT |

### 结构到 G1B1 需求的映射

- 店铺 pending/confirmed：`growth_shops.identity_status` 将 `review_required` 投影为 API 的 `pending`，`confirmed` 保持为 `confirmed`；店铺来源映射和确认人/时间复用 `growth_shop_source_mappings`。
- 确认、取消确认及原因：业务变更写入 `growth_mapping_events`；取消原因进入已有的 `after_json` 事件载荷，不新增列。
- 来源确认：应用前预览留在内存；事务应用后的批次写 `growth_source_batches.status=applied` 和 `source_scope_status=confirmed`。`created_by` 与 `imported_at` 分别提供服务端确认人和确认时间。
- 来源范围：已有 `source_scope_json` 是 013 明确提供的来源范围字段，用于 `shop_scope`、`country_scope`、`warehouse_scope` 和 `semantic_scope`；不是新增的隐藏结构。窗口和快照优先使用显式的 `query_started_at`、`query_ended_at`、`collected_at`。
- 订单幂等：批次使用 `source_type + source_sha256` 派生稳定幂等键；订单头、行分别复用业务键和行键唯一约束。行号只用于证据定位，不作为长期业务身份。
- 库存幂等与多仓：复用 014 的 SKU+仓库+快照唯一粒度；同 SKU 不同仓库保持独立。
- 质量问题：预览使用标准化问题模型，应用后写入 `growth_data_quality_issues`；映射候选和冲突继续使用 `growth_mapping_issues`。
- 历史观察与在线状态：历史订单只写 `growth_shop_sku_observations`；只有权威当前在线源才能写 `growth_shop_sku_coverage_snapshots`。两者不会互相推导。
- 销售语义：实际订单行产生 `own_sales`；库存页面窗口值产生 `source_visible_sales`；预测保持 `source_prediction_not_actual`。无 `company_sales` 权威来源时不写值。

013/014 足以实现本节点，因此没有结构缺口，也不需要 015/016。

## 数据语义

所有语义 API 对象都包含 `value`, `semantic_type`, `source`, `observed_at`, `snapshot_at`, `confirmation_status`, `availability_status`。

- `historical_observed`：仅表示有效历史订单确实发生过；不等于当前在线，也不代表当前运营归属。
- `current_online`：只接受权威当前在线快照。当前无来源，返回 `value=null`、`availability_status=unavailable`。
- `own_sales`：只汇总当前订单事实中的有效头和有效行；取消、作废、未知状态不进入合计。
- `company_sales`：当前无来源，返回 `value=null`、`availability_status=unavailable`，不以自身销量或库存页面销量代替。
- `source_visible_sales`：来自库存来源页面并保留 7/28/42 天窗口和快照时间，不等于公司销量。
- `source_predicted_daily_sales`：来自来源系统的预测，状态固定为 `source_prediction_not_actual`，不进入实际销量。

## 店铺确认流程

订单应用发现的来源店铺会创建稳定内部代码和 `review_required` 店铺主数据，初始均为 `pending`，不自动确认。管理接口可编辑显示名、平台、国家、负责人/组织归属和状态；待确认映射会同步平台和国家。

确认前验证店铺启用、国家不是待确认占位、至少存在来源映射且平台一致。确认动作在单个事务内更新店铺和映射、记录事件、回填订单/产品身份并重算历史观察。认证操作者来自服务器审计上下文，请求体中的 `confirmedBy` 不会被读取；时间由服务器生成。重复确认返回 `reused=true`。取消确认必须提供原因，保留店铺与来源关联用于历史审计，但从正式机会范围移除。

## 订单预览与应用

订单预览解析店铺、平台、SKU、仓库、状态、数量、订单级金额和数据窗口。客户姓名、买家/`buyer`、收件信息、地址、电话、邮箱、身份信息、联系人、账号等列在解析阶段排除；批次只保存被过滤字段数量，不保存 PII 列名或值。以 `=`, `+`, `-`, `@` 等危险前缀开始的单元格和 Excel 公式均不作为业务值，并产生 `formula_injection_risk`。

预览返回原始/有效/无效/重复行数、未匹配店铺/SKU、排除状态、PII 字段数、窗口、可应用状态、阻断原因和脱敏样本。预览不写事实表。应用只接受服务端保存的 `previewId`，不接受客户端重传解析行；校验权限、确认门禁和过期时间后，在单个数据库事务中写入。任一错误整体回滚。应用结果返回新增、更新、忽略数。

## 库存预览与应用

库存预览解析 SKU、仓库、可用/实物/锁定/在途/待发数量、来源可见销量窗口、来源预测销量和 `snapshot_at`。匹配优先键为标准化 `source_sku + source_warehouse`；空 SKU、空仓库、重复快照和不在来源范围的订单库存键均形成问题。同 SKU 多仓是多个合法粒度，不会被错误去重。

预测值和来源可见销量分别写入专用列；预测保持非实际语义，库存页面销量不会写入 `company_sales`。库存预览同样不写事实表，确认应用使用与预览完全相同的标准化结果。

## 数据质量分类

标准问题对象包含 `issue_code`, `severity`, `affected_count`, 最多五个仅含来源行号的脱敏 `sample_rows`, `blocking`, `recommended_action`。当前分类包括：

`missing_shop_mapping`, `pending_shop_confirmation`, `missing_sku`, `empty_source_sku`, `empty_source_warehouse`, `duplicate_source_row`, `invalid_order_status`, `pii_field_filtered`, `formula_injection_risk`, `inventory_key_not_visible_in_source_scope`, `current_online_source_unavailable`, `company_sales_source_unavailable`, `prediction_not_actual`, `stale_preview`, `source_scope_unconfirmed`，以及订单级金额冲突 `order_amount_conflict`。

## 权限、审计与 API

权限在原有查看、店铺管理和映射权限之外增加：

- `growth_radar.data.preview`
- `growth_radar.data.apply`
- `growth_radar.scope.confirm`

新增店铺范围审计动作 `growth_radar.shop.confirmed` 和 `growth_radar.shop.confirmation_revoked`。批次应用继续使用订单/库存应用审计动作。审计元数据只记录认证用户、请求 ID、批次/店铺/映射 ID、变化字段、应用计数、错误码和时间；不记录 Cookie、Token、客户行、完整路径或原始文件内容。

G1B1 新增或完善的 API 能力：

- `GET /api/growth-radar/shops`：按 pending/confirmed 等条件列店铺。
- `POST /api/growth-radar/shops`、`GET/PATCH /api/growth-radar/shops/:id`：店铺主数据与详情。
- `POST /api/growth-radar/shops/:id/confirm`、`POST .../revoke`、`GET .../history`：范围确认闭环。
- `GET /api/growth-radar/mappings/shops` 及既有 confirm/revoke/history：来源映射管理。
- `GET /api/growth-radar/source-batches`、`GET .../:id`、`GET .../:id/result`：来源范围、详情和应用结果。
- `POST /api/growth-radar/import/orders/preview`、`POST .../orders/apply`。
- `POST /api/growth-radar/import/inventory/preview`、`POST .../inventory/apply`。
- `GET /api/growth-radar/data-quality/issues`：支持按批次筛选。
- `GET /api/growth-radar/observations`：默认只返回正式确认范围。
- `GET /api/growth-radar/semantics/status`：完整语义状态与来源可用性。

所有写接口先做细分权限校验并进入统一 HTTP 审计；错误统一返回安全错误码，不暴露 SQLite 结构、本机路径或解析堆栈。请求路径不会执行全库 `integrity_check`。

## 测试与验证

新增 `growth-radar-g1b-backend.test.mjs`，覆盖用户要求的 39 项场景，并增加来源追溯、语义包络、问题脱敏、应用计数、读取 API 契约和店铺编辑 API 六项，共 45 个子测试（Node 测试报告含父测试为 46/46）。Growth Radar 基础专项与 G1B1 专项合计 103/103，全量测试 569/569。`npm run build` 通过；A2 专用 `doctor:growth-radar:g1b` 全部隔离检查通过，通用 Doctor 在未加载 A2 专用环境时按设计 fail-closed。路径检查、敏感赋值扫描、Git 数据库文件扫描均通过；A2 数据库与正式数据库只读检查均为 `integrity_check=ok`、`foreign_key_check=0`、最高迁移 014；3193 的 A2 HTTP 健康检查返回 `{"ok":true}` 后进程已停止。

## 已知限制与 G1B2

- 预览为进程内短期状态，服务重启后不恢复；这是为遵守现有数据库状态 CHECK 的明确取舍。
- `current_online` 当前没有权威来源，始终明确返回 unavailable，不能从历史销售推导。
- `company_sales` 当前没有权威来源，始终明确返回 unavailable，不返回伪造的零值。
- 013 的批次 `source_type` CHECK 没有 `current_online`、`company_sales`、`manual_mapping`；本节点不伪造这三类导入批次。当前在线保留独立权威快照表，人工映射使用事件表，公司销量待未来正式结构和来源决策。
- G1B2 可在本后端契约之上实现最小前端工作流、真实但隔离的脱敏验收、当前在线来源接入设计和公司级销量来源决策；不得在没有权威来源前改变语义状态。
