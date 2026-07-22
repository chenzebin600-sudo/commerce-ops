# Growth Radar 主线合并与迁移记录

## 1. 结论

- 状态：通过。
- 执行日期：2026-07-22。
- 主线：`master`。
- 支线：`feature/deterministic-product-growth-radar`。
- 支线最终提交：`6060209d5756c402f6d19004c7462c413d898da4`。
- 支线同步基准：`c10e0a4da74bafa5808386c5e1dd937851dc499a`。
- 合并方式：保留历史的 `--no-ff` merge commit。
- 合并提交：`fc1daae75c1c20f36fee568f6f772c0023b3109a`。
- 冲突：无；未使用 `ours`、`theirs`、squash 或局部 cherry-pick。
- 正式 SQLite：已从 012 升级到 014，仍是当前生产数据库。
- Growth Radar 正式数据：16 张相关表共 0 行。
- 015：仅为多 SKU 基础迁移保留编号，本节点未创建任何 015 文件。

## 2. 合并边界

本次合并保留了支线 A 的完整提交历史、设计文档、解析器、Repository、Service、API、前端基础页面、测试和两份迁移。没有开始 Growth Radar G1B/G2/G3，也没有创建多 SKU 表或修改 Listing 数据模型。

主线原有两份未跟踪参考文档保持原状，未修改、未移动、未暂存：

- `docs/product-query-center-DESIGN.md`
- `docs/product-query-center-production-analysis.md`

## 3. 迁移文件

### 013

`013_deterministic_growth_radar_foundation.sql` 建立确定性增长雷达基础：

- 来源批次、店铺主数据与来源映射；
- 订单原始行、订单头、订单行；
- 产品身份映射和映射问题；
- 库存原始行、库存快照；
- 数据质量问题、映射事件；
- 历史店铺 SKU 观察和保留的当前在线覆盖表。

所有事实均保留来源批次、质量状态和可审计关系；迁移不写入真实业务数据。

### 014

`014_deterministic_growth_radar_scope_and_linkage.sql` 增加来源范围与确定性关联：

- 批次来源范围确认状态和 PII 过滤计数；
- 订单行来源仓库及规范化仓库；
- 库存快照仓库粒度、来源可见销量与来源预测字段；
- 订单行到库存快照的 `source_sku + source_warehouse` 关联；
- 自有 7 日销量指标和来源销量分层。

014 不包含 `style_groups`、`style_group_products`、`product_sku_descriptions`、`product_listing_draft_items`、`product_listing_draft_images` 或其他多 SKU Listing 结构。

迁移目录检查结果：001-014 连续、每个编号唯一、文件名唯一，不存在 015 或更高编号。

## 4. 临时数据库验证

所有临时数据库均位于 Git 忽略目录 `storage/validation/growth-radar-mainline-20260722013028/`。

### 空库 001-014

| 检查 | 结果 |
|---|---|
| 首次应用 | 001-014 共 14 个迁移 |
| `schema_migrations` | 14 行，文件名与迁移目录完全一致 |
| 第二次执行 | 0 个新迁移 |
| 关闭并重新打开后执行 | 0 个新迁移 |
| `integrity_check` | `ok` |
| `foreign_key_check` | 0 |
| Growth Radar 表 | 16 张，共 0 行 |
| 临时服务启动 | `/` 与 `/api/health` 均为 HTTP 200 |

### 正式库 012 副本升级到 014

副本由 SQLite online backup API 创建，升级前只含 12 个迁移。官方 Repository 迁移器只应用 013 和 014，第二次执行及重新打开后均为 0 个新迁移。

| 业务表 | 升级前 | 升级后 |
|---|---:|---:|
| `product_skus` | 18,347 | 18,347 |
| `product_package_rows` | 21,714 | 21,714 |
| `product_images` | 1 | 1 |
| `product_listing_drafts` | 0 | 0 |
| `product_ai_contents` | 0 | 0 |
| `product_field_overrides` | 81 | 81 |
| `export_files` | 9 | 9 |

副本升级后 `integrity_check=ok`、外键异常为 0、Growth Radar 16 张表共 0 行。

## 5. 正式数据库备份

- 正式数据库：`storage/commerce-ops.sqlite`。
- 备份目录：`storage/backups/growth-radar-mainline-20260722013312/`。
- 备份文件：`commerce-ops-before-013-014.sqlite`。
- 备份清单：`backup-manifest.json`。
- 备份时间：2026-07-22 09:33（Asia/Shanghai）。
- 备份大小：260,538,368 bytes。
- 备份 SHA-256：`cc54113b2b6761033c72516b08954c76ba797b6d8426cdf85a6aa63c53c226b7`。
- 升级前最高迁移：012。
- 升级前 `integrity_check`：`ok`。
- 升级前 `foreign_key_check`：0。

备份前已确认运行中与待执行的马帮任务均为 0、活动调度租约为 0，并停止主服务、广告子进程和调度器。完成 WAL checkpoint 后使用 SQLite 官方 backup API 生成一致性备份。备份可读、核心表行数与来源一致；目录被 Git 忽略且未覆盖旧备份。

运行文件另做不可变性基线：排除数据库、备份、验证目录和内部服务密钥后，共 1,863 个文件、385,418,992 bytes，聚合 SHA-256 为 `bb089a7327561ef7cf19befe47ceecf77091bcf2cb5d245ead71c890eb407277`。

## 6. 正式数据库升级

正式升级只运行项目官方命令 `npm run migrate`，没有手工执行 SQL、插入迁移记录或替换数据库文件。

