import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolvePythonRuntime } from "../lib/python-runtime.mjs";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pythonRuntime = resolvePythonRuntime({
  appRoot: rootDir,
  env: process.env,
  requiredModules: ["openpyxl"],
});
assert.equal(pythonRuntime.ok, true, pythonRuntime.errorCode);
const python = pythonRuntime.executable;
const worker = path.join(rootDir, "scripts", "mabang_worker.py");

test("Python Excel policy preserves scalar types and escapes only dangerous strings", () => {
  const source = [
    "import json,sys",
    `sys.path.insert(0, ${JSON.stringify(path.join(rootDir, "scripts"))})`,
    "from datetime import date,datetime",
    "from excel_cell_policy import sanitize_excel_text",
    "d=date(2026,7,16); dt=datetime(2026,7,16,8,30)",
    "values=[sanitize_excel_text(v) for v in [-10.5,10.5,True,None,d,dt,'-10.5','SKU-1','=SUM(1,1)','\\t@SUM(1,1)',\"'=SUM(1,1)\"]]",
    "print(json.dumps({'values':[str(v) if isinstance(v,(date,datetime)) else v for v in values],'date_same':values[4] is d,'datetime_same':values[5] is dt}))",
  ].join(";");
  const result = spawnSync(python, ["-c", source], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.equal(data.date_same, true);
  assert.equal(data.datetime_same, true);
  assert.deepEqual(data.values.slice(0, 4), [-10.5, 10.5, true, null]);
  assert.deepEqual(data.values.slice(6), ["-10.5", "SKU-1", "'=SUM(1,1)", "'\t@SUM(1,1)", "'=SUM(1,1)"]);
});

test("Mabang workbook keeps columns and scalar values while emitting no untrusted formulas", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mabang-excel-safety-"));
  const outputPath = path.join(tempDir, "mock.xlsx");
  const columns = ["name", "amount", "date", "active", "sku", "note", "原始商品总金额"];
  const payload = {
    action: "write-xlsx",
    outputPath,
    kind: "orders",
    columns,
    records: [{
      name: '=HYPERLINK("http://example.com")',
      amount: -10.5,
      date: "2026-07-16",
      active: true,
      sku: "SKU-ABC-123",
      note: "-cmd|' /C calc'!A0",
      原始商品总金额: "",
    }],
    metadataSheetName: "Task Info",
    summary: { taskName: "+SUM(1,1)", exportedRows: 1 },
  };
  try {
    const generated = spawnSync(python, [worker], {
      input: Buffer.from(JSON.stringify(payload), "utf8"),
      encoding: "utf8",
      env: { ...process.env, PYTHONIOENCODING: "utf-8", MABANG_EXPORT_DIR: tempDir },
      timeout: 30_000,
    });
    assert.equal(generated.status, 0, generated.stderr);
    const result = JSON.parse(generated.stdout);
    assert.equal(result.ok, true);
    assert.deepEqual(result.sanitizedCells.map((item) => item.count), [2, 1]);

    const inspectSource = [
      "import json,sys,openpyxl",
      "wb=openpyxl.load_workbook(sys.argv[1],read_only=True,data_only=False,keep_links=False)",
      "detail=wb.worksheets[0]",
      "rows=list(detail.iter_rows(values_only=False))",
      "metadata=list(wb.worksheets[1].iter_rows(values_only=True))",
      "print(json.dumps({'headers':[c.value for c in rows[0]],'values':[c.value for c in rows[1]],'types':[c.data_type for c in rows[1]],'metadata':metadata},ensure_ascii=True,default=str))",
      "wb.close()",
    ].join(";");
    const inspected = spawnSync(python, ["-c", inspectSource, outputPath], { encoding: "utf8" });
    assert.equal(inspected.status, 0, inspected.stderr);
    const workbook = JSON.parse(inspected.stdout);
    assert.deepEqual(workbook.headers, columns);
    assert.deepEqual(workbook.values, [
      "'=HYPERLINK(\"http://example.com\")",
      -10.5,
      "2026-07-16",
      true,
      "SKU-ABC-123",
      "'-cmd|' /C calc'!A0",
      "来源未提供",
    ]);
    assert.equal(workbook.types.includes("f"), false);
    assert.equal(workbook.metadata.some((row) => row.includes("'+SUM(1,1)")), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("lifecycle report workbook uses the same formula-injection protection", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-excel-safety-"));
  const outputPath = path.join(tempDir, "lifecycle.xlsx");
  const payload = {
    action: "write-xlsx",
    outputPath,
    kind: "lifecycle",
    columns: ["filename", "reason_code"],
    records: [{ filename: "=HYPERLINK(\"http://example.com\")", reason_code: "+SUM(1,1)" }],
    metadataSheetName: "Scan information",
    summary: { scanId: "@scan", exportedRows: 1 },
  };
  try {
    const generated = spawnSync(python, [worker], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      env: { ...process.env, PYTHONIOENCODING: "utf-8", MABANG_EXPORT_DIR: tempDir },
      timeout: 30_000,
    });
    assert.equal(generated.status, 0, generated.stderr);
    const inspect = [
      "import json,sys,openpyxl",
      "wb=openpyxl.load_workbook(sys.argv[1],read_only=True,data_only=False,keep_links=False)",
      "rows=list(wb.worksheets[0].iter_rows(values_only=False))",
      "meta=list(wb.worksheets[1].iter_rows(values_only=False))",
      "print(json.dumps({'values':[c.value for c in rows[1]],'types':[c.data_type for c in rows[1]],'meta_values':[c.value for row in meta for c in row],'meta_types':[c.data_type for row in meta for c in row]}))",
      "wb.close()",
    ].join(";");
    const inspected = spawnSync(python, ["-c", inspect, outputPath], { encoding: "utf8" });
    assert.equal(inspected.status, 0, inspected.stderr);
    const workbook = JSON.parse(inspected.stdout);
    assert.deepEqual(workbook.values, ["'=HYPERLINK(\"http://example.com\")", "'+SUM(1,1)"]);
    assert.equal([...workbook.types, ...workbook.meta_types].includes("f"), false);
    assert.equal(workbook.meta_values.includes("'@scan"), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
