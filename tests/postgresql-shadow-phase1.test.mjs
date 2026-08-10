import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { buildShadowSchema, selectShadowDataTables } from "../lib/postgresql/shadow/shadow-schema.mjs";
import { LocalStorageProvider } from "../lib/storage/local-storage-provider.mjs";
import { MinioStorageProvider } from "../lib/storage/minio-storage-provider.mjs";
import { normalizeStorageKey } from "../lib/storage/storage-provider.mjs";

test("Shadow schema uses explicit text identifiers, JSONB, timestamps, constraints, and dependency closure", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE parent (id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent(id), quantity NUMERIC NOT NULL CHECK(quantity >= 0));
    CREATE VIEW child_v AS SELECT * FROM child;
  `);
  database.prepare("INSERT INTO parent VALUES (?,?,?)").run("platform-123", '{"ok":true}', "2026-08-05T00:00:00.000Z");
  database.prepare("INSERT INTO child VALUES (?,?,?)").run("child-1", "platform-123", 2.5);
  const generated = buildShadowSchema(database);
  const parent = generated.contract.tables.find((table) => table.name === "parent");
  assert.equal(parent.columns.find((column) => column.name === "id").logicalType, "text");
  assert.equal(parent.columns.find((column) => column.name === "payload_json").logicalType, "json");
  assert.equal(parent.columns.find((column) => column.name === "created_at").logicalType, "timestamp");
  assert.match(generated.tableSql, /jsonb/);
  assert.match(generated.deferredSql, /FOREIGN KEY/);
  assert.match(generated.deferredSql, /CREATE VIEW "app"\."child_v"/);
  assert.deepEqual(selectShadowDataTables(generated.source), []);
  database.close();
});

test("Storage Provider contract preserves local behavior and keeps MinIO injectable", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "commerce-storage-provider-"));
  try {
    assert.throws(() => normalizeStorageKey("../escape"), /invalid/);
    const local = new LocalStorageProvider({ rootDir: root });
    await local.put("reports/test.txt", "ok");
    assert.equal((await local.get("reports/test.txt")).toString(), "ok");
    assert.equal((await local.stat("reports/test.txt")).provider, "local");

    const calls = [];
    const minio = new MinioStorageProvider({
      bucket: "commerce-ops",
      client: {
        async putObject(...args) { calls.push(["put", ...args]); },
        async getObject(...args) { calls.push(["get", ...args]); return "stream"; },
        async statObject() { return { size: 2, etag: "etag" }; },
        async removeObject(...args) { calls.push(["remove", ...args]); },
      },
    });
    assert.equal((await minio.put("reports/test.txt", "ok")).provider, "minio");
    assert.equal(await minio.get("reports/test.txt"), "stream");
    assert.equal(calls[0][1], "commerce-ops");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

