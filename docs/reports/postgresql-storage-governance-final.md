# Commerce Ops PostgreSQL 存储治理最终报告

完成日期：2026-08-10（Asia/Shanghai）  
第二阶段状态更新：2026-08-10 11:38 CST  
最终状态：**PASS（WAL 未删除，等待未来批次人工确认）**

## 执行摘要

本次从“只有持续增长的加密 WAL、没有物理基础备份”的状态，建立了可验证的 PostgreSQL 物理恢复链：在线压缩基础备份、SHA-256 清单验证、隔离恢复启动、六类业务一致性验证、周备份与周恢复计划任务、15 分钟 WAL 阈值监控，以及 7 天人工清理策略。

没有停止或写入生产 PostgreSQL 业务数据。恢复测试使用 C 盘独立目录和 55432 端口，并已正常停止。WAL 文件没有被删除、移动或改写。

## 阶段结果

| 阶段 | 结果 | 关键证据 |
|---|---|---|
| 环境基线 | PASS | PostgreSQL 18.4；正式库 7.139 GiB；141 张 `app` 表；WAL 5,102 个/79.72 GiB；归档失败 0 |
| 物理基础备份 | PASS | 2.847 GiB；zstd:6；stream WAL；SHA-256 清单；`pg_verifybackup` PASS |
| 独立恢复 | PASS | 55432 启动成功；141/141 表；六类业务行数完全一致；实例已停止 |
| 备份策略 | PASS | 每周日 03:00；正式 VERIFIED 备份保留 4 份；不自动删除 |
| WAL 策略 | PASS | 保留 7 天；50/80 GiB 分级；每 15 分钟；不自动删除 |
| 清理建议 | PASS | 当前严格候选 0；未来候选流程已生成；等待人工确认 |
| 自动化 | PASS | 备份、恢复、WAL 监控三任务 Ready；监控任务实测 WARNING/退出码 1 |
| 生产回归 | PASS | provider=postgres；运行检查 writes=0；监控 PASS；3101/4173 HTTP 200；归档失败 0 |

## 正式恢复链

- 基础备份：`D:\PostgreSQLBackups\base_backup\2026-08-10`
- VERIFIED 元数据：`D:\PostgreSQLBackups\metadata\physical-base-backup-2026-08-10.json`
- 备份日志：`D:\PostgreSQLBackups\logs\physical-base-backup-20260810-103348.log`
- 清单 WAL 范围：timeline 1，`19/3E000028` → `19/3E000158`
- 起始 WAL 段：`00000001000000190000003E`
- 恢复副本：`C:\PostgreSQL_restore_test\2026-08-10`（恢复 PASS 后已于第二阶段受保护删除）
- 恢复证据：`D:\PostgreSQLBackups\restore-test\restore-test-2026-08-10.json`

六类业务验证：orders 22,889；products 76,114；inventory 240,421；tasks 477；agent_runs 0；audit_logs 169,008。所有源库备份前、备份后、恢复副本及恢复测试时源库行数完全一致。

## 当前存储影响

| 项目 | 任务前 | 当前 | 说明 |
|---|---:|---:|---|
| D 盘可用 | 39.506 GiB | 约 33.812 GiB | 新增正式备份和保留的第一次尝试 |
| C 盘可用 | 约 97.784 GiB | 约 97.201 GiB | 第二阶段删除隔离恢复副本，释放约 16.069 GiB |
| 加密 WAL | 5,102 / 79.719 GiB | 5,107 / 79.797 GiB | 正常生产与备份期间增长，删除 0 |
| 正式基础备份 | 0 | 1 / 2.847 GiB | VERIFIED |
| 第一次尝试 | 0 | 1 / 2.847 GiB | 保留在 `2026-08-10-unverified-attempt1`，未删除 |

第一次尝试没有同一次脚本闭环的完成后业务基线，所以不计入正式保留 4 份。第二阶段重新执行 `pg_verifybackup` 和三个文件的 SHA-256 对比后，确认它是 WAL 范围更早且文件哈希不同的有效独立恢复点；按“存在恢复价值则保留”的规则不删除。

