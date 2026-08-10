# Commerce Ops 统一数据缺口审计

> 更新说明：本文是 00:04 CST 的结构审计快照。店铺/Connector 映射、字段覆盖和多仓成本数字已由 01:40 CST 的 `COMMERCE-OPS-UNIFIED-FIELD-GAP-PREVIEW-20260808.md` 复核；店铺技术身份权威源又进一步调整为 Platform API / Connector，最终口径见 `COMMERCE-OPS-PLATFORM-API-SHOP-GAP-RESOLUTION-20260808.md`。本文中“139 家全部缺 Connector ID”“92 个名称候选”“69 个国家冲突”以及“店铺明细为身份真源”等早期结论均不再作为回填依据。

检查时点：2026-08-08 00:04 CST  
范围：生产 PostgreSQL `commerce_ops/app`、Connector SQLite `storage/lazada-oauth.sqlite`、模块查询代码  
方式：只读聚合检查；未执行生产写入或迁移

## 1. 总体判断

数据库结构没有损坏：166 个外键均已验证，核心表外键孤儿为 0。当前问题主要是：

- 来源口径漂移；
- 产品/店铺统一身份为空或冲突；
- Connector 与业务主库没有受约束关系；
- 字段值缺失和时间口径错误；
- 多个模块仍绕过公共合同直读底表。

自动审计汇总：10 类 Blocker、6 类 Error、2 类 Warning。

## 2. 表级数据缺口

| 表 / 数据集 | 当前规模 | 欠缺 | 影响 | 优先级 |
|---|---:|---|---|---|
| `growth_order_headers` | 80,500 | 80,500 无 `internal_shop_id`；80,500 无国家 | 订单不能按统一店铺/国家统计 | P0 |
| `growth_order_lines` 当前行 | 116,700 | 116,700 无产品、国家和行金额；matched=0 | Sales/Growth 产品销量和金额口径不可信 | P0 |
| `growth_inventory_snapshots` | 190,066 | 190,066 无产品；全部 country_unresolved；190,066 无 sellable/days_of_supply | 库存无法与产品包统一，可售指标不可用 | P0 |
| `product_identity_mappings` | 0 | 整表为空 | 订单/库存断开产品包的直接根因 | P0 |
| `product_skus` | 75,797 新源 | Foundation 新源身份 0；main SKU/model 各缺 5,348，sales spec 缺 4,232 | AI/Growth 仍可能引用旧产品身份 | P0/P1 |
| `product_package_rows` | 119,245 | 结构键完整；若干业务字段缺值，见下表 | 产品基础属性不完整 | P1 |
| `product_sku_current_prices` | 617,667 | 91,950 无产品名；91,950 无 country+SKU 产品映射 | 控价不能稳定追溯产品中心 | P0/P1 |
| `commerce_shop_registry` | 139 | 139 无 Connector ID、币种、控价类型；70 无 Growth ID；69 国家冲突 | 控价/API/报表无法共享店铺身份 | P0 |
| `growth_shops` | 205 | 205 国家均为 ZZ、身份均待复核 | 不能继续作为店铺主数据 | P0 |
| `commerce_shop_account_bindings` | 139 | 全部为马帮绑定，无 Lazada/Shopee API 应用绑定 | API 配置与店铺没有正式关系 | P0 |
| `platform_api_application_profiles` | 不存在 | 平台应用配置表缺失 | `application_id` 仍是自由文本 | P0 |
| `shop_external_identities` | 不存在 | 跨库店铺身份桥缺失 | 不能建立受约束 API 店铺绑定 | P0 |
| `product_package_sync_runs` | 4 | 4 次 `source_checked_at > finished_at` | 新鲜度和水位误判 | P0 |
| `price_control_sync_runs` | 49 | 49 次 `source_checked_at > finished_at` | 同步监控约 +8 小时漂移 | P0 |

## 3. 马帮订单和库存

订单：

- 80,500 个订单头；116,700 个当前订单行；
- 当前订单行映射状态：ambiguous 65,333、country_unresolved 35,059、unmatched 16,308、matched 0；
- 最新订单批次 432 条原始行：413 parsed、19 rejected；
- 当前订单行 `line_amount` 全空，不能再用已不存在的产品包 45% 价格静默代替成交额。

库存：

- 历史快照 190,066；最新批次 108,374 原始行、108,363 快照、11 rejected；
- 22 行缺 available quantity，12 行缺 available quantity 的最新批次口径需与历史审计区分；
- locked quantity、sellable quantity、days of supply 全空；
- `product_inventory_snapshots` 的 119,245 行来自产品包投影，只能是参考字段，不能与马帮库存混用。

## 4. 产品包值欠缺

119,245 行全部具备 62 个结构键，`source_row_key` 唯一，主键、国家和 SKU 均完整。主要值缺失为：

| 字段 | 缺失行 |
|---|---:|
| `color`、`jointRate`、`special_volume`、`third_category_name` | 各 119,245 |
| `developer_name` | 48,048 |
| `earliestTime` | 10,166 |
| `recentlyTime` | 10,166 |
| `sales_sku` | 7,242 |
| `net_weight` | 6,873 |
| `case_size` | 6,837 |
| `declare_code` | 6,608 |
| `specification` | 6,025 |
| `saleSpec` | 5,825 |
| `picture` | 6 |

