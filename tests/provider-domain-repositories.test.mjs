import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createProviderDomainRepositories } from "../lib/data/provider-domain-repositories.mjs";
import { ProviderAuditRepository } from "../lib/data/provider-audit-repository.mjs";
import { SqliteProvider } from "../lib/data/sqlite/sqlite-provider.mjs";
import { SchedulerDatabase } from "../lib/mabang-scheduler/db.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");

function fixtureEvent(id) {
  return {
    id,
    requestId: "phase2-request",
    occurredAt: "2026-08-05T00:00:00.000Z",
    module: "database_provider",
    action: "provider.phase2.test",
    httpMethod: null,
    requestPath: null,
    status: "success",
    httpStatus: null,
    durationMs: 1,
    sourceIp: null,
    actorType: "system",
    actorIdentifier: null,
    taskId: null,
    runId: null,
    fileId: null,
    errorStage: null,
    errorCode: null,
    errorSummary: null,
    metadataJson: JSON.stringify({ phase: 2 }),
    createdAt: "2026-08-05T00:00:00.000Z",
  };
}

test("provider domain repositories expose stable SQLite interfaces", async (context) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "commerce-provider-domains-"));
  const databasePath = path.join(temporaryRoot, "domains.sqlite");
  const provider = new SqliteProvider({ databasePath });
  context.after(() => {
    provider.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  const scheduler = new SchedulerDatabase({
    databasePath,
    migrationsDir: path.join(rootDir, "migrations"),
    provider,
  });
  scheduler.migrate();

  const repositories = createProviderDomainRepositories({ provider });
  assert.equal(repositories.dialect, "sqlite");
  assert.equal((await repositories.products.getProducts({ pageSize: 1 })).total, 0);
  assert.deepEqual(await repositories.sales.getSalesSummary(), {
    orderCount: 0,
    lineCount: 0,
    salesQuantity: 0,
    earliestPaidAt: null,
    latestPaidAt: null,
  });
  assert.deepEqual(await repositories.sales.getIdentitySet(), { headers: [], lines: [] });
  assert.equal((await repositories.inventory.getInventorySnapshot()).rowCount, 0);
  assert.deepEqual(await repositories.tasks.listTasks({ limit: 5 }), []);
  assert.equal((await repositories.audit.listEvents({ page: 1, pageSize: 5 })).total, 0);
});

test("provider audit repository preserves the audit row contract", async (context) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "commerce-provider-audit-"));
  const databasePath = path.join(temporaryRoot, "audit.sqlite");
  const provider = new SqliteProvider({ databasePath });
  context.after(() => {
    provider.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  const scheduler = new SchedulerDatabase({
    databasePath,
    migrationsDir: path.join(rootDir, "migrations"),
    provider,
  });
  scheduler.migrate();
  const repository = new ProviderAuditRepository({ provider });
  const id = "phase2-audit-event";
  const created = await repository.create(fixtureEvent(id));
  assert.equal(created.id, id);
  assert.deepEqual(JSON.parse(created.metadata_json), { phase: 2 });
  assert.equal((await repository.query({ module: "database_provider", page: 1, pageSize: 5 })).total, 1);
  assert.equal((await repository.summary()).byStatus[0].status, "success");
  assert.equal(await repository.cleanupBefore("2026-08-06T00:00:00.000Z"), 1);
  assert.equal(await repository.get(id), null);
});
