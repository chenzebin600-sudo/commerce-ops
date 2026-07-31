# 马帮多店铺自动发货接口

当前店铺、国家、平台、物流渠道、仓库范围和店铺级自动开关由 `config/fulfillment-shops.json` 维护。初始配置覆盖同一马帮账号下的 5 个 Shopee 印尼店铺；全系统同一时间只执行一个真实发货批次。

第一阶段固定支持 Shopee 印尼站 `JOJO Mall`，每批最多 10 单，只预览“待处理”且信息完整的订单。预览需要一次性确认令牌，10 分钟失效。真实写操作默认关闭。

预览结果包含 `stockStatus`、`isOutOfStock`、`requiredQuantity` 和 `availableQuantity`。库存不足标记为 `OUT_OF_STOCK`，库存字段缺失或无法识别标记为 `INVENTORY_UNKNOWN`；这两类订单都不会进入可发货列表。

多 SKU 订单会按订单号合并：`skuCount` 是不同 SKU 的种类数，`totalItemQuantity` 是商品总件数。任意 SKU 缺货或库存未知都会阻止整单发货；预览只返回汇总数量，不暴露具体 SKU 字符串。

## 启动

在项目 `.env` 中配置：

```env
FULFILLMENT_HOST=127.0.0.1
FULFILLMENT_PORT=3112
FULFILLMENT_SHOP_CONFIG_PATH=config/fulfillment-shops.json
FULFILLMENT_API_TOKEN=
FULFILLMENT_MABANG_USERNAME=
FULFILLMENT_MABANG_PASSWORD=
FULFILLMENT_REAL_SUBMIT_ENABLED=false
FULFILLMENT_ORDER_CONCURRENCY=2
FULFILLMENT_SCHEDULER_ENABLED=true
FULFILLMENT_SCHEDULER_INTERVAL_SECONDS=300
FULFILLMENT_TRACKING_RECOVERY_CHECK_SECONDS=300
FULFILLMENT_TRACKING_RECOVERY_RESET_MINUTES=30
FULFILLMENT_TRACKING_RECOVERY_DEADLINE_HOURS=24
FULFILLMENT_TRACKING_RECOVERY_RESET_ENABLED=false
FULFILLMENT_AUTO_FULFILL_ENABLED=false
FULFILLMENT_AUTO_FULFILL_SHOP_IDS=2021578358,2021485965,2021621760,2021557966
```

只有 `FULFILLMENT_REAL_SUBMIT_ENABLED=true` 和 `FULFILLMENT_AUTO_FULFILL_ENABLED=true` 同时成立时，定时任务才会对名单内店铺自动创建真实发货批次。名单外店铺仍只生成预览。自动模式每个批次最多 10 单，缺货、库存未知、状态变化、已有运单号或固定物流渠道不可用的订单不会提交。

店铺还必须在配置文件中设置 `autoFulfillEnabled=true`，并同时存在于 `FULFILLMENT_AUTO_FULFILL_SHOP_IDS` 环境白名单，才允许真实自动发货。`allowedWarehouses` 为空时允许任意单一仓库；非空时只允许列出的准确仓库名称。完整字段和新国家接入步骤见 `docs/FULFILLMENT_SHOP_CONFIG.md`。

`FULFILLMENT_ORDER_CONCURRENCY` 只允许 `1` 或 `2`。设置为 `2` 时按双单波次执行：同一波最多两单同时运行，只有两单都成功才启动下一波；任一订单失败或需要人工处理，后续波次全部停止。正在运行的另一单可能已经提交，因此不会被强制中断或重复操作。

多店铺定时扫描使用一次账号级只读采集，再按稳定店铺 ID 和准确店铺名称隔离记录并分别生成预览，避免每个店铺重复登录和重复导出同一日期范围。共享采集失败时会自动退回原来的逐店扫描；该回退只影响速度，不改变库存、状态、渠道、幂等或真实提交检查。调度状态中的 `lastScanStrategy` 会显示 `shared_account_scan` 或 `per_shop_fallback`，`lastSharedCollectionMs` 是最近一次共享采集耗时。

运行 `npm run start:fulfillment`。

开发调试时运行 `npm run dev:fulfillment`。该模式会监听接口代码，保存文件后自动重启服务，无需重复按 `Ctrl+C`；修改 `.env` 后仍需手动重启一次。

启动后打开 `http://127.0.0.1:3112/docs`，即可在交互式 API 测试台中直接生成预览、查询预览、人工确认及查询批次。OpenAPI 3.0 定义位于 `http://127.0.0.1:3112/openapi.json`。