最重要的口径断链已经复现：生产只有正式源 `ai_project_a_product_package` 119,245 行，旧源 `company_product_center` 为 0；Sales 原来的三处旧源查询会实际返回 0 行。

## 5. 控价和产品覆盖

- 当前价格点 617,667，20,660 个全局 SKU；
- 价格值 0 个非数字、0 个负数，当前来源批次均为 CA；
- 75,205 个 country+SKU 价格键中，13,812 个无法关联产品中心，占 18.37%；
- 涉及 91,950 个价格点，占 14.89%；
- 其中 3,650 个 SKU 在任何国家都不存在于产品中心；
- 未匹配键分国：ID 2,571、MY 3,111、PH 2,601、SG 858、TH 1,979、TW 726、VN 1,966。

增量效率也有缺陷：最近整点运行重复扫描 104 个批次、114,822 源行、573,950 价格点，多次 `batches_applied=0/change_count=0`；但本地共有 248 个 CA 批次。当前窗口既昂贵，又可能漏掉更早批次的原地修改。应采用可靠 `source_updated_at` 水位与索引，并安排低频全量对账。

## 6. 店铺与 Connector

业务主库：

- 店铺明细 139：Lazada 79、Shopee 60；
- `provider_shop_type` 139 行全为原始代码字符串 `1`，尚未翻译 STANDARD/MALL；
- `control_shop_type` 139 行全 UNKNOWN，currency 139 行全空；
- 69 个已连 Growth 店铺全部指向国家 ZZ，与店铺明细真实国家冲突。

Connector：

- 134 个店：Lazada 78、Shopee 56；120 个授权；
- 14 个活跃店无授权；
- Shopee 42 个授权中 36 个实际过期但 `token_status` 仍为 active；
- 78 个 Lazada legacy token 与新授权表完整重复，旧表没有更新得更晚；
- `.env` 声明 3 个 Lazada App，但只有 app-1/app-2 配置完整并被授权使用；app-3 不完整；app-1 名称“Stores 01-20”却已绑定 58 店，容量语义已失真。

跨库身份比对：

- 按平台 + 国家 + 规范化店名，仅 92 个唯一候选；
- 47 个注册表店铺无 Connector 候选；
- 42 个 Connector 店铺无注册表候选；
- provider/shop ID 精确匹配为 0，因此不能直接自动填 FK。

## 7. 代码与结构缺陷

1. Sales 产品包读取旧源，已在本次改为统一来源常量；
2. Sales 仍依赖新产品包不再提供的 `price_tier_45`，金额规则待确认；
3. `CommerceShopRegistryRepository` 原先在 PostgreSQL 路径使用 SQLite `?` 占位符；本次已接入统一转换层并通过生产只读筛选验证；
4. Growth Radar V2 原先对 `timestamptz paid_at` 使用 `SUBSTR`；本次已改为上海时区 PostgreSQL 表达式并通过生产只读 readiness 验证；
5. Product Center 仍保留数据库同步和手工 Excel 两条可写入口，未来可能重建旧 source_system；
6. `growth_shops`、`commerce_shop_registry`、Connector shops、Listing/履约侧车形成多套店铺身份；
7. Fulfillment 仍实时重新抓马帮订单并使用独立店铺 JSON，不能成为统计真源；
8. Connector 的 `lazada_store_tokens` 与新授权表重复保存敏感数据。

## 8. 数据库基础设施风险

这些不属于“表格缺值”，但会影响统一底座上线：

- 159 个生产 FK 中有 71 个缺少支持索引，覆盖 41 张表；大表包括价格快照、价格变更、订单库存链接；
- 有 4 组完全重复索引；
- `price_control_price_snapshots.sync_run_id` 等大 FK 查询/清理存在性能风险；
- 数据盘、WAL 归档和逻辑备份都在 D 盘，没有异盘/异机副本；
- WAL 归档约 20.95 GB，未找到保留清理策略；
- Windows 计划任务中未确认到自动备份、恢复演练和监控任务，现有策略主要停留在文档；
- `commerce_app` 可更新/删除审计表，审计尚未在数据库层强制 append-only；
- 生产没有流复制或 replication slot；
- Sales 日报曾因加载 10.8 万条宽库存原始 JSON 超过 30 秒，应改为数据库聚合或物化事实。

## 9. 修复顺序

1. 应用统一数据目录、标准视图、外部店铺身份和 API Profile 候选迁移；
2. 注册正式产品包来源，重建产品身份，回填订单/库存；
3. 以店铺明细为主数据，建立候选确认队列，补币种和店铺类型；
4. 建立 API application -> Foundation account -> shop binding，并修复授权状态；
5. 修复 UTC 写入规则；
6. 处理 13,812 个控价未匹配 country+SKU；
7. 切换模块到标准合同并双读校验；
8. 最后单独审批旧身份、重复 Token、重复库存投影和旧写入口的下线。
