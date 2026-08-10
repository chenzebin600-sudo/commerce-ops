# PostgreSQL 物理基础备份报告

日期：2026-08-10（Asia/Shanghai）  
结论：**VERIFIED / PASS**

## 正式备份

- 目录：`D:\PostgreSQLBackups\base_backup\2026-08-10`
- PostgreSQL：18.4，在线物理集群备份，生产未停机
- 工具与格式：`pg_basebackup`、tar、客户端 Zstandard level 6
- WAL：`--wal-method=stream`
- 检查点：`--checkpoint=spread`
- 开始：2026-08-10 10:33:48 CST
- 完成：2026-08-10 10:44:01 CST
- 耗时：613.249 秒
- 总大小：3,056,616,142 bytes（2.847 GiB）
- 源 LSN 观测窗口：`19/3D000168` → `19/3F000168`
- 备份清单 WAL 范围：timeline 1，`19/3E000028` → `19/3E000158`

| 文件 | 字节 | SHA-256 |
|---|---:|---|
| `base.tar.zst` | 3,037,915,134 | `37EB84D78C68D1581AB9D422DF69A38F89C449C648887C70378C1543B303A573` |
| `pg_wal.tar` | 16,778,752 | `E8C2D2598DE812BB484AB1A0BCBC97F1FB7736AEB038988669C08CF523ABD6B4` |
| `backup_manifest` | 1,922,256 | `036507F9EC2688033448271A100A2B370F25B2878C27EE4439269DBBF625CA71` |

## 完整性验证

`pg_verifybackup --no-parse-wal` 返回 `backup successfully verified`，文件清单和 SHA-256 校验通过。tar 格式不能直接交给 `pg_waldump` 解析，因此 WAL 的端到端可用性由后续独立恢复启动测试验证；在恢复测试通过前，本报告不授权任何 WAL 删除。

元数据：`D:\PostgreSQLBackups\metadata\physical-base-backup-2026-08-10.json`  
日志：`D:\PostgreSQLBackups\logs\physical-base-backup-20260810-103348.log`

## 业务基线窗口

备份前后 `app` 普通表均为 141 张，`commerce_ops` 大小均为 7,665,530,559 bytes。六类核心数据在备份前后没有行数漂移：

| 领域 | 表 | 备份前 | 备份后 |
|---|---|---:|---:|
| orders | `app.growth_order_raw_rows` | 22,889 | 22,889 |
| products | `app.product_skus` | 76,114 | 76,114 |
| inventory | `app.product_inventory_snapshots` | 240,421 | 240,421 |
| tasks | `app.foundation_tasks` | 477 | 477 |
| agent_runs | `app.fulfillment_agent_runs` | 0 | 0 |
| audit_logs | `app.operation_audit_events` | 169,008 | 169,008 |

## 异常与保留证据

第一次完整复制因 tar 模式验证命令缺少 `--no-parse-wal` 而未生成 VERIFIED 元数据。产物没有被删除或覆盖，已可逆移动并保留在：

`D:\PostgreSQLBackups\base_backup\2026-08-10-unverified-attempt1`

该尝试随后也通过了清单/哈希验证，但因缺少同一次运行闭环采集的完成后业务基线，不作为本次正式恢复链入口，也不计入正式保留 4 份策略。

## 安全边界

- 未停止生产 PostgreSQL 或 Commerce Ops。
- 除只读基线查询、复制协议读取和正常检查点/WAL 活动外，未修改生产业务数据。
- 未删除、移动或改写 `D:\PostgreSQLBackups\wal` 中任何文件。
- 自动保留期清理未启用；所有删除仍需要恢复链验证和人工确认。
