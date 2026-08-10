# Lazada 库存同步脚本

脚本使用 `config/lazada-inventory-sync-shops.json` 中的一店多来源仓映射，按店铺、库存 SKU 汇总马帮可用库存，并为每个 SKU 保留 50 件安全库存。

计算公式：

```text
可同步库存 = max(店铺绑定来源仓库的总可用库存 - 50, 0)
```

同一店铺内，如果一个库存 SKU 被多个在线变体共用，可同步库存会确定性等分，避免重复放大库存。马帮快照不存在的 SKU 会被阻断，不会自动写成 0。

## 账号配置

在本地 `.env` 配置：

```text
LAZADA_INVENTORY_MABANG_USERNAME=
LAZADA_INVENTORY_MABANG_PASSWORD=
LAZADA_INVENTORY_MABANG_ACCOUNT_HOST=900445.private.mabangerp.com
```

未配置专用账号时，脚本会回退使用 `FULFILLMENT_MABANG_USERNAME` 和 `FULFILLMENT_MABANG_PASSWORD`。

## 预览

```powershell
npm.cmd run sync:lazada-inventory
```

预览不会写入库存。JSON 报告默认保存在 `storage/inventory-sync/lazada-reports/`。

## 执行

检查预览报告后执行：

```powershell
npm.cmd run sync:lazada-inventory -- --execute --confirm=CONFIRM_LAZADA_INVENTORY_SYNC
```

执行模式会重新读取一次来源库存，再生成最终计划。写入按最多 100 个商品、500 个变体分批串行提交，并使用马帮刊登服务的全局任务锁、并发原值检查和平台刷新回读。Shopee 正在写入时，Lazada 任务不会并行抢写。

脚本默认要求当前账号下每一家 Lazada 店铺都存在于配置中；发现未配置店铺会停止。临时排除未配置店铺时可显式增加 `--allow-unconfigured-shops`。
