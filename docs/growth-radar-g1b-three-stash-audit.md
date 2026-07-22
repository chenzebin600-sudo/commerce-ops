# Growth Radar G1B 三份 Stash 审计与正式库隔离确认

审计时间：2026-07-22（Asia/Shanghai）  
审计分支：`feature/deterministic-growth-radar-g1b`  
审计前 HEAD：`e2fef3c46d286a87a422ca733737dae28d15a835`  
审计工作树：`C:\Users\PC\.codex\worktrees\growth-radar-g1b\commerce-ops`

## 1. 结论

1. 三个 stash 均可读取，均以同一基准 `e2fef3c46d286a87a422ca733737dae28d15a835` 创建；原 stash 未应用、未删除、未修改。
2. 已建立三个本地 `refs/archive/a2/*` 保护引用。它们只保护对象，不是业务分支，未推送。
3. 正式库写入进程曾在审计开始时运行：主服务 3101、scheduler、start-all 与广告子服务。按本节点要求停止后，主库和 WAL 在 11 分 24 秒复核窗口内大小、修改时间及 SHA-256 均未变化，WAL 已静止。
4. 三个 stash 不包含迁移；未修改 013/014，未创建 015/016，未新增表或字段，未写 `schema_migrations`。G1B 可在复用 013/014 的前提下完成，不需要数据库结构调整。
5. 最新 stash 是最早 repository 片段与中间 API/service 片段的集成版本，并增加 UI、审计路由和测试；它不是可以整体恢复的正确成品。
6. 当前不能直接进入 G1B 正式开发。必须先把 A2 启动路径固定为隔离库并增加安全失败门禁，再按本文逐文件移植；不得整体应用任一 stash。

## 2. 现场与正式 SQLite 隔离

### 2.1 Git 现场

- 分支正确：`feature/deterministic-growth-radar-g1b`
- 审计前 HEAD 正确：`e2fef3c46d286a87a422ca733737dae28d15a835`
- 审计前工作树干净。
- migrations 最高为 `014_deterministic_growth_radar_scope_and_linkage.sql`；不存在 015、016 或更高迁移。
- 3193 在审计开始时没有监听。

### 2.2 发现并停止的正式环境进程

审计开始时发现以下同一主系统进程组：

| PID | 角色 | 证据 |
|---:|---|---|
| 33336 | npm 启动包装 | `npm run start` |
| 4040 | npm 启动包装 | `npm run start:all` |
| 35188 | 监督进程 | `scripts/start-all.mjs` |
| 3592 | 正式主服务 | `C:\Users\PC\Documents\New project2\server.mjs`，监听 3101 |
| 36112 | 正式调度器 | `C:\Users\PC\Documents\New project2\scheduler.mjs` |
| 33296 | 托管广告子服务 | `node server.mjs`，监听 4173，父进程为 3592 |

上述进程已按本节点要求停止。停止后 3101、3193、4173 均无连接，未发现支线 B 服务、项目后台 Node、测试进程或自动任务进程。Codex/MCP 进程未停止。

主系统 `.env.local` 的正式路径配置为 `SCHEDULER_DB_PATH=storage/commerce-ops.sqlite`。广告服务配置目录为 `D:\codex\Lazada-Sponsored Max analysis\webapp`；主系统的 `advertisingChildEnvironment` 会删除 `DATABASE_PATH`、`SCHEDULER_DB_PATH` 和所有主 storage 根变量。广告项目没有 SQLite 路径引用，也没有发现 `.sqlite`/`.db` 文件，因此没有证据表明广告服务访问正式 Commerce Ops SQLite。广告服务在本审计结束时保持停止。

### 2.3 正式库指纹

正式库完整路径：`C:\Users\PC\Documents\New project2\storage\commerce-ops.sqlite`

停止正式环境进程后，以 2026-07-22 10:40:53.837 +08:00 为静止基准；第二次检查为 10:52:17.999 +08:00，间隔 11 分 24 秒。

