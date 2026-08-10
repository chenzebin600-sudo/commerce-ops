import { createHash, randomUUID } from "node:crypto";
import { createPortableRepositoryExecutor } from "../data/portable-repository-executor.mjs";
import { normalizeCanonicalShopName } from "../data-foundation/unified-normalizers.mjs";
import { MABANG_GMV_SOURCE_RULE_VERSION } from "../data-foundation/mabang-gmv-contract.mjs";
import { PROFIT_GMV_RULE_VERSION } from "./gmv-calculator.mjs";
import { decimalToScaled, scaledToDecimal } from "./profit-money.mjs";

function parseJson(value, fallback) {
  if (value !== null && typeof value === "object") return value;
  try { return JSON.parse(String(value || "")); } catch { return fallback; }
}

function dateOnly(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  const text = String(value || "");
  const direct = text.match(/^(\d{4}-\d{2}-\d{2})/);
  if (direct) return direct[1];
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? text.slice(0, 10) : parsed.toISOString().slice(0, 10);
}

const MABANG_TRANSACTION_ID_FIELD = "\u4ea4\u6613\u7f16\u53f7";
const MABANG_QUANTITY_FIELD = "\u5546\u54c1\u6570\u91cf";
const MABANG_WAREHOUSE_FIELD = "\u4ed3\u5e93";

function normalizedSku(value) {
  return String(value || "").normalize("NFKC").trim().toUpperCase();
}

function normalizedWarehouse(value) {
  return String(value || "").normalize("NFKC").trim();
}

function recoverableRawOrderLine(row, metadata) {
  const raw = parseJson(row.raw_values_json, {});
  const sourceSku = String(raw.SKU || "").normalize("NFKC").trim();
  const quantity = String(raw[MABANG_QUANTITY_FIELD] ?? "").trim();
  const numericQuantity = Number(quantity);
  if (!sourceSku || !Number.isFinite(numericQuantity) || numericQuantity <= 0) return null;
  const sourceWarehouseName = normalizedWarehouse(raw[MABANG_WAREHOUSE_FIELD]) || null;
  return {
    transactionId: String(raw[MABANG_TRANSACTION_ID_FIELD] || "").trim(),
    sourceSku,
    normalizedSourceSku: normalizedSku(sourceSku),
    quantity,
    sourceWarehouseName,
    normalizedSourceWarehouseName: sourceWarehouseName,
    sourceShopName: metadata.sourceShopName || null,
    platform: metadata.platform || null,
    raw,
  };
}

function runRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    platform: row.platform,
    dateFrom: dateOnly(row.date_from),
    dateTo: dateOnly(row.date_to),
    ruleVersion: row.rule_version,
    status: row.status,
    currentStage: row.current_stage,
    totalShopCount: Number(row.total_shop_count || 0),
    financeSuccessCount: Number(row.finance_success_count || 0),
    completeShopCount: Number(row.complete_shop_count || 0),
    partialShopCount: Number(row.partial_shop_count || 0),
    failedShopCount: Number(row.failed_shop_count || 0),
    selectedOrderCount: Number(row.selected_order_count || 0),
    mabangSyncStatus: row.mabang_sync_status,
    warnings: parseJson(row.warnings_json, []),
    startedAt: row.started_at,
    completedAt: row.completed_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function resultRow(row) {
  if (!row) return null;
  const numberOrNull = (value) => value === null || value === undefined || value === "" ? null : Number(value);
  return {
    id: row.id,
    runId: row.run_id,
    platform: row.platform,
    canonicalShopId: row.canonical_shop_id || null,
    connectorShopId: row.connector_shop_id,
    shopCode: row.shop_code,
    shopName: row.shop_name,
    countryCode: row.country_code,
    currency: row.currency,
    dataStatus: row.data_status,
    listRevenue: numberOrNull(row.list_revenue),
    receivedRevenue: numberOrNull(row.received_revenue),
    totalCost: numberOrNull(row.total_cost),
    knownTotalCost: Number(row.known_total_cost || 0),
    listProfitMargin: numberOrNull(row.list_profit_margin),
    receivedProfitMargin: numberOrNull(row.received_profit_margin),
    listToReceivedProfitMargin: numberOrNull(row.list_to_received_profit_margin),
    financeRowCount: Number(row.finance_row_count || 0),
    selectedOrderCount: Number(row.selected_order_count || 0),
    linkedOrderCount: Number(row.linked_order_count || 0),
    evaluationOrderCount: Number(row.evaluation_order_count || 0),
    costLineCount: Number(row.cost_line_count || 0),
    matchedCostLineCount: Number(row.matched_cost_line_count || 0),
    missingOrderCount: Number(row.missing_order_count || 0),
    missingCostLineCount: Number(row.missing_cost_line_count || 0),
    ambiguousCostLineCount: Number(row.ambiguous_cost_line_count || 0),
    warnings: parseJson(row.warnings_json, []),
    calculatedAt: row.calculated_at,
  };
}

function expenseFactRow(row) {
  if (!row) return null;
  const decimalOrNull = (value) => value === null || value === undefined || value === "" ? null : String(value);
  return {
    id: row.id,
    platform: row.platform,
    canonicalShopId: row.canonical_shop_id || null,
    connectorShopId: row.connector_shop_id,
    countryCode: row.country_code,
    currency: row.currency,
    transactionDate: dateOnly(row.transaction_date),
    dataStatus: row.data_status,
    advertisingExpenseSigned: String(row.advertising_expense_signed ?? "0"),
    billingExpenseSigned: String(row.billing_expense_signed ?? "0"),
    affiliateExpenseSigned: decimalOrNull(row.affiliate_expense_signed),
    adsEscrowExpenseSigned: decimalOrNull(row.ads_escrow_expense_signed),
    sourceSignedTotal: decimalOrNull(row.source_signed_total),
    expenseValue: decimalOrNull(row.expense_value),
    classification: row.classification || null,
    ruleVersion: row.rule_version,
    advertisingRowCount: Number(row.advertising_row_count || 0),
    billingRowCount: Number(row.billing_row_count || 0),
    sourceWindowCount: Number(row.source_window_count || 0),
    duplicateGroupCount: Number(row.duplicate_group_count || 0),
    duplicateRemovedCount: Number(row.duplicate_removed_count || 0),
    sourceComplete: row.source_complete === true || Number(row.source_complete) === 1,
    issues: parseJson(row.issues_json, []),
    calculatedAt: row.calculated_at,
  };
}

