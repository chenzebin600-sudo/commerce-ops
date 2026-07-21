# 确定性货盘增长雷达 G1A 数据底座

本文记录 G1A“订单事实、店铺身份与 SKU 映射数据底座”的实现与验收边界。G1A 只提供可追溯的数据管理能力，不包含机会评分、店铺推荐、行动清单、AI 分析或平台上架。

## 1. 主线同步结果

- 支线：`feature/deterministic-product-growth-radar`
- 同步前支线提交：`47cf7a98b8de5dfa9b27b5547b8bea92c684a689`
- 实际稳定主线基准：`4aca65297c62a9be97d22febcd0f8f1dbd67f503`
- 同步方式：干净 rebase，无冲突。
- 同步后 G0 提交：`d2a0408193ba6aeb5dbdd4d735d719671ad9fbd9`
- 同步后 G0.5 数据合同提交：`9ff68c6efa67b94b3414655c0af7f057fc3fd963`
- 主线 Listing AI 合并后的基线文档提交：`53aee1dae62d29c4fddc97f4a8e447bff7cfb9df`
- G0 与 G0.5 文档均保留；文档中的本机绝对路径已改为脱敏占位说明，数据审计结论未删除。

## 2. 迁移编号

同步后主线最高正式迁移为 `012_product_listing_ai_content_images.sql`，因此 G1A 使用：

`013_deterministic_growth_radar_foundation.sql`

迁移通过正式迁移入口在隔离数据库执行。隔离库 `PRAGMA integrity_check` 为 `ok`，`PRAGMA foreign_key_check` 为 0。正式数据库没有执行迁移或写入。

## 3. 新增表结构

迁移新增 14 张表：

1. `growth_source_batches`：订单、库存及后续货盘来源批次，保留来源哈希、查询范围、文件名、行数和幂等键。
2. `growth_order_raw_rows`：订单 Excel 的脱敏原始行、类型、源行号、行哈希和解析状态。
3. `growth_order_headers`：订单级事实和订单级金额。
4. `growth_order_lines`：订单商品明细、技术行身份、数量与产品映射状态。
5. `growth_shops`：稳定内部店铺主数据。
6. `growth_shop_source_mappings`：来源店铺名到内部店铺的映射。
7. `product_identity_mappings`：来源平台、国家、SKU 到产品中心 SKU 的映射。
8. `growth_mapping_issues`：店铺、国家、SKU、订单键和明细键问题队列。
9. `growth_inventory_raw_rows`：库存 Excel 的原始行框架。
10. `growth_inventory_snapshots`：只保存已确认来源字段的库存快照框架。
11. `growth_data_quality_issues`：可追溯到批次与实体的数据质量问题。
12. `growth_mapping_events`：店铺和产品映射确认/撤销的业务审计事件。
13. `growth_shop_sku_observations`：有效历史订单形成的 `historical_observed` 事实。
14. `growth_shop_sku_coverage_snapshots`：为权威 `current_online` 数据预留，G1A 不写入。

原始订单中的客户、买家、收件、地址、电话、邮箱、账号、备注等身份或联系字段不进入原始值 JSON；被排除的表头单独写入 `redacted_fields_json`，以同时满足源行追溯和隐私最小化要求。

## 4. 订单头和订单行模型

每个来源商品行都先进入 `growth_order_raw_rows`，不会因订单号相同而合并。随后按订单业务键生成一个 `growth_order_headers`，再为每个可用来源行生成 `growth_order_lines`。

订单级字段只进入订单头；商品 SKU、数量、商品名和技术行身份进入订单行。真实样例的 1,244 个来源商品行形成 341 个订单头和 1,244 个当前订单行，多行订单不会重复生成订单头。

## 5. 订单业务键

当前键版本为 `mabang_order_v1`，业务键由以下标准化字段计算 SHA-256：

- 平台
- 来源店铺名称
- 来源订单号

键版本和键值同时保存。若同一来源订单号在不同平台或来源店铺下形成多个业务键，则记录 `duplicate_order_key`，不会静默合并。

订单行键版本为 `mabang_order_line_occurrence_v1`。当前行身份由订单业务键、SKU、平台 SKU、仓库、SKU 明细、商品名、数量、单价等稳定字段签名，再加同签名组内出现序号组成。出现序号是技术身份，不是马帮官方明细 ID；`dedupe_confidence` 明确标记为 `technical_occurrence`。

## 6. 跨批次幂等策略

