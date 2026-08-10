# Commerce Ops SQLite 迁移可行性报告

审计日期：2026-08-05  
审计方式：只读文件、DDL、数据、代码访问边界与本机 PostgreSQL 环境审计  
工作分支：`codex/vue-mainline-integration`  
审计基线 HEAD：`89ccd7ebc0e80c6c19079c3b4d0b7e6bdae0992f`

## 1. 执行结论

Commerce Ops **适合迁移 PostgreSQL**，但当前只具备“基础设施和部分 Provider 原型”，尚不具备生产切换条件。

结论分为两部分：

- 数据本身健康：正式 SQLite `integrity_check=ok`、外键异常为 0，2,000,771 行数据中的 JSON 和时间字段未发现转换错误，也没有把图片或 Excel 二进制塞入主库。
- 当前迁移链路不完整：生产组合根仍强制创建 `SqliteProvider`，旧 F3 只覆盖 36 张表，而正式库已有 88 张表；当前类型推断、表达式索引、自引用外键和多个 SQLite 专属 Repository 会阻止直接切换。

因此：

> 可迁移性：高。直接切换成熟度：低。推荐先完成 Provider 生产化和影子迁移，再按域切换。

## 2. 数据库文件现状

### 2.1 正式主库

- `storage/commerce-ops.sqlite`：1,746,882,560 bytes（1665.96 MiB）
- `storage/commerce-ops.sqlite-wal`：56,159,752 bytes（审计时实时值）
- `storage/commerce-ops.sqlite-shm`：32,768 bytes

### 2.2 独立 SQLite 数据孤岛

- `storage/integrations/mabang-listing/publisher.db`：当前马帮刊登执行状态库，约 100 KiB。
- `integrations/mabang-getdata/mabang-listing-dashboard/work/publisher.db`：旧/默认工作目录副本，约 96 KiB，需在迁移前确认是否仍被任何启动方式使用。
- `storage/mabang-fulfillment.sqlite`：自动发货服务默认路径；当前未发现落盘文件，但 `fulfillment-service/repository.mjs` 会在服务启动时直接创建 SQLite 库。

### 2.3 备份和非业务数据库

`storage/backups/` 内存在多轮迁移前备份，最大备份约 1.63 GiB；`storage/validation/` 是隔离验证库；`storage/chrome-user-data/` 下的 `.db` 属于浏览器缓存，不是 Commerce Ops 业务数据，不应迁移。

## 3. 主库结构与容量

- 表：88
- 字段：1,527
- 视图：15
- 触发器：0
- 索引（含隐式索引）：301
- 外键声明：148
- 总行数：2,000,771
- 页大小：4,096 bytes
- 空闲页：0
- 最新正式迁移：`024_price_control_automation.sql`
- 已应用迁移数：23（按治理规则没有 016）

完整字段、主键、外键、索引和逐表行数见：

- [SQLite Schema Inventory](./COMMERCE-OPS-SQLITE-SCHEMA-INVENTORY-20260805.md)
- 同目录 `COMMERCE-OPS-SQLITE-SCHEMA-TABLES-01-20260805.md` 至 `08` 为 88 张表的详细附录。

### 3.1 按业务域统计

| 业务域 | 表数 | 行数 | 含索引存储 |
|---|---:|---:|---:|
| Growth Radar / 销售事实 | 26 | 931,562 | 906.02 MiB |
| 商品 | 28 | 531,947 | 405.41 MiB |
| 价格控制 | 4 | 396,888 | 258.06 MiB |
| 图片采集元数据 | 5 | 63,511 | 49.86 MiB |
| 审计 | 1 | 41,994 | 28.81 MiB |
| Foundation 主数据与任务 | 10 | 25,499 | 14.34 MiB |
| 调度与集成 | 7 | 9,303 | 3.16 MiB |
| 文件元数据 | 6 | 44 | 0.16 MiB |

## 4. 核心数据现状

### 4.1 订单与销售

- `growth_order_headers`：79,768
- `growth_order_lines`：115,868
- `growth_order_raw_rows`：150,374
- `growth_order_inventory_links`：344,576

### 4.2 库存

- `growth_inventory_raw_rows`：61,560
- `growth_inventory_snapshots`：61,548
- `growth_sku_warehouse_sales_metrics`：60,110
- `product_inventory_snapshots`：21,978

### 4.3 商品与 SKU

- `product_skus`：18,347
- `product_models`：6,500
- `product_package_rows`：21,714
- `product_packaging_profiles`：18,347
- `product_cost_snapshots`：18,602
- `product_sku_current_prices`：324,962

### 4.4 图片与资产

- `product_media_assets`：6,583
- `product_media_links`：33,764
- `mabang_sku_image_discoveries`：22,687
- `mabang_sku_image_discovery_images`：40,039
- `mabang_sku_image_batches`：210