## 接口

- `GET /api/fulfillment/agent/status`，查看只读 Agent 是否启用、模型是否配置、提示词版本和工具白名单
- `POST /api/fulfillment/agent/chat`，请求体 `{ "message": "检查今天有没有发货异常", "conversationId": "可选会话ID" }`；Agent 只允许查询看板、调度状态、预览、批次和执行深度预检
- `GET /api/fulfillment/dashboard?days=7`，只读运营看板统计；按北京时间返回今日订单、成功/执行中/异常、店铺表现、耗时、趋势和当前恢复队列
- `POST /api/fulfillment/previews`，请求体 `{ "limit": 10 }`
- `POST /api/fulfillment/preflights`，请求体 `{ "orderId": "指定订单号" }`；执行全部底层检查但绝不提交
- `GET /api/fulfillment/previews/{previewId}`
- `POST /api/fulfillment/previews/{previewId}/confirm`
- `GET /api/fulfillment/batches/{batchId}`
- `POST /api/fulfillment/manual-reviews/recheck`，请求体 `{ "shopId": "店铺ID", "orderId": "订单号" }`；只重新核对并解除已修复订单的人工锁，不会立即提交发货
- `GET /api/fulfillment/tracking-recoveries`，查看跨店铺运单号审批恢复队列
- `POST /api/fulfillment/tracking-recoveries/check`，单笔受控真实测试使用 `{ "shopId": "店铺ID", "orderId": "指定订单号", "confirmation": "TRACKING_RECOVERY_CONFIRMED" }`；确认标记只授权这一单，不会开启全局自动清空

## 只读发货 Agent

第一阶段 Agent 复用项目现有 DeepSeek AI 网关。配置 `DEEPSEEK_API_KEY` 后即可按需调用；也可以通过 `FULFILLMENT_AGENT_ENABLED=false` 完全关闭。可选配置为：

```env
FULFILLMENT_AGENT_ENABLED=true
FULFILLMENT_AGENT_MODEL=deepseek-chat
FULFILLMENT_AGENT_MAX_STEPS=6
```

Agent 与现有自动发货调度器相互隔离。它不能调用 `/scheduler/scan`，因为该接口在生产开关开启时可能自动创建真实批次；Agent 的“检查订单”只会按店铺生成预览。工具层不包含确认发货、领取确认令牌、运单恢复、留言恢复、渠道清空、配置修改或开关修改能力，预览返回的确认令牌也会在进入模型前移除。

每次 Agent 运行只在 `fulfillment_agent_runs` 中保存运行 ID、会话 ID、模型、步骤数、工具名称与参数字段名、状态和错误码。用户原始消息、模型最终答复、工具结果、订单号参数值和密钥不会写入该审计表。短期对话上下文仅保存在当前服务进程内，重启后清空。

主系统 `http://127.0.0.1:3101/#fulfillment` 的“发货任务”页通过本机只读代理展示恢复队列。它只读取状态，不暴露恢复写操作，适合日常观察审批中、重新交运后等待、恢复成功和需要人工处理的订单。

确认请求体为 `{ "confirmationToken": "预览接口返回的一次性令牌" }`。人工确认接口继续保留；自动模式只对配置名单内的店铺使用内部一次性令牌，并执行与人工确认完全相同的提交前复检和逐单回查。

提交前会再次校验店铺、平台、待处理状态和空运单号；提交后轮询订单状态、固定渠道和运单号。任何一项不一致都会停止或标记为需要人工处理。

Shopee 已接受交运但暂未返回运单号时，订单进入持久化恢复队列。系统默认每 5 分钟逐单回查；当 `FULFILLMENT_TRACKING_RECOVERY_RESET_ENABLED=true` 时，超过 30 分钟仍无运单号的订单会再次确认店铺、平台、待处理状态、空运单号、库存有货以及既有交运记录，然后调用马帮“批量修改订单”的空物流渠道动作。清空成功会先记录不可重复状态，再按固定物流渠道重新交运一次。第二次交运不会再次清空或再次提交；取得运单号后转入“配货中”，超过 24 小时或任何写操作结果不确定时转人工处理。该真实写操作开关默认关闭，须完成一笔受控验证后再开启。

恢复过程中的 `ready_to_resubmit` 表示渠道已清空、等待唯一一次重新交运；`resubmitting` 表示请求可能在途，服务重启后只回查马帮现状，不会盲目重发；`waiting_after_reset` 表示重新交运已接受并继续等待运单号。这三种状态都由数据库保存，电脑或服务重启不会丢失。

