import assert from "node:assert/strict";
import test from "node:test";
import {
  countPublishedCustomerServiceKnowledgeReleases,
} from "../lib/product-knowledge/product-knowledge-service.mjs";
import {
  normalizeKnowledgeCandidate,
  normalizeKnowledgeRiskLevel,
} from "../lib/product-knowledge/shared-knowledge-package.mjs";
import { resolveProductKnowledgeImportTarget } from "../lib/product-knowledge/product-knowledge-import-safety.mjs";

test("customer-service readiness counts the schema-valid CUSTOMER_SERVICE release scope", () => {
  assert.equal(countPublishedCustomerServiceKnowledgeReleases([
    { status: "PUBLISHED", consumerScope: "CUSTOMER_SERVICE", total: 2 },
    { status: "DRAFT", consumerScope: "CUSTOMER_SERVICE", total: 9 },
    { status: "PUBLISHED", consumerScope: "LISTING", total: 4 },
    { status: "PUBLISHED", consumerScope: "SUPPORT", total: 7 },
  ]), 2);
  assert.equal(countPublishedCustomerServiceKnowledgeReleases(null), 0);
});

test("unknown and RESTRICTED source risks fail closed to HIGH", () => {
  assert.equal(normalizeKnowledgeRiskLevel("NORMAL"), "NORMAL");
  assert.equal(normalizeKnowledgeRiskLevel("SENSITIVE"), "SENSITIVE");
  assert.equal(normalizeKnowledgeRiskLevel("RESTRICTED"), "HIGH");
  assert.equal(normalizeKnowledgeRiskLevel("future-critical"), "HIGH");
  assert.equal(normalizeKnowledgeRiskLevel(""), "NORMAL");

  const candidate = normalizeKnowledgeCandidate({
    asset_id: "policy-review-inducement",
    asset_type: "SUPPORT_POLICY_CANDIDATE",
    governance: { status: "REVIEW_REQUIRED", risk_level: "RESTRICTED" },
    subject: { canonical_category: "fixture" },
    scope: { scope_type: "UNVERIFIED" },
    content: { issue: "fixture" },
    evidence: { source_id: "source-1" },
  }, {
    batchId: "batch-1",
    packageDigest: "digest-1",
    defaultTarget: "CUSTOMER_SERVICE_POLICY",
    now: "2026-08-08T00:00:00.000Z",
  });
  assert.equal(candidate.riskLevel, "HIGH");
});

test("production candidate import requires an explicit matching database target", () => {
  const configuredDatabase = "commerce_ops";
  assert.deepEqual(resolveProductKnowledgeImportTarget({
    argv: ["--apply", "--database=commerce_ops", "--confirm-database=commerce_ops"],
    configuredDatabase,
  }), { apply: true, database: "commerce_ops" });
  for (const argv of [
    ["--apply"],
    ["--apply", "--database=commerce_ops"],
    ["--apply", "--database=commerce_ops_migration_test", "--confirm-database=commerce_ops_migration_test"],
  ]) {
    assert.throws(
      () => resolveProductKnowledgeImportTarget({ argv, configuredDatabase }),
      /requires the active database/,
    );
  }
  assert.deepEqual(resolveProductKnowledgeImportTarget({ argv: [], configuredDatabase }), {
    apply: false,
    database: null,
  });
});
