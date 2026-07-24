# 支线 B：马帮 SKU 图片采集真实会话验收

> 验收日期：2026-07-22
>
> 分支：`codex/mabang-sku-image-collector`
>
> 永久工作树：主项目同级目录 `commerce-ops-mabang-sku-images`
>
> 范围：真实已登录会话、小范围试跑、隔离数据库；未执行首次全量，未迁移正式库，未合并主线，未创建 016。

## 1. Git 与迁移基线

| 项目 | 结果 |
| --- | --- |
| rebase 前支线 HEAD | `21cfb4bb8f43b15b3baa9488f0af86ffb3717fa6` |
| 支线旧基准 | `6faa0789f15c27c57abd2071ca41971856845af8` |
| 最新主线基准 | `e2fef3c46d286a87a422ca733737dae28d15a835` |
| rebase 后功能提交 | `bd8327ac25c1ccacffea8f991de7de72b5a3555a` |
| rebase 后文档提交 | `33078f1c907f7e4d9df0ea8e47bf282317351ad9` |
| 冲突 | 有；在获得人工逐文件解决授权后处理 7 个敏感文件，没有使用整文件 `ours`/`theirs` |
| 迁移归属 | 013/014 为增长雷达；015 仅为马帮 SKU 图片采集；016 预留且不存在 |

`015_mabang_sku_image_collector.sql` 只创建：

- `mabang_sku_image_batches`
- `mabang_sku_image_checkpoints`
- `mabang_sku_image_discoveries`
- `product_media_assets`
- `product_media_links`

015 不包含 `style_groups`、`style_group_products`、`product_listing_draft_items`、多 SKU Listing 或增长雷达结构。

## 2. CDP 与页面复核

- `127.0.0.1:9222/json/version` 可连接。
- 可见 3 个 `type=page` target：两个马帮库存查询页和一个非马帮普通页面。
- 两个马帮页面均为 `readyState=complete`、标题“马帮ERP::库存查询”、路径 `/index.php?mod=warehouse.inventorydetail`，未发现可见密码输入框。
- 两页的库存 frame 均能读取 50 行库存记录和可见 SKU。
- 最终只控制 target `C626DC578A5F5CEA77902BF98B9F846B`；另一库存 target `488FF308BE50CB446729941E6541A362` 保持不动。
- 实际库存表位于子 frame；行结构为 `ul.list-body > li`，表头为 `ul.list-title`。SKU 从当前行 `.shopStock` 读取，未从图片文件名反推。

完整企业子域、账号、Cookie、Token、密码、授权头和请求值没有进入本文、应用日志或 Git。

## 3. 真实接口结构

| 字段 | 脱敏结果 |
| --- | --- |
| URL | `POST https://<enterprise>.private.mabangerp.com/index.php?mod=<inventory-module>` |
| 类型 | XHR，同源，需要当前 Browser Context 身份 |
| 请求方法 | `POST` |
| 页码参数 | `page` |
| 每页数量参数 | `rowsPerPage` |
| 页面支持数量 | 50、100、200、500；试跑采用 500 |
| 总数量 | 页面语义元数据为 1,440 行 |
| 响应结构 | JSON 包装；库存行位于 HTML 字符串字段，另有成功标记与分页 HTML 字段 |
| SKU | 同一 HTML 行的 `.shopStock` |
| 图片 | 同一 HTML 行的 `<img>` 实际属性 |
| 仓库 | 同一行仓库语义节点 `.warehouseIds`/动态表头 |
| 商品名称 | SKU 单元格中的名称语义节点 `p.ellipsis` |
| GraphQL | 未发现 |
| 初始化 JSON | 已监听，但未成为采集来源 |
| COS 请求 | 观察到真实 `stock-cos.mabangerp.com` 图片请求，未按 SKU 构造 URL |

实际采集方式为 `xhr_html`：优先复用已登录页面捕获的库存 XHR，在当前页面执行上下文分页请求，并用页面 `DOMParser` 解析响应中的 HTML 行。DOM 表格和实际 COS 请求仅作为后备来源。

图片下载使用当前 CDP Browser Context 的 `Network.loadNetworkResource` 与 `IO.read`，启用当前身份上下文；没有建立 Python `requests.Session` 或未认证 Node 下载会话。

## 4. 最多 10 页试跑结果

