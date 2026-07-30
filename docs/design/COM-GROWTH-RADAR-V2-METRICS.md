# COM-GROWTH-RADAR-V2-0.1 指标口径冻结报告

> 指标版本：`GRV2-METRICS-1.0.1`  
> 状态：已由用户确认，可进入 V2-1 数据层设计  
> 日期：2026-07-25（Asia/Shanghai）  
> 确认日期：2026-07-25（Asia/Shanghai）  
> 审计分支：`master`  
> 审计 HEAD：`a8327c524764f89eda8127e32b4aa48e38c3fac6`  
> 依据：`docs/design/COM-GROWTH-RADAR-V2-DESIGN.md`、现有 Growth Radar 数据合同、正式 SQLite 只读值域检查  
> 本节点只更新设计文档，不修改代码、数据库、迁移、页面或正式数据。

## 1. 冻结结论

第一版指标统一遵守以下原则：

1. 自店实际销量只计算当前有效的“已发货”订单行。
2. “配货中、待处理、待审核”只作为待处理需求，不计入实际销量。
3. “已作废”和无法识别的订单状态不计入任何实际销量。
4. 马帮库存来源中的 `销量(7/28/42)` 定义为“来源可见销量”，不自动称为公司真实销量。
5. 来源可见销量按 `SKU + 唯一仓库` 聚合；同一 SKU 多仓的销量求和。
6. 可用库存和在途量分开保存、分开展示；在途量不计入当前可用库存。
7. 当前可售天数由“可用库存 / 来源可见 28 天日均销量”计算。
8. 新品只接受产品中心 `NEW` 生命周期或未来权威新品标记；“等待开发”不等于新品。
9. 滞销使用 60/90/180 天三级阈值。
10. 缺货使用 14/7/0 天三级阈值。
11. 当前只能计算“可售货盘销售覆盖率”和“高表现货盘销售覆盖率”，不能计算“在线 Listing 覆盖率”。
12. 所有机会和风险均由确定性规则生成，不使用 AI 评分。
13. 店铺销售覆盖率以同一确认国家、同一确认经营范围内的当前可售 SKU 为分母，以近 28 天有“已发货”销量的 SKU 为分子。
14. 爆款不使用跨类目固定件数阈值；第一版使用 28 天来源可见销量的类目内 P80 排名，7 天和 42 天仅作趋势证据。
15. 店铺重点 SKU 分为“本店亮点款”和“增长跟进款”，不得把两个相反含义混为一个指标。
16. 国家维度只接受版本化、人工确认的仓库与店铺国家映射，不允许运行时从仓库名或店名猜测。
17. 国家映射不完整时，公司全盘分析仍可展示；店铺货盘覆盖、国家机会和跨源对比必须标记为 `unavailable`。

## 2. 当前真实值域依据

正式 SQLite 只读检查结果：

- `integrity_check = ok`
- `foreign_key_check = 0`
- 订单头：
  - 已发货：1,293
  - 配货中：268
  - 待处理：192
  - 待审核：43
  - 已作废：247
- 当前订单行：
  - `valid`：1,747 行，商品数量 1,859
  - `pending`：660 行，商品数量 709
  - `invalid_cancelled`：319 行，商品数量 334
- 最新库存批次：
  - 20,022 个有效 SKU + 仓库快照
  - 10,327 个唯一 SKU
  - 27 个唯一仓库
  - 4,710 个多仓 SKU
- 多仓来源销量：
  - 1,080 个多仓 SKU 的 28 天销量值在各仓相同
  - 3,630 个多仓 SKU 的 28 天销量值在各仓不同
- 现有 `days_of_supply` 全部为空，不能直接读取为当前可售天数。
- 当前在线覆盖快照为 0，不能判断店铺是否已上架 SKU。
- 已确认产品身份映射为 0，不能把全部马帮 SKU 自动关联为产品中心国家 + SKU。

多仓销量大量不同，第一版冻结为“仓库级来源可见销量”。未来如果马帮正式说明部分仓库行复制的是 SKU 全局销量，需要发布新的指标版本，不修改 `1.0.0` 历史结果。

## 3. 公共计算边界

### 3.1 业务粒度

库存基础粒度：

```text
inventory_batch_id
+ normalized_source_sku
+ normalized_warehouse_name
```

公司货盘 SKU 汇总粒度：

```text
analysis_run_id
+ normalized_source_sku
```

店铺 SKU 指标粒度：

```text
analysis_run_id
+ internal_shop_id
+ normalized_source_sku
```

当前库存来源没有可信国家字段，因此公司货盘指标不能强制按“国家 + SKU”拆分。第一版粒度冻结为：

