import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseProvider, DATABASE_DIALECTS } from "../lib/data/database-provider.mjs";
import {
  createPortableRepositoryExecutor,
  rewriteQuestionMarkPlaceholders,
} from "../lib/data/portable-repository-executor.mjs";

class ProviderStub extends DatabaseProvider {
  constructor(dialect) {
    super({ dialect });
    this.calls = [];
    this._transactionManager = { run() {} };
  }
  get connection() { return {}; }
  get transactionManager() { return this._transactionManager; }
  query(text, values = []) { this.calls.push({ kind: "query", text, values }); return Promise.resolve({ rows: [] }); }
  execute(text, values = []) { this.calls.push({ kind: "execute", text, values }); return Promise.resolve({ rows: [], rowCount: 0 }); }
  executeScript(text) { this.calls.push({ kind: "script", text }); return Promise.resolve({ rows: [], rowCount: 0 }); }
  placeholder(index) { return this.dialect === DATABASE_DIALECTS.POSTGRESQL ? `$${index}` : "?"; }
  transaction(callback) {
    return callback({
      query: (text, values) => this.query(text, values),
      execute: (text, values) => this.execute(text, values),
      executeScript: (text) => this.executeScript(text),
      placeholder: (index) => this.placeholder(index),
    });
  }
  close() {}
}

test("placeholder rewrite ignores SQL literals, identifiers, comments, and dollar quotes", () => {
  const source = `SELECT '?', "?", value FROM sample
    WHERE first=? AND note=$tag$?$tag$ AND second=? -- ?
    /* ? */`;
  assert.equal(
    rewriteQuestionMarkPlaceholders(source, DATABASE_DIALECTS.POSTGRESQL),
    `SELECT '?', "?", value FROM sample
    WHERE first=$1 AND note=$tag$?$tag$ AND second=$2 -- ?
    /* ? */`,
  );
});

test("portable executor leaves SQLite SQL unchanged", async () => {
  const provider = new ProviderStub(DATABASE_DIALECTS.SQLITE);
  const executor = createPortableRepositoryExecutor(provider);
  await executor.query("SELECT * FROM sample WHERE id=?", [1]);
  assert.equal(provider.calls[0].text, "SELECT * FROM sample WHERE id=?");
});

test("portable executor rewrites PostgreSQL queries and transaction statements", async () => {
  const provider = new ProviderStub(DATABASE_DIALECTS.POSTGRESQL);
  const executor = createPortableRepositoryExecutor(provider);
  await executor.query("SELECT * FROM sample WHERE first=? AND second=?", [1, 2]);
  await executor.transaction((transaction) => transaction.execute("UPDATE sample SET value=? WHERE id=?", [3, 4]));
  assert.equal(provider.calls[0].text, "SELECT * FROM sample WHERE first=$1 AND second=$2");
  assert.equal(provider.calls[1].text, "UPDATE sample SET value=$1 WHERE id=$2");
});
