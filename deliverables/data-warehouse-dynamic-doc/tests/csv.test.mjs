import test from "node:test";
import assert from "node:assert/strict";
import { collectColumns, downloadCsv, serializeCsv } from "../shared/csv.mjs";

test("collects columns in first-seen order", () => {
  assert.deepEqual(collectColumns([{ a: 1, b: 2 }, { b: 3, c: 4 }]), ["a", "b", "c"]);
});

test("writes BOM, CRLF, quotes, commas, newlines, nulls, and objects", () => {
  const csv = serializeCsv([{ name: "A,B", note: "say \"hi\"\nnow", empty: null, meta: { x: 1 } }]);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.match(csv, /^\uFEFFname,note,empty,meta\r\n/);
  assert.match(csv, /"A,B"/);
  assert.match(csv, /"say ""hi""\nnow"/);
  assert.match(csv, /,"\{""x"":1\}"\r\n$/);
});

test("keeps accepted row names and long multiline values unchanged for export", () => {
  const unrelatedKey = ["zndr", "not-the-active-key"].join("_");
  const otherColumn = ["zndr", "other-looking-column"].join("_");
  const longValue = "L".repeat(600);
  const rows = [{
    "[已隐藏]": "first",
    [otherColumn]: "second",
    spaced: "  keep both spaces  ",
    multiline: "line one\nline two",
    unrelatedKey,
    longValue,
  }];
  assert.deepEqual(collectColumns(rows), [
    "[已隐藏]", otherColumn, "spaced", "multiline", "unrelatedKey", "longValue",
  ]);
  const csv = serializeCsv(rows);
  assert.equal(csv.startsWith(`\uFEFF[已隐藏],${otherColumn},spaced,multiline,unrelatedKey,longValue\r\n`), true);
  assert.equal(csv.includes("  keep both spaces  "), true);
  assert.equal(csv.includes('"line one\nline two"'), true);
  assert.equal(csv.includes(unrelatedKey), true);
  assert.equal(csv.includes(longValue), true);
});

test("downloads a CSV Blob through a temporary anchor", async () => {
  const clicks = [];
  const revokedUrls = [];
  const browserApi = {
    Blob,
    URL: {
      createObjectURL(blob) {
        assert.equal(blob.type, "text/csv;charset=utf-8");
        return "blob:csv";
      },
      revokeObjectURL(url) {
        revokedUrls.push(url);
      }
    },
    document: {
      createElement(tagName) {
        assert.equal(tagName, "a");
        return {
          click() {
            clicks.push({ href: this.href, download: this.download });
          }
        };
      }
    }
  };

  downloadCsv([{ total: 1 }], "report.csv", browserApi);

  assert.deepEqual(clicks, [{ href: "blob:csv", download: "report.csv" }]);
  assert.deepEqual(revokedUrls, ["blob:csv"]);
});

test("rejects downloading empty rows", () => {
  assert.throws(() => downloadCsv([], "report.csv", {}), /没有可导出的数据/);
});