- 公司全盘指标：`analysis_run_id + normalized_source_sku`，允许在国家映射缺失时计算；
- 国家货盘指标：`analysis_run_id + confirmed_country_code + normalized_source_sku`，仅在仓库国家映射完成时计算；
- 店铺指标：`analysis_run_id + internal_shop_id + normalized_source_sku`；
- 店铺与货盘的覆盖、缺口和增长机会：必须同时具备店铺确认国家、仓库确认国家和一致的 SKU 口径。

`growth_shops.country_code = 'ZZ'`、空国家、推测国家或只从名称提取的国家都不属于确认国家。产品身份映射可以作为后续增强证据，但不能替代仓库和店铺的明确国家范围。

### 3.2 业务日和时间窗口

- 系统业务时区：`Asia/Shanghai`
- `as_of_time`：分析运行使用的订单截止时间
- 7 天窗口：`[as_of_date - 6天 00:00:00, as_of_date 23:59:59]`
- 28 天窗口：`[as_of_date - 27天 00:00:00, as_of_date 23:59:59]`
- 42 天窗口：来源库存字段已经给出，不从订单反推
- 边界时间统一转换后再比较，不依赖服务器本机时区

订单窗口使用 `paid_at`。没有有效 `paid_at` 的订单不进入时间窗口销量。

### 3.3 空值规则

- `NULL` 表示未知或不可用，不等于 0。
- 0 表示来源明确给出零值。
- 任一正式公式的必要输入为 `NULL` 时，该指标结果为 `NULL`。
- 页面不得把 `NULL` 格式化为 0、`0%`、无库存或无销量。
- 部分仓库字段缺失时可以展示“已知部分合计”，但不得用于正式风险信号。

### 3.4 数据质量状态

每个指标必须带：

- `confirmed`：输入完整、来源范围确认、状态可识别。
- `degraded`：可以展示，但存在代理口径、产品映射缺失等限制。
- `blocked`：不得生成业务信号。

## 4. 一、销量口径

### 4.1 自店实际销量 `own_sales`

数据来源：

- `growth_order_headers`
- `growth_order_lines`
- `growth_shops`
- `growth_shop_source_mappings`

计入条件必须全部满足：

```text
growth_order_headers.effective_status = 'valid'
AND growth_order_lines.effective_status = 'valid'
AND growth_order_lines.is_current = 1
AND growth_order_headers.order_status = '已发货'
AND growth_order_headers.paid_at IS NOT NULL
AND growth_order_lines.quantity > 0
AND growth_order_headers.internal_shop_id IS NOT NULL
AND 店铺状态为 active
AND 店铺身份范围已确认
```

自店 SKU 销量：

```text
own_sales_quantity_Nd =
  SUM(growth_order_lines.quantity)
```

去重：

- 订单头使用现有 `business_key_version + business_key`。
- 订单行使用现有 `source_line_key_version + source_line_key`。
- 只计算 `is_current = 1` 的当前订单行。
- 不按商品名称、平台 SKU 或 Excel 行号重复计算。

### 4.2 订单状态冻结

| 原始订单状态 | `effective_status` | 是否计入实际销量 | 处理 |
|---|---|---:|---|
| 已发货 | `valid` | 是 | 进入 7/28 天实际销量 |
| 配货中 | `pending` | 否 | 单独进入待处理需求 |
| 待处理 | `pending` | 否 | 单独进入待处理需求 |
| 待审核 | `pending` | 否 | 单独进入待处理需求 |
| 已作废 | `invalid_cancelled` | 否 | 完全排除 |
| 其他/未知 | `unconfirmed` | 否 | 产生质量问题，等待映射 |

待处理需求：

```text
pending_demand_quantity =
  SUM(quantity WHERE effective_status = 'pending' AND is_current = 1)
```

待处理需求不得与实际销量相加，不参与热销、滞销或缺货公式，只作为未来可能消耗库存的旁证。

### 4.3 退款、退货和净销量

第一版不计算：

- 退款订单数；
- 退款件数；
- 退款后净销量；
- 退款金额；
- 净 GMV。

原因：当前字段不足以稳定区分退款完成、仅申请、部分退款、补发和退货状态。

### 4.4 来源可见销量 `source_visible_sales`

来源：

`growth_inventory_snapshots.source_visible_sales_7d/28d/42d`

正式定义：

> 马帮库存来源在指定快照时间、指定 SKU + 仓库粒度下展示的历史销量窗口值。

它可以用于：

- 来源需求高低排序；
- 库存周转和可售天数；
- 滞销与缺货风险；
- 自店销售不足机会。

它不能直接用于：

- 宣称公司真实销量；
- 宣称公司 GMV；
- 计算退款后净销量；
- 计算未经确认的自店公司占比；
- 作为某个店铺的销量。

SKU 汇总：

```text
source_visible_sales_Nd =
  SUM(
    每个唯一 normalized_source_warehouse_name
    对应的 source_visible_sales_Nd
  )
```

完整性条件：

