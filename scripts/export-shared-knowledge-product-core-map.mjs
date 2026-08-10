import fs from "node:fs";
import path from "node:path";
import { loadPostgresqlF1Config } from "../lib/postgresql/f1-config.mjs";
import { PostgresqlProvider } from "../lib/data/postgresql/postgresql-provider.mjs";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function normalizeSku(value) {
  return String(value || "").normalize("NFKC").trim().toUpperCase();
}

function unique(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function summarize(mapping) {
  const statuses = {};
  const categories = {};
  for (const value of Object.values(mapping)) {
    statuses[value.status] = (statuses[value.status] || 0) + 1;
    if (value.canonical_category) categories[value.canonical_category] = (categories[value.canonical_category] || 0) + 1;
  }
  return { total: Object.keys(mapping).length, statuses, categories };
}

const rootDir = path.resolve(import.meta.dirname, "..");
const inputPath = path.resolve(argument("--input") || "");
const outputPath = path.resolve(argument("--output") || "");
if (!argument("--input") || !argument("--output")) {
  throw new Error("Usage: node scripts/export-shared-knowledge-product-core-map.mjs --input <source-skus.txt> --output <map.json>");
}
if (!fs.existsSync(inputPath)) throw new Error(`Input SKU file does not exist: ${inputPath}`);

const sourceSkus = unique(fs.readFileSync(inputPath, "utf8").split(/\r?\n/).map(normalizeSku));
const config = loadPostgresqlF1Config({ rootDir, env: process.env });
const provider = new PostgresqlProvider({
  config,
  database: config.database,
  user: config.appUser,
  password: config.appPassword,
  readOnly: true,
});

try {
  const identity = (await provider.query(`
    SELECT current_database() database,
           current_setting('default_transaction_read_only') read_only
  `)).rows[0];
  if (identity.database !== "commerce_ops" || identity.read_only !== "on") {
    throw new Error("Product Core mapping requires commerce_ops with default_transaction_read_only=on");
  }

  const rows = [];
  for (const batch of chunks(sourceSkus, 2_000)) {
    const result = await provider.query(`
      SELECT s.id,
             UPPER(TRIM(COALESCE(s.sku_code_normalized, s.source_sku, ''))) stock_sku,
             UPPER(TRIM(COALESCE(s.source_main_sku, ''))) main_sku,
             s.model_id,
             UPPER(TRIM(COALESCE(s.country_raw, ''))) country,
             c.source_name canonical_category
      FROM app.product_skus s
      LEFT JOIN app.product_categories c ON c.id = s.category_id
      WHERE s.deleted_at IS NULL
        AND (
          UPPER(TRIM(COALESCE(s.sku_code_normalized, s.source_sku, ''))) = ANY($1::text[])
          OR UPPER(TRIM(COALESCE(s.source_main_sku, ''))) = ANY($1::text[])
        )
    `, [batch]);
    rows.push(...result.rows);
  }

  const byStock = new Map();
  const byMain = new Map();
  for (const row of rows) {
    const stockSku = normalizeSku(row.stock_sku);
    const mainSku = normalizeSku(row.main_sku);
    if (stockSku) {
      if (!byStock.has(stockSku)) byStock.set(stockSku, []);
      byStock.get(stockSku).push(row);
    }
    if (mainSku) {
      if (!byMain.has(mainSku)) byMain.set(mainSku, []);
      byMain.get(mainSku).push(row);
    }
  }

  const mappings = {};
  for (const sourceSku of sourceSkus) {
    const mainRows = byMain.get(sourceSku) || [];
    const stockRows = byStock.get(sourceSku) || [];
    const selected = mainRows.length ? mainRows : stockRows;
    const mainSkus = unique(selected.map((row) => normalizeSku(row.main_sku)));
    const modelIds = unique(selected.map((row) => row.model_id));
    const categories = unique(selected.map((row) => row.canonical_category));
    const countries = unique(selected.map((row) => normalizeSku(row.country)));
    const productSkuIds = unique(selected.map((row) => row.id));

    let status = "UNMATCHED";
    let matchMethod = null;
    if (mainRows.length) {
      status = mainSkus.length === 1 && categories.length === 1 ? "EXACT_MAIN_SKU" : "AMBIGUOUS";
      matchMethod = "EXACT_MAIN_SKU";
    } else if (stockRows.length) {
      if (mainSkus.length === 1 && categories.length === 1) {
        status = "EXACT_STOCK_SKU_TO_MODEL";
      } else if (mainSkus.length === 0 && categories.length === 1) {
        status = "EXACT_STOCK_SKU_MODEL_MISSING";
      } else {
        status = "AMBIGUOUS";
      }
      matchMethod = "EXACT_STOCK_SKU";
    }

    mappings[sourceSku] = {
      source_sku: sourceSku,
      status,
      match_method: matchMethod,
      main_sku: mainSkus.length === 1 ? mainSkus[0] : null,
      model_ids: modelIds,
      product_sku_ids: productSkuIds,
      country_codes: countries,
      canonical_category: categories.length === 1 ? categories[0] : null,
      category_candidates: categories,
    };
  }

  const payload = {
    schema_version: "1.0.0",
    generated_at: new Date().toISOString(),
    source_database: identity.database,
    database_read_only: identity.read_only === "on",
    matching_priority: ["EXACT_MAIN_SKU", "EXACT_STOCK_SKU"],
    summary: summarize(mappings),
    mappings,
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ output: outputPath, summary: payload.summary })}\n`);
} finally {
  await provider.close();
}