- 批次级：`source_type + idempotency_key` 唯一。默认使用来源文件 SHA-256 作为幂等键。
- 原始层：每个批次完整保留所有来源行，唯一键为 `batch_id + source_row_number`。
- 标准订单层：按带版本的订单业务键更新，不重复增加订单数。
- 标准明细层：按带版本的技术行键更新；同一订单重处理前先把旧行标记为非当前，再恢复本批次出现的当前行。
- 状态变化：更新订单头、订单行、最后来源批次、最后观察时间和修订号，不删除历史原始行。

测试已验证：重复应用同一幂等键不会重复写入；第二批次中的订单状态变化会更新标准事实，同时订单头和当前明细数量保持稳定。

## 7. 订单金额防重复方案

订单金额只读取 `订单核算金额（人民币）`，并在订单头保存一次。若同一订单多行中的该字段不一致，订单头金额保持 `NULL`，记录 `ORDER_AMOUNT_CONFLICT`。

订单行 `line_amount` 始终为 `NULL`，`line_amount_status = unavailable`。系统不平均分摊订单金额，也不声称具备精确 SKU GMV。当前可以安全聚合 SKU 件数、SKU 涉及订单数、店铺订单数和订单头金额。

## 8. 有效订单口径

- `已作废`：`invalid_cancelled`
- `已发货`：`valid`
- `配货中`、`待处理`：`pending`
- 其他状态：`unconfirmed`

所有状态的原始行和标准事实都保留。`invalid_cancelled` 不进入历史销量、订单数和件数聚合，但不会被物理删除。API 和页面分别展示原始行、标准订单与作废订单数量。

## 9. 退款数据限制

真实订单文件没有可靠退款金额、退款件数或部分退款影响。G1A 将退款数据状态固定为 `unavailable`，不计算净销售金额、净销售件数、精确退款率、精确售后率或部分退款影响。

## 10. 店铺稳定身份规则

`growth_shops.id` 是稳定业务身份；展示名称不是身份键。店铺支持新增、编辑名称、平台、国家、负责人、主营类目范围和启停状态。店铺改名通过更新主数据完成，不自动创建新店铺。

来源店铺名称不会进行相似度自动确认。首次出现时生成 `unmatched` 映射与 `shop_unmatched` 问题，等待人工确认。人工确认和撤销都写入业务映射事件和统一 HTTP 审计日志。

## 11. 店铺到国家映射流程

1. 来源系统、平台和标准化来源店铺名定位来源映射。
2. 人工选择同平台内部店铺。
3. 确认后写入内部店铺 ID 和店铺国家。
4. 回填该来源店铺的订单头。
5. 使用店铺国家重新处理当前订单行的产品身份。

撤销映射后，相关订单头的内部店铺和国家恢复为 `NULL`，订单行重新标记为国家未确认、歧义或未匹配。真实样例识别 16 个来源店铺；本节点未擅自创建或确认真实店铺，因此确认映射为 0、待确认映射为 16。

## 12. 国家 + SKU 产品匹配流程

1. 店铺国家未确认时，只收集候选，不生成产品映射。
2. 国家确认后，按规范国家别名和标准化来源 SKU 查询产品中心。
3. 仅一个精确候选时标记 `matched`，来源为 `exact_country_sku`。
4. 无候选时标记 `unmatched`。
5. 多候选时标记 `ambiguous`。

国家别名覆盖 TH/泰国、PH/菲律宾、MY/马来/马来西亚、ID/印尼/印度尼西亚、VN/越南及英文别名。禁止使用商品名称模糊匹配，也禁止跨国家随机选择同 SKU。

## 13. SKU 歧义处理

店铺国家未确认时：

- SKU 在多个国家出现：`sku_ambiguous`
- SKU 只有一个跨域候选：`country_unresolved`
- SKU 不存在：`sku_unmatched`

问题保存来源批次、来源行、来源值、候选 ID/国家/SKU 与原因。人工确认只能选择相同国家和 SKU 的精确产品候选。确认和撤销会回填当前事实并生成 `growth_mapping_events`。

真实样例的 165 个唯一 SKU 中，82 个为跨国家多候选，82 个为国家待确认的单候选，1 个无候选。由于真实店铺国家均未人工确认，自动产品映射为 0；82 个跨国家 SKU 均未被静默匹配。

## 14. 库存字段审计

本节点没有收到真实库存文件，未执行马帮登录或新的真实采集。库存解析器和数据合同已覆盖：