- 使用同一个最新已确认库存批次；
- 每个 `SKU + 仓库` 只有一条有效快照；
- 所有参与仓库的该窗口销量均非空；
- 来源值不是无效格式；
- 来源范围状态为 `confirmed`。

任一仓库值缺失时：

- 已知值可以展示为 `partial_source_visible_sales`；
- 正式 `source_visible_sales_Nd = NULL`；
- 不生成热销、滞销或缺货结论。

### 4.5 何时禁止称为公司真实销量

出现任一情况时，页面和导出只能使用“来源可见销量”：

- 来源账号不覆盖公司全部业务；
- 来源仓库范围不完整；
- 7/28/42 天字段算法未由马帮或公司中台确认；
- 来源包含预测、估算或延迟更新；
- 多仓粒度存在未处理冲突；
- 订单取消、退货和退款口径未知；
- 数据超过新鲜度上限；
- 来源范围状态不是 `confirmed`。

即使来源范围已确认，历史字段名仍保存为 `source_visible_sales`。只有独立的权威公司销量数据源接入后，才新增 `company_sales`，不重命名旧字段。

## 5. 二、库存口径

### 5.1 可用库存

基础字段：

`growth_inventory_snapshots.available_quantity`

SKU + 仓库可用库存：

```text
warehouse_available_quantity = available_quantity
```

SKU 总可用库存：

```text
sku_available_quantity =
  SUM(每个唯一仓库的 available_quantity)
```

完整性规则：

- 同一批次、同一 SKU、同一标准化仓库只保留一条快照。
- 重复行先由导入质量门拒绝，不能重复累计。
- 任一仓库可用库存为空时，总可用库存质量为 `blocked`。
- 负数库存保留原始事实，但产生 `negative_available_inventory` 问题并阻断风险公式。

不使用以下字段代替可用库存：

- 实际库存；
- 仓位库存；
- 在途量；
- 未发货量；
- 调拨未发货；
- 预测库存。

### 5.2 在途量

基础字段：

`growth_inventory_snapshots.in_transit_quantity`

SKU 总在途：

```text
sku_in_transit_quantity =
  SUM(每个唯一仓库的 in_transit_quantity)
```

使用规则：

- 在途量单独展示。
- 在途量不加入当前可用库存。
- 在途量不降低当前缺货风险等级。
- 在途量可产生提示：`in_transit_may_relieve_risk`。
- 没有预计到货时间时，不计算“到货后可售天数”。

### 5.3 当前可售天数

第一版不读取现有 `days_of_supply`，因为正式数据中该字段当前全部为空。

有效日均销量：

```text
effective_daily_sales_28d =
  source_visible_sales_28d / 28
```

系统当前可售天数：

```text
IF sku_available_quantity < 0:
  days_of_supply = NULL
  status = invalid_negative_inventory

ELSE IF source_visible_sales_28d IS NULL:
  days_of_supply = NULL
  status = sales_unavailable

ELSE IF source_visible_sales_28d = 0
     AND sku_available_quantity > 0:
  days_of_supply = NULL
  status = no_sales_in_28d

ELSE IF source_visible_sales_28d = 0
     AND sku_available_quantity = 0:
  days_of_supply = NULL
  status = no_stock_no_sales

ELSE:
  days_of_supply =
    sku_available_quantity / (source_visible_sales_28d / 28)
  status = calculated
```

展示规则：

- `calculated`：显示一位小数。
- `no_sales_in_28d`：显示“28天无销量”，不显示无限大数字。
- `sales_unavailable`：显示“销量不可用”。
- `no_stock_no_sales`：显示“无库存且无近期销量”。

`source_predicted_daily_sales` 只作为旁证，不替代 28 天实际来源可见销量，不参与第一版正式可售天数。

### 5.4 多仓聚合

| 指标 | 规则 |
|---|---|
| 可用库存 | 唯一仓库求和 |
| 实际库存 | 唯一仓库求和，仅作参考 |
| 在途量 | 唯一仓库求和 |
| 未发货量 | 唯一仓库求和，仅作参考 |
| 来源可见销量 | 唯一仓库求和 |
| 预测日销量 | 唯一仓库求和后仅作预测旁证 |
| 来源可售天数 | 不求和、不平均 |
| 系统可售天数 | 使用 SKU 总可用库存和 SKU 总来源销量重新计算 |

空仓库、重复仓库或无法标准化的仓库记录阻断 SKU 汇总。

## 6. 三、新品规则

### 6.1 新品定义

第一版新品必须满足以下任一权威条件：

1. 已映射产品中心 SKU，当前生命周期为 `NEW`；
2. 未来接入的权威来源字段明确标记为新品，并保存新品开始时间。

以下条件不能单独定义新品：

- 马帮商品状态“等待开发”；
- SKU 前缀或编号；
- 商品名称包含“新”；
- 第一次被 Growth Radar 导入；
- AI 判断；
- 有库存但没有销量。

