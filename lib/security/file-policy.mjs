import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import { inflateRawSync } from "node:zlib";

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const DEFAULT_MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const DEFAULT_TEMP_RETENTION_HOURS = 24;

export const FILE_ERROR_CODES = Object.freeze({
  FILE_NOT_FOUND: "FILE_NOT_FOUND",
  FILE_ACCESS_DENIED: "FILE_ACCESS_DENIED",
  FILE_PATH_INVALID: "FILE_PATH_INVALID",
  FILE_TYPE_NOT_ALLOWED: "FILE_TYPE_NOT_ALLOWED",
  FILE_MIME_INVALID: "FILE_MIME_INVALID",
  FILE_SIGNATURE_INVALID: "FILE_SIGNATURE_INVALID",
  FILE_TOO_LARGE: "FILE_TOO_LARGE",
  WORKBOOK_INVALID: "WORKBOOK_INVALID",
  WORKBOOK_LIMIT_EXCEEDED: "WORKBOOK_LIMIT_EXCEEDED",
  TEMP_FILE_ERROR: "TEMP_FILE_ERROR",
  FILE_STORAGE_ERROR: "FILE_STORAGE_ERROR",
});

const PUBLIC_MESSAGES = Object.freeze({
  FILE_NOT_FOUND: "文件不存在或已被清理。",
  FILE_ACCESS_DENIED: "不允许访问该文件。",
  FILE_PATH_INVALID: "文件路径无效。",
  FILE_TYPE_NOT_ALLOWED: "不支持该文件类型。",
  FILE_MIME_INVALID: "文件 MIME 类型不正确。",
  FILE_SIGNATURE_INVALID: "文件内容与声明的类型不一致。",
  FILE_TOO_LARGE: "文件超过允许的大小限制。",
  WORKBOOK_INVALID: "Excel 工作簿无效或无法安全读取。",
  WORKBOOK_LIMIT_EXCEEDED: "Excel 工作簿超过安全处理限制。",
  TEMP_FILE_ERROR: "临时文件处理失败。",
  FILE_STORAGE_ERROR: "文件存储操作失败。",
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const BLOCKED_FILE_NAMES = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|id_[^.]+|credentials(?:\..*)?|secrets?(?:\..*)?)$/i;
const BLOCKED_EXTENSIONS = new Set([
  ".db", ".sqlite", ".sqlite3", ".log", ".key", ".pem", ".pfx", ".p12",
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".py", ".sh", ".ps1", ".bat", ".cmd",
  ".exe", ".dll", ".com", ".html", ".htm", ".svg",
]);
const XLSX_UPLOAD_MIMES = new Set([XLSX_MIME, "application/octet-stream"]);

export class FilePolicyError extends Error {
  constructor(code, options = {}) {
    super(PUBLIC_MESSAGES[code] || "文件安全校验失败。", options.cause ? { cause: options.cause } : undefined);
    this.name = "FilePolicyError";
    this.code = code;
    this.status = options.status || defaultStatus(code);
  }
}

function defaultStatus(code) {
  if (code === FILE_ERROR_CODES.FILE_NOT_FOUND) return 404;
  if (code === FILE_ERROR_CODES.FILE_TOO_LARGE) return 413;
  if (code === FILE_ERROR_CODES.FILE_MIME_INVALID) return 415;
  if (code === FILE_ERROR_CODES.FILE_ACCESS_DENIED) return 403;
  return 400;
}

function boundedInteger(value, fallback, { minimum, maximum, name }) {
  const parsed = value == null || String(value).trim() === "" ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} 必须是 ${minimum} 到 ${maximum} 之间的整数。`);
  }
  return parsed;
}

function configuredRoot(rootDir, value, fallback) {
  return path.resolve(rootDir, String(value || "").trim() || fallback);
}

export function resolveFileStorageConfig(rootDir, env = process.env) {
  const storageRoot = configuredRoot(rootDir, env.STORAGE_ROOT, "storage");
  const uploadRoot = configuredRoot(rootDir, env.UPLOAD_ROOT, path.join(storageRoot, "uploads"));
  const exportRoot = configuredRoot(
    rootDir,
    env.EXPORT_ROOT || env.EXPORT_STORAGE_PATH,
    path.join(storageRoot, "exports", "mabang"),
  );
  const tempRoot = configuredRoot(rootDir, env.TEMP_ROOT, path.join(storageRoot, "temp"));
  return Object.freeze({
    storageRoot,
    uploadRoot,
    exportRoot,
    tempRoot,
    maxUploadBytes: boundedInteger(env.MAX_UPLOAD_BYTES, DEFAULT_MAX_UPLOAD_BYTES, {
      minimum: 1024,
      maximum: 100 * 1024 * 1024,
      name: "MAX_UPLOAD_BYTES",
    }),
    tempFileRetentionHours: boundedInteger(env.TEMP_FILE_RETENTION_HOURS, DEFAULT_TEMP_RETENTION_HOURS, {
      minimum: 1,
      maximum: 24 * 365,
      name: "TEMP_FILE_RETENTION_HOURS",
    }),
    workbookLimits: Object.freeze({
      maxSheets: boundedInteger(env.MAX_WORKBOOK_SHEETS, 50, { minimum: 1, maximum: 200, name: "MAX_WORKBOOK_SHEETS" }),
      maxRows: boundedInteger(env.MAX_WORKBOOK_ROWS, 200_000, { minimum: 1, maximum: 1_048_576, name: "MAX_WORKBOOK_ROWS" }),
      maxColumns: boundedInteger(env.MAX_WORKBOOK_COLUMNS, 256, { minimum: 1, maximum: 16_384, name: "MAX_WORKBOOK_COLUMNS" }),
      maxEntries: boundedInteger(env.MAX_XLSX_ENTRIES, 2_000, { minimum: 10, maximum: 20_000, name: "MAX_XLSX_ENTRIES" }),
      maxEntryBytes: boundedInteger(env.MAX_XLSX_ENTRY_BYTES, 64 * 1024 * 1024, { minimum: 1024, maximum: 256 * 1024 * 1024, name: "MAX_XLSX_ENTRY_BYTES" }),
      maxUncompressedBytes: boundedInteger(env.MAX_XLSX_UNCOMPRESSED_BYTES, 200 * 1024 * 1024, { minimum: 1024, maximum: 1024 * 1024 * 1024, name: "MAX_XLSX_UNCOMPRESSED_BYTES" }),
      maxCompressionRatio: boundedInteger(env.MAX_XLSX_COMPRESSION_RATIO, 200, { minimum: 1, maximum: 10_000, name: "MAX_XLSX_COMPRESSION_RATIO" }),
    }),
  });
}

export async function ensureFileStorageRoots(config) {
  for (const root of [config.storageRoot, config.uploadRoot, config.exportRoot, config.tempRoot]) {
    await fs.mkdir(root, { recursive: true });
  }
  return config;
}

export function validateFileId(value) {
  const id = String(value || "").trim();
  if (!UUID_PATTERN.test(id)) throw new FilePolicyError(FILE_ERROR_CODES.FILE_PATH_INVALID);
  return id;
}

export function sanitizeFilename(value, { fallback = "file", maxLength = 180 } = {}) {
  let filename = path.basename(String(value || ""))
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "_")
    .replace(/[. ]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!filename || filename === "." || filename === "..") filename = fallback;
  if (filename.startsWith(".")) filename = `file${filename}`;
  if (WINDOWS_RESERVED.test(filename)) filename = `file_${filename}`;
  const extension = path.extname(filename);
  const stemLimit = Math.max(1, maxLength - extension.length);
  const stem = path.basename(filename, extension).slice(0, stemLimit).replace(/[. ]+$/g, "") || fallback;
  return `${stem}${extension.slice(0, Math.max(0, maxLength - stem.length))}`;
}

function decodePathRepeatedly(value) {
  let decoded = value;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let next;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      throw new FilePolicyError(FILE_ERROR_CODES.FILE_PATH_INVALID);
    }
    if (next === decoded) return decoded;
    decoded = next;
  }
  return decoded;
}

export function normalizeStoredRelativePath(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.indexOf("\0") >= 0) throw new FilePolicyError(FILE_ERROR_CODES.FILE_PATH_INVALID);
  const decoded = decodePathRepeatedly(raw);
  if (decoded !== raw || /%[0-9a-f]{2}/i.test(raw)) throw new FilePolicyError(FILE_ERROR_CODES.FILE_PATH_INVALID);
  if (path.isAbsolute(raw) || path.win32.isAbsolute(raw) || path.posix.isAbsolute(raw)) {
    throw new FilePolicyError(FILE_ERROR_CODES.FILE_PATH_INVALID);
  }
  if (/^(?:[a-z]:|\\\\|\/\/)/i.test(raw) || raw.indexOf("\\") >= 0) {
    throw new FilePolicyError(FILE_ERROR_CODES.FILE_PATH_INVALID);
  }
  const segments = raw.split("/");
  if (segments.some((part) => !part || part === "." || part === ".." || part.indexOf(":") >= 0)) {
    throw new FilePolicyError(FILE_ERROR_CODES.FILE_PATH_INVALID);
  }
  return segments.join("/");
}

function normalizedComparisonPath(value) {
  const resolved = path.resolve(value).replace(/[\\/]+$/g, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function assertInsideRoot(root, target, { allowRoot = false } = {}) {
  const rootValue = normalizedComparisonPath(root);
  const targetValue = normalizedComparisonPath(target);
  const relative = path.relative(rootValue, targetValue);
  if ((!relative && !allowRoot) || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new FilePolicyError(FILE_ERROR_CODES.FILE_PATH_INVALID);
  }
}

function assertAllowedFileName(filename, allowedExtensions = [".xlsx"]) {
  const rawName = String(filename || "").trim();
  if (BLOCKED_FILE_NAMES.test(rawName.toLowerCase())) {
    throw new FilePolicyError(FILE_ERROR_CODES.FILE_ACCESS_DENIED);
  }
  const safeName = sanitizeFilename(filename);
  const lower = safeName.toLowerCase();
  const extension = path.extname(lower);
  if (BLOCKED_FILE_NAMES.test(lower) || BLOCKED_EXTENSIONS.has(extension)) {
    throw new FilePolicyError(FILE_ERROR_CODES.FILE_ACCESS_DENIED);
  }
  if (allowedExtensions && !allowedExtensions.map((item) => item.toLowerCase()).includes(extension)) {
    throw new FilePolicyError(FILE_ERROR_CODES.FILE_TYPE_NOT_ALLOWED);
  }
  return safeName;
}

async function realRoot(root) {
  await fs.mkdir(root, { recursive: true });
  return fs.realpath(root);
}

async function ensureSafeSubdirectory(canonicalRoot, segments) {
  let current = canonicalRoot;
  for (const segment of segments) {
    const candidate = path.join(current, segment);
    assertInsideRoot(canonicalRoot, candidate);
    let stat;
    try {
      stat = await fs.lstat(candidate);
    } catch (error) {
      if (error?.code !== "ENOENT") throw new FilePolicyError(FILE_ERROR_CODES.FILE_STORAGE_ERROR, { cause: error });
      try {
        await fs.mkdir(candidate);
        stat = await fs.lstat(candidate);
      } catch (createError) {
        throw new FilePolicyError(FILE_ERROR_CODES.FILE_STORAGE_ERROR, { cause: createError });
      }
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new FilePolicyError(FILE_ERROR_CODES.FILE_PATH_INVALID);
    }
    current = await fs.realpath(candidate);
    assertInsideRoot(canonicalRoot, current);
  }
  return current;
}

export async function resolveExistingFile(root, relativePath, { allowedExtensions = [".xlsx"] } = {}) {
  const canonicalRoot = await realRoot(root);
  const normalizedRelative = normalizeStoredRelativePath(relativePath);
  assertAllowedFileName(path.basename(normalizedRelative), allowedExtensions);
  const candidate = path.resolve(canonicalRoot, normalizedRelative);
  assertInsideRoot(canonicalRoot, candidate);
  let fileInfo;
  try {
    fileInfo = await fs.lstat(candidate);
  } catch (error) {
    if (error?.code === "ENOENT") throw new FilePolicyError(FILE_ERROR_CODES.FILE_NOT_FOUND);
    throw new FilePolicyError(FILE_ERROR_CODES.FILE_STORAGE_ERROR, { cause: error });
  }
  if (fileInfo.isSymbolicLink() || !fileInfo.isFile()) throw new FilePolicyError(FILE_ERROR_CODES.FILE_ACCESS_DENIED);
  const canonicalTarget = await fs.realpath(candidate);
  assertInsideRoot(canonicalRoot, canonicalTarget);
  return Object.freeze({ path: canonicalTarget, stat: fileInfo, relativePath: normalizedRelative });
}

export async function resolveExistingDirectory(root, relativePath) {
  const canonicalRoot = await realRoot(root);
  const normalizedRelative = normalizeStoredRelativePath(relativePath);
  const candidate = path.resolve(canonicalRoot, normalizedRelative);
  assertInsideRoot(canonicalRoot, candidate);
  let directoryInfo;
  try {
    directoryInfo = await fs.lstat(candidate);
  } catch (error) {
    if (error?.code === "ENOENT") throw new FilePolicyError(FILE_ERROR_CODES.FILE_NOT_FOUND);
    throw new FilePolicyError(FILE_ERROR_CODES.FILE_STORAGE_ERROR, { cause: error });
  }
  if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
    throw new FilePolicyError(FILE_ERROR_CODES.FILE_ACCESS_DENIED);
  }
  const canonicalTarget = await fs.realpath(candidate);
  assertInsideRoot(canonicalRoot, canonicalTarget);
  return Object.freeze({ path: canonicalTarget, stat: directoryInfo, relativePath: normalizedRelative });
}

export async function resolveNewFile(root, relativePath, { allowedExtensions = [".xlsx"] } = {}) {
  const canonicalRoot = await realRoot(root);
  const normalizedRelative = normalizeStoredRelativePath(relativePath);
  const segments = normalizedRelative.split("/");
  const filename = assertAllowedFileName(segments.at(-1), allowedExtensions);
  const parent = await ensureSafeSubdirectory(canonicalRoot, segments.slice(0, -1));
  const candidate = path.join(parent, filename);
  const safeRelativePath = [...segments.slice(0, -1), filename].join("/");
  assertInsideRoot(canonicalRoot, candidate);
  try {
    await fs.lstat(candidate);
    throw new FilePolicyError(FILE_ERROR_CODES.FILE_STORAGE_ERROR);
  } catch (error) {
    if (error instanceof FilePolicyError) throw error;
    if (error?.code !== "ENOENT") throw new FilePolicyError(FILE_ERROR_CODES.FILE_STORAGE_ERROR, { cause: error });
  }
  return Object.freeze({ path: candidate, relativePath: safeRelativePath });
}

export async function createTemporaryFilePath(tempRoot, { prefix = "file", extension = ".tmp" } = {}) {
  const safePrefix = sanitizeFilename(prefix, { fallback: "file", maxLength: 60 }).replace(/\.[^.]+$/, "");
  const safeExtension = /^\.[a-z0-9]{1,10}$/i.test(extension) ? extension.toLowerCase() : ".tmp";
  return resolveNewFile(tempRoot, `${safePrefix}-${crypto.randomUUID()}${safeExtension}`, {
    allowedExtensions: [safeExtension],
  });
}

export async function createTemporaryDirectory(tempRoot, { prefix = "job" } = {}) {
  const canonicalRoot = await realRoot(tempRoot);
  const safePrefix = sanitizeFilename(prefix, { fallback: "job", maxLength: 60 }).replace(/\.[^.]+$/, "");
  const target = path.join(canonicalRoot, `${safePrefix}-${crypto.randomUUID()}`);
  assertInsideRoot(canonicalRoot, target);
  await fs.mkdir(target, { recursive: false });
  return Object.freeze({ path: target, name: path.basename(target) });
}

export async function atomicMoveFile({ sourceRoot, sourcePath, destinationRoot, destinationRelativePath }) {
  const sourceRootReal = await realRoot(sourceRoot);
  const sourceCandidate = path.resolve(sourcePath);
  assertInsideRoot(sourceRootReal, sourceCandidate);
  const sourceLinkStat = await fs.lstat(sourceCandidate).catch((error) => {
    throw new FilePolicyError(FILE_ERROR_CODES.TEMP_FILE_ERROR, { cause: error });
  });
  if (sourceLinkStat.isSymbolicLink() || !sourceLinkStat.isFile()) {
    throw new FilePolicyError(FILE_ERROR_CODES.TEMP_FILE_ERROR);
  }
  const sourceReal = await fs.realpath(sourcePath).catch((error) => {
    throw new FilePolicyError(FILE_ERROR_CODES.TEMP_FILE_ERROR, { cause: error });
  });
  assertInsideRoot(sourceRootReal, sourceReal);
  const sourceStat = await fs.lstat(sourceReal);
  if (sourceStat.isSymbolicLink() || !sourceStat.isFile() || sourceStat.size <= 0) {
    throw new FilePolicyError(FILE_ERROR_CODES.TEMP_FILE_ERROR);
  }
  const destination = await resolveNewFile(destinationRoot, destinationRelativePath, { allowedExtensions: [".xlsx"] });
  try {
    await fs.rename(sourceReal, destination.path);
  } catch (error) {
    throw new FilePolicyError(FILE_ERROR_CODES.FILE_STORAGE_ERROR, { cause: error });
  }
  return Object.freeze({ ...destination, stat: sourceStat });
}

export async function atomicMoveDirectory({ sourceRoot, sourcePath, destinationRoot, destinationRelativePath }) {
  const sourceRootReal = await realRoot(sourceRoot);
  const sourceCandidate = path.resolve(sourcePath);
  assertInsideRoot(sourceRootReal, sourceCandidate);
  const sourceStat = await fs.lstat(sourceCandidate).catch((error) => {
    throw new FilePolicyError(FILE_ERROR_CODES.TEMP_FILE_ERROR, { cause: error });
  });
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
    throw new FilePolicyError(FILE_ERROR_CODES.TEMP_FILE_ERROR);
  }
  const sourceReal = await fs.realpath(sourceCandidate);
  assertInsideRoot(sourceRootReal, sourceReal);

  const destinationRootReal = await realRoot(destinationRoot);
  const normalizedRelative = normalizeStoredRelativePath(destinationRelativePath);
  const destinationSegments = normalizedRelative.split("/");
  const destinationName = assertAllowedFileName(destinationSegments.at(-1), null);
  const destinationParent = await ensureSafeSubdirectory(destinationRootReal, destinationSegments.slice(0, -1));
  const destination = path.join(destinationParent, destinationName);
  assertInsideRoot(destinationRootReal, destination);
  try {
    await fs.lstat(destination);
    throw new FilePolicyError(FILE_ERROR_CODES.FILE_STORAGE_ERROR);
  } catch (error) {
    if (error instanceof FilePolicyError) throw error;
    if (error?.code !== "ENOENT") throw new FilePolicyError(FILE_ERROR_CODES.FILE_STORAGE_ERROR, { cause: error });
  }
  try {
    await fs.rename(sourceReal, destination);
  } catch (error) {
    throw new FilePolicyError(FILE_ERROR_CODES.FILE_STORAGE_ERROR, { cause: error });
  }
  return Object.freeze({ path: destination, relativePath: normalizedRelative });
}

export async function removeFileInsideRoot(root, filePath) {
  try {
    const rootReal = await realRoot(root);
    const candidate = path.resolve(filePath);
    assertInsideRoot(rootReal, candidate);
    const linkStat = await fs.lstat(candidate);
    if (linkStat.isSymbolicLink() || !linkStat.isFile()) return false;
    const targetReal = await fs.realpath(candidate);
    assertInsideRoot(rootReal, targetReal);
    await fs.unlink(targetReal);
    return true;
  } catch (error) {
    if (error instanceof FilePolicyError || error?.code === "ENOENT") return false;
    return false;
  }
}

async function removeTreeWithoutFollowingLinks(target) {
  const stat = await fs.lstat(target);
  if (stat.isSymbolicLink() || stat.isFile()) {
    await fs.unlink(target);
    return;
  }
  if (!stat.isDirectory()) return;
  for (const entry of await fs.readdir(target)) await removeTreeWithoutFollowingLinks(path.join(target, entry));
  await fs.rmdir(target);
}

export async function removeEntryInsideRoot(root, targetPath) {
  try {
    const canonicalRoot = await realRoot(root);
    const candidate = path.resolve(targetPath);
    assertInsideRoot(canonicalRoot, candidate);
    await fs.lstat(candidate);
    await removeTreeWithoutFollowingLinks(candidate);
    return true;
  } catch (error) {
    if (error instanceof FilePolicyError || error?.code === "ENOENT") return false;
    return false;
  }
}

export async function cleanupTemporaryFiles(tempRoot, { retentionHours = DEFAULT_TEMP_RETENTION_HOURS, now = new Date() } = {}) {
  const canonicalRoot = await realRoot(tempRoot);
  const cutoff = now.getTime() - retentionHours * 60 * 60 * 1000;
  let removed = 0;
  let errors = 0;
  for (const entry of await fs.readdir(canonicalRoot, { withFileTypes: true })) {
    const target = path.join(canonicalRoot, entry.name);
    try {
      assertInsideRoot(canonicalRoot, target);
      const stat = await fs.lstat(target);
      if (stat.mtimeMs > cutoff) continue;
      await removeTreeWithoutFollowingLinks(target);
      removed += 1;
    } catch {
      errors += 1;
    }
  }
  return Object.freeze({ removed, errors });
}

export function safeContentDisposition(filename) {
  const safeName = sanitizeFilename(filename, { fallback: "download.xlsx" });
  const asciiFallback = safeName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(safeName)}`;
}

