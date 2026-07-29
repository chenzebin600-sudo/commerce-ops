import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
for (const file of [
  "public/app.js",
  "public/audit-page.mjs",
  "public/growth-radar-page.mjs",
  "public/auth-client.mjs",
  "public/ad-frame-bridge.mjs",
  "public/mabang-images-page.mjs",
  "lib/app-access.mjs",
  "lib/ad-service-proxy.mjs",
  "lib/security/network-policy.mjs",
  "lib/security/chrome-navigation.mjs",
  "lib/security/image-proxy.mjs",
  "lib/security/file-policy.mjs",
  "lib/security/excel-cell-policy.mjs",
  "lib/security/audit-service.mjs",
  "lib/security/audit-http.mjs",
  "lib/security/audit-api.mjs",
  "lib/files/file-repository.mjs",
  "lib/files/export-file-service.mjs",
  "lib/files/file-api.mjs",
  "lib/files/file-lifecycle-policy.mjs",
  "lib/files/file-lifecycle-repository.mjs",
  "lib/files/file-lifecycle-scanner.mjs",
  "lib/files/file-lifecycle-service.mjs",
  "lib/files/file-lifecycle-api.mjs",
  "lib/mabang-scheduler/api.mjs",
  "lib/mabang-scheduler/db.mjs",
  "lib/mabang-scheduler/executor.mjs",
  "lib/mabang-scheduler/service.mjs",
  "lib/mabang-scheduler/task-state.mjs",
  "lib/mabang-images/access-policy.mjs",
  "lib/mabang-images/api.mjs",
  "lib/mabang-images/browser-session.mjs",
  "lib/mabang-images/extraction.mjs",
  "lib/mabang-images/image-assets.mjs",
  "lib/mabang-images/repository.mjs",
  "lib/mabang-images/service.mjs",
  "fulfillment-service/config.mjs",
  "fulfillment-service/api-docs.mjs",
  "fulfillment-service/repository.mjs",
  "fulfillment-service/service.mjs",
  "fulfillment-service/mabang-source.mjs",
  "fulfillment-service/server.mjs",
  "server.mjs",
  "scheduler.mjs",
  "scripts/cleanup-audit.mjs",
]) {
  const result = spawnSync(process.execPath, ["--check", file], { cwd: rootDir, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `${file} syntax check failed`);
}
const html = readFileSync(path.join(rootDir, "public", "index.html"), "utf8");
const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
if (duplicates.length) throw new Error(`Duplicate HTML ids: ${[...new Set(duplicates)].join(", ")}`);
const app = readFileSync(path.join(rootDir, "public", "app.js"), "utf8");
const referencedIds = [...new Set([...app.matchAll(/\$\("([^"]+)"\)/g)].map((match) => match[1]))];
const auditPage = readFileSync(path.join(rootDir, "public", "audit-page.mjs"), "utf8");
referencedIds.push(...[...auditPage.matchAll(/byId\("([^"]+)"\)/g)].map((match) => match[1]));
const mabangImagesPage = readFileSync(path.join(rootDir, "public", "mabang-images-page.mjs"), "utf8");
referencedIds.push(...[...mabangImagesPage.matchAll(/el\("([^"]+)"\)/g)].map((match) => match[1]));
const dynamicIds = new Set(["retryExtractBtn"]);
const missingIds = [...new Set(referencedIds)].filter((id) => !ids.includes(id) && !dynamicIds.has(id));
if (missingIds.length) throw new Error(`JavaScript references missing HTML ids: ${missingIds.join(", ")}`);
console.log(`Frontend checks passed: ${ids.length} unique element ids, ${referencedIds.length} static bindings.`);