### 6.2 新品开始时间

优先级：

1. 产品中心生命周期事件进入 `NEW` 的时间；
2. 权威新品来源的 `new_started_at`；
3. 都不可用时，新品状态为 `unknown`，不进入新品机会。

### 6.3 新品观察周期

第一版冻结为 90 个自然日：

| 阶段 | 天数 | 用途 |
|---|---:|---|
| 上新期 | 0-30 天 | 看是否形成初始销售 |
| 增长期 | 31-60 天 | 看需求和店铺扩散 |
| 验证期 | 61-90 天 | 判断继续推广或转普通商品 |
| 退出新品 | >90 天 | 不再进入新品机会规则 |

### 6.4 新品机会

基础规则：

```text
is_new = true
AND new_age_days BETWEEN 0 AND 90
AND sku_available_quantity > 0
AND source_visible_sales_7d > 0
AND quality_status != blocked
```

店铺新品机会：

```text
new_product_opportunity
AND shop_own_sales_28d = 0
AND shop_scope_confirmed = true
```

该结果表示“新品有来源需求，但该店近 28 天未观察到销售”，不表示该店没有上架。

## 7. 四、滞销规则

### 7.1 适用范围

来源商品状态标准化：

| 原始状态 | 标准状态 | 是否进入普通滞销规则 |
|---|---|---:|
| 正常销售 | `ACTIVE` | 是 |
| 商品清仓 | `CLEARANCE` | 是，风险上调一级 |
| 等待开发 | `DEVELOPMENT` | 否 |
| 停止销售 | `DISCONTINUED` | 不进入普通规则，单独检查停销库存 |
| 空值/乱码/未知 | `UNKNOWN` | 否，产生质量问题 |

当前存在少量乱码状态，必须归为 `UNKNOWN`，不能猜测修复。

### 7.2 类目库存分位

零销量 SKU 的库存严重程度需要类目相对值：

1. 二级目录有效 SKU 数不少于 30：使用二级目录 P75；
2. 否则一级目录有效 SKU 数不少于 30：使用一级目录 P75；
3. 否则使用全部有效 SKU 的 P75。

`P75` 基于最新确认批次的 `sku_available_quantity` 计算。

### 7.3 基础风险等级

前提：

- 可用库存完整且大于 0；
- 来源可见销量完整；
- 商品状态可识别；
- 数据未过期。

| 条件 | 风险等级 | 规则码 |
|---|---|---|
| `60 <= days_of_supply < 90` | 提醒 `warning` | `SLOW_DOS_60` |
| `90 <= days_of_supply < 180` | 高风险 `high` | `SLOW_DOS_90` |
| `days_of_supply >= 180` | 严重 `critical` | `SLOW_DOS_180` |
| 42 天来源可见销量为 0，库存 > 0 | 高风险 `high` | `SLOW_ZERO_SALES_42D` |
| 42 天销量为 0，库存 >= 类目 P75 | 严重 `critical` | `SLOW_ZERO_SALES_HIGH_STOCK` |

状态修正：

- `CLEARANCE`：基础风险上调一级，最高为 `critical`。
- `DISCONTINUED` 且库存 > 0：直接输出 `critical` 的 `DISCONTINUED_WITH_STOCK`。
- `DEVELOPMENT` 且库存 > 0：输出信息提示 `DEVELOPMENT_STOCK_REVIEW`，不称为滞销。

### 7.4 滞销输出

- SKU、商品名称、商品状态；
- 一级/二级目录；
- 仓库数；
- 可用库存、在途量；
- 来源可见销量 7/28/42 天；
- 当前可售天数及状态；
- 类目库存 P75；
- 风险等级和命中规则；
- 建议动作码；
- 来源批次和快照时间。

建议动作只允许：

- `review_clearance`
- `review_transfer`
- `review_purchase_pause`
- `monitor`

系统不得自动清仓、调拨或停止采购。

## 8. 五、缺货规则

### 8.1 适用前提

- 商品状态为 `ACTIVE` 或 `CLEARANCE`；
- 可用库存和来源可见销量完整；
- 近 7 天来源可见销量大于 0；
- 可售天数状态为 `calculated`；
- 数据质量不为 `blocked`。

### 8.2 风险等级

| 条件 | 风险等级 | 规则码 |
|---|---|---|
| 可用库存 = 0 且 7 天销量 > 0 | 严重 `critical` | `OUT_OF_STOCK_WITH_DEMAND` |
| `0 < days_of_supply <= 7` | 高风险 `high` | `LOW_STOCK_7D` |
| `7 < days_of_supply <= 14` | 提醒 `warning` | `LOW_STOCK_14D` |
| `days_of_supply > 14` | 无缺货风险 | - |
| 7 天销量 = 0 | 不生成缺货信号 | - |

在途量处理：

