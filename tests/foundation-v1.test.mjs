import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openCommerceDataAccess } from "../lib/data/data-access.mjs";
import { FoundationService } from "../lib/foundation/foundation-service.mjs";
import { FoundationListingAccountBridge } from "../lib/foundation/foundation-listing-account-bridge.mjs";

const PROJECT_ROOT = path.resolve(".");
const PROJECT_MIGRATIONS = path.join(PROJECT_ROOT, "migrations");
const CANDIDATE_NAME = "022_commerce_ops_foundation_v1.sql";
const CANDIDATE_PATH = path.join(PROJECT_MIGRATIONS, "candidates", CANDIDATE_NAME);
const FIXED_NOW = new Date("2026-07-28T10:00:00.000Z");

async function stageTopLevelMigrations(target, through = "018_") {
  await fs.mkdir(target, { recursive: true });
  const names = (await fs.readdir(PROJECT_MIGRATIONS))
    .filter((name) => name.endsWith(".sql") && name.slice(0, 4) <= through)
    .sort();
  for (const name of names) {
    await fs.copyFile(path.join(PROJECT_MIGRATIONS, name), path.join(target, name));
  }
  return names;
}

async function applyCandidate(context) {
  context.access.close();
  await fs.copyFile(CANDIDATE_PATH, path.join(context.migrationsDir, CANDIDATE_NAME));
  context.access = openCommerceDataAccess({
    rootDir: PROJECT_ROOT,
    databasePath: context.databasePath,
    migrationsDir: context.migrationsDir,
  });
  context.db = context.access.provider.connection;
  return context;
}

