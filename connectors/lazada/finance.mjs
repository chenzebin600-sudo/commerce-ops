const MAX_PAGE_SIZE = 100;
const MAX_ROWS = 100_000;

function required(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new TypeError(`${label} is required`);
  return normalized;
}

function optional(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function decimal(value) {
  const normalized = String(value ?? "").trim().replaceAll(",", "");
  if (!/^-?(?:\d+)(?:\.\d+)?$/.test(normalized)) {
    throw new TypeError(`Lazada finance amount is invalid: ${String(value).slice(0, 80)}`);
  }
  return normalized;
}

function transactionRows(payload) {
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.transactions)) return payload.data.transactions;
  if (Array.isArray(payload?.data?.transaction_details)) return payload.data.transaction_details;
  return [];
}

function accountTransactionRows(payload) {
  const data = payload?.data;
  const candidates = [
    data, data?.transactions, data?.account_transactions, data?.accountTransactions,
    data?.account_transaction_list, data?.accountTransactionList, data?.list,
    payload?.transactions,
  ];
  return candidates.find(Array.isArray) || [];
}

function compactDate(value, label) {
  const normalized = required(value, label);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) throw new TypeError(`${label} is invalid`);
  return normalized.replaceAll("-", "");
}

export function normalizeLazadaExpenseTransaction(row = {}, { currency = null, sourceWindow = null } = {}) {
  return {
    transactionDate: required(row.transaction_time ?? row.transactionTime ?? row.transaction_date ?? row.transactionDate, "transaction_time"),
    transactionType: required(row.type ?? row.transaction_type ?? row.transactionType, "transaction_type"),
    transactionSubtype: optional(row.sub_type ?? row.subType ?? row.transaction_sub_type ?? row.transactionSubtype),
    amount: decimal(row.amount),
    currency: optional(row.currency) || optional(currency),
    transactionNumber: optional(row.transaction_number ?? row.transactionNumber),
    remarks: optional(row.remarks ?? row.remark),
    sourceWindow,
  };
}

export function normalizeLazadaFinanceTransaction(row = {}) {
  return {
    transactionDate: optional(row.transaction_date || row.transactionDate),
    transactionType: optional(row.transaction_type || row.transactionType),
    feeName: required(row.fee_name || row.feeName, "fee_name"),
    amount: decimal(row.amount),
    statementNumber: optional(row.statement || row.statement_number || row.statementNumber),
    transactionNumber: optional(row.transaction_number || row.transactionNumber),
    orderNo: optional(row.order_no || row.order_number || row.orderNo),
    orderItemNo: optional(row.order_item_no || row.order_item_number || row.orderItemNo),
    sellerSku: optional(row.seller_sku || row.sku || row.sellerSku),
    lazadaSku: optional(row.lazada_sku || row.shop_sku || row.lazadaSku),
    paidStatus: optional(row.paid_status || row.paidStatus),
    orderStatus: optional(row.order_status || row.order_item_status || row.orderStatus),
  };
}

export class LazadaFinanceApi {
  constructor(client) { this.client = client; }

  async getTransactions(input = {}) {
    const startTime = required(input.startTime, "start_time");
    const endTime = required(input.endTime, "end_time");
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(input.limit) || MAX_PAGE_SIZE));
    let offset = Math.max(0, Number(input.offset) || 0);
    const records = [];
    const providerRequestIds = [];

    while (records.length < MAX_ROWS) {
      const payload = await this.client.request({
        path: "/finance/transaction/details/get",
        operation: "get_finance_transactions",
        parameters: { start_time: startTime, end_time: endTime, offset, limit },
      });
      const rows = transactionRows(payload);
      records.push(...rows.map(normalizeLazadaFinanceTransaction));
      if (payload.request_id) providerRequestIds.push(String(payload.request_id));
      if (rows.length < limit) break;
      offset += limit;
    }
    if (records.length >= MAX_ROWS) {
      const error = new Error("Lazada finance result exceeded the 100,000-row safety limit");
      error.code = "LAZADA_FINANCE_ROW_LIMIT_EXCEEDED";
      throw error;
    }
    return {
      records,
      page: { offset: Math.max(0, Number(input.offset) || 0), limit, count: records.length },
      providerRequestId: providerRequestIds.at(-1) || null,
      providerRequestIds,
    };
  }

  async getExpenseTransactions(input = {}) {
    const dateFrom = required(input.dateFrom, "date_from");
    const dateTo = required(input.dateTo, "date_to");
    if (dateFrom > dateTo) throw new TypeError("date_from must not be after date_to");
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(input.pageSize) || MAX_PAGE_SIZE));
    const sourceWindow = `${dateFrom}:${dateTo}`;
    const records = [];
    const providerRequestIds = [];
    let pageNum = 1;
    while (records.length < MAX_ROWS) {
      const payload = await this.client.request({
        path: "/finance/transaction/accountTransactions/query",
        method: "POST",
        operation: "get_expense_transactions",
        parameters: {
          start_time: compactDate(dateFrom, "date_from"),
          end_time: compactDate(dateTo, "date_to"),
          transaction_type: "Payment",
          page_num: pageNum,
          page_size: pageSize,
        },
      });
      const rows = accountTransactionRows(payload);
      records.push(...rows.map((row) => normalizeLazadaExpenseTransaction(row, {
        currency: input.currency,
        sourceWindow,
      })));
      if (payload.request_id) providerRequestIds.push(String(payload.request_id));
      if (rows.length < pageSize) break;
      pageNum += 1;
    }
    if (records.length >= MAX_ROWS) {
      const error = new Error("Lazada expense result exceeded the 100,000-row safety limit");
      error.code = "LAZADA_EXPENSE_ROW_LIMIT_EXCEEDED";
      throw error;
    }
    return {
      records,
      paginationComplete: true,
      page: { pageNum, pageSize, count: records.length },
      providerRequestId: providerRequestIds.at(-1) || null,
      providerRequestIds,
      sourceWindows: [sourceWindow],
    };
  }
}
