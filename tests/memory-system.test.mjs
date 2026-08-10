import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { auditMemory } from "../scripts/memory-doctor.mjs";

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "commerce-ops-memory-"));
  await mkdir(path.join(root, "memory", "projects"), { recursive: true });
  await writeFile(path.join(root, "AGENTS.md"), "# Agent\n", "utf8");
  await writeFile(
    path.join(root, "memory", "INDEX.md"),
    "---\nupdated_at: 2026-08-04\n---\n<!-- memory-pointer: memory/PERMANENT.md -->\n",
    "utf8",
  );
  await writeFile(
    path.join(root, "memory", "PERMANENT.md"),
    "---\nupdated_at: 2026-08-04\n---\n<!-- fact-id: fixture.permanent -->\n- fact\n",
    "utf8",
  );
  await writeFile(
    path.join(root, "memory", "SOP.md"),
    "---\nupdated_at: 2026-08-04\n---\n# SOP\n",
    "utf8",
  );
  await writeFile(
    path.join(root, "memory", "projects", "commerce-ops.md"),
    "---\nupdated_at: 2026-08-04\n---\n# Project\n",
    "utf8",
  );
  return root;
}

test("memory audit accepts a healthy single-source fixture", async () => {
  const root = await createFixture();
  const result = await auditMemory(root);
  assert.deepEqual(result.errors, []);
  assert.equal(result.counts.facts, 1);
  assert.equal(result.counts.pointers, 1);
});

test("memory audit reports duplicate facts and identifies the newest file", async () => {
  const root = await createFixture();
  await writeFile(
    path.join(root, "memory", "projects", "duplicate.md"),
    "---\nupdated_at: 2026-08-05\n---\n<!-- fact-id: fixture.permanent -->\n- newer fact\n",
    "utf8",
  );

  const result = await auditMemory(root);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /Duplicate fact-id fixture\.permanent/);
  assert.match(result.errors[0], /Temporary winner \(newest file\): memory\/projects\/duplicate\.md/);
});

test("memory audit reports broken pointers", async () => {
  const root = await createFixture();
  await writeFile(
    path.join(root, "memory", "INDEX.md"),
    "---\nupdated_at: 2026-08-04\n---\n<!-- memory-pointer: memory/missing.md -->\n",
    "utf8",
  );

  const result = await auditMemory(root);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /Broken pointer/);
});

test("memory audit warns when permanent memory becomes bloated", async () => {
  const root = await createFixture();
  const largePermanent = [
    "---",
    "updated_at: 2026-08-04",
    "---",
    "<!-- fact-id: fixture.permanent -->",
    ...Array.from({ length: 122 }, (_, index) => `- durable line ${index + 1}`),
  ].join("\n");
  await writeFile(
    path.join(root, "memory", "PERMANENT.md"),
    largePermanent,
    "utf8",
  );

  const result = await auditMemory(root);
  assert.deepEqual(result.errors, []);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /getting large/);
});
