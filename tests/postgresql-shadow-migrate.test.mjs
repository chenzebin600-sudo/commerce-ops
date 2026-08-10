import assert from "node:assert/strict";
import test from "node:test";
import { planShadowMigrations } from "../scripts/postgresql-shadow-migrate.mjs";

test("Shadow migration planning preserves applied checksums and identifies pending files", () => {
  const files = [
    { version: "001_base.sql", sql: "SELECT 1;" },
    { version: "002_next.sql", sql: "SELECT 2;" },
  ];
  const first = planShadowMigrations(files, []);
  const planned = planShadowMigrations(files, [{ version: "001_base.sql", sha256: first[0].sha256 }]);
  assert.deepEqual(planned.map((item) => [item.version, item.status]), [
    ["001_base.sql", "ALREADY_APPLIED"],
    ["002_next.sql", "PENDING"],
  ]);
});

test("Shadow migration planning refuses changed applied SQL", () => {
  assert.throws(
    () => planShadowMigrations([{ version: "001_base.sql", sql: "SELECT 2;" }], [{ version: "001_base.sql", sha256: "wrong" }]),
    { code: "SHADOW_MIGRATION_CHECKSUM_MISMATCH" },
  );
});
