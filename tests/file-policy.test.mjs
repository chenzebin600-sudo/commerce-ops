import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  FILE_ERROR_CODES,
  atomicMoveFile,
  cleanupTemporaryFiles,
  createTemporaryFilePath,
  hashFileBuffer,
  normalizeStoredRelativePath,
  resolveExistingFile,
  resolveFileStorageConfig,
  resolveNewFile,
  safeContentDisposition,
  sanitizeFilename,
  validateDownloadMetadata,
  validateFileId,
  validateXlsxUpload,
} from "../lib/security/file-policy.mjs";
import { createMabangSchedulerApi } from "../lib/mabang-scheduler/api.mjs";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function zip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.data || "");
    const declaredCompressed = entry.compressedSize ?? data.length;
    const declaredUncompressed = entry.uncompressedSize ?? data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.method || 0, 8);
    local.writeUInt32LE(declaredCompressed, 18);
    local.writeUInt32LE(declaredUncompressed, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.method || 0, 10);
    central.writeUInt32LE(declaredCompressed, 20);
    central.writeUInt32LE(declaredUncompressed, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.length + name.length + data.length;
  }
  const localData = Buffer.concat(localParts);
  const centralData = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralData.length, 12);
  eocd.writeUInt32LE(localData.length, 16);
  return Buffer.concat([localData, centralData, eocd]);
}

function workbook({ sheets = 1, worksheetXml, extraEntries = [] } = {}) {
  const entries = [
    { name: "[Content_Types].xml", data: "<Types/>" },
    { name: "_rels/.rels", data: "<Relationships/>" },
    { name: "xl/workbook.xml", data: "<workbook/>" },
  ];
  for (let index = 1; index <= sheets; index += 1) {
    entries.push({
      name: `xl/worksheets/sheet${index}.xml`,
      data: worksheetXml || '<worksheet><dimension ref="A1:B2"/><sheetData><row r="1"><c r="A1"/></row></sheetData></worksheet>',
    });
  }
  return zip([...entries, ...extraEntries]);
}

function config(root, overrides = {}) {
  return resolveFileStorageConfig(root, {
    STORAGE_ROOT: "storage",
    MAX_UPLOAD_BYTES: String(20 * 1024 * 1024),
    ...overrides,
  });
}

