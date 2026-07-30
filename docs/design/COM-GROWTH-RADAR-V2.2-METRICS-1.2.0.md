# COM-GROWTH-RADAR-V2.2-METRICS-1.2.0 正式合同

> 合同版本：`GRV2-METRICS-1.2.0`
> 状态：`FINAL`
> 生效日期：`2026-07-27`
> 前序版本：`GRV2-METRICS-1.1.0`
> 来源合同：`GRV2-MABANG-SOURCE-1.0.0`
> 候选文档：`COM-GROWTH-RADAR-V2.2-METRICS-1.2.0-CANDIDATE.md`
> 本合同只冻结设计口径，不代表代码、migration、正式数据库或任务写入获批。

## 1. 目标与适用范围

Growth Radar V2.2 将货盘来源事实、我方订单表现和库存约束转换为可计算、可解释、可追溯的运营信号。

```text
货盘来源表现
+ 我方订单表现
+ 仓库级库存约束
-> 确定性机会与风险
-> 店长可执行的运营任务
```

每个正式结果必须回答：

1. 发现了什么；
2. 使用了哪些输入；
3. 计算公式是什么；
4. 使用了哪一版阈值配置；
5. 数据是否完整；
6. 为什么建议该动作。

禁止 AI 评分、黑盒综合分、无证据推荐和自动经营动作。

## 2. 公共计算边界

### 2.1 时间与日期

- 业务时区：`Asia/Shanghai`。
- 订单日期字段：来源 `付款时间`。
- `as_of_date`：最新完整成功数据所覆盖的业务日期。
- 页面必须显示真实 `as_of_date`，不得用系统当前日期替代。

### 2.2 有效订单

我方销量只统计以下订单状态：

```text
已发货
待处理
配货中
已完成
```

计算粒度：

```text
订单商品明细
+ normalized_sku
+ confirmed_shop
+ confirmed_country
+ platform
+ effective_manager
```

商品数量使用订单明细数量。订单头汇总数量只用于质量核对。

`effective_manager` 优先使用人工确认负责人；没有人工覆盖时使用来源 `店长`。

### 2.3 货盘与库存

- 库存来源粒度：`normalized_sku + warehouse`。
- `预测日销量(个)` 是该 SKU 在该仓库对应国家下的来源预测销量。
- `当前可售天数` 直接使用马帮仓库级结果，不在 Growth Radar 中重算。
- `爆款/旺款/平款/滞销款` 使用马帮来源分类，作为独立证据。
- `是否新款=是` 可直接作为来源新品依据。

### 2.4 空值与零值

- `NULL` 表示未知、缺失或不可计算，不等于 0。
- 0 只表示来源范围完整且明确没有数量。
- 必要输入为 `NULL` 时，派生指标必须为 `NULL`。
- 页面不得把 `NULL` 展示为 `0`、`0%`、无库存或无销量。
- 缺失日期不得补零或插值。

### 2.5 公共维度

货盘指标：

```text
confirmed_country
+ category_level_1
+ category_level_2
+ normalized_sku
```

店铺指标：

```text
confirmed_shop
+ confirmed_country
+ platform
+ effective_manager
+ normalized_sku
```

库存风险：

```text
confirmed_country
+ warehouse
+ normalized_sku
```

## 3. 阈值配置合同

### 3.1 配置原则

所有数值阈值必须来自版本化指标配置，不得写死在 SQL、后端、前端或测试断言中。

每次分析运行必须保存：

- `rule_version`；
- `threshold_profile_version`；
- 完整阈值快照；
- 阈值快照哈希；
- 生效时间；
- 创建人和确认人。

修改任何默认值必须创建新配置版本。历史分析继续引用原阈值快照，不得被新配置追溯改写。

### 3.2 正式默认配置

