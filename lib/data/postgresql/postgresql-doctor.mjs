export async function inspectPostgresqlReadiness({ provider, config, caFingerprint, externalTaskStatus, tcpCheck }) {
  const tcp = await tcpCheck(config.host, config.port);
  const [tlsResult, identityResult, migrationResult, privilegeResult] = await Promise.all([
    provider.query("SELECT ssl,version,bits FROM pg_stat_ssl WHERE pid=pg_backend_pid()"),
    provider.query("SELECT current_database() AS database,current_user AS username,current_schema() AS schema"),
    provider.query(`SELECT version FROM "${config.schema}"."schema_migrations" ORDER BY applied_at DESC,version DESC LIMIT 1`),
    provider.query("SELECT has_schema_privilege(current_user,$1,'CREATE') AS can_create", [config.schema]),
  ]);
  const tls = tlsResult.rows[0] || {}, identity = identityResult.rows[0] || {};
  const identityMatches = identity.database === config.database && identity.username === config.appUser && identity.schema === config.schema;
  const tlsReady = tls.ssl === true && String(tls.version || "").startsWith("TLSv1.3");
  const ddlDenied = privilegeResult.rows[0]?.can_create === false;
  const schemaVersion = migrationResult.rows[0]?.version || null;
  return Object.freeze({
    ready: Boolean(tcp && identityMatches && tlsReady && ddlDenied && schemaVersion),
    details: Object.freeze({
      provider: "postgres", host: config.host, port: config.port, database: config.database, schema: config.schema,
      sslmode: config.sslmode, channelBinding: config.channelBinding, caFingerprint,
      tcp: Boolean(tcp), identityMatches, tls: `${tls.version || "unknown"}/${Number(tls.bits || 0)}`,
      schemaVersion, appRoleDdlDenied: ddlDenied, externalTaskStatus,
    }),
  });
}