## WAL 清理结论

当前 WAL 为 79.797 GiB，状态 WARNING，距离 80 GiB CRITICAL 约 0.203 GiB。正式基础备份起始段之前有 5,106 个文件、79.782 GiB，但截至 2026-08-10 10:52 CST，没有任何文件早于 7 天截止点，因此当前策略交集为 0。

最早 WAL 将从 2026-08-13 19:13:55 CST 起逐步达到 7 天。届时仍需重新计算“早于 7 天”与“早于最新 VERIFIED 基础备份起始段”的交集，并由用户确认具体文件数、字节数和截止时间。建议先移入隔离目录，再恢复演练，最后二次确认永久删除。

## 自动化与运行状态

- `CommerceOpsPostgreSQLBaseBackupWeekly`：Ready；下次 2026-08-16 03:00。
- `CommerceOpsPostgreSQLRestoreTestWeekly`：Ready；下次 2026-08-16 05:00。
- `CommerceOpsPostgreSQLWalMonitor`：Ready；每 15 分钟；实测 WARNING、退出码 1、删除 false。
- `CommerceOpsRuntime`：Running；登录时从 `D:\Projects\commerce-ops\scripts\start-all.mjs` 启动。

最终应用回归：主服务 3101、广告服务 4173 均 HTTP 200，`/api/health` 返回 `{"ok":true}`；调度器随 `start-all` 运行。正式 PostgreSQL 运行检查为 PASS，持久化 provider 为 `postgres`，检查期间 writes=0、externalCalls=0。数据库监控为 PASS，阻塞会话 0、长事务 0、等待锁 0、死锁 0、归档失败 0。

旧路径 `C:\Users\PC\Documents\New project2` 已确认是指向 `D:\Projects\commerce-ops` 的 Junction；排除检查命令自身后，没有进程命令行或可执行路径引用旧 C 盘路径。Commerce Ops 的 Node 进程命令行全部指向 D 盘项目。

## 过程异常与修复

1. Windows PowerShell 默认参数阶段没有提供 `$PSScriptRoot`：已移到脚本正文解析。
2. Windows PowerShell 5 将 `pg_basebackup` 正常 stderr 进度包装为错误记录：已改为依据原生退出码判定。
3. tar 备份的 `pg_verifybackup` 需要 `--no-parse-wal`：已修正，并以独立恢复启动补足 WAL 可用性证明。
4. 流式 WAL 文件实际为 `pg_wal.tar`：恢复脚本已同时接受 `.tar` 与 `.tar.zst`。
5. WAL 7 天候选为空时严格模式读取 `Sum` 失败：已显式处理为 0。

所有修复后的脚本均通过 PowerShell 解析；正式备份、恢复和 WAL 监控均已实际运行通过。

## 交付物

- `docs/reports/postgresql-storage-baseline-2026-08-10.md`
- `docs/reports/postgresql-base-backup-report.md`
- `docs/reports/postgresql-restore-test-report.md`
- `docs/reports/postgresql-backup-policy.md`
- `docs/reports/postgresql-wal-cleanup-recommendation-2026-08-10.md`
- `docs/reports/postgresql-wal-cleanup-recommendation-v2.md`
- `docs/reports/postgresql-storage-cleanup-final.md`
- `docs/reports/postgresql-storage-governance-final.md`
- `config/postgresql-backup-policy.json`
- `scripts/postgres-backup/backup.ps1`
- `scripts/postgres-backup/check_wal.ps1`
- `scripts/postgres-backup/restore_test.ps1`
- `scripts/postgres-backup/install_tasks.ps1`
- `scripts/postgres-backup/README.md`

## 尚需人工决策

当前没有可按 7 天策略删除的 WAL。未来达到 7 天的具体批次仍需用户再次确认。D 盘第一次备份 attempt 已证明具有恢复价值并保留；C 盘停止的恢复副本已受保护删除，审计位于 `D:\PostgreSQLBackups\cleanup-audit`。