数据库只保存文件元数据和关联，图片、Excel、报告仍在文件系统。这一边界应保留，并在未来替换为 MinIO 对象键。

### 4.5 任务、审计与 Agent

- `foundation_tasks`：217；`foundation_task_events`：223
- `scheduled_export_tasks`：4；`scheduled_export_runs`：16；运行事件：216
- `operation_audit_events`：41,994
- Agent Run、Tool Call、Gateway 和 Evaluation 当前复用 `operation_audit_events` 的 JSON 元数据，而不是独立关系表。
- 当前可观测记录包含 2 次 Agent Run 启动、1 次完成、1 次失败、8 次 Tool 调用和 4 次统一 Gateway 成功记录。

## 5. 数据访问架构审计

### 5.1 已完成的基础

- `DatabaseProvider`、`SqliteProvider`、`PostgresqlProvider` 已存在。
- 14 个主要 Repository 文件已经使用 Provider 查询、方言前缀和占位符接口，共约 8,518 行。
- Product、Growth Radar、Mabang Images、Foundation、Sales Assortment、AI Context 的主要 Repository 已具备部分 PostgreSQL 意识。
- PostgreSQL Provider 支持连接池、事务、UTC 时区、`search_path` 和 statement timeout。

### 5.2 生产组合根仍是 SQLite

`lib/data/data-access.mjs` 无条件执行：

1. 创建 `SqliteProvider`；
2. 创建 `SchedulerDatabase`；
3. 在应用启动时执行 SQLite migration；
4. 注入 SQLite 专属审计、文件和调度 Repository。

`server.mjs`、`scheduler.mjs` 和 `price-control-sync.mjs` 都调用该组合根。设置 `DATABASE_PROVIDER=postgres` 当前不会让生产服务切换数据库。

### 5.3 SQLite 专属访问

以下生产模块仍直接依赖 `DatabaseSync`、`.prepare()`、`PRAGMA`、`BEGIN IMMEDIATE` 或 `resolveSqliteProvider`：

- `lib/data/sqlite/sqlite-scheduler-repository.mjs`
- `lib/data/sqlite/sqlite-audit-repository.mjs`
- `lib/files/file-repository.mjs`
- `lib/files/file-lifecycle-repository.mjs`
- `lib/files/file-review-repository.mjs`
- `fulfillment-service/repository.mjs`
- Python 马帮刊登 `mabang_publisher.py` 使用独立 `sqlite3`。

三层 Account/ScheduledTask/ScheduledRun Repository 只是委托给 SQLite Scheduler Repository，并非真正的跨库实现。

### 5.4 Provider-aware Repository 仍有方言泄漏

- Foundation 和 Price Control 探活查询使用 `sqlite_master`。
- Price Control 使用 `INSERT OR IGNORE`。
- Agent Observability 使用 SQLite `json_extract`。
- 部分查询把布尔字段按 `0/1` 比较；目标 PostgreSQL 若改为 `boolean` 必须同步改写。
- 当前 F4 兼容测试只对 14 张基础表执行通用 CRUD 合同，并未执行真实业务 Repository、88 张正式表或完整服务链路。

## 6. 现有 PostgreSQL 能力审计

本机环境已经具备：

- PostgreSQL 18.4，Windows 服务运行中且自动启动。
- `psql`、`pg_dump`、`pg_restore`、`pg_ctl` 可用。
- 生产数据库 `commerce_ops` 可只读连接，目前 `app` schema 为 0 张表。
- 测试数据库 `commerce_ops_migration_test` 可连接，目前为 38 张表，是旧 F3 演练残留。
- Docker Desktop 未安装，但本机原生 PostgreSQL 已足够，不需要 Docker 才能迁移。
- C 盘审计时约 47.4 GiB 可用，D 盘约 150.7 GiB 可用。

现有 `docs/postgresql-f3-schema.sql` 仅有 36 张表，生成于 2026-07-21，不包含 023/024，更不能代表当前 88 表正式库。

## 7. 转换器真实数据预检

对 2,000,771 行、1,527 个字段执行了当前转换器的只读归一化检查。

### 7.1 通过项

- JSON 字段未发现非法 JSON。
- 时间戳和日期未发现无法解析值。
- SQLite 外键检查为 0。
- 所有 88 张表都有主键。

### 7.2 阻断项

当前转换器按“TEXT 且字段名为 `id` 或以 `_id` 结尾”推断 UUID，造成 827,614 个字段值无法转换。主要包括：

- 396,815 个 SHA-256 价格快照 ID 被误判 UUID。
- 324,962 个价格来源快照 ID 被误判 UUID。
- 79,768 个平台订单号被误判 UUID。
- Foundation 的命名空间 ID（如 `foundation:task:*`）被误判 UUID。
- 中文负责人、规则代码、外部业务号也被误判 UUID。

