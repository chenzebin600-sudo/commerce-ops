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
