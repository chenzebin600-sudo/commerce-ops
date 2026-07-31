# Mabang inventory export contract

## Scope

- Open `商品 > 库存查询` and initialize the default unfiltered search.
- Read the result count from the inventory pagination response.
- Read the stock summary when available; a summary failure does not invalidate detail export.
- Download the official inventory XLSX export.
- Split results into numbered export pages when the count is 10,000 or greater.
- Require the total parsed detail rows to equal the displayed result count.

## Required output fields

The official export must contain:

`库存SKU编号`, `商品状态`, `活跃度`, `是否新款`, `一级目录`, `二级目录`, `三级目录`,
`一级品牌`, `二级品牌`, `采购员`, `中文名称`, `英文名称`, `父级仓库`, `仓库`, `仓位`,
`销量(7/28/42)`, `预测日销量(个)`, `仓位库存`, `当前可售天数`, `在途量`,
`海外仓预调入量`, `分仓调拨预调入量`, `警戒量`, `警戒天数`, `未发货量`,
`分仓调拨未发货量`, `可用库存量`, `最后出库时间`, `最后入库时间`, `商品备注`.

## Normalization rules

- Skip rows without `库存SKU编号` or `仓库` and then enforce the total-row equality check.
- Normalize these fields as numbers when the source value is numeric:
  `预测日销量(个)`, `仓位库存`, `当前可售天数`, `在途量`, `海外仓预调入量`,
  `分仓调拨预调入量`, `警戒量`, `警戒天数`, `未发货量`, `分仓调拨未发货量`,
  and `可用库存量`.
- Preserve other source values and keep missing values blank.
- Do not infer locked stock from warehouse stock, available stock, unshipped quantity, or transfer quantities.

## Summary fields

Return these values when the Mabang summary endpoint provides them:

- `total`: total inventory quantity.
- `totalCost`: total inventory value.
- `inTransitTotal`: total in-transit quantity.
- `cacheUpdateTime`: source summary update time.

## Common failure meanings

- `登录需要人工验证`: Complete the approved authentication flow; do not bypass it.
- `未找到库存查询 iframe`: The page structure, tenant permissions, or route may have changed.
- `库存导出文件缺少字段`: The official export schema changed or the wrong endpoint was returned.
- `库存导出行数校验失败`: Do not use the file; investigate missing/blank SKU or warehouse rows, pagination, or export changes.
- Non-XLSX response: The session may have expired or the export endpoint may have returned a login/error page.

## Configuration

- Tenant site default: `https://900445.private.mabangerp.com`
- Private inventory service default: `https://private-amz.mabangerp.com`

Override these with `MABANG_BASE_URL` and `MABANG_PRIVATE_URL`. Never put credentials in this reference.
