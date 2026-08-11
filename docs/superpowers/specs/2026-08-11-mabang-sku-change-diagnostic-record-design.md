# 马帮 SKU 更换 409 诊断记录设计

## 目标

当马帮 SKU 更换返回 HTTP 409 或其他失败结果时，向网页提供足以判断“字段缺失、字段值不被接受、业务状态限制或写后回读异常”的脱敏详情，并把同一份诊断信息随执行记录持久化。页面断开或服务重启后仍可恢复查看。

本改动只增强可观察性，不改变 SKU 更换请求字段、不增加重试，也不授权新的真实订单写入。再次测试真实订单前必须单独确认。

## 诊断数据结构

每次 SKU 写入最多生成一份 `diagnostic`：

- `version`：固定为 `1`。
- `capturedAt`：ISO 时间。
- `stage`：`mabang_response`、`mabang_request_uncertain`、`readback` 或 `service_precheck`。
- `endpoint`：固定的接口标识 `order.doChanegOrderItem`，不保存带查询参数的完整 URL。
- `request`：只保存字段名和安全业务值：`orderItemId`、`stockId`、`type`。不保存请求头、Cookie 或认证信息。
- `response.httpStatus`：马帮 HTTP 状态；没有收到响应时为 `null`。
- `response.contentType`：裁剪到 80 字符。
- `response.success`：布尔值、数字或短字符串；其他类型不保存。
- `response.code`：从 `code`、`errorCode` 或 `status` 中提取的短标量。
- `response.message`：从 `message`、`msg` 或字符串型 `error` 中提取，去控制字符并限制 300 字符。
- `response.fieldNames`：马帮 JSON 顶层字段名，最多 30 个，每个最多 80 字符，用来判断响应契约是否变化。
- `response.bodyKind`：`json`、`non_json`、`no_response`。
- `response.textPreview`：仅在非 JSON 且不是 HTML 时保存最多 200 字符，并对 token、password、cookie、authorization 等模式脱敏；HTML 只记录 `bodyKind`、长度和内容类型，不保存正文。
- `verification`：`beforeSku`、`targetSku`、`afterSku`、`result`，其中 `result` 为 `target`、`original`、`other`、`missing` 或 `read_failed`。

任何未列入白名单的响应字段值都不得进入诊断记录。完整响应体、完整 HTML、堆栈、账号、密码、Cookie、Authorization 和请求头一律不保存。

## 数据传递

1. `scripts/mabang_order_source.py` 在唯一一次内部接口请求周围构造脱敏诊断，并在写后回读完成后补充 `verification`。
2. 成功时，诊断随 `result.writeResponse` 返回。
3. 失败时，使用带 `diagnostic` 属性的 SKU 更换异常；`scripts/mabang_worker.py` 将其输出为 `{ ok: false, error, code, diagnostic }`。
4. `lib/mabang-worker-runner.mjs` 只接收已经脱敏且通过结构校验的诊断，并挂到 Node `Error.diagnostic`。
5. `fulfillment-service/sku-replacement.mjs` 无论成功或失败，都在 `storage/sku-replacements/executions/<planHash>.json` 写入最终记录。失败记录包含状态、错误码、短消息和诊断。
6. `fulfillment-service/sku-replacement-batch.mjs` 把同一诊断复制到对应任务商品行；现有任务轮询接口因此可在页面断线后恢复详情。
7. 单项执行 API 的 HTTP 409 使用 `FulfillmentError.details.diagnostic` 返回诊断；批量执行从持久化任务项目返回诊断。

## 页面展示

在失败或人工核对的 SKU 商品行下显示可展开的“查看接口诊断”：

- 请求阶段和马帮 HTTP 状态。
- 请求字段：`orderItemId`、`stockId`、`type`。
- 马帮业务码和短错误消息。
- 返回字段名列表。
- 写后回读结果：原 SKU、目标 SKU、最终 SKU。

页面不显示空字段，也不提供原始响应下载。诊断内容按普通文本渲染，不使用 HTML 注入。

## 错误判定

- 马帮明确拒绝且回读仍为原 SKU：`FAILED`，显示马帮业务码和消息。
- 请求超时、登录失效、非 JSON、回读失败、商品行缺失或出现第三个 SKU：`MANUAL_REVIEW`，禁止重试。
- 马帮响应未确认但回读为目标 SKU：`COMPLETED`，诊断保留响应格式差异供后续适配。
- 履约服务在调用马帮前失败：`service_precheck`，明确标出没有发送马帮写入请求。

## 测试要求

采用测试驱动实现：

1. Python 单元测试证明只保留白名单字段，HTML、认证字段及过长内容不会落盘。
2. Python 行为测试覆盖明确拒绝、超时、非 JSON、目标回读、原 SKU 回读、第三 SKU 和回读失败。
3. Worker 测试证明 `code` 和 `diagnostic` 能透传，任意对象不能绕过诊断结构校验。
4. 服务测试证明单项 HTTP 409 含 `details.diagnostic`，失败执行记录会持久化。
5. 批量任务测试证明失败项包含诊断，服务重启后仍能恢复。
6. 前端类型与组件测试证明失败项能展开字段详情，文本经过框架转义。
7. 全量测试通过后，只部署记录功能；再次真实写入需要新的明确确认，并且仍然最多一次、禁止重试。

## 保留策略

诊断记录与现有 SKU 执行记录同生命周期，不建立独立日志文件，不延长现有业务历史保留时间。删除相应执行历史时，诊断随记录一并删除。
