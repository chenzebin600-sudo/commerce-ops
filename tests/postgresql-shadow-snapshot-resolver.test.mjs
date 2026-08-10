import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveShadowSqliteSnapshot } from "../lib/postgresql/incremental-sync/shadow-snapshot-resolver.mjs";

test("Shadow snapshot resolver honors an explicit override", () => {
  const expected = path.resolve("explicit-shadow.sqlite");
  assert.equal(resolveShadowSqliteSnapshot({
    rootDir: process.cwd(),
    env: { POSTGRES_SHADOW_SQLITE_SNAPSHOT: expected },
  }), expected);
});

test("Shadow snapshot resolver selects the newest successful incremental report", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "shadow-snapshot-resolver-"));
  try {
    const reportsDir = path.join(rootDir, "docs", "reports");
    const snapshotsDir = path.join(rootDir, "tmp", "postgresql-incremental-sync");
    await fs.mkdir(reportsDir, { recursive: true });
    await fs.mkdir(snapshotsDir, { recursive: true });
    const older = path.join(snapshotsDir, "older.sqlite");
    const newer = path.join(snapshotsDir, "newer.sqlite");
    await fs.writeFile(older, "older");
    await fs.writeFile(newer, "newer");
    await fs.writeFile(path.join(reportsDir, "COMMERCE-OPS-POSTGRESQL-INCREMENTAL-SYNC-older.json"), JSON.stringify({
      status: "PASS",
      snapshot: { path: "<workspace>/tmp/postgresql-incremental-sync/older.sqlite", time: "2026-08-05T00:00:00.000Z" },
    }));
    await fs.writeFile(path.join(reportsDir, "COMMERCE-OPS-POSTGRESQL-INCREMENTAL-SYNC-newer.json"), JSON.stringify({
      status: "PASS",
      snapshot: { path: "<workspace>/tmp/postgresql-incremental-sync/newer.sqlite", time: "2026-08-06T00:00:00.000Z" },
    }));
    await fs.writeFile(path.join(reportsDir, "COMMERCE-OPS-POSTGRESQL-INCREMENTAL-SYNC-failed.json"), JSON.stringify({
      status: "FAIL",
      snapshot: { path: "<workspace>/tmp/postgresql-incremental-sync/missing.sqlite", time: "2026-08-07T00:00:00.000Z" },
    }));
    assert.equal(resolveShadowSqliteSnapshot({ rootDir, env: {} }), newer);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});