export function hashFileBuffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export function validateDownloadMetadata(file) {
  if (!file || file.status !== "available") throw new FilePolicyError(FILE_ERROR_CODES.FILE_NOT_FOUND);
  validateFileId(file.id);
  const originalFilename = assertAllowedFileName(file.originalFilename, [".xlsx"]);
  const storageFilename = assertAllowedFileName(file.storageFilename, [".xlsx"]);
  const relativePath = normalizeStoredRelativePath(file.relativePath);
  if (path.basename(relativePath) !== storageFilename) throw new FilePolicyError(FILE_ERROR_CODES.FILE_PATH_INVALID);
  return Object.freeze({ ...file, originalFilename, storageFilename, relativePath });
}

function findEndOfCentralDirectory(buffer) {
  const minimum = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

function safeZipEntryName(value) {
  if (!value || value.indexOf("\0") >= 0 || value.indexOf("\\") >= 0 || value.length > 512) {
    throw new FilePolicyError(FILE_ERROR_CODES.WORKBOOK_INVALID);
  }
  if (value.startsWith("/") || /^[a-z]:/i.test(value)) throw new FilePolicyError(FILE_ERROR_CODES.WORKBOOK_INVALID);
  const parts = value.split("/");
  if (parts.some((part) => part === "." || part === "..")) throw new FilePolicyError(FILE_ERROR_CODES.WORKBOOK_INVALID);
  return value;
}

function parseZipEntries(buffer, limits) {
  if (buffer.length < 22 || buffer.readUInt32LE(0) !== 0x04034b50) {
    throw new FilePolicyError(FILE_ERROR_CODES.FILE_SIGNATURE_INVALID);
  }
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) throw new FilePolicyError(FILE_ERROR_CODES.WORKBOOK_INVALID);
  const disk = buffer.readUInt16LE(eocd + 4);
  const centralDisk = buffer.readUInt16LE(eocd + 6);
  const diskEntries = buffer.readUInt16LE(eocd + 8);
  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (disk || centralDisk || diskEntries !== totalEntries || !totalEntries) {
    throw new FilePolicyError(FILE_ERROR_CODES.WORKBOOK_INVALID);
  }
  if (totalEntries > limits.maxEntries) throw new FilePolicyError(FILE_ERROR_CODES.WORKBOOK_LIMIT_EXCEEDED);
  if (centralOffset + centralSize > eocd || centralOffset + centralSize > buffer.length) {
    throw new FilePolicyError(FILE_ERROR_CODES.WORKBOOK_INVALID);
  }

  const entries = new Map();
  let offset = centralOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new FilePolicyError(FILE_ERROR_CODES.WORKBOOK_INVALID);
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength;
    if (nextOffset > buffer.length || [compressedSize, uncompressedSize, localOffset].some((value) => value === 0xffffffff)) {
      throw new FilePolicyError(FILE_ERROR_CODES.WORKBOOK_INVALID);
    }
    if (flags & 0x1 || (method !== 0 && method !== 8)) throw new FilePolicyError(FILE_ERROR_CODES.WORKBOOK_INVALID);
    const name = safeZipEntryName(buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8"));
    if (entries.has(name)) throw new FilePolicyError(FILE_ERROR_CODES.WORKBOOK_INVALID);
    totalUncompressed += uncompressedSize;
    const ratio = compressedSize === 0 ? (uncompressedSize ? Number.POSITIVE_INFINITY : 1) : uncompressedSize / compressedSize;
    if (uncompressedSize > limits.maxEntryBytes || totalUncompressed > limits.maxUncompressedBytes || ratio > limits.maxCompressionRatio) {
      throw new FilePolicyError(FILE_ERROR_CODES.WORKBOOK_LIMIT_EXCEEDED);
    }
    entries.set(name, { name, flags, method, compressedSize, uncompressedSize, localOffset });
    offset = nextOffset;
  }
  if (offset !== centralOffset + centralSize) throw new FilePolicyError(FILE_ERROR_CODES.WORKBOOK_INVALID);
  return entries;
}