export class ProfitRepository {
  constructor({ provider }) {
    if (!provider) throw new TypeError("Database provider is required");
    this.provider = createPortableRepositoryExecutor(provider);
  }

  async isReady() {
    try {
      await this.provider.query("SELECT 1 FROM profit_runs LIMIT 1");
      await this.provider.query("SELECT 1 FROM profit_finance_transactions LIMIT 1");
      await this.provider.query("SELECT 1 FROM profit_shop_results LIMIT 1");
      await this.provider.query("SELECT 1 FROM profit_expense_transactions LIMIT 1");
      await this.provider.query("SELECT 1 FROM profit_shop_daily_expenses LIMIT 1");
      return true;
    } catch { return false; }
  }

  async isGmvReady() {
    try {
      await this.provider.query(
        "SELECT original_product_amount_local,discount_amount_local,gmv_source_status,gmv_source_rule_version FROM growth_order_headers LIMIT 1",
      );
      return true;
    } catch { return false; }
  }

  async createRun(input) {
    const now = input.startedAt || new Date().toISOString();
    const id = input.id || randomUUID();
    await this.provider.execute(
      `INSERT INTO profit_runs (
         id,platform,date_from,date_to,rule_version,status,current_stage,total_shop_count,
         warnings_json,started_at,created_at,updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, input.platform, input.dateFrom, input.dateTo, input.ruleVersion, "RUNNING",
        input.currentStage || "DISCOVERING_SHOPS", Number(input.totalShopCount || 0),
        JSON.stringify(input.warnings || []), now, now, now],
    );
    return this.getRun(id);
  }

  async updateRun(id, input = {}) {
    const columns = new Map([
      ["status", "status"], ["currentStage", "current_stage"], ["totalShopCount", "total_shop_count"],
      ["financeSuccessCount", "finance_success_count"], ["completeShopCount", "complete_shop_count"],
      ["partialShopCount", "partial_shop_count"], ["failedShopCount", "failed_shop_count"],
      ["selectedOrderCount", "selected_order_count"], ["mabangSyncStatus", "mabang_sync_status"],
      ["warnings", "warnings_json"], ["completedAt", "completed_at"],
    ]);
    const assignments = [];
    const values = [];
    for (const [key, column] of columns) {
      if (!Object.hasOwn(input, key)) continue;
      assignments.push(`${column}=?`);
      values.push(key === "warnings" ? JSON.stringify(input[key] || []) : input[key]);
    }
    assignments.push("updated_at=?");
    values.push(input.updatedAt || new Date().toISOString(), id);
    await this.provider.execute(`UPDATE profit_runs SET ${assignments.join(",")} WHERE id=?`, values);
    return this.getRun(id);
  }

  async getRun(id) {
    return runRow((await this.provider.query("SELECT * FROM profit_runs WHERE id=? LIMIT 1", [id])).rows[0]);
  }

  async latestRun({ platform, dateFrom, dateTo }) {
    return runRow((await this.provider.query(
      `SELECT * FROM profit_runs WHERE platform=? AND date_from=? AND date_to=?
       ORDER BY created_at DESC LIMIT 1`, [platform, dateFrom, dateTo],
    )).rows[0]);
  }

  async listRuns({ platform = null, limit = 30 } = {}) {
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 30));
    const result = platform
      ? await this.provider.query(
        `SELECT * FROM profit_runs WHERE platform=? ORDER BY created_at DESC LIMIT ${safeLimit}`,
        [String(platform).toUpperCase()],
      )
      : await this.provider.query(`SELECT * FROM profit_runs ORDER BY created_at DESC LIMIT ${safeLimit}`);
    return result.rows.map(runRow);
  }

  async latestResultsForRange({ platform, dateFrom, dateTo }) {
    const rows = (await this.provider.query(
      `SELECT result.*,run.created_at AS run_created_at
       FROM profit_shop_results result
       JOIN profit_runs run ON run.id=result.run_id
       WHERE run.platform=? AND run.date_from=? AND run.date_to=?
         AND run.status IN ('COMPLETE','PARTIAL') AND run.current_stage='COMPLETE'
       ORDER BY run.created_at DESC,result.calculated_at DESC`,
      [platform, dateFrom, dateTo],
    )).rows;
    const seen = new Set();
    const latest = [];
    for (const row of rows) {
      if (seen.has(row.connector_shop_id)) continue;
      seen.add(row.connector_shop_id);
      latest.push(resultRow(row));
    }
    return latest.sort((left, right) => `${left.countryCode}|${left.shopCode}`.localeCompare(`${right.countryCode}|${right.shopCode}`));
  }

  async resultWindowsForRange({ platform, dateFrom, dateTo, connectorShopIds = [] }) {
    const unique = [...new Set((connectorShopIds || []).map((value) => String(value || "").trim()).filter(Boolean))];
    if (!unique.length) return [];
    const rows = [];
    for (let offset = 0; offset < unique.length; offset += 300) {
      const chunk = unique.slice(offset, offset + 300);
      const values = [platform, dateFrom, dateTo, ...chunk];
      const placeholders = chunk.map((_, index) => this.provider.placeholder(index + 4)).join(",");
      const result = await this.provider.query(
        `SELECT result.*,run.date_from AS run_date_from,run.date_to AS run_date_to,
                run.created_at AS run_created_at,run.completed_at AS run_completed_at,
                run.rule_version AS run_rule_version
         FROM profit_shop_results result
         JOIN profit_runs run ON run.id=result.run_id
         WHERE run.platform=${this.provider.placeholder(1)}
           AND run.date_from>=${this.provider.placeholder(2)}
           AND run.date_to<=${this.provider.placeholder(3)}
           AND run.status IN ('COMPLETE','PARTIAL') AND run.current_stage='COMPLETE'
           AND result.data_status<>'FAILED'
           AND result.connector_shop_id IN (${placeholders})
         ORDER BY result.connector_shop_id,run.date_from,run.date_to,run.created_at DESC,result.calculated_at DESC`,
        values,
      );
      rows.push(...result.rows);
    }
    const seen = new Set();
    const latest = [];
    for (const row of rows) {
      const key = `${row.connector_shop_id}|${dateOnly(row.run_date_from)}|${dateOnly(row.run_date_to)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      latest.push({
        ...resultRow(row),
        window: { dateFrom: dateOnly(row.run_date_from), dateTo: dateOnly(row.run_date_to) },
        runCreatedAt: row.run_created_at || null,
        runCompletedAt: row.run_completed_at || null,
        runRuleVersion: row.run_rule_version || null,
      });
    }
    return latest;
  }

  async financeCoverageWindows({ platform, connectorShopIds = [] }) {
    const unique = [...new Set((connectorShopIds || []).map((value) => String(value || "").trim()).filter(Boolean))];
    if (!unique.length) return [];
    const rows = [];
    for (let offset = 0; offset < unique.length; offset += 300) {
      const chunk = unique.slice(offset, offset + 300);
      const values = [platform, ...chunk];
      const placeholders = chunk.map((_, index) => this.provider.placeholder(index + 2)).join(",");
      const result = await this.provider.query(
        `SELECT result.connector_shop_id,run.date_from,run.date_to,run.completed_at,run.id AS run_id
         FROM profit_runs run
         JOIN profit_shop_results result ON result.run_id=run.id
         WHERE run.platform=${this.provider.placeholder(1)}
           AND run.status IN ('COMPLETE','PARTIAL') AND run.current_stage='COMPLETE'
           AND result.data_status<>'FAILED'
           AND result.connector_shop_id IN (${placeholders})
         ORDER BY result.connector_shop_id,run.date_from,run.date_to`, values,
      );
      rows.push(...result.rows.map((row) => ({
        connectorShopId: row.connector_shop_id,
        dateFrom: dateOnly(row.date_from),
        dateTo: dateOnly(row.date_to),
        completedAt: row.completed_at || null,
        runId: row.run_id,
      })));
    }
    return rows;
  }

  async replaceFinanceWindow({ platform, connectorShopId, dateFrom, dateTo, rows }) {
    return this.provider.transaction(async (tx) => {
      await tx.execute(
        `DELETE FROM profit_finance_transactions
         WHERE platform=? AND connector_shop_id=? AND transaction_date>=? AND transaction_date<=?`,
        [platform, connectorShopId, dateFrom, dateTo],
      );
      const columns = [
        "id", "platform", "canonical_shop_id", "connector_shop_id", "country_code", "currency",
        "transaction_date", "transaction_time", "transaction_type", "fee_name_raw", "fee_name_normalized",
        "amount", "statement_number", "transaction_number", "order_no", "order_item_no", "seller_sku",
        "lazada_sku", "paid_status", "order_status", "source_key", "provider_request_id", "fetched_at",
        "created_at", "updated_at",
      ];
      for (let offset = 0; offset < rows.length; offset += 100) {
        const chunk = rows.slice(offset, offset + 100);
        const values = [];
        const groups = chunk.map((row) => {
          const now = row.fetchedAt || new Date().toISOString();
          values.push(
            row.id || randomUUID(), platform, row.canonicalShopId || null, connectorShopId,
            row.countryCode, row.currency, row.transactionDate, row.transactionTime || null,
            row.transactionType || null, row.feeNameRaw, row.feeNameNormalized, row.amount,
            row.statementNumber || null, row.transactionNumber || null, row.orderNo || null,
            row.orderItemNo || null, row.sellerSku || null, row.lazadaSku || null,
            row.paidStatus || null, row.orderStatus || null, row.sourceKey,
            row.providerRequestId || null, now, now, now,
          );
          return `(${Array.from({ length: columns.length }, (_, index) => tx.placeholder(values.length - columns.length + index + 1)).join(",")})`;
        });
        await tx.execute(
          `INSERT INTO profit_finance_transactions (${columns.join(",")}) VALUES ${groups.join(",")}`,
          values,
        );
      }
      return rows.length;
    });
  }

  async financeRows({ platform, connectorShopId, dateFrom, dateTo }) {
    return (await this.provider.query(
      `SELECT * FROM profit_finance_transactions
       WHERE platform=? AND connector_shop_id=? AND transaction_date>=? AND transaction_date<=?
       ORDER BY transaction_date,id`,
      [platform, connectorShopId, dateFrom, dateTo],
    )).rows;
  }

  async financeRowsForRange({ platform, connectorShopIds = [], dateFrom, dateTo }) {
    const unique = [...new Set((connectorShopIds || []).map((value) => String(value || "").trim()).filter(Boolean))];
    if (!unique.length) return [];
    const rows = [];
    for (let offset = 0; offset < unique.length; offset += 300) {
      const chunk = unique.slice(offset, offset + 300);
      const values = [platform, dateFrom, dateTo, ...chunk];
      const placeholders = chunk.map((_, index) => this.provider.placeholder(index + 4)).join(",");
      const result = await this.provider.query(
        `SELECT * FROM profit_finance_transactions
         WHERE platform=${this.provider.placeholder(1)}
           AND transaction_date>=${this.provider.placeholder(2)}
           AND transaction_date<=${this.provider.placeholder(3)}
           AND connector_shop_id IN (${placeholders})
         ORDER BY connector_shop_id,transaction_date,id`, values,
      );
      rows.push(...result.rows);
    }
    return rows;
  }

  async replaceExpenseTransactionWindow({ platform, connectorShopId, dateFrom, dateTo, rows }) {
    return this.provider.transaction(async (tx) => {
      await tx.execute(
        `DELETE FROM profit_expense_transactions
         WHERE platform=? AND connector_shop_id=? AND transaction_date>=? AND transaction_date<=?`,
        [platform, connectorShopId, dateFrom, dateTo],
      );
      const columns = [
        "id", "platform", "canonical_shop_id", "connector_shop_id", "country_code", "currency",
        "transaction_date", "transaction_time", "source_type", "transaction_type", "transaction_subtype",
        "transaction_tab_type", "money_flow", "amount", "transaction_number", "remarks", "source_window",
        "source_key", "provider_request_id", "fetched_at", "created_at", "updated_at",
      ];
      const occurrences = new Map();
      for (let offset = 0; offset < rows.length; offset += 100) {
        const chunk = rows.slice(offset, offset + 100);
        const values = [];
        const groups = chunk.map((row) => {
          const now = row.fetchedAt || new Date().toISOString();
          const sourceWindow = String(row.sourceWindow || `${dateFrom}:${dateTo}`);
          const fingerprint = JSON.stringify([
            row.transactionDate, row.transactionType, row.transactionSubtype, row.transactionTabType,
            row.moneyFlow, row.amount, row.transactionNumber, row.remarks, sourceWindow,
          ]);
          const occurrence = (occurrences.get(fingerprint) || 0) + 1;
          occurrences.set(fingerprint, occurrence);
          const sourceKey = row.sourceKey || createHash("sha256").update(`${fingerprint}\u001f${occurrence}`).digest("hex");
          values.push(
            row.id || randomUUID(), platform, row.canonicalShopId || null, connectorShopId,
            row.countryCode, row.currency, row.transactionDate, row.transactionTime || null,
            "ADVERTISING", row.transactionType || null, row.transactionSubtype || null,
            row.transactionTabType || null, row.moneyFlow || null, row.amount,
            row.transactionNumber || null, row.remarks || null, sourceWindow, sourceKey,
            row.providerRequestId || null, now, now, now,
          );
          return `(${Array.from({ length: columns.length }, (_, index) => tx.placeholder(values.length - columns.length + index + 1)).join(",")})`;
        });
        await tx.execute(
          `INSERT INTO profit_expense_transactions (${columns.join(",")}) VALUES ${groups.join(",")}`,
          values,
        );
      }
      return rows.length;
    });
  }

  async expenseTransactions({ platform, connectorShopId, dateFrom, dateTo }) {
    return (await this.provider.query(
      `SELECT * FROM profit_expense_transactions
       WHERE platform=? AND connector_shop_id=? AND transaction_date>=? AND transaction_date<=?
       ORDER BY transaction_date,id`,
      [platform, connectorShopId, dateFrom, dateTo],
    )).rows;
  }

  async upsertDailyExpenseFacts(facts = [], { transactional = false } = {}) {
    const persist = async (executor) => {
      for (const fact of facts) {
        const now = fact.calculatedAt || new Date().toISOString();
        const sourceComplete = executor.dialect === "postgresql" ? Boolean(fact.sourceComplete) : Number(Boolean(fact.sourceComplete));
        const values = [
          fact.id || randomUUID(), fact.platform, fact.canonicalShopId || null, fact.connectorShopId,
          fact.countryCode, fact.currency, fact.transactionDate, fact.dataStatus,
          fact.advertisingExpenseSigned || "0", fact.billingExpenseSigned || "0",
          fact.affiliateExpenseSigned ?? null, fact.adsEscrowExpenseSigned ?? null,
          fact.sourceSignedTotal ?? null, fact.expenseValue ?? null, fact.classification || null,
          fact.ruleVersion, fact.advertisingRowCount || 0, fact.billingRowCount || 0,
          fact.sourceWindowCount || 0, fact.duplicateGroupCount || 0, fact.duplicateRemovedCount || 0,
          sourceComplete, JSON.stringify(fact.issues || []), now, now, now,
        ];
        const placeholders = values.map((_, index) => executor.placeholder(index + 1)).join(",");
        await executor.execute(
          `INSERT INTO profit_shop_daily_expenses (
           id,platform,canonical_shop_id,connector_shop_id,country_code,currency,transaction_date,data_status,
           advertising_expense_signed,billing_expense_signed,affiliate_expense_signed,ads_escrow_expense_signed,
           source_signed_total,expense_value,classification,rule_version,advertising_row_count,billing_row_count,
           source_window_count,duplicate_group_count,duplicate_removed_count,source_complete,issues_json,
           calculated_at,created_at,updated_at
         ) VALUES (${placeholders})
         ON CONFLICT(platform,connector_shop_id,transaction_date) DO UPDATE SET
           canonical_shop_id=excluded.canonical_shop_id,country_code=excluded.country_code,currency=excluded.currency,
           data_status=excluded.data_status,advertising_expense_signed=excluded.advertising_expense_signed,
           billing_expense_signed=excluded.billing_expense_signed,affiliate_expense_signed=excluded.affiliate_expense_signed,
           ads_escrow_expense_signed=excluded.ads_escrow_expense_signed,source_signed_total=excluded.source_signed_total,
           expense_value=excluded.expense_value,classification=excluded.classification,rule_version=excluded.rule_version,
           advertising_row_count=excluded.advertising_row_count,billing_row_count=excluded.billing_row_count,
           source_window_count=excluded.source_window_count,duplicate_group_count=excluded.duplicate_group_count,
           duplicate_removed_count=excluded.duplicate_removed_count,source_complete=excluded.source_complete,
           issues_json=excluded.issues_json,calculated_at=excluded.calculated_at,updated_at=excluded.updated_at`, values,
        );
      }
      return facts.length;
    };
    if (transactional && facts.length > 1) return this.provider.transaction(persist);
    return persist(this.provider);
  }

  async dailyExpenseFactsForRange({ platform, connectorShopIds = [], dateFrom, dateTo }) {
    const unique = [...new Set((connectorShopIds || []).map((value) => String(value || "").trim()).filter(Boolean))];
    if (!unique.length) return [];
    const rows = [];
    for (let offset = 0; offset < unique.length; offset += 300) {
      const chunk = unique.slice(offset, offset + 300);
      const values = [platform, dateFrom, dateTo, ...chunk];
      const placeholders = chunk.map((_, index) => this.provider.placeholder(index + 4)).join(",");
      const result = await this.provider.query(
        `SELECT * FROM profit_shop_daily_expenses
         WHERE platform=${this.provider.placeholder(1)}
           AND transaction_date>=${this.provider.placeholder(2)}
           AND transaction_date<=${this.provider.placeholder(3)}
           AND connector_shop_id IN (${placeholders})
         ORDER BY connector_shop_id,transaction_date`, values,
      );
      rows.push(...result.rows.map(expenseFactRow));
    }
    return rows;
  }

  async expenseAggregatesForRange(input) {
    const facts = await this.dailyExpenseFactsForRange(input);
    const expectedDayCount = Math.round((Date.parse(`${input.dateTo}T00:00:00Z`) - Date.parse(`${input.dateFrom}T00:00:00Z`)) / 86_400_000) + 1;
    const byShop = new Map();
    for (const fact of facts) {
      if (!byShop.has(fact.connectorShopId)) byShop.set(fact.connectorShopId, []);
      byShop.get(fact.connectorShopId).push(fact);
    }
    return [...byShop.entries()].map(([connectorShopId, rows]) => {
      const completeExpenseDayCount = rows.filter((row) => row.dataStatus === "COMPLETE" && row.sourceComplete).length;
      const complete = rows.length === expectedDayCount && completeExpenseDayCount === expectedDayCount;
      const sum = (field) => scaledToDecimal(rows.reduce((total, row) => total + decimalToScaled(row[field] ?? "0"), 0n));
      const signed = complete ? rows.reduce((total, row) => total + decimalToScaled(row.sourceSignedTotal), 0n) : null;
      return {
        connectorShopId,
        expenseDataStatus: complete ? "COMPLETE" : "PARTIAL",
        advertisingExpenseSigned: sum("advertisingExpenseSigned"),
        billingExpenseSigned: sum("billingExpenseSigned"),
        sourceSignedTotal: signed === null ? null : scaledToDecimal(signed),
        expenseValue: signed === null ? null : scaledToDecimal(-signed),
        expenseClassification: signed === null ? null : signed <= 0n ? "EXPENSE" : "NET_CREDIT",
        expenseDayCount: rows.length,
        completeExpenseDayCount,
        expectedExpenseDayCount: expectedDayCount,
        advertisingExpenseRowCount: rows.reduce((total, row) => total + row.advertisingRowCount, 0),
        billingExpenseRowCount: rows.reduce((total, row) => total + row.billingRowCount, 0),
        duplicateExpenseGroupCount: rows.reduce((total, row) => total + row.duplicateGroupCount, 0),
        duplicateExpenseRemovedCount: rows.reduce((total, row) => total + row.duplicateRemovedCount, 0),
        expenseRuleVersions: [...new Set(rows.map((row) => row.ruleVersion))],
        expenseIssues: [...new Set(rows.flatMap((row) => row.issues))],
      };
    });
  }

  async gmvAggregatesForRange({ platform, shops = [], dateFrom, dateTo }) {
    const targets = (shops || []).map((shop) => ({
      connectorShopId: String(shop.connectorShopId || shop.id || "").trim(),
      canonicalShopId: String(shop.canonicalShopId || shop.directoryShopId || "").trim() || null,
      growthShopId: String(shop.growthShopId || "").trim() || null,
      normalizedShopName: normalizeCanonicalShopName(shop.normalizedShopName || shop.shopName),
    })).filter((shop) => shop.connectorShopId && shop.normalizedShopName);
    if (!targets.length) return [];

    const platformName = String(platform || "").trim().toLowerCase();
    const businessDate = this.provider.dialect === "postgresql"
      ? "CAST(paid_at AT TIME ZONE 'Asia/Shanghai' AS date)"
      : "date(paid_at, '+8 hours')";
    const orderResult = await this.provider.query(
      `SELECT id,internal_shop_id,normalized_source_shop_name,source_order_id,
              original_product_amount_local,discount_amount_local,gmv_source_status,gmv_source_rule_version
       FROM growth_order_headers
       WHERE LOWER(platform)=LOWER(${this.provider.placeholder(1)})
         AND effective_status='valid' AND paid_at IS NOT NULL
         AND ${businessDate}>=${this.provider.placeholder(2)}
         AND ${businessDate}<=${this.provider.placeholder(3)}
       ORDER BY id`, [platformName, dateFrom, dateTo],
    );
    const batchResult = await this.provider.query(
      `SELECT id,query_started_at,query_ended_at,source_scope_json
       FROM growth_source_batches
       WHERE source_type='mabang_order' AND status='applied' AND source_scope_status='confirmed'
       ORDER BY imported_at,id`,
    );

    const allDays = [];
    for (let value = Date.parse(`${dateFrom}T00:00:00Z`); value <= Date.parse(`${dateTo}T00:00:00Z`); value += 86_400_000) {
      allDays.push(new Date(value).toISOString().slice(0, 10));
    }
    const coveredDaysByName = new Map();
    const sourceBatchesByName = new Map();
    const globallyCoveredDays = new Set();
    const globalSourceBatches = new Set();
    for (const batch of batchResult.rows) {
      const scope = parseJson(batch.source_scope_json, {});
      const batchFrom = dateOnly(scope.dateFrom || batch.query_started_at);
      const batchTo = dateOnly(scope.dateTo || batch.query_ended_at);
      if (!batchFrom || !batchTo || batchFrom > dateTo || batchTo < dateFrom) continue;
      const scopedPlatform = String(scope.platform || "").trim().toLowerCase();
      if (scopedPlatform && scopedPlatform !== platformName) continue;
      const queryType = String(scope.queryType || "").trim().toLowerCase();
      const coverageMode = String(scope.shopCoverageMode || "").trim().toUpperCase();
      const coversAllVisibleShops = coverageMode === "ALL_VISIBLE_SHOPS"
        || queryType === "profit_initial_sync";
      if (coversAllVisibleShops) {
        globalSourceBatches.add(batch.id);
        for (const day of allDays) if (day >= batchFrom && day <= batchTo) globallyCoveredDays.add(day);
      }
      const names = [...new Set((scope.shopScope || []).map(normalizeCanonicalShopName).filter(Boolean))];
      for (const name of names) {
        if (!coveredDaysByName.has(name)) coveredDaysByName.set(name, new Set());
        if (!sourceBatchesByName.has(name)) sourceBatchesByName.set(name, new Set());
        sourceBatchesByName.get(name).add(batch.id);
        for (const day of allDays) if (day >= batchFrom && day <= batchTo) coveredDaysByName.get(name).add(day);
      }
    }

    const targetsByGrowthShop = new Map();
    const targetsByName = new Map();
    for (const target of targets) {
      if (target.growthShopId) {
        if (!targetsByGrowthShop.has(target.growthShopId)) targetsByGrowthShop.set(target.growthShopId, []);
        targetsByGrowthShop.get(target.growthShopId).push(target);
      }
      if (!targetsByName.has(target.normalizedShopName)) targetsByName.set(target.normalizedShopName, []);
      targetsByName.get(target.normalizedShopName).push(target);
    }
    const aggregates = new Map(targets.map((target) => [target.connectorShopId, {
      ...target,
      knownGmvScaled: 0n,
      gmvOrderCount: 0,
      confirmedGmvOrderCount: 0,
      missingGmvOrderCount: 0,
      conflictingGmvOrderCount: 0,
      invalidGmvOrderCount: 0,
      gmvMappingSources: new Set(),
    }]));
    for (const order of orderResult.rows) {
      const growthCandidates = order.internal_shop_id ? targetsByGrowthShop.get(order.internal_shop_id) || [] : [];
      const nameCandidates = targetsByName.get(normalizeCanonicalShopName(order.normalized_source_shop_name)) || [];
      const candidates = growthCandidates.length === 1 ? growthCandidates : nameCandidates;
      if (candidates.length !== 1) continue;
      const aggregate = aggregates.get(candidates[0].connectorShopId);
      aggregate.gmvOrderCount += 1;
      aggregate.gmvMappingSources.add(growthCandidates.length === 1 ? "GROWTH_SHOP_ID" : "EXACT_UNIQUE_NAME");
      if (order.gmv_source_status === "CONFLICT") {
        aggregate.conflictingGmvOrderCount += 1;
        continue;
      }
      if (order.gmv_source_status !== "CONFIRMED"
        || order.original_product_amount_local === null || order.discount_amount_local === null) {
        aggregate.missingGmvOrderCount += 1;
        continue;
      }
      const gmv = decimalToScaled(order.original_product_amount_local) - decimalToScaled(order.discount_amount_local);
      if (gmv < 0n) {
        aggregate.invalidGmvOrderCount += 1;
        continue;
      }
      aggregate.knownGmvScaled += gmv;
      aggregate.confirmedGmvOrderCount += 1;
    }

    return [...aggregates.values()].map((aggregate) => {
      const coveredDays = new Set([
        ...globallyCoveredDays,
        ...(coveredDaysByName.get(aggregate.normalizedShopName) || []),
      ]);
      const sourceBatches = new Set([
        ...globalSourceBatches,
        ...(sourceBatchesByName.get(aggregate.normalizedShopName) || []),
      ]);
      const sourceCovered = allDays.every((day) => coveredDays.has(day));
      // MABANG-ORDER-GMV-1.1.0: with complete source-day coverage, each
      // unresolved order contributes zero while confirmed orders remain in
      // the published subtotal. The issue counters remain auditable.
      const complete = sourceCovered;
      const defaultedOrderCount = aggregate.missingGmvOrderCount
        + aggregate.conflictingGmvOrderCount + aggregate.invalidGmvOrderCount;
      const issues = [];
      if (!sourceCovered) issues.push("MABANG_GMV_SOURCE_COVERAGE_INCOMPLETE");
      if (aggregate.missingGmvOrderCount) issues.push("GMV_COMPONENT_MISSING");
      if (aggregate.conflictingGmvOrderCount) issues.push("GMV_COMPONENT_CONFLICT");
      if (aggregate.invalidGmvOrderCount) issues.push("GMV_AMOUNT_NEGATIVE");
      if (defaultedOrderCount) issues.push("GMV_UNRESOLVED_ORDER_DEFAULTED_TO_ZERO");
      return {
        connectorShopId: aggregate.connectorShopId,
        canonicalShopId: aggregate.canonicalShopId,
        gmvDataStatus: complete ? "COMPLETE" : "PARTIAL",
        gmvValue: sourceCovered ? scaledToDecimal(aggregate.knownGmvScaled) : null,
        knownGmvValue: scaledToDecimal(aggregate.knownGmvScaled),
        gmvOrderCount: aggregate.gmvOrderCount,
        confirmedGmvOrderCount: aggregate.confirmedGmvOrderCount,
        missingGmvOrderCount: aggregate.missingGmvOrderCount,
        conflictingGmvOrderCount: aggregate.conflictingGmvOrderCount,
        invalidGmvOrderCount: aggregate.invalidGmvOrderCount,
        gmvSourceCoveredDayCount: coveredDays.size,
        expectedGmvDayCount: allDays.length,
        gmvSourceBatchCount: sourceBatches.size,
        gmvMappingSources: [...aggregate.gmvMappingSources].sort(),
        gmvRuleVersions: [MABANG_GMV_SOURCE_RULE_VERSION, PROFIT_GMV_RULE_VERSION],
        gmvDateBasis: "MABANG_PAID_AT_ASIA_SHANGHAI",
        gmvIssues: issues,
      };
    });
  }

  async orderCostInputs(orderNumbers) {
    const unique = [...new Set((orderNumbers || []).map((value) => String(value || "").trim()).filter(Boolean))];
    if (!unique.length) return [];
    const currentRows = [];
    const tradeExpression = this.provider.dialect === "postgresql"
      ? `raw.raw_values_json ->> '${MABANG_TRANSACTION_ID_FIELD}'`
      : `json_extract(raw.raw_values_json, '$.${MABANG_TRANSACTION_ID_FIELD}')`;
    for (let offset = 0; offset < unique.length; offset += 400) {
      const chunk = unique.slice(offset, offset + 400);
      const placeholders = chunk.map((_, index) => this.provider.placeholder(index + 1)).join(",");
      const result = await this.provider.query(
        `SELECT ${tradeExpression} AS transaction_id,raw.raw_values_json,
                line.source_sku,line.normalized_source_sku,line.quantity,
                line.source_warehouse_name,line.normalized_source_warehouse_name,
                header.source_shop_name,header.platform,header.source_batch_id AS authoritative_batch_id
         FROM growth_order_lines line
         JOIN growth_order_headers header ON header.id=line.order_header_id
         JOIN growth_order_raw_rows raw
           ON raw.batch_id=line.source_batch_id AND raw.source_row_number=line.source_row_number
         WHERE line.is_current=1 AND ${tradeExpression} IN (${placeholders})`, chunk,
      );
      currentRows.push(...result.rows.map((row) => ({
        transactionId: String(row.transaction_id || "").trim(),
        sourceSku: row.source_sku,
        normalizedSourceSku: row.normalized_source_sku,
        quantity: String(row.quantity ?? "0"),
        sourceWarehouseName: row.source_warehouse_name || null,
        normalizedSourceWarehouseName: row.normalized_source_warehouse_name || null,
        sourceShopName: row.source_shop_name || null,
        platform: row.platform || null,
        authoritativeBatchId: row.authoritative_batch_id || null,
        raw: parseJson(row.raw_values_json, {}),
      })));
    }

    const currentByTransaction = new Map();
    for (const row of currentRows) {
      if (!currentByTransaction.has(row.transactionId)) currentByTransaction.set(row.transactionId, []);
      currentByTransaction.get(row.transactionId).push(row);
    }
    const transactionsByBatch = new Map();
    for (const [transactionId, transactionRows] of currentByTransaction) {
      const batches = [...new Set(transactionRows.map((row) => row.authoritativeBatchId).filter(Boolean))];
      if (batches.length !== 1) continue;
      if (!transactionsByBatch.has(batches[0])) transactionsByBatch.set(batches[0], []);
      transactionsByBatch.get(batches[0]).push(transactionId);
    }

    const recoveredByTransaction = new Map();
    for (const [batchId, transactionIds] of transactionsByBatch) {
      for (let offset = 0; offset < transactionIds.length; offset += 400) {
        const chunk = transactionIds.slice(offset, offset + 400);
        const values = [batchId, ...chunk];
        const placeholders = chunk.map((_, index) => this.provider.placeholder(index + 2)).join(",");
        const rawResult = await this.provider.query(
          `SELECT raw.batch_id,raw.source_row_number,raw.raw_values_json,raw.row_hash,raw.parse_status
           FROM growth_order_raw_rows raw
           WHERE raw.batch_id=${this.provider.placeholder(1)} AND ${tradeExpression} IN (${placeholders})
           ORDER BY raw.source_row_number`, values,
        );
        const validHashes = new Set(rawResult.rows
          .filter((row) => row.parse_status !== "rejected")
          .map((row) => row.row_hash));
        for (const row of rawResult.rows) {
          // Mabang may emit one byte-identical row per unit. Restore only rejected
          // rows that duplicate a valid row in the same authoritative batch.
          if (row.parse_status === "rejected" && !validHashes.has(row.row_hash)) continue;
          const raw = parseJson(row.raw_values_json, {});
          const transactionId = String(raw[MABANG_TRANSACTION_ID_FIELD] || "").trim();
          const metadata = currentByTransaction.get(transactionId)?.[0];
          if (!metadata) continue;
          const recovered = recoverableRawOrderLine(row, metadata);
          if (!recovered) continue;
          if (!recoveredByTransaction.has(transactionId)) recoveredByTransaction.set(transactionId, []);
          recoveredByTransaction.get(transactionId).push(recovered);
        }
      }
    }

    const rows = [];
    for (const transactionId of unique) {
      const recovered = recoveredByTransaction.get(transactionId);
      if (recovered?.length) rows.push(...recovered);
      else rows.push(...(currentByTransaction.get(transactionId) || []).map(({ authoritativeBatchId, ...row }) => row));
    }
    return rows;
  }

  async productCostRows({ countryCode, skus }) {
    const unique = [...new Set((skus || []).map((value) => String(value || "").trim()).filter(Boolean))];
    if (!unique.length) return [];
    const rows = [];
    for (let offset = 0; offset < unique.length; offset += 400) {
      const chunk = unique.slice(offset, offset + 400);
      const values = [String(countryCode || "").trim().toUpperCase(), ...chunk];
      const placeholders = chunk.map((_, index) => this.provider.placeholder(index + 2)).join(",");
      const result = await this.provider.query(
        `SELECT country_normalized,sku_normalized,warehouse_normalized,normalized_payload_json
         FROM product_package_rows
         WHERE country_normalized=${this.provider.placeholder(1)} AND sku_normalized IN (${placeholders})`, values,
      );
      rows.push(...result.rows.map((row) => {
        const payload = parseJson(row.normalized_payload_json, {});
        return {
          countryCode: row.country_normalized,
          sku: row.sku_normalized,
          warehouse: row.warehouse_normalized || null,
          unitCost: payload.cost_local === undefined || payload.cost_local === null ? null : String(payload.cost_local),
        };
      }));
    }
    return rows;
  }

  async countryExchangeRateCandidates({ countryCodes }) {
    const unique = [...new Set((countryCodes || []).map((value) => String(value || "").trim().toUpperCase()).filter(Boolean))];
    if (!unique.length) return [];
    const rateExpression = this.provider.dialect === "postgresql"
      ? "normalized_payload_json ->> 'exchange_rate'"
      : "json_extract(normalized_payload_json, '$.exchange_rate')";
    const directionExpression = this.provider.dialect === "postgresql"
      ? "normalized_payload_json ->> 'exchange_direction'"
      : "json_extract(normalized_payload_json, '$.exchange_direction')";
    const placeholders = unique.map((_, index) => this.provider.placeholder(index + 1)).join(",");
    const result = await this.provider.query(
      `SELECT country_normalized,${rateExpression} AS exchange_rate,
              ${directionExpression} AS exchange_direction,COUNT(*) AS row_count,MAX(updated_at) AS updated_at
       FROM product_package_rows
       WHERE country_normalized IN (${placeholders})
         AND NULLIF(${rateExpression},'') IS NOT NULL
         AND NULLIF(${directionExpression},'') IS NOT NULL
       GROUP BY country_normalized,${rateExpression},${directionExpression}
       ORDER BY country_normalized,row_count DESC`, unique,
    );
    return result.rows.map((row) => ({
      countryCode: row.country_normalized,
      exchangeRate: String(row.exchange_rate),
      exchangeDirection: row.exchange_direction,
      rowCount: Number(row.row_count || 0),
      updatedAt: row.updated_at || null,
    }));
  }

  async upsertShopResult(input) {
    const now = input.calculatedAt || new Date().toISOString();
    const values = [
      input.id || randomUUID(), input.runId, input.platform, input.canonicalShopId || null,
      input.connectorShopId, input.shopCode, input.shopName, input.countryCode, input.currency,
      input.dataStatus, input.listRevenue, input.receivedRevenue, input.totalCost,
      input.knownTotalCost || "0", input.listProfitMargin, input.receivedProfitMargin,
      input.listToReceivedProfitMargin, input.financeRowCount || 0, input.selectedOrderCount || 0,
      input.linkedOrderCount || 0, input.evaluationOrderCount || 0, input.costLineCount || 0,
      input.matchedCostLineCount || 0, input.missingOrderCount || 0, input.missingCostLineCount || 0,
      input.ambiguousCostLineCount || 0, JSON.stringify(input.warnings || []), now, now, now,
    ];
    const placeholders = values.map((_, index) => this.provider.placeholder(index + 1)).join(",");
    await this.provider.execute(
      `INSERT INTO profit_shop_results (
         id,run_id,platform,canonical_shop_id,connector_shop_id,shop_code,shop_name,country_code,currency,
         data_status,list_revenue,received_revenue,total_cost,known_total_cost,list_profit_margin,
         received_profit_margin,list_to_received_profit_margin,finance_row_count,selected_order_count,
         linked_order_count,evaluation_order_count,cost_line_count,matched_cost_line_count,missing_order_count,
         missing_cost_line_count,ambiguous_cost_line_count,warnings_json,calculated_at,created_at,updated_at
       ) VALUES (${placeholders})
       ON CONFLICT(run_id,connector_shop_id) DO UPDATE SET
         canonical_shop_id=excluded.canonical_shop_id,shop_code=excluded.shop_code,shop_name=excluded.shop_name,
         country_code=excluded.country_code,currency=excluded.currency,data_status=excluded.data_status,
         list_revenue=excluded.list_revenue,received_revenue=excluded.received_revenue,total_cost=excluded.total_cost,
         known_total_cost=excluded.known_total_cost,list_profit_margin=excluded.list_profit_margin,
         received_profit_margin=excluded.received_profit_margin,
         list_to_received_profit_margin=excluded.list_to_received_profit_margin,
         finance_row_count=excluded.finance_row_count,selected_order_count=excluded.selected_order_count,
         linked_order_count=excluded.linked_order_count,evaluation_order_count=excluded.evaluation_order_count,
         cost_line_count=excluded.cost_line_count,matched_cost_line_count=excluded.matched_cost_line_count,
         missing_order_count=excluded.missing_order_count,missing_cost_line_count=excluded.missing_cost_line_count,
         ambiguous_cost_line_count=excluded.ambiguous_cost_line_count,warnings_json=excluded.warnings_json,
         calculated_at=excluded.calculated_at,updated_at=excluded.updated_at`, values,
    );
  }

  async resultsForRun(runId) {
    return (await this.provider.query(
      "SELECT * FROM profit_shop_results WHERE run_id=? ORDER BY country_code,shop_code", [runId],
    )).rows.map(resultRow);
  }
}
