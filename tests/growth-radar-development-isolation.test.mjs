import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openCommerceDataAccess } from "../lib/data/data-access.mjs";
import { loadLocalEnv } from "../lib/env.mjs";
import {
  RUNTIME_PROFILES,
  RuntimeIsolationError,
  inspectRuntimeIsolation,
  resolveRuntimeConfig,
} from "../lib/runtime-config.mjs";

const projectRoot = path.resolve(".");

async function fixture(prefix = "commerce-ops-g1b-isolation-") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const storageRoot = path.join(root, "storage", "development");
  await fs.mkdir(storageRoot, { recursive: true });
  const databasePath = path.join(storageRoot, "growth-radar-g1b.sqlite");
  return {
    root,
    storageRoot,
    databasePath,
    env: {
      COMMERCE_OPS_RUNTIME_PROFILE: RUNTIME_PROFILES.GROWTH_RADAR_G1B,
      DATABASE_PATH: databasePath,
      STORAGE_ROOT: storageRoot,
      APP_HOST: "127.0.0.1",
      APP_PORT: "3193",
      AD_SERVICE_MODE: "external",
    },
  };
}

function assertRejected(root, env, failedCheck) {
  assert.throws(
    () => resolveRuntimeConfig({ bootstrapRoot: root, env }),
    (error) => error instanceof RuntimeIsolationError
      && error.code === "RUNTIME_ISOLATION_REJECTED"
      && error.checks.some((item) => item.id === failedCheck && !item.ok),
  );
}

test("A2 profile requires an explicit nonblank database path before startup", async () => {
  const context = await fixture();
  try {
    const env = { ...context.env };
    delete env.DATABASE_PATH;
    assertRejected(context.root, env, "database_path_explicit");
    assertRejected(context.root, { ...context.env, DATABASE_PATH: "   " }, "database_path_explicit");
  } finally {
    await fs.rm(context.root, { recursive: true, force: true });
  }
});

test("A2 profile rejects the default commerce-ops.sqlite path", async () => {
  const context = await fixture();
  try {
    assertRejected(context.root, {
      ...context.env,
      DATABASE_PATH: path.join(context.root, "storage", "commerce-ops.sqlite"),
    }, "default_database_rejected");
  } finally {
    await fs.rm(context.root, { recursive: true, force: true });
  }
});

test("A2 profile rejects a formal database path outside the worktree", async () => {
  const context = await fixture();
  const formalRoot = await fs.mkdtemp(path.join(os.tmpdir(), "commerce-ops-formal-fixture-"));
  try {
    const formalStorage = path.join(formalRoot, "storage");
    await fs.mkdir(formalStorage, { recursive: true });
    assertRejected(context.root, {
      ...context.env,
      DATABASE_PATH: path.join(formalStorage, "commerce-ops.sqlite"),
    }, "database_inside_worktree");
  } finally {
    await fs.rm(context.root, { recursive: true, force: true });
    await fs.rm(formalRoot, { recursive: true, force: true });
  }
});

test("A2 profile rejects an allowed-looking filename outside the worktree", async () => {
  const context = await fixture();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "commerce-ops-other-branch-"));
  try {
    assertRejected(context.root, {
      ...context.env,
      DATABASE_PATH: path.join(outside, "growth-radar-g1b.sqlite"),
    }, "database_inside_worktree");
  } finally {
    await fs.rm(context.root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("an inherited APP_ROOT cannot redefine the A2 worktree boundary", async () => {
  const context = await fixture();
  const otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), "commerce-ops-other-app-root-"));
  try {
    const otherStorage = path.join(otherRoot, "storage", "development");
    await fs.mkdir(otherStorage, { recursive: true });
    assertRejected(context.root, {
      ...context.env,
      APP_ROOT: otherRoot,
      STORAGE_ROOT: otherStorage,
      DATABASE_PATH: path.join(otherStorage, "growth-radar-g1b.sqlite"),
    }, "app_root_is_worktree");
  } finally {
    await fs.rm(context.root, { recursive: true, force: true });
    await fs.rm(otherRoot, { recursive: true, force: true });
  }
});

