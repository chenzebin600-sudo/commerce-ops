# COM-GROWTH-RADAR-V2 重构 R0 工作树与文件归属审计

> 日期：`2026-07-25`
> 阶段：`R0`
> 结论：`CONDITIONAL_PASS`
> 下一状态：等待确认 React 替代边界；未进入 R1

## 1. Git 基线

| 项目 | 结果 |
|---|---|
| 当前分支 | `master` |
| 当前 HEAD | `a8327c524764f89eda8127e32b4aa48e38c3fac6` |
| `origin/master` | `a809f9c9cb48b0b16eb77a0a3780487d12fe10c1` |
| 分支关系 | `ahead 2, behind 0` |
| 暂存修改 | `0` |
| 已跟踪状态项 | `30` |
| 有实际内容差异的已跟踪文件 | `29` |
| 未跟踪文件 | `36` |

本地 `master` 超前的两个提交均属于 COM-015：

```text
bb0002e feat: cap Mabang image batches by unique SKU
a8327c5 fix: retain Mabang batch limit audit metadata
```

`lib/mabang-images/browser-session.mjs` 被 Git 状态标为修改，但工作区内容哈希与索引完全一致，当前没有实际内容差异。

三个 A2 保护 stash 均完整保留，未 apply、pop 或 drop：

- `df08119e338018d32d7dd133d21a50b0ca14cce5`
- `84441ced533ad105bdc7881191797209acfa919e`
- `8238953c06cd057385629025abde25713a93d716`

## 2. 未提交修改归属

### 2.1 Growth Radar V2 专属未跟踪文件

以下是此前 V2 候选实现和文档，当前均未提交：

- `docs/design/COM-GROWTH-RADAR-V2-*.md`
- `docs/reports/COM-GROWTH-RADAR-V2-*.md`
- `lib/growth-radar/v2/*`
- `migrations/019_growth_radar_v2_analysis.sql`
- `migrations/020_growth_radar_direction_contract.sql`
- `public/growth-radar-v2-page.mjs`
- `public/growth-radar-v2.css`
- `public/growth-radar-workspace.mjs`
- `tests/growth-radar-v2.test.mjs`
- `tests/growth-radar-v2-frontend.test.mjs`

这些文件属于旧 V2 候选实现。它们可以作为算法、API 和证据契约的参考，但旧前端不能作为新 React 页面验收基线。

### 2.2 A2 与数据基础在途修改

以下已跟踪文件存在修改，但 R1 禁止触碰：

- `lib/growth-radar/growth-radar-service.mjs`
- `public/growth-radar-page.mjs`
- `scripts/validate-growth-radar-g1a5.mjs`
- `tests/growth-radar-foundation.test.mjs`

修改内容涉及来源幂等键、A2 根节点装配参数、隔离验证期望和基础测试兼容。它们不是 React 重构范围。

### 2.3 COM-015 和马帮数据在途修改

以下修改与 Growth Radar React 重构无关：

- `.env.example`
- `docs/postgresql-readiness.md`
- `lib/data/repositories/product-catalog-repository.mjs`
- `lib/mabang-images/*`
- `lib/mabang-scheduler/executor.mjs`
- `lib/security/file-policy.mjs`
- `public/mabang-images-page.mjs`
- `public/product-center-page.mjs`
- `public/styles.css`
- `scheduler.mjs`
- `scripts/mabang_worker.py`
- `scripts/postgresql-readiness.mjs`
- `tests/mabang-sku-image-collector.test.mjs`
- `tests/postgresql-readiness.test.mjs`
- `tests/scheduler-integration.test.mjs`
- `lib/mabang-data/persistence-service.mjs`
- `lib/mabang-images/worker-session.mjs`
- `migrations/017_mabang_full_image_sync.sql`
- `migrations/018_mabang_image_collection_performance.sql`
- `tests/mabang-data-persistence.test.mjs`

R1 不得修改、格式化、暂存、提交或回退这些文件。

### 2.4 混合共享入口

以下文件同时包含旧 V2 和 COM-015/马帮修改，风险最高：

