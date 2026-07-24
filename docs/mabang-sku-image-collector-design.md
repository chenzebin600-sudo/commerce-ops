# 支线 B：马帮 SKU 图片采集与产品中心素材同步设计审计

> 状态：设计审计、实现、最新主线同步与真实登录会话小范围验收完成（2026-07-22）
> 分支：`codex/mabang-sku-image-collector`
> 永久工作树：主项目同级目录 `commerce-ops-mabang-sku-images`
> 基线：`master@e2fef3c46d286a87a422ca733737dae28d15a835`（含迁移 013、014）
> 隔离约束：不修改增长雷达、Listing 或 `product_package_rows`，不创建迁移 016。

## 1. 结论

本功能应作为独立的、按需启动的长任务实现，复用现有持久 Chrome 用户目录与原生 CDP 会话，不复用当前库存 Python 采集器的网络实现。现有库存/订单 Python 代码通过独立 `requests.Session` 登录，并含历史企业子域常量，不满足“复用浏览器会话、不得硬编码企业 ID”的约束。

产品中心现有 `product_images` 是按国家产品记录持有图片，首张上传图片会自动成为主图，且 `relative_path` 唯一；它不能表达“一份图片资源关联多个国家相同 SKU”“建议主图”“马帮来源”三个要求。设计新增共享素材表和 SKU/产品关联表，保留现有人工上传表，不改产品包事实表，也不把二进制写入 SQLite。

采集链路固定为：

1. 在当前已登录 Chrome 页面中监听库存查询的 Fetch/XHR/GraphQL/初始化 JSON。
2. 若响应含 SKU 与图片字段，在同一页面执行上下文内使用 `fetch(..., credentials: "include")` 分页请求；图片二进制通过当前 CDP Browser Context 的 `Network.loadNetworkResource` 读取。Cookie/Token 仅由浏览器携带，不导出到应用日志或数据库。
3. 若接口没有图片字段，进入库存表格所在 frame，等待加载、定位真实滚动容器、滚动触发懒加载，再逐行提取。
4. 最后仅把 `stock-cos.mabangerp.com` 的真实图片响应与同一行 SKU 交叉关联；绝不根据 SKU 构造 URL。

## 2. 审计范围与证据

### 2.1 马帮登录、订单与库存采集

| 模块 | 当前实现 | 结论 |
| --- | --- | --- |
| 手工采集入口 | `server.mjs` 的 `/api/mabang-data/login-test`、`/collect`、`/result`、`/export` | 手工结果只在内存保留 30 分钟，不适合长任务断点恢复 |
| 账号管理 | `mabang_account_profiles` + AES-256-GCM 加密密码 | 复用账号 ID 作为任务身份与审计维度；不得输出明文用户名/密码 |
| 订单采集 | `scripts/mabang_order_source.py` | 使用独立 `requests.Session`；不可作为本功能会话层 |
| 库存采集 | `scripts/mabang_inventory_source.py` | 通过官方库存 Excel 导出获取数据；存在历史企业子域和固定接口常量，不用于图片采集 |
| Worker | `scripts/mabang_worker.py`、`lib/mabang-worker-runner.mjs` | 子进程标准输入传凭证，输出 JSON；适合现有 Excel 流程，不适合复用浏览器 Cookie |

历史库存代码提供了“库存查询可能位于 iframe、查询与分页信息可能由不同接口返回”的线索，但其中 URL、字段名、分页大小均视为未验证历史信息，不作为新实现硬编码依据。

### 2.2 浏览器会话与 CDP

`server.mjs` 已实现：

- 通过 `CHROME_DEBUG_PORT` 连接本机 CDP；
- 使用 `CHROME_PROFILE_ROOT` 下的持久用户目录启动 Chrome；
- 发现页面 target、连接 WebSocket CDP、订阅事件；
- 导航前执行域名、DNS、重定向和私网地址校验；
- `mabangerp.com` 已在 Chrome 导航允许域中。

初次只读审计时没有可用登录页面，因此没有用历史常量冒充真实接口。后续真实会话验收已连接 `127.0.0.1:9222`，发现两个已登录且表格可读的库存查询 page target，并只选择其中一个执行采集，未同时控制两个页面。