function readZipEntry(buffer, entry, maxOutputLength) {
  const offset = entry.localOffset;
  if (offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== 0x04034b50) {
    throw new FilePolicyError(FILE_ERROR_CODES.WORKBOOK_INVALID);
  }
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const start = offset + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > buffer.length) throw new FilePolicyError(FILE_ERROR_CODES.WORKBOOK_INVALID);
  const compressed = buffer.subarray(start, end);
  try {
    const output = entry.method === 0
      ? Buffer.from(compressed)
      : inflateRawSync(compressed, { maxOutputLength });
    if (output.length !== entry.uncompressedSize || output.length > maxOutputLength) {
      throw new FilePolicyError(FILE_ERROR_CODES.WORKBOOK_LIMIT_EXCEEDED);
    }
    return output;
  } catch (error) {
    if (error instanceof FilePolicyError) throw error;
    throw new FilePolicyError(FILE_ERROR_CODES.WORKBOOK_INVALID, { cause: error });
  }
}

function columnNumber(letters) {
  return String(letters || "").toUpperCase().split("").reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0);
}

function validateWorksheetDimensions(xml, limits) {
  let maxRow = 0;
  let maxColumn = 0;
  const dimension = xml.match(/<dimension\b[^>]*\bref="\$?([A-Z]+)\$?(\d+)(?::\$?([A-Z]+)\$?(\d+))?"/i);
  if (dimension) {
    maxColumn = Math.max(columnNumber(dimension[1]), columnNumber(dimension[3] || dimension[1]));
    maxRow = Math.max(Number(dimension[2]), Number(dimension[4] || dimension[2]));
  }
  let rowCount = 0;
  for (const match of xml.matchAll(/<row\b[^>]*?(?:\br="(\d+)")?[^>]*>/gi)) {
    rowCount += 1;
    if (match[1]) maxRow = Math.max(maxRow, Number(match[1]));
    if (rowCount > limits.maxRows) throw new FilePolicyError(FILE_ERROR_CODES.WORKBOOK_LIMIT_EXCEEDED);
  }
  for (const match of xml.matchAll(/<c\b[^>]*\br="([A-Z]+)(\d+)"/gi)) {
    maxColumn = Math.max(maxColumn, columnNumber(match[1]));
    maxRow = Math.max(maxRow, Number(match[2]));
    if (maxColumn > limits.maxColumns || maxRow > limits.maxRows) {
      throw new FilePolicyError(FILE_ERROR_CODES.WORKBOOK_LIMIT_EXCEEDED);
    }
  }
  if (maxColumn > limits.maxColumns || maxRow > limits.maxRows) {
    throw new FilePolicyError(FILE_ERROR_CODES.WORKBOOK_LIMIT_EXCEEDED);
  }
}

