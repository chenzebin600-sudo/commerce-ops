import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openProviderDomainDataAccess } from "../lib/data/provider-domain-data-access.mjs";

test("provider domain data access owns one selected provider and stable repositories", async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "commerce-provider-access-"));
  const databasePath = path.join(temporaryRoot, "phase2.sqlite");
  fs.writeFileSync(databasePath, "");
  const dataAccess = openProviderDomainDataAccess({
    databasePath,
    env: { DATABASE_PROVIDER: "sqlite" },
    sqliteReadOnly: true,
  });
  try {
    assert.equal(dataAccess.name, "sqlite");
    assert.equal(dataAccess.mode, "production-compatible");
    assert.equal(dataAccess.repositories.dialect, "sqlite");
    assert.equal(typeof dataAccess.repositories.products.getProducts, "function");
    assert.equal(typeof dataAccess.repositories.tasks.listTasks, "function");
  } finally {
    await dataAccess.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
