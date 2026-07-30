# 马帮 Lazada 在线商品修改接口（已验证到前端调用层）

> 状态：已从马帮当前 Lazada 刊登前端 `main.22e2b9f3.js` 与
> `chunk-3599.f3c80ef1.js` 验证接口名称和调用方式；尚未在目标账号、
> 目标店铺执行写入。

## 1. 商品列表

- 方法：`GET`
- 路径：`/kandeng/api/v2/common/online/list`
- Lazada 平台参数：`platformId=7`
- 商品 ID 搜索：`search_type=product_id`
- 其它主要参数：`page`、`page_size`、`shop_id`、`search_value`、
  `menu_type`

用途：按店铺和商品 ID 定位目标商品，并取得马帮刊登内部 `id`。

## 2. 在线商品详情

- 方法：`GET`
- 路径：`/kandeng/api/v2/common/online/detail`
- 参数：
  - `platformId=7`
  - `id=<马帮刊登内部 id>`

前端调用：

```text
lazadaOnlineDetailApi({ platformId: 7, id })
```

注意：这里的 `id` 不是 Lazada 商品 ID。必须先通过列表接口用
`product_id` 找到马帮内部 `id`。

## 3. 在线商品保存 / 更新

- 方法：`POST`
- 路径：`/kandeng/api/v2/common/online/save`
- 请求体：完整商品详情对象，不是只传修改字段的 PATCH。

SKU 相关字段位于：

```text
variations[].sku
variations[].sku_id
variations[].price
variations[].special_price
variations[].supply_price
variations[].stock
variations[].special_from_time
variations[].special_to_time
variations[].propert[]
variations[].package_length
variations[].package_width
variations[].package_height
variations[].package_weight
variations[].warehouse_stock[]
```

提交前前端还会：

- 把 `specialTime` 拆成 `special_from_time` 与 `special_to_time`；
- 删除临时字段 `specialTime`；
- 清洗图片 URL、描述和高亮内容；
- 添加 `is_save_and_publish`；
- 对在线商品调用 `lazadaOnlineSaveApi(fullProductBody)`。

因此批量修改的安全流程必须是：读取详情 → 仅修改已确认字段 →
保留其它字段原值 → 提交完整对象 → 查询列表/历史记录验证。

## 4. 其它相关接口

- SKU 存在性检查：
  `POST /kandeng/api/v2/lazada/online/vProduct/list`
- Lazada 修改历史：
  `POST /kandeng/api/v2/lazada/historyList`
- 下架：
  `POST /kandeng/api/v2/lazada/online/product/offline`
- 上架：
  `POST /kandeng/api/v2/lazada/online/product/online`
- 删除：
  `POST /kandeng/api/v2/lazada/online/product/delete`

## 5. 目标任务当前校验结果

- 当前登录操作员：`陈泽彬`
- 店铺：`3C pilot`
- Lazada 商品 ID：`16222622566`
- 马帮刊登内部 ID：`6480099`
- 目标 SKU ID：`127430020150`
- 目标 SKU：`T3CC1270045`
- 规格值：`2 pin plus`
- 当前库存：`999`
- 当前价格：`3116.00 THB`
- 当前促销价：`1718.00 THB`
- 当前包裹尺寸：`11.4 × 42.5 × 28 cm`
- 当前包裹重量：`3.81 kg`
- SKU 文本框在标准编辑页中为禁用状态，不能通过该编辑页直接改 SKU
- 尚未提交任何写入请求

建议的“目标变体所有数值字段 +1”解释：

| 字段 | 当前值 | 拟修改为 |
| --- | ---: | ---: |
| 库存 | 999 | 1000 |
| 价格 | 3116.00 | 3117.00 |
| 促销价 | 1718.00 | 1719.00 |
| 包裹长度 | 11.4 | 12.4 |
| 包裹宽度 | 42.5 | 43.5 |
| 包裹高度 | 28 | 29 |
| 包裹重量 | 3.81 | 4.81 |

规格值 `2 pin plus` 是文本枚举，不能直接按数值规则 `+1`；促销起止时间为空，
也不适用 `+1`。

## 6. 仍需在提交时验证的内容

- Lazada 卖家后台或公共商品页的独立回读结果

## 7. 2026-07-25 实际提交结果

- 用户已确认上表 7 项修改。
- 点击编辑页“更新”后，页面显示：`刊登信息更新成功！`
- 根据当前前端代码，只有保存响应 `code=200` 才会进入此成功分支。
- 此成功弹窗对应 `is_save_and_publish=1`。
- 保存接口：
  `POST /kandeng/api/v2/common/online/save`
