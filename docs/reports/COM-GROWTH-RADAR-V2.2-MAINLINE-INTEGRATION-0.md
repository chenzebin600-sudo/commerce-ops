# COM-GROWTH-RADAR-V2.2-MAINLINE-INTEGRATION-0 报告

## 1. 审计结论

本节点只完成主线接入审计和实施计划，没有修改业务代码、迁移、数据库或页面。

Growth Radar V2.2 可以采用 React Island 方式接入 Commerce Ops 主工作台，不需要 iframe，也不需要第二套登录。但是当前工作树和候选实现尚不具备直接进入主线开发的条件。

进入代码接入前必须关闭三个 P0 门禁：

1. 当前 `master` 工作树混有 Growth Radar V2.2、COM-015、马帮数据持久化、产品中心图片和共享入口等多条在途修改，不能按整文件暂存或提交。
2. 当前马帮 Excel 进入 A2 事实层的解析过程没有完整保留 GRV2-METRICS-1.2.0 需要的字段和订单状态，直接分析会产生错误结果。
3. 当前候选数据库、后端计算和 React 展示仍主要基于 GRV2-METRICS-1.1.0 或更早语义，尚未与 1.2.0 候选合同对齐。

因此，本报告的结论是：

> 主线集成架构通过，当前候选代码暂不进入共享入口。下一节点应先完成合同确认、数据入口兼容和文件归属隔离。

## 2. 当前主线状态

### 2.1 Git

| 项目 | 当前值 |
| --- | --- |
| 分支 | `master` |
| HEAD | `a8327c524764f89eda8127e32b4aa48e38c3fac6` |
| `origin/master` | `a809f9c` |
| 本地关系 | 相对远端 ahead 2 |
| 已跟踪修改 | 29 个文件 |
| 已跟踪差异 | 3,092 insertions / 167 deletions |
| 工作树 | 非干净，包含大量未跟踪文件 |

本地两个未推送提交为：

- `bb0002e feat: cap Mabang image batches by unique SKU`
- `a8327c5 fix: retain Mabang batch limit audit metadata`

当前正式数据库最高迁移仍为：

```text
018_mabang_image_collection_performance.sql
```

本节点未执行数据库写入或迁移。

### 2.2 在途修改归属

#### Growth Radar V2.2 独有候选文件

- `frontend/growth-radar-v2/**`
- `lib/growth-radar/v2/**`
- `public/growth-radar-v2-page.mjs`
- `public/growth-radar-v2.css`
- `public/growth-radar-workspace.mjs`
- `tests/growth-radar-v2*.test.mjs`
- `migrations/019_growth_radar_v2_analysis.sql`
- `migrations/020_growth_radar_direction_contract.sql`
- `migrations/021_growth_radar_task_lifecycle.sql`
- Growth Radar V2.2 设计和阶段报告

#### 共享接入文件

以下文件同时承载多个模块，必须按代码块逐段审计，禁止整文件归入 Growth Radar：

- `server.mjs`
- `lib/data/data-access.mjs`
- `public/app.js`
- `public/index.html`
- `public/styles.css`
- `.env.example`
- 根目录 `package.json` 和构建检查脚本

#### 非 Growth Radar V2.2 修改

以下修改应明确排除在本节点之外：

- `lib/mabang-images/**`
- `public/mabang-images-page.mjs`
- `scripts/mabang_worker.py`
- COM-015 图片任务、调度和产品图片关联
- `migrations/017_*`
- `migrations/018_*`
- 产品中心图片展示相关修改
- 与马帮图片采集有关的测试

#### A2 / 数据入口边界

以下文件属于 A2 事实层或其输入边界。若后续需要修改，必须单独批准并单独提交：

- `scripts/growth-radar-parser.py`
- `lib/growth-radar/growth-radar-service.mjs`
- A2 Growth Radar 隔离、后端和解析测试
- `lib/mabang-data/persistence-service.mjs`

## 3. 文件合并方案

### 3.1 合并原则

1. 不从当前混合工作树直接执行整文件 `git add`。
2. Growth Radar V2.2 独有文件、A2 数据入口兼容、共享主壳接入、迁移和文档分别形成独立变更单元。
3. `server.mjs`、`public/app.js`、`public/index.html` 和 `lib/data/data-access.mjs` 只能按归属明确的代码块合入。
4. COM-015、图片采集和产品中心图片修改不得随 Growth Radar V2.2 进入提交。
5. 三个既有保护 stash 不在本节点 apply、pop 或 drop。

### 3.2 推荐变更序列

