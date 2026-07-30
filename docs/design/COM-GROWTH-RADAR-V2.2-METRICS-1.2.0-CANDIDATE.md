# COM-GROWTH-RADAR-V2.2-METRICS-1.2.0 候选合同

> 合同版本：`GRV2-METRICS-1.2.0-CANDIDATE`
> 日期：2026-07-27
> 状态：候选，等待人工确认
> 前序版本：`GRV2-METRICS-1.1.0`
> 来源合同：`GRV2-MABANG-SOURCE-1.0.0`
> 本合同不代表代码、migration、正式数据库或任务写入批准

## 1. 目标

本合同将 Growth Radar V2.2 的来源事实转换为可计算、可解释的运营指标：

```text
货盘来源表现
+ 我方订单表现
+ 当前库存约束
-> 确定性机会与风险
-> 可追溯运营任务候选
```

每个结果必须回答：

1. 发现了什么；
2. 使用了哪些输入；
3. 公式是什么；
4. 数据是否完整；
5. 为什么建议该动作。

禁止 AI 评分、黑盒综合分、自动经营动作和无证据推荐。

## 2. 公共计算边界

### 2.1 业务时区和分析日

- 业务时区：`Asia/Shanghai`
- `as_of_date`：最新完整成功数据所覆盖的业务日期
- 订单日期字段：`付款时间`
- 页面不得用系统当前日期替代 `as_of_date`
- 数据未覆盖当天时，显示实际数据日期

### 2.2 有效订单

我方销量只计算以下状态：

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
+ country
+ platform
+ manager
```

商品数量使用订单明细数量。订单头 `SKU总数量` 只用于质量核对。

### 2.3 空值和零值

- `NULL` 表示未知、缺失或不可计算，不等于 0。
- 0 只表示来源范围完整且明确没有数量。
- 必要输入为 `NULL` 时，指标结果为 `NULL`。
- 页面不得把 `NULL` 显示为 `0`、`0%`、无库存或无销量。
- 缺失日期不得补零或插值。

### 2.4 公共维度

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

`effective_manager` 优先使用人工确认负责人；没有人工覆盖时使用来源 `店长`。

### 2.5 质量状态

每个指标必须保存：

| 状态 | 含义 |
|---|---|
| `READY` | 输入、配置和窗口完整，可以生成正式信号 |
| `PARTIAL` | 可展示部分事实，但不得生成正式任务 |
| `INSUFFICIENT_WINDOW` | 时间窗口不足 |
| `BLOCKED_CONFIG` | 国家、店铺或负责人配置不足 |
| `BLOCKED_QUALITY` | 重复、未知状态、异常数量等质量问题 |
| `STALE` | 超过计划同步周期与宽限期 |

## 3. 趋势指标

### 3.1 时间窗口

以 `as_of_date` 为截止日：

```text
current_7d
= [as_of_date - 6 days, as_of_date]

previous_7d
= [as_of_date - 13 days, as_of_date - 7 days]
```

窗口按业务日闭区间计算。

### 3.2 完整性门禁

趋势为 `READY` 必须满足：

1. 14 个连续业务日均有成功来源覆盖证明；
2. 两个窗口使用相同店铺和来源范围；
3. 每日导入状态明确；
4. 没有导入的日期不能被视为销量 0；
5. 店铺身份、国家和负责人配置在两个窗口内可追溯。

如果店铺范围在窗口中发生变化：

- 保存范围版本；
- 结果标记 `PARTIAL`；
- 不生成增长或下滑任务。

### 3.3 公式

```text
current_sales_7d
= SUM(valid_order_line_quantity in current_7d)

previous_sales_7d
= SUM(valid_order_line_quantity in previous_7d)

