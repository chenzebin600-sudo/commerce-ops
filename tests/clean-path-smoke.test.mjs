import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const sourceRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const excludedNames = new Set([
  ".git", ".agents", ".mabang-exports", ".venv-mabang", "node_modules", "storage",
  "ui-check", "packaged-skills", "design-system", "lazada-images", "lazada-images-th",
]);

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(url, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("temporary service did not start");
}

test("a clean neutral directory starts without reading the formal runtime", { timeout: 45_000 }, async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "e1-neutral-"));
  const appRoot = path.join(sandbox, "app");
  await fs.cp(sourceRoot, appRoot, {
    recursive: true,
    filter(source) {
      if (source === sourceRoot) return true;
      const relative = path.relative(sourceRoot, source);
      if (!relative || relative.startsWith("..")) return true;
      const parts = relative.split(path.sep);
      if (parts.some((part) => excludedNames.has(part))) return false;
      return !parts.some((part) => part === ".env" || part === ".env.local" || part.endsWith(".log"));
    },
  });
  const port = await freePort();
  const adPort = await freePort();
  const dataRoot = path.join(sandbox, "runtime");
  await fs.mkdir(dataRoot, { recursive: true });
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server.mjs"], {
    cwd: appRoot,
    env: {
      ...process.env,
      COMMERCE_OPS_RUNTIME_PROFILE: "test",
      APP_ROOT: appRoot,
      DATA_ROOT: dataRoot,
      STORAGE_ROOT: dataRoot,
      DATABASE_PATH: path.join(dataRoot, "test.sqlite"),
      APP_HOST: "127.0.0.1",
      APP_PORT: String(port),
      APP_ACCESS_TOKEN: "temporary-clean-path-token",
      APP_ENCRYPTION_KEY: "temporary-clean-path-encryption-key",
      AD_SERVICE_MODE: "external",
      AD_SERVICE_BASE_URL: `http://127.0.0.1:${adPort}`,
      AD_SERVICE_PORT: String(adPort),
      AD_SERVICE_INTERNAL_TOKEN: "temporary-clean-path-internal-token",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  try {
    await waitFor(`http://127.0.0.1:${port}/api/health`);
    const page = await fetch(`http://127.0.0.1:${port}/`).then((response) => response.text());
    for (const marker of ["page-link", "page-keyword", "page-ads", "page-mabang"]) {
      assert.match(page, new RegExp(`id=[\"']${marker}[\"']`));
    }
    assert.equal(output.includes(sourceRoot), false);
    assert.equal(await fs.stat(path.join(dataRoot, "test.sqlite")).then(() => true), true);
  } finally {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});
