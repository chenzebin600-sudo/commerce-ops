# PostgreSQL 备份空间整理与 WAL 生命周期优化最终报告

完成时间：2026-08-10 11:38 CST  
状态：**PASS**  
WAL 删除：**未执行**

## 执行结论

本轮只永久删除了已经完成验证、实例已停止、无进程引用且可由正式基础备份重新生成的 C 盘恢复测试副本，共 9,469 个文件、17,252,744,428 bytes（16.068 GiB）。C 盘实际增加约 16.069 GiB 可用空间。

D 盘第一次物理备份 attempt 经重新验证后确认仍是有效、独立的恢复点，因此按“存在恢复价值则保留”的规则没有删除。WAL 当前没有达到 7 天保留条件的文件，删除数量为 0。

## 清理前存储基线

| 项目 | 清理前 |
|---|---:|
| D 盘可用 | 33.809 GiB |
| `D:\PostgreSQLBackups` | 88.180 GiB |
| WAL archive | 79.797 GiB |
| physical base backups | 5.693 GiB |
| logical backups | 2.688 GiB |
| C 盘可用 | 81.132 GiB |
| C 盘恢复测试副本 | 16.068 GiB / 9,469 files |

## D 盘备份目录盘点

| 目录 | 创建时间 | 文件数 | 大小 | 分类 | 处置 |
|---|---|---:|---:|---|---|
| `wal` | 2026-08-06 16:54:50 | 5,109 | 79.797 GiB | WAL archive：5,107 个段 + 2 个备份历史标记 | 保留；未满 7 天 |
| `base_backup` | 2026-08-10 10:20:45 | 6 | 5.693 GiB | physical backups | 两个恢复点均保留 |
| `logical` | 2026-08-06 16:54:50 | 22 | 2.688 GiB | 11 个加密 logical dumps + 11 个 manifests | 保留；本轮不在删除范围 |
| `config` | 2026-08-06 16:54:50 | 22 | 435,499 bytes | backup configuration / keys metadata | 保留 |
| `logs` | 2026-08-10 10:20:45 | 2 | 188,168 bytes | physical backup logs | 保留 |
| `metadata` | 2026-08-10 10:20:45 | 1 | 5,180 bytes | VERIFIED backup metadata | 保留 |
| `restore-test` | 2026-08-10 10:47:07 | 1 | 4,191 bytes | restore PASS evidence | 保留 |
| `monitor` | 2026-08-10 10:19:54 | 2 | 3,592 bytes | WAL monitor evidence | 保留 |

清理后新增 `cleanup-audit`，只保存本次删除的 JSON 审计记录，体积可忽略。

## 两个物理备份的恢复价值判断

| 目录 | 大小 | WAL 范围 | 清单/哈希 | 是否正式 | 决策 |
|---|---:|---|---|---|---|
| `2026-08-10-unverified-attempt1` | 2.847 GiB | `19/3C000028` → `19/3C000158` | `pg_verifybackup` PASS | 否，缺少同次完成后的正式元数据 | **保留** |
| `2026-08-10` | 2.847 GiB | `19/3E000028` → `19/3E000158` | VERIFIED；恢复 PASS；删除后再次校验 PASS | 是 | **保留** |

attempt 的 `base.tar.zst`、`pg_wal.tar` 和 `backup_manifest` SHA-256 均与正式备份不同，并且 WAL 范围更早。它不是无效或字节重复副本，而是独立恢复点。删除它会减少恢复选择，违反“存在恢复价值则保留”的硬门槛。

## 已执行删除

| 删除路径 | 文件数 | 逻辑大小 | 观测释放 | 删除依据 |
|---|---:|---:|---:|---|
| `C:\PostgreSQL_restore_test\2026-08-10` | 9,469 | 16.068 GiB | 约 16.069 GiB | restore PASS、实例停止、55432 未监听、无进程引用、正式 VERIFIED 备份完整 |

删除后：

- C 盘可用：97.201 GiB。
- 恢复日期目录已不存在；父目录 `C:\PostgreSQL_restore_test` 保留。
- 删除审计：`D:\PostgreSQLBackups\cleanup-audit\restore-test-cleanup-20260810-112331.json`。
- 正式基础备份删除后重新执行全清单/哈希验证：PASS。
- WAL 删除：false。
- 生产数据库修改：false。