| 文件 | 第一次大小 | 第二次大小 | 修改时间变化 | SHA-256 变化 |
|---|---:|---:|---|---|
| `commerce-ops.sqlite` | 260,849,664 | 260,849,664 | 无，均为 09:34:04.498 | 无，`4DDDE54B38D6F9108E477EE0538A61FC27E44196E4D434D0303218A9DA989222` |
| `commerce-ops.sqlite-wal` | 1,664,512 | 1,664,512 | 无，均为 10:40:04.707 | 无，`5D97C42B577D20C34E99DF162C5BE48B307E38390B4D3A6040BFAA0AFB7EAF70` |
| `commerce-ops.sqlite-shm` | 32,768 | 32,768 | 有：09:37:51.729 → 10:41:23.480 | 按要求不计算 |

说明：停止进程前 WAL 仍在增长，10:39:37 时为 1,652,152 字节，停止进程后最终到 1,664,512 字节。静止基准建立后 WAL 不再增长。SHM 大小未变化，但执行附件要求的只读 `integrity_check`/`foreign_key_check` 后修改时间更新了一次；这是连接与共享锁状态的辅助文件变化，不是业务行变化，仍按“SHM 有变化”如实记录。未删除 WAL/SHM，未执行 truncate 或 checkpoint。

只读数据库检查结果：

- 最高已应用迁移：`014_deterministic_growth_radar_scope_and_linkage.sql`
- `PRAGMA integrity_check`：`ok`
- `PRAGMA foreign_key_check`：0 条违规
- 15 个 `growth_*` 业务表行数均为 0
- `product_skus=18347`
- `product_package_rows=21714`
- `product_images=1`
- `product_listing_drafts=0`
- `product_listing_publish_records=0`

上述计数与现场保护检查的基线一致。主库和 WAL 的第二次哈希也一致，因此停止服务后的正式业务数据未变化。

### 2.4 A2 隔离开发库

隔离库：`C:\Users\PC\.codex\worktrees\growth-radar-g1b\commerce-ops\storage\development\growth-radar-g1b.sqlite`

- 最高迁移：014
- `integrity_check=ok`
- 外键违规：0
- 全部 `growth_*` 表为 0 行
- Product Center 关键表均为 0 行
- 3193 没有监听

隔离库及其 WAL/SHM、启动日志和内部 token 是被 Git 忽略的运行时文件，保持原样，未纳入 stash、未删除。

## 3. A2 环境变量与路径风险

### 3.1 当前静态行为

`resolveRuntimeConfig` 在没有环境变量时使用：

- `STORAGE_ROOT=<当前工作树>/storage`
- `UPLOAD_ROOT=<当前工作树>/storage/uploads`
- `EXPORT_ROOT=<当前工作树>/storage/exports/mabang`
- `TEMP_ROOT=<当前工作树>/storage/temp`
- `DATABASE_PATH=<当前工作树>/storage/commerce-ops.sqlite`

相对路径以代码所在工作树为根，因此在 A2 工作树启动时不会自动跳到 `C:\Users\PC\Documents\New project2\storage\commerce-ops.sqlite`。但 A2 工作树没有持久化 `.env.local`，代码也不会强制要求 `growth-radar-g1b.sqlite`；漏设环境变量时会静默创建或使用另一个 `<A2>/storage/commerce-ops.sqlite`。上传、导出和临时目录也会退回 `<A2>/storage/*`，而不是指定的 `storage/development/*`。

`SqliteProvider` 会创建数据库父目录并以可写方式打开数据库。`openSchedulerDatabase` 只在“项目内默认库已经存在、显式替代库不存在”时拒绝启动，不能证明 A2 的路径就是要求的隔离路径。

测试方面，Growth Radar 主测试通过 `mkdtemp` 创建临时数据库；相关产品、调度和迁移测试也显式使用临时目录或内存库。未发现测试默认回退到主线正式绝对路径。

### 3.2 风险结论与开发前门禁

正式库绝对路径隔离目前成立，但“明确绑定 A2 隔离库、漏配时安全失败”的要求不成立。进入正式开发前必须：

