# Commerce Ops 014 纯治理 DRAFT 隔离演练报告

- 日期：2026-08-08
- 状态：PASS
- 演练库：`commerce_ops_unified_rehearsal`（演练结束后已删除）
- 生产写入：0
- 014 原始文件 SHA-256：`9cbddd86dfb7ce1da7ed0021a3a70a31988943ea742c6a7276d28e64aa62a5ec`
- 014 规范化定义 SHA-256：`a3e5a5f7efa5b15425d860019e1c815d031275cf888dc237707d9aa0d0facbad`

## 演练边界

演练从正式 PostgreSQL 仅导出 `app` schema，不复制业务数据。隔离库依次执行 013、记录基线、执行 014、同步 DRAFT 字段目录，并在每一步比较受保护对象。

| 检查 | 结果 |
|---|---|
| 事实/绑定表结构未变化 | PASS |
| 事实/绑定表行数未变化 | PASS |
| `app` 视图集合和定义未变化 | PASS |
| V2 views | 0 |
| backfill ledger relations | 0 |
| module bindings 未变化 | PASS |
| DRAFT contract 已物化 relation | 0 |
| 已发布 V2 contract | 0 |
| 014 重放 | 被明确拒绝 |
| 隔离库清理 | PASS |

受保护对象包括：`growth_order_headers`、`growth_order_lines`、`growth_inventory_snapshots`、`product_package_rows`、`product_sku_current_prices`、`commerce_shop_account_bindings`。

## DRAFT 治理目录结果

| 项目 | 数量 |
|---|---:|
| 数据源 | 6 |
| 数据集 | 8 |
| 现有 V1 canonical views | 8 |
| DRAFT source fields | 241 |
| DRAFT dataset columns | 233 |
| DRAFT field mappings | 241 |
| DRAFT identity rules | 6 |
| 物理目标只读校验 | 1 |

## 约束演练

以下 9 项正向/负向约束均通过：

1. mapping run 指纹必须为 64 位小写十六进制 SHA-256。
2. 平台+国家+名称匹配不能自动确认。
3. relationship rule 不能产生 identity candidate。
4. candidate 创建后不可更新或删除。
5. HUMAN_REQUIRED candidate 不能由 POLICY 审批。
6. 同一个 candidate 只能有一个 APPROVE 决策。
7. resolution 撤销时不能同时篡改证据或身份字段。
8. ACTIVE resolution 可以执行受限的合法撤销。
9. OPEN issue 不允许填写 `resolved_at`。

## 本次修复

- 014 增加 mapping 生命周期、运行指纹、运行完成状态、candidate key/rank、单次审批、resolution 不可变字段及 issue 状态闭合约束。
- candidate 和 resolution 都会在写入时重新验证目标实体；仓库必须处于 `confirmed`。
- 014 文件内保存规范化定义指纹；rehearsal 在连接 PostgreSQL 前即校验该指纹。
- rehearsal 从数量报告升级为 013 后基线对比，覆盖事实结构、事实行、视图定义、module bindings、V2/backfill 缺席和重复执行拒绝。
- PostgreSQL 本地化错误改用 SQLSTATE 验证，避免依赖中英文错误文本。

## 验证命令

```text
node --disable-warning=ExperimentalWarning scripts/rehearse-unified-data-foundation.mjs --confirm=CREATE_AND_DROP_ISOLATED_REHEARSAL
node --disable-warning=ExperimentalWarning --test tests/unified-data-foundation.test.mjs tests/unified-field-mappings.test.mjs
```

- isolated PostgreSQL rehearsal：PASS
- 相关单元测试：12/12 PASS
- `node --check`：PASS
- `git diff --check`：PASS

## 结论

014 现在只建立 DRAFT 治理合同、字段 crosswalk、identity preview/decision/resolution 目录；不会改事实表、不会创建 V2 查询视图、不会建立或执行物理 backfill，也不会切换模块合同。任何 V2 发布、API 绑定强化或事实回填仍必须使用后续独立迁移和单独审批窗口。
