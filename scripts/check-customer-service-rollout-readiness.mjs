import { evaluateCustomerServiceDeploymentReadiness } from "../lib/customer-service/customer-service-deployment-readiness.mjs";

function option(name, fallback = null) {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find((item) => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

const baseUrl = String(option("url", "http://127.0.0.1:3101")).replace(/\/+$/, "");
const target = option("target", "observe");
const accountId = option("account-id");

async function api(pathname) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "GET",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(8_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${pathname} returned HTTP ${response.status}: ${body.code || body.error || "unknown error"}`);
  return body;
}

try {
  const [statusResponse, accountsResponse] = await Promise.all([
    api("/api/customer-service/status"),
    api("/api/customer-service/accounts"),
  ]);
  const result = evaluateCustomerServiceDeploymentReadiness({
    status: statusResponse.status,
    accounts: accountsResponse.accounts || [],
    target,
    accountId,
  });
  process.stdout.write(`${JSON.stringify({ baseUrl, ...result }, null, 2)}\n`);
  if (!result.ready) process.exitCode = 2;
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    contractVersion: "CS_DEPLOYMENT_READINESS_V1",
    baseUrl,
    ready: false,
    code: "CS_READINESS_CHECK_FAILED",
    error: error instanceof Error ? error.message : String(error),
  }, null, 2)}\n`);
  process.exitCode = 1;
}
