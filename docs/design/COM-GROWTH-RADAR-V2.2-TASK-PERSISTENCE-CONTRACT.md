# COM-GROWTH-RADAR-V2.2 任务持久化合同

> 合同版本：`GRV2-TASKS-2.2.0`
>
> 日期：2026-07-27
>
> 状态：候选实现与隔离演练已批准；正式数据库应用仍未批准

## 1. 目标

本合同将 V2.2 确定性信号转换为可由店长持续处理的运营任务，并复用：

- `growth_focus_items`
- `growth_focus_item_events`

不新增语义重复的 `operation_tasks` 表。

边界：

```text
growth_signals
= 每次分析可重算的事实

growth_focus_items
= 店长当前工作状态

growth_focus_item_events
= 不可变的任务操作历史
```

每日重算可以更新任务证据，但不得覆盖人工处理状态、备注、延后时间或解决结果。

## 2. 任务状态

允许状态：

- `NEW`
- `ACKNOWLEDGED`
- `IN_PROGRESS`
- `MONITORING`
- `RESOLVED`
- `BLOCKED`
- `DISMISSED`
- `REOPENED`

活动状态：

- `NEW`
- `ACKNOWLEDGED`
- `IN_PROGRESS`
- `MONITORING`
- `BLOCKED`
- `REOPENED`

终态：

- `RESOLVED`
- `DISMISSED`

## 3. 状态转换

允许的人工转换：

```text
NEW -> ACKNOWLEDGED
ACKNOWLEDGED -> IN_PROGRESS
IN_PROGRESS -> MONITORING
MONITORING -> RESOLVED

NEW -> BLOCKED
ACKNOWLEDGED -> BLOCKED
IN_PROGRESS -> BLOCKED
MONITORING -> BLOCKED

NEW -> DISMISSED
ACKNOWLEDGED -> DISMISSED

BLOCKED -> IN_PROGRESS
BLOCKED -> DISMISSED

RESOLVED -> REOPENED
DISMISSED -> REOPENED
REOPENED -> ACKNOWLEDGED
REOPENED -> IN_PROGRESS
```

自动分析只允许：

- 为新业务键创建 `NEW`；
- 更新活动任务的最新信号与证据；
- 对已结束但重新命中的任务创建 `REOPENED` 事件，并将状态改为 `REOPENED`；
- 标记本次是否继续命中。

自动分析不得：

- 把 `IN_PROGRESS` 重置为 `NEW`；
- 自动解决或忽略任务；
- 删除任务；
- 清空人工备注；
- 在证据不足时生成经营建议任务。

## 4. 优先级

允许值：

- `P0`
- `P1`
- `P2`
- `P3`

排序固定为：

1. 严重程度；
2. 影响范围；
3. 货盘需求分位或销量变化幅度；
4. 库存可行动性；
5. 连续命中天数；
6. 首次发现时间。

所有排序输入必须保存在 `evidence_snapshot_json`，禁止保存无法解释的综合 AI 分数。

## 5. `growth_focus_items`

建议字段：

| 字段 | 约束与用途 |
| --- | --- |
| `id` | UUID 主键 |
| `task_key` | 稳定业务键 |
| `task_type` | 受控任务类型 |
| `current_signal_id` | 当前确定性信号 |
| `first_analysis_run_id` | 首次命中运行 |
| `last_analysis_run_id` | 最近命中运行 |
| `owner_user_id` | 负责店长 |
| `internal_shop_id` | 店铺，可空 |
| `country_code` | 已确认国家，可空 |
| `platform` | 平台，可空 |
| `category_l1` | 一级类目，可空 |
| `category_l2` | 二级类目，可空 |
| `subject_type` | `shop`、`shop_category`、`shop_sku`、`country_category`、`sku`、`data_configuration` |
| `normalized_source_sku` | SKU 任务使用，可空 |
| `priority` | `P0` 至 `P3` |
| `status` | 本合同状态枚举 |
| `reason_code` | 确定性原因 |
| `recommended_action_code` | 受控动作 |
| `evidence_snapshot_json` | 生成任务时的证据快照 |
| `consecutive_hit_count` | 连续命中次数 |
| `is_hit_in_latest_run` | 最新运行是否继续命中 |
| `first_detected_at` | 首次命中 |
| `last_detected_at` | 最近命中 |
| `acknowledged_at` | 已查看时间 |
| `started_at` | 开始处理时间 |
| `due_at` | 到期时间 |
| `snoozed_until` | 观察或延后复核时间 |
| `blocked_reason_code` | 阻塞原因 |
| `resolution_code` | 解决或忽略原因 |
| `resolution_note` | 人工说明 |
| `resolved_at` | 结束时间 |
| `revision` | 乐观并发版本，初始为 1 |
| `created_at` | 创建时间 |
| `updated_at` | 更新时间 |

外键：

- `current_signal_id -> growth_signals.id`
- `first_analysis_run_id -> growth_analysis_runs.id`
- `last_analysis_run_id -> growth_analysis_runs.id`
- `internal_shop_id -> growth_shops.id`

