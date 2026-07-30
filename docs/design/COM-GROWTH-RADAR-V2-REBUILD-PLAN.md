# COM-GROWTH-RADAR-V2 重构实施计划

> 计划版本：`GRV2-REBUILD-1.0.0`
> 页面合同：`GRV2-BATTLE-UI-1.0.0`
> 指标合同：`GRV2-METRICS-1.0.1`
> 日期：`2026-07-25`
> 状态：等待开发批准

## 1. 实施目标

把当前 Growth Radar V2 从数据展示页重构为电商运营作战系统，同时保留已冻结的数据语义、A2 隔离边界和“最新成功发布结果”机制。

本次重构不包含：

- AI 评分或 AI 自动决策。
- 自动上架、补货、调价、广告或清仓。
- Listing 开发。
- COM-015 图片业务修改。
- 正式数据库迁移执行。
- 对 A2 历史迁移和核心隔离逻辑的改写。

## 2. 当前代码边界

当前仓库是服务端 Node.js + 原生前端结构，Growth Radar V2 已有：

- `lib/growth-radar/v2/`
- `public/growth-radar-v2-page.mjs`
- `public/growth-radar-v2.css`
- `public/growth-radar-workspace.mjs`
- V2 API 和专项测试
- 尚未应用到正式数据库的 V2 迁移候选

当前工作树还存在 COM-015 和其他并行修改。开发前必须建立文件所有权清单，禁止重置、删除、暂存或提交无关改动。

## 3. 前端技术方案

### 3.1 React island

不迁移整个 Commerce Ops 前端。Growth Radar V2 使用独立 React island：

```text
现有应用外壳
-> Growth Radar workspace
-> React createRoot
-> Growth Radar V2 app
```

离开页面时调用 `root.unmount()`，避免事件、图表和请求残留。

### 3.2 独立构建目录

建议新增：

```text
frontend/growth-radar-v2/
├── package.json
├── tsconfig.json
├── vite.config.ts
└── src/
```

技术栈：

- React
- TypeScript
- Vite
- Ant Design
- Tailwind CSS
- ECharts
- Lucide React

构建产物输出到受控静态目录，由现有页面入口加载。不得使用 CDN 依赖。

### 3.3 样式隔离

- Tailwind 只扫描 Growth Radar React 源码。
- 禁止全局样式污染现有页面。
- Ant Design 使用 `ConfigProvider` 和 compact theme。
- 统一设计 token：字体、间距、边框、语义色和图表色。
- 不修改现有产品中心和 COM-015 页面样式。

### 3.4 图表封装

建立最小 ECharts 封装：

- `OpportunityHeatmap`
- `MarketOwnQuadrant`
- `CategoryRankingChart`
- `ShopCoverageChart`
- `TrendSparkline`

封装负责：

- `ResizeObserver`
- `setOption`
- loading / empty / unavailable
- click drilldown
- dispose
- 图例与无障碍摘要

## 4. 数据库与分析模型

优先复用已有 V2 表：

- 分析运行
- SKU 日指标
- 店铺日指标
- 店铺 SKU 日指标
- 确定性信号
- 国家映射和规则配置

需要在实现前审计并最小化的增量：

### 4.1 国家类目聚合

候选表：`growth_category_daily_metrics`

职责：

- 保存国家 x 一级类目 x 二级类目的聚合指标。
- 保存机会指数的每个组成部分。
- 保存样本数、质量状态和规则版本。
- 为驾驶舱热力图提供直接查询，避免浏览器聚合 20,000 SKU。

### 4.2 运营任务

候选表：

- `growth_operator_tasks`
- `growth_operator_task_items`
- `growth_operator_task_events`

职责：

- 每位店长每日最多 10 项聚合任务。
- 保存任务优先级、建议动作、证据摘要和包含的 SKU。
- 支持确认、完成和忽略。
- 保留人工操作审计。

### 4.3 配置管理

继续使用版本化配置：

- 仓库到国家映射
- 店铺身份、国家和店长
- P80
- 最小样本数
- 低承接率阈值
- 库存覆盖阈值
- 任务上限

配置由前端维护、后端校验、数据库版本化保存。分析运行必须引用确定的配置版本。

### 4.4 迁移纪律

- 不重写已存在的迁移历史。
- 不预占迁移号。
- 先审计当前未跟踪的 019/020 候选及迁移登记表。
- 新增结构只在隔离临时数据库验证。
- 正式数据库迁移必须作为独立人工批准节点。

## 5. 确定性分析流水线

```text
最新库存批次
+ 近 28 天已发货订单
+ 已确认国家和店铺配置
+ 已发布规则版本
-> SKU 事实归一
-> 国家类目聚合
-> P80 高表现识别
-> 我方承接计算
-> 库存约束判断
-> 方向与风险信号
-> 店铺/店长诊断
-> 每日任务生成
-> 完整性校验
-> 原子发布
```

新运行失败时：

- 标记失败并记录原因。
- 不替换上一份 published 结果。
- 页面继续读取上一份成功结果。
- 页面明确显示数据日期和失败提示。

## 6. API 方案

保留已有 V2 基础 API，并新增面向页面的聚合接口：

```text
GET /api/growth-radar/v2/dashboard
GET /api/growth-radar/v2/opportunity-map
GET /api/growth-radar/v2/top-skus
GET /api/growth-radar/v2/quadrants
GET /api/growth-radar/v2/blue-ocean
GET /api/growth-radar/v2/operator-tasks
GET /api/growth-radar/v2/stores/:shopId/diagnosis
GET /api/growth-radar/v2/skus/:sku/evidence
```