真实接口是同源 `POST /index.php?mod=<脱敏库存模块>` XHR。请求体动态识别出 `page` 与 `rowsPerPage`；响应为 JSON 包装，其中库存行位于一个 HTML 字符串字段。行内 `.shopStock` 是 SKU 主身份，图片来自同一行 `<img>`，仓库和商品名称从同一行语义节点读取。页面显示总计 1,440 行，默认 50 行/页，支持的最大页大小为 500；没有发现 GraphQL。完整企业子域、请求值、Cookie、Token、授权头和响应正文均未持久化。

首次连接成功后只持久化以下脱敏接口画像：

```json
{
  "transport": "xhr|fetch|graphql|initial_json",
  "url": "https://redacted.mabangerp.com/index.php?mod=<redacted>",
  "method": "POST",
  "parameter_keys": ["<page-key>", "<page-size-key>"],
  "page_parameter": "<detected>",
  "page_size_parameter": "<detected>",
  "total_path": "<detected-json-path>",
  "rows_path": "<detected-json-path>",
  "sku_path": "<detected-json-path>",
  "image_path": "<detected-json-path|null>",
  "warehouse_path": "<detected-json-path|null>",
  "product_name_path": "<detected-json-path|null>"
}
```

不持久化请求头、Cookie、Authorization、CSRF Token、密码、完整响应体或完整企业子域。

### 2.3 任务调度与运行事件

现有 `scheduled_export_tasks` / `scheduled_export_runs` / `scheduled_export_run_events` 面向定时 Excel 导出：任务必须带 schedule，运行阶段和计数也以订单/Excel 为中心。图片采集不要求每日运行，不应伪装成定时导出任务。

本功能采用独立 batch + checkpoint 模型，但复用以下模式：

- 每阶段事件；
- 可重试错误码；
- stale run 恢复思想；
- HTTP 操作审计；
- 服务重启后从数据库检查点恢复。

不创建默认 cron、每日任务或 `scheduled_export_tasks` 记录。

### 2.4 文件统一存储层

当前统一文件配置由 `STORAGE_ROOT`、`UPLOAD_ROOT`、`EXPORT_ROOT`、`TEMP_ROOT` 管理；所有路径解析、原子移动、安全文件名和 SHA-256 能力集中在 `lib/security/file-policy.mjs`。`export_files` 只允许 Excel 类型，不能把图片伪装成导出文件。

图片继续进入统一 `STORAGE_ROOT` 文件层，使用独立产品素材目录与马帮命名空间：

```text
storage/product-media/mabang/<sha256前2位>/<sha256>.<实际扩展名>
```

规则：

- 临时下载先写 `TEMP_ROOT`，通过 MIME、文件头、非空、大小和宽高校验后原子移动；
- 最终文件名由 SHA-256 与实际 MIME 决定，不使用 SKU 猜测扩展名；
- 同 SHA-256 只保留一份物理文件；
- Git 已忽略 `storage/`、数据库、图片和临时文件；
- SQLite 只保存元数据和相对路径。

### 2.5 产品中心、图片和 SKU 身份

产品中心身份规则来自迁移 008：

- 单一国家产品唯一键：`source_system + country_raw + sku_code_normalized`；
- `sku_code_normalized = UPPER(TRIM(source_sku))`；
- 跨国家匹配必须使用 `sku_code_normalized`，不能使用包含国家的 `normalized_sku`；
- `product_package_rows` 是源事实层，只能由产品包导入维护，本功能不得读写依赖其副作用。

现有 `product_images` 保留为人工上传兼容层。新素材通过共享 `product_media_assets` 和 `product_media_links` 表接入产品详情读取模型：

- 同一 asset 可关联多个国家产品；
- 马帮素材初始 `mapping_status=suggested`；
- 产品没有人工主图时，第一张有效马帮素材可标记 `media_role=suggested_primary`；
- 只有 `mabang_images.set_primary` 操作确认后才变成 `mapping_status=confirmed, media_role=primary`；
- 若存在 `product_images.is_primary=1` 的人工主图，确认接口返回冲突，不更新人工记录；
- 不修改任何 listing draft 的 `media_json`，因此未确认素材不会进入当前上架采用图片。

## 3. 数据设计（迁移 015）