- 保存对象内部 ID：`6480099`
- 保存后重新加载在线商品详情，7 项新值均已持久化。
- 刷新站点商品列表后，列表回读结果：
  - SKU：`T3CC1270045`
  - SKU ID：`127430020150`
  - 价格：`3117.00 THB`
  - 促销价：`1719.00 THB`
  - 库存：`1000`
  - 更新时间：`2026-07-25 12:00:55`
- 重新打开详情接口后回读：
  - 包裹尺寸：`12.4 × 43.5 × 29 cm`
  - 包裹重量：`4.81 kg`
- 其它变体的列表值和详情值保持不变。
- Lazada 公共商品页触发平台反自动化验证，因此未绕过验证，也未将
  公共前台页面作为独立成功证据。

## 8. 本地动态工作台实现

本地网页现通过 `mabang_listing_service.py` 连接上述接口，浏览器不直接
持有马帮令牌。

本地接口：

- `GET /api/health`：检查本地桥接服务和当前会话。
- `POST /api/session/login`：在内存中建立马帮会话。
- `GET /api/platforms`：读取平台、状态和已开放写入能力。
- `GET /api/shops?platform=lazada`：动态读取当前账号授权店铺。
- `GET /api/listings?...`：动态分页读取刊登商品。
- `POST /api/batch/preview`：逐商品读取最新详情并生成字段差异。
- `POST /api/batch/execute`：校验确认文字后创建串行同步任务。
- `GET /api/jobs/<job_id>`：查询提交和回读验证结果。

安全约束：

- 服务只绑定 `127.0.0.1`。
- 密码、刊登 token、`cKey` 和 `memcacheKey` 不写入文件，也不返回前端。
- 只有 Lazada 在线商品开放写入。
- 只允许修改已验证字段：价格、促销价、库存、包裹长宽高和重量。
- SKU 与规格修改请求会被服务端拒绝。
- 预览 15 分钟过期，执行前重新读取并比对原值，防止覆盖并发修改。
- 保存后重新调用详情接口，逐字段验证新值。
- 同一时间只运行一个写入任务，单次最多 100 个商品。

## 9. 2026-07-28 库存/售价快捷任务接口

马帮当前刊登控制台对 Lazada 和 Shopee 在线商品的库存、售价快捷修改，
使用平台专属的 local-online 接口：

- Lazada 库存：`POST /kandeng/api/v2/lazada/online/local/save/stock`
- Lazada 售价：`POST /kandeng/api/v2/lazada/online/local/save/price`
- Shopee 库存：`POST /kandeng/api/v2/shopee/online/local/save/stock`
- Shopee 售价：`POST /kandeng/api/v2/shopee/online/local/save/price`
- 任务状态：`GET /kandeng/api/v2/common/public/batch/process?batch_id=<batch_id>`

请求体不是压缩后的字段补丁，而是修改后的完整商品详情数组：

```json
[
  {
    "id": "马帮刊登内部 ID",
    "product_id": "平台商品 ID",
    "shop_id": "马帮店铺 ID",
    "variations": [
      {
        "sku_id": "平台变体 ID",
        "sku": "变体 SKU",
        "status": "原变体状态",
        "stock": 200
      }
    ]
  }
]
```

提交成功后从 `data.batch_id` 取得任务 ID。马帮前端每秒查询一次任务状态，读取：

- `data.data_num.total_num`
- `data.data_num.success_num`
- `data.data_num.fail_num`
- `data.data_error`

本地控制台对单字段库存/售价修改使用这条链路。只有响应包含
`data.batch_id` 才视为任务已创建；HTTP 200 但没有任务编号会立即失败，
不能再当作“马帮已受理”。马帮任务状态作为首要执行反馈，详情接口仅用于
最终值回读；某一商品失败不会覆盖其它商品的成功结果。

## 10. 2026-07-28 Shopee 多仓库存与平台回读

Shopee 多仓商品不能只修改变体顶层的 `stock`。马帮当前批量编辑器会：

1. 读取 `GET /kandeng/api/v2/shopee/online/detail/batch`。
2. 修改目标变体的 `warehouse_stock[].stock`。
3. 将所有仓库库存求和后写回变体顶层 `stock`。
4. 提交完整详情数组到
   `POST /kandeng/api/v2/shopee/online/global/save/stock`。

本地控制台遵循相同合同。若目标库存为 0，则所有仓库归零；若只有一个仓库
当前有库存，则修改该仓库并保留其它仓库为 0。多个仓库同时有库存时，系统
停止并要求明确仓库，不猜测库存分配。

马帮批次状态成功只代表马帮任务执行完成，不再直接作为店铺后台成功证据。
批次完成后，系统调用马帮在线商品“同步商品”能力，从平台重新拉取数据，再
校验总库存和仓库库存。只有平台刷新回读一致时，任务才标记为成功。
