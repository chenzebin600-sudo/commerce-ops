# 马帮订单与库存自动入库

## 结论

马帮订单和库存采集完成后，系统会先保留 Excel 来源证据，再通过增长雷达的标准化解析器写入 SQLite。正式数据库默认由 `SCHEDULER_DB_PATH` / `DATABASE_PATH` 指定；当前环境为：

`storage/commerce-ops.sqlite`

Excel 文件仍由 `export_files` 记录元数据，物理文件位于 `storage/exports/mabang`。业务明细不再只存在于页面内存或 Excel 中。

## 入库表

| 数据层 | 表 | 用途 |
| --- | --- | --- |
| 公共批次 | `growth_source_batches` | 每次订单或库存来源批次、文件、哈希、采集范围、状态和操作者 |
| 订单原始层 | `growth_order_raw_rows` | 保留过滤个人信息后的订单源行和解析状态 |
| 订单标准层 | `growth_order_headers` | 标准订单头，一张订单一条当前事实 |
| 订单标准层 | `growth_order_lines` | 标准订单商品明细，包含 SKU、仓库、数量和有效状态 |
| 库存原始层 | `growth_inventory_raw_rows` | 保留库存源行和解析状态 |
| 库存标准层 | `growth_inventory_snapshots` | 按“快照时间 + SKU + 仓库”保存库存事实 |
| 衍生关系 | `growth_order_inventory_links` | 按“SKU + 仓库”关联订单明细与库存快照 |
| 衍生指标 | `growth_sku_warehouse_sales_metrics` | SKU/仓库粒度的自有订单销量与来源库存指标 |

表结构由以下迁移提供：

- `migrations/013_deterministic_growth_radar_foundation.sql`
- `migrations/014_deterministic_growth_radar_scope_and_linkage.sql`

## 执行流程

### 手工获取

`POST /api/mabang-data/collect`

1. 从马帮获取订单或库存。
2. 用与正式导出一致的工作簿格式生成临时 Excel。
3. 解析、校验并过滤订单个人信息字段。
4. 在一个数据库事务中写入原始层、标准层和衍生层。
5. 入库成功后才返回采集结果；响应中的 `persistence.batchId` 可追踪到 `growth_source_batches.id`。
6. 临时 Excel 删除，页面预览数据仍只保留 30 分钟。

### 定时获取

`scheduler.mjs` 的任务执行器：

1. 获取马帮数据并生成正式 Excel。
2. 将 Excel 和文件哈希登记到 `export_files`。
3. 执行 `persist_collected_data` 步骤，写入增长雷达表。
4. 入库成功后再发送成功通知。
5. 入库失败时，任务状态为 `failed`，`error_stage` 为 `persist_collected_data`；已经生成的 Excel 保留，便于排查和重试。

### 幂等规则

- 订单用“列、数据行、查询范围”生成业务幂等键；相同日期范围和相同结果不会重复建批次。
- 库存额外使用来源快照时间；同一来源快照重复获取不会重复入库，不同快照时间可以形成新库存事实。
- 来源 Excel 的真实 SHA-256 和业务幂等键分开保存：前者用于文件证据，后者用于防重。

## 当前正式库补录结果

2026-07-24 已将现有的最新订单与库存 Excel 补录到正式数据库：

| 表 | 行数 |
| --- | ---: |
| `growth_source_batches` | 2 |
| `growth_order_raw_rows` | 2,659 |
| `growth_order_headers` | 1,582 |
| `growth_order_lines` | 2,114 |
| `growth_inventory_raw_rows` | 1,440 |
| `growth_inventory_snapshots` | 1,438 |
| `growth_order_inventory_links` | 2,114 |
| `growth_sku_warehouse_sales_metrics` | 1,438 |

批次 ID：

- 订单：`a4f9c3bf-8981-4e7e-b907-45e43483543a`
- 库存：`953051fa-24b7-4ad4-b3c1-be166748846f`

补录前一致性备份：

`storage/backups/commerce-ops-pre-mabang-data-2026-07-24T09-08-23-668Z.sqlite`

订单原始文件中的 8 个个人信息字段未写入增长雷达原始数据。
