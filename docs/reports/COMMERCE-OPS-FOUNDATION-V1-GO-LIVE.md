# COMMERCE-OPS-FOUNDATION-V1 GO-LIVE REPORT

日期：2026-07-28

状态：通过

## 1. 架构变化

Foundation V1 已作为加法式统一层进入正式 SQLite。产品、SKU 和店铺继续由
原业务主表负责，Foundation 通过视图、身份关系、来源运行和任务投影提供统一
引用，不复制订单、库存、图片或 Listing 业务事实。

正式结构现在是：

```text
数据来源
  -> 既有事实表
  -> Product / SKU / Store / Warehouse / Owner Master
  -> Growth Radar / COM-015 / Listing
  -> Foundation 统一任务投影
```

## 2. 数据模型变化

迁移 022 新增 10 张表和 7 个视图：

- 来源与账号：`foundation_source_systems`、
  `foundation_integration_accounts`、`foundation_account_capabilities`
- 主数据：`foundation_owners`、`foundation_warehouses`、
  `foundation_identity_links`
- 运行与任务：`foundation_source_runs`、`foundation_tasks`、
  `foundation_task_events`、`foundation_task_leases`
- 主数据视图：Product、SKU、Store、Owner、Warehouse
- 任务视图：开放任务、任务域汇总

账号层只保存凭据引用，不保存密码、Cookie、Token 或账号完整用户名。

## 3. Migration 记录

执行前正式库最高迁移：

`018_mabang_image_collection_performance.sql`

正式应用顺序：

1. `019_growth_radar_v2_analysis.sql`
2. `020_growth_radar_direction_contract.sql`
3. `021_growth_radar_task_lifecycle.sql`
4. `022_commerce_ops_foundation_v1.sql`

执行后迁移记录共 21 条，最高为 022。Growth Radar 活动规则为
`GRV2-METRICS-1.2.0`。

迁移前备份：

`backups/foundation-v1/20260728T053947Z`

备份包含经过验证的在线 SQLite 备份、原始 main/WAL/SHM 三件套和
`backup-manifest.json`。在线备份仍为 018，完整性为 `ok`，外键异常为 0，
保护表行数与迁移前一致。

## 4. 主数据初始化结果

| 对象 | 结果 |
|---|---:|
| Product Master | 6,500 |
| SKU Master | 18,347 |
| Store Master | 107 |
| Owner Master | 22（21 位负责人 + 1 个未分配保留项） |
| Warehouse Master | 29 |
| 已确认仓库国家 | 27 |
| 明确排除的损坏仓库名 | 2 |
| Foundation 身份关系 | 24,983 |

107/107 家店铺均已映射负责人，无缺失，共 21 位实际负责人。店铺本身的
A2 身份确认状态未被 Foundation 越权修改，因此 107 条 Store 身份关系仍按
原 A2 事实标记为 `suggested`。

仓库国家配置建立了一个活动映射集：

`GRV2-COUNTRY-20260728054633-f9ca314e`

重复运行初始化脚本时 Owner 变更数为 0、国家映射复用原版本、任务数量和
任务版本均未变化，幂等验证通过。

## 5. 模块接入情况

- 马帮数据：2 个账号引用、10 个能力声明、2 个来源运行和 2 个成功任务投影。
- COM-015：2 个全量同步父任务和 210 个图片批次已投影；209 个成功、3 个失败，
  保留源系统真实历史，不伪造成功。
- Growth Radar：019-021 结构和 1.2.0 规则已就绪；国家映射已激活；首次正式
  分析未自动启动，因此当前无 Growth 运营任务投影。
- Listing：统一账号桥和任务投影能力已就绪；正式库当前草稿和发布记录均为 0，
  因此没有生成虚假的 Listing 任务。
- A2：隔离门禁、001-014 基线和原事实模型保持不变。

## 6. 测试结果

| 验收项 | 结果 |
|---|---|
| Foundation + Growth Radar V2 | 42/42 |
| A2 | 158/158 |
| COM-015 + Listing | 149/149 |
| 全量测试 | 725/725 |
| Build | 通过 |
| Doctor | 全部 OK |
| 正式库完整性 | `integrity_check=ok` |
| 正式库外键 | 0 |
| 保护表行数变化 | 0 张 |
| Foundation 凭据值命中 | 0 |

全量测试首次发现 PostgreSQL readiness 的旧表数和文档清单未包含迁移 022；
已改为从迁移集合动态推导表数，并补齐 Foundation PostgreSQL 准备度说明。

## 7. 性能情况

- 正式应用 019-022：约 5.9 秒。
- 完整初始化并做两次幂等投影：约 68 秒。
- 全量测试：约 44.8 秒。
- 双前端构建和静态检查：约 17.1 秒。
- Doctor：约 6 秒。

Growth Radar 构建产物的主包约 1.77 MB，gzip 后约 572 KB。当前不阻断上线，
但应通过路由级动态导入和 ECharts/Ant Design 分包降低首屏成本。

## 8. 遗留问题

1. Foundation 主数据同步目前逐条 upsert 24,983 条身份关系，正确但初始化耗时
   偏高；后续可改为事务内批量 upsert。
2. 3 个 COM-015 失败任务是源历史状态，需要运营按原错误证据决定是否重试。
3. 107 条 Store 身份仍受 A2 店铺范围确认门禁管理；Foundation 不应自动确认。
4. Listing 当前没有正式草稿或发布事实，统一任务域暂为空。
5. Growth Radar 首次正式分析仍需单独批准，Foundation 上线没有自动触发分析。
6. 正式库继续使用 SQLite；PostgreSQL 准备度文档已更新，但没有执行数据库切换。

## 9. 下一阶段路线

1. 在用户批准后运行首次 Growth Radar 正式分析，并把生成的运营任务投影到
   Foundation。
2. 为 Foundation 增加只读管理 API 和统一任务观察界面。
3. 对身份同步进行批量化，增加初始化耗时基线和增量水位。
4. 完成 Listing 账号绑定后，验证真实发布任务投影与回读。
5. 拆分 Growth Radar 前端大包，建立桌面和移动端首屏性能预算。
6. 继续保持正式数据库迁移、数据删除和自动经营动作的人工批准门禁。