| 配置键 | 正式默认值 | 用途 |
|---|---:|---|
| `window.trend_days` | `7` | 当前趋势窗口天数 |
| `window.capture_days` | `28` | 承接比和覆盖率窗口天数 |
| `window.source_evidence_days` | `[7,28,42]` | 来源货盘销量证据窗口 |
| `data.minimum_trend_source_days` | `14` | 趋势任务最小连续来源天数 |
| `data.minimum_capture_source_days` | `28` | 承接与缺口任务最小连续来源天数 |
| `data.minimum_extended_source_days` | `42` | 我方扩展趋势最小连续来源天数 |
| `trend.change_rate` | `0.10` | 增长或下降变化率阈值 |
| `trend.min_previous_quantity` | `5` | 趋势判断最小前期销量 |
| `trend.min_absolute_change` | `3` | 趋势判断最小绝对变化 |
| `trend.new_sales_min_quantity` | `5` | 新增销售最小销量 |
| `assortment.high_percentile` | `0.80` | 高表现货盘分位 |
| `assortment.mid_percentile` | `0.50` | 中等表现货盘分位 |
| `assortment.minimum_sample_size` | `30` | 类目分位最小样本数 |
| `capture.low_ratio` | `0.10` | 低承接比阈值 |
| `store_gap.minimum_eligible_high_skus` | `10` | 类目缺口最小高表现 SKU 数 |
| `store_gap.coverage_ratio` | `0.50` | 普通类目缺口覆盖率阈值 |
| `store_gap.severe_coverage_ratio` | `0.25` | 严重类目缺口覆盖率阈值 |
| `store_gap.severe_missing_skus` | `10` | 严重类目缺口最小缺失 SKU 数 |
| `supply.out_of_stock_days` | `0` | 断货可售天数边界 |
| `supply.critical_days` | `7` | 严重库存风险上界 |
| `supply.warning_days` | `14` | 库存预警上界 |
| `slow_moving.watch_days` | `60` | 滞销观察阈值 |
| `slow_moving.risk_days` | `90` | 滞销风险阈值 |
| `slow_moving.severe_days` | `180` | 严重滞销阈值 |
| `new_product.observation_days` | `90` | 有可信首次出现时间时的新品观察期 |
| `priority.p0.sales_stopped_min_previous_7d` | `20` | P0 停销最小前期销量 |
| `priority.p0.decline_rate` | `0.50` | P0 严重下降幅度 |
| `priority.p0.decline_min_absolute` | `20` | P0 严重下降最小绝对减少 |
| `priority.p1.decline_rate` | `0.20` | P1 下降幅度 |
| `priority.p1.decline_min_absolute` | `5` | P1 下降最小绝对减少 |
| `priority.p1.decline_min_previous_7d` | `10` | P1 下降最小前期销量 |
| `task.manager_home_limit` | `10` | 每位店长首页任务上限 |

百分比配置统一保存为 `[0,1]` 小数。公式中的下降条件使用负方向，例如：

```text
sales_change_rate_7d <= -priority.p0.decline_rate
```

## 4. 质量状态

每个指标必须有质量状态：

| 状态 | 含义 |
|---|---|
| `READY` | 输入、配置和窗口完整，可生成正式信号 |
| `PARTIAL` | 可展示部分事实，但不得生成正式经营任务 |
| `INSUFFICIENT_WINDOW` | 时间窗口不足 |
| `INSUFFICIENT_SAMPLE` | 比较样本不足 |
| `BLOCKED_CONFIG` | 国家、店铺或负责人配置不足 |
| `BLOCKED_QUALITY` | 重复、未知状态或异常数量等质量问题 |
| `STALE` | 数据超过计划同步周期及宽限期 |

## 5. 趋势指标

### 5.1 时间窗口

以 `as_of_date` 为截止日：

```text
current_7d
= [as_of_date - (window.trend_days - 1), as_of_date]

previous_7d
= [as_of_date - (2 * window.trend_days - 1),
   as_of_date - window.trend_days]
```

### 5.2 完整性门禁

趋势为 `READY` 必须满足：

1. 两个连续 7 天窗口均有成功来源覆盖；
2. 两个窗口使用相同店铺和来源范围；
3. 每日导入状态明确；
4. 未导入日期不视为销量 0；
5. 店铺、国家和负责人配置可追溯。

范围在窗口内变化时标记 `PARTIAL`，不生成增长或下降任务。

### 5.3 公式

```text
current_sales_7d
= SUM(valid_order_line_quantity in current_7d)

previous_sales_7d
= SUM(valid_order_line_quantity in previous_7d)

sales_delta_7d
= current_sales_7d - previous_sales_7d

sales_change_rate_7d
= sales_delta_7d / previous_sales_7d
```

只有 `previous_sales_7d > 0` 时计算变化率。

### 5.4 趋势分类

