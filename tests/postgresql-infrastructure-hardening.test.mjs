import assert from "node:assert/strict";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createEncryptionKey,
  decryptFile,
  encryptFile,
  isEncryptedArtifact,
  readEncryptionKey,
  sha256File,
} from "../lib/postgresql/infrastructure/encrypted-artifact.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");

test("PostgreSQL encrypted artifacts round-trip with a separate AES-256-GCM key", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "commerce-ops-pg-encrypted-"));
  const source = path.join(root, "source.wal");
  const encrypted = path.join(root, "archive.aes256gcm");
  const restored = path.join(root, "restored.wal");
  const keyFile = path.join(root, "secrets", "archive.key");
  try {
    await fsp.writeFile(source, crypto.randomBytes(256 * 1024));
    assert.deepEqual(await createEncryptionKey(keyFile), { created: true, keyFile });
    assert.equal((await readEncryptionKey(keyFile)).length, 32);
    await encryptFile(source, encrypted, await readEncryptionKey(keyFile));
    assert.equal(await isEncryptedArtifact(encrypted), true);
    await decryptFile(encrypted, restored, await readEncryptionKey(keyFile));
    assert.equal(await sha256File(restored), await sha256File(source));
    assert.equal(path.dirname(keyFile) === path.dirname(encrypted), false);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("PostgreSQL production policy covers all machine-verifiable operations gates", async () => {
  const backup = JSON.parse(await fsp.readFile(path.join(rootDir, "config", "postgresql-backup-policy.json"), "utf8"));
  const monitoring = JSON.parse(await fsp.readFile(path.join(rootDir, "config", "postgresql-monitoring.json"), "utf8"));
  assert.equal(backup.encryptionEnabled, true);
  assert.equal(backup.retentionDays > 0, true);
  assert.equal(backup.walArchiving, true);
  assert.equal(backup.plaintextRetention, false);
  for (const field of ["connectionPool", "locks", "replication", "disk", "slowQueries", "backupFreshness", "restoreFreshness", "ioTiming"]) {
    assert.equal(monitoring[field], true, `${field} monitoring must be enabled`);
  }
});

