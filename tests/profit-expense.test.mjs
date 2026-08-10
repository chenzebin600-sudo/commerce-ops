import assert from "node:assert/strict";
import test from "node:test";
import { ShopeeFinanceApi } from "../connectors/shopee/finance.mjs";
import {
  calculateLazadaDailyExpenses,
  calculateShopeeDailyExpense,
  expenseTransactionDate,
} from "../lib/profit/expense-calculator.mjs";

test("expense dates preserve provider-local JavaScript date strings", () => {
  assert.equal(expenseTransactionDate("Mon Jul 27 2026 00:00:00 GMT+0800 (中国标准时间)"), "2026-07-27");
  assert.equal(expenseTransactionDate("Tue Jul 28 2026 00:00:00 GMT+0700"), "2026-07-28");
});

test("Lazada expense reconciles S-NAIDE and removes only the cross-window duplicate", () => {
  const advertisingRows = Array.from({ length: 37 }, (_, index) => ({
    sourceWindow: "account:2026-07-27:2026-08-07",
    transactionDate: `2026-08-${String(1 + (index % 7)).padStart(2, "0")}T10:00:00+07:00`,
    transactionType: "Payment",
    transactionSubtype: "Sponsored Solutions Top-up",
    amount: "-107.00",
    currency: "THB",
    transactionNumber: `AD-${index}`,
  }));
  const duplicate = {
    transactionDate: "04 Aug 2026",
    transactionType: "Other Services-Marketing Fees",
    feeNameRaw: "Sponsored Affiliates",
    amount: "-213.37",
    statementNumber: "04 Aug 2026 - 04 Aug 2026",
    transactionNumber: "AFF-1",
    orderNo: "ORDER-1",
  };
  const result = calculateLazadaDailyExpenses({
    shop: { id: "lazada:th:s-naide", country: "TH", currency: "THB" },
    dateFrom: "2026-07-27",
    dateTo: "2026-08-07",
    advertisingRows,
    financeRows: [
      { ...duplicate, sourceWindow: "finance:w2" },
      { ...duplicate, sourceWindow: "finance:w3" },
      { ...duplicate, sourceWindow: "finance:w3", transactionNumber: "AFF-2", amount: "-1596.25" },
      { ...duplicate, sourceWindow: "finance:w3", transactionNumber: "AFF-R1", feeNameRaw: "Sponsored Affiliates Refund", amount: "128.95" },
      { ...duplicate, sourceWindow: "finance:w3", transactionNumber: "PREMIUM", feeNameRaw: "Premium Package", amount: "-999.00" },
    ],
  });
  assert.equal(result.aggregate.dataStatus, "COMPLETE");
  assert.equal(result.aggregate.advertisingExpenseSigned, "-3959");
  assert.equal(result.aggregate.billingExpenseSigned, "-1680.67");
  assert.equal(result.aggregate.sourceSignedTotal, "-5639.67");
  assert.equal(result.aggregate.expenseValue, "5639.67");
  assert.equal(result.aggregate.duplicateGroupCount, 1);
  assert.equal(result.aggregate.duplicateRemovedCount, 1);
  assert.equal(result.facts.length, 12);
});

test("Lazada expense includes the provider fee names behind Max marketing fees", () => {
  const base = {
    transactionDate: "04 Aug 2026",
    transactionType: "Orders-Marketing Fees",
    statementNumber: "04 Aug 2026 - 04 Aug 2026",
    sourceWindow: "finance:2026-08-04",
  };
  const result = calculateLazadaDailyExpenses({
    shop: { id: "lazada:ph:shop", country: "PH", currency: "PHP" },
    dateFrom: "2026-08-04",
    dateTo: "2026-08-04",
    financeRows: [
      { ...base, transactionNumber: "MAX-1", feeNameRaw: "Free Shipping Max Fee", amount: "-100" },
      { ...base, transactionNumber: "MAX-R1", feeNameRaw: "Reversal of Free Shipping Max Fee", amount: "20" },
      { ...base, transactionNumber: "PREMIUM", feeNameRaw: "Premium Package", amount: "-999" },
    ],
  });
  assert.equal(result.aggregate.dataStatus, "COMPLETE");
  assert.equal(result.aggregate.billingExpenseSigned, "-80");
  assert.equal(result.aggregate.expenseValue, "80");
  assert.equal(result.aggregate.billingRowCount, 2);
});

test("Shopee normal expense combines daily wallet and exact Summary components", () => {
  const result = calculateShopeeDailyExpense({
    shop: { id: "shopee:my:fine-nest", country: "MY", currency: "MYR" },
    dateFrom: "2026-08-08",
    dateTo: "2026-08-08",
    walletRows: [{
      transactionDate: "2026-08-08",
      transactionTabType: "wallet_wallet_payment",
      moneyFlow: "MONEY_OUT",
      amount: "-950.40",
      currency: "MYR",
      sourceWindow: "2026-08-08:2026-08-08",
    }],
    statement: {
      dateFrom: "2026-08-08",
      dateTo: "2026-08-08",
      summary: { SUMMARY_AMS_COMMISSION: "-79.06", SUMMARY_ADS_ESCROW_TOP_UP: "0.00" },
    },
  });
  assert.equal(result.aggregate.dataStatus, "COMPLETE");
  assert.equal(result.aggregate.advertisingExpenseSigned, "-950.4");
  assert.equal(result.aggregate.billingExpenseSigned, "-79.06");
  assert.equal(result.aggregate.expenseValue, "1029.46");
});

test("Shopee multi-day Summary is not assigned to an invented transaction date", () => {
  const result = calculateShopeeDailyExpense({
    shop: { id: "shop", country: "MY", currency: "MYR" },
    dateFrom: "2026-08-01",
    dateTo: "2026-08-08",
    statement: { dateFrom: "2026-08-01", dateTo: "2026-08-08", summary: {} },
  });
  assert.equal(result.facts.length, 0);
  assert.equal(result.aggregate.dataStatus, "PARTIAL");
  assert.deepEqual(result.aggregate.issues, ["SHOPEE_EXPENSE_REQUIRES_DAILY_STATEMENT"]);
});

test("Shopee wallet API splits at 15 local days and paginates to more=false", async () => {
  const calls = [];
  const finance = new ShopeeFinanceApi({
    async call(operation, input) {
      calls.push({ operation, input });
      const isFirstWindow = input.params.create_time_from === 1785513600;
      const isFirstPage = input.params.page_no === 1;
      return {
        providerRequestId: `request-${calls.length}`,
        data: { response: {
          more: isFirstWindow && isFirstPage,
          transaction_list: isFirstWindow && isFirstPage ? [{
            create_time: 1785513600,
            transaction_tab_type: "wallet_wallet_payment",
            money_flow: "MONEY_OUT",
            amount: "-1.25",
            transaction_id: "wallet-1",
          }] : [],
        } },
      };
    },
  }, { shopId: "1618749121", countryCode: "MY" });
  const result = await finance.getExpenseTransactions({ dateFrom: "2026-08-01", dateTo: "2026-08-20" });
  assert.equal(result.paginationComplete, true);
  assert.equal(result.records.length, 1);
  assert.deepEqual(result.sourceWindows, ["2026-08-01:2026-08-15", "2026-08-16:2026-08-20"]);
  assert.equal(calls.length, 3);
  assert.equal(calls.every((call) => call.operation === "get_wallet_transaction_list"), true);
  assert.equal(calls[0].input.params.page_size, 100);
});