- SKU / 库存 SKU 编号
- 仓库
- 可用库存量
- 实际库存 / 仓位库存
- 锁定库存
- 在途量 / 采购在途量
- 未发货量 / 调拨未发货
- 预测日销量
- 数据更新时间

解析器逐行保存来源值、类型、哈希和源行号；公式单元格不作为业务值使用，并记录 `FORMULA_CELL_REDACTED`。真实库存字段语义仍未完成生产审计。

## 15. 库存事实状态

没有来源值的库存字段保存 `NULL`，不会填 0。库存快照明确保留：

- `sellable_quantity = NULL`
- `sellable_quantity_status = unconfirmed`
- `days_of_supply = NULL`
- `days_of_supply_status = unavailable`
- 来源预测日销量缺失时为 `NULL / unavailable`，存在时仍为 `unconfirmed`

测试样例验证了原始行和快照框架，但不构成真实库存生产验收。库存数据不参与机会判断。

## 16. historical_observed 规则

`growth_shop_sku_observations` 只允许 `coverage_semantic = historical_observed`。聚合键为平台、来源店铺与来源 SKU，记录首次/最后观察时间、有效订单数、有效明细数、有效件数以及首末来源批次。

聚合查询排除 `invalid_cancelled` 订单。真实订单样例形成 189 个来源店铺 + SKU 历史观察身份。该事实只表示历史上在订单中观察到过，不表示当前仍在线。

## 17. current_online 限制

G1A 仅预留 `growth_shop_sku_coverage_snapshots` 和 `/api/growth-radar/coverage/status`。由于没有平台在线状态的权威来源：

- 不从历史订单推断当前在线。
- 不写入当前覆盖快照。
- API 返回 `currentOnlineImplemented = false` 和 `currentOnlineAuthority = unavailable`。
- 页面明确展示“当前在线未实现”。

真实隔离验证的 `currentOnline` 数量为 0。

## 18. 数据质量问题

`growth_data_quality_issues` 保存稳定问题码、严重级别、批次、实体、脱敏说明、源行上下文和处理状态。公开错误响应包含 `code` 与 `issue_code`，不会包含原始敏感值或本机文件路径。

真实订单样例产生 1 个 warning：`ORDER_QUANTITY_TOTAL_MISMATCH`，表示某订单的来源 `SKU总数量` 与商品行数量合计不一致。该问题没有阻断其他事实入库，也没有被静默修正。

## 19. 权限设计

新增权限：

- `growth_radar.data.view`
- `growth_radar.data.import`
- `growth_radar.shop.manage`
- `growth_radar.mapping.view`
- `growth_radar.mapping.confirm`
- `growth_radar.quality.view`

权限可通过部署环境配置；店铺范围可通过授权店铺 ID 限定。权限判断发生在 API 访问层，不改变或删除原始事实。映射确认权限独立于查看权限，确认人和请求 ID 同时进入业务事件与统一审计。

## 20. API 列表

核心接口：

- `GET /api/growth-radar/capabilities`
- `GET /api/growth-radar/summary`
- `GET /api/growth-radar/freshness`
- `GET /api/growth-radar/coverage/status`
- `GET /api/growth-radar/source-batches`
- `GET /api/growth-radar/source-batches/:id`
- `GET /api/growth-radar/data-quality/issues`
- `GET|POST /api/growth-radar/shops`
- `PATCH /api/growth-radar/shops/:id`
- `GET /api/growth-radar/mappings/shops`
- `GET /api/growth-radar/mappings/shops/unresolved`
- `POST /api/growth-radar/mappings/shops/confirm`
- `POST /api/growth-radar/mappings/shops/revoke`
- `GET /api/growth-radar/mappings/shops/:id/history`
- `GET /api/growth-radar/mappings/products`
- `GET /api/growth-radar/mappings/products/unresolved`
- `POST /api/growth-radar/mappings/products/confirm`
- `POST /api/growth-radar/mappings/products/revoke`
- `GET /api/growth-radar/mappings/products/:id/history`
- `POST /api/growth-radar/import/orders/preview`
- `POST /api/growth-radar/import/orders/apply`
- `POST /api/growth-radar/import/inventory/preview`
- `POST /api/growth-radar/import/inventory/apply`

预览只保存在有时限的内存缓存，不写数据库。应用必须显式提交预览 ID 和幂等键，并创建或复用来源批次。API 只返回来源文件名，不返回本机路径。

## 21. 页面截图

管理页面提供 8 个允许的数据视图：来源批次、订单预览、库存预览、店铺主数据、待处理店铺、待处理 SKU、数据质量和新鲜度。页面没有机会评分、推荐榜单、店铺缺口或行动清单。

