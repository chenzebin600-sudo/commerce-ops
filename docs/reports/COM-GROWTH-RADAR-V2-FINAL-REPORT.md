# COM-GROWTH-RADAR-V2 FINAL REPORT

> 日期：2026-07-25（Asia/Shanghai）
> 指标合同：`GRV2-METRICS-1.0.1`
> 当前分支：`master`
> 当前 HEAD：`a8327c524764f89eda8127e32b4aa48e38c3fac6`

## 1. 完成内容

Growth Radar V2 第一阶段已经形成完整闭环：

```text
最新马帮库存批次 + 已发货订单事实
-> 确定性日指标
-> 机会、风险和数据阻断信号
-> 已发布分析运行
-> API
-> 货盘与店铺运营页面
```

已经实现：

- 全盘 SKU 指标和类目内 P80/P75 阈值。
- 来源高表现、缺货、滞销、新品、停售库存和数据阻断信号。
- 店铺亮点款和增长跟进款。
- 最新已发布结果读取和失败刷新回退。
- 驾驶舱、货盘分析、店铺分析和 SKU 证据详情。
- 用户可维护的仓库国家映射和确定性规则配置。
- 信号、库存健康、类目表现和店铺表现可视化。
- 国家映射缺失时的显式降级。

没有实现或启动：

- AI 评分。
- 自动经营动作。
- 在线 Listing 覆盖推断。
- A3。
- Listing 开发。
- COM-015 图片业务改造。

## 2. 架构变化

新增独立 V2 模块：

- `lib/growth-radar/v2/growth-radar-v2-repository.mjs`
- `lib/growth-radar/v2/growth-radar-v2-engine.mjs`
- `lib/growth-radar/v2/growth-radar-v2-service.mjs`
- `lib/growth-radar/v2/growth-radar-v2-api.mjs`

职责分层：

- Repository：事实读取、指标和信号持久化、published 投影查询。
- Engine：纯确定性聚合、分位数、机会和风险规则。
- Service：输入指纹、幂等运行、质量校验、发布与失败回退。
- API：权限校验、筛选、分页和可解释证据输出。

A2/G1B 数据治理页面保持完整，并作为“数据与范围”工作区继续使用。

## 3. 数据库变化

新增迁移：

`migrations/019_growth_radar_v2_analysis.sql`

新增 8 张表：

- `growth_country_mapping_sets`
- `growth_warehouse_country_mappings`
- `growth_rule_sets`
- `growth_analysis_runs`
- `growth_sku_daily_metrics`
- `growth_shop_daily_metrics`
- `growth_shop_sku_daily_metrics`
- `growth_signals`

同时新增最新 published 只读视图、唯一约束、外键和查询索引。

重要边界：

- 迁移 019 只存在于代码中。
- 正式数据库没有应用 019，当前仍为 018。
- 正式订单、库存、产品、店铺、Listing 和图片事实没有被修改。

## 4. API 变化

新增：

- `GET /api/growth-radar/v2/status`
- `POST /api/growth-radar/v2/analysis-runs`
- `GET /api/growth-radar/v2/overview`
- `GET /api/growth-radar/v2/assortment`
- `GET /api/growth-radar/v2/signals`
- `GET /api/growth-radar/v2/stores`
- `GET /api/growth-radar/v2/stores/:id`
- `GET /api/growth-radar/v2/skus/:sku`
- `GET /api/growth-radar/v2/configuration`
- `PUT /api/growth-radar/v2/configuration/country-mappings`
- `PUT /api/growth-radar/v2/configuration/rules`

读取接口只服务最新 published 运行。创建分析使用输入指纹保证幂等；新运行失败时，上一成功运行仍可继续提供页面数据。配置写入要求 `growth_radar.data.apply` 权限，采用版本化保存并记录审计。

## 5. 前端变化

Growth Radar 现在包含两个工作区：

- `货盘分析`：默认进入 V2。
- `数据与范围`：保留现有 A2/G1B 能力。

V2 页面提供：

- 驾驶舱：机会、风险、新品和重点 SKU。
- 货盘分析：高表现、缺货、滞销和新品筛选。
- 店铺分析：销售覆盖可用性、亮点款和增长跟进款。
- SKU 详情：规则、输入、公式、阈值和来源证据。
- 配置管理：仓库国家映射、规则参数和配置版本历史。
- 可视化：信号结构环图、库存健康分布、类目来源销量和店铺表现条形图。

页面已验证桌面端和 430px 移动端，浏览器控制台错误为 `0`。

## 6. 测试结果

| 门禁 | 结果 |
|---|---:|
| Growth Radar 全族 | `177/177 PASS` |
| 全量测试 | `693/693 PASS` |
| Build | `PASS` |
| Doctor | `PASS` |
| COM-015 回归 | `63/63 PASS` |
| PostgreSQL readiness / e2 | `8/8 PASS` |
| 浏览器桌面与移动端 | `PASS` |
| 浏览器控制台错误 | `0` |

## 7. 性能情况

隔离副本实测：

- 有效库存事实：`20,022` 行。
- 聚合 SKU：`10,327`。
- 发布信号：`7,695`。
- 完整分析耗时：约 `3.4` 秒。

该结果用于当前 SQLite 数据规模的工程基线，不代表正式环境 SLA。正式启用后仍应记录每日运行耗时、数据库文件增长和 API P95。

## 8. 风险清单

1. 正式环境国家映射尚未配置。

   前端配置、版本保存和隔离分析已验证；正式启用前仍需用户在正式环境核对仓库国家，异常编码仓库不得猜测。

2. 正式库尚未应用迁移 019。

   当前交付是代码完成和隔离验收，不是生产启用。迁移前需要独立备份、哈希和只读基线检查。

3. 每日定时触发尚未接线。

   当前 API 支持手工且幂等地生成最新分析；后续应在现有马帮库存和订单同步成功后触发一次分析，不应独立猜测数据是否更新。

4. 店铺事实当前为空或不可分析。

   隔离验收中 `shopCount=0`。这是 confirmed 店铺范围和国家映射不足导致的正确降级，不是算法输出零覆盖。

5. 工作树包含其他并行在途修改。

   本节点没有暂存、提交、删除或回退这些修改。合并或提交前必须按文件所有权审计，避免把 COM-015 等并行工作混入同一提交。

## 9. 后续建议

推荐按以下人工批准节点继续：

1. 审核本报告和迁移 019。
2. 配置并确认仓库到国家映射。
3. 对正式 SQLite 做备份、哈希和只读基线记录。
4. 单独批准并应用迁移 019。
5. 在正式数据上首次生成分析并核对信号抽样。
6. 将每日分析挂到库存和订单同步成功后的调度链。
7. 收集运营反馈后再调整阈值；任何口径变更必须升级规则版本。

当前结论：Growth Radar V2 第一阶段代码与隔离验收完成，可以进入人工代码审查和正式启用审批，但不能视为已经修改或启用正式数据库。