配置接口：

```text
GET  /api/growth-radar/v2/config
POST /api/growth-radar/v2/config/versions
POST /api/growth-radar/v2/config/versions/:id/publish
```

所有接口必须：

- 读取最新 published 结果。
- 支持国家、类目、平台、店铺和店长筛选。
- 返回规则版本、数据时间、质量状态和证据。
- 对 NULL、0 和 unavailable 使用不同表示。
- 使用现有 Growth Radar 权限和审计边界。

## 7. 开发阶段

### 阶段 R0：稳定基线与所有权

- 审计当前分支、HEAD、工作树和未跟踪 V2 文件。
- 记录本次允许修改的文件。
- 不处理无关 COM-015 和其他并行修改。
- 确认正式数据库哈希和迁移状态只读不变。

完成门：无文件归属冲突。

### 阶段 R1：React 基础

- 建立独立 React + TypeScript 构建。
- 挂载到现有 Growth Radar workspace。
- 完成主题、路由状态、全局筛选和空壳页面。
- 不接正式业务写操作。

完成门：桌面和移动端空壳可渲染，离开页面无残留。

### 阶段 R2：数据合同与隔离迁移

- 审计并补齐国家类目聚合、任务和配置合同。
- 创建最小迁移候选。
- 只在临时 SQLite 和 PostgreSQL readiness 环境验证。

完成门：迁移幂等、完整性、外键和索引测试通过。

### 阶段 R3：分析引擎

- 实现国家类目聚合。
- 实现 P80、承接率、机会指数和四方向规则。
- 实现缺货、滞销、新品和蓝海规则。
- 实现店铺/店长诊断和任务聚合。

完成门：固定 fixture 的输入、公式、输出和证据全部可复算。

### 阶段 R4：聚合 API

- 实现页面聚合接口。
- 保留上一成功结果。
- 增加筛选、权限、审计和错误契约。

完成门：API 合同、权限和失败回退测试通过。

### 阶段 R5：驾驶舱与可视化

- 实现已确认首屏。
- 实现热力图、四象限、Top SKU、蓝海池和店长诊断。
- 所有图表支持下钻。

完成门：使用隔离数据完成桌面和移动端视觉验收。

### 阶段 R6：分页页面与任务闭环

- 实现货盘机会、国家类目、店铺分析、蓝海机会和重点 SKU。
- 实现任务确认、完成和忽略。
- 不实现自动经营动作。

完成门：运营任务可从汇总下钻到证据并完成人工闭环。

### 阶段 R7：质量和性能

- Growth Radar 专项测试。
- 全量测试。
- Build。
- Doctor。
- 临时数据库迁移。
- 20,000 SKU fixture 性能测试。
- Playwright 桌面和 430px 移动端验收。
- 浏览器控制台错误为 0。

完成门：全部门禁通过，正式数据库仍未修改。

### 阶段 R8：正式迁移审批

单独输出迁移和发布报告，等待用户批准。代码完成不自动触发正式迁移或分析运行。

## 8. 测试矩阵

| 层级 | 重点 |
|---|---|
| 指标单元测试 | P80、预测冲突、承接率、覆盖天数、NULL 语义 |
| 规则测试 | 四方向、蓝海、缺货、滞销、新品、任务优先级 |
| 数据测试 | 多仓去重、国家映射、配置版本、发布原子性 |
| API 测试 | 筛选、权限、证据、上一成功回退 |
| 前端测试 | 筛选联动、下钻、空状态、不可比较、任务状态 |
| 视觉测试 | 1440x900、430px、无重叠、无横向页面滚动 |
| 性能测试 | 20,000 SKU、聚合查询、表格分页、图表点数上限 |

## 9. 性能目标

- 分析在服务端计算，浏览器不接收全量 20,000 SKU 后再聚合。
- 驾驶舱接口在本地目标数据规模下 p95 不超过 500ms。
- 首屏在本地环境目标为 2 秒内显示可交互骨架和首批数据。
- 热力图只传聚合单元格。
- 四象限默认传 Top N 及可解释抽样，完整清单通过表格分页查看。
- Top SKU 和蓝海池服务端分页。

## 10. 风险与停止条件

遇到以下情况立即停止并报告：

1. 需要修改指标口径或把预测销量解释为实际销量。
2. 需要推断店铺未上架。
3. 需要修改 A2 核心隔离逻辑。
4. 需要修改 COM-015 图片业务。
5. 需要删除或改写迁移历史。
6. 需要修改正式数据库或正式数据。
7. 现有并行修改与本次文件范围冲突。
8. 20,000 SKU 性能目标无法通过聚合和索引满足。

## 11. 最终验收

交付必须证明：

- 产品上：运营能得到明确的国家、类目、SKU、店铺和店长方向。
- 语义上：每个结论可解释且不越过数据证据。
- 工程上：React 新模块不污染现有页面。
- 数据上：分析失败不清空上一成功结果。
- 安全上：正式数据库和 COM-015 保持不变。
- 质量上：专项、全量、Build、Doctor、性能和视觉门禁全部通过。

## 12. 开发批准口令

只有用户明确回复以下含义后，才进入 R0/R1 并开始写代码：

```text
确认线框与实施方案，开始开发 Growth Radar V2 重构
```