看板接口直接按稳定 `orderKey` 从数据库全量统计，在所选时间范围内同一订单只采用最新一次执行结果。当前处于运单恢复队列的订单归类为执行中；已经完成但仍出现在扫描结果里的订单不计入异常。接口只读，不会触发扫描、清空渠道或真实发货。

批次查询结果包含 `timings`。批次级记录提交前整批复检、逐单执行和总耗时；订单级记录安全准备、交运请求、等待运单号、转配货请求、状态回查及逐单总耗时，单位均为毫秒。该数据用于判断后续并行优化应落在哪个阶段。

真实基线、阶段耗时和并发验收标准见 `fulfillment-service/PERFORMANCE.md`。

真实提交前会读取马帮“批处理功能 → 批量修改订单 → 设置物流渠道”弹窗中的渠道列表，并精确匹配固定渠道 ID `1143663` 及完整渠道值。列表读取失败或不存在该渠道时返回 `CHANNEL_NOT_AVAILABLE_BEFORE_SUBMIT`，不会调用交运提交接口。交运弹窗接口仅用于确认目标订单仍可交运，不再作为渠道列表来源。

马帮订单原始库存标志中 `0` 表示有货、`2` 表示缺货、`3` 表示同一订单中的 SKU 分属不同仓库并需要进入待审核处理。任一标志为 `2` 时停止提交；标志为 `3` 或预览检测到多个仓库时标记为 `MULTI_WAREHOUSE_REQUIRES_REVIEW`；标志缺失或出现其他未识别值时按库存未知停止，不作乐观推断。

人工换仓完成后，马帮可能仍保留订单级 `hasGoods=3`。系统不会直接忽略该标志：只有最新指定订单导出明细确认所有 SKU 属于同一个仓库、商品库存正常，并且商品级标志为有货时，才把残留的 `3/0` 组合视为已人工修复；真正仍包含多个仓库的订单继续拦截。该单仓证明会同时传入深度预检和真实执行器，缺失时禁止提交。

如果订单在真正提交前返回 `INVENTORY_UNKNOWN_BEFORE_SUBMIT`，该订单会进入 `needs_attention` 人工处理状态并建立幂等锁。后续定时扫描不会再次提交或重复提醒这笔订单，但同店铺其他正常订单继续自动处理。确认马帮库存标志含义并修复规则前，不得把未知值直接当作有货。

多仓订单同样会进入 `needs_attention` 并保持幂等锁。人工在马帮“待审核”中完成换仓并把订单恢复为“待处理”后，可以调用人工复核接口。系统会重新检查订单状态、单一仓库、库存、空运单号和固定物流渠道；全部通过时只解除本地人工锁，订单由下一轮正常扫描重新进入发货流程。任何检查未通过时保留原锁，防止重复提醒和误发货。

定时任务会自动复核 `MULTI_WAREHOUSE_REQUIRES_REVIEW` 和 `INVENTORY_UNKNOWN_BEFORE_SUBMIT` 两类人工锁。订单必须连续两轮通过待处理、单一仓库、库存、空运单号、固定物流渠道及交运参数检查；任一轮失败会把计数清零。第二轮通过后只解除锁并把历史订单状态记为 `released`，不会在同一轮提交；下一轮扫描才允许重新进入发货。`VERIFY_FAILED`、运单号获取中或重启恢复产生的不确定订单不参与自动解锁，避免重复交运。调度状态中的 `lastManualRecoveries` 可查看最近一次自动复核的第 1/2 轮、已释放和继续保留结果。

每次任务都会主动登录并验证登录后的订单页面。只读请求遇到会话失效会自动重新登录一次；真实交运提交绝不因登录失效自动重试，以避免重复发货。验证码或风控验证会返回明确的 `MABANG_CAPTCHA_REQUIRED`，需要人工处理。

确认后先对整批订单重新读取库存；任意订单缺货、库存未知或库存快照变化，整批会在第一单提交前停止。执行过程中每单提交前再次读取；某单失败后，后续未提交订单标记为 `SKIPPED_AFTER_BATCH_FAILURE`，已成功订单不会自动撤销或重复提交。

指定订单预览可使用 `{ "orderIds": ["马帮订单编号或Shopee交易编号"] }`，每次最多 10 个。设置 `orderIds` 后不会自动选择其他订单；未找到或不是“待处理”的订单会以 `ORDER_NOT_FOUND_OR_NOT_PENDING` 出现在排除列表中。
