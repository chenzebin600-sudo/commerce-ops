import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const schemaUrl = new URL("../docs/design/fulfillment-v2-postgresql-schema.sql", import.meta.url);

async function schemaSql() {
  return readFile(schemaUrl, "utf8");
}

function tableNames(sql) {
  return [...sql.matchAll(/^CREATE TABLE fulfillment\.([a-z_]+)/gm)].map((match) => match[1]);
}

test("fulfillment V2 schema defines a complete isolated transaction", async () => {
  const sql = await schemaSql();
  assert.match(sql, /^BEGIN;$/m);
  assert.match(sql, /^COMMIT;$/m);
  assert.equal((sql.match(/^BEGIN;$/gm) || []).length, 1);
  assert.equal((sql.match(/^COMMIT;$/gm) || []).length, 1);
  assert.doesNotMatch(sql, /\b(?:DROP|TRUNCATE)\s+(?:TABLE|SCHEMA)\b/i);
});

test("fulfillment V2 schema references only defined tables", async () => {
  const sql = await schemaSql();
  const defined = tableNames(sql);
  assert.equal(new Set(defined).size, defined.length);
  const referenced = [...sql.matchAll(/REFERENCES fulfillment\.([a-z_]+)/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(referenced.filter((name) => !defined.includes(name)))], []);
});

test("manual approval requires an authenticated human identity snapshot", async () => {
  const sql = await schemaSql();
  const approval = sql.match(/CREATE TABLE fulfillment\.approval_decisions \(([\s\S]*?)\n\);/)?.[1] || "";
  for (const required of [
    "actor_id uuid NOT NULL",
    "actor_subject_snapshot text NOT NULL",
    "actor_display_name_snapshot text NOT NULL",
    "auth_source_snapshot text NOT NULL",
    "request_id text NOT NULL",
    "decided_at timestamptz NOT NULL",
  ]) assert.match(approval, new RegExp(required.replaceAll(" ", "\\s+")));
  assert.match(approval, /approval_mode = 'manual' AND actor_type_snapshot = 'human'/);
  assert.match(approval, /approval_mode = 'automatic' AND actor_type_snapshot IN \('service', 'system'\)/);
});

test("approval history is append-only with a separate current-state projection", async () => {
  const sql = await schemaSql();
  assert.match(sql, /CREATE TABLE fulfillment\.preview_approval_state/);
  assert.match(sql, /FOREIGN KEY \(current_decision_id, preview_id\)[\s\S]*?REFERENCES fulfillment\.approval_decisions\(id, preview_id\)/);
  assert.match(sql, /supersedes_decision_id uuid REFERENCES fulfillment\.approval_decisions\(id\)/);
  assert.match(sql, /decision = 'revoked' AND supersedes_decision_id IS NOT NULL/);
});

test("jobs are bound to the approved decision for the same preview", async () => {
  const sql = await schemaSql();
  const jobs = sql.match(/CREATE TABLE fulfillment\.jobs \(([\s\S]*?)\n\);/)?.[1] || "";
  assert.match(jobs, /preview_id uuid NOT NULL UNIQUE REFERENCES fulfillment\.previews\(id\)/);
  assert.match(jobs, /approval_decision_id uuid NOT NULL UNIQUE/);
  assert.match(jobs, /FOREIGN KEY \(approval_decision_id, preview_id\)[\s\S]*?REFERENCES fulfillment\.approval_decisions\(id, preview_id\)/);
});
