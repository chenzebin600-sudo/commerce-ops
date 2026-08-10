# 乐聊 AI 辅助回复工具（第一阶段）

这是 Commerce Ops 客服中心的 Playwright 边缘节点。它访问乐聊 / ChatPlusAI 网页工作台，将未读客户消息和右侧面板观察结果同步到中央客服控制面；中央 Reply Agent 结合订单、库存、店铺、Product Core 和已发布的共享产品知识生成建议，再由该节点把建议写入唯一匹配的乐聊输入框，等待客服亲自检查和发送。断开中央配置时仍可使用原有本地模式。

中央模式没有发送逻辑。`FILL_DRAFT` 命令只调用编辑器的 `fill()`，不会点击发送按钮，也不会模拟发送快捷键；错误会话、旧消息、已有其他草稿或多义匹配都会拒绝执行。客服必须在乐聊输入框中亲自检查和发送。旧本地审核页的程序化发送兼容能力也默认关闭。

## 已实现

- 首次有头浏览器登录；可自动填写本机环境中的账号/密码，验证码或二次验证由用户完成。
- 保存并复用包含 Cookie、Local Storage 和 IndexedDB 的 Playwright `storage_state`。
- 进入 `#/workbench/conversation`，被动监听页面自身的会话/消息响应。
- 点击未读会话触发消息加载，并提供可配置的 DOM 选择器回退。
- 滚动虚拟会话列表触发分页加载，页数由 `LIAOLIAO_MAX_SCROLL_PAGES` 控制。
- 店铺、客户、会话、消息、AI 建议、采集批次和审计事件写入 SQLite。
- OpenAI-compatible `/chat/completions` LLM 适配；未配置 LLM 时仍可正常采集。
- `assist` 可见浏览器模式：消息进入 SQLite 持久队列，逐个打开会话、生成并填入草稿，随后立即切换下一会话，不等待前一条发送。
- 每个会话独立保护草稿；已有人工或 AI 草稿时只延迟该会话，不阻塞其他客户。
- 同一客户连续发来多段消息时，队列以该会话最新消息为准，旧任务标记为 `superseded`。
- 自动提取乐聊右侧可见的订单详情、物流状态和商品资料，作为生成建议的事实依据。
- 本地兼容模式可加载 `knowledge/` 中的政策；中央模式只使用 Product Domain 已审批、已发布的共享知识 Release，不信任边缘节点本地文件。
- 可选同步到 Commerce Ops 主系统客服中心；消息、路由和 Context 在中央数据库加密保存，浏览器 Session 与密码不离开客服电脑。
- 中央模式持续拉取只填入不发送的命令；执行前重新打开目标会话并核对账号、会话、最新入站消息和编辑器内容。
- 将订单、物流、商品和售后文本整理为结构化上下文，减少无关页面文字干扰。
- 生成阶段输出意图、风险和事实依据，再执行第二阶段质量复核；旧建议必须重新生成后才能进入批准发送。
- 保存 AI 原稿、人工修改和最终采用回复，相同店铺/场景后续可检索为高质量示例。
- 本地连续审核页支持编辑、重新生成、保存反馈和人工批准发送；低/中风险回复可用 `Ctrl+Alt+Enter`，高风险回复增加二次确认。
- 本地 Web 页面显示店铺、客户、原始消息、AI 回复建议，并可标记已处理。
- 文件轮转日志与数据库审计日志；日志不记录消息正文、密码或 API Key。
- `probe` 命令可在登录后记录选择器命中数与响应端点，不保存客户名或消息正文。

网页可行性与结构证据见 [docs/web-analysis.md](docs/web-analysis.md)。

## 项目结构

```text
liaoliao-ai-assistant/
├── app/
│   ├── browser.py          # Session、响应监听、DOM 回退、编辑器安全填充
│   ├── assistant.py        # 持久队列 → 上下文 → AI → 填入 → 切换下一会话
│   ├── knowledge.py        # 全局/平台/店铺政策加载
│   ├── extraction.py       # 乐聊响应/DOM 归一化与去重
│   ├── repository.py       # SQLite 数据访问与审计
│   ├── llm.py              # OpenAI-compatible 回复建议
│   ├── service.py          # 采集和建议生成编排
│   ├── web.py              # FastAPI 本地工作台
│   ├── cli.py              # init/login/collect/assist/probe/serve
│   ├── templates/
│   └── static/
│   ├── migrations/         # SQLite schema
├── tests/                  # 数据层、提取、LLM、Web 测试
├── knowledge/              # 可维护的客服政策知识库
├── selectors.json          # 可热调整的乐聊选择器
├── .env.example
└── pyproject.toml
```