async function createContext({ through = "018_" } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "commerce-foundation-v1-"));
  const migrationsDir = path.join(root, "migrations");
  const databasePath = path.join(root, "foundation.sqlite");
  await stageTopLevelMigrations(migrationsDir, through);
  const context = {
    root,
    migrationsDir,
    databasePath,
    access: openCommerceDataAccess({
      rootDir: PROJECT_ROOT,
      databasePath,
      migrationsDir,
    }),
    db: null,
    async close() {
      this.access.close();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
  context.db = context.access.provider.connection;
  return context;
}

function seedMabangAccount(db, {
  id = "account-1",
  name = "Primary Mabang",
  username = "operator@example.test",
} = {}) {
  const timestamp = "2026-07-28T08:00:00.000Z";
  db.prepare(`INSERT INTO mabang_account_profiles (
    id,name,username,encrypted_password,enabled,last_verified_at,
    last_verify_status,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?)`).run(
    id,
    name,
    username,
    "encrypted-secret-must-not-be-copied",
    1,
    timestamp,
    "success",
    timestamp,
    timestamp,
  );
}

function seedScheduledRun(db, accountId = "account-1") {
  const timestamp = "2026-07-28T08:00:00.000Z";
  db.prepare(`INSERT INTO scheduled_export_tasks (
    id,task_type,name,account_profile_id,schedule_type,schedule_config_json,
    timezone,payment_date_mode,payment_date_config_json,filters_json,
    created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    "scheduled-task-1",
    "order_export",
    "Daily orders",
    accountId,
    "daily",
    "{}",
    "Asia/Shanghai",
    "relative",
    "{}",
    "[]",
    timestamp,
    timestamp,
  );
  db.prepare(`INSERT INTO scheduled_export_runs (
    id,task_id,trigger_type,scheduled_run_at,started_at,finished_at,status,
    raw_order_count,filtered_order_count,detail_row_count,retry_count,
    log_summary_json,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    "scheduled-run-1",
    "scheduled-task-1",
    "scheduled",
    timestamp,
    timestamp,
    "2026-07-28T08:05:00.000Z",
    "success",
    20,
    18,
    24,
    0,
    "{}",
    timestamp,
    "2026-07-28T08:05:00.000Z",
  );
}

function seedImageSync(db, accountId = "account-1") {
  const timestamp = "2026-07-28T08:00:00.000Z";
  db.prepare(`INSERT INTO mabang_sku_image_sync_runs (
    id,account_id,status,next_page,segment_count,discovered_skus,
    downloaded_images,duplicate_images,failed_images,matched_skus,
    unmatched_skus,created_by,started_at,completed_at,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    "image-sync-1",
    accountId,
    "completed",
    3,
    2,
    200,
    145,
    45,
    0,
    180,
    20,
    "test",
    timestamp,
    "2026-07-28T08:30:00.000Z",
    timestamp,
    "2026-07-28T08:30:00.000Z",
  );
}

test("candidate 022 is additive, isolated, and does not copy credentials", async () => {
  const context = await createContext();
  try {
    seedMabangAccount(context.db);
    const protectedBefore = {
      accounts: context.db.prepare("SELECT COUNT(*) AS count FROM mabang_account_profiles").get().count,
      products: context.db.prepare("SELECT COUNT(*) AS count FROM product_models").get().count,
      skus: context.db.prepare("SELECT COUNT(*) AS count FROM product_skus").get().count,
      imageRuns: context.db.prepare("SELECT COUNT(*) AS count FROM mabang_sku_image_sync_runs").get().count,
    };

    await applyCandidate(context);

    const versions = context.db.prepare(
      "SELECT version FROM schema_migrations ORDER BY version",
    ).all().map((row) => row.version);
    assert.equal(versions.at(-1), CANDIDATE_NAME);
    assert.deepEqual({
      accounts: context.db.prepare("SELECT COUNT(*) AS count FROM mabang_account_profiles").get().count,
      products: context.db.prepare("SELECT COUNT(*) AS count FROM product_models").get().count,
      skus: context.db.prepare("SELECT COUNT(*) AS count FROM product_skus").get().count,
      imageRuns: context.db.prepare("SELECT COUNT(*) AS count FROM mabang_sku_image_sync_runs").get().count,
    }, protectedBefore);

    const account = context.db.prepare(
      "SELECT * FROM foundation_integration_accounts",
    ).get();
    assert.equal(account.credential_ref_id, "account-1");
    assert.equal(account.credential_ref_type, "mabang_account_profile");
    assert.equal(String(account.metadata_json).includes("encrypted-secret"), false);
    assert.equal(
      context.db.prepare("SELECT COUNT(*) AS count FROM foundation_account_capabilities").get().count,
      5,
    );
    assert.equal(
      context.db.prepare("SELECT COUNT(*) AS count FROM foundation_product_master_v").get().count,
      protectedBefore.products,
    );
    assert.equal(
      context.db.prepare("SELECT COUNT(*) AS count FROM foundation_sku_master_v").get().count,
      protectedBefore.skus,
    );
    assert.equal(context.db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.equal(context.db.prepare("PRAGMA foreign_key_check").all().length, 0);
    assert.deepEqual(context.access.repositories.scheduler.migrate(), []);
  } finally {
    await context.close();
  }
});

test("account registry resolves shared capabilities without owning secrets", async () => {
  const context = await createContext();
  try {
    seedMabangAccount(context.db);
    await applyCandidate(context);
    const service = new FoundationService({
      repository: context.access.repositories.foundation,
      now: () => new Date(FIXED_NOW),
    });
    const sync = await service.accounts.synchronizeMabangAccounts();
    assert.equal(sync.synchronizedCount, 1);
    assert.deepEqual(sync.capabilities, [
      "orders.read",
      "inventory.read",
      "images.read",
    ]);
    assert.deepEqual(sync.bindableCapabilities, [
      "listing.read",
      "listing.write",
    ]);
    const account = await service.accounts.resolve({
      sourceSystem: "mabang",
      capability: "inventory.read",
    });
    assert.equal(account.credentialRefId, "account-1");
    assert.equal(Object.hasOwn(account, "password"), false);
    assert.equal(JSON.stringify(account).includes("encrypted-secret"), false);
    await assert.rejects(
      () => service.accounts.resolve({
        sourceSystem: "mabang",
        capability: "listing.write",
      }),
      { code: "FOUNDATION_ACCOUNT_CAPABILITY_UNAVAILABLE" },
    );
  } finally {
    await context.close();
  }
});

test("confirmed and excluded warehouse identities survive repeated fact synchronization", async () => {
  const context = await createContext();
  try {
    await applyCandidate(context);
    const repository = context.access.repositories.foundation;
    const confirmedId = "foundation:warehouse:mabang:confirmed-warehouse";
    const excludedId = "foundation:warehouse:mabang:excluded-warehouse";

    await repository.upsertWarehouse({
      id: confirmedId,
      canonicalKey: "mabang:confirmed-warehouse",
      displayName: "Confirmed warehouse",
      normalizedName: "confirmed-warehouse",
      countryCode: "TH",
      countryName: "Thailand",
      identityStatus: "confirmed",
      metadata: { source: "approved_mapping" },
    }, FIXED_NOW);
    await repository.upsertWarehouse({
      id: excludedId,
      canonicalKey: "mabang:excluded-warehouse",
      displayName: "Excluded warehouse",
      normalizedName: "excluded-warehouse",
      identityStatus: "excluded",
      metadata: { reason: "invalid_source_text" },
    }, FIXED_NOW);
    await repository.upsertIdentityLink({
      id: "identity-confirmed-warehouse",
      entityType: "warehouse",
      entityId: confirmedId,
      sourceSystem: "mabang",
      sourceEntityType: "warehouse",
      externalKey: "Confirmed warehouse",
      normalizedExternalKey: "confirmed-warehouse",
      matchStatus: "confirmed",
      evidence: { source: "approved_mapping" },
    }, FIXED_NOW);
    await repository.upsertIdentityLink({
      id: "identity-excluded-warehouse",
      entityType: "warehouse",
      entityId: excludedId,
      sourceSystem: "mabang",
      sourceEntityType: "warehouse",
      externalKey: "Excluded warehouse",
      normalizedExternalKey: "excluded-warehouse",
      matchStatus: "rejected",
      evidence: { reason: "invalid_source_text" },
    }, FIXED_NOW);

    for (const input of [
      {
        id: confirmedId,
        canonicalKey: "mabang:confirmed-warehouse",
        displayName: "Confirmed warehouse",
        normalizedName: "confirmed-warehouse",
      },
      {
        id: excludedId,
        canonicalKey: "mabang:excluded-warehouse",
        displayName: "Excluded warehouse",
        normalizedName: "excluded-warehouse",
      },
    ]) {
      await repository.upsertWarehouse({
        ...input,
        identityStatus: "review_required",
        metadata: { source: "fact_refresh" },
      }, new Date("2026-07-28T11:00:00.000Z"));
      await repository.upsertIdentityLink({
        id: `refresh:${input.id}`,
        entityType: "warehouse",
        entityId: input.id,
        sourceSystem: "mabang",
        sourceEntityType: "warehouse",
        externalKey: input.displayName,
        normalizedExternalKey: input.normalizedName,
        matchStatus: "unresolved",
        evidence: { source: "fact_refresh" },
      }, new Date("2026-07-28T11:00:00.000Z"));
    }

    const warehouses = context.db.prepare(
      "SELECT normalized_name,identity_status,metadata_json FROM foundation_warehouses ORDER BY normalized_name",
    ).all().map((row) => ({ ...row }));
    assert.deepEqual(warehouses, [
      {
        normalized_name: "confirmed-warehouse",
        identity_status: "confirmed",
        metadata_json: '{"source":"approved_mapping"}',
      },
      {
        normalized_name: "excluded-warehouse",
        identity_status: "excluded",
        metadata_json: '{"reason":"invalid_source_text"}',
      },
    ]);
    const links = context.db.prepare(
      "SELECT normalized_external_key,match_status,evidence_json FROM foundation_identity_links ORDER BY normalized_external_key",
    ).all().map((row) => ({ ...row }));
    assert.deepEqual(links, [
      {
        normalized_external_key: "confirmed-warehouse",
        match_status: "confirmed",
        evidence_json: '{"source":"approved_mapping"}',
      },
      {
        normalized_external_key: "excluded-warehouse",
        match_status: "rejected",
        evidence_json: '{"reason":"invalid_source_text"}',
      },
    ]);
  } finally {
    await context.close();
  }
});

test("Listing account bridge reuses the Mabang credential owner without persisting secrets", async () => {
  const context = await createContext();
  try {
    seedMabangAccount(context.db);
    await applyCandidate(context);
    const service = new FoundationService({
      repository: context.access.repositories.foundation,
      now: () => new Date(FIXED_NOW),
    });
    await service.accounts.synchronizeMabangAccounts();
    let connectorInput = null;
    const bridge = new FoundationListingAccountBridge({
      foundationRepository: context.access.repositories.foundation,
      accountRegistry: service.accounts,
      accountRepository: {
        get(id, options) {
          assert.equal(id, "account-1");
          assert.deepEqual(options, { includeSecret: true });
          return {
            username: "operator@example.test",
            encryptedPassword: "encrypted-value",
          };
        },
      },
      decryptSecret(value) {
        assert.equal(value, "encrypted-value");
        return "plain-secret";
      },
      async connectListing(input) {
        connectorInput = input;
        return {
          connected: true,
          username: input.username,
          account_host: "listing.example.test",
          token: "must-not-be-returned",
        };
      },
    });
    const result = await bridge.connect("foundation:account:mabang:account-1");
    assert.equal(connectorInput.password, "plain-secret");
    assert.equal(result.session.connected, true);
    assert.equal(result.session.accountHost, "listing.example.test");
    assert.equal(JSON.stringify(result).includes("plain-secret"), false);
    assert.equal(JSON.stringify(result).includes("must-not-be-returned"), false);
    assert.equal(result.secretPersisted, false);
    assert.equal((await service.accounts.resolve({
      sourceSystem: "mabang",
      capability: "listing.write",
    })).id, "foundation:account:mabang:account-1");
    await service.accounts.synchronizeMabangAccounts();
    assert.equal((await service.accounts.resolve({
      sourceSystem: "mabang",
      capability: "listing.write",
    })).id, "foundation:account:mabang:account-1");
    const stored = context.db.prepare(
      "SELECT metadata_json FROM foundation_integration_accounts WHERE id=?",
    ).get("foundation:account:mabang:account-1");
    assert.equal(String(stored.metadata_json).includes("plain-secret"), false);
  } finally {
    await context.close();
  }
});

test("Listing account bridge preserves safe Mabang connection errors for the API boundary", async () => {
  const upstream = Object.assign(new Error("Mabang requires account verification."), {
    code: "MABANG_LISTING_REQUEST_FAILED",
    status: 409,
  });
  const bridge = new FoundationListingAccountBridge({
    foundationRepository: {
      async getAccount() {
        return {
          id: "foundation:account:mabang:account-1",
          status: "active",
          sourceSystem: "mabang",
          credentialRefType: "mabang_account_profile",
          credentialRefId: "account-1",
        };
      },
    },
    accountRegistry: { async activateCapabilities() {} },
    accountRepository: {
      async get() {
        return { username: "operator@example.test", encryptedPassword: "encrypted-value" };
      },
    },
    decryptSecret() { return "plain-secret"; },
    async connectListing() { throw upstream; },
  });

  await assert.rejects(
    bridge.connect("foundation:account:mabang:account-1"),
    (error) => error.code === "MABANG_LISTING_REQUEST_FAILED"
      && error.status === 409
      && error.message === "Mabang requires account verification."
      && error.cause === upstream,
  );
});

test("Listing account bridge keeps non-Mabang connector failures private", async () => {
  const upstream = Object.assign(new Error("secret connector detail"), {
    code: "INTERNAL_CONNECTOR_FAILURE",
  });
  const bridge = new FoundationListingAccountBridge({
    foundationRepository: {
      async getAccount() {
        return {
          id: "foundation:account:mabang:account-1",
          status: "active",
          sourceSystem: "mabang",
          credentialRefType: "mabang_account_profile",
          credentialRefId: "account-1",
        };
      },
    },
    accountRegistry: { async activateCapabilities() {} },
    accountRepository: {
      async get() {
        return { username: "operator@example.test", encryptedPassword: "encrypted-value" };
      },
    },
    decryptSecret() { return "plain-secret"; },
    async connectListing() { throw upstream; },
  });

  await assert.rejects(
    bridge.connect("foundation:account:mabang:account-1"),
    (error) => error.code === "FOUNDATION_LISTING_CONNECTION_FAILED"
      && error.status === 502
      && error.message === "Mabang Listing account connection failed."
      && !error.message.includes("secret connector detail")
      && error.cause === upstream,
  );
});

test("Foundation-owned tasks enforce transitions, retries, events, and leases", async () => {
  const context = await createContext();
  try {
    await applyCandidate(context);
    const service = new FoundationService({
      repository: context.access.repositories.foundation,
      now: () => new Date(FIXED_NOW),
    });
    const task = await service.tasks.create({
      domain: "listing",
      taskKind: "publish",
      executionMode: "system",
      domainRefType: "foundation_publish_request",
      domainRefId: "request-1",
      idempotencyKey: "listing:request-1",
      state: "PENDING",
      createdBy: "test",
    });
    const duplicate = await service.tasks.create({
      domain: "listing",
      taskKind: "publish",
      executionMode: "system",
      domainRefType: "foundation_publish_request",
      domainRefId: "request-1",
      idempotencyKey: "listing:request-1",
      state: "PENDING",
      createdBy: "test",
    });
    assert.equal(duplicate.id, task.id);

    const running = await service.tasks.transition(task.id, "RUNNING", {
      actorId: "worker-1",
    });
    assert.equal(running.state, "RUNNING");

    const lease = await service.tasks.acquireLease(task.id, {
      leaseOwner: "worker-1",
      ttlMs: 10_000,
    });
    assert.equal(lease.leaseOwner, "worker-1");
    assert.equal(await service.tasks.acquireLease(task.id, {
      leaseOwner: "worker-2",
      ttlMs: 10_000,
    }), null);
    assert.ok(await service.tasks.renewLease(task.id, lease.leaseToken, {
      ttlMs: 20_000,
    }));
    assert.equal(await service.tasks.releaseLease(task.id, lease.leaseToken), true);

    const retry = await service.tasks.scheduleRetry(task.id, {
      delayMs: 30_000,
      message: "Transient publisher error",
    });
    assert.equal(retry.state, "RETRY_WAIT");
    assert.equal(retry.attemptCount, 1);
    assert.ok(retry.availableAt);

    const events = await context.access.repositories.foundation.listTaskEvents(task.id);
    assert.deepEqual(events.map((event) => event.eventType), [
      "CREATED",
      "STATE_CHANGED",
      "RETRY_SCHEDULED",
    ]);
    await assert.rejects(
      () => service.tasks.transition(task.id, "SUCCEEDED"),
      { code: "FOUNDATION_TASK_TRANSITION_INVALID" },
    );
  } finally {
    await context.close();
  }
});

test("domain projections unify scheduler, COM-015, and Listing jobs idempotently", async () => {
  const context = await createContext();
  try {
    seedMabangAccount(context.db);
    seedScheduledRun(context.db);
    seedImageSync(context.db);
    await applyCandidate(context);
    const service = new FoundationService({
      repository: context.access.repositories.foundation,
      now: () => new Date(FIXED_NOW),
    });
    const listingJobs = [{
      id: "listing-job-1",
      draftId: "draft-1",
      draftVersion: 2,
      status: "PUBLISHED",
      attempts: 1,
      createdAt: "2026-07-28T09:00:00.000Z",
      finishedAt: "2026-07-28T09:02:00.000Z",
      result: { platformProductId: "platform-1" },
    }];
    const first = await service.synchronize({ listingJobs });
    assert.equal(first.projections.scheduledRuns, 1);
    assert.equal(first.projections.imageWork, 1);
    assert.equal(first.projections.listing, 1);
    assert.equal(first.projections.total, 3);

    const tasks = await context.access.repositories.foundation.listTasks({ limit: 20 });
    assert.equal(tasks.length, 3);
    assert.deepEqual(
      Object.fromEntries(tasks.map((task) => [task.domain, task.state])),
      {
        listing: "SUCCEEDED",
        mabang_data: "SUCCEEDED",
        mabang_images: "SUCCEEDED",
      },
    );
    assert.equal(
      tasks.find((task) => task.domain === "mabang_images").result.downloadedImages,
      145,
    );

    const versionsBefore = Object.fromEntries(tasks.map((task) => [task.id, task.stateVersion]));
    await service.synchronize({ listingJobs });
    const repeatedTasks = await context.access.repositories.foundation.listTasks({ limit: 20 });
    assert.equal(repeatedTasks.length, 3);
    assert.deepEqual(
      Object.fromEntries(repeatedTasks.map((task) => [task.id, task.stateVersion])),
      versionsBefore,
    );
  } finally {
    await context.close();
  }
});

test("candidate 022 remains compatible after Growth Radar migrations 019 through 021", async () => {
  const context = await createContext({ through: "021_" });
  try {
    await applyCandidate(context);
    assert.equal(await context.access.repositories.foundation.isReady(), true);
    assert.equal(context.db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.equal(context.db.prepare("PRAGMA foreign_key_check").all().length, 0);
    assert.ok(context.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='growth_focus_items'",
    ).get());
    const service = new FoundationService({
      repository: context.access.repositories.foundation,
      now: () => new Date(FIXED_NOW),
    });
    assert.equal((await service.status()).activationStatus, "available");
  } finally {
    await context.close();
  }
});
