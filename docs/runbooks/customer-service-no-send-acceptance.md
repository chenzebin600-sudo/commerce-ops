# 客服中心“只填框、不发送”验收手册

版本：1.0  
日期：2026-08-08  
适用范围：Commerce Ops 客服控制面、共享产品知识、Reply Agent、乐聊 Playwright Edge 与多账号 Fleet。

## 1. 安全边界

- 第一阶段的终点是：AI 草稿进入正确乐聊会话的输入框，等待客服在乐聊中亲自检查和发送。
- 中央命令只有 `FILL_DRAFT`，契约固定为 `CS_FILL_DRAFT_V1`，`automaticSend` 必须为 `false`。
- Fleet 强制 `LIAOLIAO_HUMAN_SEND_ENABLED=false`，不会继承本机误开的旧兼容发送配置。
- Edge 执行前必须再次核对中央账号、乐聊会话、最新入站消息、契约版本和编辑器为空/同文；任一不一致即拒绝。
- 每个乐聊账号同时只能有一个中央主控租约；消息上报、命令拉取和结果回传必须携带同一账号及租约令牌，重复 Worker 在打开浏览器前失败关闭。
- 新账号由后端强制创建为 `OBSERVE_ONLY`，客户端传入更高模式也会被忽略。账号只能逐级升级：至少成功采集 1 条入站消息、Reply Agent 已配置、共享产品知识迁移就绪且至少发布 1 个经审核的 SUPPORT Release 后，才能进入 `SUGGEST_ONLY`；至少生成并由人工接受或编辑 1 条建议后，才能进入 `DRAFT_FILL`。全局 AI、全局 Draft Fill 与账号模式门禁均满足后，才允许创建填框命令；降级始终允许。
- AI 草稿还必须通过确定性质量门禁：模型证据 ID 必须真实存在，低于置信度阈值、退款/赔偿承诺、无依据时效/订单/库存/物流断言及未知运单号都不会自动回填。
- 本手册中的离线验收不登录真实乐聊、不调用真实平台写接口、不发送客户消息。

## 2. 离线验收

在仓库根目录执行：

```powershell
npm run verify:customer-service:no-send
```

该命令顺序验证：

1. 中央事件幂等、每会话独立排队、新消息淘汰旧建议、账户灰度和人工审核。
2. Product Knowledge 只允许已审核且已发布内容进入客服 Context。
3. 马帮订单、库存、Product Core、产品包和平台权威物流的确定性 Context 链接。
4. Node 生成的 `CS_FILL_DRAFT_V1` 与 Python Edge 消费契约一致，跨账号/旧消息/危险 safety 字段全部失败关闭。
5. Playwright 的普通草稿动作只调用编辑器 `fill()`；已有人工草稿时不覆盖。
6. 多账号清单为每个账号分配独立 Session、SQLite、日志、中央账号和 Worker，中央账号租约阻止跨机器重复主控。
7. Commerce Ops 客服页面通过 Vue/TypeScript 类型检查，展示置信度、质量阻断原因和人工反馈统计，且不暴露自动发送入口。
8. 人工修改或拒绝使用受控原因码；编辑幅度只保存非敏感数值指标，质量与实际输入/输出/总 Token 可按国家、类目、意图、风险、账号、店铺和模型分层查看。

验收成功时最后输出：

```json
{
  "ok": true,
  "acceptance": "CUSTOMER_SERVICE_NO_SEND_OFFLINE",
  "automaticSend": false,
  "realBrowserUsed": false,
  "realCustomerMessageSent": false
}
```

### 2.1 回复质量回放

示例金标契约位于 `contracts/customer-service/cs-reply-evaluation-v1.example.jsonl`。默认回放不会调用模型、不会消耗模型 Token，只验证候选回复经过质量门禁后是否符合期望风险、自动回填资格、必需/禁止标记和文案约束：

```powershell
npm run evaluate:customer-service:replies
npm run evaluate:customer-service:replies -- --dataset <匿名化的业务金标集.jsonl>
```

真实历史样本必须先去除客户姓名、电话、地址、账号和订单明文；每个 case 必须有唯一 `caseId` 和至少一个期望断言。模型或 Prompt 升级时，先在同一金标集生成候选结果，再用本命令比较；未经金标通过不得全量切换。

### 2.2 逐阶段只读上线检查

`CS_DEPLOYMENT_READINESS_V1` 只读取当前服务状态和账号放行证据，不修改数据库或浏览器。返回码 `0` 表示目标阶段满足；返回码 `2` 表示存在业务阻断；返回码 `1` 表示 API 或参数检查失败。

```powershell
# 迁移后、登录账号前：全局 AI 与回填必须关闭
npm run check:customer-service:rollout -- --target=observe

# 指定账号已采集消息，知识库已有已发布 SUPPORT Release，回填仍关闭
npm run check:customer-service:rollout -- --target=suggest --account-id=<中央账号ID>

# 指定账号已生成并人工审核建议，准备验证只填框、不发送
npm run check:customer-service:rollout -- --target=draft --account-id=<中央账号ID>
```

每个账号卡片同时显示三阶段进度、入站消息数、已生成建议数、已人工审核数和阻断原因。不得绕过禁用控件直接调用 API；API 使用同一门禁判定器并会再次拒绝不满足条件的升级。

### 2.3 匿名只读界面验收

在不连接正式数据库、真实乐聊账号或模型的前提下，可以启动客服页面专用夹具：