1. 用仅本地、被 Git 忽略的 A2 环境配置显式设置 `DATABASE_PATH`、`SCHEDULER_DB_PATH`、`STORAGE_ROOT`、`UPLOAD_ROOT`、`EXPORT_ROOT` 和 `TEMP_ROOT`，全部位于 `storage/development`。
2. 启动前解析并打印非敏感规范化路径，拒绝任何指向 `C:\Users\PC\Documents\New project2\storage` 的路径。
3. 对 G1B/A2 启动增加“缺失隔离标志或数据库路径不等于批准路径即失败”的门禁；不能仅依赖通用默认值。
4. 测试继续显式传入临时数据库，不运行会读取正式 `.env.local` 的启动级测试。

本节点只记录风险，不修改业务代码或环境配置。

## 4. Stash 保护引用

已建立并验证：

| 保护引用 | 对象 |
|---|---|
| `refs/archive/a2/g1b-interrupted-latest` | `df08119e338018d32d7dd133d21a50b0ca14cce5` |
| `refs/archive/a2/g1b-partial-middle` | `84441ced533ad105bdc7881191797209acfa919e` |
| `refs/archive/a2/g1b-partial-oldest` | `8238953c06cd057385629025abde25713a93d716` |

三个引用均解析为 `commit` 对象。原 stash 仍保留在 `stash@{0}`、`stash@{1}`、`stash@{2}`；后续 stash 顺序即使变化，也不影响 archive 引用。引用仅保存在本地，不应推送。

## 5. 三个 Stash 基本信息

| 顺序 | 对象 | 创建时间 | 原始分支 | 原始 HEAD/第一父提交 | index 父提交 | 未跟踪父提交 |
|---|---|---|---|---|---|---|
| 最新 | `df08119e338018d32d7dd133d21a50b0ca14cce5` | 2026-07-22 10:32:43 +08:00 | `feature/deterministic-growth-radar-g1b` | `e2fef3c46d286a87a422ca733737dae28d15a835` | `c6849645a72bf333f268d9d8d952b4d8965be2af` | `42e8c1605cb71ae941be8515c9553cd5b3795b1d`，空树差异 |
| 中间 | `84441ced533ad105bdc7881191797209acfa919e` | 2026-07-22 10:14:01 +08:00 | 同上 | 同上 | `0d284f2e704c686cd8ae5492aef48dfa48bd386f` | 无 |
| 最早 | `8238953c06cd057385629025abde25713a93d716` | 2026-07-22 10:13:41 +08:00 | 同上 | 同上 | `7f8b53777ca85774eeb7a324e83f1219d9032904` | 无 |

三个 stash 均无暂存区修改，全部业务差异来自未暂存修改。最新 stash 因使用 `--include-untracked` 生成了第三父提交，但第三父提交没有文件；三个 stash 实际均不含未跟踪文件。

| Stash | 修改文件 | 新增文件 | 删除文件 | 插入 | 删除 |
|---|---:|---:|---:|---:|---:|
| 最新 `df08119e` | 9 | 0 | 0 | 1,163 | 311 |
| 中间 `84441ced` | 2 | 0 | 0 | 227 | 23 |
| 最早 `8238953c` | 1 | 0 | 0 | 129 | 5 |

三份 patch 均通过 `git diff --check`，没有空白错误。

## 6. 完整文件差异与推荐来源

“重复比例”采用相对于共同基准的规范化 patch 行多重集合计算；百分比表示较早 stash 的变更行在最新 stash 中仍出现的比例。仅一个 stash 修改的文件记为不适用。

