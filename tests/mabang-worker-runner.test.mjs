import test from "node:test";
import assert from "node:assert/strict";
import { workerResultError } from "../lib/mabang-worker-runner.mjs";

test("preserves a bounded leading worker safety code", () => {
  const error = workerResultError({
    ok: false,
    error: "SKU_REPLACEMENT_VERIFY_FAILED: 写入结果无法确认",
  });

  assert.equal(error.code, "SKU_REPLACEMENT_VERIFY_FAILED");
  assert.equal(error.message, "SKU_REPLACEMENT_VERIFY_FAILED: 写入结果无法确认");
});

test("does not promote arbitrary response text to an error code", () => {
  const error = workerResultError({ ok: false, error: "https://example.test failed" });

  assert.equal(error.code, undefined);
  assert.equal(error.message, "https://example.test failed");
});
