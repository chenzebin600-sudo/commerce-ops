# Commerce Ops PostgreSQL 备份与 WAL 保留策略

生效日期：2026-08-10  
状态：**ACTIVE**  
机器时区：Asia/Shanghai

## 目标

- 每周生成一个经过清单、哈希和独立启动验证的物理基础备份。
- 保留最新 4 个 VERIFIED 周备份，提供约 4 周的基础快照。
- 保留最近 7 天 WAL，提供最近 7 天的连续恢复窗口。
- WAL 达 50 GiB 告警，达 80 GiB 严重告警。
- 不自动删除基础备份、恢复副本或 WAL；删除必须由人工确认。

物理备份是 PostgreSQL 集群级备份，会覆盖集群中的所有数据库；`commerce_ops` 是本策略的正式生产验证数据库。

## 物理基础备份

| 项目 | 策略 |
|---|---|
| 路径 | `D:\PostgreSQLBackups\base_backup\YYYY-MM-DD` |
| 周期 | 每周日 03:00 |
| 格式 | tar |
| 压缩 | client-zstd:6 |
| WAL | stream |
| 清单 | SHA-256 |
| 校验 | `pg_verifybackup --no-parse-wal` |
| 恢复验证 | 每周日 05:00，隔离端口 55432 |
| 正式保留 | 最新 4 个日期目录且元数据状态为 VERIFIED |
| 自动清理 | 关闭 |

失败、部分完成或名称带 `unverified` 的目录不计入正式 4 份。脚本只报告超出 4 份的候选，不删除。正式目录已存在且非空时，备份脚本拒绝覆盖。

## WAL 保留与告警

| 项目 | 策略 |
|---|---|
| 路径 | `D:\PostgreSQLBackups\wal` |
| 保留 | 最近 7 天 |
| 检查周期 | 每 15 分钟 |
| WARNING | `>= 50 GiB`，任务退出码 1 |
| CRITICAL | `>= 80 GiB`，任务退出码 2 |
| 自动删除 | 关闭 |

WAL 清理候选必须同时满足：

1. 已存在 `pg_verifybackup=PASS` 的最新正式基础备份；
2. 该备份已通过独立恢复启动和业务一致性测试；
3. 文件最后修改时间早于 7 天保留截止点；
4. 文件段号早于最新正式基础备份所需的起始 WAL 段；
5. 人工复核候选清单并明确确认本批次；
6. 优先移动到独立隔离目录，复核后再执行不可逆删除。

在任一条件不满足时，清理数量必须为 0。`check_wal.ps1` 没有删除实现，只写 JSON/NDJSON 证据。

## 自动化任务

| Windows 任务 | 计划 | 权限 | 行为 |
|---|---|---|---|
| `CommerceOpsPostgreSQLBaseBackupWeekly` | 周日 03:00 | 当前用户 / Interactive / Limited | 在线备份、校验、写元数据，不删除 |
| `CommerceOpsPostgreSQLRestoreTestWeekly` | 周日 05:00 | 当前用户 / Interactive / Limited | 选择最新 VERIFIED 备份，隔离恢复并停止，不删除目录 |
| `CommerceOpsPostgreSQLWalMonitor` | 每 15 分钟 | 当前用户 / Interactive / Limited | 容量、年龄和阈值监控，不删除 |

任务注册脚本：`scripts/postgres-backup/install_tasks.ps1`。当前任务需要用户处于交互登录状态；如果以后改成无人值守服务账号，必须先单独验证该账号对 `.env.postgres.local`、TLS CA、备份根目录和 PostgreSQL 的最小权限。

## 恢复语义

- 最近 7 天：从合适的基础备份加连续 WAL 执行时间点恢复。
- 更早但仍在 4 份保留内：至少可恢复到对应基础备份本身的一致快照；若其后 WAL 已超过 7 天被批准清理，则不承诺任意时间点恢复。
- tar 模式的 `pg_verifybackup` 不解析 WAL；必须以实际解压并启动 PostgreSQL 的恢复测试补足。

## 当前未做的生产变更

基线显示 `wal_compression=off`。本次没有修改生产配置、重载或重启 PostgreSQL。可在后续独立变更窗口评估 `wal_compression` 的 CPU 与空间权衡，但不能把该建议视为已应用。

机器可读策略：`config/postgresql-backup-policy.json`。
