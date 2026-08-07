import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "../lib/env.mjs";
import { updateEnvValues } from "../integrations/lazada-oauth/lazada-oauth-service.mjs";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
loadLocalEnv(rootDir);

function runCloudflared(args, { secretOutput = false } = {}) {
  const result = spawnSync("cloudflared", args, {
    cwd: rootDir,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "cloudflared failed").trim();
    throw new Error(detail);
  }
  if (!secretOutput && result.stderr?.trim()) process.stderr.write(result.stderr);
  return String(result.stdout || "").trim();
}

function argument(name) {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length) || "";
}

const tunnelName = argument("name") || process.env.CLOUDFLARE_TUNNEL_NAME || "commerce-ops-lazada-oauth";
const hostname = argument("hostname") || process.env.CLOUDFLARE_TUNNEL_HOSTNAME || "";
if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(hostname)) {
  throw new Error("Pass a full DNS hostname, for example --hostname=lazada-oauth.example.com");
}

const tunnels = JSON.parse(runCloudflared(["tunnel", "list", "--output", "json"]));
let tunnel = tunnels.find((item) => item.name === tunnelName && !item.deleted_at);
if (!tunnel) {
  runCloudflared(["tunnel", "create", tunnelName]);
  const refreshed = JSON.parse(runCloudflared(["tunnel", "list", "--output", "json"]));
  tunnel = refreshed.find((item) => item.name === tunnelName && !item.deleted_at);
}
if (!tunnel?.id) throw new Error(`Cloudflare Tunnel was not found after creation: ${tunnelName}`);

const routeOutput = runCloudflared(["tunnel", "route", "dns", tunnel.id, hostname]);
if (routeOutput) process.stdout.write(`${routeOutput}\n`);
const token = runCloudflared(["tunnel", "token", tunnel.id], { secretOutput: true });
if (!token) throw new Error("Cloudflare did not return a tunnel token");

const publicUrl = `https://${hostname}`;
const appCount = Number.parseInt(process.env.LAZADA_APP_COUNT || "3", 10) || 3;
const callbackUrls = {};
const callbackEnv = {
  LAZADA_CALLBACK_BASE_URL: publicUrl,
  LAZADA_CALLBACK_URL: `${publicUrl}/lazada/callback`,
};
for (let index = 1; index <= appCount; index += 1) {
  const appId = String(process.env[`LAZADA_APP_${index}_ID`] || `app-${index}`).trim().toLowerCase();
  const callbackUrl = index === 1
    ? `${publicUrl}/lazada/callback`
    : `${publicUrl}/lazada/apps/${appId}/callback`;
  callbackUrls[appId] = callbackUrl;
  callbackEnv[`LAZADA_APP_${index}_CALLBACK_URL`] = callbackUrl;
}
await updateEnvValues(path.join(rootDir, ".env"), {
  CLOUDFLARE_TUNNEL_NAME: tunnelName,
  CLOUDFLARE_TUNNEL_ID: tunnel.id,
  CLOUDFLARE_TUNNEL_HOSTNAME: hostname,
  CLOUDFLARE_TUNNEL_TOKEN: token,
  ...callbackEnv,
});

console.log(`Tunnel configured: ${tunnelName} (${tunnel.id})`);
for (const [appId, callbackUrl] of Object.entries(callbackUrls)) console.log(`${appId} callback: ${callbackUrl}`);
console.log("Tunnel token was saved to .env and was not printed.");
