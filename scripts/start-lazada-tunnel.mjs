import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "../lib/env.mjs";
import { updateEnvValues } from "../integrations/lazada-oauth/lazada-oauth-service.mjs";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
loadLocalEnv(rootDir);

const originUrl = `http://${process.env.LAZADA_OAUTH_HOST || "127.0.0.1"}:${process.env.LAZADA_OAUTH_PORT || "8977"}`;
const token = String(process.env.CLOUDFLARE_TUNNEL_TOKEN || "").trim();
const mode = String(process.env.CLOUDFLARE_TUNNEL_MODE || (token ? "named" : "quick")).trim().toLowerCase();
if (!new Set(["quick", "named"]).has(mode)) throw new Error("CLOUDFLARE_TUNNEL_MODE must be quick or named");
if (mode === "named" && !token) throw new Error("CLOUDFLARE_TUNNEL_TOKEN is not configured in .env");

const args = mode === "quick"
  ? ["tunnel", "--no-autoupdate", "--loglevel", "info", "--url", originUrl]
  : ["tunnel", "--no-autoupdate", "run", "--url", originUrl];
const child = spawn("cloudflared", args, {
  cwd: rootDir,
  env: mode === "named" ? { ...process.env, TUNNEL_TOKEN: token } : process.env,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

const statusPath = path.join(rootDir, "storage", "lazada-quick-tunnel.json");
let quickTunnelUrl = "";
let persistencePromise = Promise.resolve();

function multiAppCallbacks(publicUrl) {
  const appCount = Number.parseInt(process.env.LAZADA_APP_COUNT || "3", 10) || 3;
  const callbacks = {};
  const envValues = {
    LAZADA_CALLBACK_BASE_URL: publicUrl,
    LAZADA_CALLBACK_URL: `${publicUrl}/lazada/callback`,
  };
  for (let index = 1; index <= appCount; index += 1) {
    const appId = String(process.env[`LAZADA_APP_${index}_ID`] || `app-${index}`).trim().toLowerCase();
    const callbackUrl = index === 1
      ? `${publicUrl}/lazada/callback`
      : `${publicUrl}/lazada/apps/${appId}/callback`;
    callbacks[appId] = callbackUrl;
    envValues[`LAZADA_APP_${index}_CALLBACK_URL`] = callbackUrl;
  }
  return { callbacks, envValues };
}

function inspectLine(line, output) {
  output.write(`${line}\n`);
  if (mode !== "quick" || quickTunnelUrl) return;
  const match = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  if (!match) return;
  quickTunnelUrl = match[0];
  const { callbacks, envValues } = multiAppCallbacks(quickTunnelUrl);
  const callbackUrl = callbacks[process.env.LAZADA_APP_1_ID || "app-1"] || `${quickTunnelUrl}/lazada/callback`;
  persistencePromise = Promise.all([
    updateEnvValues(path.join(rootDir, ".env"), {
      CLOUDFLARE_TUNNEL_MODE: "quick",
      CLOUDFLARE_QUICK_TUNNEL_URL: quickTunnelUrl,
      ...envValues,
    }),
    fs.writeFile(statusPath, `${JSON.stringify({
      mode: "quick",
      origin_url: originUrl,
      public_url: quickTunnelUrl,
      callback_url: callbackUrl,
      callback_urls: callbacks,
      started_at: new Date().toISOString(),
    }, null, 2)}\n`, "utf8"),
  ]).then(() => {
    console.log(`Quick Tunnel ready: ${quickTunnelUrl}`);
    for (const [appId, appCallbackUrl] of Object.entries(callbacks)) console.log(`${appId} callback: ${appCallbackUrl}`);
  }).catch((error) => {
    console.error(`Unable to persist Quick Tunnel URL: ${error.message}`);
    child.kill("SIGTERM");
  });
}

readline.createInterface({ input: child.stdout }).on("line", (line) => inspectLine(line, process.stdout));
readline.createInterface({ input: child.stderr }).on("line", (line) => inspectLine(line, process.stderr));

child.on("error", (error) => {
  console.error(`Unable to start cloudflared: ${error.message}`);
  process.exitCode = 1;
});
child.on("exit", async (code, signal) => {
  await persistencePromise;
  if (signal) console.error(`cloudflared stopped by ${signal}`);
  process.exitCode = Number(code || 0);
});

function shutdown(signal) {
  if (!child.killed) child.kill(signal);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
