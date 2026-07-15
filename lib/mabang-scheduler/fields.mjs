export const ORDER_FIELD_CATALOG = [
  ["uq101", "订单编号"], ["uq102", "交易编号"], ["uq219", "交运时间"], ["uq128", "物流渠道"],
  ["uq135", "店铺名"], ["uq205", "平台"], ["uq172", "店长"], ["uq136", "订单状态"],
  ["uq137", "仓库"], ["uq202", "SKU总数量"], ["uq108", "所属地区（省/州）"], ["uq109", "所属城市"],
  ["uq119", "SKU"], ["uq121", "商品数量"], ["uq142", "商品库存"], ["uq158", "商品中文名称"],
  ["uq130", "货运单号"], ["uq268", "付款方式"], ["uq254", "SKU明细"], ["uq103", "客户账号"],
  ["uq104", "客户姓名"], ["uq257", "邮寄地址1(按逗号分隔导出2列)"], ["uq122", "商品销售单价"],
  ["uq123", "原始商品销售单价"], ["uq124", "商品总金额"], ["uq125", "原始运费金额"],
  ["uq126", "运费收入"], ["uq146", "原始商品总金额"], ["uq147", "订单原始总金额"],
  ["uq148", "订单总金额"], ["uq244", "优惠金额（人民币）"], ["uq245", "优惠金额（原始货币）"],
  ["uq251", "订单核算金额（人民币）"], ["uq252", "订单核算金额（原始货币）"],
  ["uq259", "汇率（原始货币）"], ["uq120", "订单商品名称"], ["uq233", "采购在途量"],
  ["uq115", "付款时间"], ["uq196", "平台SKU"], ["uq129", "买家自选物流方式"],
  ["uq258", "最后发货期限"], ["uq226", "订单自定义分类"], ["uq149", "发货时间"],
  ["uq316", "是否转WMS发货"], ["uq174", "退货原因"], ["uq206", "退货备注"],
  ["uq241", "作废时间"], ["uq267", "作废前状态"], ["uq105", "电话1"], ["uq106", "电话2"],
  ["uq113", "订单备注"], ["uq365", "平台订单仓库"], ["uq363", "是否测评"],
  ["uq340", "测评费用"], ["uq110", "邮政编码"], ["uq371", "tiktok样品订单"],
  ["uq443", "签收时间"], ["uq341", "实付金额"],
].map(([id, label]) => ({ id, label }));

export const ORDER_FIELD_BY_ID = new Map(ORDER_FIELD_CATALOG.map((field) => [field.id, field]));
export const ORDER_FIELD_BY_LABEL = new Map(ORDER_FIELD_CATALOG.map((field) => [field.label, field]));

export const PRIMARY_SCHEDULE_FILTER_IDS = [
  "uq115", "uq172", "uq135", "uq205", "uq108", "uq137", "uq136", "uq119", "uq128",
];

export function normalizeTaskFilters(filters) {
  if (!Array.isArray(filters)) throw new Error("订单筛选条件格式无效。");
  if (filters.length > ORDER_FIELD_CATALOG.length) throw new Error("订单筛选条件数量超过可用字段数。");
  return filters.map((filter, index) => {
    const fieldId = String(filter?.fieldId || "").trim();
    const field = ORDER_FIELD_BY_ID.get(fieldId);
    if (!field) throw new Error(`第 ${index + 1} 个筛选字段无效。`);
    const operator = ["equals", "contains", "notEquals", "notContains", "empty", "notEmpty"].includes(filter?.operator)
      ? filter.operator
      : "equals";
    const rawValues = Array.isArray(filter?.values) ? filter.values : [filter?.value];
    const values = [...new Set(rawValues.map((value) => String(value ?? "").trim()).filter(Boolean))].slice(0, 100);
    if (!["empty", "notEmpty"].includes(operator) && !values.length) {
      throw new Error(`请填写第 ${index + 1} 个筛选条件的值。`);
    }
    return { fieldId, field: field.label, operator, values };
  });
}

export function filtersForWorker(filters) {
  return normalizeTaskFilters(filters).map((filter) => ({
    field: filter.field,
    operator: filter.operator,
    values: filter.values,
    value: filter.values[0] || "",
  }));
}
