# COM-GROWTH-RADAR-V2.2-INT-1-A 数据库迁移隔离演练报告

> 日期：`2026-07-27`
> 分支：`master`
> HEAD：`a8327c524764f89eda8127e32b4aa48e38c3fac6`
> 演练范围：`019/020/021`
> 正式库基线：`018_mabang_image_collection_performance.sql`

## 1. 结论

```text
技术隔离演练：PASS
正式合同门禁：FAIL
正式数据库迁移：未批准、未执行
```

019/020/021 可以在正式库复制件和全新隔离库中按顺序执行，结构、索引、外键、事务和幂等检查均通过；所有既有业务表数据保持不变。

但是，这组三个候选 migration 尚不符合正式合同 `GRV2-METRICS-1.2.0`，当前不得应用正式数据库。

## 2. 候选 migration 审计

### 2.1 019：Growth Radar V2 分析层

文件：

```text
migrations/019_growth_radar_v2_analysis.sql
```

用途：

- 建立仓库国家映射配置；
- 建立规则配置与分析运行记录；
- 建立国家/SKU、店铺和店铺/SKU 指标；
- 建立信号表；
- 建立最新成功发布结果视图；
- 写入空国家映射基线和 `GRV2-METRICS-1.0.1` 初始规则。

新增：

- 8 张表；
- 15 个显式索引；
- 5 个视图。

对既有结构的影响：

- 不 `ALTER`、`DROP` 或重建 A2、产品、Listing、COM-015 表；
- 只通过外键引用 `growth_source_batches`、`growth_shops` 和 `product_skus`；
- 不写入上述既有表。

合同偏差：

1. 初始规则仍为 `GRV2-METRICS-1.0.1`。
2. 有效订单只有 `已发货`。
3. 低承接候选值为 `0.20`，正式合同要求 `capture.low_ratio=0.10`。
4. 未保存 `GRV2-METRICS-1.2.0` 的完整 32 项阈值配置。
5. `growth_sku_daily_metrics` 只有 `global/country` 粒度，却保存 `computed_days_of_supply`。
6. 没有仓库级可售天数风险指标表或仓库维度。
7. 使用 `source_visible_sales_*`、`demand_percentile_28d` 和 `is_source_high_performance`，未落实正式 `ASSORTMENT_*` 证据合同。

### 2.2 020：方向与指标合同

文件：

```text
migrations/020_growth_radar_direction_contract.sql
```

用途：

- 退役 019 写入的活动规则；
- 激活 `GRV2-METRICS-1.1.0`。

结构影响：

- 不新增或修改既有核心表结构；
- 只更新 019 新建的 `growth_rule_sets`。

合同偏差：

1. 激活版本是 `GRV2-METRICS-1.1.0`，不是正式后继合同 `1.2.0`。
2. 有效订单仍只有 `已发货`，缺少 `待处理/配货中/已完成`。
3. 阈值仍使用旧 JSON，未覆盖 1.2.0 的版本化配置键。
4. 低承接口径仍是 `0.20`。

### 2.3 021：运营任务生命周期

文件：

```text
migrations/021_growth_radar_task_lifecycle.sql
```

用途：

- 建立 `growth_focus_items`；
- 建立 `growth_focus_item_events`；
- 建立开放任务视图；
- 支持 P0-P3、确认、处理中、观察、阻塞、解决、忽略和重开等生命周期。

新增：

- 2 张表；
- 6 个显式索引；
- 1 个视图。

符合项：

- 复用 `growth_focus_items/events`，符合 V2.2 已确认方向；
- 包含蓝海、跨国候选、店铺缺口、增长和下降任务；
- 任务事件有 revision 与 idempotency key；
- 不修改 A2 或 COM-015。

合同缺口：

- 任务和信号没有显式 `warehouse` 维度；
- 仓库风险只能依赖 JSON 证据，不能稳定索引、去重或下钻到具体仓库；
- 在 1.2.0 仓库级库存风险落地前，`INVENTORY_RISK` 不具备正式发布条件。

## 3. 正式库复制件演练

演练方法：

1. 只读打开正式 SQLite；
2. 使用 SQLite Online Backup 创建临时一致性快照；
3. 复制快照为临时演练库；
4. 只向临时演练库应用 019/020/021；
5. 比较正式库前后文件证据；
6. 比较所有既有表的行数与内容哈希；
7. 删除临时目录。

结果：

