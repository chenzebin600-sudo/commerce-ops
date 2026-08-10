# Commerce Ops 利润模块 GMV 与费用率 V1

## 业务口径

- 订单 GMV（店铺原币）=`原始商品总金额 - 优惠金额（原始货币）`。
- 只统计马帮规范化订单头中 `effective_status='valid'` 的订单。
- 日期口径为马帮 `付款时间` 在 `Asia/Shanghai` 时区对应的自然日，筛选区间首尾均包含。
- 店铺费用率=`店铺总费用 / 店铺 GMV`。
- 国家费用率=`国家内店铺总费用之和 / 国家内店铺 GMV 之和`，禁止平均店铺费用率。
- 跨国家汇总先按产品包版本化国家汇率逐店转换为人民币，再计算 `人民币总费用 / 人民币总 GMV`。

## 数据粒度与去重

GMV 的事实粒度是 `growth_order_headers` 的规范化订单头。该表以
`(business_key_version, business_key)` 唯一约束保证同一平台、店铺和订单身份只保留一个当前订单头。
商品明细重复行只用于核对订单头金额是否一致，不能直接参与 GMV 求和。

订单头保存以下可审计源组成，不保存独立的店铺日 GMV 快照：

- `original_product_amount_local`
- `discount_amount_local`
- `gmv_source_status`：`CONFIRMED`、`MISSING` 或 `CONFLICT`
- `gmv_source_rule_version`

马帮订单再次导入时，上述字段与订单头在同一事务中更新。因此 GMV 始终从当前规范化订单头投影，避免与马帮订单表形成两份会漂移的数据。

## 店铺归属

归属优先使用 `commerce_shop_registry.growth_shop_id` 与订单头 `internal_shop_id` 的确定性关联。
历史订单尚无该关联时，只允许在同平台的有效、已确认店铺中使用“规范化店铺名精确且唯一”作为分析回退。
名称歧义或未匹配订单不分摊到任何店铺，也不能用于平台授权或执行身份。

## 完整性与失败关闭

店铺 GMV 按版本化经营规则发布：

1. 已确认的马帮订单批次覆盖所选日期的每一天和该店铺；
2. `MABANG-ORDER-GMV-1.1.0` 将组成缺失、冲突或派生为负数的单个订单贡献定义为 0；
3. 其他已确认订单继续按原始商品总金额减优惠金额累计。

来源日期覆盖不完整时，`gmvValue` 和费用率仍保持为空。来源日期完整时，未解决订单按 0 贡献，`gmvValue` 发布已确认订单小计，并继续保留缺失、冲突、非法订单数和问题代码。店铺 GMV 为 0 时不做除零费用率；国家费用率仍按国家总费用除以国家总 GMV 计算。

## 迁移

- SQLite：`migrations/037_profit_gmv_module.sql`
- PostgreSQL 正式库：`postgresql/shadow/migrations/020_profit_gmv_module.sql`
- 正式库迁移脚本默认只输出计划；执行必须同时确认数据库名和迁移令牌 `PROFIT_GMV_MODULE_V1`。
