# COM-GROWTH-RADAR-V2.2 候选迁移静态审计

- 日期：2026-07-27
- 分支：`master`
- 基线 HEAD：`a8327c524764f89eda8127e32b4aa48e38c3fac6`
- 审计对象：`019_growth_radar_v2_analysis.sql`、`020_growth_radar_direction_contract.sql`
- 审计性质：只读静态审计
- 正式数据库：未修改，最高已应用迁移仍为 `018_mabang_image_collection_performance.sql`

## 1. 结论

候选迁移 `019/020` 的 SQL 结构、现有表依赖和事务执行方式具备进入隔离库演练的基础，但当前不能直接批准进入正式数据库。

阻断项有两个：

1. 指标合同版本存在待确认冲突。
2. V2.2 正式运营任务需要的 `growth_focus_items` / `growth_focus_item_events` 尚未落为物理表。

## 2. 迁移器兼容性

当前 SQLite 迁移器按文件名排序，并在单文件事务中执行：

```text
检查 schema_migrations
-> 执行完整 SQL 文件
-> 写入 schema_migrations
-> 成功提交 / 失败回滚
```

因此：

- `019` 失败时不会留下半套 V2 表。
- `020` 失败时不会留下规则集“已退休但新规则未插入”的中间状态。
- 两个文件可分别追踪，不需要修改历史迁移。

`019` 引用的以下父表均来自现有迁移：

- `growth_source_batches`
- `growth_shops`
- `product_skus`

## 3. 指标合同版本冲突

当前存在两条不同的版本事实：

### 已冻结基础合同

以下设计文档仍将 `GRV2-METRICS-1.0.1` 定义为已确认基线：

- `COM-GROWTH-RADAR-V2-METRICS.md`
- `COM-GROWTH-RADAR-V2-1-DATA-LAYER-DESIGN.md`
- `COM-GROWTH-RADAR-V2-IMPLEMENTATION-PLAN.md`
- `COM-GROWTH-RADAR-V2-BATTLE-DASHBOARD-WIREFRAME.md`

`019` 也会先插入并激活 `GRV2-METRICS-1.0.1`。

### 候选方向合同

以下实现已经使用 `GRV2-METRICS-1.1.0`：

- `020_growth_radar_direction_contract.sql`
- `growth-radar-v2-engine.mjs`
- `growth-radar-v2-service.mjs`
- Growth Radar V2 测试

`020` 会退休当时所有活动规则集，并激活 `GRV2-METRICS-1.1.0`。

`COM-GROWTH-RADAR-V2-DIRECTION-CONTRACT.md` 记录了 `1.1.0` 的国家 × 类目、预测销量排序和我方承接方向，但其状态仅证明“实现完成、尚未应用到正式数据库”。V2.2 设计同时明确规定：改变指标合同前必须人工确认。

### 审计判断

在人工明确选择前，不得：

- 把 `1.1.0` 宣称为正式已批准指标合同；
- 应用 `020`；
- 将前端固定显示为任一未确认版本。

需要人工确认：

```text
是否批准 GRV2-METRICS-1.1.0 作为 1.0.1 的正式后继合同？
```

## 4. 任务生命周期数据缺口

`019/020` 均未创建：

- `growth_focus_items`
- `growth_focus_item_events`

因此当前实现只能从 `growth_signals` 生成只读任务投影，不能可靠保存：

- 接收；
- 开始处理；
- 进入观察；
- 阻塞；
- 解决；
- 忽略；
- 重新打开；
- 处理原因和历史事件。

用户已经确认 `operation_tasks` 复用这两张表的语义，避免重复创建第三套任务表。但物理表、唯一约束、并发版本和事件审计仍需要新的候选 migration。

新迁移至少需要冻结：

### `growth_focus_items`

- 任务业务键与类型；
- 当前信号；
- 店长、店铺、国家、平台、类目和 SKU；
- `NEW`、`ACKNOWLEDGED`、`IN_PROGRESS`、`MONITORING`、`RESOLVED`、`BLOCKED`、`DISMISSED`、`REOPENED`；
- 优先级、推荐动作和证据快照；
- 首次/最近命中时间；
- 到期、延后、解决和更新时间；
- 并发修订号；
- 同一业务对象和任务类型仅一个活动任务的约束。

### `growth_focus_item_events`

- 任务 ID；
- 事件类型；
- 前后状态；
- 操作人；
- 原因与备注；
- 证据快照；
- 幂等键；
- 发生时间。

## 5. 配置写入边界

现有数据结构可以承载：

- `growth_shops`：内部店铺、国家和 `owner_user_id`；
- `growth_shop_source_mappings`：来源店铺到内部店铺的映射；
- `growth_warehouse_country_mappings`：`019` 新增的仓库国家映射。

因此无需再创建语义重复的店铺配置表。

当前缺少的是经过权限、确认和审计保护的 V2 配置写入 API。现有前端正确保持只读，`writeGate.enabled = false`。在正式 migration 和写入权限获批前，不得开放保存按钮。

## 6. 趋势数据

当前 7 天与前 7 天销量已经由候选引擎计算，并存入指标的 `evidence_json`。第一版不需要为了趋势额外新增列。

正式发布仍要求：

- 至少 14 个完整业务日；
- 继续只统计“已发货”订单；
- 历史不足返回 `INSUFFICIENT_HISTORY`；
- 不把缺失的前 7 天当作 0。

## 7. 进入隔离演练前的批准项

必须由用户明确批准：

1. `GRV2-METRICS-1.1.0` 是否成为正式后继合同。
2. 是否允许在正式库复制件/隔离库中应用 `019/020`。
3. 是否允许新增任务生命周期候选 migration。

未批准前继续保持：

- 正式数据库只读；
- 配置写入关闭；
- 正式任务发布关闭；
- 不启动正式 Growth Radar V2 分析运行。