重新审计时，主线与支线 A 已包含 `013_deterministic_growth_radar_foundation.sql` 和 `014_deterministic_growth_radar_scope_and_linkage.sql`。本分支仍保持在不含支线 A 实现的独立基线上，但迁移使用 `015_mabang_sku_image_collector.sql`，避免未来并列合并时发生编号冲突。

### 3.1 `mabang_sku_image_batches`

主要字段：

- `id`, `account_id`, `mode`, `status`, `created_by`；
- `started_at`, `completed_at`, `paused_at`, `current_page`, `total_pages`；
- `discovered_skus`, `downloaded_images`, `missing_images`, `duplicate_images`, `failed_images`, `linked_products`, `shared_country_links`, `filename_mismatches`；
- `interface_profile_json`（只允许脱敏字段画像）；
- `last_error_code`, `last_error_message`, `created_at`, `updated_at`。

约束：

- `mode IN ('full_initial','missing_only','retry_failed')`；
- 状态包含 `pending/running/pause_requested/paused/completed/partial_success/failed`；
- `account_id` 外键指向现有马帮账号配置；
- 所有计数非负。

### 3.2 `mabang_sku_image_checkpoints`

字段：`id`, `batch_id`, `page_number`, `page_hash`, `row_count`, `discovered_count`, `failed_count`, `status`, `error_code`, `completed_at`。

`UNIQUE(batch_id, page_number)`；一页成功后单独提交事务，前页不会因后页失败丢失。

### 3.3 `mabang_sku_image_discoveries`

包含需求中的全部来源字段：

- 行身份：`batch_id`, `source_sku`, `source_sku_normalized`, `product_name`, `warehouse_name`, `source_page`, `source_row_number`；
- 图片来源：`source_image_url`, `image_src`, `image_data_src`, `image_srcset`, `image_background_url`, `source_kind`；
- 校验：`filename_sku`, `validation_status`, `quality_issue_code`；
- 下载：`download_status`, `asset_id`, `download_attempts`, `http_status`, `error_code`, `error_message`；
- 时间：`discovered_at`, `last_checked_at`。

行 SKU 永远是主身份。文件名只使用 `^(.+)_\d+\.(jpg|jpeg|png|webp)$` 交叉校验；不一致写入 `IMAGE_FILENAME_SKU_MISMATCH`，绝不覆盖行 SKU。

### 3.4 `product_media_assets`

字段：`id`, `source_system`, `source_url`, `storage_file_id`, `original_filename`, `storage_filename`, `relative_path`, `sha256`, `mime_type`, `width`, `height`, `file_size`, `status`, `created_at`, `updated_at`。

- `UNIQUE(sha256)` 实现全局物理去重；
- `source_system` 至少支持 `mabang`，读取层把旧 `product_images` 标记为 `user_upload`，AI 任务仍保持独立，不把本功能接入 AI 生成；
- `storage_file_id` 是稳定文件身份，不使用 `export_files` 假装图片文件。

### 3.5 `product_media_links`

字段：`id`, `asset_id`, `source_sku`, `source_sku_normalized`, `product_id`, `country_code`, `media_role`, `mapping_status`, `linked_at`, `linked_by`, `confirmed_at`, `confirmed_by`。

- `UNIQUE(asset_id, product_id)`；
- 一份 asset 允许多个国家产品关联；
- 人工主图优先级高于已确认马帮主图；
- `media_role IN ('gallery','suggested_primary','primary')`；
- `mapping_status IN ('suggested','confirmed','rejected','invalid')`。

## 4. 采集器设计

### 4.1 会话与页面进入

1. 根据当前 CDP target 查找已打开的 `mabangerp.com` 页面。
2. 如果没有，返回 `MABANG_BROWSER_SESSION_REQUIRED`，由现有“打开验证浏览器”入口建立持久 profile；不创建未认证 HTTP 会话。
3. 在页面 DOM 中按可见文本依次点击“商品”和“库存查询”，不拼企业子域，不依赖固定菜单 DOM 层级。
4. 监听 `Network.requestWillBeSent`、`Network.responseReceived`、`Network.loadingFinished`、Runtime 初始化对象。
5. 验证当前页面仍在允许的 `mabangerp.com` 域名下。

### 4.2 接口识别与分页

接口候选按结构评分，不按固定 URL：

