import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { openProvider } from "../lib/data/open-provider.mjs";
import { loadSharedPostgresqlConfig } from "../lib/data/postgresql/shared-runtime-config.mjs";
import { PostgresqlSchedulerRepository } from "../lib/data/postgresql/postgresql-scheduler-repository.mjs";

class UnavailablePool {
  on() {}
  async connect() { throw Object.assign(new Error("connection unavailable"), { code: "ECONNREFUSED" }); }
  async end() {}
}

test("PostgreSQL startup failure never creates or falls back to SQLite", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "postgres-no-fallback-"));
  const databasePath = path.join(root, "must-not-exist.sqlite");
  const config = {
    host: "127.0.0.1", port: 1, database: "commerce_ops_test", schema: "app", appUser: "commerce_app",
    sslmode: "verify-full", channelBinding: "require", ssl: { ca: "PUBLIC-CA", rejectUnauthorized: true },
    poolMax: 1, poolIdleTimeoutMs: 1_000, connectionTimeoutMs: 1_000, statementTimeoutMs: 1_000,
  };
  try {
    await assert.rejects(() => openProvider({ providerName: "postgres", databasePath,
      postgresqlConfig: config, credentials: { password: "not-logged" }, PoolClass: UnavailablePool }), /connection unavailable/);
    await assert.rejects(() => fs.stat(databasePath), { code: "ENOENT" });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("an invalid PostgreSQL CA is rejected before any SQLite fallback", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "postgres-bad-ca-"));
  const caPath = path.join(root, "bad-ca.crt");
  const databasePath = path.join(root, "must-not-exist.sqlite");
  await fs.writeFile(caPath, "not a certificate", "utf8");
  try {
    assert.throws(() => loadSharedPostgresqlConfig({ rootDir: root, env: {
      POSTGRES_HOST: "127.0.0.1", POSTGRES_PORT: "5432", POSTGRES_DATABASE: "commerce_ops_test",
      POSTGRES_SCHEMA: "app", POSTGRES_APP_USER: "commerce_app", POSTGRES_SSLMODE: "verify-full",
      POSTGRES_CHANNEL_BINDING: "require", POSTGRES_SSLROOTCERT: caPath,
    } }), /must contain a PEM certificate/);
    await assert.rejects(() => fs.stat(databasePath), { code: "ENOENT" });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

const live = process.env.COMMERCE_POSTGRES_SHARED_SMOKE === "1";

test("two PostgreSQL instances share committed data and contend for one lease", { skip: !live }, async () => {
  const config = loadSharedPostgresqlConfig({ rootDir: process.cwd(), env: process.env });
  if (!/_test$/.test(config.database)) throw new Error("Shared smoke test requires POSTGRES_DATABASE ending in _test");
  const credentials = { password: String(process.env.POSTGRES_APP_PASSWORD || "") };
  const first = await openProvider({ providerName: "postgres", postgresqlConfig: config, credentials });
  const second = await openProvider({ providerName: "postgres", postgresqlConfig: config, credentials });
  const name = `smoke-${randomUUID()}`;
  try {
    const a = new PostgresqlSchedulerRepository({ provider: first });
    const b = new PostgresqlSchedulerRepository({ provider: second });
    assert.equal(await a.acquireLease(name, "instance-a", new Date(), 60_000), true);
    assert.equal(await b.acquireLease(name, "instance-b", new Date(), 60_000), false);
    const visible = await second.query(`SELECT owner_id FROM "${config.schema}"."scheduler_leases" WHERE name=$1`, [name]);
    assert.equal(visible.rows[0]?.owner_id, "instance-a");
    assert.equal(await a.releaseLease(name, "instance-a"), true);
    assert.equal(await b.acquireLease(name, "instance-b", new Date(), 60_000), true);
    const updated = await first.query(`SELECT owner_id FROM "${config.schema}"."scheduler_leases" WHERE name=$1`, [name]);
    assert.equal(updated.rows[0]?.owner_id, "instance-b");
  } finally {
    await first.execute(`DELETE FROM "${config.schema}"."scheduler_leases" WHERE name=$1`, [name]).catch(() => {});
    await Promise.all([first.close(), second.close()]);
  }
});
