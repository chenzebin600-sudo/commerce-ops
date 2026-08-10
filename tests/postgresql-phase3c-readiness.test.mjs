import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { evaluatePhase3cReadiness } from "../lib/postgresql/phase3c-readiness.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");

function role(name) {
  return {
    name,
    superuser: false,
    createDatabase: false,
    createRole: false,
    replication: false,
    bypassRowSecurity: false,
  };
}

function readyEvidence() {
  return {
    productionProvider: "sqlite",
    expectedDatabase: "commerce_ops",
    expectedMigrator: "commerce_migrator",
    clientSsl: true,
    identity: {
      database: "commerce_ops",
      username: "commerce_migrator",
      readOnly: "on",
      serverVersion: "17.5",
    },
    roles: {
      migrator: role("commerce_migrator"),
      application: role("commerce_app"),
    },
    privileges: { migratorConnect: true, applicationConnect: true },
    schema: {
      owner: "commerce_migrator",
      migratorUsage: true,
      migratorCreate: true,
      applicationUsage: true,
      applicationCreate: false,
      tableCount: 0,
    },
    settings: {
      ssl: "on",
      walLevel: "replica",
      archiveMode: "on",
      archiveCommandConfigured: true,
      dataChecksums: "on",
      logMinDurationStatement: "500",
      trackIoTiming: "on",
    },
    extensions: { pgStatStatementsInstalled: true, pgStatStatementsPreloaded: true },
    tools: {
      pgDump: { available: true, version: "pg_dump 17.5" },
      pgRestore: { available: true, version: "pg_restore 17.5" },
      pgBasebackup: { available: true, version: "pg_basebackup 17.5" },
    },
    evidence: {
      encryptedBackup: { encryptionEnabled: true, retentionDays: 30 },
      restoreRehearsal: { status: "PASS", report: "restore.json" },
      monitoring: { configured: true },
      capacityBaseline: { status: "PASS", report: "capacity.json" },
    },
  };
}

test("Phase 3C evaluates all operational gates but never authorizes a provider switch", () => {
  const result = evaluatePhase3cReadiness(readyEvidence());
  assert.equal(result.status, "PASS");
  assert.equal(result.blocked, 0);
  assert.equal(result.isSwitchReady, false);
  assert.equal(result.checks.every((item) => item.status === "PASS"), true);
});

test("Phase 3C reports concrete TLS, recovery, monitoring, and rehearsal blockers", () => {
  const input = readyEvidence();
  input.clientSsl = false;
  input.settings = {
    ...input.settings,
    ssl: "off",
    archiveMode: "off",
    archiveCommandConfigured: false,
    dataChecksums: "off",
    logMinDurationStatement: "-1",
    trackIoTiming: "off",
  };
  input.extensions = { pgStatStatementsInstalled: false, pgStatStatementsPreloaded: false };
  input.evidence = {
    encryptedBackup: false,
    restoreRehearsal: false,
    monitoring: false,
    capacityBaseline: false,
  };
  const result = evaluatePhase3cReadiness(input);
  assert.equal(result.status, "NOT_READY");
  for (const blocker of [
    "tls",
    "wal_archiving",
    "data_checksums",
    "slow_query_logging",
    "io_timing",
    "pg_stat_statements",
    "encrypted_backup_evidence",
    "restore_rehearsal_evidence",
    "monitoring_evidence",
    "capacity_baseline",
  ]) assert.ok(result.blockerIds.includes(blocker));
  assert.equal(result.isSwitchReady, false);
});

test("Phase 3C runner is read-only and does not expose secret configuration", async () => {
  const source = await readFile(path.join(ROOT, "scripts", "postgresql-phase3c-readiness.mjs"), "utf8");
  assert.match(source, /database: config\.database/);
  assert.match(source, /readOnly: true/);
  assert.doesNotMatch(source, /\b(?:INSERT INTO|UPDATE\s+[^"']|DELETE FROM|DROP\s+(?:TABLE|SCHEMA|DATABASE)|ALTER\s+(?:TABLE|ROLE|DATABASE)|GRANT\s|REVOKE\s)\b/i);
  assert.doesNotMatch(source, /JSON\.stringify\(config/);
  assert.doesNotMatch(source, /\.\.\.config/);
});