| 文件 | 最早 stash | 中间 stash | 最新 stash | 重复比例 | 推荐来源 |
|---|---|---|---|---:|---|
| `lib/data/repositories/growth-radar-repository.mjs` | 修改 | — | 修改 | 76.6%（最新 patch 的 90.7% 来自最早） | 最早stash |
| `lib/growth-radar/growth-radar-api.mjs` | — | 修改 | 修改 | 100% | 最新stash |
| `lib/growth-radar/growth-radar-service.mjs` | — | 修改 | 修改 | 94.1% | 最新stash |
| `lib/security/audit-http.mjs` | — | — | 修改 | 不适用 | 最新stash |
| `public/app.js` | — | — | 修改 | 不适用 | 以最新主线重写 |
| `public/growth-radar-page.mjs` | — | — | 修改 | 不适用 | 以最新主线重写 |
| `public/growth-radar.css` | — | — | 修改 | 不适用 | 以最新主线重写 |
| `public/index.html` | — | — | 修改 | 不适用 | 以最新主线重写 |
| `tests/growth-radar-foundation.test.mjs` | — | — | 修改 | 不适用 | 最新stash |

### 6.1 最早 stash：repository 片段

完整 patch 只修改 repository，主要包括：

- 从 `source_scope_json` 读取确认状态并更新批次、库存快照和销售指标的范围状态。
- 查询稳定店铺代码、负责人、类目范围、审核备注。
- 增加历史观察列表、来源范围状态、G1B 摘要计数、PII 表头检查和 SQLite 健康检查。
- 不新增表或列，全部复用 013/014。

最早版本的 PII 正则包含 `买家|buyer`。最新 stash 删除了这两个关键词，这是后来版本删除有价值防护的明确例子，因此 repository 以最早 stash 为参考，再按主线代码风格移植。

### 6.2 中间 stash：API 与 service 片段

完整 patch 修改两个文件：

- API：readiness、scope、observations、店铺确认模板和批量确认路由。
- Service：店铺批量确认事务、审核备注、范围证据与审计、历史观察代理、G2 readiness 条件。

API 在最新 stash 中逐行相同。Service 在最新 stash 中保留 94.1% 的中间 patch，并增加 `listShopMappings` 的审核备注回查，修复“最后一条事件没有备注时列表丢失早期备注”的问题；其他差异主要是格式压缩。

### 6.3 最新 stash：集成片段

最新 stash 合并 repository/API/service，并增加：

- 两个审计动作：范围确认、店铺批量确认。
- 九个 G1B 管理视图、CSV 店铺确认、范围表单、历史观察页面、显式预览/应用确认。
- 一整套页面样式、响应式布局、焦点样式和减少动画支持。
- 11 个新增子测试，覆盖原子批量确认、范围审计、G2 阻断、无迁移和审计动作。

它同时包含必须废弃的硬编码 `EXPECTED` 验收数字，并把这些数字用于 UI “与验收基线一致”判断；不能整体恢复。

## 7. 包含、顺序和覆盖关系

1. 最早和中间 stash 创建时间仅相差 20 秒，基准完全相同，修改文件互不重叠：最早只保存 repository，中间只保存 API/service。它们是同一次开发被拆开的互补片段，不是完整度递增的两个快照。
2. 最新 stash 在 18 分 42 秒后创建，包含上述三个核心文件，并增加六个集成文件，是同一次 G1B 开发的集成阶段。
3. 最新 API 100% 包含中间 API；最新 service 包含中间 service 的 94.1% 规范化变更行并有一处有价值修复。
4. 最新 repository 语义上保留最早的大部分功能，但因压缩格式和删除 `买家|buyer`，较早 patch 行包含率为 76.6%。PII 删除属于回归，不应采用。
5. 三个 stash 共同修改的文件为 0；中间和最新共同修改 API/service，最早和最新共同修改 repository。

因此总体参考顺序为：最新 stash 用于了解完整意图；repository 取最早 stash；API/service 与测试取最新 stash 的局部实现；前端按最新主线重写。

## 8. 数据语义审计