sales_delta_7d
= current_sales_7d - previous_sales_7d
```

当 `previous_sales_7d > 0`：

```text
sales_change_rate_7d
= sales_delta_7d / previous_sales_7d
```

特殊情况：

| 前 7 天 | 当前 7 天 | 趋势结果 |
|---:|---:|---|
| 0 | 0 | `NO_SALES` |
| 0 | > 0 | `NEW_SALES` |
| > 0 | 0 | `SALES_STOPPED` |
| 数据不完整 | 任意 | `INSUFFICIENT_DATA` |

不产生无穷大百分比。

### 3.4 候选趋势阈值

候选默认配置：

```text
trend_change_rate = 10%
trend_min_previous_quantity = 5
trend_min_absolute_change = 3
new_sales_min_quantity = 5
```

分类：

| 状态 | 条件 |
|---|---|
| `GROWING` | 前 7 天至少 5 件、增幅至少 10%、绝对增加至少 3 件 |
| `DECLINING` | 前 7 天至少 5 件、降幅至少 10%、绝对减少至少 3 件 |
| `STABLE` | 前 7 天至少 5 件，且未达到增长或下降条件 |
| `NEW_SALES` | 前 7 天为 0，当前 7 天至少 5 件 |
| `SALES_STOPPED` | 前 7 天至少 5 件，当前 7 天为 0 |
| `LOW_VOLUME_NOISE` | 有变化，但未达到最小数量门槛 |
| `NO_SALES` | 两个完整窗口均为 0 |
| `INSUFFICIENT_DATA` | 任一窗口不完整 |

`LOW_VOLUME_NOISE` 和 `NO_SALES` 不生成增长或下滑经营任务。

## 4. 货盘市场验证指标

### 4.1 指标命名

马帮字段在产品中统一称为：

```text
货盘预测日销量
```

不得称为：

- 平台市场销量；
- 市场份额；
- 单店实际销量；
- 我方实际销量。

### 4.2 国家 + SKU 预测日销量

库存来源粒度为 `SKU + 仓库`。

```text
predicted_daily_sales_country_sku
= SUM(source_predicted_daily_sales)
  over unique mapped warehouses
  within the same country and SKU
```

要求：

1. 先按 `SKU + 仓库` 唯一键去重；
2. 只聚合到已确认国家；
3. 不跨国家求和后用于国家排名；
4. 未映射仓库不进入正式结果；
5. 保存每个仓库的原始值作为证据。

### 4.3 类目排名

比较组优先级：

1. 国家 + 二级类目，样本至少 30 个有效 SKU；
2. 国家 + 一级类目，样本至少 30 个有效 SKU；
3. 一级类目仍不足 30 时标记 `INSUFFICIENT_SAMPLE`，不生成市场验证信号。

禁止脱离类目退回到国家全部 SKU 比较，避免不同货盘之间的销量规模污染排名。

排序指标：

```text
predicted_daily_sales_country_sku DESC
```

分位使用确定性升序 `PERCENT_RANK`：

- 相同预测日销量共享同一分位；
- SKU 只用于结果稳定排序，不进入分位计算；
- 空值和质量阻断行不进入样本。

候选分类：

| 分类 | 条件 |
|---|---|
| `MARKET_VERIFIED_HIGH` | 预测日销量 > 0 且类目内分位 >= P80 |
| `MARKET_VERIFIED_MID` | 分位 >= P50 且 < P80 |
| `MARKET_LOW` | 分位 < P50 |
| `MARKET_DATA_INSUFFICIENT` | 国家、样本或预测值不足 |

马帮 `爆款/旺款/平款/滞销款` 作为独立来源标签展示，不覆盖上述排名结果，也不参与
分位计算。两者不一致时同时展示，不替用户隐藏差异。

### 4.4 辅助证据

每个市场验证结果同时保存：

- 来源 7/28/42 天销量；
- 马帮活跃度；
- 商品状态；
- 是否新款；
- 国家和仓库；
- 可用库存、在途量；
- 每仓当前可售天数；
- 比较组、样本数、分位和规则版本。

## 5. 我方表现指标

### 5.1 销量

必须分别保存：

```text
store_sales_quantity_7d
store_sales_quantity_previous_7d
store_sales_quantity_28d

manager_sales_quantity_7d
manager_sales_quantity_28d