本次启动的是 `missing_only`，不是 `full_initial`。页面默认 50 行时总计 29 页；把每页数量设置为页面实际支持的最大值 500 后，有效分页为 3 页，因此试跑在 3 页自然结束，没有扩大到全量模式。

| 页 | 行数 | 唯一 SKU | 结果 |
| ---: | ---: | ---: | --- |
| 1 | 500 | 450 | 成功写入检查点后暂停 |
| 2 | 500 | 421 | 服务重启后从此页继续 |
| 3 | 440 | 353 | `currentPage=totalPages`，正常停止 |

聚合结果：

- 库存行：1,440。
- 唯一 SKU：953。
- 有图片 SKU：953；无图片 SKU：0。
- 文件名 SKU 不一致：25 行，均保留行 SKU 为主身份并记录 `IMAGE_FILENAME_SKU_MISMATCH`。
- 多仓 SKU：279。
- 产品中心匹配 SKU：850；未匹配 SKU：103。
- 最终有效共享素材：716 个，716 个不同 SHA-256，物理文件共 55,157,677 字节。
- 新保存素材：716；重复 SHA 结果：410；最终未解决失败：0。
- 最终产品素材关联：1,229 个产品记录、716 个素材；282 个素材被多个国家共享，单素材最多 5 个国家。
- 403 / 404 / 429 / 超时 / 非图片 / 损坏图片：均为 0。

原始试跑批次保留不可篡改的历史状态：527 次新下载、169 次重复、430 次失败。失败不是马帮限流或鉴权错误，而是旧的页面 `fetch` 受到 COS CORS 限制。修复为 Browser Context 网络资源通道后，第一次 `retry_failed` 恢复 429 条（189 次新保存、240 次 SHA 重用），仅剩 1 条临时文件落盘竞争错误；第二次 `retry_failed` 将该条作为重复素材成功恢复。最终失败链为 0。

并发 SHA 竞争审计还发现 7 条“数据库素材存在但物理文件缺失”。增加按 SHA 的进程内串行化和现存文件大小/哈希复核后，使用同一真实会话内容修复；最终 716/716 个素材文件存在，大小和 SHA-256 全部吻合。并发限制保持为 3。

## 5. SKU 与图片人工抽样

从真实结果抽取 20 条并直接查看图片内容，不用文件名判断正确性：

| 抽样类别 | 数量 | 结果 |
| --- | ---: | --- |
| 文件名 SKU 与行 SKU 不一致 | 5 | 5/5 图片内容、行商品名、产品中心来源名一致；没有覆盖行 SKU |
| 多国家相同 SKU | 5 | 5/5 匹配，并建立多个国家的建议关联 |
| 多仓 SKU | 4 | 4/4 行 SKU、仓库记录和图片映射一致 |
| 重复 SHA 图片 | 3 | 3/3 正确复用同一素材 |
| 单国家 SKU | 3 | 3/3 产品匹配正确 |

20/20 的页面行 SKU、数据库 `source_sku`、原始图片 URL、图片实际内容、产品中心来源名称与国家关联一致；图片均为有效 JPEG，宽高可读。

真实 953 个 SKU 全部有图，所以无法从本次真实数据中抽到“无图片 SKU”。正式产品中心虽有 1 张既存人工主图，但该产品不在本次已关联 SKU 中，因此没有人为造数来模拟“同一 SKU 已有人工主图”。这两类由自动化测试覆盖，不能用样例数据冒充真实抽检。

## 6. 暂停、重启、恢复与分页保护

1. 在第 1 页运行期间请求暂停。
2. 当前页完整落库并保存第 1 页检查点后，批次进入 `paused`。
3. 停止隔离验收服务并重新启动。
4. 批次仍为 `paused`；人工继续后从第 2 页开始。
5. 再次并发点击继续返回 HTTP 409 / `MABANG_IMAGE_BATCH_NOT_RESUMABLE`。
6. 第 1 页没有重新采集，已完成图片没有重复下载，第 2、3 页无遗漏，最终统计保持一致。

真实页按 3/3 停止；没有出现重复页面，因此没有伪造重复页。连续 page hash 相同的保护由专项自动化测试实际触发并通过，安全最大页数也保留为配置上限。

## 7. 人工主图与 Listing 保护

- 1,229 个新关联全部为 `mapping_status=suggested`。
- 1,229 个关联中没有 `confirmed` 或 `media_role=primary`；建议主图为 `suggested_primary`。
- 正式主图覆盖数量：0。
- 现有 `product_images` 行数和全行 SHA-256 在试跑前后一致。
- 没有写入 Listing draft 的当前采用素材；没有修改产品包事实表。

