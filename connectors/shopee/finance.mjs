import { ConnectorError } from "../base/errors.mjs";

const MAX_REPORT_BYTES = 64 * 1024 * 1024;
const PENDING_REPORT_TTL_MS = 6 * 60 * 60 * 1000;
const pendingReportsByRelay = new WeakMap();

function required(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new TypeError(`${label} is required`);
  return normalized;
}

function responseBody(call) {
  const data = call?.data?.response && typeof call.data.response === "object" ? call.data.response : call?.data;
  return data && typeof data === "object" ? data : {};
}

function reportId(payload) {
  return String(payload.id || payload.report_id || payload.income_report_id || "").trim();
}

function reportUrl(payload) {
  return String(payload.file_url || payload.download_url || payload.url || payload.file_link || "").trim();
}

function pendingReportStore(relayClient) {
  let store = pendingReportsByRelay.get(relayClient);
  if (!store) {
    store = new Map();
    pendingReportsByRelay.set(relayClient, store);
  }
  const expiry = Date.now() - PENDING_REPORT_TTL_MS;
  for (const [key, value] of store) {
    if (value.createdAt < expiry) store.delete(key);
  }
  return store;
}

function allowedDownloadUrl(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  const marketplaceHosts = [
    "shopee.com", "shopee.com.my", "shopee.co.th", "shopee.co.id",
    "shopee.ph", "shopee.sg", "shopee.vn",
  ];
  if (!(marketplaceHosts.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
    || host.endsWith(".shopeemobile.com") || host.endsWith(".shopeeusercontent.com")
    || host.endsWith(".susercontent.com"))) return null;
  return url;
}

