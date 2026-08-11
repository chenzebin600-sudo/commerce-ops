import test from "node:test";
import assert from "node:assert/strict";
import { presentFulfillmentError } from "../fulfillment-service/http-error.mjs";

const diagnostic = {
  version: 1, stage: "mabang_response", response: { httpStatus: 409 },
};

test("非 500 的 SKU 错误返回诊断详情", () => {
  const error = Object.assign(new Error("马帮拒绝"), {
    status: 409, code: "SKU_REPLACEMENT_REJECTED", details: { diagnostic },
  });
  assert.deepEqual(presentFulfillmentError(error), {
    status: 409,
    body: { success: false, error: { code: "SKU_REPLACEMENT_REJECTED", message: "马帮拒绝", details: { diagnostic } } },
  });
});

test("500 错误不暴露详情", () => {
  const result = presentFulfillmentError(Object.assign(new Error("secret"), { diagnostic }));
  assert.deepEqual(result, {
    status: 500,
    body: { success: false, error: { code: "INTERNAL_ERROR", message: "服务内部错误" } },
  });
});