专用清理脚本为 `scripts/postgres-backup/remove_restore_test.ps1`。它要求精确目标确认，并拒绝删除根目录、重解析点、正在监听的测试实例、有进程引用的目录、证据不完整的副本或正式备份缺失时的副本。

## WAL 生命周期 V2

当前 5,107 个加密 WAL 段占 79.797 GiB，最早时间为 2026-08-06 19:13:55 CST。当前 7 天截止点为 2026-08-03 11:24:27 CST，达到 7 天的段为 0。

因为第一次 attempt 被保留，最老恢复边界必须使用 `00000001000000190000003C`，而不是只使用正式备份的 `...3E`：

- 边界之前：5,104 个、79.750 GiB；目前均未满 7 天。
- `...3C` 到 `...3E` 之前：2 个、0.031 GiB；为保护较早恢复点后的连续恢复能力而保留。
- 当前“早于 7 天”与“早于最老恢复边界”的交集：0 个、0 GiB。

完整建议见 `docs/reports/postgresql-wal-cleanup-recommendation-v2.md`。最早文件从 2026-08-13 19:13:55 CST 起才逐步满足 7 天条件，届时仍需重新生成具体批次并人工确认。计划任务不会自动删除 WAL。

## 长期策略检查

| 项目 | 当前状态 |
|---|---|
| Base Backup 周任务 | `CommerceOpsPostgreSQLBaseBackupWeekly`，Ready，下次 2026-08-16 03:00 |
| Restore Test 周任务 | `CommerceOpsPostgreSQLRestoreTestWeekly`，Ready，下次 2026-08-16 05:00 |
| 正式保留数量 | 最新 4 个 VERIFIED 周备份 |
| Base 自动清理 | 关闭 |
| WAL 保留 | 7 天 |
| WAL 监控 | 每 15 分钟 |
| WAL 阈值 | 50 GiB WARNING；80 GiB CRITICAL |
| WAL 自动删除 | 关闭；需要 VERIFIED backup、restore PASS 和人工确认 |

当前机制可以阻止静默误删，但不能在无人响应告警时自动阻止 WAL 无限增长。当前距离 80 GiB CRITICAL 很近，应在第一批文件达到 7 天后及时执行人工候选审查。

每周恢复测试会生成新的 C 盘恢复副本，并默认保留。应在每次 PASS 且实例停止后运行受保护的清理流程，避免 C 盘按周累积约 16 GiB；不建议绕过证据门槛做通用目录清空。

## 清理后系统状态

- 正式 PostgreSQL 18.4：监控 PASS。
- provider：`postgres`；正式运行检查 PASS，writes=0、externalCalls=0。
- 连接使用率：2%；阻塞会话 0、长事务 0、等待锁 0、死锁 0。
- archive_mode：on；archived_count 5,109；failed_count 0。
- Commerce Ops：3101 `/api/health` 返回 HTTP 200 和 `{"ok":true}`；4173 正常。
- `CommerceOpsRuntime` 已改用带持久日志和最多三次异常重试的受管入口。连续两段约 90 秒观察期间任务保持 Running、调度器 1 个、事件日志无 EXIT。
- 55432：未监听。
- 旧 C 盘项目 Junction：无进程引用；运行进程来自 `D:\Projects\commerce-ops`。

## 下一阶段建议

1. **公司主机迁移**：在公司主机部署 PostgreSQL，使用新物理基础备份加连续 WAL 做一次完整迁移演练；切换前后验证表数、核心业务行数、LSN 和应用 provider。
2. **NAS 备份**：采用 PostgreSQL 主机 → NAS 的第二份加密、不可变备份，不把开发电脑上的同盘备份当成异地容灾；定期从 NAS 独立恢复。
3. **数据生命周期**：明确四类保留窗口——4 份周基础备份、7 天 WAL、30 天逻辑备份、恢复测试副本 PASS 后受保护清理；每月审计实际占用与恢复成功率。
4. **容量保护**：CRITICAL 告警应升级为人工值守事项；达到阈值时先生成严格候选清单，不直接按容量删除。

## 验收映射

- PostgreSQL 正常运行：PASS。
- Commerce Ops 正常访问：PASS。
- 正式 Base Backup 保留并在删除后重新校验：PASS。
- 恢复能力不受影响：PASS。
- 删除均有依据和 JSON 审计：PASS。
- WAL 未经确认删除：PASS，删除 0。
