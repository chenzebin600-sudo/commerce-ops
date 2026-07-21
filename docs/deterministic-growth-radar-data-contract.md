# 确定性货盘增长雷达：G0.5 数据口径与实施前检查

> 状态：G0.5 交付稿  
> 原始基准：G0 设计提交 `8dc4bc8394ef1cf98505f000631b5baa74c5bb9d`  
> 当前实施基线：主线稳定提交 `4aca65297c62a9be97d22febcd0f8f1dbd67f503`  
> 分支：`feature/deterministic-product-growth-radar`  
> 日期：2026-07-21（Asia/Shanghai）  
> 范围：只固化支线、协调迁移、只读核查真实样例、校准口径、恢复本地测试依赖并定义 G1 数据合同；不实现增长业务功能，不创建或执行增长迁移，不写数据库，不进行真实马帮登录或采集。

为避免把个人机器路径写入仓库，本文用 `<growth-worktree>` 表示当前功能工作树，用 `<permanent-worktree>` 表示永久工作树。真实绝对路径只在本节点完成报告中提供，不写入可移植文档。

## 1. 当前分支、工作树与 G0 提交

### 1.1 当前功能工作树

- 正式分支：`feature/deterministic-product-growth-radar`。
- 分支创建基准：`e659000bb5a396a291d7434c3d1f963f4a3ba58a`。
- G0 文档提交：`8dc4bc8394ef1cf98505f000631b5baa74c5bb9d`。
- rebase 后 G0 文档提交：`d2a0408193ba6aeb5dbdd4d735d719671ad9fbd9`。
- 原 G0.5 文档提交：`47cf7a98b8de5dfa9b27b5547b8bea92c684a689`；rebase 后为 `9ff68c6efa67b94b3414655c0af7f057fc3fd963`。
- 提交信息：`docs: design deterministic product growth radar`。
- 该提交只包含 `docs/deterministic-product-growth-radar-design.md`，共新增 1 个文件。
- 创建分支前目标分支不存在，因此没有覆盖既有分支。
- G0.5 完成时尚未变基主线；恢复 G1A 时已无冲突 rebase 到 `4aca652`，且未修改其他工作树。

### 1.2 所有已注册工作树

| 工作树 | 当前分支 | 当前 HEAD | 当前状态 |
| --- | --- | --- | --- |
| `<permanent-worktree>` | `master` | `4aca65297c62a9be97d22febcd0f8f1dbd67f503` | 主线稳定基线；仅余两份与支线无关的未跟踪产品查询中心文档 |
| `<growth-worktree>` | `feature/deterministic-product-growth-radar` | `9ff68c6efa67b94b3414655c0af7f057fc3fd963` | 已无冲突 rebase 到主线稳定基线，G0/G0.5 完整保留 |

审计开始时永久工作树的 Listing 工作仍是已暂存未提交状态；审计过程中该工作树由外部流程提交为 `98af7ec feat(product-center): add listing workbench`。后续 Listing AI 形成稳定提交 `4aca652`，本支线只 rebase 到该提交，没有修改永久工作树。

## 2. 证据范围与语义状态

本文件区分四种证据：

1. **代码证据**：当前支线源代码、迁移和测试。
2. **持久化元数据证据**：永久工作树 SQLite 中的任务、运行、文件和产品表，只读打开。
3. **真实样例证据**：既有系统已经持久化的两份订单 Excel；未重新登录马帮或重新采集。
4. **公开文档证据**：马帮官方帮助中心公开说明，不代表当前账号权限或实例数据范围。

字段语义状态统一为：

| 状态 | 定义 | 是否可进入确定性硬规则 |
| --- | --- | --- |
| `confirmed` | 已由代码、真实样例和/或权威说明共同确认，且范围、粒度和时间口径明确 | 可以 |
| `inferred` | 能从结构或分布合理推断，但缺少权威业务确认 | 不可以 |
| `unconfirmed` | 字段存在或公开算法已知，但当前实例范围、粒度或业务含义未确认 | 不可以 |
| `unavailable` | 当前来源没有该字段或没有可读取样例 | 不可以 |

技术 ID、哈希、时间戳等合同控制字段可标记为 `confirmed`；业务指标必须满足完整语义才可标记为 `confirmed`。只有 `confirmed` 业务字段能用于后续确定性推荐硬门和评分。

## 3. 所有工作树、迁移状态与迁移编号协调方案

### 3.1 当前迁移事实

rebase 后当前功能分支包含主线正式迁移 `001`–`012`，尚未创建增长雷达迁移。

永久工作树当前包含并已提交：

- `001_mabang_scheduler.sql`
- `002_operation_audit_events.sql`
- `003_scheduled_task_soft_delete.sql`
- `004_export_file_persistence.sql`
- `005_file_lifecycle_scanning.sql`
- `006_file_quarantine_and_review.sql`
- `007_product_center_g1a2.sql`
- `008_product_center_country_identity.sql`
- `009_product_package_lossless_rows.sql`
- `010_product_catalog_soft_delete_ai_content.sql`
- `011_product_listing_workbench.sql`
- `012_product_listing_ai_content_images.sql`

主线正式最高迁移为 `012_product_listing_ai_content_images.sql`。本次 rebase 后再次扫描确认目录中没有 `013` 或更高正式迁移；正式数据库只允许只读质量检查，不在支线开发中执行测试导入。

### 3.2 编号建议

1. 主线保留 `011_product_listing_workbench.sql` 与 `012_product_listing_ai_content_images.sql`，两者均不得修改或重编号。
2. 增长雷达 G1A 的第一个迁移使用 `013_deterministic_growth_radar_foundation.sql`；创建前仍须再次扫描所有工作树。
3. G0.5 当时没有创建任何正式迁移；G1A 只能通过官方 `schema_migrations` 迁移器应用新增迁移。
4. 推荐合并顺序：主线 Listing `011` → 主线 Listing AI `012` → 增长支线同步 `4aca652` → 增长 `013` → 完成 G1A 质量门后合并增长支线。
5. 若增长创建迁移前主线又提交了 `013` 或更高迁移，增长应使用“同步后的最高已提交编号 + 1”。
6. 若合并顺序被改变，必须在任一迁移进入共享主线前重新编号尚未合并的一方；已经应用到共享/正式数据库的迁移不得仅改文件名冒充新编号。

### 3.3 避免并发撞号

- 创建迁移前执行 `git worktree list`、逐工作树 `git status` 和 `migrations` 编号扫描。
- 在团队共享任务/变更单中登记“迁移编号、所有者、分支、预计合并顺序”；登记不是永久占号，主线变化后仍需复核。
- 同一时刻只允许一个明确的迁移编号协调人批准新编号。
- CI 增加迁移文件名唯一、连续性、`schema_migrations` 唯一和 SQLite/PostgreSQL 转换测试。
- 迁移 PR 合并前再次基于目标主线检查编号；发现冲突时只重编号尚未合并/未在共享数据库应用的一方。

## 4. 真实订单样例审查

### 4.1 样例与血缘

在既有持久化文件中找到两份真实订单导出，均位于：

`<permanent-worktree>/storage/exports/mabang/<account-pseudonym>/2026-07/`

| 样例 | 文件时间（本地） | 文件大小 | 来源类型 | 任务/运行 |
| --- | --- | ---: | --- | --- |
| A | 2026-07-15 10:52 | 350,613 bytes | `mabang_scheduled_order` | 手工触发的计划任务运行，成功 |
| B | 2026-07-15 10:53 | 350,608 bytes | `mabang_scheduled_order` | 定时触发，成功 |

两份文件均为 `available`，有 SHA-256、任务 ID、运行 ID和 30 天保留配置。两次运行的付款日期范围均为 2026-07-14，无采集筛选条件，记录为 341 个订单、1,244 行明细。

文件只做只读解析；未复制到仓库、未重存、未改名、未在文档记录账号、订单号、客户或完整明细。

### 4.2 工作表与行粒度

- `订单明细`：`A1:BF1245`，58 列，首行为表头，后续 1,244 行为商品明细。
- `任务信息`：`A1:B13`，记录数据类型、导出时间、任务、日期范围、行数和账号等元数据；账号必须脱敏。
- 源代码会向下填充订单公共字段，并丢弃交易编号或 SKU 为空的行。
- 因每行都有 `SKU` 与 `商品数量`，一行是订单商品明细，不是订单头。
- 341 个唯一订单中，116 个展开为多行，单个订单最多 33 行。
- 样例共有 165 个唯一 SKU、16 个店铺名称、1 个平台；没有国家字段。

一个订单多 SKU 或同 SKU 多行通过重复订单编号表达。样例存在 496 个唯一“订单 × SKU”组合和 1,244 行，不能把“订单 × SKU”简单当成唯一源行。

### 4.3 真实表头

58 个表头为：

```text
订单编号、交易编号、交运时间、物流渠道、店铺名、平台、店长、订单状态、仓库、SKU总数量、
所属地区（省/州）、所属城市、SKU、商品数量、商品库存、商品中文名称、货运单号、付款方式、
SKU明细、客户账号、客户姓名、邮寄地址1(按逗号分隔导出2列)、商品销售单价、原始商品销售单价、
商品总金额、原始运费金额、运费收入、原始商品总金额、订单原始总金额、订单总金额、
优惠金额（人民币）、优惠金额（原始货币）、订单核算金额（人民币）、订单核算金额（原始货币）、
汇率（原始货币）、订单商品名称、采购在途量、付款时间、平台SKU、买家自选物流方式、
最后发货期限、订单自定义分类、发货时间、是否转WMS发货、退货原因、退货备注、作废时间、
作废前状态、电话1、电话2、订单备注、平台订单仓库、是否测评、测评费用、邮政编码、
tiktok样品订单、签收时间、实付金额
```