- 不降低风险等级；
- 显示在途数量；
- 若在途 > 0，附加 `IN_TRANSIT_PRESENT` 证据；
- 没有预计到货日时，不判断能否及时缓解。

### 8.3 缺货输出

- SKU、商品和分类；
- 可用库存、在途量；
- 来源可见销量 7/28 天；
- 有效日均销量；
- 可售天数；
- 风险等级；
- 在途提示；
- 建议动作码：
  - `review_replenishment`
  - `review_transfer`
  - `review_promotion_throttle`
  - `monitor_arrival`

## 9. 六、店铺分析规则

### 9.1 店铺有效范围

店铺自身销量、亮点款等只依赖订单事实的指标计算：

- `growth_shops.status = active`
- 店铺身份已确认；
- 来源店铺映射为 `matched` 或 `manually_confirmed`；
- 订单头已经关联 `internal_shop_id`；
- 平台范围已确认。

店铺与公司货盘的覆盖率、销售缺口和增长跟进款还必须满足：

- 店铺 `country_code` 为已确认的受控国家代码，不能是 `ZZ`；
- 库存仓库已经通过有效版本的映射关联到同一国家；
- 店铺主营类目范围已确认，或明确接受该国家全部可售货盘作为比较范围；
- 订单、库存和映射的时间水位均满足质量门。

缺少任一条件时，店铺自身销量仍可展示，但跨源货盘指标为 `unavailable`，不得静默回退为全公司货盘比较。

### 9.2 店铺 SKU 销售覆盖率

第一版冻结两个不同分母的销售覆盖率；二者都只表示“近 28 天观察到销售的 SKU 覆盖”，不表示当前在线 Listing 覆盖。

#### 9.2.1 当前可售货盘销售覆盖率

指标名称：

`shop_saleable_assortment_sales_coverage_rate_28d`

分母集合 `eligible_saleable_sku_set`：

- 使用最新已发布库存快照；
- 商品状态为 `ACTIVE` 或 `CLEARANCE`；
- `available_quantity > 0`；
- SKU、仓库和商品状态的数据质量不为 `blocked`；
- 仓库确认国家等于店铺确认国家；
- 落在店铺已确认主营类目范围内；主营类目未配置时，使用该国家全部当前可售 SKU；
- 按 `normalized_source_sku` 去重，多仓只贡献一个 SKU。

分子：

```text
eligible_saleable_sku_set 中，
该店近 28 天 own_sales_quantity_28d > 0 的唯一 SKU 数
```

分母：

```text
eligible_saleable_sku_set 的唯一 SKU 数
```

公式：

```text
shop_saleable_assortment_sales_coverage_rate_28d =
  sold_eligible_sku_count_28d
  / eligible_saleable_sku_count
```

#### 9.2.2 高表现货盘销售覆盖率

指标名称：

`shop_high_performance_sales_coverage_rate_28d`

分母是在 `eligible_saleable_sku_set` 中同时命中 R01 `SOURCE_HIGH_PERFORMANCE` 的唯一 SKU 数；分子是其中该店近 28 天 `own_sales_quantity_28d > 0` 的唯一 SKU 数。

```text
shop_high_performance_sales_coverage_rate_28d =
  sold_high_performance_sku_count_28d
  / eligible_high_performance_sku_count
```

公共聚合规则：

- 店铺层按 `internal_shop_id` 单独计算；
- 国家层分子是该国家至少一个确认店铺近 28 天售出的唯一 SKU 并集，分母是该国家符合条件的唯一 SKU 集合；
- 全部店铺层按各确认国家的 SKU 集合并集计算；
- 禁止对店铺百分比直接求平均；
- 分母为 0 或国家映射未确认时结果为 `NULL`，`availability_status = unavailable`，不显示 0%。

### 9.3 在线 Listing 覆盖率

目标指标：

`shop_listing_coverage_rate`

当前状态：

`unavailable`

原因：

`growth_shop_sku_coverage_snapshots` 当前没有权威在线数据。

未来公式：

```text
current_online_sku_count
/ eligible_candidate_sku_count
```

在权威在线快照接入前：

- 不显示在线覆盖率；
- 不把历史订单推导为在线；
- 不把近 28 天无销量推导为未上架。

### 9.4 来源高表现 SKU 但店铺缺失

第一版正式名称：

`来源高表现 SKU 销售缺口`

规则码：

`SOURCE_HIGH_SHOP_NO_SALE_28D`

公式：

```text
source_high_performance = true
AND shop_own_sales_quantity_28d = 0
AND shop_scope_confirmed = true
AND warehouse_country_mapping_confirmed = true
AND warehouse_country_code = shop_country_code
AND sku_available_quantity > 0
```

输出文案：

> 来源需求表现高，但该店近 28 天未观察到有效销售。

禁止文案：

- 该店未上架；
- 该店缺少该商品；
- 该店 Listing 缺失。