async function downloadReport(fetchImpl, rawUrl, timeoutMs) {
  const url = allowedDownloadUrl(rawUrl);
  if (!url) throw new ConnectorError("Shopee income report download URL was rejected", {
    code: "SHOPEE_INCOME_REPORT_DOWNLOAD_URL_INVALID", status: 502, platform: "shopee",
  });
  const response = await fetchImpl(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new ConnectorError("Shopee income report download failed", {
    code: "SHOPEE_INCOME_REPORT_DOWNLOAD_FAILED", status: 502, retryable: response.status >= 500, platform: "shopee",
  });
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > MAX_REPORT_BYTES) throw new ConnectorError("Shopee income report is too large", {
    code: "SHOPEE_INCOME_REPORT_TOO_LARGE", status: 413, platform: "shopee",
  });
  const reader = response.body?.getReader();
  if (!reader) return Buffer.from(await response.arrayBuffer());
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_REPORT_BYTES) {
      await reader.cancel();
      throw new ConnectorError("Shopee income report is too large", {
        code: "SHOPEE_INCOME_REPORT_TOO_LARGE", status: 413, platform: "shopee",
      });
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

const COUNTRY_UTC_OFFSETS = Object.freeze({ MY: "+08:00", PH: "+08:00", TH: "+07:00", VN: "+07:00", ID: "+07:00" });
const COUNTRY_CURRENCIES = Object.freeze({ MY: "MYR", PH: "PHP", TH: "THB", VN: "VND", ID: "IDR" });
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_WALLET_ROWS = 100_000;

function unixStart(dateText, countryCode) {
  const offset = COUNTRY_UTC_OFFSETS[String(countryCode || "").toUpperCase()] || "+00:00";
  const value = Date.parse(`${required(dateText, "date_from")}T00:00:00${offset}`);
  if (!Number.isFinite(value)) throw new TypeError("date_from is invalid");
  return Math.floor(value / 1000);
}

function unixEnd(dateText, countryCode) {
  const offset = COUNTRY_UTC_OFFSETS[String(countryCode || "").toUpperCase()] || "+00:00";
  const value = Date.parse(`${required(dateText, "date_to")}T23:59:59${offset}`);
  if (!Number.isFinite(value)) throw new TypeError("date_to is invalid");
  return Math.floor(value / 1000);
}

function addDays(dateText, amount) {
  const date = new Date(`${required(dateText, "date")}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new TypeError("date is invalid");
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function walletRows(payload) {
  const candidates = [
    payload.transaction_list, payload.wallet_transaction_list, payload.transactions,
    payload.list, payload.data?.transaction_list, payload.data?.wallet_transaction_list,
  ];
  return candidates.find(Array.isArray) || [];
}

function localDateFromEpoch(value, countryCode) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) throw new TypeError("Shopee wallet create_time is invalid");
  const offset = COUNTRY_UTC_OFFSETS[countryCode] || "+00:00";
  const sign = offset.startsWith("-") ? -1 : 1;
  const [hours, minutes] = offset.slice(1).split(":").map(Number);
  return new Date(seconds * 1000 + sign * (hours * 60 + minutes) * 60_000).toISOString().slice(0, 10);
}

function walletAmount(value) {
  const normalized = String(value ?? "").trim().replaceAll(",", "");
  if (!/^-?(?:\d+)(?:\.\d+)?$/.test(normalized)) throw new TypeError("Shopee wallet amount is invalid");
  return normalized;
}

export function normalizeShopeeExpenseTransaction(row = {}, { countryCode, sourceWindow } = {}) {
  const createTime = Number(row.create_time ?? row.createTime);
  return {
    transactionDate: localDateFromEpoch(createTime, countryCode),
    transactionTime: new Date(createTime * 1000).toISOString(),
    transactionType: String(row.transaction_type ?? row.transactionType ?? "").trim() || null,
    transactionSubtype: String(row.transaction_subtype ?? row.transactionSubtype ?? row.description ?? "").trim() || null,
    transactionTabType: String(row.transaction_tab_type ?? row.transactionTabType ?? "wallet_wallet_payment").trim(),
    moneyFlow: String(row.money_flow ?? row.moneyFlow ?? "").trim(),
    amount: walletAmount(row.amount ?? row.transaction_amount ?? row.transactionAmount),
    currency: String(row.currency || COUNTRY_CURRENCIES[countryCode] || "").trim() || null,
    transactionNumber: String(row.transaction_id ?? row.transactionId ?? row.id ?? "").trim() || null,
    remarks: String(row.description ?? row.remark ?? row.remarks ?? "").trim() || null,
    sourceWindow,
  };
}

export class ShopeeFinanceApi {
  constructor(relayClient, {
    shopId,
    countryCode,
    fetchImpl = fetch,
    pollAttempts = 12,
    pollIntervalMs = 2_500,
    timeoutMs = 60_000,
    sleeper = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {}) {
    this.relayClient = relayClient;
    this.shopId = required(shopId, "shop_id");
    this.countryCode = required(countryCode, "country_code").toUpperCase();
    this.fetchImpl = fetchImpl;
    this.pollAttempts = Math.max(1, Math.min(60, Number(pollAttempts) || 12));
    this.pollIntervalMs = Math.max(100, Number(pollIntervalMs) || 2_500);
    this.timeoutMs = Math.max(5_000, Number(timeoutMs) || 60_000);
    this.sleeper = sleeper;
  }

  async getTransactions(input = {}) {
    const dateFrom = required(input.dateFrom, "date_from");
    const dateTo = required(input.dateTo, "date_to");
    const cacheKey = `${this.shopId}:${this.countryCode}:${dateFrom}:${dateTo}`;
    const pendingReports = pendingReportStore(this.relayClient);
    let pending = pendingReports.get(cacheKey);
    let payload = {};
    if (!pending) {
      const generated = await this.relayClient.call("generate_income_report", {
        shopId: this.shopId,
        params: {
          release_time_from: unixStart(dateFrom, this.countryCode),
          release_time_to: unixEnd(dateTo, this.countryCode),
        },
      });
      payload = responseBody(generated);
      const generatedReportId = reportId(payload);
      if (!generatedReportId) throw new ConnectorError("Shopee did not return an income report ID", {
        code: "SHOPEE_INCOME_REPORT_NOT_AVAILABLE", status: 403, platform: "shopee",
        providerRequestId: generated.providerRequestId,
      });
      pending = {
        incomeReportId: generatedReportId,
        providerRequestId: generated.providerRequestId,
        createdAt: Date.now(),
      };
      pendingReports.set(cacheKey, pending);
    }
    const { incomeReportId } = pending;
    for (let attempt = 0; attempt < this.pollAttempts && !reportUrl(payload); attempt += 1) {
      if (attempt) await this.sleeper(this.pollIntervalMs);
      const status = await this.relayClient.call("get_income_report", {
        shopId: this.shopId, params: { income_report_id: incomeReportId },
      });
      payload = responseBody(status);
      const numericState = Number(payload.status);
      const state = String(payload.status ?? payload.report_status ?? "").toUpperCase();
      if ([0, 4].includes(numericState) || ["FAILED", "EXPIRED", "ERROR", "INVALID"].includes(state)) {
        pendingReports.delete(cacheKey);
        throw new ConnectorError("Shopee income report generation failed", {
          code: "SHOPEE_INCOME_REPORT_GENERATION_FAILED", status: 502, platform: "shopee",
          providerRequestId: status.providerRequestId,
        });
      }
    }
    const fileUrl = reportUrl(payload);
    if (!fileUrl) throw new ConnectorError("Shopee income report is still processing", {
      code: "SHOPEE_INCOME_REPORT_PENDING", status: 202, retryable: true, platform: "shopee",
      providerRequestId: pending.providerRequestId,
    });
    const workbookBuffer = await downloadReport(this.fetchImpl, fileUrl, this.timeoutMs);
    pendingReports.delete(cacheKey);
    return {
      workbookBuffer,
      incomeReportId,
      providerRequestId: pending.providerRequestId,
      reportStatus: String(payload.status ?? payload.report_status ?? "READY"),
    };
  }

  async getExpenseTransactions(input = {}) {
    const dateFrom = required(input.dateFrom, "date_from");
    const dateTo = required(input.dateTo, "date_to");
    if (!DATE_PATTERN.test(dateFrom) || !DATE_PATTERN.test(dateTo) || dateFrom > dateTo) {
      throw new TypeError("Shopee wallet date range is invalid");
    }
    const pageSize = Math.min(100, Math.max(1, Number(input.pageSize) || 100));
    const records = [];
    const providerRequestIds = [];
    const sourceWindows = [];
    for (let windowFrom = dateFrom; windowFrom <= dateTo;) {
      const windowTo = [addDays(windowFrom, 14), dateTo].sort()[0];
      const sourceWindow = `${windowFrom}:${windowTo}`;
      sourceWindows.push(sourceWindow);
      let pageNo = 1;
      while (records.length < MAX_WALLET_ROWS) {
        const call = await this.relayClient.call("get_wallet_transaction_list", {
          shopId: this.shopId,
          params: {
            transaction_tab_type: "wallet_wallet_payment",
            create_time_from: unixStart(windowFrom, this.countryCode),
            create_time_to: unixEnd(windowTo, this.countryCode),
            page_no: pageNo,
            page_size: pageSize,
          },
        });
        const payload = responseBody(call);
        const rows = walletRows(payload);
        records.push(...rows.map((row) => normalizeShopeeExpenseTransaction(row, {
          countryCode: this.countryCode,
          sourceWindow,
        })));
        if (call.providerRequestId) providerRequestIds.push(String(call.providerRequestId));
        const more = payload.more ?? payload.page_info?.more ?? payload.pageInfo?.more;
        if (more === false || (more === undefined && rows.length < pageSize)) break;
        pageNo += 1;
      }
      windowFrom = addDays(windowTo, 1);
    }
    if (records.length >= MAX_WALLET_ROWS) {
      throw new ConnectorError("Shopee wallet result exceeded the 100,000-row safety limit", {
        code: "SHOPEE_WALLET_ROW_LIMIT_EXCEEDED", status: 413, platform: "shopee",
      });
    }
    return {
      records,
      paginationComplete: true,
      page: { pageSize, count: records.length },
      sourceWindows,
      providerRequestId: providerRequestIds.at(-1) || null,
      providerRequestIds,
    };
  }
}