| 检查 | 结果 |
|---|---|
| 升级前版本 | 012 |
| 实际新增迁移 | 013、014 |
| 升级后版本 | 014 |
| 013 记录数 | 1 |
| 014 记录数 | 1 |
| 连续两次再次运行 | 未新增迁移，时间戳不变 |
| `integrity_check` | `ok` |
| `foreign_key_check` | 0 |
| 原业务行数 | 保持不变 |
| 原运行文件 | 数量、字节数与聚合 SHA-256 保持不变 |

升级后的正式业务行数：

| 表 | 行数 |
|---|---:|
| `mabang_account_profiles` | 2 |
| `dingtalk_robot_configs` | 1 |
| `scheduled_export_tasks` | 1 |
| `scheduled_export_runs` | 2 |
| `export_files` | 9 |
| `managed_files` | 7 |
| `product_skus` | 18,347 |
| `product_models` | 6,500 |
| `product_package_rows` | 21,714 |
| `product_inventory_snapshots` | 21,978 |
| `product_field_overrides` | 81 |
| `product_images` | 1 |
| `product_listing_drafts` | 0 |
| `product_ai_contents` | 0 |
| `product_image_generation_tasks` | 0 |

## 7. Growth Radar 数据与隐私边界

- 正式库相关表：16 张。
- 正式库相关数据行：0。
- 真实订单明细：0。
- 真实库存快照：0。
- `current_online` 数据：0。
- `company_sales` 字段：0。
- 客户账号、姓名、地址、电话、邮箱、收件信息等 PII 命名字段：0。
- 真实样本专项验证只写入一次性临时数据库，验证完成后临时库自动删除。
- 来源范围状态保持 `unconfirmed`，历史观察数据不会被提升为当前在线覆盖。

专项样本验证结果：订单文件 2,659 行、1,582 个订单、229 个 SKU、16 个来源店铺；库存文件 1,440 行、1,438 条快照事实、952 个 SKU、6 个仓库。2,658 条关联成功，1 条作废订单关联不到当前来源范围。PII 字段过滤计数为 8，客户信息未写入标准事实。

## 8. 测试与构建

| 质量门 | 结果 |
|---|---|
| Growth Radar G1A/G1A.5 专项测试 | 通过 |
| 真实样本隔离验证 | 通过，临时库已删除 |
| 全量测试 | 506/506 通过 |
| Build | 通过 |
| 路径检查 | 通过 |
| Doctor | 全项通过 |
| Git diff 检查 | 通过 |
| Git 敏感信息扫描 | 0 个真实 API Key、Webhook Token、私钥或硬编码密码命中 |
| 数据库文件提交扫描 | 0 |
| Excel/CSV 提交扫描 | 0 |

广告运行时的历史环境例外 `node.exe ENOENT` 本次未复现；受管广告服务成功启动，健康接口 HTTP 200。该历史例外仍作为环境相关风险保留，测试和断言未被删除或弱化。

## 9. 服务健康检查

主服务重新启动后监听 3101，广告服务仅在本机监听 4173。共完成 28 个 HTTP/DOM 检查点：

- `/`、`/api/health`、认证状态、广告页面代理和广告健康代理：200；
- 产品权限、产品查询、SKU 详情、Listing 草稿、AI 历史、产品导入：200；
- 马帮调度元数据、账号、任务、运行记录：200；
- 审计查询、文件列表：200；
- Growth Radar 权限、摘要、新鲜度、覆盖状态、来源批次、质量问题、店铺、店铺映射、产品映射：200；
- 虚构文件 ID 下载：404，文件下载保护按预期拒绝；
- 主页面包含产品中心、SKU 编辑、Listing 工作台、Growth Radar、马帮和审计所需 DOM 入口。

## 10. 截图遗留项

本次自动浏览器通道在初始化时发生运行时属性冲突，未能生成可信截图。未使用静态构建结果冒充页面截图，也未伪造截图。

当前截图完成数：0。以下 7 张图保留为后续页面人工验收项：

1. 数据来源批次；
2. 订单导入预览；
3. 店铺主数据；
4. 店铺映射待确认；
5. SKU 映射待确认；
6. 数据质量问题；
7. 库存导入预览。

## 11. 回滚方案

### 代码回滚

在确认没有基于合并结果的新提交后，使用：

```powershell
git revert -m 1 fc1daae75c1c20f36fee568f6f772c0023b3109a
```

该命令生成反向提交并保留历史，不重写主线。

### 数据库回滚

1. 停止主服务、调度器和所有写入任务；
2. 将当前 `storage/commerce-ops.sqlite` 改名保存为故障副本；
3. 将备份 `storage/backups/growth-radar-mainline-20260722013312/commerce-ops-before-013-014.sqlite` 复制回 `storage/commerce-ops.sqlite`；
4. 执行 `PRAGMA integrity_check` 与 `PRAGMA foreign_key_check`；
5. 回滚代码后重新启动服务并验证任务、文件和产品行数。

不得在服务运行时覆盖数据库文件。

## 12. 多 SKU 开发基线

- 新分支：`feature/multi-sku-listing`。
- 永久工作树：`%CODEX_HOME%/worktrees/multi-sku-listing/commerce-ops`。
- 分支基准：包含本报告的最新稳定主线提交。
- 架构文档：`docs/multi-sku-listing-architecture.md` 已存在。
- 迁移最高编号：014。
- 015 文件：不存在。
- 015 预留：`015_multi_sku_listing_foundation.sql`，仅保留名称，本节点不创建文件。
- 开发数据库：后续必须使用独立数据库副本或独立开发数据库，不得直接写正式库。

原 Growth Radar 支线继续保留。未来 G1B 应从合并后的最新主线创建新分支，不在旧支线上继续堆叠，也不得占用已预留的 015。