```powershell
# 终端 1：只监听 127.0.0.1；只接受 GET，任何写请求固定返回 405
npm run preview:customer-service:fixture

# 终端 2：让 Vue 开发服务器把 /api 代理到只读夹具
$env:VITE_API_PROXY_TARGET="http://127.0.0.1:3198"
npm run dev:vue -- --host 127.0.0.1 --port 4188
```

打开 `http://127.0.0.1:4188/vue-preview/index.html#/customer-service`。夹具只包含匿名合成账号，覆盖“观察阶段被阻断”“观察阶段可放行”“建议阶段被阻断进入回填”三个场景；不得把夹具数据当作真实业务数据。验收时应确认：

1. 全局条明确显示客服库、SUPPORT 知识版本、AI、输入框回填和“自动发送永久关闭”。
2. 三个账号的阶段、证据计数、阻断原因和按钮禁用状态一致。
3. 尝试点击唯一可放行按钮时，请求被只读夹具拒绝，账号阶段不变，并显示账号级错误。
4. 长弹窗可以滚动到新增账号表单和底部按钮；页面无横向溢出。
5. 匿名质量条显示已观察人工回复、摘要完全一致的 AI 原样采用量、首次响应 P50/P95、显式标记已处理率及处理耗时 P50/P95；这些是合成样本，只用于检查格式和布局。“已处理”不得解释为客户问题已确认解决。

夹具退出即丢弃全部状态，不写 SQLite/PostgreSQL，不创建浏览器 Session，不调用 LLM，也不会打开或发送任何乐聊消息。

## 3. 正式数据库与知识导入门（需业务负责人明确确认）

在任何正式写入前先确认数据库目标、备份和回滚点。当前需应用的领域迁移是 SQLite `033`、`035`，PostgreSQL Shadow 对应 `016`、`018`。不得只应用其中一半。

知识包先做只读计划：

```powershell
npm run product-knowledge:import -- --package outputs/shared-product-knowledge-20260808-001
```

计划输出的摘要必须为：

```text
1bc094f8f9458a978c2c9102bb36ce9ed5f119b16743ccbc176140bc5003881c
```

只有迁移和导入目标经确认后，才使用 `--apply --confirm-digest=<摘要>`。导入只是候选入库，不等于批准和发布；943 个冲突、160 条待读钉钉正文及未映射候选继续保持不可用于模型。

## 4. 单真实账号非发送验收

1. 主系统创建账号；确认无论创建请求如何填写，后端都将它固定为 `OBSERVE_ONLY`，且页面不能直接选择初始 AI/回填模式。
2. Edge 配置中央 URL、中央账号 ID、唯一 Worker ID 和 Worker Token。
3. 执行 `liaoliao login`，人工完成验证码；确认 Session 只在本机路径。
4. 执行 `liaoliao probe`，确认会话、消息、右侧面板和输入框选择器均唯一命中。
5. 执行 `liaoliao assist`，让一条测试/内部会话进入中央；核对消息正文、店铺、订单、物流、SKU、库存、知识证据。
   同时在另一 Worker 使用相同中央账号启动，确认其在打开浏览器前收到租约冲突；停止主 Worker 后确认租约可释放或到期接管。
6. 先确认未采集消息、知识迁移未完成或没有已发布 SUPPORT Release 时均无法切到 `SUGGEST_ONLY`；第 5 步成功采集且知识版本发布后运行 suggest 检查，再逐级切换，确认只生成建议、不填框；人工修改并保存反馈。
   分别模拟一次事实修正和一次拒绝，确认必须选择原因，质量分层中对应意图/国家的编辑、拒绝和修改幅度随之更新。
7. 先确认从 `OBSERVE_ONLY` 不能越级切到 `DRAFT_FILL`，且未审核建议时即使处于 `SUGGEST_ONLY` 也不能升级。完成至少一条接受或编辑审核、打开全局 Draft Fill 后，仅将该测试账号切到 `DRAFT_FILL`；确认草稿进入正确输入框，但不发送。人工检查后在测试会话中亲自发送：相同内容应显示“已观察到人工发送”，`SEND_OBSERVED` 必须通过草稿内容摘要精确关联；人工改成不同内容时不得错误关联为 AI 原样采用。
8. 在草稿未发送时制造同会话新消息，确认旧命令拒绝；再制造另一会话消息，确认它独立继续处理。
9. 完成后把账号降回 `SUGGEST_ONLY` 或 `OBSERVE_ONLY`。

任何测试都不得使用真实客户产生不可逆业务影响；优先使用内部测试买家或历史只读样本。

## 5. 多账号灰度

复制并编辑 `integrations/liaoliao-ai-assistant/fleet.example.json` 为本机 `fleet.local.json`。每个账号依次登录，然后启动 Fleet：

```powershell
liaoliao fleet validate --manifest fleet.local.json
liaoliao fleet login --manifest fleet.local.json --account <account-key>
liaoliao fleet assist --manifest fleet.local.json
liaoliao fleet status --manifest fleet.local.json
```

按 `1 → 5 → 30 → 全量` 扩容。单机最多 12 个可见浏览器，默认建议 4 个；超过上限按客服电脑拆 shard。同一账号可准备备用 Worker，但任何时刻只能由主控租约持有者运行。灰度期间必须观察错会话填入、Context 缺失率、低置信阻断量、建议采用/编辑/拒绝率、Worker 离线、Session 失效、租约冲突、队列 P95 和平台 API 错误率。