本次页面实测时，应用内浏览器插件在初始化阶段返回 `Cannot redefine property: process`。按照浏览器控制技能的恢复流程重连后仍失败，因此没有使用独立 Playwright、外部浏览器控制或伪造截图替代。待应用内浏览器运行时恢复后，需要补齐以下 7 张截图：

1. 数据来源批次
2. 订单导入预览
3. 店铺主数据
4. 店铺映射待确认
5. SKU 映射待确认
6. 数据质量问题
7. 库存未提供或未确认状态

## 22. 真实订单样例验证

真实 Excel 只读解析并写入由正式数据库只读备份生成的隔离验证库；原始 Excel 未修改、未复制到 Git，验证数据库未纳入 Git。

| 指标 | G0.5 审计 | G1A 预览 | G1A 隔离入库 |
|---|---:|---:|---:|
| 原始商品行 | 1,244 | 1,244 | 1,244 |
| 唯一订单 / 标准订单头 | 341 | 341 | 341 |
| 标准订单商品行 | 1,244 | 1,244 | 1,244 |
| 多行订单 | 116 | 116 | 已验证 |
| 单订单最大行数 | 33 | 33 | 已验证 |
| 已作废订单 | 99 | 99 | 99 |
| 来源店铺 | 16 | 16 | 16 个待确认 |
| 唯一 SKU | 165 | 165 | 已验证 |
| 跨国家多候选 SKU | 82 | 82 | 82 个歧义问题 |
| 未匹配 SKU | 1 | 1 | 1 个未匹配问题 |

隔离库结果：完整性 `ok`、外键问题 0、敏感表头在原始值 JSON 中命中 0。订单金额只进入订单头，行金额均为 `NULL / unavailable`。

## 23. 真实库存样例验证

没有找到或收到用户明确提供的真实库存文件。因此：

- 没有执行账号凭证搜索。
- 没有登录马帮。
- 没有发起新的库存采集。
- 没有真实库存 SHA-256 或表头审计结论。
- 没有宣布库存事实生产验收通过。

本节点只完成库存迁移、解析接口、预览/应用分离、测试样例和未确认语义。

## 24. 测试结果

G1A 新增测试文件覆盖 49 个测试结果，全部通过。覆盖范围包括迁移、权限、预览无写入、订单头/行拆分、订单金额、作废订单、退款限制、跨批次幂等和状态更新、敏感字段排除、店铺映射、国家 + SKU、确认/撤销事件、历史观察、库存未确认语义、API 审计和 8 个页面视图。

- 全量测试：477 项，476 通过，1 项已知环境失败。
- 唯一失败：`only the main origin is needed for an authenticated advertising module`，错误为外部广告子项目启动时 `spawn ... node.exe ENOENT`。未修改该测试断言。
- Build：通过；便携路径检查通过；前端检查为 393 个唯一元素 ID、185 个静态绑定。
- Doctor：隔离环境通过；广告子项目采用 external 模式时按预期给出 warning，其余运行时、Python、SQLite、存储、Chrome、访问策略和端口检查均通过。

## 25. 当前仍未确认口径

- 真实库存文件的工作表、表头和值域。
- “可用库存量”是否等同于业务可售库存。
- 实际库存、锁定库存、待发库存、在途库存之间的权威公式。
- 来源预测日销量的定义、时间窗和可信度。
- 正式可售天数公式。
- 可靠退款金额、退款件数、部分退款和售后口径。
- 马帮订单商品行的官方稳定明细 ID；当前只使用技术出现序号。
- 16 个真实来源店铺到内部店铺/国家/平台的人工确认结果。
- 权威 `current_online` 数据源和有效期规则。

## 26. G1B 进入条件

| 条件 | 当前状态 |
|---|---|
| 至少一份真实库存文件完成字段审计 | 未满足 |
| 可用库存字段语义有初步确认 | 未满足 |
| 店铺主数据可以维护 | 已满足 |
| 主要来源店铺可映射到国家和平台 | 功能已满足，真实 16 店尚未人工确认 |
| 订单事实可稳定幂等导入 | 已满足 |
| SKU 歧义不会被静默合并 | 已满足 |
| 测试质量门达到要求 | G1A 测试已满足；全量质量门以最终交付汇报为准 |

由于真实库存审计、可售库存语义和真实店铺映射尚未完成，本节点结束后暂停，不进入 G1B、G2 或 G3，也不开发公司已验证产品池、机会评分或店铺推荐。
