import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  StrictChannelBindingClient,
  buildPostgresqlPoolOptions,
  loadSharedPostgresqlConfig,
} from "../lib/data/postgresql/shared-runtime-config.mjs";

const PUBLIC_CA = "-----BEGIN CERTIFICATE-----\nTEST PUBLIC CA\n-----END CERTIFICATE-----\n";

async function fixture(overrides = {}) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "shared-postgresql-config-"));
  const certificatePath = path.join(rootDir, "commerce-ops-ca.crt");
  await fs.writeFile(certificatePath, PUBLIC_CA, "utf8");
  const env = {
    POSTGRES_HOST: "10.110.80.117",
    POSTGRES_PORT: "5432",
    POSTGRES_DATABASE: "commerce_ops",
    POSTGRES_SCHEMA: "app",
    POSTGRES_APP_USER: "commerce_app",
    POSTGRES_SSLMODE: "verify-full",
    POSTGRES_SSLROOTCERT: certificatePath,
    POSTGRES_CHANNEL_BINDING: "require",
    POSTGRES_POOL_MAX: "5",
    POSTGRES_POOL_IDLE_TIMEOUT_MS: "30000",
    POSTGRES_CONNECTION_TIMEOUT_MS: "10000",
    POSTGRES_STATEMENT_TIMEOUT_MS: "30000",
    POSTGRES_APP_PASSWORD: "must-not-enter-public-config",
    ...overrides,
  };
  return {
    rootDir,
    env,
    async close() { await fs.rm(rootDir, { recursive: true, force: true }); },
  };
}

test("shared PostgreSQL rejects TLS or channel-binding downgrade", async () => {
  const context = await fixture();
  try {
    assert.throws(
      () => loadSharedPostgresqlConfig({ rootDir: context.rootDir, env: { ...context.env, POSTGRES_SSLMODE: "require" } }),
      /POSTGRES_SSLMODE must be verify-full/,
    );
    assert.throws(
      () => loadSharedPostgresqlConfig({ rootDir: context.rootDir, env: { ...context.env, POSTGRES_CHANNEL_BINDING: "prefer" } }),
      /POSTGRES_CHANNEL_BINDING must be require/,
    );
  } finally {
    await context.close();
  }
});

test("shared PostgreSQL loads only public connection configuration", async () => {
  const context = await fixture();
  try {
    const config = loadSharedPostgresqlConfig({ rootDir: context.rootDir, env: context.env });
    assert.equal(config.host, "10.110.80.117");
    assert.equal(config.port, 5432);
    assert.equal(config.database, "commerce_ops");
    assert.equal(config.schema, "app");
    assert.deepEqual(config.ssl, { ca: PUBLIC_CA, rejectUnauthorized: true });
    assert.equal(Object.hasOwn(config, "appPassword"), false);
    assert.equal(JSON.stringify(config).includes("must-not-enter-public-config"), false);
  } finally {
    await context.close();
  }
});

test("pool options require verified TLS and channel binding", async () => {
  const context = await fixture();
  try {
    const config = loadSharedPostgresqlConfig({ rootDir: context.rootDir, env: context.env });
    const options = buildPostgresqlPoolOptions(config, { password: "local-only-password" });
    assert.equal(options.host, "10.110.80.117");
    assert.equal(options.user, "commerce_app");
    assert.equal(options.enableChannelBinding, true);
    assert.equal(options.Client, StrictChannelBindingClient);
    assert.deepEqual(options.ssl, { ca: PUBLIC_CA, rejectUnauthorized: true });
    assert.equal(options.password, "local-only-password");
  } finally {
    await context.close();
  }
});

test("strict client rejects a server that does not offer SCRAM-SHA-256-PLUS", () => {
  const client = new StrictChannelBindingClient({ user: "commerce_app", password: "not-logged" });
  const connection = new EventEmitter();
  client.connection = connection;
  const error = new Promise((resolve) => connection.once("error", resolve));

  client._handleAuthSASL({ mechanisms: ["SCRAM-SHA-256"] });

  return assert.doesNotReject(async () => {
    const received = await error;
    assert.equal(received.code, "PG_CHANNEL_BINDING_REQUIRED");
    assert.equal(received.message, "Required channel binding is unavailable");
  });
});
