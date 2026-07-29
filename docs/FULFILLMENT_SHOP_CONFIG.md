# 自动发货店铺配置说明

店铺、国家、平台、物流渠道、仓库范围和店铺级自动发货开关统一维护在 `config/fulfillment-shops.json`。修改配置后需要安全重启自动发货服务。

## 配置结构

- `version`：当前固定为 `1`。
- `defaultShopId`：接口未指定店铺时使用的稳定马帮店铺 ID。
- `channels`：可复用的国家/平台物流渠道配置。
- `shops`：店铺与渠道、仓库范围和自动发货开关的绑定。

渠道字段：

- `profileId`：配置内部使用的稳定名称，例如 `id-shopee-jt-furniture`。
- `countryCode`、`platformId`：渠道适用的国家和平台。
- `channelId`、`channelProviderId`、`channelLogisticsId`：马帮稳定渠道标识。
- `channelValue`、`channelName`、`channelSource`：马帮真实交运请求使用的固定值。

店铺字段：

- `shopId`、`shopName`：马帮稳定店铺 ID 和准确店铺名称，必须唯一。
- `platform`、`platformId`、`countryCode`：店铺所属平台和国家。
- `channelProfileId`：引用 `channels` 中的渠道。
- `allowedWarehouses`：允许自动发货的准确仓库名称。空数组表示允许任意单一仓库；配置非空时，其他仓库会以 `WAREHOUSE_NOT_ALLOWED` 排除，并在真实提交前再次拦截。
- `autoFulfillEnabled`：店铺配置级开关。

## 自动发货双重开关

店铺只有同时满足以下条件才会真实自动发货：

1. `.env` 中 `FULFILLMENT_AUTO_FULFILL_ENABLED=true`；
2. 店铺配置中 `autoFulfillEnabled=true`；
3. 店铺 ID 位于 `.env` 的 `FULFILLMENT_AUTO_FULFILL_SHOP_IDS` 白名单。

任意一层关闭时，店铺只扫描或保留人工确认预览。新增店铺默认应设置为 `false`，完成深度预检和单笔真实验证后再同时开启配置开关和环境白名单。

## 新国家或新渠道接入步骤

1. 在 `channels` 增加经过真实页面核对的渠道配置。
2. 在 `shops` 增加店铺，并绑定对应 `channelProfileId`。
3. 保持店铺 `autoFulfillEnabled=false`，重启并确认 `/health` 中配置加载正确。
4. 使用指定订单完成预览、深度预检和单笔真实测试。
5. 验证运单号、渠道、仓库和“配货中”状态一致后，再加入自动发货双重开关。

服务启动会拒绝以下配置：重复店铺 ID/名称、重复渠道配置、未知渠道引用、国家或平台不匹配、无效 ID、错误 `channelValue`、无效仓库数组或不存在的默认店铺。校验失败时服务不会带着部分配置继续运行。
