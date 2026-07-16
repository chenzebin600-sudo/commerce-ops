import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import { mkdtempSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const adServiceDir = "D:\\codex\\Lazada-Sponsored Max analysis\\webapp";
const APP_TOKEN = "temporary-main-integration-token";
const INTERNAL_TOKEN = "temporary-main-ad-internal-token";

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForHealth(url, child, logs) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`service exited early: ${logs.join("")}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Service is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`service startup timed out: ${logs.join("")}`);
}

async function stop(child) {
  if (child.exitCode !== null) return;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("child process did not stop")), 5_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } else {
      child.kill("SIGTERM");
    }
  });
}

test("only the main origin is needed for an authenticated advertising module", { timeout: 30_000 }, async () => {
  const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), "commerce-ops-main-integration-"));
  const mainPort = await freePort();
  const adPort = await freePort();
  const mainUrl = `http://127.0.0.1:${mainPort}`;
  const adUrl = `http://127.0.0.1:${adPort}`;
  const adLogs = [];
  const mainLogs = [];
  const adService = spawn(process.execPath, ["server.mjs"], {
    cwd: adServiceDir,
    env: {
      ...process.env,
      AD_SERVICE_HOST: "127.0.0.1",
      AD_SERVICE_PORT: String(adPort),
      AD_SERVICE_INTERNAL_TOKEN: INTERNAL_TOKEN,
      AD_STANDALONE_ACCESS_TOKEN: "",
      DEEPSEEK_API_KEY: "",
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  adService.stdout.on("data", (chunk) => adLogs.push(chunk.toString()));
  adService.stderr.on("data", (chunk) => adLogs.push(chunk.toString()));

  let mainService;
  try {
    await waitForHealth(`${adUrl}/api/health`, adService, adLogs);
    mainService = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server.mjs"], {
      cwd: rootDir,
      env: {
        ...process.env,
        APP_HOST: "127.0.0.1",
        APP_PORT: String(mainPort),
        APP_ACCESS_TOKEN: APP_TOKEN,
        AD_SERVICE_HOST: "127.0.0.1",
        AD_SERVICE_PORT: String(adPort),
        AD_SERVICE_BASE_URL: adUrl,
        AD_SERVICE_INTERNAL_TOKEN: INTERNAL_TOKEN,
        AD_ANALYZER_DIR: adServiceDir,
        SCHEDULER_DB_PATH: path.join(runtimeRoot, "commerce-ops.sqlite"),
        STORAGE_ROOT: path.join(runtimeRoot, "storage"),
        UPLOAD_ROOT: path.join(runtimeRoot, "storage", "uploads"),
        EXPORT_ROOT: path.join(runtimeRoot, "storage", "exports"),
        TEMP_ROOT: path.join(runtimeRoot, "storage", "temp"),
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    mainService.stdout.on("data", (chunk) => mainLogs.push(chunk.toString()));
    mainService.stderr.on("data", (chunk) => mainLogs.push(chunk.toString()));
    await waitForHealth(`${mainUrl}/api/health`, mainService, mainLogs);

    const deniedChrome = await fetch(`${mainUrl}/api/chrome/navigate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "http://127.0.0.1/" }),
    });
    const deniedImage = await fetch(`${mainUrl}/api/image?url=${encodeURIComponent("http://127.0.0.1/image.png")}`);
    assert.equal(deniedChrome.status, 401);
    assert.equal(deniedImage.status, 401);

    const blockedChrome = await fetch(`${mainUrl}/api/chrome/navigate`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${APP_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ url: "http://127.0.0.1/" }),
    });
    const blockedImage = await fetch(`${mainUrl}/api/image?url=${encodeURIComponent("http://127.0.0.1/image.png")}`, {
      headers: { Authorization: `Bearer ${APP_TOKEN}` },
    });
    const blockedChromeBody = await blockedChrome.json();
    const blockedImageBody = await blockedImage.json();
    assert.equal(blockedChrome.status, 400);
    assert.equal(blockedImage.status, 400);
    assert.equal(blockedChromeBody.code, "IP_ADDRESS_NOT_ALLOWED");
    assert.equal(blockedImageBody.code, "IP_ADDRESS_NOT_ALLOWED");
    assert.doesNotMatch(JSON.stringify([blockedChromeBody, blockedImageBody]), /[A-Z]:\\|node:internal|server\.mjs:\d+/i);

    const denied = await fetch(`${mainUrl}/api/ads/service/status`);
    assert.equal(denied.status, 401);
    const proxied = await fetch(`${mainUrl}/api/ads/service/status`, {
      headers: { Authorization: `Bearer ${APP_TOKEN}` },
    });
    assert.equal(proxied.status, 200);
    assert.deepEqual(await proxied.json(), { ok: true });

    const page = await fetch(`${mainUrl}/ads/`);
    const pageText = await page.text();
    assert.equal(page.status, 200);
    assert.match(pageText, /Lazada Sponsored Max/);
    assert.equal(pageText.includes(APP_TOKEN), false);
    assert.equal(pageText.includes(INTERNAL_TOKEN), false);

    const status = await fetch(`${mainUrl}/api/ad-analyzer/status`, {
      method: "POST",
      headers: { Authorization: `Bearer ${APP_TOKEN}` },
    });
    const statusPayload = await status.json();
    assert.equal(status.status, 200);
    assert.equal(statusPayload.url, "/ads/");
    assert.equal(JSON.stringify(statusPayload).includes("127.0.0.1"), false);

    const directDenied = await fetch(`${adUrl}/api/service/status`);
    assert.equal(directDenied.status, 401);

    await stop(adService);
    const unavailable = await fetch(`${mainUrl}/api/ads/service/status`, {
      headers: { Authorization: `Bearer ${APP_TOKEN}` },
    });
    assert.equal(unavailable.status, 503);
    const mainHealth = await fetch(`${mainUrl}/api/health`);
    const mainPage = await fetch(`${mainUrl}/`);
    assert.equal(mainHealth.status, 200);
    assert.equal(mainPage.status, 200);
    assert.equal(`${adLogs.join("")}\n${mainLogs.join("")}`.includes(APP_TOKEN), false);
    assert.equal(`${adLogs.join("")}\n${mainLogs.join("")}`.includes(INTERNAL_TOKEN), false);
  } finally {
    if (mainService) await stop(mainService);
    await stop(adService);
  }
});