| 顺序 | 变更单元 | 说明 |
| --- | --- | --- |
| 0 | 工作树归属基线 | 输出文件及代码块归属清单，不改历史 |
| 1 | 马帮来源合同兼容 | 只补齐订单、库存进入事实层所需语义；需单独批准 |
| 2 | GRV2-METRICS-1.2.0 计算层 | 修订 V2 repository、engine、service 及测试 |
| 3 | V2 API | 在隔离库验证只读结果、任务候选接口和失败回退 |
| 4 | React Island | 增加嵌入入口、主壳认证适配和生产构建产物 |
| 5 | 共享主壳接入 | 逐段合入 `server.mjs`、`app.js`、`index.html` |
| 6 | 候选迁移 | 修订后在复制库演练；正式库应用需要再次批准 |
| 7 | 报告与验收 | 全量测试、Build、Doctor、视觉和数据库保护报告 |

## 4. 前端集成方案

### 4.1 推荐边界

保留 Commerce Ops 原生主工作台作为唯一应用壳：

- 唯一登录会话
- 唯一全局导航
- 唯一 Growth Radar 导航入口
- A2 数据和范围配置继续保留

将 `frontend/growth-radar-v2` 作为 Growth Radar 工作区内的 React Island：

```text
Commerce Ops 主工作台
└── Growth Radar 工作区
    ├── 今日作战 / 店铺 / 货盘 / 产品 / 任务：React V2.2
    └── 数据范围 / 来源 / A2 配置：现有原生 A2
```

不使用 iframe，不重复登录，不创建第二个侧边栏。

### 4.2 当前差距

#### 嵌入入口

当前 `frontend/growth-radar-v2/src/main.tsx` 只支持独立页面的 `#root` 挂载。需要拆出可复用工作区组件，并提供显式生命周期：

```ts
mountGrowthRadarV2(container, hostContext)
unmountGrowthRadarV2()
```

独立开发入口可以继续保留，但嵌入模式不得渲染自己的全局 Sidebar 和顶层应用壳。

#### 统一认证

主工作台通过 `createAuthorizedFetch` 注入 Bearer Token，并统一处理 401 和会话锁定。

当前 React `src/api.ts` 直接调用全局 `fetch`，不会继承主工作台认证。这是 P0 问题。React Island 必须接收主壳注入的 `authorizedFetch`，不得读取第二套凭据或自行实现登录。

#### 统一路由

主导航仍使用现有 `growth-radar` 页面标识。React 内部只管理 Growth Radar 子视图，不接管浏览器顶层导航。

建议由主工作台控制工作区显示和销毁，React 内部使用可序列化的子路由状态，并保留旧原生 V2 临时回退开关。

#### 样式边界

React、Ant Design 和 Tailwind 不得污染原生工作台。

进入 INT-1 时应先验证以下两种隔离方式：

1. Shadow Root + Ant Design portal 容器适配。
2. 严格的 `.grv2-app` 前缀和受控 reset。

只有通过桌面和移动端视觉检查后，才能确定最终方式。

#### 构建和静态资源

当前根项目不是 npm workspace，根 `build` 不会构建 React 工程；服务端也只暴露 `public/`。

正式接入必须增加：

- React 子工程依赖锁定和类型检查
- Vite production build
- manifest 校验
- 版本化静态资源复制或受控输出到 `public/assets/growth-radar-v2/`
- 根 Build 对 React 产物的完整性检查

不应在 `index.html` 中手工写死带哈希的产物文件名。

### 4.3 渐进启用

建议保留独立开关：

- V2.2 UI
- V2.2 分析读取
- 运营任务写入
- 自动分析调度
- 旧原生 V2 回退

第一阶段只开启 UI 和最新 published 结果读取。任务写入、自动运行和正式迁移分别批准。

## 5. 数据库迁移方案

当前 019/020/021 都是未应用正式库的候选迁移。它们整体采用新增表和视图的方式，不修改 A2、COM-015 或现有业务数据，方向正确；但当前内容尚未完全符合 GRV2-METRICS-1.2.0。

### 5.1 迁移 019

文件：

```text
migrations/019_growth_radar_v2_analysis.sql
```

用途：

- 国家映射配置
- 规则集
- 分析运行
- SKU、店铺和店铺-SKU 指标投影
- 确定性信号
- 最新 published 视图

必要性：

> 必要。它承载 V2.2 的只读分析结果，不重复订单和库存事实表。

对现有数据的影响：

- 设计上只新增表、索引、视图和规则候选行。
- 不更新或删除现有 A2、COM-015、产品和 Listing 数据。

当前问题：

