import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { parseMabangWorkerResponse } from "../lib/mabang-worker-runner.mjs";

test("Mabang worker runner decodes compressed responses", () => {
  const expected = {
    ok: true,
    kind: "inventory",
    records: [{ SKU: "SKU-1", 仓库: "WH-A", 可用库存: 12 }],
  };
  const payload = gzipSync(Buffer.from(JSON.stringify(expected), "utf8"));
  assert.deepEqual(parseMabangWorkerResponse(payload, { encoding: "gzip" }), expected);
});

test("Mabang worker runner keeps plain response compatibility", () => {
  const expected = { ok: false, error: "source failure" };
  assert.deepEqual(parseMabangWorkerResponse(JSON.stringify(expected)), expected);
});

test("Mabang worker runner reports decompressed output overflow explicitly", () => {
  const payload = gzipSync(Buffer.from(JSON.stringify({ ok: true, value: "x".repeat(4096) }), "utf8"));
  assert.throws(
    () => parseMabangWorkerResponse(payload, { encoding: "gzip", maxResponseBytes: 1024 }),
    { code: "MABANG_WORKER_OUTPUT_TOO_LARGE" },
  );
});
