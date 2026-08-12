import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openProvider } from "../lib/data/open-provider.mjs";

const postgresqlConfig = Object.freeze({
  host: "10.110.80.117",
  port: 5432,
  database: "commerce_ops",
  schema: "app",
  appUser: "commerce_app",
  sslmode: "verify-full",
  channelBinding: "require",
  ssl: Object.freeze({ ca: "-----BEGIN CERTIFICATE-----\nPUBLIC\n-----END CERTIFICATE-----\n", rejectUnauthorized: true }),
  poolMax: 3,
  poolIdleTimeoutMs: 30_000,
  connectionTimeoutMs: 5_000,
  statementTimeoutMs: 10_000,
});

class IdentityClient {
  constructor(identity = { database: "commerce_ops", username: "commerce_app", schema: "app" }) {
    this.identity = identity;
  }

  async query(query) {
    const text = typeof query === "string" ? query : query.text;
    if (text.includes("set_config")) return { rows: [{}], rowCount: 1 };
    if (text.includes("current_database")) return { rows: [this.identity], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }

  release() {}
}

class IdentityPool {
  constructor(options) {
    this.options = options;
    this.client = new IdentityClient(IdentityPool.identity);
  }

  on() {}
  async connect() { return this.client; }
  async end() {}
}

test("provider factory selects SQLite without PostgreSQL configuration", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "open-provider-sqlite-"));
  const databasePath = path.join(root, "commerce.sqlite");
  try {
    const provider = await openProvider({ providerName: "sqlite", databasePath });
    assert.equal(provider.dialect, "sqlite");
    assert.equal(provider.databasePath, databasePath);
    provider.close();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("provider factory verifies shared PostgreSQL identity before returning", async () => {
  IdentityPool.identity = { database: "commerce_ops", username: "commerce_app", schema: "app" };
  const provider = await openProvider({
    providerName: "postgres",
    postgresqlConfig,
    credentials: { password: "local-only-password" },
    PoolClass: IdentityPool,
  });
  try {
    assert.equal(provider.dialect, "postgresql");
    assert.equal(provider.connection.options.enableChannelBinding, true);
  } finally {
    await provider.close();
  }
});

test("provider factory rejects a wrong database identity without exposing it", async () => {
  IdentityPool.identity = { database: "other_database", username: "commerce_app", schema: "app" };
  await assert.rejects(() => openProvider({
    providerName: "postgresql",
    postgresqlConfig,
    credentials: { password: "local-only-password" },
    PoolClass: IdentityPool,
  }), (error) => {
    assert.equal(error.code, "PG_IDENTITY_MISMATCH");
    assert.equal(error.message.includes("other_database"), false);
    assert.equal(error.message.includes("local-only-password"), false);
    return true;
  });
});

test("provider factory rejects unknown names instead of creating SQLite", async () => {
  await assert.rejects(() => openProvider({ providerName: "postgress" }), /DATABASE_PROVIDER must be sqlite or postgres/);
});