- JSON 中存在对象数组；
- 数组行中存在可归一化的 SKU 字段；
- 同一行出现 http(s) 图片 URL 时优先级最高；
- 能同时识别总数、页码、每页数量、仓库和商品名时提高置信度。

复用请求时只在内存保存当前请求的 URL、method、body 和必要请求头（包括页面原请求可能需要的授权值）；任何头值都不持久化。实际分页调用在页面执行上下文中执行 `fetch`，设置 `credentials: "include"`，由浏览器携带 Cookie。真实响应的库存数组不是 JSON 数组而是 JSON 字符串字段中的 HTML；采集器在当前页面的 `DOMParser` 中解析该字段，再按行建立 SKU/图片映射。不得使用 Node `fetch`、Python `requests` 或新建未认证会话下载马帮资源。

每页大小优先读取页面分页器支持的 option 最大值；没有可验证 option 时保留接口当前值，不猜测“最大值”。页码/页大小字段通过首个真实请求的参数和值动态识别。

停止条件全部启用：

- 下一页按钮禁用；
- 当前页等于总页数；
- 当前页没有数据；
- 连续页面内容哈希相同；
- 超过 `MABANG_IMAGE_SAFE_MAX_PAGES`（默认 10,000，可配置）的安全上限。

### 4.3 DOM 兜底

接口没有图片字段时：

1. 等待表格行出现并稳定；
2. 在主页面与 frame tree 中查找表格；
3. 通过 `scrollHeight > clientHeight` 与实际行包含关系识别滚动容器；
4. 按容器可视高度分段滚动到动态底部，并等待懒加载完成；
5. 读取表头文本并动态匹配 SKU/名称/仓库列，不使用固定列号；
6. 从每行图片元素收集 `src/currentSrc/data-src/srcset/style.backgroundImage`；
7. 保存页面行号、行数、唯一 SKU 数，并生成 page hash。

### 4.4 图片下载、校验与去重

- 并发默认 4，强制限制在 3–5；
- 单图默认最多 4 次，使用 500ms 起步、上限 8s 的指数退避；
- 403、429、5xx、超时可重试；404 记录缺失，不无限重试；
- 使用当前 CDP Browser Context 的 `Network.loadNetworkResource`，设置 `includeCredentials=true`；仅在旧版 CDP 不支持该方法时回退页面上下文 `fetch`；
- 跟随浏览器允许的重定向，但最终 URL 仍需在 `mabangerp.com`/其真实图片域安全范围内；
- 校验 HTTP 200、Content-Type、JPEG/PNG/WebP 文件头、非空、最大尺寸、可读取宽高；
- 校验通过后计算 SHA-256；已存在 SHA 时删除临时文件并复用 asset；
- 非图片、空文件、损坏图不创建可用 asset，也不关联产品。

## 5. 模式与恢复

### `full_initial`

扫描所有库存页，处理全部 SKU；SHA 重复只复用素材。

### `missing_only`

页面仍可扫描全部 SKU；下载前按 `sku_code_normalized` 查找所有国家产品。只要任一目标产品没有人工图片且没有有效素材关联，才下载该 SKU 图片。

### `retry_failed`

基于所选失败批次复制失败/损坏 discovery 到新批次，只重试这些 URL；不存在源批次时拒绝启动。

暂停设置 `pause_requested`，当前原子页结束并写 checkpoint 后进入 `paused`；继续时重新发现接口并从最后成功页之后执行。失败页单独记录，可从失败页重试。服务重启不自动创建每日任务，也不擅自恢复网络操作；用户点击继续后恢复。

## 6. API 与权限

建议新增：

- `GET /api/mabang-images/capabilities`
- `GET /api/mabang-images/accounts`
- `GET /api/mabang-images/batches`
- `POST /api/mabang-images/batches`
- `GET /api/mabang-images/batches/:id`
- `POST /api/mabang-images/batches/:id/pause`
- `POST /api/mabang-images/batches/:id/resume`
- `GET /api/mabang-images/batches/:id/discoveries`
- `GET /api/mabang-images/assets/:id/content`
- `GET /api/mabang-images/assets/:id/products`
- `POST /api/mabang-images/links/:id/confirm-primary`

权限：

- `mabang_images.view`
- `mabang_images.collect`
- `mabang_images.retry`
- `mabang_images.link`
- `mabang_images.set_primary`