等在线 Listing 快照可用后，才增加：

```text
SOURCE_HIGH_SHOP_LISTING_MISSING =
  source_high_performance
  AND current_online_status = offline
```

### 9.5 店铺现有亮点款

规则码：

`STORE_KEY_PERFORMER`

类目比较组：

1. 店铺 + 二级目录，有效 SKU 不少于 10；
2. 否则店铺全部有效 SKU。

公式：

```text
shop_own_sales_28d > 0
AND shop_own_sales_7d > 0
AND shop_sales_percentile_28d >= P80
AND order_data_quality = confirmed
```

重点款不等于无风险。若同时命中缺货或滞销信号，重点款保留并附加风险标签。

### 9.6 店铺增长跟进款

规则码：

`STORE_GROWTH_FOCUS_SKU`

第一版把“公司表现好、当前店铺不足、有库存支持”翻译为可计算且不夸大数据语义的规则：

```text
source_high_performance = true
AND shop_scope_confirmed = true
AND warehouse_country_mapping_confirmed = true
AND warehouse_country_code = shop_country_code
AND sku_available_quantity > 0
AND (
  shop_own_sales_quantity_28d = 0
  OR shop_to_source_visible_ratio_percentile_28d <= P20
)
```

其中：

```text
shop_to_source_visible_ratio_28d =
  shop_own_sales_quantity_28d
  / source_visible_sales_28d
```

- 分母为 0 或 `NULL` 时比值为 `NULL`；
- 比值只命名为“自店/来源可见销量比”，不得命名为市场份额或公司销售占比；
- 低比值分位按“店铺 + 确认国家 + 二级目录”比较，有效样本少于 30 时退到一级目录，再不足 30 时只使用“近 28 天无销售”条件；
- 输出必须区分 `no_recent_sales` 和 `low_relative_sales` 两种原因；
- 建议动作仅为人工复核上架状态、价格、内容、广告和库存，不自动执行。

### 9.7 国家维度

第一版支持国家筛选和国家聚合，但只在显式映射完成后启用。

仓库国家来源：

```text
source_system = mabang_inventory
+ normalized_warehouse_name
+ mapping_version
-> confirmed_country_code
```

店铺国家来源：

```text
growth_shops.country_code
+ growth_shop_source_mappings.country_code
+ mapping_status in (matched, manually_confirmed)
```

冻结规则：

- 国家代码使用受控 ISO/业务国家代码；
- 仓库名称中的中文、英文或国家缩写只能生成待确认候选，不能在分析运行时直接转成国家；
- `ZZ`、空值、冲突映射和过期映射均视为未确认；
- 同一仓库在同一有效期只能映射到一个国家；
- 国家口径变更必须创建新映射版本，不覆盖历史分析证据；
- 公司全盘指标可以不按国家展示；
- 店铺覆盖率、店铺销售缺口、店铺增长跟进款和国家货盘指标必须按确认国家对齐；
- 当前正式数据中店铺国家均为 `ZZ`，且没有可用的仓库国家映射，因此本节点只冻结合同，国家级跨源指标当前状态为 `unavailable`。

## 10. 七、机会规则冻结

### 10.1 公共证据字段

每个规则结果必须保存：

- `analysis_run_id`
- `rule_code`
- `metrics_version = GRV2-METRICS-1.0.1`
- `inventory_batch_id`
- `order_watermark_at`
- `snapshot_at`
- `normalized_source_sku`
- `internal_shop_id`，如适用
- `source_scope_status`
- `quality_status`
- 输入字段原值
- 计算中间值
- 阈值
- 命中条件
- 未命中或阻断原因
- `calculated_at`

### 10.2 规则清单

#### R01 来源高表现 SKU

- 名称：来源高表现 SKU
- 规则码：`SOURCE_HIGH_PERFORMANCE`
- 输入：
  - `source_visible_sales_28d`
  - 一级/二级目录
  - 商品状态
- 计算：
  - 主窗口为 28 天；7 天只表示近期动量，42 天只表示稳定性证据；
  - 不使用跨类目固定件数阈值；
  - 国家映射可用时，先在“确认国家 + 二级目录”内比较；
  - 国家映射不可用时，只能在公司全盘同类目内比较，结果标记为 `degraded`；
  - 二级目录有效 SKU 不少于 30 时，按二级目录计算 28 天销量分位；
  - 否则按一级目录；
  - 一级目录仍不足 30 时按全部有效 SKU；
  - 使用确定性升序 `PERCENT_RANK`，同销量值共享同一分位；SKU 只用于结果展示的稳定排序，不进入分位函数；
  - `source_visible_sales_28d > 0 AND demand_percentile_28d >= P80`；
  - `source_visible_sales_28d` 为 `NULL`、来源范围未确认或比较组不足 30 且无可用回退组时不生成高表现信号。