export function inspectXlsxBuffer(buffer, limits) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new FilePolicyError(FILE_ERROR_CODES.FILE_SIGNATURE_INVALID);
  const entries = parseZipEntries(buffer, limits);
  for (const required of ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml"]) {
    if (!entries.has(required)) throw new FilePolicyError(FILE_ERROR_CODES.WORKBOOK_INVALID);
  }
  for (const name of entries.keys()) {
    const lower = name.toLowerCase();
    if (lower.endsWith("vbaproject.bin") || lower.startsWith("xl/activex/") || lower.startsWith("xl/embeddings/")) {
      throw new FilePolicyError(FILE_ERROR_CODES.FILE_TYPE_NOT_ALLOWED);
    }
  }
  const contentTypes = readZipEntry(buffer, entries.get("[Content_Types].xml"), limits.maxEntryBytes).toString("utf8");
  if (/macroEnabled|vbaProject|activeX|oleObject/i.test(contentTypes)) {
    throw new FilePolicyError(FILE_ERROR_CODES.FILE_TYPE_NOT_ALLOWED);
  }
  const worksheets = [...entries.values()].filter((entry) => /^xl\/worksheets\/[^/]+\.xml$/i.test(entry.name));
  if (!worksheets.length) throw new FilePolicyError(FILE_ERROR_CODES.WORKBOOK_INVALID);
  if (worksheets.length > limits.maxSheets) throw new FilePolicyError(FILE_ERROR_CODES.WORKBOOK_LIMIT_EXCEEDED);
  for (const worksheet of worksheets) {
    const xml = readZipEntry(buffer, worksheet, limits.maxEntryBytes).toString("utf8");
    validateWorksheetDimensions(xml, limits);
  }
  return Object.freeze({ entries: entries.size, sheets: worksheets.length });
}