test("A2 profile requires an explicit STORAGE_ROOT", async () => {
  const context = await fixture();
  try {
    const env = { ...context.env };
    delete env.STORAGE_ROOT;
    assertRejected(context.root, env, "storage_root_explicit");
  } finally {
    await fs.rm(context.root, { recursive: true, force: true });
  }
});

test("A2 profile rejects port 3101", async () => {
  const context = await fixture();
  try {
    assertRejected(context.root, { ...context.env, APP_PORT: "3101" }, "formal_port_rejected");
  } finally {
    await fs.rm(context.root, { recursive: true, force: true });
  }
});

test("A2 profile accepts the exact isolated database, storage root, and port", async () => {
  const context = await fixture();
  try {
    const config = resolveRuntimeConfig({ bootstrapRoot: context.root, env: context.env });
    assert.equal(config.runtimeProfile, RUNTIME_PROFILES.GROWTH_RADAR_G1B);
    assert.equal(config.databasePath, context.databasePath);
    assert.equal(config.storageRoot, context.storageRoot);
    assert.equal(config.appPort, 3193);
    assert.equal(config.adServiceMode, "external");
    assert.equal(inspectRuntimeIsolation({ bootstrapRoot: context.root, env: context.env }).checks.every((item) => item.ok), true);
  } finally {
    await fs.rm(context.root, { recursive: true, force: true });
  }
});

test("a legal A2 profile can apply migrations 001 through 014 to its isolated database", async () => {
  const context = await fixture();
  let dataAccess;
  try {
    const config = resolveRuntimeConfig({ bootstrapRoot: context.root, env: context.env });
    const migrationNames = (await fs.readdir(path.join(projectRoot, "migrations")))
      .filter((name) => /^\d{3}_.+\.sql$/.test(name) && Number.parseInt(name.slice(0, 3), 10) <= 14)
      .sort();
    assert.deepEqual(
      migrationNames.map((name) => Number.parseInt(name.slice(0, 3), 10)),
      Array.from({ length: 14 }, (_, index) => index + 1),
    );
    assert.equal(migrationNames.at(-1), "014_deterministic_growth_radar_scope_and_linkage.sql");

    const baselineMigrationsDir = path.join(context.root, "migrations-g1b-baseline");
    await fs.mkdir(baselineMigrationsDir, { recursive: true });
    await Promise.all(migrationNames.map((name) => fs.copyFile(
      path.join(projectRoot, "migrations", name),
      path.join(baselineMigrationsDir, name),
    )));

    dataAccess = openCommerceDataAccess({
      rootDir: projectRoot,
      databasePath: config.databasePath,
      migrationsDir: baselineMigrationsDir,
    });
    const rows = await dataAccess.provider.query("SELECT version FROM schema_migrations ORDER BY version");
    assert.deepEqual(rows.rows.map((row) => row.version), migrationNames);
  } finally {
    dataAccess?.close();
    await fs.rm(context.root, { recursive: true, force: true });
  }
});

test("explicit test profiles use unique temporary databases", async () => {
  const first = await fs.mkdtemp(path.join(os.tmpdir(), "commerce-ops-test-profile-a-"));
  const second = await fs.mkdtemp(path.join(os.tmpdir(), "commerce-ops-test-profile-b-"));
  try {
    const configFor = async (root, port) => {
      const storageRoot = path.join(root, "storage");
      await fs.mkdir(storageRoot, { recursive: true });
      return resolveRuntimeConfig({ bootstrapRoot: projectRoot, env: {
        COMMERCE_OPS_RUNTIME_PROFILE: RUNTIME_PROFILES.TEST,
        STORAGE_ROOT: storageRoot,
        DATABASE_PATH: path.join(storageRoot, "test.sqlite"),
        APP_PORT: String(port),
      } });
    };
    const [a, b] = await Promise.all([configFor(first, 41011), configFor(second, 41012)]);
    assert.notEqual(a.databasePath, b.databasePath);
    assert.equal(a.databasePath.startsWith(os.tmpdir()), true);
    assert.equal(b.databasePath.startsWith(os.tmpdir()), true);
  } finally {
    await fs.rm(first, { recursive: true, force: true });
    await fs.rm(second, { recursive: true, force: true });
  }
});