- 指标列仍偏向旧版 `source_visible_sales` 和计算型可售天数。
- 未完整保存 1.2.0 要求的来源预测日销量、当前/前 7 天销量、马帮直接可售天数、活跃度和新品标记证据。
- 旧规则种子不应作为新的正式激活合同。

结论：

> 保留迁移职责，先按 1.2.0 修订候选结构，再在隔离库演练。当前文件不应用正式库。

### 5.2 迁移 020

文件：

```text
migrations/020_growth_radar_direction_contract.sql
```

用途：

- 激活正式后继指标合同。
- 记录规则版本、阈值和有效订单状态。

必要性：

> 建议保留。结构迁移和业务规则激活分开，有利于回滚、审计和灰度。

对现有数据的影响：

- 只影响新建的规则集记录和激活状态。
- 不触碰订单、库存、图片、产品或 Listing 数据。

当前问题：

- 当前内容仍激活 `GRV2-METRICS-1.1.0`。
- 有效订单只配置 `已发货`，与新来源合同不一致。

1.2.0 要求的有效订单状态为：

```text
已发货 + 待处理 + 配货中 + 已完成
```

结论：

> 当前 020 已过期。应在 1.2.0 正式确认后重写候选内容，未经确认不得演练或应用。

### 5.3 迁移 021

文件：

```text
migrations/021_growth_radar_task_lifecycle.sql
```

用途：

- 复用 `growth_focus_items` 和 `growth_focus_item_events` 承载运营任务生命周期。
- 保存优先级、负责人、状态、证据、建议动作和事件记录。

必要性：

> 对“超级店长运营助手”的可写任务闭环必要，但不是只读驾驶舱上线的前置条件。

对现有数据的影响：

- 新增任务和事件表、索引和视图。
- 不修改现有业务事实。

当前问题：

- `task_type` 和规则代码主要来自旧 V2.2 设计，需与 1.2.0 的国家机会、店铺高潜缺口和跨国候选规则对齐。
- 任务大类应保持稳定，具体指标变化应通过 `rule_code` 和证据表达，避免每次合同升级都修改表约束。

结论：

> 021 独立保留并延后。先完成只读分析和 UI 验收，再批准任务写入及正式迁移。

### 5.4 推荐应用顺序

```text
修订并冻结 019
→ 复制库 / 隔离库演练
→ 修订并确认 020
→ 019 + 020 联合演练
→ 人工批准正式应用
→ 只读分析验收
→ 修订和演练 021
→ 人工批准任务写入
```

## 6. 数据接入方案

### 6.1 正确数据链路

库存和订单应继续通过同一事实层进入 Growth Radar：

```text
马帮手动或定时导出
→ 马帮数据持久化服务
→ A2 preview / apply 校验
→ growth_order_* / growth_inventory_* 事实表
→ V2.2 确定性分析运行
→ 019 分析投影和 signals
→ 最新 published 视图
→ V2 API
→ React Island
```

V2.2 不直接读取 Excel、临时文件或 COM-015 图片表，也不复制订单和库存事实。

### 6.2 当前数据入口缺口

依据已确认的马帮来源合同，订单和库存需要保留以下语义：

- 订单：店长、国家、付款时间、有效订单状态、跨行订单表头继承。
- 库存：7/28/42 天货盘销量、预测日销量、马帮直接可售天数、活跃度、是否新款、仓库。

当前解析边界存在以下问题：

1. 订单允许字段未完整包含 `店长` 和 `国家`。
2. 当前只把 `已发货` 归为有效销量，未包含 `待处理`、`配货中` 和 `已完成`。
3. 订单导出中的商品续行可能缺少重复订单表头，现有逐行必填校验可能拒绝大量有效商品行。
4. 库存解析未保留马帮的 `当前可售天数`。
5. 库存解析未完整保留 `活跃度` 和 `是否新款`。
6. 当前 V2 engine 仍会自行重算可售天数，并使用旧销量口径。

这不是页面问题，而是结果可信度问题。

由于本节点禁止修改 A2，当前只记录门禁：

> 必须由用户单独批准一个“马帮来源合同兼容”节点。该节点优先采用输入标准化适配器或最小 parser 扩展，不重写 A2 核心范围、权限、审计和正式库保护逻辑。

### 6.3 分析结果生成位置

建议继续在主后端进程的 Growth Radar V2 service 中生成分析结果：

- 输入：A2 已应用事实表和用户维护的国家映射配置。
- 计算：确定性 engine，固定 `rule_version`。
- 输出：019 的指标表和 signals。
- 发布：只有完整成功的运行变成 `published`。
- 失败：保留上一条成功 published 结果。