## 安装

```powershell
cd D:\Projects\commerce-ops\integrations\liaoliao-ai-assistant
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e ".[dev]"
python -m playwright install chromium
Copy-Item .env.example .env
```

编辑 `.env`。账号和密码可以留空：执行首次登录后在浏览器里手工输入即可。若填写，它们仅由本机 Playwright 用于 `mai.zhisuitech.com` 登录页，不会写入 SQLite 或日志。

工具会复用仓库根目录已有的 `DEEPSEEK_API_KEY`、`DEEPSEEK_MODEL` 和 `DEEPSEEK_BASE_URL`。如需为乐聊单独指定模型，再配置：

```dotenv
LIAOLIAO_ACCOUNT=
LIAOLIAO_PASSWORD=
LIAOLIAO_LLM_BASE_URL=https://api.deepseek.com
LIAOLIAO_LLM_API_KEY=your-local-secret
LIAOLIAO_LLM_MODEL=your-model
```

## 首次运行

```powershell
liaoliao init
liaoliao login
liaoliao probe
liaoliao assist
```

`liaoliao assist` 会打开可见的乐聊窗口。工具把草稿留在各自会话后继续处理下一条；你在乐聊输入框中检查并手动发送。按 `Ctrl+C` 停止。

## 多乐聊账号隔离运行

每个乐聊账号必须使用独立的 Chromium Context、Session、SQLite、日志目录、中央账号 ID 和 Worker ID，不能复制或共用 `storage-state.json`。先复制示例清单：

```powershell
Copy-Item fleet.example.json fleet.local.json
```

`fleet.local.json` 只保存账号编排信息，不保存密码、Cookie 或 Worker Token。每个账号可选引用一个仅存在本机的 `envFile`；该文件可以保存登录账号等本机配置，但不得提交到 Git。中央 `CUSTOMER_SERVICE_WORKER_TOKEN` 继续由机器环境或模块 `.env` 提供。

依次为账号登录、校验并启动：

```powershell
liaoliao fleet validate --manifest fleet.local.json
liaoliao fleet login --manifest fleet.local.json --account th-home-01
liaoliao fleet assist --manifest fleet.local.json
liaoliao fleet status --manifest fleet.local.json
```

`fleet login` 一次只打开一个账号，避免把 Session 保存到错误目录；`fleet assist` 才会为所有 `enabled=true` 的账号启动独立可见浏览器并监督异常重启。Fleet 模式强制 `LIAOLIAO_HUMAN_SEND_ENABLED=false`，即使本机其他配置误开，也只允许中央 `FILL_DRAFT` 填框。

单台客服电脑的清单由 `maxProcesses` 限制为最多 12 个可见浏览器，示例默认 4 个。账号更多时应按客服电脑/边缘节点拆成多个 shard，而不是在一台机器堆叠数百个浏览器。运行状态写入 `runtime/fleet/fleet-status.json`；每个账号的数据位于 `runtime/fleet/<account-key>/`，互不共享。

中央模式会为每个乐聊账号签发短期主控租约。只有持有当前租约令牌的 Worker 能上报该账号消息、拉取或完成填框命令；第二台机器启动同一账号时会在打开浏览器前失败关闭。正常退出会主动释放，异常退出后最长等待租约过期即可由备用 Worker 接管。

## 接入 Commerce Ops 客服中心

先在主系统“客服中心”创建乐聊账号，取得中央账号 ID；主系统配置独立的 `CUSTOMER_SERVICE_WORKER_TOKEN` 后，在客服电脑的 `.env` 增加：

```env
COMMERCE_OPS_API_URL=http://127.0.0.1:3101
LIAOLIAO_CENTRAL_ACCOUNT_ID=主系统创建的账号ID
LIAOLIAO_WORKER_ID=customer-service-pc-01
CUSTOMER_SERVICE_WORKER_TOKEN=与主系统相同的独立工作节点密钥
```

四项同时存在才会启用中央模式。同步失败时本地采集继续运行并写告警日志；同一消息使用确定性事件 ID，重试不会在中央重复建消息或重复排队。中央同步不上传乐聊密码、Cookie 或 Playwright storage state。

主系统还有两层独立门禁，默认均关闭：