test("ordinary mainline configuration is not misclassified as an A2 error", () => {
  const config = resolveRuntimeConfig({ bootstrapRoot: projectRoot, env: {} });
  assert.equal(config.runtimeProfile, RUNTIME_PROFILES.DEFAULT);
  assert.equal(config.appPort, 3101);
});

test("relative paths cannot escape the A2 worktree", async () => {
  const context = await fixture();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "commerce-ops-relative-escape-"));
  try {
    const relativeEscape = path.relative(context.root, path.join(outside, "growth-radar-g1b.sqlite"));
    assertRejected(context.root, { ...context.env, DATABASE_PATH: relativeEscape }, "database_inside_worktree");
  } finally {
    await fs.rm(context.root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("Windows path case changes cannot bypass the default database rejection", { skip: process.platform !== "win32" }, async () => {
  const context = await fixture();
  try {
    const mixedCaseDefault = path.join(context.root.toUpperCase(), "STORAGE", "COMMERCE-OPS.SQLITE");
    assertRejected(context.root, { ...context.env, DATABASE_PATH: mixedCaseDefault }, "default_database_rejected");
  } finally {
    await fs.rm(context.root, { recursive: true, force: true });
  }
});

test("a directory symlink or junction cannot escape the A2 worktree", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "commerce-ops-symlink-root-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "commerce-ops-symlink-outside-"));
  const storageParent = path.join(root, "storage");
  const storageRoot = path.join(storageParent, "development");
  try {
    await fs.mkdir(storageParent, { recursive: true });
    try {
      await fs.symlink(outside, storageRoot, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) return t.skip(`symlink unavailable: ${error.code}`);
      throw error;
    }
    assertRejected(root, {
      COMMERCE_OPS_RUNTIME_PROFILE: RUNTIME_PROFILES.GROWTH_RADAR_G1B,
      STORAGE_ROOT: storageRoot,
      DATABASE_PATH: path.join(storageRoot, "growth-radar-g1b.sqlite"),
      APP_PORT: "3193",
      AD_SERVICE_MODE: "external",
    }, "storage_inside_worktree");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("an unconfirmable database parent is rejected before SQLite can create a file", async () => {
  const context = await fixture();
  const databasePath = path.join(context.root, "missing", "parent", "growth-radar-g1b.sqlite");
  try {
    assertRejected(context.root, { ...context.env, DATABASE_PATH: databasePath }, "database_parent_confirmed");
    await assert.rejects(fs.stat(databasePath), { code: "ENOENT" });
  } finally {
    await fs.rm(context.root, { recursive: true, force: true });
  }
});

test("the dedicated local profile file is required and can override inherited mainline paths", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "commerce-ops-env-profile-"));
  const previousDatabase = process.env.DATABASE_PATH;
  try {
    assert.throws(() => loadLocalEnv(root, { filenames: [".env.growth-radar-g1b.local"], required: true }), /Required environment file is missing/);
    await fs.writeFile(path.join(root, ".env.growth-radar-g1b.local"), "DATABASE_PATH=isolated.sqlite\n", "utf8");
    process.env.DATABASE_PATH = "formal.sqlite";
    loadLocalEnv(root, { filenames: [".env.growth-radar-g1b.local"], required: true, override: true });
    assert.equal(process.env.DATABASE_PATH, "isolated.sqlite");
  } finally {
    if (previousDatabase === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabase;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("an A2 .env.local marker makes generic startup fail closed", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "commerce-ops-a2-marker-"));
  const trackedNames = ["COMMERCE_OPS_RUNTIME_PROFILE", "DATABASE_PATH", "STORAGE_ROOT", "APP_PORT", "AD_SERVICE_MODE"];
  const previous = Object.fromEntries(trackedNames.map((name) => [name, process.env[name]]));
  try {
    await fs.writeFile(path.join(root, ".env.local"), "COMMERCE_OPS_RUNTIME_PROFILE=growth-radar-g1b\n", "utf8");
    for (const name of trackedNames) delete process.env[name];
    loadLocalEnv(root);
    assertRejected(root, process.env, "database_path_explicit");
  } finally {
    for (const name of trackedNames) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});
