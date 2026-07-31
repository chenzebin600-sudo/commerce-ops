import assert from "node:assert/strict";
import test from "node:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import {
  appendVaryHeader,
  encodeHttpBody,
  preferredContentEncoding,
} from "../lib/http-content-encoding.mjs";

test("HTTP response encoding honors quality values and round-trips payloads", async () => {
  assert.equal(preferredContentEncoding("gzip, br"), "br");
  assert.equal(preferredContentEncoding("br;q=0, gzip;q=1"), "gzip");
  assert.equal(preferredContentEncoding("identity"), null);

  const source = JSON.stringify({ rows: Array.from({ length: 500 }, (_, index) => ({ index, label: "dashboard" })) });
  const brotli = await encodeHttpBody(source, "gzip, br");
  const gzipped = await encodeHttpBody(source, "gzip");
  assert.equal(brotli.encoding, "br");
  assert.equal(gzipped.encoding, "gzip");
  assert.equal(brotliDecompressSync(brotli.body).toString("utf8"), source);
  assert.equal(gunzipSync(gzipped.body).toString("utf8"), source);
  assert.ok(brotli.body.length < Buffer.byteLength(source));
  assert.equal(appendVaryHeader("Origin", "Accept-Encoding"), "Origin, Accept-Encoding");
});

test("small HTTP responses remain uncompressed", async () => {
  const result = await encodeHttpBody("ok", "gzip, br");
  assert.equal(result.encoding, null);
  assert.equal(result.body.toString("utf8"), "ok");
});
