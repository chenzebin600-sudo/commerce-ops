import test from "node:test";
import assert from "node:assert/strict";
import {
  createExcelHtmlRenderer,
  excelHtmlText,
  isUnsafeExcelText,
  normalizedSanitizationCounts,
  sanitizeExcelText,
} from "../lib/security/excel-cell-policy.mjs";

test("external formula prefixes are escaped without changing normal scalar types", () => {
  for (const value of ["=SUM(1,1)", "+SUM(1,1)", "@SUM(1,1)", "-cmd|' /C calc'!A0"]) {
    assert.equal(sanitizeExcelText(value), `'${value}`);
  }
  assert.equal(sanitizeExcelText(-10.5), -10.5);
  assert.equal(sanitizeExcelText(10.5), 10.5);
  assert.equal(sanitizeExcelText(true), true);
  assert.equal(sanitizeExcelText(null), null);
  const date = new Date("2026-07-16T00:00:00Z");
  assert.equal(sanitizeExcelText(date), date);
});

test("normal text, numeric text, SKU hyphens and existing apostrophes stay unchanged", () => {
  for (const value of ["普通商品名称", "-10.5", "-1,234.50", "SKU-ABC-123", "'=SUM(1,1)"]) {
    assert.equal(sanitizeExcelText(value), value);
    assert.equal(isUnsafeExcelText(value), false);
  }
});

test("leading Unicode whitespace, tabs and newlines cannot bypass formula detection", () => {
  for (const value of ["  =SUM(1,1)", "\t+SUM(1,1)", "\r\n@SUM(1,1)", "\u3000-cmd|'x'!A0", "\ufeff=1+1"]) {
    assert.equal(isUnsafeExcelText(value), true);
    assert.equal(sanitizeExcelText(value), `'${value}`);
  }
});

test("trusted formulas can be explicitly preserved and callbacks receive no cell content", () => {
  const calls = [];
  assert.equal(sanitizeExcelText("=SUM(1,1)", { trustedFormula: true }), "=SUM(1,1)");
  assert.equal(sanitizeExcelText("=SUM(1,1)", { onSanitized: (...args) => calls.push(args) }), "'=SUM(1,1)");
  assert.deepEqual(calls, [[]]);
});

test("HTML spreadsheet rendering applies formula safety before complete HTML escaping", () => {
  const renderer = createExcelHtmlRenderer();
  const html = renderer.table("Report", ["Field", "Value"], [
    ["title", renderer.text("<script>alert(1)</script>")],
    ["formula", renderer.text('=HYPERLINK("http://example.com")')],
    ["ai", renderer.text("+SUM(1,1)")],
    ["numeric-text", renderer.text("-10.5")],
    ["link", renderer.link("javascript:alert(1)", "<unsafe>")],
  ]);
  assert.equal(html.includes("<script>"), false);
  assert.equal(html.includes("javascript:alert"), false);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&#39;=HYPERLINK\(&quot;http:\/\/example\.com&quot;\)/);
  assert.match(html, /&#39;\+SUM\(1,1\)/);
  assert.match(html, />-10\.5</);
  assert.match(html, /&lt;unsafe&gt;/);
  assert.equal(renderer.sanitizedCount, 2);
});

test("direct HTML text helper protects AI output and audit counts contain no raw values", () => {
  assert.equal(excelHtmlText("@AI result <b>"), "&#39;@AI result &lt;b&gt;");
  assert.deepEqual(normalizedSanitizationCounts([
    { sheet: "Details\r\nInjected", count: 2 },
    { sheet: "Ignored", count: 0 },
  ]), [{ sheet: "Details  Injected", count: 2 }]);
});
