# Shopee Discount 折扣价匹配运行手册

## 1. 交付边界

系统按 `国家 + SKU + platform=SHOPEE` 匹配数仓控价，为 Shopee Discount 活动生成不可变预览。运营必须查看差异、输入姓名和页面给出的完整确认语句，再批准并手动发起执行。系统不会自动识别 8.8、9.9 或 Payday，不会自动结束活动、删除重建变体，也不会在未确认时执行平台写入。

默认覆盖所选店铺全部在售商品（含零库存）；下架、禁售、删除和审核失败商品排除。单个异常变体只隔离自身。

## 2. 启动前配置与 fail-closed 门禁

后端 API 与调度器都必须显式配置，不能依赖默认开放：

- `SHOPEE_DISCOUNT_SCHEDULER_ENABLED=true`
- `SHOPEE_DISCOUNT_SCHEDULER_SHOP_IDS`：逗号分隔的精确 Shopee 店铺 ID，不允许空值、非法值或重复值。
- `SHOPEE_DISCOUNT_SHOP_TIMEZONES_JSON`：每个店铺对应一个有效 IANA 时区。
- `SHOPEE_DISCOUNT_WAREHOUSE_BASE_URL`：必须是 HTTPS 数仓地址。
- 数仓访问密钥必须通过现有加密设置保存；日志、API 和通知不得出现明文。
- `SHOPEE_DISCOUNT_DINGTALK_CONFIG_ID`：当前唯一的指定钉钉群机器人配置。
- `SHOPEE_DISCOUNT_ENTRY_BASE_URL`：运营进入折扣页的 HTTP(S) 地址。
- 外部任务共享 lease 必须处于 active；没有 lease 时调度器不运行。

环境变量只完成静态校验。根调度器在启动前还会执行只读探测：解密设置中必须存在可解析的数仓密钥引用、数仓必须接受该密钥、每个配置店铺必须存在且授权健康、指定钉钉配置必须存在并启用。探测不创建草稿、待办、通知或 Shopee 写；任一条件失败时返回安全原因码并保持关闭。HTTPS 地址只解析和规范化一次，根组件复用该结果。

任一条件缺失时 Shopee Discount 调度器保持关闭。根调度器只自动做扫描、草稿、系统待办和提醒，不注入执行器；平台写入仍必须由人工批准后的受控 worker 完成。

真实写还必须满足以下一种安全模式：

- `trusted_single_role`：完成受信单角色声明，且国家、店铺、批次范围均在声明内。
- `separate_execute_identity`：批准身份与执行身份分离，特权批准必须绑定同一 `planId + merkleRoot + policyHash + expiresAt`。

SQLite 仅允许 1 店、最多 10 变体试点；超过该范围必须使用 PostgreSQL。任何门禁、身份、HTTPS/签名能力或范围校验失败都必须拒绝写入。

## 3. 运营流程

1. 选择一个国家、店铺范围和默认价格档位 `DAILY`、`EVENT` 或 `MEGA`。
2. 如本期有临时需求，在当前方案中设置店铺级或链接级覆盖；优先级为链接 > 店铺 > 国家默认。覆盖不会自动延续到下一期。
3. 生成预览，检查数仓水位、异常率、缺价回退、目标价、原价冲突、活动冲突和排除数量。
4. 若目标价大于或等于 Shopee 原价，该变体会跳过并提醒运营考虑删除后重建变体；不要在此功能中改原价。
5. 确认预览未过期，输入运营姓名和页面给出的完整确认语句，批准精确 Merkle 根。
6. 手动发起执行。执行前系统会重新检查数仓、商品、活动和店铺授权漂移。
7. 查看运行明细。`SUCCEEDED`、`REQUIRES_REAPPROVAL`、`AUTH_BLOCKED`、`CONFLICT` 和 `UNKNOWN` 必须按变体处理，不能把部分成功当成整店成功。

续期默认无缝衔接 30 天；错过窗口时从最近可用时间开始，不补历史空档。大促结束后重新开始完整 30 天周期。系统在 T-24h、T-6h、T-1h 创建持久待办并向唯一钉钉群发送摘要；提醒失败不能改变方案或执行结果。

## 4. 上线阶梯

每一阶段至少连续三个批次满足门禁才进入下一阶段：

1. 只读：只扫描、预览和比较，不批准、不写入。
2. SQLite 试点：1 店、最多 10 变体。
3. PostgreSQL 小流量：10 店。
4. PostgreSQL 扩容：100 店。
5. 仅扩展到显式授权且健康的店铺，国家上限 1,000 店、单店 1,000 链接、单店 10,000 变体。

