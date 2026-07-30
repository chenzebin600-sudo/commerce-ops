import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
for (const file of [
  "public/app.js",
  "public/audit-page.mjs",
  "public/growth-radar-page.mjs",
  "public/growth-radar-workspace.mjs",
  "public/growth-radar-v2-loader.mjs",
  "public/sales-assortment-dashboard-loader.mjs",
  "public/auth-client.mjs",
  "public/ad-frame-bridge.mjs",
  "public/mabang-images-page.mjs",
  "public/mabang-listing-loader.mjs",
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
  "lib/mabang-listing-proxy.mjs",
  "lib/mabang-listing-service-manager.mjs",
  "lib/mabang-listing-token.mjs",
  "lib/mabang-wps-assistant-manager.mjs",
  "server.mjs",
  "scheduler.mjs",
  "scripts/cleanup-audit.mjs",
]) {
  const result = spawnSync(process.execPath, ["--check", file], { cwd: rootDir, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `${file} syntax check failed`);
}
const html = readFileSync(path.join(rootDir, "public", "index.html"), "utf8");
const growthRadarManifest = path.join(
  rootDir,
  "public",
  "assets",
  "growth-radar-v2",
  ".vite",
  "manifest.json",
);
if (!existsSync(growthRadarManifest)) {
  throw new Error("Growth Radar V2 production manifest is missing.");
}
const manifest = JSON.parse(readFileSync(growthRadarManifest, "utf8"));
const embeddedEntry = Object.values(manifest).find((entry) => (
  entry?.isEntry && entry?.src === "src/embed.tsx"
));
if (!embeddedEntry?.file) {
  throw new Error("Growth Radar V2 embedded entry is missing from the production manifest.");
}
const mabangListingManifest = path.join(
  rootDir,
  "public",
  "assets",
  "mabang-listing",
  ".vite",
  "manifest.json",
);
if (!existsSync(mabangListingManifest)) {
  throw new Error("Mabang listing production manifest is missing.");
}
const listingManifest = JSON.parse(
  readFileSync(mabangListingManifest, "utf8"),
);
const listingEmbeddedEntry = Object.values(listingManifest).find((entry) => (
  entry?.isEntry && entry?.src === "src/embed.tsx"
));
if (!listingEmbeddedEntry?.file) {
  throw new Error(
    "Mabang listing embedded entry is missing from the production manifest.",
  );
}
const salesAssortmentManifest = path.join(
  rootDir,
  "public",
  "assets",
  "sales-assortment-dashboard",
  ".vite",
  "manifest.json",
);
if (!existsSync(salesAssortmentManifest)) {
  throw new Error("Sales assortment dashboard production manifest is missing.");
}
const salesAssortmentEntries = JSON.parse(
  readFileSync(salesAssortmentManifest, "utf8"),
);
const salesAssortmentEmbeddedEntry = Object.values(salesAssortmentEntries).find((entry) => (
  entry?.isEntry && entry?.src === "src/embed.tsx"
));
if (!salesAssortmentEmbeddedEntry?.file) {
  throw new Error("Sales assortment dashboard embedded entry is missing.");
}
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