此外：

- 表达式/部分索引 `uq_price_control_one_running_sync` 使当前 schema 生成器直接失败。
- `product_categories` 和 `mabang_sku_image_batches` 有自引用外键，当前拓扑排序器错误地将其判为不可迁移循环。
- BOOLEAN_COLUMNS 白名单仅覆盖早期字段，不能作为 88 表长期类型合同。

这些是迁移工具问题，不是正式数据损坏。

## 8. 当前架构优点

可以保留的能力：

1. 订单头/行、库存快照、商品主数据、外部身份映射已经形成明确事实层。
2. 图片与文件只存元数据，不存大 BLOB。
3. 迁移链、审计、任务事件和分析快照具备可追溯性。
4. 外键零异常，主键完整。
5. 主要业务 Repository 已经开始使用 Provider 协议和参数化 SQL。
6. PostgreSQL 角色、测试库、连接池和基础兼容测试已有起点。

## 9. 风险矩阵

| 风险 | 级别 | 影响 | 处理要求 |
|---|---|---|---|
| 生产组合根硬绑 SQLite | P0 | 服务无法真正切库 | 先实现 Provider factory 和两套组合根 |
| 旧 F3 仅覆盖 36/88 表 | P0 | 丢表、丢数据 | 从正式只读快照重新生成显式目标 DDL |
| 827,614 个字段误判 UUID | P0 | 批量迁移立即失败 | 建立显式字段类型 manifest，禁止命名猜测 |
| 表达式索引和自引用 FK 不支持 | P0 | DDL/装载失败 | 专项转换；FK 后建并验证 |
| SQLite 专属 Repository | P0 | 调度、文件、审计、发货不可用 | 实现 PostgreSQL Repository 合同 |
| Agent Observability JSON 方言 | P1 | 监控页面失败 | 改为 JSONB 操作符或第一方 Agent 表 |
| 主库实时 WAL 写入 | P1 | 快照后发生数据漂移 | 在线备份 + 有界变更捕获 + 最终短暂停机 |
| publisher/fulfillment 数据孤岛 | P1 | 刊登与发货状态割裂 | 单独纳入或明确延期边界 |
| SQLite 同步 API 与 PG 异步 API | P1 | 调用链行为变化 | 按 Repository 服务逐条做 async contract 测试 |
| 无组织/租户键 | P2 | 未来多组织隔离困难 | 目标模型引入 `organization_id` |
| 单表审计承载 Agent 观测 | P2 | JSON 查询和留存成本上升 | 新增 AI 可观测专表并保留审计引用 |

## 10. 必须修改项

在生产切换前必须完成：

1. 用显式 schema manifest 代替 UUID/boolean/date 命名推断。
2. 重新生成覆盖 88 表和 15 视图的 PostgreSQL staging DDL。
3. 支持表达式索引、自引用外键和 sequence reset。
4. 将 `openCommerceDataAccess` 改为由配置选择 Provider，但默认仍保持 SQLite。
5. 为 Scheduler、File、Audit、Fulfillment 建立真实 PostgreSQL Repository。
6. 改写 `sqlite_master`、`json_extract`、`INSERT OR IGNORE` 等方言。
7. 真实 Repository 合同覆盖核心读写路径，而不是只测通用 CRUD。
8. 对主库、刊登库和发货库分别定义迁移边界。
9. 建立逐表 count、digest、FK、unique、关键业务查询对账。
10. 完成影子读取和受控回滚演练后才允许切换。

## 11. 可以保持项

- 当前 SQLite 正式库在迁移准备阶段继续作为唯一写入源。
- 现有业务 ID 不强制改写为 UUID；外部 ID 和命名空间 ID继续使用 `text`。
- 已有订单、库存、商品、图片、任务、审计数据不做破坏式重建。
- Agent Prompt、业务规则、Context 和 Tool 逻辑保持不变，只替换持久化实现。
- MinIO 不作为 PostgreSQL 切换前置条件。

## 12. 可行性判定

| 目标 | 当前判断 |
|---|---|
| 在测试库重建当前 schema | 可行，但需先修正转换器 |
| 将 200 万行数据迁入测试 PostgreSQL | 可行，容量不是阻断 |
| 今晚直接把生产切到 PostgreSQL | 不安全，不建议 |
| 今晚完成影子库第一轮全量装载 | 修正 P0 工具后可争取，不等于生产可用 |
| 日报和 Agent Monitoring 直接在 PG 上运行 | 当前未证明 |
| 自动发货服务直接在 PG 上运行 | 当前不支持 |

最终结论：**当前应进入 PostgreSQL Migration Foundation V2，而不是执行生产迁移。**
