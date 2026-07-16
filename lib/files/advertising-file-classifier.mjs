import fs from "node:fs/promises";
import path from "node:path";
import { normalizeStoredRelativePath } from "../security/file-policy.mjs";
import { hashFileStream, maskLifecycleFilename } from "./file-lifecycle-scanner.mjs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JOB_OUTPUT_FILES = new Set(["analysis_data.json", "client_result.json", "chat_history.json"]);
const FORMAL_TYPES = new Set(["advertising_source", "advertising_output", "advertising_report"]);

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function mimeFor(extension) {
  return ({
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".json": "application/json",
    ".ndjson": "application/x-ndjson",
    ".png": "image/png",
  })[extension] || "application/octet-stream";
}

async function readPrefix(filePath, length = 64) {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export async function inspectManagedFileSignature(filePath, extension) {
  const prefix = await readPrefix(filePath);
  if (extension === ".xlsx" && prefix.length >= 4 && prefix[0] === 0x50 && prefix[1] === 0x4b) return "xlsx_zip";
  if (extension === ".png" && prefix.length >= 8 && prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
  if ([".json", ".ndjson"].includes(extension)) {
    const first = prefix.find((byte) => byte > 0x20);
    if (first === 0x7b || first === 0x5b) return "json_text";
  }
  return "unknown";
}

async function safeWalk(root) {
  let rootReal;
  try {
    rootReal = await fs.realpath(root);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const rootStat = await fs.lstat(rootReal);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw Object.assign(new Error("Managed root is invalid"), { code: "MANAGED_ROOT_INVALID" });
  const output = [];
  async function visit(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await visit(candidate);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await fs.lstat(candidate);
      const real = await fs.realpath(candidate);
      if (!stat.isFile() || stat.isSymbolicLink() || !inside(rootReal, real)) continue;
      output.push({
        absolutePath: real,
        relativePath: normalizeStoredRelativePath(path.relative(rootReal, real).split(path.sep).join("/")),
        stat,
      });
    }
  }
  await visit(rootReal);
  return output;
}

function trustedMetadata(value, expectedId) {
  if (!value || value.id !== expectedId || !UUID_PATTERN.test(expectedId)) return null;
  if (typeof value.storageFilename !== "string" || typeof value.fileHash !== "string" || !/^[a-f0-9]{64}$/i.test(value.fileHash)) return null;
  if (!Number.isSafeInteger(Number(value.fileSize)) || Number(value.fileSize) < 1) return null;
  return Object.freeze({
    id: expectedId,
    storageFilename: path.basename(value.storageFilename),
    mimeType: typeof value.mimeType === "string" ? value.mimeType.slice(0, 120) : "",
    fileSize: Number(value.fileSize),
    fileHash: value.fileHash.toLowerCase(),
    createdAt: typeof value.createdAt === "string" ? value.createdAt : null,
    status: value.status === "available" ? "available" : null,
  });
}

async function loadJobMetadata(root, jobId) {
  const relative = normalizeStoredRelativePath(`advertising/${jobId}/file_metadata.json`);
  const rootReal = await fs.realpath(root);
  const target = path.resolve(rootReal, relative);
  if (!inside(rootReal, target)) return null;
  try {
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) return null;
    const real = await fs.realpath(target);
    if (!inside(rootReal, real)) return null;
    return trustedMetadata(JSON.parse(await fs.readFile(real, "utf8")), jobId);
  } catch {
    return null;
  }
}

function classifyDescriptor({ scope, relativePath, extension, signature, hash, stat, metadata }) {
  const parts = relativePath.split("/");
  const basename = parts.at(-1);
  let detectedFileType = "advertising_unknown";
  let reasonCode = "ADVERTISING_FILE_NOT_RELIABLY_IDENTIFIED";
  let jobId = null;
  let protectRecommended = false;

  if (scope === "ad_temp") {
    detectedFileType = "advertising_temp";
    reasonCode = "CONTROLLED_ADVERTISING_TEMP_FILE";
  } else if (scope === "ad_upload" && parts[0] === "advertising" && UUID_PATTERN.test(parts[1] || "")) {
    jobId = parts[1];
    if (parts.length === 3 && basename === "file_metadata.json" && metadata) {
      protectRecommended = true;
      reasonCode = "TRUSTED_JOB_CONTROL_METADATA";
    } else if (parts.length === 4 && parts[2] === "source" && metadata
      && basename === metadata.storageFilename && extension === ".xlsx" && signature === "xlsx_zip"
      && Number(stat.size) === metadata.fileSize && hash === metadata.fileHash) {
      detectedFileType = "advertising_source";
      reasonCode = "TRUSTED_JOB_SOURCE_METADATA_MATCH";
    } else if (parts.length === 4 && parts[2] === "output" && metadata
      && JOB_OUTPUT_FILES.has(basename) && extension === ".json" && signature === "json_text") {
      detectedFileType = "advertising_output";
      reasonCode = "TRUSTED_JOB_OUTPUT_RELATION";
    }
  } else if (scope === "ad_output" && basename === "analysis_data.json"
    && extension === ".json" && signature === "json_text") {
    detectedFileType = "advertising_output";
    reasonCode = "KNOWN_ANALYZER_OUTPUT_SIGNATURE";
    if (UUID_PATTERN.test(parts.at(-2) || "")) jobId = parts.at(-2);
  }
  return { detectedFileType, reasonCode, jobId, protectRecommended };
}

function itemKey({ scope, fileSize, shortHash, maskedFilename, fileModifiedAt }) {
  return [scope, Number(fileSize), String(shortHash || "").toLowerCase(), maskedFilename, new Date(fileModifiedAt).getTime()].join("|");
}

export function isFormalAdvertisingType(value) {
  return FORMAL_TYPES.has(value);
}

export async function classifyAdvertisingScanItems({ scanItems, roots }) {
  const selectedRoots = roots.filter((entry) => ["ad_upload", "ad_output", "ad_temp"].includes(entry.scope));
  const physical = [];
  for (const descriptor of selectedRoots) {
    const files = await safeWalk(descriptor.root);
    for (const file of files) {
      const extension = path.extname(file.relativePath).toLowerCase();
      const hash = await hashFileStream(file.absolutePath);
      const parts = file.relativePath.split("/");
      const possibleJobId = descriptor.scope === "ad_upload" && parts[0] === "advertising" && UUID_PATTERN.test(parts[1] || "") ? parts[1] : null;
      const metadata = possibleJobId ? await loadJobMetadata(descriptor.root, possibleJobId) : null;
      const signature = await inspectManagedFileSignature(file.absolutePath, extension);
      const classified = classifyDescriptor({
        scope: descriptor.scope,
        relativePath: file.relativePath,
        extension,
        signature,
        hash,
        stat: file.stat,
        metadata,
      });
      physical.push({
        rootKey: descriptor.scope,
        relativePath: file.relativePath,
        maskedFilename: maskLifecycleFilename(path.basename(file.relativePath)),
        fileSize: Number(file.stat.size),
        fileHash: hash,
        shortHash: hash.slice(0, 12),
        fileCreatedAt: (file.stat.birthtimeMs > 0 ? file.stat.birthtime : file.stat.ctime).toISOString(),
        fileModifiedAt: file.stat.mtime.toISOString(),
        mimeType: mimeFor(extension),
        signatureCode: signature,
        ...classified,
      });
    }
  }
  const hashCounts = new Map();
  for (const file of physical) hashCounts.set(file.fileHash, (hashCounts.get(file.fileHash) || 0) + 1);
  const itemMap = new Map();
  for (const item of scanItems) {
    if (!["metadata_missing", "temp_stale", "expired_candidate", "unknown_file"].includes(item.classification)
      || !["ad_upload", "ad_output", "ad_temp"].includes(item.scope)) continue;
    const key = itemKey(item);
    const bucket = itemMap.get(key) || [];
    bucket.push(item);
    itemMap.set(key, bucket);
  }
  const evidence = [];
  for (const file of physical) {
    const key = itemKey({
      scope: file.rootKey,
      fileSize: file.fileSize,
      shortHash: file.shortHash,
      maskedFilename: file.maskedFilename,
      fileModifiedAt: file.fileModifiedAt,
    });
    const bucket = itemMap.get(key) || [];
    const item = bucket.shift();
    if (!item) continue;
    evidence.push({
      lifecycleItemId: item.id,
      scanId: item.scanId,
      duplicateContent: (hashCounts.get(file.fileHash) || 0) > 1,
      ...file,
    });
  }
  return Object.freeze({
    evidence,
    matchedCount: evidence.length,
    unmatchedItemCount: [...itemMap.values()].reduce((total, items) => total + items.length, 0),
  });
}

export async function snapshotControlledFiles(roots) {
  const records = [];
  for (const descriptor of roots.filter((entry) => ["ad_upload", "ad_output"].includes(entry.scope))) {
    for (const file of await safeWalk(descriptor.root)) {
      records.push({
        rootKey: descriptor.scope,
        relativePath: file.relativePath,
        fileSize: Number(file.stat.size),
        fileModifiedAt: file.stat.mtime.toISOString(),
        fileHash: await hashFileStream(file.absolutePath),
      });
    }
  }
  return records.sort((left, right) => `${left.rootKey}/${left.relativePath}`.localeCompare(`${right.rootKey}/${right.relativePath}`));
}
