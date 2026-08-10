import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseProvider, DATABASE_DIALECTS } from "../lib/data/database-provider.mjs";
import { createRepositorySql } from "../lib/data/repository-sql.mjs";

class ProviderStub extends DatabaseProvider {
  constructor(dialect, rows = []) {
    super({ dialect });
    this.rows = rows;
    this.calls = [];
    this._transactionManager = { run() {} };
  }
  get connection() { return {}; }
  get transactionManager() { return this._transactionManager; }
  query(text, values = []) { this.calls.push({ text, values }); return Promise.resolve({ rows: this.rows }); }
  execute() { return Promise.resolve({ rows: [], rowCount: 0 }); }
  executeScript() { return Promise.resolve({ rows: [], rowCount: 0 }); }
  placeholder(index) { return this.dialect === DATABASE_DIALECTS.POSTGRESQL ? `$${index}` : "?"; }
  transaction(callback) { return callback(this); }
  close() {}
}

test("repository SQL qualifies PostgreSQL tables and numbers placeholders", () => {
  const sql = createRepositorySql(new ProviderStub(DATABASE_DIALECTS.POSTGRESQL));
  assert.equal(sql.table("products"), "app.products");
  assert.deepEqual(sql.placeholders(3, 2), ["$2", "$3", "$4"]);
  assert.equal(sql.jsonText("metadata_json", "agentName"), "(COALESCE(metadata_json, '{}')::jsonb ->> 'agentName')");
  assert.equal(sql.jsonNumber("metadata_json", "totalTokens"), "COALESCE(NULLIF((COALESCE(metadata_json, '{}')::jsonb ->> 'totalTokens'), '')::numeric, 0)");
});

test("repository SQL preserves SQLite table and JSON semantics", () => {
  const sql = createRepositorySql(new ProviderStub(DATABASE_DIALECTS.SQLITE));
  assert.equal(sql.table("products"), "products");
  assert.deepEqual(sql.placeholders(2), ["?", "?"]);
  assert.equal(sql.jsonText("metadata_json", "agentName"), "json_extract(COALESCE(metadata_json, '{}'),'$.agentName')");
  assert.equal(sql.jsonNumber("metadata_json", "totalTokens"), "COALESCE(json_extract(COALESCE(metadata_json, '{}'),'$.totalTokens'), 0)");
});

test("repository SQL checks provider-specific metadata catalogs", async () => {
  const postgres = new ProviderStub(DATABASE_DIALECTS.POSTGRESQL, [{ found: 1 }]);
  const sqlite = new ProviderStub(DATABASE_DIALECTS.SQLITE, [{ found: 1 }]);
  assert.equal(await createRepositorySql(postgres).relationExists("products"), true);
  assert.match(postgres.calls[0].text, /information_schema\.tables/);
  assert.equal(await createRepositorySql(sqlite).relationExists("products"), true);
  assert.match(sqlite.calls[0].text, /sqlite_master/);
});