所有外键使用 `ON DELETE RESTRICT`。

## 6. 任务唯一性

同一业务任务只能有一个活动实例。

建议稳定键：

```text
task_key =
task_type
+ owner_user_id
+ internal_shop_id
+ country_code
+ platform
+ category_l2
+ subject_type
+ normalized_source_sku
```

空值必须转换为固定占位符后计算，不能依赖数据库对 `NULL` 的唯一约束行为。

建议约束：

- `task_key` 非空；
- 活动状态下 `task_key` 唯一；
- `revision >= 1`；
- `consecutive_hit_count >= 1`；
- `DISMISSED` 必须有 `resolution_code`；
- `BLOCKED` 必须有 `blocked_reason_code`；
- `MONITORING` 必须有 `snoozed_until` 或 `due_at`；
- `RESOLVED` 必须有 `resolution_code` 与 `resolved_at`。

## 7. `growth_focus_item_events`

事件是追加写入、不可修改的业务历史。

建议字段：

| 字段 | 约束与用途 |
| --- | --- |
| `id` | UUID 主键 |
| `focus_item_id` | 任务 ID |
| `event_type` | 受控事件类型 |
| `task_revision` | 事件对应的任务修订号；同一任务内单调递增 |
| `from_status` | 原状态，可空 |
| `to_status` | 新状态 |
| `actor_user_id` | 操作人 |
| `actor_type` | `user` 或 `system` |
| `reason_code` | 操作原因 |
| `note` | 人工备注 |
| `signal_id` | 触发信号，可空 |
| `analysis_run_id` | 触发运行，可空 |
| `evidence_snapshot_json` | 事件发生时证据 |
| `idempotency_key` | 客户端或系统幂等键 |
| `occurred_at` | 事件时间 |
| `created_at` | 入库时间 |

事件类型：

- `CREATED`
- `ASSIGNED`
- `ACKNOWLEDGED`
- `STARTED`
- `MONITORING_STARTED`
- `BLOCKED`
- `RESOLVED`
- `DISMISSED`
- `REOPENED`
- `SIGNAL_REFRESHED`
- `NOT_HIT_IN_LATEST_RUN`
- `SCHEDULED`

约束：

- `focus_item_id + idempotency_key` 唯一；
- `focus_item_id + task_revision` 唯一；
- 事件不得物理删除；
- `from_status`、`to_status` 必须与状态机一致；
- 系统刷新证据时使用 `SIGNAL_REFRESHED`，不得冒充人工处理事件。

## 8. 并发与幂等

任务更新必须带：

```text
expected_revision
```

更新条件：

```text
WHERE id = ?
AND revision = expected_revision
```

成功时：

```text
revision = revision + 1
```

版本不匹配返回冲突，不静默覆盖另一位运营的处理结果。

同一 HTTP 重试必须复用 `idempotency_key`。任务状态更新与事件写入必须位于同一数据库事务。

## 9. 权限与审计

第一版建议权限：

- `growth_radar.task.view`
- `growth_radar.task.update_own`
- `growth_radar.task.assign`
- `growth_radar.task.resolve`
- `growth_radar.task.admin`

默认：

- 店长只能更新分配给自己的任务；
- 主管可以重新分配；
- `DISMISSED`、`RESOLVED`、`BLOCKED` 必须填写受控原因；
- HTTP 审计记录调用者与接口；
- `growth_focus_item_events` 记录业务状态为何改变。

## 10. API 合同

只读：

- `GET /api/growth-radar/v2/tasks`
- `GET /api/growth-radar/v2/tasks/:id`
- `GET /api/growth-radar/v2/tasks/:id/events`

写入：

- `PATCH /api/growth-radar/v2/tasks/:id/status`
- `PATCH /api/growth-radar/v2/tasks/:id/assignment`
- `PATCH /api/growth-radar/v2/tasks/:id/schedule`

写请求必须包含：

- `expectedRevision`
- `idempotencyKey`
- 目标状态或修改内容
- 受控原因
- 需要时的备注

正式数据库未批准前，所有写接口必须保持关闭。

## 11. 发布与失败边界

1. 只有最新已发布分析可以创建或刷新正式任务。
2. 新分析失败时，保留上一成功分析和现有任务状态。
3. 未确认国家、店铺或店长时，仅生成配置阻塞任务。
4. 预测日销量语义未确认时，不生成经营机会任务。
5. 历史不足 14 天时，不生成增长或下滑任务。
6. 每位店长今日作战台最多 10 项，完整任务中心保留其余任务。
7. 蓝海动作固定为“核查在线状态后低风险测试”。
8. 跨国家机会统一称为“跨国候选”。

## 12. migration 门禁

本合同不分配 migration 编号，也不创建 SQL 文件。

进入实现前必须单独批准：

1. 候选 migration 编号；
2. 在隔离库创建两张表；
3. 状态转换、唯一约束和并发测试；
4. 配置写入权限；
5. 正式数据库备份与应用。
