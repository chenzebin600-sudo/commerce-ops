import assert from "node:assert/strict";
import test from "node:test";
import { inspectPostgresqlReadiness } from "../lib/data/postgresql/postgresql-doctor.mjs";

class DoctorProvider {
  constructor() { this.calls = []; }
  async query(text) {
    this.calls.push(text);
    if (text.includes("pg_stat_ssl")) return { rows: [{ ssl: true, version: "TLSv1.3", bits: 256 }] };
    if (text.includes("current_database")) return { rows: [{ database: "commerce_ops", username: "commerce_app", schema: "app" }] };
    if (text.includes("schema_migrations")) return { rows: [{ version: "001_shared_baseline.sql" }] };
    if (text.includes("has_schema_privilege")) return { rows: [{ can_create: false }] };
    return { rows: [] };
  }
}

test("PostgreSQL Doctor reports readiness without credentials or CA contents", async () => {
  const provider = new DoctorProvider();
  const report = await inspectPostgresqlReadiness({
    provider,
    config: { host: "10.110.80.117", port: 5432, database: "commerce_ops", schema: "app",
      appUser: "commerce_app", sslmode: "verify-full", channelBinding: "require", ssl: { ca: "TOP-SECRET-CA" } },
    caFingerprint: "sha256:public-fingerprint", externalTaskStatus: "disabled_by_configuration",
    tcpCheck: async () => true,
  });
  assert.equal(report.ready, true);
  assert.equal(report.details.tls, "TLSv1.3/256");
  assert.equal(report.details.schemaVersion, "001_shared_baseline.sql");
  assert.equal(report.details.appRoleDdlDenied, true);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes("TOP-SECRET-CA"), false);
  assert.equal(serialized.includes("password"), false);
  assert.equal(provider.calls.some((sql) => /CREATE\s+TABLE/i.test(sql)), false);
});