- 全局 `CUSTOMER_SERVICE_AI_ENABLED=true` 才启动 Reply Agent 队列；
- 全局 `CUSTOMER_SERVICE_DRAFT_FILL_ENABLED=true` 且具体账号模式为“生成并填入”，低风险建议才会创建 `FILL_DRAFT` 命令。

每个新账号默认“仅观察”。可在 Commerce Ops 客服中心依次切换为“只生成建议”和“生成并填入”。人工在主系统修改并点击“填入乐聊输入框”也会重新校验最新消息、会话与编辑器；任何模式都没有自动发送能力。

中央模式的真实流程是：

```text
乐聊新消息/右侧面板 → 加密入库 → 每会话独立队列 → Context Snapshot
→ Reply Agent → READY → FILL_DRAFT → 重新核对目标 → 只填入编辑器 → 人工发送
```

一条会话生成完成后会立即处理其他会话，不会等第一条被发送。同一会话出现更新消息时，仅淘汰该会话的旧建议和旧填入命令。

## 业务上下文与知识库

每次为队列任务生成建议前，边缘节点会保存并上报当前乐聊右侧面板快照。中央 Context Assembler 再合并最近对话、系统订单、库存、店铺绑定、Product Core、产品包和已发布的共享知识。乐聊面板里的物流仅标记为“页面观察、非权威事实”；上下文快照加密保存，不写入普通日志。

中央模式下，下面的本地 `knowledge/` 文件不会自动成为模型证据。共享知识必须经过“标准化候选 → 人工审核 → Release 发布”，客服与未来上架模块按不同 consumer scope 读取同一事实来源。

- 通用政策：编辑 `knowledge/global.md`。
- 平台政策：新增 `knowledge/platforms/shopee.md` 等文件。
- 店铺政策：在 `knowledge/shops.json` 中以乐聊显示的店铺名为键填写。
- 国家/地区政策：新增 `knowledge/regions/ph.md` 等文件。
- 商品资料：新增 `knowledge/products/<sku>.md`。
- 场景规则：新增 `knowledge/intents/delivery.md`、`refund.md` 等文件。
- 优质示例：写入 `knowledge/examples.jsonl`，或让系统从人工采用回复中自动积累。

知识库默认为空，避免虚构公司政策。填写内容应经过业务确认，并遵守客户数据和模型服务商的合规要求。

可选的本地记录页使用 [http://127.0.0.1:8876](http://127.0.0.1:8876)，不再占用马帮的 8765 端口：

```powershell
liaoliao serve
```

`liaoliao login` 会打开可见 Chromium；如果出现验证码或二次验证，请在窗口中完成。成功进入登录后的页面后，工具会自动保存 Session 并关闭该窗口。

## 定时采集

单进程启动并每 30 秒采集一次：

```powershell
liaoliao serve --auto-collect-seconds 30
```

也可在 `.env` 设置 `LIAOLIAO_AUTO_COLLECT_SECONDS=30`。采集有进程内互斥锁，不会在同一进程重叠执行。第一阶段建议保持单实例运行。

## 选择器校准

乐聊是持续发布的 SPA，CSS 类名可能变化。工具优先使用页面自身返回的数据；DOM 只用于点击未读会话和回退读取。若页面升级后采集为空：

1. 执行 `liaoliao probe`。
2. 查看 `runtime/probe.json` 的端点与选择器命中数。
3. 只修改 `selectors.json`，无需改 Python 业务代码。
4. 再执行 `liaoliao collect`。

`runtime/probe.json` 不包含客户名和消息正文。

## 本地数据与安全

- Session：`runtime/browser/storage-state.json`
- SQLite：`data/liaoliao.db`
- 日志：`logs/liaoliao.log`
- 探测：`runtime/probe.json`

以上路径均被本模块 `.gitignore` 排除。Session 等同于登录凭据，应只保留在受控客服电脑；怀疑泄露时应在乐聊退出会话并删除本地 Session 后重新登录。

LLM 会收到当前客户消息、最近对话、右侧订单/物流/商品面板及适用政策知识。请按公司数据政策选择模型服务商，并在上线前确认跨境客户信息的合规边界。

## 测试

```powershell
pytest -q
```

不需要真实乐聊账号的测试覆盖：响应归一化、消息去重、SQLite 状态流转、结构化上下文、双阶段质量检查、反馈学习、编辑器保护、旧批准失效、人工发送确认和 Web 页面。真实账号验收使用 `login → probe → assist`；本次升级只做非发送实机验证，未向任何真实客户发送测试消息。
