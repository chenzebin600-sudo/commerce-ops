import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { OPERATION_CONTRACTS } from "../lib/contracts/operation-contracts.mjs";
import { FUTURE_MODULE_IDS, MODULE_ID_VALUES } from "../lib/contracts/module-ids.mjs";

test("all seven future module contracts use stable modules and declare support honestly", () => {
  const contracts = Object.values(OPERATION_CONTRACTS);
  const allowedModules = [...MODULE_ID_VALUES, ...Object.values(FUTURE_MODULE_IDS)];
  assert.equal(contracts.length, 7);
  for (const contract of contracts) {
    assert.ok(allowedModules.includes(contract.sourceModule));
    assert.ok(allowedModules.includes(contract.targetModule));
    assert.ok(contract.required.includes("request_id"));
    assert.ok(["partial", "not_connected"].includes(contract.currentSupport));
    assert.match(contract.futureNode, /^F\d$/);
  }
});

test("module contract documentation contains required caveats and HTTP correlation", async () => {
  const document = await fs.readFile(path.resolve("docs/module-contracts.md"), "utf8");
  for (const phrase of [
    "not guaranteed to be a true platform sales ranking",
    "not real pixel-level vision analysis",
    "uploaded Lazada Excel files",
    "mapping is incomplete",
    "x-request-id",
    "Managed mode",
    "External mode",
  ]) assert.match(document, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
});

test("PostgreSQL readiness covers every formal SQLite table without connecting PostgreSQL", async () => {
  const document = await fs.readFile(path.resolve("docs/postgresql-readiness.md"), "utf8");
  const migrationSql = (await fs.readdir(path.resolve("migrations")))
    .filter((name) => name.endsWith(".sql"))
    .map((name) => fs.readFile(path.resolve("migrations", name), "utf8"));
  const schema = (await Promise.all(migrationSql)).join("\n");
  const tables = [...schema.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+([A-Za-z0-9_]+)/gi)]
    .map((match) => match[1])
    .filter((name) => !name.endsWith("_d2b1"));
  for (const table of new Set(["schema_migrations", ...tables])) assert.match(document, new RegExp(`\\b${table}\\b`));
  for (const missing of ["orders", "inventory snapshots", "competitor snapshots", "keyword search results", "advertising metrics", "AI analysis results"]) {
    assert.match(document, new RegExp(missing, "i"));
  }
  const packageJson = JSON.parse(await fs.readFile(path.resolve("package.json"), "utf8"));
  assert.equal(Object.keys(packageJson.dependencies || {}).some((name) => /^(pg|postgres|postgresql)$/i.test(name)), false);
  const productionFiles = ["server.mjs", "scheduler.mjs", "lib/data/data-access.mjs"];
  for (const file of productionFiles) {
    const source = await fs.readFile(path.resolve(file), "utf8");
    assert.doesNotMatch(source, /from\s+["'](?:pg|postgres|postgresql)["']/i);
  }
});
