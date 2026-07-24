# 马帮 SKU 图片采集 rebase 冲突解决记录

## 范围与结果

- 支线：`codex/mabang-sku-image-collector`
- 支线原提交：`21cfb4bb8f43b15b3baa9488f0af86ffb3717fa6`
- 支线旧基准：`6faa0789f15c27c57abd2071ca41971856845af8`
- 最新主线基准：`e2fef3c46d286a87a422ca733737dae28d15a835`
- rebase 后功能提交：`bd8327ac25c1ccacffea8f991de7de72b5a3555a`
- rebase 结果：成功，没有第二轮冲突，没有 merge commit，也没有使用整文件 ours/theirs 覆盖。
- 本节点未执行真实马帮会话试跑、未执行全量图片采集、未合并主线、未创建 016、未修改正式数据库。

解决方法是先对每个冲突文件比较旧基准到支线 B 的真实差异，并分别读取主线 `HEAD` 与 `REBASE_HEAD`，再以最新主线为骨架重新应用图片采集增量。没有为了减少冲突而删除或注释现有功能。

## 冲突文件处理

| 文件 | 保留的主线内容 | 重新应用的支线 B 增量 | 行为变化 | 是否删除功能代码 |
|---|---|---|---|---|
| `docs/postgresql-readiness.md` | 013/014 增长雷达表、JSON 迁移说明和主线迁移顺序 | 015 五张表、接口档案 JSON、时间/布尔/唯一索引/外键、SHA-256、安全相对路径及图片二进制不入库说明 | PostgreSQL 准备度覆盖迁移 001–015 | 否 |
| `lib/data/data-access.mjs` | 产品中心、Listing、`product_images`、增长雷达 Repository、Provider 和事务初始化 | 独立 `mabangImages` Repository | 数据访问对象同时暴露增长雷达与图片采集命名空间 | 否 |
| `lib/security/audit-http.mjs` | 全部原有 HTTP 操作分类和增长雷达动作 | 采集启动、暂停、恢复和确认主图四个 HTTP 审计分类 | 新增图片采集操作审计；原风险和失败分类不变 | 否 |
| `public/index.html` | 产品中心、Listing、增长雷达、马帮数据、权限/审计页面和主线元素 ID | “马帮 SKU 图片”导航、采集管理页、批次/进度/失败/预览/关联确认区域 | 新增独立管理页面；样式缓存键更新并继续加载增长雷达独立样式 | 否 |
| `public/app.js` | 产品中心初始化、多页面导航、增长雷达初始化、权限和现有事件绑定 | 图片页模块、延迟加载、账号选择、任务控制、轮询和素材关联交互 | 仅进入图片页时加载采集数据，没有在全局初始化时请求全部图片数据 | 否 |
| `server.mjs` | 主线 import、产品中心/Listing/增长雷达路由、权限/审计、文件保护、单一 HTTP Server 和启动顺序 | 图片 Service、Browser Context 复用、恢复机制、图片 API handler 和关闭时暂停/等待活动采集任务 | 服务启动只恢复为可继续状态，不自动开始全量；关闭时有界清理采集任务 | 否 |
| `tests/postgresql-readiness.test.mjs` | 主线所有 readiness 断言和增长雷达后的 54 张表基线 | 015 五张表后的 59 张表断言 | 表数量期望由 54 增至 59 | 否 |

API 前缀审计没有发现与主线路由重名。冲突标记检查和 `git diff --check` 均通过。

## 结构验证

- 013：`013_deterministic_growth_radar_foundation.sql` 完整保留。
- 014：`014_deterministic_growth_radar_scope_and_linkage.sql` 完整保留。
- 015：`015_mabang_sku_image_collector.sql` 完整保留，仅创建以下五张表：
  - `mabang_sku_image_batches`
  - `mabang_sku_image_checkpoints`
  - `mabang_sku_image_discoveries`
  - `product_media_assets`
  - `product_media_links`
- 迁移目录最高编号为 015，不存在 016 或更高迁移。
- 015 不包含 `style_groups`、`style_group_products`、`product_listing_draft_items` 或增长雷达结构。
- 产品中心、Listing、增长雷达和马帮 SKU 图片页面均存在。
- 11 个文档化图片采集 API 合同均保留并由图片 API handler 注册。
- 图片权限共 5 项：`view`、`collect`、`retry`、`link`、`set_primary`。
- 图片审计动作共 8 项：启动、完成、失败、请求暂停、已暂停、恢复、关联、确认主图。
- 页面检查：449 个唯一元素 ID，210 个静态绑定，无重复 ID 或缺失绑定。

## 测试与构建

- 冲突关联测试：149/149 通过。
- SKU 图片专项测试：27/27 通过。
- 增长雷达专项测试：57/57 通过。
- PostgreSQL readiness：5/5 通过。
- 全量测试：533/533 通过，等于主线 506 项加支线 B 27 项。
- Build：通过。
- 路径检查：通过。
- 前端唯一 ID 与静态绑定检查：通过。

首次全量运行时，广告集成测试因永久工作树旁不存在默认 `../lazada-ads/webapp` 目录而出现一次进程启动 `ENOENT`。确认 Node 可执行文件正常后，以临时环境变量指向本机实际广告子项目目录复跑；单项和 533 项全量测试均通过。没有修改 `.env` 或提交机器路径配置。

## 数据库迁移验证

所有数据库验证均使用系统临时目录中的独立数据库，并通过官方 `SchedulerDatabase.migrate()` 执行。

### 001 → 015 空库

- 首次应用迁移：15 条。
- `schema_migrations`：15 条。
- 013、014、015：各 1 条。
- 第二次运行新增迁移：0 条。
- `PRAGMA integrity_check`：`ok`。
- `PRAGMA foreign_key_check`：0 条。
- 五张 015 新表：全部为空。

### 014 → 015 副本

- 独立 014 数据库先应用 14 条迁移，再写入最小产品、产品包、现有产品图片、Listing 和增长雷达哨兵数据。
- 复制数据库后只应用 `015_mabang_sku_image_collector.sql`。
- 第二次运行新增迁移：0 条。
- `schema_migrations`：15 条；013、014、015 各 1 条。
- 产品、`product_package_rows`、`product_images`、Listing 和全部增长雷达表在迁移前后的行数及全行 SHA-256 摘要一致。
- 五张 015 新表：全部为空。
- `PRAGMA integrity_check`：`ok`。
- `PRAGMA foreign_key_check`：0 条。

## 运行与安全检查

- Doctor：通过。Node、npm 依赖、Python、马帮 worker、广告服务目录、临时 SQLite、存储目录和 Chrome 均为 OK；仅有既有端口占用与托管广告内部令牌首次启动生成的非阻塞警告。
- HTTP 健康检查：临时数据库和随机空闲端口下 `/api/health` 返回 200 与 `{ "ok": true }`；图片 capabilities 返回 200 和 5 项权限；首页返回 200。
- 敏感信息扫描：生产增量高风险命中 0。专项测试中有 1 个用于验证脱敏的合成凭证夹具，不是运行凭证。
- Git 数据库扫描：没有跟踪 SQLite 或其他数据库文件。
- Git 图片扫描：支线新增的两张图片均为管理页面 UI 截图；没有真实 SKU 图片或下载素材进入 Git。
- 正式数据库：未读取、未迁移、未写入；所有验证数据均已随临时目录清理。

## 结论

rebase、结构检查、完整测试、Build、Doctor、迁移链、SQLite 完整性、HTTP 健康及安全扫描均通过。当前节点具备进入后续“真实已登录会话小范围试跑”的代码前置条件，但本节点按授权边界暂停，未执行真实会话验收。