| 状态 | 条件 |
|---|---|
| `GROWING` | 前期销量达到最小量，增幅和绝对增加均达到配置阈值 |
| `DECLINING` | 前期销量达到最小量，降幅和绝对减少均达到配置阈值 |
| `STABLE` | 前期销量达到最小量，但未达到增长或下降阈值 |
| `NEW_SALES` | 前期为 0，当前销量达到新增销售阈值 |
| `SALES_STOPPED` | 前期达到最小量，当前为 0 |
| `LOW_VOLUME_NOISE` | 有变化，但未达到最小数量门槛 |
| `NO_SALES` | 两个完整窗口均为 0 |
| `INSUFFICIENT_DATA` | 任一窗口不完整 |

`LOW_VOLUME_NOISE` 和 `NO_SALES` 不生成增长或下降经营任务。

## 6. 货盘验证指标

### 6.1 正式命名

本合同统一使用 `ASSORTMENT` 表达货盘来源表现。

| 状态码 | 页面文案 |
|---|---|
| `ASSORTMENT_VERIFIED_HIGH` | 高表现货盘 |
| `ASSORTMENT_VERIFIED_MID` | 中等表现货盘 |
| `ASSORTMENT_LOW` | 低表现货盘 |
| `ASSORTMENT_DATA_INSUFFICIENT` | 货盘排名数据不足 |

`MARKET_VERIFIED_*`、`MARKET_LOW` 和 `MARKET_DATA_INSUFFICIENT` 自本合同起废弃，不得写入新结果、证据字段、API 或页面文案。

马帮字段在产品中统一称为：

```text
货盘预测日销量
```

不得称为平台市场销量、市场份额、单店实际销量或我方实际销量。

### 6.2 国家 + SKU 货盘预测日销量

```text
source_predicted_daily_sales_country_sku
= SUM(source_predicted_daily_sales)
  over unique mapped warehouses
  within the same country and SKU
```

要求：

1. 先按 `normalized_sku + warehouse` 唯一键去重；
2. 只聚合已确认国家映射的仓库；
3. 不跨国家求和后用于国家排名；
4. 未映射仓库不进入正式结果；
5. 保留每个仓库原始值作为证据。

### 6.3 类目排名

比较组按以下顺序选择：

1. `国家 + 二级类目`，有效样本数达到 `assortment.minimum_sample_size`；
2. 否则回退到 `国家 + 一级类目`，有效样本数达到同一阈值；
3. 仍不足时返回 `ASSORTMENT_DATA_INSUFFICIENT`。

禁止回退到国家全部 SKU，避免不同货盘规模污染排名。

排序输入：

```text
source_predicted_daily_sales_country_sku DESC
```

分位使用确定性升序 `PERCENT_RANK`。相同预测日销量共享同一分位，SKU 只用于稳定结果顺序。

分类：

```text
ASSORTMENT_VERIFIED_HIGH
IF predicted_daily_sales > 0
AND assortment_percentile >= assortment.high_percentile

ASSORTMENT_VERIFIED_MID
IF assortment.mid_percentile <= assortment_percentile
AND assortment_percentile < assortment.high_percentile

ASSORTMENT_LOW
IF assortment_percentile < assortment.mid_percentile
```

马帮活跃度分类作为独立来源证据展示，不覆盖货盘分位结果，也不参与分位计算。

## 7. 我方表现指标

### 7.1 销量

至少保存：

```text
store_sales_quantity_7d
store_sales_quantity_previous_7d
store_sales_quantity_28d
manager_sales_quantity_7d
manager_sales_quantity_28d
country_own_sales_quantity_7d
country_own_sales_quantity_28d
```

所有销量可下钻到国家、平台、店铺、店长、类目和 SKU。

### 7.2 日均销量

只在窗口完整时计算：

```text
own_daily_sales_7d
= own_sales_quantity_7d / window.trend_days

own_daily_sales_28d
= own_sales_quantity_28d / window.capture_days
```

### 7.3 我方承接比

```text
country_capture_ratio_28d
= country_own_daily_sales_28d
  / source_predicted_daily_sales_country_sku

store_capture_ratio_28d
= store_own_daily_sales_28d
  / source_predicted_daily_sales_country_sku
```

规则：

1. 分母必须大于 0；
2. 28 天订单窗口必须完整；
3. 比值可以超过 100%，不得截断；
4. 超过 100% 时保留真实结果并显示口径提示；
5. 该比率不是市场份额。

低承接条件：

```text
capture_ratio_28d < capture.low_ratio
```

### 7.4 店铺销售承接覆盖率

