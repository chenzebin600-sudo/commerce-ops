export const PHASE3C_READINESS_CONTRACT = "COMMERCE-OPS-PG-PHASE3C-READINESS-1.0.0";

function check(id, description, passed, evidence, { required = true } = {}) {
  return Object.freeze({
    id,
    description,
    required,
    status: passed ? "PASS" : required ? "BLOCKED" : "ADVISORY",
    evidence,
  });
}

function leastPrivilege(role) {
  return Boolean(role)
    && !role.superuser
    && !role.createDatabase
    && !role.createRole
    && !role.replication
    && !role.bypassRowSecurity;
}

export function evaluatePhase3cReadiness(input) {
  if (!input?.identity || !input?.roles || !input?.settings || !input?.tools) {
    throw new TypeError("Phase 3C readiness evidence is incomplete");
  }
  const { identity, roles, privileges, schema, settings, extensions, tools, evidence } = input;
  const archiveMode = new Set(["on", "always"]).has(String(settings.archiveMode || "").toLowerCase());
  const walLevel = new Set(["replica", "logical"]).has(String(settings.walLevel || "").toLowerCase());
  const slowQueryThreshold = Number(settings.logMinDurationStatement);
  const checks = [
    check("production_provider_sqlite", "Production remains on SQLite during migration preparation", input.productionProvider === "sqlite", input.productionProvider),
    check("candidate_identity", "Read-only inspection targets the configured PostgreSQL production candidate", identity.database === input.expectedDatabase && identity.username === input.expectedMigrator && identity.readOnly === "on", identity),
    check("migrator_least_privilege", "Migrator role is non-superuser and cannot administer roles or databases", leastPrivilege(roles.migrator), roles.migrator),
    check("application_least_privilege", "Application role is non-superuser and cannot administer roles or databases", leastPrivilege(roles.application), roles.application),
    check("database_connect_privileges", "Only the intended application roles have required candidate connectivity", Boolean(privileges?.migratorConnect && privileges?.applicationConnect), privileges),
    check("schema_ownership", "The app schema is owned by the migrator role", schema?.owner === input.expectedMigrator, schema),
    check("application_schema_privileges", "Application has schema usage without schema create", Boolean(schema?.applicationUsage && !schema?.applicationCreate), schema),
    check("tls", "PostgreSQL client and server TLS are enabled", Boolean(input.clientSsl && settings.ssl === "on"), { clientSsl: input.clientSsl, serverSsl: settings.ssl }),
    check("wal_level", "WAL level supports physical or logical recovery", walLevel, settings.walLevel),
    check("wal_archiving", "WAL archiving is enabled with a non-placeholder archive command", archiveMode && settings.archiveCommandConfigured, { archiveMode: settings.archiveMode, archiveCommandConfigured: settings.archiveCommandConfigured }),
    check("data_checksums", "PostgreSQL data checksums are enabled", settings.dataChecksums === "on", settings.dataChecksums),
    check("backup_cli", "pg_dump is available", tools.pgDump.available, tools.pgDump),
    check("restore_cli", "pg_restore is available", tools.pgRestore.available, tools.pgRestore),
    check("basebackup_cli", "pg_basebackup is available for physical backup rehearsal", tools.pgBasebackup.available, tools.pgBasebackup),
    check("slow_query_logging", "A bounded slow-query logging threshold is configured", Number.isFinite(slowQueryThreshold) && slowQueryThreshold >= 0 && slowQueryThreshold <= 1_000, settings.logMinDurationStatement),
    check("io_timing", "I/O timing collection is enabled", settings.trackIoTiming === "on", settings.trackIoTiming),
    check("pg_stat_statements", "pg_stat_statements is installed and preloaded", Boolean(extensions?.pgStatStatementsInstalled && extensions?.pgStatStatementsPreloaded), extensions),
    check("encrypted_backup_evidence", "Encrypted backup storage and retention are documented", Boolean(evidence?.encryptedBackup), evidence?.encryptedBackup || false),
    check("restore_rehearsal_evidence", "A successful current-schema restore rehearsal is recorded", Boolean(evidence?.restoreRehearsal), evidence?.restoreRehearsal || false),
    check("monitoring_evidence", "Connection, lock, replication, disk, and slow-query monitoring evidence exists", Boolean(evidence?.monitoring), evidence?.monitoring || false),
    check("capacity_baseline", "Production-like capacity and latency baselines are approved", Boolean(evidence?.capacityBaseline), evidence?.capacityBaseline || false),
  ];
  const blockers = checks.filter((item) => item.required && item.status !== "PASS");
  return Object.freeze({
    status: blockers.length ? "NOT_READY" : "PASS",
    contract: PHASE3C_READINESS_CONTRACT,
    checks,
    passed: checks.filter((item) => item.status === "PASS").length,
    blocked: blockers.length,
    blockerIds: blockers.map((item) => item.id),
    isSwitchReady: false,
  });
}
