import assert from "node:assert/strict";
import test from "node:test";
import { encodeImportedPostgresqlValue } from "../lib/data/postgresql/import-value.mjs";

test("shared import encoding handles JSON arrays and objects as JSON text", () => {
  assert.equal(encodeImportedPostgresqlValue("[]", { data_type: "jsonb" }), "[]");
  assert.equal(encodeImportedPostgresqlValue('{"ok":true}', { data_type: "jsonb" }), '{"ok":true}');
  assert.equal(encodeImportedPostgresqlValue([1, 2], { data_type: "jsonb" }), "[1,2]");
  assert.deepEqual(JSON.parse(encodeImportedPostgresqlValue('{"id":"a\\u0000b"}', { data_type: "jsonb" })), {
    id: "a\\u0000b",
  });
});

test("shared import encoding normalizes only the approved legacy report timestamp", () => {
  assert.equal(encodeImportedPostgresqlValue("04/08/2026 19:16", {
    data_type: "timestamp with time zone", table: "advertising_source_batches", column: "report_created_at",
  }), "2026-08-04T19:16:00Z");
  assert.throws(() => encodeImportedPostgresqlValue("04/08/2026 19:16", {
    data_type: "timestamp with time zone", table: "other", column: "created_at",
  }), /Unexpected legacy timestamp/);
});

test("shared import encoding preserves text identifiers and validates booleans", () => {
  assert.equal(encodeImportedPostgresqlValue("platform-product-1", { data_type: "text" }), "platform-product-1");
  assert.equal(encodeImportedPostgresqlValue(1, { data_type: "boolean" }), true);
  assert.equal(encodeImportedPostgresqlValue("0", { data_type: "boolean" }), false);
  assert.throws(() => encodeImportedPostgresqlValue(2, { data_type: "boolean" }), /Invalid boolean/);
});