- 输出：
  - 是否高表现；
  - 需求分位；
  - 比较组和样本数。
- 证据：
  - 来源销量、类目、分位阈值、样本数、库存批次。

#### R02 来源高表现、自店无近期销售

- 名称：来源高表现自店销售缺口
- 规则码：`SOURCE_HIGH_SHOP_NO_SALE_28D`
- 输入：
  - R01 结果；
  - `shop_own_sales_quantity_28d`
  - 店铺确认状态
  - 可用库存
  - 店铺和仓库确认国家
- 计算：

```text
R01 = true
AND shop_own_sales_quantity_28d = 0
AND shop_scope_confirmed = true
AND warehouse_country_mapping_confirmed = true
AND warehouse_country_code = shop_country_code
AND sku_available_quantity > 0
```

- 输出：
  - 店铺销售机会；
  - 建议动作 `review_store_promotion`。
- 证据：
  - 来源 28 天销量及分位；
  - 店铺 28 天销量；
  - 店铺、平台、负责人；
  - 当前库存；
  - 国家映射版本。

#### R03 新品机会

- 名称：新品动销机会
- 规则码：`NEW_PRODUCT_OPPORTUNITY`
- 输入：
  - 生命周期；
  - 新品开始时间；
  - 可用库存；
  - 来源 7 天销量；
  - 店铺 28 天销量。
- 计算：

```text
is_new = true
AND new_age_days <= 90
AND available_quantity > 0
AND source_visible_sales_7d > 0
```

店铺机会增加：

```text
shop_own_sales_quantity_28d = 0
```

- 输出：
  - 新品阶段；
  - 来源级或店铺级机会；
  - 建议动作 `review_new_product_promotion`。
- 证据：
  - 生命周期事件；
  - 新品年龄；
  - 库存；
  - 7 天来源销量；
  - 店铺 28 天销量。

#### R04 滞销风险

- 名称：库存滞销风险
- 规则码：
  - `SLOW_DOS_60`
  - `SLOW_DOS_90`
  - `SLOW_DOS_180`
  - `SLOW_ZERO_SALES_42D`
  - `SLOW_ZERO_SALES_HIGH_STOCK`
- 输入：
  - 可用库存；
  - 来源 28/42 天销量；
  - 可售天数；
  - 商品状态；
  - 类目库存 P75。
- 计算：使用第 7 节冻结阈值。
- 输出：
  - 风险等级；
  - 连续命中状态；
  - 建议动作。
- 证据：
  - 多仓库存明细；
  - 销量窗口；
  - 可售天数公式；
  - 类目分位；
  - 商品状态。

#### R05 缺货风险

- 名称：高需求缺货风险
- 规则码：
  - `LOW_STOCK_14D`
  - `LOW_STOCK_7D`
  - `OUT_OF_STOCK_WITH_DEMAND`
- 输入：
  - 可用库存；
  - 在途量；
  - 来源 7/28 天销量；
  - 可售天数。
- 计算：使用第 8 节冻结阈值。
- 输出：
  - 风险等级；
  - 在途旁证；
  - 建议动作。
- 证据：
  - 可用和在途；
  - 日均销量；
  - 可售天数；
  - 来源快照。

#### R06 店铺现有亮点款

- 名称：店铺现有亮点 SKU
- 规则码：`STORE_KEY_PERFORMER`
- 输入：
  - 店铺 7/28 天实际销量；
  - 店铺类目销售分位；
  - 店铺确认状态。
- 计算：

```text
shop_sales_28d > 0
AND shop_sales_7d > 0
AND shop_category_sales_percentile_28d >= P80
```

- 输出：
  - 店铺现有亮点 SKU；
  - 类目排名和风险标签。
- 证据：
  - 订单行数量；
  - 有效订单数；
  - 7/28 天窗口；
  - 比较组和分位。

#### R06B 店铺增长跟进款

- 名称：店铺增长跟进 SKU
- 规则码：`STORE_GROWTH_FOCUS_SKU`
- 输入：
  - R01 结果；
  - 店铺 28 天实际销量；
  - 自店/来源可见销量比及类目分位；
  - 店铺和仓库确认国家；
  - 可用库存；
  - 店铺确认状态。
- 计算：使用第 9.6 节冻结公式。
- 输出：
  - `no_recent_sales` 或 `low_relative_sales`；
  - 人工复核建议；
  - 不生成“未上架”结论。
- 证据：
  - 来源 28 天销量和高表现分位；
  - 店铺 28 天销量；
  - 自店/来源可见销量比及比较组；
  - 国家映射版本；
  - 当前可用库存；
  - 店铺、平台和负责人。

#### R07 停销有库存

- 名称：停销商品库存风险
- 规则码：`DISCONTINUED_WITH_STOCK`
- 输入：
  - 商品状态；
  - 可用库存；
  - 在途量。