权限通过 `MABANG_IMAGE_PERMISSIONS` 配置，默认本机兼容模式全部启用；主图确认必须单独具备 `mabang_images.set_primary`。

审计动作覆盖启动、暂停、继续、成功/失败、重复、关联和主图确认。允许的审计 metadata 只包含 account 的脱敏标识、模式、计数、batch/asset/product ID；不接收请求头、Cookie、Token、密码或完整 URL。

## 7. 后台页面

在运营数据主导航增加独立页面“马帮 SKU 图片”，延续现有深青主色、8–10px 圆角、紧凑表格和系统字体。

页面结构：

- 顶部操作区：账号选择、首次全量、补采缺失、重试失败；
- 明确长任务提示：“该任务可能运行较长时间，但可以暂停和恢复。”；
- 首次全量二次确认，展示账号、模式和非每日运行说明；
- 进度区：状态、当前页/总页数、发现 SKU、下载、缺失、失败、文件名不一致；
- discovery 表格：缩略图、SKU、商品名、仓库、来源方式、校验、下载、关联产品、错误原因；
- 操作：暂停/继续、查看图片、查看关联产品、确认主图；
- 加载、空状态和错误状态均提供明确反馈，错误状态显示可重试原因；
- 移动端保留横向滚动，不挤压表格文字；所有按钮具备 hover/focus/disabled/loading 状态。

## 8. 测试与验收

自动化测试至少覆盖需求列出的 20 项，并额外覆盖：

- 接口画像脱敏；
- 不持久化 Cookie/Authorization；
- 迁移 015 可在本分支 012 基线独立升级，并为主线已有 013/014 预留编号；
- 产品详情读取能区分 `user_upload` 与 `mabang`；
- 人工上传主图存在时确认接口返回冲突；
- `missing_only` 不重复处理已有素材 SKU；
- 并发始终在 3–5；
- 安全最大页数触发保护；
- 正式数据库路径不被测试使用。

交付前执行：

```powershell
npm test
npm run build
npm run doctor
```

SQLite 验证在临时数据库应用全部迁移后执行 `PRAGMA foreign_key_check` 与 `PRAGMA integrity_check`。正式数据库只读检查，不导入测试数据。页面用本功能工作树的隔离数据库启动，保存桌面和窄屏截图；不保存真实马帮图片。

## 9. 明确禁止

- 不根据 SKU 猜 URL，不硬编码企业目录、时间戳、扩展名、企业 ID、页数或表格列位置；
- 不绕过登录，不导出浏览器 Cookie，不记录 Token/密码/完整授权头；
- 不使用高并发，不创建每日全量任务；
- 不修改 `product_package_rows`；
- 不把图片二进制写入 SQLite；
- 不把真实图片、数据库、浏览器 profile 或凭证提交 Git；
- 不自动覆盖人工主图，不自动写入 listing 当前采用素材；
- 不接入 AI 图片生成；
- 不修改或合并支线 A。

## 10. 审计状态摘要

| 项目 | 结果 |
| --- | --- |
| 支线 B 当前基准 | 最新主线 `e2fef3c`，完整包含 013/014 |
| 当前主线最高迁移 | 014（增长雷达基础与关联） |
| 支线 B 迁移编号 | 015（仅图片采集五张表）；016 仍预留且未创建 |
| 正式 SQLite | 最高迁移仍为 014；试跑使用官方在线备份的独立副本，正式库没有 015 表或试跑记录 |
| 现有统一文件层 | 可复用路径安全、临时文件、原子移动、SHA-256；`export_files` 不适合图片 |
| 现有产品图片 | 人工上传兼容层；不能直接满足共享资源/建议主图 |
| 现有产品 SKU 身份 | 国家内唯一；跨国家使用 `sku_code_normalized` |
| 现有浏览器能力 | 持久 profile + 原生 CDP + 网络安全策略 |
| 本次真实接口审计 | 已完成：真实 XHR 返回 JSON 包装的 HTML 库存行，接口优先采集 |
| 实现策略 | 动态探测、脱敏接口画像、XHR HTML 行优先、DOM/COS 兜底、Browser Context 图片下载 |

真实会话的详细指标、暂停恢复、失败重试、抽样核对、正式库隔离证据和截图见 `docs/mabang-sku-image-collector-real-session-validation.md`。
