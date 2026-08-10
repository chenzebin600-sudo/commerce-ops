# 乐聊 / ChatPlusAI 网页结构与自动化可行性

分析日期：2026-08-07（Asia/Shanghai）

## 结论

可以通过浏览器自动化读取消息。回复区是标准 `textarea` 或 `contenteditable` 时，Playwright 也可以只填入草稿并把最终发送权留给客服。

确认依据不是产品宣传，而是实际网页与当前生产前端包：

1. 官方站注册页的 Sign In 指向 `https://mai.zhisuitech.com/`。
2. 该地址返回可执行的 SPA，HTML 元信息标识“乐言跨境客服工作台”，当前前端版本 `9.59.6`，commit `3b7bbe101d6f5c784716904b761aabad17a154ce`。
3. 实际浏览器加载后进入 `https://mai.zhisuitech.com/#/login`，DOM 可被 Playwright 读取。
4. 登录页可稳定按可访问文本定位：`密码登录`、`验证码登录`、账号输入框 `请输入帐号/邮箱`、密码输入框 `请输入密码`、按钮 `登录`。
5. 当前生产 JavaScript 包中存在 `#/workbench/conversation` 会话工作台路由，并存在会话列表、会话详情、未读计数和消息同步代码。
6. 当前工作台自身使用的只读数据路径包括：
   - `/aggregation/v1/advanceQueryConversationList`
   - `/aggregation/v1/queryConversation`
   - `/oversea-conversation/v1/queryMessage`
   - `/oversea-conversation/v1/syncMessage`
   - `/notice/unread_count`
7. 前端模型中出现 `conversationId`、`storeId`、`buyerId`、`buyerNick`、`unreadCount`、`msgId`、`msgFromType`、`textContent`、`sendTime` 等可归一化字段。

因此，本阶段不需要乐聊官方开放 API：Playwright 登录同一网页，监听页面自身已经发起的响应，再用 DOM 点击未读会话触发详情加载即可。实现没有构造发送消息请求，也没有直接调用未公开接口。

`assist` 的写边界仅限回复编辑器：不会调用发送接口、不会点击发送按钮、不会模拟 Enter。由于未登录页面无法确认生产工作台的最终 CSS，`reply_editors` 已独立放入 `selectors.json`，首次真实登录后用 `probe` 校准命中。

## 页面结构

```text
https://mai.zhisuitech.com/
└── React SPA (#root)
    ├── #/login
    │   ├── 密码登录 / 验证码登录
    │   ├── 账号/邮箱
    │   ├── 密码
    │   └── 登录
    └── #/workbench/conversation
        ├── 会话列表（店铺、买家、未读数、预览）
        ├── 当前会话消息流
        └── 订单/商品/买家等侧边信息
```

当前页面使用 hash routing。登录后的精确 CSS 类名未作为合同，因为生产包使用编译/样式生成类名，更新后可能变化。

## 采集策略

按可靠性从高到低：

1. 监听页面自身会话列表/会话详情响应并解析 JSON。
2. 使用响应里的客户名匹配会话列表节点，点击未读会话以触发页面正常加载详情。
3. 使用 `data-conversation-id`、`data-talk-id`、`data-message-id` 等稳定属性读取 DOM。
4. 使用 `selectors.json` 中的结构选择器进行最后回退。

所有来源在写入 SQLite 前都归一化并按 `conversation_id + message_id` 去重；没有消息 ID 时使用内容、时间、方向与会话 ID 的 SHA-256 指纹。

## Session

Playwright 首次以 headed Chromium 打开登录页：

- 配置账号/密码时自动填写并点击登录。
- 验证码、CAPTCHA 或二次验证由用户在浏览器中完成。
- 登录成功后保存 Cookie、Local Storage 和 IndexedDB 到 `storage-state.json`。
- 后续 headless 采集复用 Session；失效时明确要求重新运行登录，不尝试绕过验证。

## 已知边界

- 本次没有用户账号，因此不能记录真实登录后客户消息 DOM 的最终 CSS 类；已通过生产包路由/数据代码和登录页实际 DOM 确认可行性。
- 乐聊前端可随时升级。版本变化后应先运行 `liaoliao probe`，再调整 `selectors.json`。
- 300 店规模可能需要分页、虚拟列表滚动和店铺分片。第一阶段实现单实例、有限批次和去重，先证明稳定采集与人工工作流；生产扩容应按账号/部门拆分采集进程，并使用集中任务锁。
- 本工具保存客户消息并可将上下文发送给所配置的 LLM；上线前需要确认账号授权、最小权限、数据保留期和跨境数据合规。
- “标记已处理”只更新本地 SQLite，不会改变乐聊未读状态，也不会发送回复。

## 公开参考

- 官方注册与登录入口：`https://chatplus.ai/pages/register`
- 官方工作台：`https://mai.zhisuitech.com/`
- 官方用户手册：`https://chatplus.ganjutech.com/wiki/en/`