真实试跑没有调用“确认设为产品主图”。人工主图冲突保护和“未确认不进入当前上架素材”分别由专项测试覆盖。

## 8. 数据库隔离与迁移链

### 001 → 015 全新临时库

- `schema_migrations` 15 条，版本唯一，最新为 015。
- 重复启动仍为 15 条，013/014/015 各执行一次。
- `integrity_check=ok`；`foreign_key_check=0`。
- 015 的 5 张表全部为空。

### 014 → 015 正式库在线备份副本

- 通过 Node SQLite 官方在线 backup API 创建一致性副本，只在副本执行迁移。
- 只新增 015；重复启动不重复迁移。
- 产品 18,347、`product_package_rows` 21,714、既存 `product_images` 1、Listing 与全部增长雷达表的行数和全行 SHA-256 迁移前后一致。
- `integrity_check=ok`；`foreign_key_check=0`；015 的 5 张表初始为空。

### 正式数据库前后检查

- 正式库始终停留在 014；不存在任何 015 采集表或试跑批次。
- 正式主数据库文件前后均为 260,849,664 字节，修改时间均为 `2026-07-22T01:34:04.498Z`。
- `product_skus`、`product_package_rows`、`product_images`、Listing 和全部增长雷达表的试跑前后行数/全行 SHA-256 相同。
- 正式库只读快照 `integrity_check=ok`，`foreign_key_check=0`。
- 正式服务在验收期间仍有自身后台活动，WAL 从试跑前的 3,304,272 字节增长到 3,975,832 字节；因此不能把整个活动数据库文件组宣称为逐字节静止。没有任何验收进程连接正式库进行写入，且所有本功能业务表与事实表均保持不变。

## 9. 质量门

| 检查 | 结果 |
| --- | --- |
| SKU 图片专项测试 | 32/32 通过 |
| 最新主线测试 | 包含在全量中，主线基线 506 项未缺失 |
| 全量测试 | 538/538 通过（506 主线 + 32 支线 B） |
| Build | 通过；路径检查通过；449 个唯一元素 ID、210 个静态绑定 |
| Doctor | 全部 OK；使用隔离数据库和临时端口 |
| 服务健康 | `GET /api/health` 返回 HTTP 200、`{"ok":true}` |
| SQLite | 001→015 与 014→015 均 `integrity_check=ok`、`foreign_key_check=0` |

全量测试第一次运行时，广告集成测试因永久工作树旁缺少默认外部广告服务目录而出现一次环境性 `spawn ... ENOENT`；使用本机已存在的广告子项目作为临时 `AD_SERVICE_DIR` 后，单项与 538 项全量均通过。没有修改或提交 `.env` 和机器绝对路径。

## 10. 安全与清理

- 没有记录账号、密码、Cookie、Token 或完整授权头。
- 接口档案只保存方法、脱敏 URL 结构、参数名和字段路径。
- 没有把图片二进制写入 SQLite。
- 没有把真实 SKU、商品名称、源 URL 或真实商品图片写入截图。
- Git 中只保留两张脱敏管理页截图；真实下载图片和验收数据库位于系统临时目录，并在完成证据核对后删除。
- 未创建每日任务，未执行首次全量采集，未迁移正式数据库，未合并主线，未创建 016。

## 11. 截图

- [桌面端脱敏截图](screenshots/mabang-sku-image-real-session-desktop.png)
- [移动端脱敏截图](screenshots/mabang-sku-image-real-session-mobile.png)

截图只显示批次统计和管理功能；账号、batch ID、SKU、商品名、源 URL 与图片已替换或隐藏。

## 12. 结论与后续门槛

真实接口识别、3 页受控试跑、行 SKU 身份、图片内容抽样、Browser Context 下载、SHA 去重、失败重试、暂停/重启/恢复、分页自然停止和人工主图保护均通过。发现的两个真实缺陷——COS CORS 下载失败与并发 SHA 文件竞争——已经修复并由新增专项测试覆盖。

当前具备提交人工合并验收的技术条件，但本分支未自行合并。首次全量采集仍不允许自动开始：尚未获得用户明确确认，正式库也尚未按“持久备份并记录 SHA-256 → 单独确认 014→015 迁移 → 用户发起采集”流程启用。活动正式库 WAL 不是逐字节静止这一事实也需在验收时知悉。