### 4.4 状态、取消与售后分布

按唯一订单统计：

| 订单状态 | 订单数 | 当前结论 |
| --- | ---: | --- |
| 已发货 | 207 | 可识别，但是否构成最终有效销售仍受售后影响 |
| 已作废 | 99 | 文件仍保留取消/作废订单；有作废时间和作废前状态 |
| 配货中 | 34 | 已付款与否不能仅由状态名判断 |
| 待处理 | 1 | 业务有效性待定义 |

样例没有独立 `付款状态`、`发货状态`、`退款状态` 或 `售后状态`。只能看到付款时间/付款方式、订单状态、交运/发货/签收时间、退货原因/备注、作废时间/作废前状态。

- `退货原因` 只有 2 行非空；`退货备注` 全空。
- 没有独立退款金额、退款件数、退款时间或部分/全额退款标志。
- 不能通过现有样例区分部分退款与全额退款。
- 取消/作废订单仍存在于文件中，不能通过“是否存在”判断有效订单。

### 4.5 数量、金额与重复风险

- `商品数量` 和 `SKU总数量` 在样例中全部可解析为整数。
- 340/341 个订单的明细 `商品数量` 合计等于订单 `SKU总数量`；1 个订单不一致，应进入数据质量队列。
- 样例有 499 行与另一行全字段完全相同，但这些行可能代表相同 SKU 的多件/多条商品明细，不能直接按整行哈希去重。
- 两次相邻导出的订单集合和“订单 × SKU”集合相同，但有 11 个 `商品库存` 单元格发生变化；说明订单文件还混入采集时点库存，文件哈希和整行内容会随时间变化。
- `订单总金额` 在 1 个订单的多行间不一致；`订单核算金额（人民币）` 和 `实付金额` 在样例订单内保持一致。
- 订单级金额被向下填充到商品行，直接对明细行求和会重复计算。

因此 G1 不应把文件哈希、整行哈希或“订单 × SKU”直接当作最终去重键。建议把每次文件视作订单快照批次，原始行完整保留行序；标准事实按经过验证的业务组合键聚合，并用最新来源版本替换同一业务事实，而不是跨批次累加。

### 4.6 关键字段确认矩阵

| 问题 | 结论 | 状态 |
| --- | --- | --- |
| 哪一行代表订单 | 没有独立订单头；订单编号相同的商品行共同代表订单 | `confirmed` |
| 哪一行代表商品明细 | `订单明细` 中每个非表头行 | `confirmed` |
| 多 SKU 表达 | 同一订单编号重复多行，每行有 SKU/数量 | `confirmed` |
| 取消订单是否存在 | 存在，状态为已作废，并有作废时间 | `confirmed` |
| 部分退款 | 无独立字段，不能识别 | `unavailable` |
| 全额退款 | 无独立字段，不能可靠识别 | `unavailable` |
| 退款件数 | 无独立字段 | `unavailable` |
| 退款金额 | 无独立字段 | `unavailable` |
| 有效订单数 | 可计算“非作废订单数”候选，但不能等价于净有效订单 | `inferred` |
| 有效销售件数 | 可计算非作废商品数量候选，但不能扣除退款件数 | `inferred` |
| 有效销售金额 | 可按订单去重计算毛额候选，但金额口径和退款未确认 | `unconfirmed` |
| 店铺稳定 ID | 只有店铺名称；无店铺 ID/账号 ID | `unavailable` |
| 国家 | 无国家/站点字段；不得仅从店名或省州推导 | `unavailable` |
| 平台 | 有直接平台字段，样例全部为 Lazada | `confirmed`（样例范围） |
| SKU 与产品中心一致 | 字符串可比，但国家缺失造成大量歧义 | `unconfirmed` |
| 创建时间 | 无 | `unavailable` |
| 付款时间 | 有，全部非空 | `confirmed` |
| 取消时间 | 无名为取消时间的字段；有作废时间 | `confirmed`（仅作废） |

### 4.7 SKU 与产品中心对比

在不输出真实 SKU 的前提下，将样例 165 个唯一 SKU 与产品中心未删除/未归档 SKU 做大小写标准化精确对比：

- 1 个没有精确命中；
- 82 个在全产品中心范围只有一个候选；
- 82 个跨多个国家有多个候选；
- 订单样例没有国家，因此至少一半不能用 SKU 字符串唯一定位产品。

即使唯一候选也只能形成 `suggested` 映射，必须结合来源系统、国家或人工证据确认。当前代码还会对平台 SKU 执行字符串截断式规范化，该规则需要真实平台 SKU 样本验证，不能直接用于 confirmed 映射。

## 5. 真实库存样例审查

### 5.1 查找结果

没有找到 `mabang_scheduled_inventory` 或 `mabang_manual_inventory` 类型的真实持久化库存文件；数据库只有 1 个订单计划任务和 2 次订单运行，也没有库存计划任务/运行。

现有四份产品包文件不是库存模块导出，不能冒充真实库存样例。产品包数据库可提供辅助证据：21,714 个无损产品包行、9,559 个 SKU、28 个仓库，`仓存` 全部为整数且出现 1 个负值；但全部 `预测日销量` 为空。产品包没有可用库存、锁定、在途、待发等完整库存语义。

因此下列真实库存问题仍不能通过实例样例验证：字段类型/值分布、仓库重复方式、可用库存定义、预测日销量值、更新时间、供应商/采购字段以及账号可见范围。

### 5.2 代码声明的库存导出字段

当前库存采集代码声明以下目标字段：

```text
库存SKU编号、商品状态、活跃度、是否新款、一级目录、二级目录、三级目录、品牌、采购员、
中文名称、英文名称、父仓库、仓库、仓位、销量(7/28/42)、预测日销量(个)、仓位库存、
当前可售天数、在途量、海外仓/预分配调拨相关量、预警量、预警天数、未发货量、
调拨未发货、可用库存量、最近出库、最近入库、备注
```

这只证明解析器期待这些字段，不证明当前账号能导出、字段有值或语义适用于公司全量。

### 5.3 订单样例缺失/库存样例缺失清单

订单样例已经存在，不需要用户再提供普通订单导出；若要确认售后净额，仍需提供包含退款明细的官方订单/售后导出。

库存侧至少需要以下任一文件：

1. 既有系统生成并持久化的一份完整、无筛选库存 Excel，关联成功任务/运行/文件元数据；或
2. 用户提供一份来自同一马帮页面和模板的只读样例，放在 Git 之外；允许先脱敏账号、供应商和备注，但保留表头、数值类型、仓库重复结构及缓存更新时间。

样例应至少覆盖：同一 SKU 多仓、零库存、在途、未发货、可用库存、非零预测日销量、小数预测值、停售/新品状态和异常负数。

## 6. 预测日销量、公司日销与 AI 包含关系

### 6.1 官方算法证据

