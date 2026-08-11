import test from "node:test";
import assert from "node:assert/strict";
import { workerResultError } from "../lib/mabang-worker-runner.mjs";

const fixtureDiagnostic = {
  version: 1,
  capturedAt: "2026-08-11T01:02:03+00:00",
  stage: "mabang_response",
  endpoint: "order.doChanegOrderItem",
  request: {
    fieldNames: ["orderItemId", "stockId", "IsChangeWarehouse", "isChangeOrderItemPrice"],
    orderItemId: "477372993",
    stockId: "2679193",
    IsChangeWarehouse: "1",
    isChangeOrderItemPrice: "2",
  },
  response: {
    httpStatus: 409,
    contentType: "application/json",
    success: false,
    code: "FIELD_INVALID",
    message: "商品编号数据不存在",
    fieldNames: ["code", "message", "success"],
    bodyKind: "json",
    bodyLength: 63,
  },
  verification: {
    beforeSku: "OLD",
    targetSku: "NEW",
    afterSku: "OLD",
    result: "original",
  },
};

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

test("preserves an allowlisted SKU diagnostic and explicit worker code", () => {
  const error = workerResultError({
    ok: false,
    error: "SKU replacement rejected",
    code: "SKU_REPLACEMENT_REJECTED",
    diagnostic: fixtureDiagnostic,
  });

  assert.equal(error.code, "SKU_REPLACEMENT_REJECTED");
  assert.deepEqual(error.diagnostic, fixtureDiagnostic);
});

test("drops unrecognized and nested sensitive diagnostic fields", () => {
  const error = workerResultError({
    ok: false,
    error: "failed",
    diagnostic: {
      ...fixtureDiagnostic,
      password: "secret",
      headers: { cookie: "secret" },
      response: {
        ...fixtureDiagnostic.response,
        html: "<b>secret</b>",
        nested: { token: "secret" },
      },
    },
  });

  assert.equal(JSON.stringify(error.diagnostic).includes("secret"), false);
  assert.deepEqual(error.diagnostic, fixtureDiagnostic);
});
