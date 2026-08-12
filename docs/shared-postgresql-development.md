# Commerce Ops 共享 PostgreSQL 开发

## 目标与边界

所有开发者连接同一个 PostgreSQL 开发库，共享表结构和业务数据。代码和迁移文件通过 Git 协作；数据库结构只通过 `migrations/postgresql` 中已审查的迁移变更。Navicat 用于查看、查询和受控编辑数据，不用于手工改表。

数据库共享不等于文件共享。`export_files`、图片素材等表只保存相对路径和元数据；另一台电脑不会因为读到记录就自动拥有原电脑磁盘上的文件。

## B 机本地配置

公开 CA 保存到 B 机受控证书目录。不要复制服务端私钥或 CA 私钥。

在 Git 忽略的 `.env.local` 或 `.env.postgres.local` 配置：

```env
DATABASE_PROVIDER=postgres
POSTGRES_HOST=10.110.80.117
POSTGRES_PORT=5432
POSTGRES_DATABASE=commerce_ops
POSTGRES_SCHEMA=app
POSTGRES_APP_USER=commerce_app
POSTGRES_APP_PASSWORD=<从密码管理器获取，不提交>
POSTGRES_SSLMODE=verify-full
POSTGRES_SSLROOTCERT=<B机公开CA证书绝对路径>
POSTGRES_CHANNEL_BINDING=require
EXTERNAL_TASKS_ENABLED=false
INSTANCE_ID=host-b
```

配置为 `postgres` 后，连接失败会终止启动，不会回退到 SQLite。

## 启动前检查

```powershell
npm run doctor
```

Doctor 只输出主机、端口、数据库、Schema、TLS 模式、CA SHA-256 指纹、迁移版本和外部任务状态，不输出密码或证书内容。必须确认：

- TCP 可达；
- TLS 为 1.3，身份与 `commerce_ops / commerce_app / app` 匹配；
- 迁移版本存在；
- `commerce_app` 没有 Schema 建表权限；
- B 的外部任务状态为 `disabled_by_configuration`。

然后运行：

```powershell
npm test
npm run build
npm run dev:main
```

## 唯一外部任务执行器

普通开发机必须设置 `EXTERNAL_TASKS_ENABLED=false`。只有指定执行器可以设置：

```env
EXTERNAL_TASKS_ENABLED=true
INSTANCE_ID=commerce-ops-executor-c
```

即使误启动两个指定实例，共享 `scheduler_leases` 也只允许一个实例执行定时导出、采集和外部副作用。

## 表结构变更流程

1. 新增顺序迁移文件，不修改已在共享库应用的历史迁移。
2. 在名称以 `_test` 结尾的隔离数据库执行迁移和烟雾测试。
3. 提交迁移、仓储实现和测试并完成代码审查。
4. 由持有 `commerce_migrator` 凭据的人执行 `npm run postgres:migrate -- --apply`。
5. 普通 `commerce_app` 仅执行 DML，不应拥有 DDL 权限。

C 端 `commerce_ops` 是带既有迁移历史的共享库，首次接入本仓库时使用显式收养模式：

```powershell
npm run postgres:migrate -- --apply --adopt-existing
```

收养模式仅在迁移账本非空时生效：它登记只用于新建空库的 `001_shared_baseline`，不执行该基线，不重建现有表，然后只执行后续增量迁移。空库会拒绝该模式；后续日常迁移仍使用普通 `--apply`。迁移密码只放在 Git 忽略的本地环境文件中，不写入命令行、日志或 Navicat 截图。

真实双实例测试必须使用隔离测试库：

```powershell
$env:POSTGRES_DATABASE='commerce_ops_shared_test'
npm run postgres:shared-smoke
```

脚本会拒绝任何不以 `_test` 结尾的数据库。

## SQLite 数据切换与回滚

切换前使用 Node SQLite backup API 创建一致快照，不要直接复制可能带 WAL 的数据库文件。快照必须满足：

- `PRAGMA integrity_check` 为 `ok`；
- `PRAGMA foreign_key_check` 为 0；
- 记录 SHA-256、字节数和生成时间；
- 快照只读，保存在 `storage/backups`，不提交 Git。

不要把 B 的 SQLite 数据直接覆盖到 C 的现有 `commerce_ops`。先逐表比较结构、行数、主键范围和关键业务汇总；冲突数据需要确定 C 保留、B 保留或人工合并。迁移工具必须在事务中写入，并在提交前完成逐表行数和摘要对账。

回滚时停止 B 应用，将 `DATABASE_PROVIDER` 恢复为 `sqlite`，并把 `DATABASE_PATH` 指向经完整性验证的快照副本。PostgreSQL 切换期间产生的新共享数据不会自动回写 SQLite，因此回滚后只能作为临时只读/应急状态，不能让两边同时继续写入。

## Navicat 规则

- 连接启用 SSL、校验 CA 和主机身份；不要关闭证书验证。
- 日常查询和受控数据编辑使用 `commerce_app`。
- 不保存或分享明文密码截图。
- 不在 Navicat 中手工创建、删除或修改表、索引、约束。
- 大批量更新先写查询确认影响行数，并通过可审查脚本执行。