async function temporaryRoot(prefix = "commerce-file-policy-") {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function assertFileError(callback, code) {
  assert.throws(callback, (error) => error?.code === code);
}

test("stored paths reject traversal, encoded traversal, absolute paths, UNC and null bytes", () => {
  const invalid = [
    "../secret.xlsx",
    "..\\secret.xlsx",
    "%2e%2e%2fsecret.xlsx",
    "%252e%252e%252fsecret.xlsx",
    "C:\\secret.xlsx",
    "\\\\server\\share\\secret.xlsx",
    "/etc/secret.xlsx",
    "folder/%00.xlsx",
  ];
  for (const value of invalid) assertFileError(() => normalizeStoredRelativePath(value), FILE_ERROR_CODES.FILE_PATH_INVALID);
  assert.equal(normalizeStoredRelativePath("task/run.xlsx"), "task/run.xlsx");
});

test("file IDs accept UUIDs only", () => {
  const id = crypto.randomUUID();
  assert.equal(validateFileId(id), id);
  assertFileError(() => validateFileId("../file"), FILE_ERROR_CODES.FILE_PATH_INVALID);
});

test("sensitive configuration, SQLite, log and source files are never resolved for download", async () => {
  const root = await temporaryRoot();
  try {
    for (const name of [".env", "data.sqlite", "server.log", "server.mjs"]) {
      await assert.rejects(resolveNewFile(root, name, { allowedExtensions: null }), (error) =>
        [FILE_ERROR_CODES.FILE_ACCESS_DENIED, FILE_ERROR_CODES.FILE_TYPE_NOT_ALLOWED].includes(error?.code));
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("download metadata and Content-Disposition sanitize path and header characters", () => {
  const id = crypto.randomUUID();
  const safe = validateDownloadMetadata({
    id,
    status: "available",
    originalFilename: "..\\report\r\nInjected.xlsx",
    storageFilename: `${id}.xlsx`,
    relativePath: `manual/${id}.xlsx`,
  });
  assert.equal(safe.originalFilename.includes("\r"), false);
  assert.equal(safe.originalFilename.includes("\n"), false);
  const disposition = safeContentDisposition(safe.originalFilename);
  assert.equal(/[\r\n]/.test(disposition), false);
  assert.match(disposition, /^attachment;/);
});

test("valid xlsx passes extension, MIME, signature and workbook checks", () => {
  const root = path.join(os.tmpdir(), "xlsx-config");
  const buffer = workbook();
  const result = validateXlsxUpload({ filename: "Lazada report.xlsx", mimeType: XLSX_MIME, buffer, config: config(root) });
  assert.equal(result.fileHash, hashFileBuffer(buffer));
  assert.equal(result.workbook.sheets, 1);
  assert.match(result.storageFilename, /^[0-9a-f-]+\.xlsx$/);
});

test("fake, wrong-signature, macro and executable uploads are rejected", () => {
  const policy = config(os.tmpdir());
  assertFileError(() => validateXlsxUpload({ filename: "fake.xlsx", mimeType: XLSX_MIME, buffer: Buffer.from("plain text"), config: policy }), FILE_ERROR_CODES.FILE_SIGNATURE_INVALID);
  assertFileError(() => validateXlsxUpload({ filename: "macro.xlsm", mimeType: XLSX_MIME, buffer: workbook(), config: policy }), FILE_ERROR_CODES.FILE_TYPE_NOT_ALLOWED);
  assertFileError(() => validateXlsxUpload({ filename: "program.exe", mimeType: "application/octet-stream", buffer: workbook(), config: policy }), FILE_ERROR_CODES.FILE_TYPE_NOT_ALLOWED);
  const macroWorkbook = workbook({ extraEntries: [{ name: "xl/vbaProject.bin", data: "macro" }] });
  assertFileError(() => validateXlsxUpload({ filename: "hidden.xlsx", mimeType: XLSX_MIME, buffer: macroWorkbook, config: policy }), FILE_ERROR_CODES.FILE_TYPE_NOT_ALLOWED);
});

test("MIME and upload size limits are enforced", () => {
  const buffer = workbook();
  assertFileError(() => validateXlsxUpload({ filename: "report.xlsx", mimeType: "text/plain", buffer, config: config(os.tmpdir()) }), FILE_ERROR_CODES.FILE_MIME_INVALID);
  const large = workbook({ worksheetXml: `<worksheet><sheetData>${"x".repeat(2048)}</sheetData></worksheet>` });
  assertFileError(() => validateXlsxUpload({ filename: "report.xlsx", mimeType: XLSX_MIME, buffer: large, config: config(os.tmpdir(), { MAX_UPLOAD_BYTES: "1024" }) }), FILE_ERROR_CODES.FILE_TOO_LARGE);
});

test("zip bombs, excessive sheets and oversized worksheet dimensions are rejected", () => {
  const normal = config(os.tmpdir());
  const bomb = workbook({ extraEntries: [{ name: "xl/sharedStrings.xml", data: "x", uncompressedSize: 10_000_000 }] });
  assertFileError(() => validateXlsxUpload({ filename: "bomb.xlsx", mimeType: XLSX_MIME, buffer: bomb, config: config(os.tmpdir(), { MAX_XLSX_COMPRESSION_RATIO: "10" }) }), FILE_ERROR_CODES.WORKBOOK_LIMIT_EXCEEDED);
  assertFileError(() => validateXlsxUpload({ filename: "sheets.xlsx", mimeType: XLSX_MIME, buffer: workbook({ sheets: 3 }), config: config(os.tmpdir(), { MAX_WORKBOOK_SHEETS: "2" }) }), FILE_ERROR_CODES.WORKBOOK_LIMIT_EXCEEDED);
  const wide = workbook({ worksheetXml: '<worksheet><dimension ref="A1:ZZ1000"/><sheetData/></worksheet>' });
  assertFileError(() => validateXlsxUpload({ filename: "wide.xlsx", mimeType: XLSX_MIME, buffer: wide, config: normal }), FILE_ERROR_CODES.WORKBOOK_LIMIT_EXCEEDED);
});

test("temporary files move atomically, zero-byte files fail, and names cannot add directories", async () => {
  const root = await temporaryRoot();
  const tempRoot = path.join(root, "temp");
  const exportRoot = path.join(root, "exports");
  try {
    const source = await createTemporaryFilePath(tempRoot, { prefix: "../../task", extension: ".xlsx" });
    await fs.writeFile(source.path, "workbook");
    const moved = await atomicMoveFile({ sourceRoot: tempRoot, sourcePath: source.path, destinationRoot: exportRoot, destinationRelativePath: "task/run.xlsx" });
    assert.equal((await fs.readFile(moved.path, "utf8")), "workbook");
    assert.equal(path.dirname(moved.path), path.join(exportRoot, "task"));

    const empty = await createTemporaryFilePath(tempRoot, { prefix: "empty", extension: ".xlsx" });
    await fs.writeFile(empty.path, "");
    await assert.rejects(atomicMoveFile({ sourceRoot: tempRoot, sourcePath: empty.path, destinationRoot: exportRoot, destinationRelativePath: "task/empty.xlsx" }),
      (error) => error?.code === FILE_ERROR_CODES.TEMP_FILE_ERROR);
    await assert.rejects(fs.stat(path.join(exportRoot, "task", "empty.xlsx")));
    assert.equal(sanitizeFilename("../../bad:name.xlsx").includes("/"), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("temporary cleanup stays inside TEMP_ROOT and preserves formal exports", async () => {
  const root = await temporaryRoot();
  const tempRoot = path.join(root, "temp");
  const exportRoot = path.join(root, "exports");
  try {
    await fs.mkdir(tempRoot, { recursive: true });
    await fs.mkdir(exportRoot, { recursive: true });
    const staleTemp = path.join(tempRoot, "stale.tmp");
    const formal = path.join(exportRoot, "history.xlsx");
    await fs.writeFile(staleTemp, "temp");
    await fs.writeFile(formal, "history");
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await fs.utimes(staleTemp, old, old);
    await fs.utimes(formal, old, old);
    const result = await cleanupTemporaryFiles(tempRoot, { retentionHours: 24 });
    assert.equal(result.removed, 1);
    await assert.rejects(fs.stat(staleTemp));
    assert.equal(await fs.readFile(formal, "utf8"), "history");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("new file paths reject an intermediate symbolic link without writing outside the root", async (context) => {
  const root = await temporaryRoot();
  const outside = await temporaryRoot("commerce-file-outside-");
  const link = path.join(root, "linked");
  try {
    try {
      await fs.symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOSYS"].includes(error?.code)) {
        context.skip("symbolic links are unavailable in this environment");
        return;
      }
      throw error;
    }
    await assert.rejects(resolveNewFile(root, "linked/nested/file.xlsx"),
      (error) => error?.code === FILE_ERROR_CODES.FILE_PATH_INVALID);
    await assert.rejects(fs.stat(path.join(outside, "nested")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

function responseRecorder() {
  return {
    status: 0,
    headers: {},
    body: Buffer.alloc(0),
    writeHead(status, headers = {}) { this.status = status; this.headers = headers; },
    end(body = "") { this.body = Buffer.isBuffer(body) ? body : Buffer.from(String(body)); },
  };
}

test("scheduled download uses file ID metadata and returns bounded 404/path errors", async () => {
  const root = await temporaryRoot();
  const fileId = crypto.randomUUID();
  const bytes = Buffer.from("existing historical export");
  const relativePath = `task/${fileId}.xlsx`;
  try {
    const target = await resolveNewFile(root, relativePath);
    await fs.writeFile(target.path, bytes);
    let record = {
      id: fileId,
      status: "available",
      originalFilename: "history.xlsx",
      storageFilename: `${fileId}.xlsx`,
      relativePath,
      fileSize: bytes.length,
      fileHash: hashFileBuffer(bytes),
    };
    const db = { getExportFile: (id) => id === fileId ? record : null };
    const handler = createMabangSchedulerApi({ db, runWorker: async () => ({}), exportRoot: root });

    const success = responseRecorder();
    await handler({ method: "GET" }, success, new URL(`http://local/api/mabang/export-files/${fileId}/download`));
    assert.equal(success.status, 200);
    assert.deepEqual(success.body, bytes);
    assert.equal(JSON.stringify(success.headers).includes(root), false);

    const missing = responseRecorder();
    await handler({ method: "GET" }, missing, new URL(`http://local/api/mabang/export-files/${crypto.randomUUID()}/download`));
    assert.equal(missing.status, 404);
    assert.equal(missing.body.toString().includes(root), false);

    record = { ...record, relativePath: "../.env" };
    const blocked = responseRecorder();
    await handler({ method: "GET" }, blocked, new URL(`http://local/api/mabang/export-files/${fileId}/download`));
    assert.ok([400, 403].includes(blocked.status));
    assert.equal(blocked.body.toString().includes(root), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