| 语义 | 审计结论 |
|---|---|
| `historical_observed` | 正确。观察列表只读取 `growth_shop_sku_observations`，页面明确“历史卖过不等于当前在线”。 |
| `current_online` | 正确阻断。没有权威来源时为 0，readiness 不通过；stash 没有生成在线快照。 |
| `own_sales` | 正确分层。沿用 014 的 `own_sales_*` 字段，来自自有订单。 |
| `company_sales` | 未新增，也未把其他销量命名为公司销量。 |
| `source_visible_sales` | 保持为库存来源可见范围销量，没有写入 `own_sales_*`。 |
| `source_predicted_daily_sales` | 保持 `source_prediction_not_actual` 状态，不等同实际销量。 |
| 店铺范围确认 | 只接受显式 `confirmation_status=confirmed`，事务失败全部回滚；没有自动确认 16 家。但 bulk-confirm 同时更新店铺主数据，权限边界过大，需重写。 |
| SKU 与仓库匹配 | 复用 014 的 SKU + 仓库粒度，没有把多仓合并；readiness 中 `multiWarehouseSkus >= 0` 是无效门槛，需重写。 |
| 未确认数据范围 | `unconfirmed` 不会成为数据库 `confirmed`；部分确认只记录 JSON 证据。没有机会商品排名。但 readiness 把 `partially_confirmed` 视作范围门槛通过，需要产品规则再次确认。 |
| 正式应用流程 | UI 保留 preview → 明确勾选 → apply，并用来源 SHA 做幂等；实际写入哪个库仍完全取决于启动路径，必须先完成 A2 路径门禁。 |

明确错误或高风险行为：

1. `public/growth-radar-page.mjs` 硬编码订单 `2659/1582/229/16` 与库存 `1440/1438/952/6/278` 等数字，并用作“验收基线一致”生产提示。这属于测试/样例数字进入正式结果判断，必须废弃。
2. `confirmedBy` 优先接受请求或 CSV 输入，再回退到审计身份，允许调用者伪造确认人。必须只采用认证审计身份，外部文本只能保存为说明字段。
3. 最新 repository 删除 `买家|buyer` PII 表头检测，降低 PII 防护；必须恢复或由统一 PII 白名单重写。
4. `scopeStatus` 的可见店铺和平台从全部映射读取，而不是绑定当前库存批次，可能把不同批次证据混在一起。
5. readiness 的“销量语义”只比较两张表行数相等，无法证明语义正确；“多仓”条件中的 `>= 0` 恒真；请求路径执行全库 `integrity_check` 成本过高。这些门禁必须重写。
6. CSV 导出没有电子表格公式注入转义；客户端 CSV 解析也没有唯一键、重复行和文件规模门禁。不得直接复用。
7. 测试 53 只检查初始即为 0 的 `product_package_rows`，不能证明非零事实数据未被修改；应先种入哨兵行再比较内容摘要。

未发现以下禁止行为：

- 历史卖过等同当前在线
- 预测销量等同实际销量
- 库存可见销量等同公司销量
- 自动确认 16 家店铺
- 未确认数据直接进入机会排名
- 客户 PII 明文新增到 Growth Radar 表
- 对 `product_package_rows` 执行 INSERT/UPDATE/DELETE
- stash 中硬编码正式数据库路径或自动写正式库

## 9. 迁移审计

三个 stash 均：

- 不包含 `migrations/*` 差异。
- 不修改 013 或 014。
- 不创建 015、016 或更高迁移。
- 不新增表、字段、索引或约束。
- 不写入 `schema_migrations`。

新增需求使用既有字段：范围细节和审计记录保存到 `growth_source_batches.source_scope_json`；确认状态使用现有 `source_scope_status`；店铺审核备注使用现有 `growth_mapping_events.after_json`；历史观察和销售指标使用 013/014 已有表。因此 G1B 可以不创建迁移完成。

## 10. 功能分类

### A. 可直接复用

- API 路由名称与只读 observations/scope/readiness 响应结构，可作为稳定契约起点。
- `audit-http` 中范围确认和店铺批量确认的审计动作映射。
- `historical_observed`/`current_online`、自有销量/来源可见销量/预测销量的页面文案边界。
- 使用已有 JSON 与状态列、保持 013/014 不变的数据库策略。

### B. 可局部移植

