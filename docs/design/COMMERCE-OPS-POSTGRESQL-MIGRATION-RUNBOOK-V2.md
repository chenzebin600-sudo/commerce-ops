# Commerce Ops PostgreSQL 迁移方案与执行手册 V2

版本：2.0  
日期：2026-08-05  
状态：规划完成，尚未执行生产迁移

## 1. 推荐结论

推荐采用：

> **方案 C 分域迁移 + 周期性影子快照 + 最终短暂停机切换。**

不推荐今晚直接执行 SQLite -> PostgreSQL 生产切换，也不推荐在当前架构上做长期无边界双写。

当前数据规模约 2,000,771 行、主库约 1.67 GiB，复制本身不难；真正风险是 88 张表的类型合同、生产组合根、SQLite 专属 Repository、调度/发货/刊登侧库和完整业务回归。

## 2. 三种迁移方式比较

### 2.1 方案 A：直接迁移并一次切换

流程：停服务 -> 备份 -> 转 DDL -> 全量复制 -> 改连接 -> 启动。

优点：

- 路径短。
- 不产生临时双系统同步代码。

当前不可接受的原因：

- 旧 F3 只有 36 张表，正式库已有 88 张表。
- 当前转换器存在 827,614 个错误类型推断。
- 生产组合根仍固定创建 SQLite。
- Scheduler、File、Audit、Fulfillment 和 Publisher 尚未完成 PostgreSQL 化。
- 完整业务 Repository 没有在 PostgreSQL 上验收。

结论：**否决。**

### 2.2 方案 B：新增 Provider 后长期双写

流程：每次业务写入同时写 SQLite 和 PostgreSQL，再比对。

优点：

- 可以逐步观察差异。
- 理论上停机时间短。

风险：

- 当前有 Node 主服务、Scheduler、Python Publisher、Fulfillment 多个写入口。
- 没有统一 outbox，直接双写会产生部分成功和顺序漂移。
- 删除、租约、幂等、任务状态和外部平台回读不适合朴素双写。
- 长期双写会把迁移问题变成永久业务复杂度。

结论：**不采用朴素长期双写。** 若未来必须零停机，必须先建立事务 outbox 和幂等回放器，再做有期限的双写。

### 2.3 方案 C：分阶段迁移核心模块

流程：

1. 当前 SQLite 保持唯一写入源。
2. 定期从一致性快照重建 PostgreSQL 影子库。
3. 逐个 Repository 在两种 Provider 上跑同一合同。
4. 页面和 Agent 对影子库做只读对账。
5. 所有域通过后安排短暂停机，做最终快照和全量装载。
6. 在维护窗口内完成端到端验证，再开放写入。

优点：

- 不影响当前生产。
- 每个阶段都有可撤销边界。
- 不引入长期双写。
- 允许在同构迁移验证后再做目标域重构。

结论：**推荐。**

## 3. 今晚能否完成

### 3.1 本机准备状态

- PostgreSQL 18.4 已安装并运行。
- `psql`、`pg_dump`、`pg_restore` 可用。
- 生产数据库和测试数据库、迁移角色、应用角色配置已存在。
- PostgreSQL 生产 `app` schema 当前 0 张表。
- PostgreSQL 测试 `app` schema 当前 38 张旧演练表。
- Docker 未安装，但不需要。
- C、D 盘空间足够进行测试迁移和多份备份。

### 3.2 几小时内可完成的内容

在允许修改迁移工具后，几个小时内可以争取完成：

1. 创建当前 88 表的显式类型 manifest。
2. 生成新的同构 staging DDL。
3. 在测试 PostgreSQL 重建 schema。
4. 从 SQLite 一致性快照进行第一轮全量装载。
5. 生成逐表 count/FK/digest 报告。

这只能证明“数据可以进入 PostgreSQL”，不能证明系统可用。

### 3.3 今晚不能安全承诺的内容

以下五项不能在当前状态下同时安全完成：

| 目标 | 今晚判断 | 原因 |
|---|---|---|
| PostgreSQL 运行 | 已满足 | 本机 18.4 已运行 |
| 全量数据迁移 | 可做测试影子迁移 | 当前转换器需先修复 |
| 主系统从 PostgreSQL 启动 | 不可承诺 | 组合根与 SQLite Repository 未改造 |
| 日报 Agent / Monitoring 正常 | 不可承诺 | Observability JSON 方言与真实链路未测 |
| 自动发货正常 | 不可承诺 | Fulfillment Repository 完全使用 `node:sqlite` |

结论：**今晚不能完成生产可用迁移。今晚最多完成 Migration Foundation 和影子装载，不应切换生产。**

## 4. 人工准备清单

### 4.1 当前已经具备

- [x] 安装 PostgreSQL。
- [x] PostgreSQL Windows 服务运行。
- [x] 建立生产库、测试库、migrator 和 app 角色。
- [x] 配置本地凭据文件，且凭据不写入报告。
- [x] 准备足够本机磁盘空间。

