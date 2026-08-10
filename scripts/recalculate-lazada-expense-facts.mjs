import path from "node:path";
import { loadLocalEnv } from "../lib/env.mjs";
import { createDatabaseProvider } from "../lib/data/database-provider-factory.mjs";
import {
  calculateLazadaDailyExpenses,
  LAZADA_EXPENSE_RULE_VERSION,
} from "../lib/profit/expense-calculator.mjs";
import { decimalToScaled, scaledToDecimal } from "../lib/profit/profit-money.mjs";
import { ProfitRepository } from "../lib/profit/profit-repository.mjs";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function option(name) {
  return process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) || null;
}

function dayCount(dateFrom, dateTo) {
  return Math.round((Date.parse(`${dateTo}T00:00:00Z`) - Date.parse(`${dateFrom}T00:00:00Z`)) / 86_400_000) + 1;
}

function addScaled(target, key, value) {
  target[key] = (target[key] || 0n) + decimalToScaled(value ?? "0");
}

function factChanged(previous, next) {
  if (!previous) return true;
  return [
    "dataStatus", "advertisingExpenseSigned", "billingExpenseSigned", "sourceSignedTotal",
    "expenseValue", "classification", "ruleVersion", "advertisingRowCount", "billingRowCount",
    "sourceWindowCount", "duplicateGroupCount", "duplicateRemovedCount", "sourceComplete",
  ].some((field) => String(previous[field] ?? "") !== String(next[field] ?? ""));
}

async function main() {
  const rootDir = path.resolve(import.meta.dirname, "..");
  loadLocalEnv(rootDir);
  const dateFrom = option("date-from");
  const dateTo = option("date-to");
  if (!DATE_PATTERN.test(dateFrom || "") || !DATE_PATTERN.test(dateTo || "") || dateFrom > dateTo) {
    throw new Error("Use --date-from=YYYY-MM-DD and --date-to=YYYY-MM-DD");
  }
  const apply = process.argv.includes("--apply");
  const runtime = createDatabaseProvider({
    rootDir,
    databasePath: path.join(rootDir, "data", "commerce-ops.db"),
  });
  const provider = runtime.provider;
  try {
    const identity = (await provider.query("SELECT current_database() database,current_user username")).rows[0];
    if (apply && (option("confirm-database") !== identity.database
      || option("confirm-rule") !== LAZADA_EXPENSE_RULE_VERSION)) {
      throw new Error(`Apply requires --confirm-database=${identity.database} --confirm-rule=${LAZADA_EXPENSE_RULE_VERSION}`);
    }
    const repository = new ProfitRepository({ provider });
    const existingFacts = await repository.dailyExpenseFactsForRange({
      platform: "LAZADA",
      connectorShopIds: (await provider.query(
        `SELECT DISTINCT connector_shop_id FROM profit_shop_daily_expenses
         WHERE platform='LAZADA' AND transaction_date>=$1 AND transaction_date<=$2`,
        [dateFrom, dateTo],
      )).rows.map((row) => row.connector_shop_id),
      dateFrom,
      dateTo,
    });
    const byShop = new Map();
    for (const fact of existingFacts) {
      if (!byShop.has(fact.connectorShopId)) byShop.set(fact.connectorShopId, []);
      byShop.get(fact.connectorShopId).push(fact);
    }
    if (!byShop.size) throw new Error("No existing Lazada expense coverage was found for the requested range");

    const expectedDays = dayCount(dateFrom, dateTo);
    const recalculated = [];
    const skipped = [];
    const countryTotals = new Map();
    const maxMarketingRows = { charges: 0, refunds: 0 };
    for (const [connectorShopId, previousFacts] of byShop) {
      const complete = previousFacts.length === expectedDays
        && previousFacts.every((fact) => fact.dataStatus === "COMPLETE" && fact.sourceComplete);
      if (!complete) {
        skipped.push({ countryCode: previousFacts[0]?.countryCode || null, reason: "EXISTING_SOURCE_COVERAGE_INCOMPLETE" });
        continue;
      }
      const metadata = previousFacts[0];
      const [advertisingRows, financeRows] = await Promise.all([
        repository.expenseTransactions({ platform: "LAZADA", connectorShopId, dateFrom, dateTo }),
        repository.financeRows({ platform: "LAZADA", connectorShopId, dateFrom, dateTo }),
      ]);
      for (const row of financeRows) {
        if (row.fee_name_raw === "Free Shipping Max Fee") maxMarketingRows.charges += 1;
        if (row.fee_name_raw === "Reversal of Free Shipping Max Fee") maxMarketingRows.refunds += 1;
      }
      const calculated = calculateLazadaDailyExpenses({
        shop: {
          id: connectorShopId,
          directoryShopId: metadata.canonicalShopId,
          country: metadata.countryCode,
          currency: metadata.currency,
        },
        dateFrom,
        dateTo,
        advertisingRows,
        financeRows,
        advertisingSourceComplete: true,
        financeSourceComplete: true,
      });
      const previousByDate = new Map(previousFacts.map((fact) => [fact.transactionDate, fact]));
      const changedFacts = calculated.facts.filter((fact) => factChanged(previousByDate.get(fact.transactionDate), fact)).length;
      recalculated.push({
        connectorShopId,
        countryCode: metadata.countryCode,
        previousFacts,
        facts: calculated.facts,
        changedFacts,
      });
      if (!countryTotals.has(metadata.countryCode)) {
        countryTotals.set(metadata.countryCode, { old: 0n, next: 0n, shops: 0, changedShops: 0 });
      }
      const total = countryTotals.get(metadata.countryCode);
      total.shops += 1;
      if (changedFacts) total.changedShops += 1;
      for (const fact of previousFacts) addScaled(total, "old", fact.expenseValue);
      for (const fact of calculated.facts) addScaled(total, "next", fact.expenseValue);
    }
    if (skipped.length) throw new Error(`${skipped.length} shops have incomplete source coverage; no recalculation was applied`);

    if (apply) {
      await repository.upsertDailyExpenseFacts(recalculated.flatMap((item) => item.facts), { transactional: true });
    }

    const result = {
      status: apply ? "APPLIED" : "PLAN",
      database: identity.database,
      platform: "LAZADA",
      dateFrom,
      dateTo,
      ruleVersion: LAZADA_EXPENSE_RULE_VERSION,
      shopCount: recalculated.length,
      factCount: recalculated.reduce((total, item) => total + item.facts.length, 0),
      changedShopCount: recalculated.filter((item) => item.changedFacts).length,
      changedFactCount: recalculated.reduce((total, item) => total + item.changedFacts, 0),
      includedMaxMarketingRows: maxMarketingRows,
      countries: [...countryTotals.entries()].sort().map(([countryCode, total]) => ({
        countryCode,
        shopCount: total.shops,
        changedShopCount: total.changedShops,
        previousExpense: scaledToDecimal(total.old),
        recalculatedExpense: scaledToDecimal(total.next),
        expenseIncrease: scaledToDecimal(total.next - total.old),
      })),
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await provider.close();
  }
}

main().catch((error) => {
  process.stderr.write(`Lazada expense recalculation failed: ${String(error?.message || error).split(/\r?\n/)[0].slice(0, 500)}\n`);
  process.exitCode = 1;
});
