import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { describeAuditRequest } from "../lib/security/audit-http.mjs";

test("product center exposes upload, history, mapping, quality and confirmation surfaces", async () => {
  const html = await fs.readFile("public/index.html", "utf8");
  for (const id of [
    "page-products", "productPackageUploadForm", "productImportHistoryTable", "productFieldMappingTable",
    "productIssueTable", "productImportRowsTable", "applyProductImportBtn",
    "productIssuesPrevBtn", "productIssuesNextBtn", "productRowsPrevBtn", "productRowsNextBtn",
  ]) assert.match(html, new RegExp(`id=["']${id}["']`));
  assert.match(html, /固定 34 字段合同/);
  assert.match(html, /原文件不会被修改/);
});

test("product center uses the authenticated current-origin API and never stores access tokens", async () => {
  const source = await fs.readFile("public/product-center-page.mjs", "utf8");
  assert.match(source, /authorizedFetch\("\/api\/product-center\/imports"/);
  assert.doesNotMatch(source, /127\.0\.0\.1|localhost|localStorage|sessionStorage|APP_ACCESS_TOKEN|[?&](?:token|access_token)=/i);
  assert.match(source, /"x-file-name"/);
  assert.match(source, /\/issues\?page=\$\{page\}&page_size=100/);
  assert.match(source, /\/rows\?page=\$\{page\}&page_size=100/);
});

test("product import creation, validation, completion and failures use stable audit actions", async () => {
  assert.equal(describeAuditRequest("POST", "/api/product-center/imports").action, "product.import.created");
  assert.equal(describeAuditRequest("POST", "/api/product-center/imports/00000000-0000-4000-8000-000000000000/apply").action, "product.import.completed");
  const api = await fs.readFile("lib/product-center/product-center-api.mjs", "utf8");
  const audit = await fs.readFile("lib/security/audit-service.mjs", "utf8");
  assert.match(api, /addRelated\("product", "product\.import\.validated"/);
  assert.match(api, /setOperation\("product", "product\.import\.failed"\)/);
  for (const action of ["product.import.created", "product.import.validated", "product.import.completed", "product.import.failed"]) {
    assert.match(audit, new RegExp(action.replaceAll(".", "\\.")));
  }
});
