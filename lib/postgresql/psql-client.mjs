import { spawnSync } from "node:child_process";

function redact(value, secrets = []) {
  let output = String(value || "");
  for (const secret of secrets) {
    if (secret) output = output.split(secret).join("[REDACTED]");
  }
  return output.replace(/(?:password|token|secret)\s*[=:]\s*\S+/gi, "$1=[REDACTED]");
}

export function runPsql({
  config,
  database,
  user,
  password,
  sql,
  secretEnvironment = {},
  runner = spawnSync,
  timeoutMs = 60_000,
}) {
  const secrets = [config.adminPassword, config.migratorPassword, config.appPassword, password, ...Object.values(secretEnvironment)];
  const result = runner("psql", [
    "--no-psqlrc",
    "--set=ON_ERROR_STOP=1",
    "--quiet",
    "--tuples-only",
    "--no-align",
    "--host", config.host,
    "--port", String(config.port),
    "--username", user,
    "--dbname", database,
  ], {
    input: sql,
    encoding: "utf8",
    windowsHide: true,
    timeout: timeoutMs,
    env: {
      ...process.env,
      PGCONNECT_TIMEOUT: "10",
      PGPASSWORD: password,
      PGSSLMODE: config.ssl ? "require" : "disable",
      ...secretEnvironment,
    },
  });
  if (result.error || result.status !== 0) {
    const detail = redact(result.stderr || result.error?.message, secrets).split(/\r?\n/).filter(Boolean)[0] || "unknown error";
    throw new Error(`PostgreSQL command failed: ${detail.slice(0, 300)}`);
  }
  return String(result.stdout || "").trim();
}

export function parseSingleJson(output, context) {
  const line = String(output || "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean).at(-1);
  if (!line) throw new Error(`${context} returned no result`);
  try {
    return JSON.parse(line);
  } catch {
    throw new Error(`${context} returned an invalid result`);
  }
}