马帮官方帮助页 [库存 SKU 的预测日销量计算逻辑](https://help.mabangerp.com/kbzx/nested/details?resource_id=2&id=2691) 说明：

- 该字段是“预测日销量（日均销量）”，不是逐日真实销量。
- 先用可配置的客单量系数和销售系数调整订单商品销量。
- 以付款时间落入最近 0–10、11–20、21–30 天区间。
- SKU 创建/开售不足 30 天时，以 30 天内调整后总销量除以创建/开售天数。
- 达到 30 天时，对三个 10 天区间的日均值做加权；未配置时默认权重为 50%/30%/20%。
- 已配置且尚未到开售日时结果为 0。

官方 [库存 SKU 日销量、剩余库存趋势图说明](https://help.mabangerp.com/kbzx/nested/details?resource_id=2&id=3226) 还说明：库存 SKU 列表销量以“前一天晚上截止”的重算结果为主，而趋势图可实时统计；可见仓库和平台受账号权限控制。

### 6.2 当前语义结论

统一英文名暂定为 `source_predicted_daily_sales`，整体语义状态仍为 `unconfirmed`，原因是：

- 算法类别与默认窗口已由官方文档确认；
- 当前实例没有真实库存导出值，无法确认整数/小数分布、导出重复粒度和实际更新时间；
- 不知道当前马帮账号可见的仓库、平台和店铺是否覆盖公司全量；
- 不知道导出行是 SKU 总值还是在每个仓库行重复同一 SKU 值；
- 不知道当前组织是否自定义了权重、客单量系数、销售系数或开售时间；
- 不知道 AI 团队订单是否包含在账号权限范围内。

因此不得把它命名为“公司真实日销”，也不得在 G2 前直接用于硬规则或评分。

### 6.3 公司销量是否包含 AI 团队

结论：`unconfirmed`。

真实订单样例只覆盖一个账号可见的 Lazada 数据；公开文档明确销量受仓库、平台和店铺权限影响。当前没有公司全量账号范围证明、AI 团队权威店铺清单，也没有同 SKU、同窗口、同粒度的公司值与 AI 值对比。

在确认前禁止计算：

```text
其他团队销量 = 公司销量 - AI 团队销量
```

未来只有在同周期、同 SKU、同单位、同订单状态、同平台/国家/店铺范围且公司值被证明包含 AI 时才允许相减。任何负值不修正为 0，必须保存两个原始值、范围版本、窗口和计算条件，并创建阻断级数据质量问题。

## 7. 可售库存候选口径

当前不决定最终公式。优先验证马帮 `可用库存量` 的官方/实例定义；若该字段已扣除锁定、待发或其他占用，再次扣减会造成重复扣减。

| 方案 | 候选公式 | 使用字段 | 优点 | 风险/重复扣减 | 跨仓合计 | 可售天数适用性 | 当前状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A | 可售库存 = 可用库存量 | `可用库存量` | 最接近来源提供的业务值，实施简单 | 定义未知；可能已含多种扣减 | 需确认是否仓级且仓库互斥 | 定义确认后优先 | `unconfirmed` |
| B | 可售库存 = 仓位库存 − 锁定库存 | `仓位库存`、`锁定库存` | 公式直观 | 当前导出字段中没有明确锁定库存 | 需按合格仓库求和 | 当前不可用 | `unavailable` |
| C | 可售库存 = 仓位库存 − 锁定库存 − 未发货量 | 上述字段、`未发货量` | 可表达待发占用 | 锁定可能已包含待发，容易双扣 | 需验证各字段粒度 | 不确认前不可用 | `unconfirmed` |
| D | 可售库存 = 仓位库存 − 未发货量 | `仓位库存`、`未发货量` | 在缺少锁定字段时可形成候选 | 忽略其他锁定；若仓位库存已净额则双扣 | 需验证仓级 | 仅用于对账实验 | `inferred` |
| E | 可售库存 = 可用库存量 + 合格在途量 | `可用库存量`、`在途量` | 可用于未来供给视图 | 在途不是当前可售，且无可靠 ETA 时会掩盖断货 | 不能作为当前可售合计 | 不适合当前可售天数 | `unconfirmed` |

在真实库存样例与业务说明到位前，标准事实分别保存来源原值，不派生最终 `sellable_inventory`。多仓汇总只包含配置为合格、相互不重叠的仓库；SKU 级日销如果在仓库行重复，只取一次，不能随仓库求和。

## 8. 店铺、当前在线 Listing 与 SKU 映射

### 8.1 当前店铺证据

当前数据库没有权威店铺主表。`mabang_filter_option_cache` 有 381 行历史筛选缓存，来自 1 个账号，累计观察到 16 个店铺名称、1 个平台、3 个负责人、3 个仓库和 165 个 SKU，最近更新时间为 2026-07-15。

该缓存：

- 只有店铺名称，没有稳定店铺 ID或平台账号 ID；
- 没有确认的国家、店铺状态、主营类目或有效期；
- 来自历史订单观察，语义只能是 `historical_observed`；
- 不能证明店铺或商品目前仍在线。

主线 Listing 工作台虽然已有 `shop_id`、`shop_key`、`platform_product_id`、`platform_listing_id` 等设计字段，但当前草稿和发布记录都是 0 行，也没有平台当前在线同步，因此不能作为 `current_online` 来源。

### 8.2 覆盖来源优先级

1. 复用/新增经过批准的马帮在线商品列表采集，并保留来源快照；
2. 导入平台后台官方商品导出表；
3. 人工上传经运营确认的当前在线商品覆盖表；
4. 后续接入平台 API；
5. 历史订单只作辅助证据，永不自动升级为 `current_online`。

G1 可以先建立店铺主数据和覆盖快照结构，并支持人工导入合同；G3 在没有新鲜、权威的 `current_online` 数据时必须暂停“未覆盖/覆盖不足”诊断。

### 8.3 临时人工覆盖导入格式

最小必填字段：

| 中文字段 | 英文字段 | 必填 | 说明 |
| --- | --- | :---: | --- |
| 来源快照时间 | `captured_at` | 是 | 含时区的采集/导出时间 |
| 平台 | `platform_code` | 是 | 必须映射到 confirmed 平台 |
| 国家/站点 | `country_code` | 是 | 不能仅从店名推导 |
| 店铺来源键 | `source_shop_key` | 是 | 平台或马帮稳定 ID；若没有需人工分配并标记 inferred |
| 店铺名称 | `source_shop_name` | 是 | 显示及别名证据，不作唯一键 |
| 平台商品 ID | `platform_product_id` | 是 | 平台稳定商品身份 |
| 平台 Listing ID | `platform_listing_id` | 否 | 平台提供时保留 |
| 平台 SKU | `platform_sku` | 是 | 原值保留 |
| 马帮/内部 SKU | `source_sku` | 是 | 用于产品映射 |
| 在线状态 | `online_status` | 是 | 受控枚举，如 online/offline/suspended |
| 最近同步时间 | `source_updated_at` | 是 | 平台记录更新时间 |
| 来源文件/批次 | `source_batch_key` | 是 | 可追溯到上传文件和哈希 |

人工表必须经过文件安全检查、表头验证、重复/冲突检查和人工确认；快照过期时不能继续判定未覆盖。

### 8.4 SKU 映射状态

- 产品中心 confirmed 身份为 `country + normalized SKU`。
- 订单样例只有 SKU，没有国家；SKU 字符串匹配只能产生候选。
- 平台 SKU 有 1 行缺失，并存在未经真实样本验证的截断式规范化逻辑。
- 主 SKU 不在订单样例中；不能用款式关系替代 SKU 身份。
- G1 允许 exact 候选、冲突队列和人工确认；只有 `confirmed` 映射进入标准事实和后续评分。

## 9. 阻断项分级

### A. 阻断 G1 数据底座的事项

这些事项不一定阻断 G1 的全部工作，但会阻断对应事实链的生产验收或正式迁移：

1. **迁移前同步主线（已完成）**：支线已无冲突同步 `4aca652`，正式最高迁移为 `012`，增长 G1A 编号为 `013`。
2. **真实库存样例缺失**：可以先实现通用来源批次/原始行合同和 fixture 解析，但库存解析器、粒度和数值验收不能完成，正式库存事实不能发布。
3. **订单稳定业务键待验证**：没有官方订单行 ID；同一订单/SKU 可重复多行。G1 必须以更多脱敏样本验证聚合键和跨批次替换策略，不能按整行或订单 × SKU盲目去重。
4. **支线质量门**：主线稳定基线为 428/428、Build 和 Doctor 通过；支线必须在 rebase 后复验。若外部广告服务目录缺失，只按环境失败单独记录，不修改断言。

已不再阻断 G1A 的事项：正式分支已建立，G0/G0.5 已提交且 rebase 后保留，SQLite 迁移机制和 `001`–`012` 正式迁移可读，订单真实样例和文件血缘可读，Node/Python/`pg` 核心依赖已恢复。

### B. 阻断 G2 确定性规则和评分的事项

1. 当前实例 `source_predicted_daily_sales` 的范围、粒度、配置权重和实际更新时间未确认。
2. 公司销量是否覆盖全部平台/店铺/国家，以及是否包含 AI 团队，均未确认。
3. AI 团队权威责任范围和版本维护人未确认。
4. 最终可售库存公式、合格仓库和在途处理未确认。
5. 订单/库存/覆盖的新鲜度 SLA 未由业务批准。
6. “已验证商品”的窗口、阈值、生命周期和排除规则未批准。

这些问题不阻止 G1 保存原始值、建立状态/质量框架，但任何相关字段都不能进入 G2 硬规则或评分。

### C. 阻断 G3 店铺货盘缺口诊断的事项

1. 没有稳定店铺 ID或平台账号 ID。
2. 没有权威且新鲜的 `current_online` Listing 来源。
3. 没有店铺状态、国家、负责人和主营/禁止类目主数据。
4. 平台、国家、类目和平台 SKU 映射未确认。

G1 可建立结构，G3 必须等上述数据来源到位后再输出未覆盖/覆盖不足结论。

### D. 阻断净销售和售后指标的事项

1. 没有退款金额、退款件数和退款时间。
2. 不能区分部分退款和全额退款。
3. `退货原因` 不足以证明已退款。
4. 已作废、配货中、待处理等状态如何进入有效订单尚未由业务确认。
5. 多种金额字段的财务含义、币种及净额关系未确认。

G1 只能保存毛订单/商品事实和来源状态；不得命名为净销量、净销售额或退款后有效订单。

### E. 非阻断但需后续补充

- 锁定库存字段可暂时为 `NULL/unavailable`，不阻止保存其他库存原值。
- 个别 SKU、类目、国家、平台映射可进入人工确认队列，不阻止已确认记录入库。
- 供应商/采购字段可延后，当前不参与增长规则。
- 产品包仓存中的 1 个负值可作为质量问题，不阻止其他行摄取。
- 外部广告集成测试缺少服务目录与增长业务无关，但在合并质量门前仍需处理。

## 10. G1 数据合同总则

### 10.1 通用规则

- 所有来源都先形成不可变批次，再形成原始行、标准事实和映射。
- 真实源文件继续由统一文件服务保存；合同只保存 `file_id`、哈希和相对血缘，不复制真实文件。
- 原始订单行采用最小白名单，禁止写入客户姓名、账号、电话、地址、邮箱或收件信息。
- 时间统一保存 UTC ISO 8601，同时保存来源时区；业务日期通过版本化规则派生。
- SKU/店铺/订单号等标识使用文本，不能转数值或丢失前导零。
- 数量使用整数或定点数；金额使用定点 decimal/最小货币单位，不使用二进制浮点。
- 原始值列与标准值列分离；标准化不能覆盖原值。
- 所有事实保存来源批次、原始行、解析器版本、映射版本和口径版本。
- 只有语义状态为 `confirmed` 的业务字段允许 `score_eligible=true`。

以下类型采用逻辑类型，实施时映射到 SQLite/PostgreSQL 可移植类型：`uuid`、`text`、`integer`、`decimal(p,s)`、`boolean`、`timestamp`、`date`、`json`、`enum`。

### 10.2 合同字段表说明

每张表的“来源/原值”列同时表达来源和是否保留原值；“评分”表示是否可以进入未来确定性规则，不表示 G1 会实现评分。

## 11. 合同一：订单来源批次 `growth_order_source_batches`

| 中文名称 | 英文字段名 | 类型 | 必填 | 来源/原值 | 标准化规则 | 语义状态 | 评分 | 数据质量规则 |
| --- | --- | --- | :---: | --- | --- | --- | :---: | --- |
| 批次ID | `id` | uuid | 是 | 系统生成；不适用 | UUID | confirmed | 否 | 唯一、不可变 |
| 来源文件ID | `source_file_id` | uuid | 是 | `export_files.id`；保留引用 | 不变 | confirmed | 否 | 文件必须 available 且哈希通过 |
| 来源文件哈希 | `source_file_sha256` | text | 是 | `export_files.file_hash`；保留 | 小写 hex | confirmed | 否 | 64 字符；与文件复核一致 |
| 来源任务ID | `source_task_id` | uuid | 否 | `scheduled_export_tasks.id` | 不变 | confirmed | 否 | 任务类型必须 order_export |
| 来源运行ID | `source_run_id` | uuid | 否 | `scheduled_export_runs.id` | 不变 | confirmed | 否 | 与文件 task/run 关系一致 |
| 账号伪标识 | `account_scope_key` | text | 是 | 账号 ID 的受控内部映射；不保留用户名 | 不可逆/内部 ID | confirmed | 否 | 禁止用户名、手机号、凭证 |
| 查询开始时间 | `query_start_at` | timestamp | 是 | 任务运行日期范围；保留原时区元数据 | 转 UTC | confirmed | 否 | 小于等于结束时间 |
| 查询结束时间 | `query_end_at` | timestamp | 是 | 同上 | 转 UTC | confirmed | 否 | 最大窗口符合来源限制 |
| 来源时区 | `source_timezone` | text | 是 | 任务 timezone | IANA 名称 | confirmed | 否 | 必须是允许时区 |
| 筛选摘要 | `filter_contract_json` | json | 是 | 任务筛选；原值白名单保留 | 稳定键排序 | confirmed | 否 | 禁止凭证/PII；公司口径要求无隐含筛选 |
| 解析器版本 | `parser_version` | text | 是 | 应用版本 | semver/提交标识 | confirmed | 否 | 不可空 |
| 摄取状态 | `status` | enum | 是 | 系统 | 受控状态机 | confirmed | 否 | succeeded 才能发布事实 |
| 行数 | `source_row_count` | integer | 是 | 工作表行数 | 非负整数 | confirmed | 否 | 与解析结果/运行元数据对账 |
| 捕获时间 | `captured_at` | timestamp | 是 | 文件导出/运行完成时间 | 转 UTC | confirmed | 否 | 不得晚于摄取完成时间 |

## 12. 合同二：原始订单行 `growth_raw_order_rows`

| 中文名称 | 英文字段名 | 类型 | 必填 | 来源/原值 | 标准化规则 | 语义状态 | 评分 | 数据质量规则 |
| --- | --- | --- | :---: | --- | --- | --- | :---: | --- |
| 原始行ID | `id` | uuid | 是 | 系统 | UUID | confirmed | 否 | 唯一 |
| 来源批次ID | `source_batch_id` | uuid | 是 | 订单批次 | 不变 | confirmed | 否 | 外键存在 |
| 工作表 | `sheet_name` | text | 是 | Excel | trim；原值保留 | confirmed | 否 | 必须为受支持表 |
| 来源行号 | `source_row_number` | integer | 是 | Excel 行号 | 1-based | confirmed | 否 | 批次内唯一 |
| 订单编号原值 | `raw_order_id` | text | 是 | `订单编号`；保留 | 不转数字、trim | confirmed | 否 | 非空；PII 访问受限 |
| 交易编号原值 | `raw_trade_id` | text | 是 | `交易编号`；保留 | 不转数字、trim | confirmed | 否 | 非空 |
| SKU原值 | `raw_sku` | text | 是 | `SKU`；保留 | trim；不截断 | confirmed | 否 | 非空 |
| 平台SKU原值 | `raw_platform_sku` | text | 否 | `平台SKU`；保留 | 仅 trim；不得沿用未验证截断 | unconfirmed | 否 | 缺失/格式异常告警 |
| 商品数量原值 | `raw_item_quantity` | text | 是 | `商品数量`；保留 | 后续解析为 decimal | confirmed | 否 | 必须可解析且非负 |
| 订单状态原值 | `raw_order_status` | text | 是 | `订单状态`；保留 | trim | confirmed | 否 | 未知枚举进入质量问题 |
| 店铺名称原值 | `raw_shop_name` | text | 是 | `店铺名`；保留 | Unicode/空白规范化另存 | confirmed | 否 | 不作稳定 ID |
| 平台原值 | `raw_platform` | text | 是 | `平台`；保留 | 别名映射另存 | confirmed | 否 | 必须可映射后才能进事实 |
| 仓库原值 | `raw_warehouse` | text | 否 | `仓库`；保留 | trim | unconfirmed | 否 | 空值允许；映射冲突告警 |
| 付款时间原值 | `raw_paid_at` | text | 是 | `付款时间`；保留 | 解析另存 | confirmed | 否 | 必须可按来源时区解析 |
| 发货/作废原值 | `raw_fulfillment_json` | json | 否 | 交运、发货、签收、作废时间/前状态；白名单保留 | 不改原值 | confirmed | 否 | JSON 结构受控 |
| 金额原值 | `raw_amounts_json` | json | 否 | 商品/订单/核算/实付金额；白名单保留 | 不改原值 | unconfirmed | 否 | 禁止把订单级金额逐行求和 |
| 行内容哈希 | `row_sha256` | text | 是 | 白名单原值 | 稳定序列化后哈希 | confirmed | 否 | 用于变更证据，不单独作为去重键 |

禁止字段：客户账号、客户姓名、电话、地址、邮编、收件信息和订单备注中的自由文本不得进入本表。

## 13. 合同三：标准订单事实 `growth_order_facts`

建议事实粒度先定义为“订单 × 产品 SKU × 平台 × 店铺 × 仓库 × 价格/变体判别项”的聚合商品事实；正式组合键需通过更多样例确认。来源文件内重复商品行先聚合，再按最新订单快照更新，不能跨批次累加。

| 中文名称 | 英文字段名 | 类型 | 必填 | 来源/原值 | 标准化规则 | 语义状态 | 评分 | 数据质量规则 |
| --- | --- | --- | :---: | --- | --- | --- | :---: | --- |
| 事实ID | `id` | uuid | 是 | 系统 | UUID | confirmed | 否 | 唯一 |
| 业务事实键 | `business_fact_key` | text | 是 | 多字段组合；组合字段原值可追溯 | 版本化哈希 | unconfirmed | 否 | 键版本必填；碰撞阻断 |
| 订单伪标识 | `order_key` | text | 是 | 订单编号受控映射 | HMAC/内部键 | confirmed | 否 | 不暴露原订单号给普通用户 |
| 产品SKU ID | `product_sku_id` | uuid | 否 | SKU 映射 | confirmed 映射后写入 | unconfirmed | 是，仅 confirmed | 一对多冲突阻断 |
| 平台ID | `platform_id` | uuid | 否 | 平台映射 | confirmed 映射 | unconfirmed | 是，仅 confirmed | 未映射阻断评分 |
| 店铺ID | `shop_id` | uuid | 否 | 店铺映射 | confirmed 映射 | unavailable | 是，仅 confirmed | 名称不得直接作 ID |
| 国家ID | `country_id` | uuid | 否 | 店铺/站点权威映射 | confirmed 映射 | unavailable | 是，仅 confirmed | 不从店名静默推导 |
| 仓库ID | `warehouse_id` | uuid | 否 | 仓库映射 | confirmed 映射 | unconfirmed | 否 | 映射冲突告警 |
| 业务日期 | `business_date` | date | 是 | 付款时间 | 来源时区转日期 | confirmed | 是 | 与口径版本绑定 |
| 商品数量 | `gross_item_quantity` | decimal(18,4) | 是 | 同业务键原始行数量合计 | 精确定点求和 | inferred | 否 | 非负；与 SKU 总量对账 |
| 订单状态 | `order_status_code` | enum | 是 | 来源状态映射 | 版本化枚举 | unconfirmed | 否 | 未确认状态不能判有效 |
| 毛订单有效标记 | `gross_eligible_flag` | boolean | 否 | 状态规则 | 规则版本化 | unconfirmed | 否 | 业务确认前必须 NULL |
| 商品毛额 | `gross_item_amount` | decimal(20,4) | 否 | 商品金额候选 | 币种内精确值 | unconfirmed | 否 | 币种必填；不可与订单金额混加 |
| 订单毛额 | `gross_order_amount` | decimal(20,4) | 否 | 订单级金额去重取值 | 同订单只计一次 | unconfirmed | 否 | 同订单多值冲突阻断 |
| 币种 | `currency_code` | text | 否 | 来源/平台配置 | ISO 4217 | unavailable | 否 | 金额非空时必填 |
| 退款件数 | `refunded_quantity` | decimal(18,4) | 否 | 当前无来源 | 不适用 | unavailable | 否 | 不得默认 0 |
| 退款金额 | `refunded_amount` | decimal(20,4) | 否 | 当前无来源 | 不适用 | unavailable | 否 | 不得默认 0 |
| 来源版本 | `source_batch_id` | uuid | 是 | 订单批次 | 不变 | confirmed | 否 | 可回溯到原始行集合 |
| 口径版本 | `metric_definition_version` | text | 是 | 指标定义 | 不变 | confirmed | 否 | 每次变更产生新版本 |

## 14. 合同四：库存来源批次 `growth_inventory_source_batches`

| 中文名称 | 英文字段名 | 类型 | 必填 | 来源/原值 | 标准化规则 | 语义状态 | 评分 | 数据质量规则 |
| --- | --- | --- | :---: | --- | --- | --- | :---: | --- |
| 批次ID | `id` | uuid | 是 | 系统 | UUID | confirmed | 否 | 唯一、不可变 |
| 来源文件ID | `source_file_id` | uuid | 是 | `export_files.id` | 不变 | confirmed | 否 | 必须为库存来源类型 |
| 来源文件哈希 | `source_file_sha256` | text | 是 | 文件服务 | 小写 hex | confirmed | 否 | 大小/哈希复核通过 |
| 来源任务/运行 | `source_execution_json` | json | 否 | task/run ID | 受控键 | confirmed | 否 | 关系必须一致 |
| 账号范围键 | `account_scope_key` | text | 是 | 账号内部 ID | 不可逆映射 | confirmed | 否 | 禁止账号/凭证 |
| 捕获时间 | `captured_at` | timestamp | 是 | 导出时间 | 转 UTC | confirmed | 是 | 快照核心时间，不得缺失 |
| 来源缓存时间 | `source_cache_updated_at` | timestamp | 否 | 马帮 `cacheUpdateTime` | 转 UTC | unavailable | 是，仅 confirmed | 真实样例到位后必验 |
| 账号权限范围 | `visibility_scope_json` | json | 否 | 账号仓库/平台权限 | 版本化 ID 集合 | unavailable | 是，仅 confirmed | 公司全量必须有证据 |
| 报告行数 | `reported_row_count` | integer | 否 | 马帮页面 | 非负整数 | unconfirmed | 否 | 与导出行数对账 |
| 解析行数 | `parsed_row_count` | integer | 是 | 解析器 | 非负整数 | confirmed | 否 | 超出容差阻断 |
| 来源汇总 | `source_summary_json` | json | 否 | 总库存/成本/在途汇总 | 原值白名单 | unconfirmed | 否 | 仅用于对账，不评分 |
| 解析器版本 | `parser_version` | text | 是 | 应用 | semver/提交 | confirmed | 否 | 非空 |
| 状态 | `status` | enum | 是 | 系统 | 受控状态机 | confirmed | 否 | succeeded 才发布快照 |

## 15. 合同五：原始库存行 `growth_raw_inventory_rows`

| 中文名称 | 英文字段名 | 类型 | 必填 | 来源/原值 | 标准化规则 | 语义状态 | 评分 | 数据质量规则 |
| --- | --- | --- | :---: | --- | --- | --- | :---: | --- |
| 原始行ID | `id` | uuid | 是 | 系统 | UUID | confirmed | 否 | 唯一 |
| 来源批次ID | `source_batch_id` | uuid | 是 | 库存批次 | 不变 | confirmed | 否 | 外键存在 |
| 来源行号 | `source_row_number` | integer | 是 | Excel | 1-based | confirmed | 否 | 批次内唯一 |
| 库存SKU原值 | `raw_inventory_sku` | text | 是 | `库存SKU编号` | trim；不截断 | unconfirmed | 否 | 真实样例确认后升级 |
| 主SKU原值 | `raw_main_sku` | text | 否 | 当前代码字段中无明确主 SKU | 不适用 | unavailable | 否 | 不得从 SKU 猜测 |
| 商品名称原值 | `raw_product_name` | text | 否 | 中文/英文名称 | trim；原值保留 | unconfirmed | 否 | 只作显示/证据 |
| 仓库原值 | `raw_warehouse` | text | 是 | `仓库` | trim；原值保留 | unconfirmed | 否 | 真实多仓样例必验 |
| 父仓库原值 | `raw_parent_warehouse` | text | 否 | `父仓库` | trim | unconfirmed | 否 | 防止父子仓重复聚合 |
| 仓位库存原值 | `raw_bin_inventory` | text | 否 | `仓位库存` | 解析另存 | unconfirmed | 否 | 数值、负数和单位检查 |
| 可用库存原值 | `raw_available_inventory` | text | 否 | `可用库存量` | 解析另存 | unconfirmed | 否 | 不与仓位库存静默互换 |
| 锁定库存原值 | `raw_locked_inventory` | text | 否 | 当前无字段 | 不适用 | unavailable | 否 | 不得默认 0 |
| 在途库存原值 | `raw_in_transit_inventory` | text | 否 | `在途量` | 解析另存 | unconfirmed | 否 | 当前可售公式不默认包含 |
| 待发库存原值 | `raw_unshipped_inventory` | text | 否 | `未发货量`/调拨未发货 | 分字段保留 | unconfirmed | 否 | 防止重复扣减 |
| 近期开奖销量原值 | `raw_sales_windows` | text | 否 | `销量(7/28/42)` | 原字符串保留 | unconfirmed | 否 | 模板格式变化阻断解析 |
| 预测日销量原值 | `raw_source_predicted_daily_sales` | text | 否 | `预测日销量(个)` | 原值保留 | unconfirmed | 否 | 不命名为公司真实日销 |
| 来源可售天数 | `raw_source_days_of_supply` | text | 否 | `当前可售天数` | 原值保留 | unconfirmed | 否 | 不反推库存/销量 |
| 商品状态/活跃度 | `raw_product_state_json` | json | 否 | 状态、活跃度、新款 | 白名单保留 | unconfirmed | 否 | 需映射版本 |
| 采购/供应信息 | `raw_procurement_json` | json | 否 | 采购员及可用字段 | 必须脱敏人员信息 | unconfirmed | 否 | 普通运营不可见个人标识 |
| 行内容哈希 | `row_sha256` | text | 是 | 白名单原值 | 稳定序列化哈希 | confirmed | 否 | 仅作证据/变更检测 |

## 16. 合同六：库存快照事实 `growth_inventory_snapshot_facts`

事实粒度候选为“快照 × 产品 SKU × 仓库”；在真实样例确认预测日销量是否为 SKU 级重复值前，预测日销量单独保留来源粒度标志。

| 中文名称 | 英文字段名 | 类型 | 必填 | 来源/原值 | 标准化规则 | 语义状态 | 评分 | 数据质量规则 |
| --- | --- | --- | :---: | --- | --- | --- | :---: | --- |
| 快照事实ID | `id` | uuid | 是 | 系统 | UUID | confirmed | 否 | 唯一 |
| 来源批次ID | `source_batch_id` | uuid | 是 | 库存批次 | 不变 | confirmed | 否 | 外键存在 |
| 快照时间 | `snapshot_at` | timestamp | 是 | 捕获/缓存时间 | 优先缓存时间，规则版本化 | unconfirmed | 是，仅 confirmed | 不得用文件写入时间替代而不标记 |
| 产品SKU ID | `product_sku_id` | uuid | 否 | SKU 映射 | confirmed 映射 | unconfirmed | 是，仅 confirmed | 冲突阻断 |
| 仓库ID | `warehouse_id` | uuid | 否 | 仓库映射 | confirmed 映射 | unconfirmed | 是，仅 confirmed | 父子仓重复阻断 |
| 仓位库存 | `bin_inventory` | decimal(18,4) | 否 | 仓位库存原值 | 精确定点 | unconfirmed | 否 | 负值质量问题 |
| 可用库存 | `source_available_inventory` | decimal(18,4) | 否 | 可用库存原值 | 精确定点 | unconfirmed | 否 | 业务定义未确认前不评分 |
| 锁定库存 | `locked_inventory` | decimal(18,4) | 否 | 当前无来源 | 不适用 | unavailable | 否 | 不得默认 0 |
| 在途库存 | `in_transit_inventory` | decimal(18,4) | 否 | 在途量 | 精确定点 | unconfirmed | 否 | 不作为当前可售 |
| 未发货量 | `unshipped_inventory` | decimal(18,4) | 否 | 未发货量 | 精确定点 | unconfirmed | 否 | 与锁定关系待确认 |
| 最终可售库存 | `sellable_inventory` | decimal(18,4) | 否 | 版本化候选公式 | 不自动计算 | unconfirmed | 是，仅 confirmed | 公式版本和输入状态必填 |
| 预测日销量 | `source_predicted_daily_sales` | decimal(18,6) | 否 | 来源字段 | 精确定点 | unconfirmed | 否 | 当前不得用于评分 |
| 预测销量粒度 | `predicted_sales_grain` | enum | 否 | 样例/说明 | sku/sku_warehouse/other | unavailable | 否 | 未确认时禁止跨仓汇总 |
| 近7/28/42天销量 | `source_sales_windows_json` | json | 否 | 来源复合字段 | 拆分值与原值并存 | unconfirmed | 否 | 窗口、状态口径必填 |
| 可售天数 | `days_of_supply` | decimal(18,6) | 否 | 可售库存/批准日销 | 版本化公式 | unconfirmed | 是，仅 confirmed | 任一输入空/非正则为 NULL+状态 |
| 新鲜度状态 | `freshness_status` | enum | 是 | 快照/SLA | fresh/stale/unknown | unconfirmed | 是，仅 fresh | SLA 未批准前为 unknown |

## 17. 合同七：店铺主数据 `growth_shops`

| 中文名称 | 英文字段名 | 类型 | 必填 | 来源/原值 | 标准化规则 | 语义状态 | 评分 | 数据质量规则 |
| --- | --- | --- | :---: | --- | --- | --- | :---: | --- |
| 店铺ID | `id` | uuid | 是 | 系统 | UUID | confirmed | 否 | 唯一 |
| 来源系统 | `source_system` | text | 是 | 马帮/平台/人工 | 受控枚举 | confirmed | 否 | 非空 |
| 来源店铺键 | `source_shop_key` | text | 是 | 平台账号 ID/马帮 ID | trim；原值保留 | unavailable | 是，仅 confirmed | 同来源唯一 |
| 店铺名称 | `source_shop_name` | text | 是 | 订单/主数据 | 原值+规范名 | confirmed（名称） | 否 | 不作唯一键 |
| 平台ID | `platform_id` | uuid | 否 | 平台映射 | confirmed 映射 | unconfirmed | 是，仅 confirmed | 必填后才能推荐 |
| 国家ID | `country_id` | uuid | 否 | 权威店铺/站点数据 | confirmed 映射 | unavailable | 是，仅 confirmed | 不从名称推导 |
| 平台账号ID | `platform_account_id` | text | 否 | 平台/马帮 | trim | unavailable | 是，仅 confirmed | 加密/脱敏展示 |
| 店铺状态 | `shop_status` | enum | 否 | 权威店铺数据 | active/inactive/suspended | unavailable | 是，仅 active | 过期状态阻断 |
| 负责人ID | `owner_id` | text | 否 | 身份/组织系统 | 稳定主体 ID | unavailable | 否 | 不接受客户端自报 |
| 店铺层级 | `shop_tier` | text | 否 | 业务配置 | 受控枚举 | unavailable | 是，仅 confirmed | 版本化 |
| 主营类目范围 | `category_scope_version_id` | uuid | 否 | 人工/权威配置 | 版本引用 | unavailable | 是，仅 confirmed | 有效期必填 |
| 首次/最近观察 | `observed_at_json` | json | 是 | 订单/主数据 | UTC | inferred | 否 | 历史观察不等于在线 |
| 确认状态 | `semantic_status` | enum | 是 | 人工/来源规则 | 四态枚举 | confirmed | 否 | 只有 confirmed 进入 G3 |

## 18. 合同八：店铺商品覆盖快照

逻辑上分为快照头 `growth_shop_listing_snapshots` 与明细 `growth_shop_listing_snapshot_items`。

### 18.1 快照头

| 中文名称 | 英文字段名 | 类型 | 必填 | 来源/原值 | 标准化规则 | 语义状态 | 评分 | 数据质量规则 |
| --- | --- | --- | :---: | --- | --- | --- | :---: | --- |
| 快照ID | `id` | uuid | 是 | 系统 | UUID | confirmed | 否 | 唯一 |
| 店铺ID | `shop_id` | uuid | 是 | 店铺主数据 | 不变 | unconfirmed | 是，仅 confirmed | 店铺必须 confirmed |
| 来源类型 | `source_type` | enum | 是 | 马帮/平台导出/人工/API | 受控枚举 | confirmed | 否 | 历史订单类型不能标 current_online |
| 来源文件ID | `source_file_id` | uuid | 否 | 文件服务 | 不变 | confirmed | 否 | 导入型来源必填 |
| 捕获时间 | `captured_at` | timestamp | 是 | 来源 | 转 UTC | unconfirmed | 是，仅 confirmed | 不得晚于导入时间 |
| 有效至 | `valid_until` | timestamp | 是 | 覆盖 SLA | 版本化 | unconfirmed | 是 | 过期整体停止诊断 |
| 来源总数 | `reported_item_count` | integer | 否 | 来源 | 非负 | unconfirmed | 否 | 与明细对账 |
| 审核状态 | `review_status` | enum | 是 | 系统/人工 | pending/approved/rejected | confirmed | 否 | approved 才可用 |

### 18.2 覆盖明细

| 中文名称 | 英文字段名 | 类型 | 必填 | 来源/原值 | 标准化规则 | 语义状态 | 评分 | 数据质量规则 |
| --- | --- | --- | :---: | --- | --- | --- | :---: | --- |
| 明细ID | `id` | uuid | 是 | 系统 | UUID | confirmed | 否 | 唯一 |
| 快照ID | `snapshot_id` | uuid | 是 | 快照头 | 不变 | confirmed | 否 | 外键存在 |
| 平台商品ID | `platform_product_id` | text | 是 | 平台/马帮 | trim；原值保留 | unavailable | 否 | 快照内唯一组合 |
| 平台Listing ID | `platform_listing_id` | text | 否 | 平台 | trim | unavailable | 否 | 多变体关系需明确 |
| 平台SKU | `platform_sku` | text | 是 | 来源 | 原值保留 | unavailable | 否 | 映射冲突阻断 |
| 来源SKU | `source_sku` | text | 是 | 来源 | trim | unavailable | 否 | 原值非空 |
| 产品SKU ID | `product_sku_id` | uuid | 否 | confirmed SKU 映射 | 不变 | unavailable | 是，仅 confirmed | 未映射不判覆盖 |
| 在线状态 | `online_status` | enum | 是 | 权威来源 | online/offline/suspended | unavailable | 是，仅 confirmed | 未知值隔离 |
| 语义类型 | `coverage_semantic` | enum | 是 | 来源类型 | current_online/historical_observed/unknown | confirmed（合同） | 是，仅 current_online | 历史订单不得升级 |
| 来源更新时间 | `source_updated_at` | timestamp | 是 | 平台/马帮 | 转 UTC | unavailable | 是 | 超过 TTL 失效 |

## 19. 合同九：SKU 身份映射 `product_identity_mappings`

| 中文名称 | 英文字段名 | 类型 | 必填 | 来源/原值 | 标准化规则 | 语义状态 | 评分 | 数据质量规则 |
| --- | --- | --- | :---: | --- | --- | --- | :---: | --- |
| 映射ID | `id` | uuid | 是 | 系统 | UUID | confirmed | 否 | 唯一 |
| 来源系统 | `source_system` | text | 是 | 订单/库存/平台 | 枚举 | confirmed | 否 | 非空 |
| 来源国家原值 | `source_country_raw` | text | 否 | 来源 | 原值保留 | unavailable（订单） | 否 | 缺失时不能跨国自动确认 |
| 来源SKU原值 | `source_sku_raw` | text | 是 | 来源 SKU | 原值保留 | confirmed | 否 | 非空 |
| 来源平台SKU | `source_platform_sku_raw` | text | 否 | 平台 SKU | 原值保留，不截断 | unconfirmed | 否 | 规范规则版本化 |
| 目标产品SKU | `product_sku_id` | uuid | 否 | 产品中心 | 不变 | unconfirmed | 是，仅 confirmed | 目标存在且未删除 |
| 匹配方法 | `match_method` | enum | 是 | 系统/人工 | exact/manual/suggested | confirmed | 否 | 模糊/模型只能 suggested |
| 映射状态 | `status` | enum | 是 | 系统/人工 | suggested/confirmed/rejected/superseded | confirmed | 是，仅 confirmed | 同有效期一个 confirmed 目标 |
| 证据 | `evidence_json` | json | 是 | 来源批次/字段 | 受控 ID 与摘要 | confirmed | 否 | 禁止 PII/完整行 |
| 有效期 | `valid_from`/`valid_to` | timestamp | 是/否 | 系统/人工 | UTC | confirmed | 否 | 有效期不重叠 |
| 确认人/时间 | `confirmed_by`/`confirmed_at` | text/timestamp | 否 | 可信身份 | 稳定主体 ID/UTC | unavailable（当前身份） | 否 | 客户端自报无效 |

## 20. 合同十：类目映射 `growth_category_mappings`

| 中文名称 | 英文字段名 | 类型 | 必填 | 来源/原值 | 标准化规则 | 语义状态 | 评分 | 数据质量规则 |
| --- | --- | --- | :---: | --- | --- | --- | :---: | --- |
| 映射ID | `id` | uuid | 是 | 系统 | UUID | confirmed | 否 | 唯一 |
| 来源系统/路径 | `source_system`/`source_path_raw` | text/json | 是 | 马帮/产品/平台 | 原路径保留 | unconfirmed | 否 | 层级不可丢失 |
| 目标分类ID | `target_category_id` | uuid | 否 | 产品中心/平台分类 | 不变 | unconfirmed | 是，仅 confirmed | 目标存在 |
| 映射方向 | `mapping_direction` | enum | 是 | 合同 | source_to_product/product_to_platform | confirmed | 否 | 方向明确 |
| 适配状态 | `fit_status` | enum | 是 | 人工/规则 | allowed/blocked/unknown | unconfirmed | 是，仅 confirmed | unknown 不推荐 |
| 状态/证据 | `status`/`evidence_json` | enum/json | 是 | 人工/来源 | 四态+受控证据 | unconfirmed | 是，仅 confirmed | 冲突阻断 |
| 版本/有效期 | `version`/`valid_from`/`valid_to` | text/timestamp | 是 | 系统 | 不变 | confirmed | 否 | 激活版本不可原改 |

## 21. 合同十一：国家映射 `growth_country_mappings`

| 中文名称 | 英文字段名 | 类型 | 必填 | 来源/原值 | 标准化规则 | 语义状态 | 评分 | 数据质量规则 |
| --- | --- | --- | :---: | --- | --- | --- | :---: | --- |
| 映射ID | `id` | uuid | 是 | 系统 | UUID | confirmed | 否 | 唯一 |
| 来源系统/国家原值 | `source_system`/`source_country_raw` | text | 是 | 产品/平台/店铺 | 原值保留 | unavailable（订单） | 否 | 非空后再映射 |
| 来源站点 | `source_site_raw` | text | 否 | 平台 | 原值保留 | unavailable | 否 | 不从店名猜测 |
| 目标国家代码 | `country_code` | text | 否 | 主数据 | ISO/业务标准代码 | unconfirmed | 是，仅 confirmed | 代码唯一有效 |
| 时区 | `business_timezone` | text | 否 | 国家/业务配置 | IANA | unconfirmed | 是，仅 confirmed | 日界线计算必填 |
| 状态/证据 | `status`/`evidence_json` | enum/json | 是 | 人工/来源 | 四态+受控证据 | unconfirmed | 是，仅 confirmed | 一个来源有效期一个目标 |

## 22. 合同十二：平台映射 `growth_platform_mappings`

| 中文名称 | 英文字段名 | 类型 | 必填 | 来源/原值 | 标准化规则 | 语义状态 | 评分 | 数据质量规则 |
| --- | --- | --- | :---: | --- | --- | --- | :---: | --- |
| 映射ID | `id` | uuid | 是 | 系统 | UUID | confirmed | 否 | 唯一 |
| 来源平台原值 | `source_platform_raw` | text | 是 | 订单/库存/覆盖 | 原值保留 | confirmed（订单样例） | 否 | trim 后非空 |
| 标准平台代码 | `platform_code` | text | 否 | 平台主数据 | 受控代码 | unconfirmed | 是，仅 confirmed | 唯一 |
| 平台范围说明 | `scope_definition` | json | 否 | 业务/来源 | 国家/站点/店铺边界 | unavailable | 是，仅 confirmed | 不把平台等同公司全量 |
| 状态/证据 | `status`/`evidence_json` | enum/json | 是 | 人工/规则 | 四态+受控证据 | unconfirmed | 是，仅 confirmed | 别名冲突阻断 |

## 23. 合同十三：数据质量问题 `growth_data_quality_issues`

| 中文名称 | 英文字段名 | 类型 | 必填 | 来源/原值 | 标准化规则 | 语义状态 | 评分 | 数据质量规则 |
| --- | --- | --- | :---: | --- | --- | --- | :---: | --- |
| 问题ID | `id` | uuid | 是 | 系统 | UUID | confirmed | 否 | 唯一 |
| 问题代码 | `issue_code` | text | 是 | 质量规则 | 稳定代码 | confirmed | 否 | 禁止自由变化 |
| 严重级别 | `severity` | enum | 是 | 质量规则 | blocker/warning/info | confirmed | 否 | blocker 阻止发布/评分 |
| 数据域 | `data_domain` | enum | 是 | 系统 | order/inventory/shop/coverage/mapping | confirmed | 否 | 非空 |
| 影响实体 | `entity_type`/`entity_id` | text/uuid | 否 | 标准事实 | 内部 ID | confirmed | 否 | 不保存 PII |
| 来源批次/行 | `source_batch_id`/`source_row_id` | uuid | 否 | 血缘 | 不变 | confirmed | 否 | 可回溯 |
| 原始值摘要 | `value_summary_json` | json | 否 | 原值 | 类型、范围、哈希；不存敏感明文 | confirmed | 否 | 白名单 |
| 状态 | `status` | enum | 是 | 系统/人工 | open/acknowledged/resolved/waived | confirmed | 否 | 状态机校验 |
| 首次/最近出现 | `first_seen_at`/`last_seen_at` | timestamp | 是 | 系统 | UTC | confirmed | 否 | 最近不早于首次 |
| 解决证据 | `resolution_json` | json | 否 | 人工/系统 | 原因码、映射/版本引用 | confirmed | 否 | waived 必须有授权人 |

## 24. 合同十四：数据来源字段目录 `growth_source_field_catalog`

| 中文名称 | 英文字段名 | 类型 | 必填 | 来源/原值 | 标准化规则 | 语义状态 | 评分 | 数据质量规则 |
| --- | --- | --- | :---: | --- | --- | --- | :---: | --- |
| 字段目录ID | `id` | uuid | 是 | 系统 | UUID | confirmed | 否 | 唯一 |
| 来源类型/模板版本 | `source_type`/`template_version` | text | 是 | 解析器/马帮 | 原值 | confirmed | 否 | 同版本字段冻结 |
| 来源字段名 | `source_field_name` | text | 是 | Excel 表头 | 原值保留 | confirmed | 否 | 大小写/空白指纹另存 |
| 英文字段代码 | `canonical_field_code` | text | 是 | 数据合同 | snake_case | confirmed | 否 | 唯一稳定 |
| 来源数据类型 | `observed_types_json` | json | 是 | 样例分布 | 类型计数 | unconfirmed（库存） | 否 | 新类型产生问题 |
| 业务语义说明 | `semantic_definition` | text | 是 | 官方/业务 | 版本化文本 | unconfirmed | 否 | 来源链接/确认人必填 |
| 粒度 | `grain` | enum | 是 | 样例/说明 | order/order_item/sku/sku_warehouse | unconfirmed | 是，仅 confirmed | 粒度不明禁止聚合 |
| 单位/币种 | `unit_code` | text | 否 | 来源/业务 | 受控单位 | unconfirmed | 是，仅 confirmed | 数值字段需要 |
| 语义状态 | `semantic_status` | enum | 是 | 审核 | 四态 | confirmed（合同） | 否 | 只有 confirmed 可启用评分 |
| 证据 | `evidence_refs_json` | json | 是 | 文件/代码/官方文档 | 只存 ID/URL/摘要 | confirmed | 否 | 禁止真实明细 |
| 是否保留原值 | `retain_raw_value` | boolean | 是 | 合同 | true/false | confirmed | 否 | PII 字段必须 false |
| 可评分标记 | `score_eligible` | boolean | 是 | 状态派生 | 仅 confirmed 为 true | confirmed | 否 | 与语义状态一致 |

## 25. 合同十五：来源追溯关系 `growth_lineage_edges`

| 中文名称 | 英文字段名 | 类型 | 必填 | 来源/原值 | 标准化规则 | 语义状态 | 评分 | 数据质量规则 |
| --- | --- | --- | :---: | --- | --- | --- | :---: | --- |
| 血缘边ID | `id` | uuid | 是 | 系统 | UUID | confirmed | 否 | 唯一 |
| 上游类型/ID | `upstream_type`/`upstream_id` | text/uuid | 是 | 文件、批次、原始行、映射 | 受控类型 | confirmed | 否 | 上游存在 |
| 下游类型/ID | `downstream_type`/`downstream_id` | text/uuid | 是 | 事实、快照、质量问题 | 受控类型 | confirmed | 否 | 下游存在 |
| 关系类型 | `edge_type` | enum | 是 | 系统 | parsed_from/normalized_from/mapped_by/aggregated_from/replaced_by | confirmed | 否 | 受控枚举 |
| 转换版本 | `transform_version` | text | 是 | 解析器/规则 | 不变 | confirmed | 否 | 非空 |
| 输入内容哈希 | `input_sha256` | text | 否 | 上游白名单内容 | 小写 hex | confirmed | 否 | 重放时复核 |
| 创建时间 | `created_at` | timestamp | 是 | 系统 | UTC | confirmed | 否 | 不可修改 |

血缘边只保存内部 ID和哈希，不复制原始 PII或整行数据。一个标准事实必须能追溯到来源批次和一组原始行；一个映射变化不能回写篡改旧事实的历史证据。

## 26. 真实数据脱敏规则

### 26.1 必须删除或不可逆处理

| 数据 | 处理规则 |
| --- | --- |
| 马帮账号、用户名 | 不进入增长原始行；任务/账号只用内部 ID或不可逆伪标识 |
| 密码、Cookie、Token、API Key | 禁止读取到分析输出，禁止进入文档、日志、数据库合同或 Git |
| 客户姓名、客户账号、平台用户 ID | 原始订单摄取时直接丢弃；如需去重只能使用受控 HMAC，不保留明文 |
| 手机号、电话 | 直接丢弃；不得只做部分遮罩后提交 Git |
| 地址、城市以下收件信息、邮编 | 直接丢弃；增长规则不需要 |
| 邮箱 | 直接丢弃 |
| 订单收件信息和自由文本备注 | 直接丢弃，避免备注中包含 PII |
| 文件绝对路径 | 文档/API 中使用文件 ID或相对逻辑路径；不暴露个人目录 |

### 26.2 可保留的分析字段

- 脱敏且稳定的店铺内部 ID；
- 标准平台、国家、SKU、类目；
- 数量、状态、库存、日销及必要业务金额；
- 付款/发货/作废/快照时间；
- 来源文件 ID、SHA-256 前缀或内部哈希证据；
- 任务/运行内部 ID和非敏感统计。

用于文档的样例只展示表头、类型、计数、范围、状态分布和质量结论，不展示真实订单号、账号、店铺名称、负责人、SKU 明细或逐单金额。真实 Excel 不复制到 `docs`，不加入 Git，也不重新保存。

## 27. 测试环境基线

### 27.1 环境版本

| 项目 | 当前值 |
| --- | --- |
| Node.js | 24.14.0 |
| npm | 11.9.0 |
| Python（马帮虚拟环境） | 3.11.9 |
| `pg` | 8.22.0，已由 `npm ci` 安装 |
| `openpyxl` | 3.1.5 |
| `pandas` | 3.0.3 |
| `requests` | 2.34.2 |

`node_modules` 与 `.venv-mabang` 均位于当前功能工作树且被 Git 忽略，没有修改永久工作树环境。

### 27.2 初始 5 项失败的准确原因

| 失败测试/文件 | 失败命令 | 缺失依赖/原因 | 分类 | 修复命令 | 是否影响主线 |
| --- | --- | --- | --- | --- | --- |
| `only the main origin is needed for an authenticated advertising module` | `npm test` 中 spawn Node 子服务 | `AD_SERVICE_DIR` 解析到不存在的外部广告项目目录；Windows 以 `spawn ... node.exe ENOENT` 报告无效 cwd | 环境失败 | 提供有效广告服务项目并在当前工作树忽略配置中设置 `AD_SERVICE_DIR` | 否，不修改主线 |
| `Python Excel policy preserves scalar types and escapes only dangerous strings` | `.venv-mabang/Scripts/python.exe -c ...` | `.venv-mabang` 不存在 | 环境失败 | 建立 Python 3.11 venv 并安装固定版本依赖 | 否 |
| `Mabang workbook keeps columns and scalar values while emitting no untrusted formulas` | `.venv-mabang/Scripts/python.exe scripts/mabang_worker.py ...` | 同上 | 环境失败 | 同上 | 否 |
| `lifecycle report workbook uses the same formula-injection protection` | `.venv-mabang/Scripts/python.exe scripts/mabang_worker.py ...` | 同上 | 环境失败 | 同上 | 否 |
| `tests/postgresql-provider.test.mjs` 模块加载 | `node --test tests/*.test.mjs` | `node_modules` 不存在，无法导入声明依赖 `pg` | 环境失败 | `npm ci` | 否 |

实际使用的依赖恢复命令：

```powershell
npm ci
python -m venv .venv-mabang
.\.venv-mabang\Scripts\python.exe -m pip install openpyxl==3.1.5 pandas==3.0.3 requests==2.34.2
npm test
```

版本与永久工作树现有马帮虚拟环境对齐，但没有复制或修改永久工作树环境。

### 27.3 修复后结果

- 测试总数：368；
- 通过：367；
- 失败：1；
- 失败仍是外部广告服务目录不存在；
- PostgreSQL provider 的 6 项测试全部通过；
- 3 项 Python/Excel 安全测试全部通过；
- 没有跳过、删除或修改测试，也没有修改业务逻辑。

测试总数从初始 363 增至 368，是因为安装 `pg` 后 `tests/postgresql-provider.test.mjs` 能正常加载并展开 6 个测试，而不是新增了测试代码。

### 27.4 额外构建检查

G0.5 执行 `npm run build` 时，`check:paths` 曾因 G0 文档含个人 Windows 绝对路径而失败。恢复 G1A 时已通过本次独立文档基线更新将实现路径替换为占位符，不修改路径扫描器或跳过检查；Build 仍须在 rebase 后重新执行。

## 28. G1 可以直接实施的内容

在同步主线和分配迁移编号后，以下内容不依赖 G2/G3 业务口径，可直接进入 G1：

1. 来源文件/任务/运行只读绑定和不可变来源批次。
2. 无 PII 的订单原始行白名单、解析器版本、行号和血缘。
3. 订单状态/金额/数量保留原值，使用 `unconfirmed` 阻止错误业务命名。
4. 订单批次内聚合、跨批次版本替换和数据质量框架；先以更多脱敏样例验证业务键。
5. 库存来源批次、原始字段容器、快照头和质量框架；未知字段保持 NULL/原值，不派生可售库存。
6. SKU/类目/国家/平台映射的 suggested/confirmed/rejected/superseded 状态机。
7. 店铺主数据和覆盖快照结构、临时人工覆盖导入合同。
8. 数据来源字段目录、语义状态、证据引用和血缘边。
9. 来源新鲜度元数据和“最后成功版本”机制，但 SLA 先标 unconfirmed。
10. 脱敏 fixture、幂等、重放、冲突和 SQLite/PostgreSQL 可移植性测试。

G1 可按订单事实、库存原始层、主数据/映射三条子轨并行实施，但库存生产验收必须等待真实库存样例。

## 29. G2 前必须确认

1. `source_predicted_daily_sales` 当前实例的配置权重、账号权限范围、粒度和更新时间。
2. 公司级销量的权威来源及其平台、国家、店铺、仓库覆盖范围。
3. AI 团队范围和公司值是否包含 AI 的同口径验证。
4. 可售库存最终公式、合格仓库、锁定/未发货/在途处理。
5. 有效订单、有效件数、有效金额及取消/退款处理。
6. 订单、库存、产品和覆盖数据的新鲜度 SLA。
7. 已验证商品的阈值、窗口、生命周期与排除集。

## 30. G3 前必须确认

1. 稳定店铺 ID/平台账号 ID及店铺合并拆分规则。
2. 店铺国家、平台、状态、负责人和主营/禁止类目。
3. 可持续刷新且有有效期的 `current_online` Listing 来源。
4. 平台商品/Listing/平台 SKU 到产品 SKU 的 confirmed 映射。
5. 覆盖快照异常下降、下线、暂停、变体合并的语义。

没有这些数据时，G3 必须保持暂停；`historical_observed` 不能替代 `current_online`。

## 31. 用户需要补充的文件或业务说明

按优先级：

1. 一份既有真实库存导出及其任务/运行/文件元数据，或 Git 外的只读脱敏库存 Excel。
2. 马帮账号在仓库、平台、店铺层面的权限截图/导出说明，确认是否公司全量。
3. 当前组织的预测日销量权重、客单量系数、销售系数和开售时间维护规则。
4. AI 团队权威店铺/SKU/国家/平台责任范围及生效日期。
5. “可用库存量”的业务定义，以及锁定、未发货、调拨、在途是否已经扣除。
6. 包含部分退款、全额退款、退款件数和金额的官方售后/退款导出样例。
7. 店铺主数据或平台店铺清单，包含稳定 ID、国家、平台、状态、负责人和主营类目。
8. 当前在线商品官方导出或人工确认覆盖表，符合第 8.3 节最小字段。
9. 对订单中 1 个数量不一致和 1 个订单总金额不一致样本的业务解释（可由授权人员在本地查看，不需提交明文）。
10. 外部广告服务项目的有效本地路径，仅用于恢复完整测试质量门。

## 32. G1 建议实施范围

建议 G1 只交付“可信事实底座”：

- 下一可用正式迁移中的来源批次、原始行、标准事实、映射、店铺/覆盖结构、质量和血缘表；
- 订单/库存文件的只读摄取与幂等重放；
- 无 PII 的解析和数据质量报告；
- 人工确认映射与覆盖导入的服务层合同；
- 最后成功版本和来源新鲜度状态；
- 脱敏 fixture、迁移、兼容性、幂等和安全测试。

真实库存样例缺失时，可先合并不依赖字段值的基础结构和订单路径；库存事实发布开关保持关闭，直到样例验收通过。

## 33. G1 明确禁止范围

- 不开发增长雷达页面或正式业务 API；
- 不创建评分、优先级、店铺推荐或行动清单；
- 不接入 DeepSeek/LLM 决策；
- 不自动发布 Listing 或修改产品中心/Listing 正式数据；
- 不把预测日销量命名为公司真实日销；
- 不计算“公司销量 − AI 销量”；
- 不把缺失/未知值当 0；
- 不把历史订单当 `current_online`；
- 不输出净销量/净销售额/退款指标；
- 不自动确认 SKU、国家、平台、店铺或类目映射；
- 不保存 PII、账号、Cookie、Token、密钥或真实 Excel 到 Git；
- 不在同步主线和协调编号前创建增长迁移；
- 不真实登录马帮或执行新的正式订单/库存采集，除非后续节点单独授权。

## 34. G0.5 结论与停止点

- 正式功能分支和 G0 文档提交已完成。
- 主线 Listing `011` 与 Listing AI `012` 已稳定提交；支线已同步 `4aca652`，增长 G1A 使用 `013_deterministic_growth_radar_foundation.sql`。
- 找到并验证了两份真实订单样例；订单行、状态、数量、字段缺口和跨批次变化已经形成数据合同约束。
- 没有找到真实库存模块样例；产品包辅助数据也没有预测日销量值。
- 预测日销量的公开算法已确认，但当前实例范围、粒度、配置和 AI 包含关系未确认，所以整体仍为 `source_predicted_daily_sales/unconfirmed`。
- 可售库存、退款净额、稳定店铺 ID和 `current_online` 均未确认，并已按 G1/G2/G3/售后分级。
- G0.5 历史验证为 367/368，剩余失败来自外部广告服务目录缺失；当前主线稳定基线已提升为 428/428，支线须在 G1A 编码前复验。
- 本节点没有修改业务代码、数据库或真实数据，没有执行真实采集，没有创建增长迁移，也没有进入 G1。

**停止点：** 完成本文件核验后暂停，等待确认，不进入 G1 编码。

## 35. 交付要求覆盖索引

| # | 要求 | 章节 |
| ---: | --- | --- |
| 1 | 当前分支和工作树状态 | 1 |
| 2 | G0 提交信息 | 1.1 |
| 3 | 所有工作树和迁移状态 | 1.2、3.1 |
| 4 | 迁移编号协调方案 | 3.2–3.3 |
| 5 | 订单真实字段审查 | 4 |
| 6 | 库存真实字段审查 | 5 |
| 7 | 预测日销量语义 | 6.1–6.2 |
| 8 | 公司日销口径 | 6 |
| 9 | AI 销量包含关系 | 6.3 |
| 10 | 库存口径候选方案 | 7 |
| 11 | 退款和取消订单语义 | 4.4、4.6、9.D |
| 12 | 店铺稳定身份来源 | 8.1、17 |
| 13 | 当前在线 Listing 来源 | 8.2–8.3、18 |
| 14 | SKU 映射状态 | 4.7、8.4、19 |
| 15 | G1 数据合同 | 10–25 |
| 16 | 字段语义状态 | 2、10–25 |
| 17 | 数据脱敏要求 | 26 |
| 18 | 阻断项分级 | 9 |
| 19 | G1 可以直接实施的内容 | 28 |
| 20 | G2 前必须确认的内容 | 29 |
| 21 | G3 前必须确认的内容 | 30 |
| 22 | 测试环境基线 | 27 |
| 23 | 用户需补充的文件或说明 | 31 |
| 24 | G1 建议实施范围 | 32 |
| 25 | G1 明确禁止范围 | 33 |