- 最早 stash 的 repository：范围状态、观察列表、摘要计数、店铺审核字段；必须保留完整 PII 检测并避免请求内全库健康检查。
- 最新 stash 的 service：批量确认事务、范围证据审计、审核备注回查；必须重做认证身份、权限边界和 readiness 判定。
- 最新 stash 的测试：原子回滚、范围证据、G2 阻断、无迁移、审计动作；必须增加非零哨兵数据、API 权限和路径隔离测试。
- UI 的信息架构、响应式和可访问性样式可作为设计参考，但不直接恢复文件。

### C. 需要重写

- A2 启动隔离与 fail-closed 路径门禁。
- G2 readiness：必须基于可验证证据，不用恒真条件、行数相等或每请求 `integrity_check`。
- 店铺 CSV 导入：服务端解析/校验、重复检测、规模限制、公式注入防护、认证身份与主数据变更权限分离。
- `public/growth-radar-page.mjs`、CSS 与主页面接入：按最新主线重新接入，移除硬编码验收数和过度生产结论。
- 范围证据查询必须绑定来源批次，不能把全局映射混入单批次证据。

### D. 主线已经存在

- 013/014 的数据结构与约束。
- 订单/库存预览与幂等应用。
- 店铺和产品映射、撤销、审计事件。
- historical/current-online 数据库约束。
- own/source-visible/predicted 销量分层。
- PII 解析白名单、权限框架和操作审计底座。

### E. 必须废弃

- 前端 `EXPECTED` 固定验收数字及“与验收基线一致”生产判定。
- 从请求体/CSV 信任 `confirmedBy` 的实现。
- 最新 stash 删除 `买家|buyer` 的 PII 回归。
- `multiWarehouseSkus >= 0`、仅比较表行数等伪 readiness 条件。
- 在用户请求路径运行全库 `PRAGMA integrity_check`。
- 未防公式注入和重复行的客户端 CSV 流程。

## 11. G1B 正式实现方案

推荐顺序：

1. 固定 A2 隔离数据库和所有 storage 根，增加 fail-closed 启动门禁。
2. 确认真实数据源、账号权限边界及店铺范围，不写业务数据。
3. 建立 16 家店铺映射维护流程；来源店铺名、稳定店铺 ID、平台和国家分开。
4. 实现店铺确认状态与认证审计；确认人只来自登录身份。
5. 完成订单批次无写入预览与验收计数展示，不内置固定生产数字。
6. 完成库存批次无写入预览，保留快照 + SKU + 仓库粒度。
7. 完成 SKU 与仓库匹配、国家歧义和人工确认。
8. 完成数据质量问题处理、重处理与可追溯审计。
9. 展示 `historical_observed`，明确其只来自有效历史订单。
10. 将 `current_online` 保持为“缺少权威数据源”，不得推断。
11. 用户明确确认后才正式应用；保持来源 SHA 幂等和事务边界。
12. 完成权限、审计、CSV 安全、页面验收和隔离库集成测试。
13. 运行全量测试，并在服务停止条件下复核正式库指纹与业务计数。

主要参考：最新 stash `df08119e...` 用于恢复完整需求意图，但不得整体应用。repository 优先参考最早 stash；API/service/测试参考最新 stash 的局部实现；所有公共前端文件按当前主线重写。

数据库结构调整：不需要。G1B 可在不创建迁移的情况下完成。

## 12. 最终验证清单

- [x] 三个原 stash 对象仍存在且可读。
- [x] 三个保护引用存在且解析到指定对象。
- [x] 未应用、弹出、删除或整体 checkout 任一 stash。
- [x] 当前业务代码相对审计前 HEAD 未变化。
- [x] migrations 最高仍为 014；不存在 015/016。
- [x] 隔离开发库未新增业务数据。
- [x] 正式库主文件与 WAL 在静止窗口内未变化；业务计数未变化。
- [x] 正式库 SHM 大小不变，但只读检查后修改时间变化，已记录。
- [x] 3193 保持停止；3101、4173 也已停止。
- [x] 本节点只新增本审计文档，不恢复业务代码。

进入 G1B 正式开发结论：**暂不允许**。先完成 A2 路径 fail-closed 门禁并确认启动时解析到 `storage/development/growth-radar-g1b.sqlite`，再按照本文的局部移植方案开始开发。