### 4.2 用户必须人工决定

- [ ] 批准目标 schema 和显式类型合同。
- [ ] 明确 `publisher.db` 哪个路径是唯一有效实例。
- [ ] 决定 Fulfillment 独立库是本次纳入还是作为第二批迁移。
- [ ] 指定备份保存盘，建议 D 盘独立目录，并确认保留周期。
- [ ] 确认最终维护窗口和可接受停机时间，建议预留 2-4 小时。
- [ ] 确认最终切换由谁批准、失败到什么条件必须回滚。
- [ ] 确认 PostgreSQL 仅本机使用还是需要局域网访问；若需局域网，再人工审核防火墙、`listen_addresses`、`pg_hba.conf` 和 TLS。
- [ ] 在最终切换前暂停人工导入、定时导入、价格同步、图片采集、刊登写入和自动发货。
- [ ] 完成关键页面与业务结果的人工 UAT，并明确“开放写入”时点。

### 4.3 不需要人工完成

Codex 可以在批准后自动完成：

- 生成一致性 SQLite 备份并计算 SHA-256。
- 生成目标 DDL、类型 manifest 和迁移脚本。
- 重建 PostgreSQL 测试 schema。
- 批量复制和 sequence 对齐。
- 运行逐表 count、digest、FK、unique 和关键查询对账。
- 改造 Provider/Repository 并补测试。
- 启动服务、Build、Doctor 和浏览器验收。
- 执行受控日报 Agent、Monitoring 和调度验证。
- 生成切换与回滚报告。

## 5. 分阶段执行计划

### M0：合同冻结与保护

目标：不改生产数据，冻结迁移边界。

1. 冻结 88 表 schema inventory 和 024 迁移基线。
2. 建立显式字段类型 manifest。
3. 标记内部 UUID、外部 text ID、boolean、jsonb、numeric、date、timestamptz。
4. 明确主库、Publisher 和 Fulfillment 边界。
5. 给现有 SQLite 运行路径增加不可误切换保护。

验收：manifest 覆盖 1,527 个字段；不再通过字段名猜类型。

预计：0.5-1 天。

### M1：迁移工具 V2

目标：当前正式快照可完整装载测试 PostgreSQL。

1. 支持 88 表、15 视图和 301 索引。
2. 支持表达式/部分索引。
3. 自引用外键在数据装载后使用 `NOT VALID` 添加，再 `VALIDATE CONSTRAINT`。
4. 支持分批流式读取和批量 insert/copy，避免一次加载大表进内存。
5. 重置 identity/sequence。
6. 每张表生成 normalized digest。

验收：测试库 88 表，所有行数与 SQLite 一致，FK/摘要通过。

预计：1-2 天。

### M2：生产 Data Access 双 Provider

目标：同一 Repository 合同在 SQLite 和 PostgreSQL 上通过。

1. `openCommerceDataAccess` 接受 Provider factory；默认仍为 SQLite。
2. PostgreSQL 不在应用启动时自动跑未批准 migration。
3. 替换 Scheduler、File、Audit 的 SQLite 专属实现。
4. 改写 `sqlite_master`、`json_extract`、`INSERT OR IGNORE` 和布尔比较。
5. 真实业务 Repository 建立双 Provider 合同。
6. 所有服务调用链统一 async 语义。

验收：SQLite 全量测试不回归；PostgreSQL Repository 合同覆盖主要读写路径。

预计：2-4 天。

### M3：按域影子验证

建议顺序：

1. Core / Foundation 身份与只读查询。
2. Catalog / Product / Price Control。
3. Sales / Inventory / Growth Radar / Sales Assortment。
4. AI Context / Agent Observability / Audit。
5. Scheduler / Task / Notification。
6. Asset metadata / Mabang Images。
7. Publisher / Fulfillment 外部执行服务。

每个域都从同一 SQLite 快照生成 PostgreSQL 数据，执行关键查询结果对比，不写生产 PostgreSQL。

预计：2-5 天。

### M4：预生产运行

1. 用最新正式快照重建影子库。
2. 运行 Node 主服务、Scheduler 和 Python Worker。
3. 外部写操作保持 dry-run 或审批阻断。
4. 连续运行日报和 Agent Monitoring。
5. 记录查询性能、连接池、锁等待和慢查询。

验收：至少一个完整业务日或 24 小时稳定运行。

预计：1-3 天。

### M5：最终切换

1. 进入维护模式，停止所有写入入口。
2. 等待在途任务到安全状态，记录水位。
3. 使用 SQLite Online Backup 生成一致性最终快照。
4. 计算 SQLite、WAL、水位清单和备份 SHA-256。
5. 在新 PostgreSQL schema 做最终全量装载。
6. 运行数据门禁。
7. 切换环境变量并重启服务。
8. 在仍禁止业务写入时完成端到端验收。
9. 人工批准后开放写入。

预计维护窗口：2-4 小时；实际数据装载预计只是其中一部分。

## 6. 备份方案