第一阶段只允许人工触发隔离运行。自动调度应在数据窗口、国家映射、店铺负责人和性能门禁全部通过后另行批准。

## 7. 风险列表

| 级别 | 风险 | 影响 | 门禁 |
| --- | --- | --- | --- |
| P0 | 混合工作树和共享文件归属不清 | 误带 COM-015 或其他节点改动 | 先建立文件及代码块归属基线 |
| P0 | React 使用原生 `fetch` | 主工作台内 API 401 或出现第二套认证 | 注入 `authorizedFetch` |
| P0 | 马帮输入字段和状态丢失 | 店铺、趋势、新品、可售天数结论错误 | 单独批准来源合同兼容 |
| P0 | 019/020 和 engine 仍基于旧合同 | 数据库、API、UI 口径不一致 | 正式确认 1.2.0 后统一修订 |
| P1 | React 自带 Sidebar 和应用壳 | 重复导航、交互割裂 | 拆分独立与嵌入入口 |
| P1 | 根构建不包含 React | 开发可见、生产缺资源 | 增加 manifest 驱动构建 |
| P1 | AntD/Tailwind 与原生 CSS 冲突 | 页面视觉和弹层异常 | 先完成样式隔离验证 |
| P1 | 021 任务类型与新规则不一致 | 后续迁移频繁修改 | 稳定任务大类，规则放 `rule_code` |
| P1 | 旧 107 店 / 27 仓审计数字过期 | 配置门禁和覆盖率错误 | 使用最新来源文件重新生成 readiness |
| P1 | 自动分析过早启用 | 每日生成不可解释或不完整结果 | 先人工运行和发布 |
| P2 | React 包体和图表首屏成本 | 主工作台首屏变慢 | 路由级懒加载和产物预算 |
| P2 | 旧原生 V2 与 React 并存 | 维护两套口径 | 设置迁移期限和回退退出条件 |

## 8. 下一步开发计划

### INT-0A：合同与归属关闭

开始写代码前需要人工确认：

1. `GRV2-METRICS-1.2.0` 从候选转为正式后继合同。
2. 允许单独修改马帮数据进入 A2 的解析/标准化边界，但不改变 A2 核心逻辑。
3. 同意按文件和代码块隔离当前混合工作树，不整文件提交共享入口。

### INT-1：来源合同兼容

- 订单表头续行标准化。
- 保留店长、国家和付款时间。
- 支持四种有效订单状态。
- 保留库存 7/28/42、预测日销量、来源可售天数、活跃度和新品标记。
- 使用样例 Excel 和隔离库验证，不修改正式数据。

### INT-2：1.2.0 数据投影和计算

- 修订 019 候选结构。
- 修订 engine、repository 和 service。
- 保存输入、公式、证据和 `rule_version`。
- 在 20,000 SKU Mock 和正式库复制件上验证性能与幂等。

### INT-3：只读 API

- 返回最新成功 published 结果。
- 提供今日任务候选、店铺诊断、国家类目机会、产品雷达和 SKU 证据。
- 分析失败时继续返回上一成功结果。
- 不开放任务写入。

### INT-4：React Island

- 拆分独立开发入口和嵌入入口。
- 删除嵌入模式下的重复主导航。
- 接收主壳认证、当前用户和工作区导航。
- 完成图表空态、数据不足态、错误态和加载态。

### INT-5：共享主壳接入

- 逐段合入 `server.mjs`、`data-access.mjs`、`app.js` 和 `index.html`。
- 保留 A2 数据/configuration 入口。
- 默认关闭 V2.2 正式开关。
- 不包含 COM-015 代码块。

### INT-6：构建和验收

- React typecheck、test、build 和 manifest 校验。
- Growth Radar 专项和全量测试。
- 根 Build 和 Doctor。
- 隔离迁移演练。
- 桌面和移动端视觉验收。
- 认证、权限、失败回退和正式数据库未修改证明。

### INT-7：分步启用

1. 只读 UI。
2. 人工触发分析。
3. 019/020 正式迁移，需人工批准。
4. 最新 published 结果读取。
5. 021 和任务写入，需再次批准。
6. 自动每日分析，最后单独批准。

## 9. 本节点验证

- 未修改生产代码。
- 未修改 A2。
- 未修改 COM-015。
- 未创建或执行 migration。
- 未连接或修改正式数据库。
- 未合并或暂存文件。
- 未运行测试和 Build；本节点仅执行只读审计并新增本报告。

当前等待人工确认，不进入主线开发。
