# COM-GROWTH-RADAR-V2.2 阶段报告：运营助手与数据门禁

- 日期：2026-07-27
- 分支：`master`
- 基线 HEAD：`a8327c524764f89eda8127e32b4aa48e38c3fac6`
- 产品合同：`GRV2-SUPER-MANAGER-2.2`
- 指标合同：基础合同 `GRV2-METRICS-1.0.1` 已冻结；候选方向合同 `GRV2-METRICS-1.1.0` 待人工确认
- 实施状态：代码候选完成，正式数据发布仍受门禁保护

## 1. 本阶段完成内容

本阶段将独立 React 工作区从静态线框推进为可消费只读 Growth Radar API 的“超级店长运营助手”：

1. 今日作战台以运营任务为第一入口，每位店长最多展示 10 项任务。
2. 店铺状态严格使用 `需处理`、`观察`、`稳定`、`阻塞`。
3. 销售趋势按当前 7 天与前 7 天比较；历史不足时返回 `insufficient_history`，不把缺失数据当作 0。
4. 蓝海机会动作统一为“核查在线状态后低风险测试”。
5. 跨国家机会统一命名为“跨国候选”。
6. 国家与店铺归属配置由前端展示，当前真实模式保持只读，写入按钮受正式门禁禁用。
7. 页面支持模拟数据与真实数据门禁两种模式。真实分析未达到发布条件时，不显示伪造任务或经营结论。
8. 当后端存在最新已发布分析时，任务、店铺、产品和国家类目机会数据会替换前端样例。

## 2. 架构变化

### 后端

新增或完善以下只读能力：

- `GET /api/growth-radar/v2/assistant/workspace`
  - 返回最新已发布分析、运营任务、店铺状态、产品方向和机会地图。
  - 不满足数据准备度时，`operationTasks` 返回空数组，仅保留诊断候选。
- `GET /api/growth-radar/v2/assistant/configuration`
  - 复用 A2 现有店铺映射事实和最新库存仓库事实。
  - 返回仓库国家映射、来源店铺映射、店长归属和准备度。
  - `writeGate.enabled` 当前固定为 `false`，避免在未批准前写入正式配置。

分析证据增加当前 7 天和前 7 天销量输入。趋势由确定性规则计算为：

- `GROWING`
- `DECLINING`
- `STABLE`
- `NEWLY_SELLING`
- `INSUFFICIENT_HISTORY`

本阶段没有改变已经冻结的指标阈值，也没有新增黑盒评分。

### 前端

独立工作区：

`frontend/growth-radar-v2`

技术栈：

- React
- TypeScript
- Ant Design
- Tailwind CSS
- ECharts

已实现：

- 今日作战台
- 我的店铺战场
- 店铺缺口诊断
- 国家 × 类目机会地图
- 产品雷达
- 市场验证表现 vs 我方承接
- 全部任务、观察项和已完成任务
- 数据准备与映射
- 任务、店铺和 SKU 详情抽屉
- 桌面与 430px 移动端响应式布局

## 3. 文件范围

主要后端文件：

- `lib/growth-radar/v2/growth-radar-v2-assistant.mjs`
- `lib/growth-radar/v2/growth-radar-v2-engine.mjs`
- `lib/growth-radar/v2/growth-radar-v2-repository.mjs`
- `lib/growth-radar/v2/growth-radar-v2-service.mjs`
- `lib/growth-radar/v2/growth-radar-v2-api.mjs`

主要前端文件：

- `frontend/growth-radar-v2/src/App.tsx`
- `frontend/growth-radar-v2/src/api.ts`
- `frontend/growth-radar-v2/src/types.ts`
- `frontend/growth-radar-v2/src/fixtures.ts`
- `frontend/growth-radar-v2/src/styles.css`
- `frontend/growth-radar-v2/src/components/*`

测试：

- `tests/growth-radar-v2.test.mjs`
- `tests/growth-radar-v2-react-workspace.test.mjs`

本阶段未修改：

- A2 核心逻辑
- COM-015 图片业务逻辑
- 旧原生 Growth Radar V2 共享入口
- 正式 SQLite 数据
- migration 历史

## 4. 数据影响

正式数据库保持只读，最高已应用迁移仍为：

`018_mabang_image_collection_performance.sql`

工作树中的以下文件仍只是候选迁移，未应用到正式数据库：

- `019_growth_radar_v2_analysis.sql`
- `020_growth_radar_direction_contract.sql`

`growth_focus_items` / `growth_focus_item_events` 尚未成为正式物理表，因此任务生命周期当前只在 API 投影层表达，未宣称已经持久化。

## 5. 验证结果

| 验证项 | 结果 |
| --- | --- |
| Growth Radar V2 后端与前端契约测试 | 23/23 PASS |
| React 工作区契约测试 | 13/13 PASS |
| 全量测试 | 708/708 PASS |
| 根项目 Build | PASS |
| React TypeScript / ESLint 检查 | PASS |
| React 生产构建 | PASS |
| Doctor | PASS，无 ERROR |
| `git diff --check` | PASS |
| 桌面浏览器验收 | PASS |
| 430px 移动端验收 | PASS，无横向溢出 |
| 浏览器控制台错误 | 0 |
| ECharts 画布 | 6 个均非空 |

React 构建存在单个 chunk 约 1.71 MB 的警告，不影响当前功能验证；后续可按页面路由拆包。

视觉证据：

- `docs/reports/grv2-v22-published-api-desktop.png`
- `docs/reports/grv2-v22-published-config-mobile.png`

本地预览：

`http://127.0.0.1:4174`

## 6. 当前发布门禁

正式数据仍存在以下门禁：

1. 候选迁移 019/020 尚未获准进入正式数据库。
2. `growth_focus_items/events` 的任务生命周期持久化需要单独的数据模型和 migration 批准。
3. 正式环境仍需完成来源店铺、国家和店长归属确认。
4. 真实趋势发布需要连续 14 个完整业务日；缺失时必须继续 fail closed。
5. 预测日销量的来源语义需要保持为“来源预测/市场验证参考”，不得称为公司实际销量。
6. `GRV2-METRICS-1.1.0` 已被候选代码和迁移使用，但尚未取得替代 `1.0.1` 的明确人工批准。

## 7. 下一人工批准点

在继续正式数据落地前，需要分别批准：

1. 对候选 migration 019/020 先执行复制库/隔离库演练和结构审计。
2. 是否允许新增任务生命周期持久化 migration，复用 `growth_focus_items` / `growth_focus_item_events` 语义。
3. 演练通过后，是否进入正式数据库备份与迁移节点。

在获得以上批准前，不启动正式分析运行，不开放配置写入，不生成正式店长运营任务。