```text
eligible_high_skus
= assortment_status = ASSORTMENT_VERIFIED_HIGH
AND country_available_quantity > 0
AND source_product_status != '停止销售'

covered_high_skus
= eligible_high_skus
AND store_sales_quantity_28d > 0

store_high_sku_coverage_ratio
= COUNT(covered_high_skus)
  / COUNT(eligible_high_skus)
```

只有 `COUNT(eligible_high_skus)` 达到 `store_gap.minimum_eligible_high_skus` 时生成正式缺口指标。

该指标只表示最近 28 天销售承接覆盖，不表示在线 Listing 覆盖。

## 8. 仓库级库存风险

### 8.1 计算粒度

库存风险必须按以下粒度计算：

```text
confirmed_country
+ warehouse
+ normalized_sku
```

每个仓库直接使用来源 `当前可售天数`。禁止跨仓库求和、平均、加权平均或以最小值替代国家可售天数。

### 8.2 仓库风险分类

必要输入：

- `warehouse_current_sellable_days`；
- `warehouse_available_quantity`；
- `warehouse_in_transit_quantity`；
- `warehouse_mapping_status`。

分类：

| 状态 | 条件 |
|---|---|
| `SUPPLY_DATA_INSUFFICIENT` | 可售天数为空或仓库国家未确认 |
| `SUPPLY_DATA_CONFLICT` | 可售天数与可用库存、在途量互相矛盾 |
| `OUT_OF_STOCK` | 可用库存和在途量均不大于 0，且来源可售天数不高于 `supply.out_of_stock_days` |
| `IN_TRANSIT_ONLY` | 可用库存不大于 0，但在途量大于 0 |
| `SUPPLY_CRITICAL` | 可用库存大于 0，可售天数大于断货边界且不高于 `supply.critical_days` |
| `SUPPLY_WARNING` | 可售天数高于严重边界且不高于 `supply.warning_days` |
| `SUPPLY_HEALTHY` | 可售天数高于 `supply.warning_days` |

`IN_TRANSIT_ONLY` 的统一动作是“到货后评估”，不得生成立即推广任务。

`SUPPLY_DATA_CONFLICT` 必须进入数据质量队列，不生成库存风险或推广任务。

### 8.3 国家层展示

国家层只聚合展示：

- 各仓库风险状态数量；
- 受影响 SKU 数；
- 受影响仓库数；
- 国家内最严重风险等级；
- 风险仓库清单；
- 国家可用库存总量；
- 国家在途量总量。

国家层不得生成单一“国家可售天数”，也不得展示跨仓平均、求和或最小可售天数。

任何库存风险任务必须引用具体 `warehouse`、来源可售天数和库存证据。

### 8.4 滞销库存分档

只有仓库可用库存大于 0 且来源可售天数有效时计算：

| 状态 | 条件 |
|---|---|
| `SLOW_MOVING_WATCH` | 可售天数高于 `slow_moving.watch_days` |
| `SLOW_MOVING_RISK` | 可售天数高于 `slow_moving.risk_days` |
| `SLOW_MOVING_SEVERE` | 可售天数高于 `slow_moving.severe_days` |

命中多个分档时取最严重状态。马帮活跃度继续作为并列来源证据，不被该分档覆盖。

### 8.5 新品机会

来源新品候选：

```text
source_is_new = true
AND source_product_status != '停止销售'
AND country_available_quantity > 0
AND country_mapping_status = confirmed
```

若存在可信的首次出现时间，可附加：

```text
days_since_first_seen <= new_product.observation_days
```

没有可信首次出现时间时，只能展示“来源标记新品”，不得伪造新品天数。新品候选默认进入 `P2`，并保留来源标记、库存和首次出现时间证据。

## 9. 机会与店铺缺口规则

### 9.1 国家级蓝海候选

规则码：

```text
COUNTRY_QUIET_ENTRY_CANDIDATE
```

```text
assortment_status = ASSORTMENT_VERIFIED_HIGH
AND country_own_sales_quantity_28d = 0
AND country_available_quantity > 0
AND source_product_status != '停止销售'
AND country_mapping_status = confirmed
AND own_28d_window_status = READY
```

- 默认优先级：`P2`；
- 统一动作：`核查在线状态后低风险测试`；
- 禁止文案：未上架、市场空白、保证增长。

### 9.2 低承接增长机会

规则码：

```text
COUNTRY_PRIORITY_GROWTH
```