- 计算：

```text
product_status = DISCONTINUED
AND available_quantity > 0
```

- 输出：
  - `critical`；
  - 建议动作 `review_discontinued_stock`。
- 证据：
  - 商品状态原值；
  - 多仓库存；
  - 在途量；
  - 快照时间。

#### R08 数据阻断

- 名称：指标数据不可用
- 规则码：`METRIC_DATA_BLOCKED`
- 输入：
  - 来源范围；
  - 新鲜度；
  - 空值；
  - 重复键；
  - 状态映射；
  - 店铺和 SKU 映射。
- 计算：
  - 任一规则必要输入不满足质量门。
- 输出：
  - 不生成业务机会/风险；
  - 返回阻断原因和修复动作。
- 证据：
  - 问题代码；
  - 来源批次；
  - 影响字段；
  - 安全脱敏样本。

## 11. 指标输出状态

每个结果必须包含：

| 字段 | 取值 |
|---|---|
| `availability_status` | `available/degraded/unavailable` |
| `quality_status` | `confirmed/degraded/blocked` |
| `semantic_type` | `own_sales/source_visible_sales/source_prediction/inventory` |
| `metrics_version` | `GRV2-METRICS-1.0.1` |
| `source_at` | 订单水位或库存快照时间 |
| `reason_code` | 可用、降级或阻断原因 |

页面不能只显示数字，不显示来源、时间和口径。

## 12. 规则变更管理

本文件冻结后：

- 修改阈值必须创建新规则版本。
- 修改销量状态映射必须创建新指标版本。
- 修改多仓来源销量聚合方式必须创建新指标版本。
- 旧分析运行继续引用旧版本，不重新解释。
- 不直接覆盖历史规则参数。
- 新版本必须使用固定 fixture 与真实脱敏样本复算对比。

## 13. 八、禁止事项

第一版明确禁止：

- 使用 AI 对 SKU 打分、分类或决定动作；
- 使用 AI 补齐缺失库存、销量、类目或状态；
- 把来源预测销量当作实际销量；
- 把来源可见销量写成公司真实销量；
- 把历史订单推导为当前在线；
- 把近 28 天无销售写成未上架；
- 把 `NULL` 当作 0；
- 将待处理订单计入已实现销量；
- 将在途量加入当前可用库存；
- 自动执行上架、补货、调拨、清仓、调价或广告操作；
- 为了得到完整百分比而忽略数据质量问题；
- 修改现有订单、库存和产品事实；
- 在本节点修改代码、数据库、迁移或页面。

## 14. 实施前确认清单

以下口径已由用户整体确认：

1. 接受“已发货”为第一版唯一实际销量状态。
2. 接受多仓来源销量按唯一仓库求和。
3. 接受来源可见销量不称为公司真实销量。
4. 接受系统可售天数使用 28 天来源可见日均销量。
5. 接受新品观察周期为 90 天。
6. 接受滞销阈值为 60/90/180 天。
7. 接受缺货阈值为 14/7/0 天。
8. 接受当前计算可售货盘和高表现货盘两类销售覆盖率，但不计算在线 Listing 覆盖率。
9. 接受“高表现 SKU 店铺缺失”第一版改称“销售缺口”。
10. 接受所有机会和风险均为建议，不自动执行经营动作。
11. 接受店铺可售货盘覆盖率和高表现货盘覆盖率使用不同分母，且禁止平均店铺百分比。
12. 接受爆款按 28 天类目内 P80 排名识别，不使用跨类目固定件数阈值。
13. 接受店铺重点 SKU 分为本店亮点款和增长跟进款。
14. 接受国家级跨源指标必须等待仓库和店铺国家映射确认；当前 `ZZ` 数据不参与国家对比。

确认结果：采用 `GRV2-METRICS-1.0.1` 作为 V2-1 数据层设计基线；国家映射采用配置表维护。V2-1 设计可以开始，但在设计评审完成前仍不创建迁移或实现。

## 15. V2-0.1 补充冻结摘要

本次只更新本指标合同，未修改生产代码、数据库、迁移或页面。

| 补充项 | 冻结结果 |
|---|---|
| 店铺销售覆盖率 | 同国家、同经营范围、当前可售 SKU 为分母；近 28 天已发货销售 SKU 为分子 |
| 爆款识别 | 28 天来源可见销量类目内 P80；7/42 天为趋势证据 |
| 店铺重点 SKU | 拆分为 `STORE_KEY_PERFORMER` 与 `STORE_GROWTH_FOCUS_SKU` |
| 国家维度 | 第一版支持，但必须使用确认映射；当前数据状态为 `unavailable` |

第 14 节十四项业务口径已经确认。V2-1 必须把仓库国家配置建模为版本化配置表；店铺国家继续使用现有店铺主数据和来源映射，不复制第二份店铺国家事实。