| 检查 | 结果 |
|---|---|
| 正式库演练前最高 migration | `018` |
| 临时库新增 migration | `019 -> 020 -> 021` |
| 临时库最高 migration | `021` |
| 正式 SQLite 主文件内容 | 未变化 |
| 正式 WAL 内容 | 未变化 |
| 正式 SHM 内容 | 未变化 |
| 既有业务表检查数量 | `60` |
| 既有表行数/内容哈希变化 | `0` |
| 临时库 `integrity_check` | `ok` |
| 临时库外键异常 | `0` |
| 临时目录 | 已清理 |

文件指纹：

| 文件 | SHA-256 |
|---|---|
| 正式 SQLite | `5aa3ad56465f2602f899e3bb7c20e59dd327a3a13824811de48d464c47acec84` |
| 正式 WAL | `3c4cec0291896401e104a9026ea58d8b82844a3e15e4d7deddafe7e3cb0b694a` |
| 正式 SHM | `205f3438f59b36d21a18c58ecd4d16def4aa6c9e63d8831dd9af354455befea6` |

说明：只读连接期间 SHM 的文件修改时间发生变化，但字节数和内容哈希没有变化；SQLite 主文件与 WAL 的内容和修改时间均未变化。

## 4. 隔离空库结构与幂等演练

全新临时库执行结果：

| 检查 | 结果 |
|---|---|
| migration 文件数 | `20` |
| 019/020/021 顺序 | 正确 |
| 第二次执行新增 migration | `0` |
| `schema_migrations` 前后变化 | 无 |
| 幂等 | PASS |
| 新增候选表 | `10` |
| 新增候选显式索引 | `21` |
| 新增候选外键 | `21` |
| Growth Radar 视图总数 | `6` |
| `integrity_check` | `ok` |
| 外键异常 | `0` |

候选新增表：

```text
growth_country_mapping_sets
growth_warehouse_country_mappings
growth_rule_sets
growth_analysis_runs
growth_sku_daily_metrics
growth_shop_daily_metrics
growth_shop_sku_daily_metrics
growth_signals
growth_focus_items
growth_focus_item_events
```

编号审计：

- migration 目录没有 `016`；
- 当前迁移器按文件名排序，技术上可以从 `015` 直接执行 `017`；
- 正式复制件已经记录到 `018`，因此本次只新增 019/020/021；
- 缺失 016 不阻断本次技术演练，但需要项目登记说明其保留、撤销或跳号原因。

## 5. 数据安全

019/020/021 没有修改既有核心表结构。

正式库复制件对全部 60 张既有业务表执行了行数与内容哈希比较，变化为 0，其中覆盖：

- 产品与 SKU；
- 产品包数据；
- Listing 草稿、发布与素材数据；
- A2 Growth Radar 事实层；
- COM-015 图片批次、发现、资产、关联与全量同步数据；
- 调度、审计和文件生命周期数据。

本次未执行：

- 正式 migration；
- 正式分析；
- 运营任务写入；
- 前端合并；
- A2 或 COM-015 修改。

## 6. 测试

```text
Growth Radar V2 专项：11/11 PASS
正式复制件隔离演练：PASS
全新空库结构演练：PASS
幂等：PASS
SQLite 完整性：ok
外键异常：0
```

现有专项测试验证的是当前候选实现，不能替代 `GRV2-METRICS-1.2.0` 合同审查。

## 7. 风险

### P0：正式规则版本错误

临时演练完成后活动规则为 `GRV2-METRICS-1.1.0`，不是已批准的 `1.2.0`。

### P0：有效订单口径错误

候选规则只统计 `已发货`，与正式合同的四种有效状态不一致。

### P0：库存风险粒度错误

候选结构把可售天数放在国家/全局 SKU 指标中；正式合同要求按仓库计算、国家只聚合展示。

### P1：阈值配置不完整

候选 JSON 未覆盖正式合同 32 项配置，且低承接默认值错误。

### P1：证据与命名未完成升级

数据库未显式提供 `assortment_status`、`assortment_percentile` 和仓库级库存证据字段。

### P1：库存任务缺少仓库身份

信号和任务缺少稳定的仓库维度，无法可靠去重和下钻。

### P2：migration 016 缺失

技术上不阻断，但需要治理记录，避免后续把跳号误判为文件丢失。

## 8. 下一步建议

当前不要应用正式数据库。

建议进入候选 migration 修订节点：

1. 在尚未正式应用前修订 019/020/021，不创建补丁式 022。
2. 020 激活 `GRV2-METRICS-1.2.0`，写入四种有效订单状态和完整阈值配置。
3. 019 增加仓库级 SKU 库存指标，移除国家级可售天数语义。
4. 统一 `ASSORTMENT_*` 状态、证据字段和页面契约。
5. 为库存信号和任务增加稳定仓库身份。
6. 为 migration 016 补充项目治理说明，不擅自创建 016。
7. 修订后重新执行本报告全部隔离门禁。

