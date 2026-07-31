# Mabang order export contract

## Scope

- Filter by `paidTime`.
- Request all order statuses.
- Collect unique `platformOrderId` values from paginated order results.
- Fail instead of silently truncating when the result exceeds the configured page limit.
- Export in batches of at most 5,000 order IDs by default.
- Keep common order fields unmerged (`hbddgyxx=2`) and omit `mergeShow`.
- Prefer complete step-2 row data; fall back to step 3/4 XLSX generation and download.

## Required output fields

The exporter expects the configured template to contain:

`订单编号`, `交易编号`, `交运时间`, `物流渠道`, `店铺名`, `平台`, `店长`, `订单状态`, `仓库`,
`SKU总数量`, `所属地区（省/州）`, `所属城市`, `SKU`, `商品数量`, `商品库存`, `商品中文名称`,
`货运单号`, `付款方式`, `SKU明细`, `客户账号`, `客户姓名`, `邮寄地址1(按逗号分隔导出2列)`,
`商品销售单价`, `原始商品销售单价`, `商品总金额`, `原始运费金额`, `运费收入`, `原始商品总金额`,
`订单原始总金额`, `订单总金额`, `优惠金额（人民币）`, `优惠金额（原始货币）`,
`订单核算金额（人民币）`, `订单核算金额（原始货币）`, `汇率（原始货币）`, `订单商品名称`,
`采购在途量`, `付款时间`, `平台SKU`, `买家自选物流方式`, `最后发货期限`, `订单自定义分类`,
`发货时间`, `是否转WMS发货`, `退货原因`, `退货备注`, `作废时间`, `作废前状态`,
`电话1`, `电话2`, `订单备注`, `平台订单仓库`, `是否测评`, `测评费用`, `邮政编码`,
`tiktok样品订单`, `签收时间`, `实付金额`.

## Amount rules

- Normalize `商品总金额`, `原始商品总金额`, and `订单核算金额（原始货币）` as numbers when present.
- Accept numeric zero as a valid value.
- Require `商品总金额`.
- Convert a blank `原始商品总金额` to zero only when all of these fields are present and zero:
  `原始商品销售单价`, `商品总金额`, `订单原始总金额`, `订单总金额`, and
  `订单核算金额（原始货币）`.
- Preserve other missing values as blank.

## Common failure meanings

- `登录需要人工验证`: Complete the required authentication in an approved flow; do not bypass it.
- `导出文件缺少字段`: Update the selected Mabang template or its ID to include every required field.
- `金额字段存在空值`: Inspect the named order/SKU and source export instead of silently filling the value.
- `step1/step2/step3` failure: The private export contract, session, template, or server behavior may have changed.
- Non-JSON response: The session may have expired or the endpoint may now redirect to a login/error page.

## Configuration

- Tenant site default: `https://900445.private.mabangerp.com`
- Private export service default: `https://private-amz.mabangerp.com`
- Export template ID default: `1049202`

Override these with `MABANG_BASE_URL`, `MABANG_PRIVATE_URL`, and
`MABANG_EXPORT_TEMPLATE_ID`. Never put credentials in this reference.