```text
assortment_status = ASSORTMENT_VERIFIED_HIGH
AND country_own_sales_quantity_28d > 0
AND country_capture_ratio_28d < capture.low_ratio
AND country_available_quantity > 0
AND own_28d_window_status = READY
```

- 默认优先级：`P1`；
- 动作：核查当前经营状态，并安排重点测试或推广。

### 9.3 单 SKU 销售承接缺口

规则码：

```text
STORE_HIGH_SKU_SALES_GAP
```

```text
assortment_status = ASSORTMENT_VERIFIED_HIGH
AND store_sales_quantity_28d = 0
AND country_available_quantity > 0
AND store_country = inventory_country
AND store_identity_status = confirmed
AND own_28d_window_status = READY
```

正式名称：`高表现货盘销售承接缺口`。

统一动作：`核查在线状态与历史经营记录后决定是否测试`。

### 9.4 类目货盘缺口

规则码：

```text
STORE_CATEGORY_ASSORTMENT_GAP
```

普通缺口：

```text
eligible_high_sku_count >= store_gap.minimum_eligible_high_skus
AND store_high_sku_coverage_ratio < store_gap.coverage_ratio
```

严重缺口：

```text
eligible_high_sku_count >= store_gap.minimum_eligible_high_skus
AND store_high_sku_coverage_ratio < store_gap.severe_coverage_ratio
AND missing_high_sku_count >= store_gap.severe_missing_skus
```

同一店铺、国家和类目的缺口合并为一项任务，避免逐 SKU 轰炸店长。

### 9.5 跨国候选

同一 SKU 在国家 A 已有我方销售承接，在国家 B 属于高表现货盘、我方 28 天销量为 0，且目标国家库存可行动时，称为 `跨国候选`。

统一动作：

```text
核查目标国在线状态、合规和库存后低风险测试
```

不得称为跨国确定机会。

## 10. 运营任务优先级

优先级只允许 `P0/P1/P2/P3`，不计算黑盒综合分。

### 10.1 P0：必须立即处理

满足任一规则：

1. 高表现货盘、我方当前有销量，相关仓库全部断货且无在途；
2. 重点 SKU 销售停止，且：

```text
previous_sales_7d >= priority.p0.sales_stopped_min_previous_7d
```

3. 重点 SKU 严重下降，且：

```text
sales_change_rate_7d <= -priority.p0.decline_rate
AND ABS(sales_delta_7d) >= priority.p0.decline_min_absolute
```

重点 SKU 必须满足以下任一条件：

```text
assortment_status = ASSORTMENT_VERIFIED_HIGH
OR previous_store_category_percentile >= assortment.high_percentile
```

### 10.2 P1：本周优先发力

包括：

- `COUNTRY_PRIORITY_GROWTH`；
- 严重 `STORE_CATEGORY_ASSORTMENT_GAP`；
- 高表现货盘命中仓库级 `SUPPLY_CRITICAL`，且我方当前 7 天有销量；
- 重点 SKU 下降达到 P1 变化率、绝对减少和最小前期销量阈值；
- 高表现货盘的店铺承接比低于 `capture.low_ratio` 且有可用库存。

### 10.3 P2：计划测试或观察

包括：

- `COUNTRY_QUIET_ENTRY_CANDIDATE`；
- 跨国候选；
- 来源新品且有库存；
- 普通 `STORE_CATEGORY_ASSORTMENT_GAP`；
- 高表现货盘命中仓库级 `SUPPLY_WARNING`；
- 达到增长趋势，但尚未形成严重经营影响。

### 10.4 P3：低优先提醒

包括：

- 低销量噪声；
- 轻度异常；
- 数据即将过期；
- 店铺、负责人或国家配置提醒；
- 尚不满足正式经营任务门槛的观察信号。

数据或配置不足只能生成明确标注的 P3 数据治理任务，不得包装成经营机会。

### 10.5 首页上限与排序

每位店长首页最多展示：

```text
task.manager_home_limit
```

其余任务进入完整任务中心。

同优先级依次按以下可解释字段排序：

1. 影响店铺数或缺口 SKU 数；
2. 货盘验证分位；
3. 销量绝对损失或增长量；
4. 仓库级库存可行动性；
5. 连续命中天数；
6. 首次发现时间；
7. 稳定业务键。

所有排序输入必须进入证据快照。

## 11. 数据不足与失败降级

### 11.1 窗口不足