country_own_sales_quantity_7d
country_own_sales_quantity_28d
```

所有销量可以继续下钻到平台、店铺、类目和 SKU。

为识别店铺既有重点款，分别在同一店铺、国家和类目内计算：

```text
store_category_sales_percentile_current_7d
store_category_sales_percentile_previous_7d
```

分位输入只使用窗口完整且销量大于 0 的 SKU，最小样本量仍为 30；样本不足时不得把
该 SKU 认定为店铺 Top 款。

### 5.2 日均销量

只有窗口完整时计算：

```text
own_daily_sales_7d
= own_sales_quantity_7d / 7

own_daily_sales_28d
= own_sales_quantity_28d / 28
```

### 5.3 我方承接比

用户界面中的“占比”正式命名为：

```text
我方承接比
```

国家层：

```text
country_capture_ratio_28d
= country_own_daily_sales_28d
  / predicted_daily_sales_country_sku
```

店铺层：

```text
store_capture_ratio_28d
= store_own_daily_sales_28d
  / predicted_daily_sales_country_sku
```

规则：

1. 分母必须大于 0；
2. 28 天订单窗口必须完整；
3. 比值可以超过 100%，不得强制截断；
4. 超过 100% 时保留结果并显示口径提示；
5. 该比率不是市场份额；
6. 7 天版本只能标记为“7 日承接参考”，不用于正式蓝海或店铺缺口任务。

候选低承接阈值：

```text
low_capture_ratio = 10%
```

### 5.4 店铺销售覆盖率

可售高表现货盘集合：

```text
eligible_high_skus
= MARKET_VERIFIED_HIGH
AND country_available_quantity > 0
AND source_product_status != '停止销售'
```

店铺已承接集合：

```text
covered_high_skus
= eligible_high_skus
AND store_sales_quantity_28d > 0
```

```text
store_high_sku_coverage_ratio
= COUNT(covered_high_skus)
  / COUNT(eligible_high_skus)
```

该指标只表示近 28 天销售承接覆盖，不表示在线 Listing 覆盖。

## 6. 蓝海机会规则

### 6.1 国家级蓝海候选

规则码：

```text
COUNTRY_QUIET_ENTRY_CANDIDATE
```

必要条件：

```text
market_status = MARKET_VERIFIED_HIGH
AND country_own_sales_quantity_28d = 0
AND country_available_quantity > 0
AND source_product_status != '停止销售'
AND country_mapping_status = confirmed
AND own_28d_window_status = READY
```

输出：

- 方向：蓝海候选；
- 统一动作：`核查在线状态后低风险测试`；
- 默认优先级：`P2`；
- 禁止文案：未上架、市场空白、保证增长。

### 6.2 低承接增长机会

规则码：

```text
COUNTRY_PRIORITY_GROWTH
```

必要条件：

```text
market_status = MARKET_VERIFIED_HIGH
AND country_own_sales_quantity_28d > 0
AND country_capture_ratio_28d < 10%
AND country_available_quantity > 0
AND own_28d_window_status = READY
```

输出：

- 方向：优先发力；
- 默认优先级：`P1`；
- 动作：核查当前经营状态并安排重点测试或推广；
- 证据：预测日销量、类目分位、我方 28 天销量、承接比、库存。

### 6.3 库存可行动性

国家库存：

```text
country_available_quantity
= SUM(available_quantity over unique country warehouses)