export function validateXlsxUpload({ filename, mimeType, buffer, config }) {
  const safeName = sanitizeFilename(filename, { fallback: "upload.xlsx" });
  if (path.extname(safeName).toLowerCase() !== ".xlsx") {
    throw new FilePolicyError(FILE_ERROR_CODES.FILE_TYPE_NOT_ALLOWED);
  }
  if (!XLSX_UPLOAD_MIMES.has(String(mimeType || "").split(";", 1)[0].trim().toLowerCase())) {
    throw new FilePolicyError(FILE_ERROR_CODES.FILE_MIME_INVALID);
  }
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new FilePolicyError(FILE_ERROR_CODES.FILE_SIGNATURE_INVALID);
  if (buffer.length > config.maxUploadBytes) throw new FilePolicyError(FILE_ERROR_CODES.FILE_TOO_LARGE);
  const workbook = inspectXlsxBuffer(buffer, config.workbookLimits);
  return Object.freeze({
    originalFilename: safeName,
    storageFilename: `${crypto.randomUUID()}.xlsx`,
    mimeType: XLSX_MIME,
    fileSize: buffer.length,
    fileHash: hashFileBuffer(buffer),
    workbook,
  });
}

export function publicFileError(error, fallbackCode = FILE_ERROR_CODES.FILE_STORAGE_ERROR) {
  return error instanceof FilePolicyError ? error : new FilePolicyError(fallbackCode, { cause: error });
}