最终切换前必须同时生成：

1. SQLite Online Backup 一致性文件。
2. SQLite 主文件、WAL 状态和 migration 水位清单。
3. 文件资产/图片目录的 SHA-256 清单。
4. PostgreSQL 切换前 `pg_dump --format=custom`。
5. `.env` 配置键清单，只记录“已配置”，不复制秘密。

备份目录必须包含 manifest：创建时间、来源路径、字节数、哈希、最新 migration、运行中任务数和操作者。

备份验证：在独立临时目录恢复 SQLite 并执行 `integrity_check` 与 `foreign_key_check`。

## 7. 数据迁移步骤

1. 从只读一致性 SQLite 快照读取 schema 和数据。
2. 在 PostgreSQL 建立 staging schema，不直接写目标业务 schema。
3. 先建表和主键，不先启用外键。
4. 按依赖域批量装载；大表分批并记录 checkpoint。
5. 设置 sequence/identity 到最大值之后。
6. 添加唯一索引和普通索引。
7. 添加外键 `NOT VALID`，再逐个 `VALIDATE CONSTRAINT`。
8. 重建 15 个视图并做查询验证。
9. 将 staging 数据转换到目标域 schema。
10. 生成逐表和跨域对账报告。

同构 staging 与目标域重塑必须是两个步骤。不能在一次 bulk copy 中同时改主键、合表和更改业务语义。

## 8. 验证门禁

### 8.1 数据一致性

- 88/88 表存在。
- 逐表行数一致。
- 主键、唯一键、非空和 CHECK 约束通过。
- 外键异常为 0。
- 每张表全字段 normalized digest 和关键字段 digest 一致。
- 时间统一为 UTC 后，业务日期保持一致。
- JSONB 内容与 SQLite JSON 规范化后一致。
- MinIO/文件对象引用清单无缺失。

### 8.2 关键业务对账

- 商品/SKU/产品包数量。
- 订单头/订单行/有效销量聚合。
- 最新库存批次、国家/仓库/SKU 汇总。
- 图片资产和 SKU 关联。
- 调度任务、运行、钉钉配置。
- Foundation Task、Task Event、Audit。
- Agent Run、Tool Trace、Gateway 和 Evaluation 查询。
- Price Control 当前价格和快照。

### 8.3 服务验收

- Node 主服务启动并通过 Doctor。
- Vue 主工作台所有核心路由可打开。
- 产品中心、马帮数据、销售与货盘、Growth Radar、Listing、价格控制可读取。
- Scheduler 加载任务，不重复补跑。
- 受控执行一次日报 Agent：Context、Tool、Gateway、Validation、DingTalk 全链路成功。
- Agent Monitoring 能查到该 Run、Tool、token 和 Evaluation。
- 图片与文件 URL 正常。
- 自动发货只做预览和 dry-run 验证；正式提交需单独批准。
- Mabang Listing 只做读取和差异预览；正式平台写入需单独批准。

### 8.4 性能门禁

- 关键 API P95 不高于 SQLite 基线的 1.5 倍。
- 不出现未使用索引的大表高频全扫。
- 连接池无泄漏，idle 和 statement timeout 生效。
- Scheduler 领取任务无重复执行。
- Agent Monitoring 时间范围查询使用分区/索引。

## 9. 回滚方案

### 9.1 开放写入前

最终验收期间保持维护模式。若任何 P0 门禁失败：

1. 停止 PostgreSQL 服务进程连接。
2. 恢复 SQLite 环境变量。
3. 启动 Node、Scheduler、Python Worker。
4. 验证 SQLite migration 水位和任务水位。
5. 解除维护模式。

因为尚未在 PostgreSQL 接受新业务写入，此时无需反向同步。

### 9.2 开放写入后

一旦 PostgreSQL 开放写入，它成为唯一权威源。不能直接指回旧 SQLite。

若必须回滚：

1. 重新进入维护模式。
2. 导出切换水位后的 PostgreSQL 增量。
3. 通过经过验证的反向映射回放 SQLite，或恢复 PostgreSQL 到健康时间点。
4. 对账通过后再恢复服务。

因此最终“开放写入”必须是明确的人工批准点。

## 10. 停止条件

执行期间出现以下任一情况立即停止：

- SQLite 备份哈希或完整性失败。
- 行数、主键摘要或关键业务指标不一致。
- 发现未纳入的写入入口。
- Repository 需要改变既有业务语义才能兼容 PostgreSQL。
- 日报 Agent、Agent Monitoring、Scheduler 或 Fulfillment 无法在维护模式下通过。
- 需要删除现有数据或修改历史 migration。
- PostgreSQL 写入后无法证明回滚水位。

## 11. 下一条执行路径

只有在用户批准本方案后，下一节点才是：

```text
POSTGRESQL-MIGRATION-V2-M0
显式字段类型合同 + 当前 88 表转换器修复 + 测试库影子迁移
```

该节点仍不得修改正式 SQLite，也不得切换生产 Provider。
