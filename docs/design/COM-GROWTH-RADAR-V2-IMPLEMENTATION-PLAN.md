# COM-GROWTH-RADAR-V2 实施方案

> 日期：2026-07-25（Asia/Shanghai）
> 指标合同：`GRV2-METRICS-1.0.1`
> 数据层设计：`COM-GROWTH-RADAR-V2-1-DATA-LAYER-DESIGN.md`
> 迁移计划：`019`

## 1. 交付范围

本次交付形成 Growth Radar V2 第一版闭环：

```text
最新库存批次 + 已发货订单事实
-> 确定性日指标
-> 机会与风险信号
-> 发布分析运行
-> API
-> 货盘与店铺运营页面
```

不交付 AI 评分、自动经营动作、在线 Listing 覆盖推断、人工重点跟进工作流或国家映射管理页面。

## 2. 后端修改范围

新增独立模块：

- `lib/growth-radar/v2/growth-radar-v2-repository.mjs`
- `lib/growth-radar/v2/growth-radar-v2-engine.mjs`
- `lib/growth-radar/v2/growth-radar-v2-service.mjs`
- `lib/growth-radar/v2/growth-radar-v2-api.mjs`

共享装配仅修改：

- `lib/data/data-access.mjs`
- `server.mjs`

V2 服务提供：

- 创建或复用幂等分析运行；
- 选择最新可用库存批次、订单水位、active 规则和国家配置；
- 计算并发布指标；
- 查询最新 published 总览、货盘、店铺、信号和 SKU 证据；
- 新运行失败时继续返回上一 published 运行。

## 3. 数据库变化

新增迁移 `019_growth_radar_v2_analysis.sql`：

- `growth_country_mapping_sets`
- `growth_warehouse_country_mappings`
- `growth_rule_sets`
- `growth_analysis_runs`
- `growth_sku_daily_metrics`
- `growth_shop_daily_metrics`
- `growth_shop_sku_daily_metrics`
- `growth_signals`
- 最新 published 只读视图
- 必要唯一约束、外键和查询索引

迁移写入一个空的 active 国家配置版本和首个 active 规则版本。它们仅是配置合同，不修改订单、库存、店铺、产品或图片事实。

## 4. 指标引擎

计算顺序：

1. 聚合 SKU + 唯一仓库库存事实。
2. 计算全盘与已确认国家范围的 SKU 指标。
3. 按二级目录、一级目录、全盘回退计算确定性 P80/P75。
4. 生成来源高表现、缺货、滞销、新品、停销库存和数据阻断信号。
5. 聚合近 7/28 天已发货店铺销量。
6. 计算店铺亮点款。
7. 国家映射完整时计算店铺销售覆盖与增长跟进款；否则显式标记 unavailable。
8. 校验行数、唯一性和质量后发布。

所有信号保存规则版本、输入值、中间值、阈值、命中条件、来源批次和时间水位。

## 5. API

新增：

- `GET /api/growth-radar/v2/status`
- `POST /api/growth-radar/v2/analysis-runs`
- `GET /api/growth-radar/v2/overview`
- `GET /api/growth-radar/v2/assortment`
- `GET /api/growth-radar/v2/stores`
- `GET /api/growth-radar/v2/stores/:shopId`
- `GET /api/growth-radar/v2/skus/:sku`
- `GET /api/growth-radar/v2/signals`

读取使用 `growth_radar.data.view`，分析触发使用已有高风险写权限 `growth_radar.data.apply`。不新增绕过权限。

## 6. 前端修改范围

新增 V2 工作区和样式：

- `public/growth-radar-workspace.mjs`
- `public/growth-radar-v2-page.mjs`
- `public/growth-radar-v2.css`

现有 G1B 数据管理页面保留为“数据与范围”模式。V2 默认展示：

- 总览：机会、风险、新品、重点 SKU 和来源时间；
- 货盘分析：高表现、缺货、滞销、新品筛选表；
- 店铺分析：自店销量、覆盖可用性、亮点和增长跟进；
- SKU 详情：公式、输入、阈值和证据。

共享前端文件只做入口与资源版本装配。

## 7. 测试计划

新增专项测试覆盖：

- 迁移 019 空库与升级链；
- 配置、外键、唯一性和最新 published 视图；
- P80、可售天数、缺货、滞销、新品和店铺亮点规则；
- 国家映射缺失时的降级行为；
- 失败运行不替换上一成功运行；
- API 权限、筛选、证据和错误输出；
- 前端请求计划、空状态、中文文案与响应式结构。

完成后执行：

- Growth Radar V2 专项；
- 所有 Growth Radar 测试；
- 全量测试；
- Build；
- Doctor；
- 隔离数据库 API 与页面冒烟。

## 8. 风险

- 当前正式数据国家映射未配置，第一版店铺跨源覆盖将显示不可用，这是合同要求，不是失败。
- 当前产品身份映射不足，新品信号可能较少或为空，不允许用首次导入时间代替权威新品时间。
- SQLite 写入约 20K SKU 指标时必须分段并保持短事务；最终发布单独原子提交。
- 现有共享前端和服务器文件含并行修改，补丁必须保持局部，不清理其他改动。

## 9. 阶段验收

只有在迁移、引擎、API、前端与全部质量门通过，且正式数据库哈希与数据未被触碰后，本实施节点才算完成。