三个干净批次要求：无未协调 `UNKNOWN`，无跨店授权泄漏，无重复 POST，无数仓水位变化，异常率未越线，提醒去重正常，人工批准绑定一致。

生产预览按店铺串行读取并按确定顺序落不可变分片；常驻工作集上限为一个店铺的 10,000 个变体、一个仓库 SKU chunk 和一个审批分片，不保留国家级变体集合。所有档位共享同一数仓水位；分片根按店铺、商品、变体稳定排序，进程恢复时逐页核对已落分片。

使用 `npm run shopee-discount:capacity-check` 运行本地分页 dry-run。它会流式遍历锁定规模并报告实际观察总数、最大页、heap 增量和耗时，不连接 PostgreSQL、不执行 DDL。PostgreSQL 基准模式必须显式提供数据库配置和分页 source，禁止从环境中猜测凭证；每页必须返回 `items + total + nextCursor/end` 完整性证据，空页、提前结束、声明总数不符、重复或不前进 cursor 都会失败。

## 5. 停写阈值与应急开关

出现任一条件立即关闭真实写门禁，但保留只读查询与审计：

- 数仓不可用、水位在扫描中变化、结果异常为空、重复 SKU 冲突或批量旧审批率超过策略阈值。
- 授权或安全模式失效，签名/nonce/请求 ID 能力不满足要求。
- 出现跨店目标、批准根/策略漂移、活动目标漂移或站点金额精度变化。
- 同一操作疑似重复 POST，或 `UNKNOWN` 数量/年龄超过当班负责人批准的阈值。
- 数据库 lease/fencing 异常、迁移 checksum drift、Foundation 与领域状态不一致。

停写步骤：关闭真实写开关与部署专用执行 worker，保留 scheduler 的只读草稿/待办；等待在途请求超过最大超时；盘点 `DISPATCHED`/`UNKNOWN`；不要清表、改状态或重新排队原 intent。

## 6. UNKNOWN 协调

`UNKNOWN` 表示请求可能已经到达 Shopee，但官方结果尚未得到精确证明。它不是“失败后重试”。

- 重启或 worker 接管时只按原 `operation_uuid` 做官方回读，禁止再次 POST。
- `LINK_VERIFIED_OBJECT`：官方回读精确匹配活动、商品、变体、价格和原 operation 后关闭。
- `CONFIRMED_NOT_SENT`：仅接受官方或 relay 的确定性未发送证据；原 intent 仍不重新排队。
- `ABANDONED`：由运营明确接受风险并填写规范原因码后关闭。
- 如仍需执行，必须创建新的预览、operation UUID 和人工批准。
- 写后回读发生授权失败时保持 `UNKNOWN` 并为该店创建一条去重 HIGH 待办；其他店继续。

钉钉发送进入不确定状态时同样不得盲重发。先协调原通知 lease/结果，再由持久 due-job 决定后续动作。

## 7. 常见故障

- `WAREHOUSE_*`：停止批准；检查 HTTPS 地址、加密密钥、分页完整性、水位和审批时间。
- `SHOPEE_AUTH_ERROR`：暂停该店本轮后续写，重新授权后从可恢复状态继续；不要影响其他店。
- `REQUIRES_REAPPROVAL`：重新生成预览并人工批准，不修改旧预览。
- `SHOPEE_DISCOUNT_JOB_NOT_CLAIMED` / lease lost：确认旧 lease 到期和 fencing epoch；严禁手工绕过所有权。
- 钉钉失败：系统待办仍是权威来源；检查唯一群机器人配置，通知恢复后按去重键补发。
- 迁移 drift：停止部署，比较 migration 文件 checksum 和数据库 ledger；不得修改已应用迁移。

## 8. 数据库迁移与回滚

SQLite fresh、从 027 升级到 033、重复启动幂等均由自动化测试覆盖。PostgreSQL 本地 migration contract 覆盖 027、035–041；033/041 为 baseline 事件补充正规化 scope 列和复合索引，不修改旧迁移。在没有受控 PostgreSQL 实例时，只能报告“未执行 live DDL”。

迁移前备份数据库和文件清单并验证恢复。回滚时先停所有写 worker 和 scheduler，等待在途任务结束，保留 dispatch intent、事件和 `UNKNOWN` 证据；切回旧版本前确认旧代码能够读取当前 additive schema。不得删除活动、计划、intent 或审计记录来“恢复”。若 PostgreSQL 切回 SQLite，只允许在试点范围内写，其余保持只读。