country_in_transit_quantity
= SUM(in_transit_quantity over unique country warehouses)
```

当前可售天数保留仓库粒度，不跨仓平均或求和。

- 有可用库存：可生成增长或蓝海任务。
- 只有在途、无可用库存：显示“到货后评估”，不生成立即推广任务。
- 可用和在途均为 0：生成供给约束，不生成蓝海任务。

## 7. 店铺缺口规则

### 7.1 单 SKU 销售承接缺口

规则码：

```text
STORE_HIGH_SKU_SALES_GAP
```

必要条件：

```text
market_status = MARKET_VERIFIED_HIGH
AND store_sales_quantity_28d = 0
AND country_available_quantity > 0
AND store_country = inventory_country
AND store_identity_status = confirmed
AND own_28d_window_status = READY
```

正式名称：

```text
高表现货盘销售承接缺口
```

不得称为“未上架”。建议动作为：

```text
核查在线状态与历史经营记录后决定是否测试
```

### 7.2 类目货盘缺口

规则码：

```text
STORE_CATEGORY_ASSORTMENT_GAP
```

候选默认门槛：

```text
eligible_high_sku_count >= 10
AND store_high_sku_coverage_ratio < 50%
```

严重缺口：

```text
eligible_high_sku_count >= 10
AND store_high_sku_coverage_ratio < 25%
AND missing_high_sku_count >= 10
```

输出：

- 国家、平台、店铺、店长、类目；
- 高表现 SKU 总数；
- 近 28 天已有销售 SKU 数；
- 缺口 SKU 数；
- 覆盖率；
- 按预测日销量排序的前 5 个缺口 SKU；
- 建议动作。

同一店铺、国家和类目的缺口合并为一个任务，避免为每个 SKU 生成一条任务。

### 7.3 跨国候选

同一 SKU 在国家 A 满足我方已承接，在国家 B 满足市场高表现且我方 28 天销量为 0 时，
称为：

```text
跨国候选
```

统一动作：

```text
核查目标国在线状态、合规和库存后低风险测试
```

不得称为跨国确定机会。

## 8. 运营任务优先级

### 8.1 原则

优先级只允许：

```text
P0
P1
P2
P3
```

不计算综合分。一个信号命中多项规则时取最高优先级，并保留全部命中证据。

### 8.2 P0：必须立即处理

满足任一条件：

1. **高需求且完全断货**

```text
market_status = MARKET_VERIFIED_HIGH
AND country_available_quantity = 0
AND country_in_transit_quantity = 0
AND country_own_sales_quantity_7d > 0
```

2. **重点 SKU 销售停止**

```text
trend_status = SALES_STOPPED
AND previous_sales_7d >= 20
AND (
  market_status = MARKET_VERIFIED_HIGH
  OR previous_store_category_percentile >= P80
)
```

3. **重点 SKU 严重下滑**

```text
trend_status = DECLINING
AND sales_change_rate_7d <= -50%
AND ABS(sales_delta_7d) >= 20
AND (
  market_status = MARKET_VERIFIED_HIGH
  OR previous_store_category_percentile >= P80
)
```

### 8.3 P1：本周优先发力

满足任一条件：

- `COUNTRY_PRIORITY_GROWTH`；
- 严重 `STORE_CATEGORY_ASSORTMENT_GAP`；
- 高表现 SKU 的仓库来源当前可售天数为 1 至 7 天，且我方当前 7 天有销量；
- 重点 SKU 下降至少 20%、绝对减少至少 5 件、前 7 天至少 10 件；
- 高表现 SKU 的店铺承接比低于 10%，且当前有可用库存。

### 8.4 P2：计划测试或观察

满足任一条件：

- `COUNTRY_QUIET_ENTRY_CANDIDATE`；
- 跨国候选；
- 来源新品且有库存；
- 普通 `STORE_CATEGORY_ASSORTMENT_GAP`；
- 高表现 SKU 的仓库来源当前可售天数为 8 至 14 天；
- 符合增长趋势但尚未形成严重经营影响。

### 8.5 P3：低优先提醒

包括：

- 低销量噪声；
- 轻度异常；
- 数据即将过期；
- 店铺、负责人或国家配置提醒；
- 需要继续观察但不满足经营任务门槛的信号。

`INSUFFICIENT_WINDOW`、`BLOCKED_CONFIG` 和 `BLOCKED_QUALITY` 不得伪装成经营机会。
它们只能生成明确标注为“数据/配置任务”的 P3 提醒。

### 8.6 同优先级排序

同一优先级内按以下顺序：

1. 影响店铺数或缺口 SKU 数；
2. 市场验证分位；
3. 销量绝对损失或增长量；
4. 库存可行动性；
5. 连续命中天数；
6. 首次发现时间；
7. 稳定业务键。

所有排序输入必须保存在证据快照。每位店长首页最多展示 10 项，其余进入完整任务中心。

## 9. 数据不足规则

### 9.1 窗口不足

| 缺口 | 展示 | 信号与任务 |
|---|---|---|
| 少于 14 个连续订单来源日 | 显示“7 日趋势数据不足” | 不生成增长、下滑或停止销售任务 |
| 少于 28 个连续订单来源日 | 显示“28 日我方表现数据不足” | 不生成蓝海、承接比或店铺缺口任务 |
| 少于 42 个连续订单来源日 | 我方 42 日趋势不展示 | 不影响来源 42 日货盘证据 |

### 9.2 配置不足

- 仓库未映射国家：不进入国家、类目和 SKU 正式排名。
- 店铺身份未确认：不进入店铺横向比较。
- 负责人未确认：可以显示店铺事实，但不分配给店长首页。
- 国家不一致：进入质量队列，不自动改写。

### 9.3 来源不足

- 预测日销量为空：不计算市场分位。
- 类目样本不足且无合法回退组：显示样本不足。
- 活跃度为空：显示未提供，不推断分类。
- 当前可售天数为空：不生成可售天数风险。
- 订单 SKU 不在库存：保留我方销量，但不生成货盘对比结论。
- 库存 SKU 不在订单：只有完整 28 天订单范围时才能把我方销量解释为 0。

### 9.4 失败降级

新分析失败时：

1. 不清空上一份成功发布结果；
2. 页面显示上一结果的数据日期和规则版本；
3. 显示本次失败原因；
4. 不基于失败运行生成或更新经营任务。

## 10. 证据合同

每条正式信号至少保存：

- `rule_code`
- `rule_version`
- `source_contract_version`
- `as_of_date`
- 订单批次和库存批次
- 国家映射版本
- 店铺与负责人修订版本
- 国家、类目、SKU、店铺、平台和店长
- 当前 7 天、前 7 天和 28 天窗口完整性
- 有效订单状态集合
- 来源预测日销量及仓库明细
- 类目分位、比较组和样本数
- 我方销量、日均销量和承接比
- 可用库存、在途量和每仓当前可售天数
- 马帮活跃度、新品和商品状态
- 命中公式、阈值和建议动作

## 11. 相对 `GRV2-METRICS-1.1.0` 的变化

| 范围 | `1.1.0` | `1.2.0` 候选 |
|---|---|---|
| 有效订单 | 仅已发货 | 已发货、待处理、配货中、已完成 |
| 订单日期 | `paid_at` | 明确对应来源付款时间 |
| 市场验证核心 | 来源 28 天销量 P80 | 国家类目内预测日销量 P80 |
| 多仓预测值 | 不累加 | 国家内唯一仓库求和 |
| 可售天数 | 系统重算 | 直接使用马帮仓库结果 |
| 活跃度 | 自有规则为主 | 第一版保留马帮分类 |
| 新品 | 产品中心生命周期 | 来源 `是否新款=是` |
| 店长 | 全部待配置 | 来源店长默认，人工覆盖优先 |
| 蓝海动作 | 经营建议 | 核查在线状态后低风险测试 |
| 趋势 | 未完整冻结 | 当前 7 天 vs 前 7 天 |

## 12. 候选默认值确认清单

正式批准 `GRV2-METRICS-1.2.0` 前，需要人工确认以下候选默认值：

1. 趋势变化阈值：`10%`。
2. 趋势最小前期销量：`5` 件。
3. 趋势最小绝对变化：`3` 件。
4. 市场高表现阈值：国家类目内 `P80`。
5. 分位最小样本量：`30` 个 SKU。
6. 低承接阈值：`10%`。
7. 类目货盘缺口：覆盖率低于 `50%`。
8. 严重类目缺口：覆盖率低于 `25%` 且缺口至少 `10` 个 SKU。
9. P0 严重下滑：至少 `-50%` 且绝对减少至少 `20` 件。
10. 每位店长首页最多 `10` 项任务。

任一默认值调整都必须生成新的候选文档修订，不得在实现代码中静默改变。

## 13. 禁止事项

- 不使用 AI 评分或 AI 改写优先级。
- 不把我方承接比称为市场份额。
- 不把近 28 天无有效订单称为未上架。
- 不把货盘预测日销量称为平台市场真实销量。
- 不在窗口不足时补零。
- 不跨国家盲目累计。
- 不自动执行推广、上架、补货或删除动作。
- 不因本候选合同修改代码、数据库或 migration。
- 不修改 A2 或 COM-015。