| 缺口 | 展示 | 信号与任务 |
|---|---|---|
| 少于 `data.minimum_trend_source_days` 个连续订单来源日 | 7 日趋势数据不足 | 不生成增长、下降或停销任务 |
| 少于 `data.minimum_capture_source_days` 个连续订单来源日 | 28 日我方表现数据不足 | 不生成蓝海、承接比或店铺缺口任务 |
| 少于 `data.minimum_extended_source_days` 个连续订单来源日 | 我方 42 日趋势不可用 | 不影响来源 42 日货盘证据 |

### 11.2 配置不足

- 仓库未映射国家：不进入国家、类目和 SKU 正式排名；
- 店铺身份未确认：不进入店铺横向比较；
- 负责人未确认：可展示店铺事实，但不分配到店长首页；
- 国家不一致：进入质量队列，不自动改写。

### 11.3 来源不足

- 预测日销量为空：不计算货盘分位；
- 类目样本不足且无合法回退组：返回 `ASSORTMENT_DATA_INSUFFICIENT`；
- 活跃度为空：显示未提供，不推断分类；
- 仓库可售天数为空：不生成该仓库可售天数风险；
- 订单 SKU 不在库存：保留我方销量，不生成货盘对比结论；
- 库存 SKU 不在订单：只有 28 天订单范围完整时，才可解释为我方销量 0。

### 11.4 失败降级

新分析失败时：

1. 不清空上一份成功发布结果；
2. 页面显示上一结果的数据日期、规则版本和阈值版本；
3. 显示本次失败原因；
4. 不基于失败运行生成或更新运营任务。

## 12. 证据合同

每条正式指标、信号或任务至少保存：

### 12.1 版本与来源

- `rule_code`
- `rule_version`
- `threshold_profile_version`
- `threshold_snapshot`
- `threshold_snapshot_hash`
- `source_contract_version`
- `as_of_date`
- 订单批次与库存批次
- 国家映射版本
- 店铺与负责人修订版本

### 12.2 业务维度

- 国家、仓库、一级类目、二级类目、SKU；
- 店铺、平台、店长；
- 当前 7 天、前 7 天、28 天窗口完整性；
- 有效订单状态集合。

### 12.3 货盘证据

- `assortment_status`
- `assortment_percentile`
- `assortment_comparison_scope`
- `assortment_sample_size`
- `source_predicted_daily_sales_country_sku`
- 每仓来源预测日销量
- 来源 7/28/42 天销量
- 马帮活跃度、新品标记和商品状态

### 12.4 我方与库存证据

- 我方销量、日均销量和承接比；
- 店铺销售承接覆盖率；
- 每仓可用库存、在途量和当前可售天数；
- 仓库级库存风险状态；
- 国家聚合风险计数；
- 命中公式、阈值和建议动作。

新结果不得使用 `market_status`、`market_percentile`、`market_share` 或 `MARKET_VERIFIED_*` 证据字段。

## 13. 页面文案合同

### 13.1 允许使用

- 货盘预测日销量
- 高表现货盘
- 中等表现货盘
- 低表现货盘
- 我方销量
- 我方承接比
- 销售承接覆盖率
- 蓝海候选
- 跨国候选
- 仓库可售天数风险
- 核查在线状态后低风险测试

### 13.2 禁止使用

- 市场真实销量
- 市场份额
- 未上架
- 保证增长
- 市场空白
- 国家可售天数
- 跨国确定机会

国家库存卡片只能展示库存总量、在途总量和仓库风险分布，不得伪造国家级可售天数。

## 14. 版本替代与实施边界

`GRV2-METRICS-1.2.0` 是 `GRV2-METRICS-1.1.0` 的正式后继合同。

相对前序版本，正式变化包括：

1. 有效订单扩展为已发货、待处理、配货中和已完成；
2. 订单日期明确使用付款时间；
3. 货盘验证改为国家类目内货盘预测日销量分位；
4. 所有阈值改为版本化配置；
5. 库存风险严格按仓库计算，国家只做聚合展示；
6. `MARKET_VERIFIED_*` 正式改名为 `ASSORTMENT_VERIFIED_*`；
7. 页面和证据字段同步采用货盘口径；
8. 失败运行继续保留上一成功发布结果。

本合同批准设计口径，不批准：

- 修改代码；
- 创建或应用 migration；
- 修改正式数据库；
- 写入正式运营任务；
- 修改 A2 或 COM-015；
- 启动 AI 评分或自动经营动作。
