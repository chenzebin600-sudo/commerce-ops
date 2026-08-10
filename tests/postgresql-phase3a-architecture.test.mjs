import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");

async function source(relativePath) {
  return readFile(path.join(ROOT, relativePath), "utf8");
}

const PRODUCTION_ENTRYPOINTS = Object.freeze([
  "server.mjs",
  "scheduler.mjs",
  "fulfillment-service/server.mjs",
  "scripts/price-control-sync.mjs",
  "scripts/price-control-repair-null-semantics.mjs",
  "scripts/cleanup-audit.mjs",
]);

test("Phase 3A production entrypoints do not construct or import SQLite directly", async () => {
  const violations = [];
  for (const relativePath of PRODUCTION_ENTRYPOINTS) {
    const text = await source(relativePath);
    const forbidden = [
      ["node:sqlite", /node:sqlite/],
      ["DatabaseSync", /\bDatabaseSync\b/],
      ["legacy data access", /openCommerceDataAccess/],
      ["SQLite implementation", /(?:^|["'])\.\.?(?:\/[^"']*)?\/data\/sqlite\//m],
    ];
    for (const [label, pattern] of forbidden) {
      if (pattern.test(text)) violations.push(`${relativePath}: ${label}`);
    }
  }
  assert.deepEqual(violations, []);
});

test("Phase 3A production composition roots select repositories through Provider factories", async () => {
  const [main, scheduler, fulfillment, priceSync, priceRepair, auditCleanup] = await Promise.all(
    PRODUCTION_ENTRYPOINTS.map(source),
  );

  assert.match(main, /openProviderRuntimeDataAccess\s*\(/);
  assert.match(scheduler, /openProviderRuntimeDataAccess\s*\(/);
  assert.match(fulfillment, /createFulfillmentRepository\s*\(/);
  assert.match(priceSync, /openProviderRuntimeDataAccess\s*\(/);
  assert.match(priceRepair, /openProviderRuntimeDataAccess\s*\(/);
  assert.match(auditCleanup, /openProviderRuntimeDataAccess\s*\(/);
});

test("Phase 3A file mutation services use StorageProvider instead of direct filesystem writes", async () => {
  const files = [
    "lib/files/export-file-service.mjs",
    "lib/files/file-review-service.mjs",
  ];
  const violations = [];
  for (const relativePath of files) {
    const text = await source(relativePath);
    if (/from\s+["']node:fs(?:\/promises)?["']/.test(text)) {
      violations.push(`${relativePath}: direct node:fs import`);
    }
    if (!/LocalStorageProvider/.test(text)) {
      violations.push(`${relativePath}: missing LocalStorageProvider boundary`);
    }
  }
  assert.deepEqual(violations, []);
});