| 文件 | Growth Radar 内容 | 其他内容 |
|---|---|---|
| `server.mjs` | V2 service/API 装配 | 马帮后台登录、图片同步、数据持久化 |
| `public/app.js` | Growth Radar workspace 入口 | 产品中心和图片页面缓存版本 |
| `public/index.html` | V2 CSS 入口 | COM-015 图片预览、上传、同步 UI |
| `lib/security/audit-http.mjs` | V2 配置审计 | COM-015 同步、上传、关联审计 |
| `lib/security/audit-service.mjs` | V2 配置动作名称 | COM-015 动作名称 |

以下共享基础设施当前只包含 V2 装配差异，但仍不应在 R1 直接修改：

- `lib/data/data-access.mjs`

`public/styles.css` 的当前实际新增内容属于 COM-015；Growth Radar V2 使用独立 CSS 文件。

## 3. 设计与代码冲突

### 3.1 前端技术冲突

当前候选前端：

```text
public/growth-radar-v2-page.mjs
+ public/growth-radar-v2.css
```

使用原生 JavaScript 和手工 HTML 字符串渲染，没有 React、TypeScript、Ant Design、Tailwind CSS 或 ECharts 依赖。

新确认合同要求：

```text
React + TypeScript + Ant Design + Tailwind CSS + ECharts
```

因此 R1 不能在旧页面上继续小修，必须建立独立 React island。旧页面暂时保留，直到新岛完成隔离验证后再决定入口切换。

### 3.2 数据模型缺口

现有迁移候选 `019/020` 已包含：

- 分析运行
- SKU 指标
- 店铺和店铺 SKU 指标
- 确定性信号
- 国家映射和规则配置

新线框中的以下能力尚无完整持久化模型：

- 国家 x 类目预聚合结果
- 每位店长每日最多 10 项运营任务
- 任务明细和人工状态事件

补齐这些能力将涉及数据模型变化和新增 migration。根据用户门禁，R0/R1 不得执行；进入后端数据阶段前必须单独请求确认。

## 4. R1 安全文件边界

若用户确认，R1 只允许新增：

```text
frontend/growth-radar-v2/**
docs/reports/COM-GROWTH-RADAR-V2-REBUILD-R1-REPORT.md
```

R1 目标：

- 建立独立 React + TypeScript 工程。
- 安装 Ant Design、Tailwind CSS、ECharts 和 Lucide React。
- 实现已确认驾驶舱的信息架构、响应式骨架和本地 fixture 展示。
- 不接入正式数据库。
- 不创建 migration。
- 不修改旧 V2、A2、COM-015 或共享入口。
- 不切换现有生产页面入口。

R1 完成后再审查集成入口。任何需要修改 `server.mjs`、`public/app.js` 或 `public/index.html` 的操作必须先对混合改动做逐 hunk 合并方案。

## 5. 数据影响

- 未打开或修改正式 SQLite。
- 未执行迁移。
- 未创建 migration。
- 未修改 COM-015。
- 未修改 A2。
- 本阶段只新增本审计报告和此前已确认的两份重构设计文档。

## 6. 测试结果

R0 为只读审计，没有运行业务测试、Build 或 Doctor。

已完成：

- Git 分支、HEAD、上游和提交差异检查。
- 暂存区、已跟踪修改和未跟踪文件清点。
- 共享入口逐 hunk 归属检查。
- 现有前端依赖检查。
- Node/npm 环境检查：Node `v24.14.0`，npm `11.9.0`。
- 当前没有 `.openai/hosting.json`。

## 7. 风险

1. 当前 `master` 同时承载未推送 COM-015 提交和大量未提交并行工作。
2. 旧 V2 前端技术栈与新合同不一致。
3. 共享入口同时存在 Growth Radar 与 COM-015 修改，不能整文件覆盖。
4. 现有 019/020 不足以持久化完整运营任务闭环。
5. 当前根 `package.json` 没有任何 React 前端依赖。

## 8. R0 结论

R0 对“独立 R1 React 基础建设”有条件通过，但根据“设计文档与代码冲突必须停止”的规则，当前停在 R1 前。

建议确认以下执行边界：

```text
同意 R1 在 frontend/growth-radar-v2 独立新建 React 工程；
旧原生 V2、共享入口、A2、COM-015、迁移和正式数据库暂不修改。
```
