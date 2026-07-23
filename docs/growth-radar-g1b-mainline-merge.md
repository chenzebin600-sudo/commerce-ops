# Growth Radar G1B 主线合并记录

## 1. 合并结论

- 合并状态：完成
- 合并前主线：`9d97066c13c20efbeb60e1e9894e0ada4d0a2897`
- A2 分支提交：`3ef9dd7379a525148205ec22253188a7f84caff9`
- 合并提交：`6c5fea7b1f4d14c76253f927ee49d598fe88355b`
- 合并方式：`--no-ff`
- 冲突文件：0
- 数据库迁移最高编号：014
- 迁移 015 / 016：未进入主线
- A2 代码合并完成条件：满足
- 生产启用：仍阻断
- A3：未开始
- 支线 B：未合并

## 2. 合并范围

本次合并保留了主线的产品中心、Listing、广告模块、正式 SQLite 基线和 SKU 软删除决策，同时引入 A2 的以下能力：

- Growth Radar 数据范围管理
- 店铺 `pending` / `confirmed` 状态管理
- 店铺确认、取消确认与服务端生成的 `confirmedBy`
- 订单和库存只读预览
- PII 过滤与 Excel 公式风险处理
- 重复行、无效状态、未匹配对象和多仓 SKU 识别
- 数据质量、数据语义和应用记录页面
- `current_online` 与 `company_sales` 无权威来源时的 `unavailable` 语义
- `source_predicted_daily_sales` 为来源预测、不是实际销量的语义
- Growth Radar 权限和操作审计
- A2/test profile 的 fail-closed 数据库与端口隔离
- 桌面端和 430px 窄屏布局
- 脱敏运行态截图及 G1B 设计、实施和验收文档

本次没有引入：

- A3 或 G2 机会判断
- LLM 评分或店铺 × SKU 推荐
- 正式生产数据导入
- 真实订单、库存或客户 PII
- 支线 B 的马帮 SKU 图片采集代码
- 迁移 015 或 016

## 3. 冲突处理

合并由 Git `ort` 策略直接完成，没有产生冲突，因此没有使用整文件 `ours`、`theirs` 或其他覆盖式处理。

主线在 A2 分叉后新增的以下决策材料均继续保留：

- `docs/mainline-sqlite-drift-audit-before-g1b-merge.md`
- `docs/product-sku-soft-delete-baseline-decision.md`

SKU `P2DD0020938` 的软删除状态继续作为正式基线。

## 4. 迁移和静态边界

- `migrations/` 仍只包含 001 至 014。
- A2 新增运行时代码没有 `ALTER TABLE`、`CREATE TABLE` 或 `DROP TABLE`。
- Git 中没有 SQLite、WAL、SHM、Excel、正式环境文件、Token、Cookie 或真实业务数据。
- 没有新增 A3、LLM 评分或推荐逻辑。
- `current_online` 和 `company_sales` 在无权威来源时返回空值及 `unavailable`，没有伪造成 0。

## 5. 测试和质量门

| 检查 | 结果 |
|---|---|
| A2 隔离专项 | 17 / 17 |
| G1B1 后端专项 | 46 / 46 |
| G1B2 前端专项 | 36 / 36 |
| Growth Radar 联跑 | 156 / 156 |
| 全量测试 | 605 / 605 |
| Build | 通过 |
| 路径检查 | 通过 |
| 页面唯一 ID | 422 个，全部唯一 |
| 静态事件绑定 | 185 个，全部有效 |
| 430px 布局 | 通过 G1B2 专项检查 |
| Doctor | 无 ERROR |

第一次全量测试中，广告集成测试在 Windows 并发运行时等待子进程退出超过 5 秒，结果为 604 / 605。该测试单独复跑通过，确认没有残留端口；第二次完整全量测试为 605 / 605。没有删除测试或降低断言。

## 6. 独立运行验收

运行验收使用 `test` profile 和系统临时目录中的独立数据库，不读取或修改正式 SQLite。

隔离验证：

1. 工作区内测试数据库路径被 fail-closed 门禁拒绝。
2. 改用 `%TEMP%\commerce-ops-g1b-mainline-merge` 后正常启动。
3. 独立数据库成功应用 001 至 014，完整性为 `ok`，外键异常为 0。
4. 主服务健康检查返回 `ok`。
5. Growth Radar 15 张表在独立数据库中均为空。
6. 验收结束后，主服务和广告子服务均已停止。

页面和模块验收：

- Growth Radar 页面正常打开，显示 8 个 G1B 工作区。
- 页面明确标识“测试/验收数据”，没有伪装成生产结果。
- Growth Radar 空状态正常。
- `current_online` 和 `company_sales` 显示“不可用”，不是 0。
- 产品中心正常打开并显示空数据状态。
- Listing 六步工作台壳、保存草稿、平台预览和发布检查入口均存在。
- Lazada 广告入口和同源 iframe 正常加载。
- 浏览器控制台没有错误或警告。

真实马帮订单和库存样本未执行，生产启用仍保持阻断。

## 7. 正式 SQLite 保护结果

正式数据库只进行了只读复核，没有执行 checkpoint、VACUUM、迁移或 fixture 写入。

| 项目 | 结果 |
|---|---|
| 主文件大小 | 260,849,664 bytes |
| 主文件 SHA-256 | `b606814fff95362d8acaacf7779b54048402b452feff54e066f3b960c693c09e` |
| WAL 大小 | 4,120,032 bytes |
| WAL SHA-256 | `c914ff5c6fb3c851c3b5c202afa7d80e6415ebdd1bbf2f9052b9545dc9621621` |
| `integrity_check` | `ok` |
| `foreign_key_check` | 0 |
| 最高迁移 | 014 |
| 15 张 Growth Radar 表 | 全部 0 |
| `product_package_rows` | 21,714 |
| `product_skus` | 18,347 |
| `product_images` | 1 |
| Listing 草稿 / 发布 | 0 / 0 |
| SKU `P2DD0020938` | 保持软删除，revision 3 |

正式主文件和 WAL 的大小、修改时间与 SHA-256 均与合并前基线一致。SHM 的修改时间可由只读连接更新，不代表业务写入。

## 8. Stash 保护

以下三个 stash 对象和保护引用均继续存在，未 apply、pop 或 drop：

- `df08119e338018d32d7dd133d21a50b0ca14cce5`
- `84441ced533ad105bdc7881191797209acfa919e`
- `8238953c06cd057385629025abde25713a93d716`

保护引用：

- `refs/archive/a2/g1b-interrupted-latest`
- `refs/archive/a2/g1b-partial-middle`
- `refs/archive/a2/g1b-partial-oldest`

这些对象留待 A2 正式归档节点处理。

## 9. 后续边界

### 支线 B

支线 B 必须在独立节点中：

1. 先基于当前最新 `master` 重新同步或 rebase。
2. 继续保留马帮 SKU 图片采集的业务边界。
3. 单独审查迁移 015 及与 G1B 文件的冲突。
4. 重新运行专项、全量、Build、Doctor 和正式库保护检查。
5. 未经确认不得向正式数据库应用迁移 015。

### A3

A3 尚未开始。本次合并不授权机会识别、评分、推荐或生产数据导入。

## 10. 最终判断

A2-G1B 的代码、页面、权限、审计、隔离门禁、测试和文档已经满足合并进入主线的条件。正式业务数据保持不变，生产启用仍阻断，下一节点不得把“代码已合并”解释为“生产已启用”。
