import crypto, { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeStoredRelativePath } from "../security/file-policy.mjs";
import { retentionMsFor } from "./file-lifecycle-policy.mjs";

const EXCLUDED_DIRECTORIES = new Set([
  ".git", ".svn", "node_modules", "__pycache__", ".venv", "venv", "backups",
  "commerceops-backups", "chrome", "chrome-data", "chrome-user-data", "user data",
]);
const INTERNAL_FILE_PATTERN = /^(?:commerce-ops\.sqlite(?:-(?:wal|shm))?|\.ad-service-internal-token|\.env(?:\..*)?|.*\.log)$/i;

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function timestamp(stat) {
  const created = stat.birthtimeMs > 0 ? stat.birthtime : stat.ctime;
  return { createdAt: created.toISOString(), modifiedAt: stat.mtime.toISOString() };
}

export function maskLifecycleFilename(filename) {
  const name = path.basename(String(filename || "file"));
  const extension = path.extname(name).slice(0, 12);
  const stem = path.basename(name, extension);
  if (stem.length <= 4) return `${stem.slice(0, 1)}***${extension}`;
  return `${stem.slice(0, 3)}***${stem.slice(-2)}${extension}`.slice(0, 100);
}

export async function hashFileStream(filePath, { deadline = Number.POSITIVE_INFINITY } = {}) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(filePath, { highWaterMark: 1024 * 1024 })) {
    if (Date.now() >= deadline) throw Object.assign(new Error("Lifecycle scan timed out"), { code: "SCAN_TIMEOUT" });
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function hasXlsxSignature(filePath) {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(4);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return bytesRead === 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
  } finally {
    await handle.close();
  }
}

export function buildLifecycleRoots({ fileStorageConfig, adAnalyzerDir, env = process.env }) {
  const adStorage = path.resolve(adAnalyzerDir, env.AD_LIFECYCLE_STORAGE_ROOT || "storage");
  const adUpload = path.resolve(adAnalyzerDir, env.AD_LIFECYCLE_UPLOAD_ROOT || path.join(adStorage, "uploads"));
  const adTemp = path.resolve(adAnalyzerDir, env.AD_LIFECYCLE_TEMP_ROOT || path.join(adStorage, "temp"));
  const adOutput = path.resolve(adAnalyzerDir, env.AD_LIFECYCLE_OUTPUT_ROOT || path.join("..", "outputs"));
  return Object.freeze([
    { scope: "main_export", root: fileStorageConfig.exportRoot },
    { scope: "main_upload", root: fileStorageConfig.uploadRoot },
    { scope: "main_temp", root: fileStorageConfig.tempRoot },
    { scope: "ad_upload", root: adUpload },
    { scope: "ad_temp", root: adTemp },
    { scope: "ad_output", root: adOutput },
    { scope: "main_storage", root: fileStorageConfig.storageRoot },
    { scope: "ad_storage", root: adStorage },
  ]);
}

function baseItem({ classification, scope, name, stat = null, reasonCode, physicalStatus = "present", errorCode = null }) {
  const times = stat ? timestamp(stat) : { createdAt: null, modifiedAt: null };
  return {
    id: randomUUID(), classification, categories: [classification], scope,
    sourceType: null, fileId: null, taskId: null, runId: null,
    maskedFilename: maskLifecycleFilename(name), fileSize: Number(stat?.size || 0),
    fileCreatedAt: times.createdAt, fileModifiedAt: times.modifiedAt,
    databaseStatus: null, physicalStatus,
    suggestQuarantine: ["metadata_missing", "path_invalid", "size_mismatch", "hash_mismatch", "legacy_untracked_export", "unknown_file"].includes(classification),
    suggestCleanup: ["temp_stale", "expired_candidate"].includes(classification),
    reasonCode, shortHash: null, errorCode,
  };
}

function addCategory(item, category) {
  if (!item.categories.includes(category)) item.categories.push(category);
  if (category === "expired_candidate" || category === "temp_stale") item.suggestCleanup = true;
  if (["duplicate_content", "legacy_untracked_export"].includes(category)) item.suggestQuarantine = true;
}

function isRecent(stat, now, policy) {
  return now.getTime() - stat.mtimeMs < policy.recentMs;
}

function isExpired(stat, descriptor, now, policy) {
  const retention = retentionMsFor(descriptor, policy);
  return retention != null && now.getTime() - stat.mtimeMs >= retention;
}

function physicalSource(scope, relativePath) {
  if (scope === "ad_temp") return "advertising_temp";
  if (scope === "ad_output" || /(?:^|\/)output(?:\/|$)/i.test(relativePath)) return "advertising_output";
  if (scope === "ad_upload") return "advertising_source";
  if (scope === "main_temp") return "system_temp";
  return null;
}

async function collectPhysicalFiles(roots, { maxFiles, deadline }) {
  const files = [];
  const seen = new Set();
  const scopeErrors = [];
  let truncated = false;

  async function visit(rootReal, current, scope) {
    if (files.length >= maxFiles || Date.now() >= deadline) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      scopeErrors.push({ scope, code: "DIRECTORY_READ_FAILED" });
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles || Date.now() >= deadline) {
        truncated = true;
        return;
      }
      const candidate = path.join(current, entry.name);
      const relative = path.relative(rootReal, candidate).split(path.sep).join("/");
      if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name.toLowerCase())) continue;
      if (entry.isSymbolicLink()) {
        files.push({ scope, relativePath: relative, absolutePath: null, stat: null, pathError: "SYMLINK_REJECTED", name: entry.name });
        continue;
      }
      if (entry.isDirectory()) {
        await visit(rootReal, candidate, scope);
        continue;
      }
      if (!entry.isFile() || INTERNAL_FILE_PATTERN.test(entry.name)) continue;
      try {
        const normalized = normalizeStoredRelativePath(relative);
        const stat = await fs.lstat(candidate);
        const real = await fs.realpath(candidate);
        if (!inside(rootReal, real) || !stat.isFile()) throw new Error("PATH_OUTSIDE_ROOT");
        const key = real.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        files.push({ scope, relativePath: normalized, absolutePath: real, stat, pathError: null, name: entry.name });
      } catch (error) {
        files.push({ scope, relativePath: relative, absolutePath: null, stat: null, pathError: error?.code || "PATH_INVALID", name: entry.name });
      }
    }
  }

  for (const descriptor of roots) {
    if (files.length >= maxFiles || Date.now() >= deadline) {
      truncated = true;
      break;
    }
    let rootReal;
    try {
      rootReal = await fs.realpath(descriptor.root);
      const stat = await fs.lstat(rootReal);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("ROOT_INVALID");
    } catch (error) {
      scopeErrors.push({ scope: descriptor.scope, code: error?.code === "ENOENT" ? "ROOT_NOT_FOUND" : "ROOT_INVALID" });
      continue;
    }
    await visit(rootReal, rootReal, descriptor.scope);
  }
  return { files, scopeErrors, truncated, deadline };
}

export class FileLifecycleScanner {
  constructor({ fileRepository, roots, policy, protectedFileIds = new Set(), now = () => new Date() }) {
    this.fileRepository = fileRepository;
    this.roots = roots;
    this.policy = policy;
    this.protectedFileIds = protectedFileIds;
    this.now = now;
  }

  async scan(scopes) {
    const startedAt = this.now();
    const selected = this.roots.filter((root) => scopes.includes(root.scope));
    const collected = await collectPhysicalFiles(selected, {
      maxFiles: this.policy.maxFiles,
      deadline: Date.now() + this.policy.timeoutMs,
    });
    const tracked = this.fileRepository.listAll();
    const trackedHashes = new Set(tracked.map((file) => String(file.fileHash || "").toLowerCase()).filter(Boolean));
    const trackedNames = new Set(tracked.flatMap((file) => [file.originalFilename, file.storageFilename])
      .map((name) => String(name || "").toLowerCase()).filter(Boolean));
    const physicalByExportPath = new Map(
      collected.files.filter((file) => file.scope === "main_export").map((file) => [file.relativePath, file]),
    );
    const matched = new Set();
    const items = [];
    let scanTruncated = collected.truncated;

    for (const record of tracked) {
      const logicalSourceType = record.metadata?.generatedBy === "lifecycle_scanner"
        ? "system_file_lifecycle_report"
        : record.sourceType;
      let normalized;
      try {
        normalized = normalizeStoredRelativePath(record.relativePath);
      } catch {
        items.push({ ...baseItem({ classification: "path_invalid", scope: "main_export", name: record.originalFilename, reasonCode: "DATABASE_PATH_INVALID", physicalStatus: "unknown", errorCode: "PATH_INVALID" }), fileId: record.id, sourceType: logicalSourceType, taskId: record.taskId, runId: record.runId, databaseStatus: record.status });
        continue;
      }
      const physical = physicalByExportPath.get(normalized);
      if (!physical) {
        items.push({ ...baseItem({ classification: "physical_missing", scope: "main_export", name: record.originalFilename, reasonCode: "DATABASE_RECORD_WITHOUT_FILE", physicalStatus: "missing" }), fileId: record.id, sourceType: logicalSourceType, taskId: record.taskId, runId: record.runId, databaseStatus: record.status, fileSize: record.fileSize });
        continue;
      }
      matched.add(physical);
      if (physical.pathError || !physical.stat || !physical.absolutePath) {
        items.push({ ...baseItem({ classification: "path_invalid", scope: "main_export", name: record.originalFilename, reasonCode: "PHYSICAL_PATH_INVALID", physicalStatus: "invalid", errorCode: physical.pathError }), fileId: record.id, sourceType: logicalSourceType, taskId: record.taskId, runId: record.runId, databaseStatus: record.status });
        continue;
      }
      let classification = "healthy";
      let reasonCode = "METADATA_AND_FILE_MATCH";
      if (isRecent(physical.stat, startedAt, this.policy)) {
        classification = "active_or_recent";
        reasonCode = "RECENT_FILE_SKIPPED";
      } else if (Number(record.fileSize) !== physical.stat.size) {
        classification = "size_mismatch";
        reasonCode = "FILE_SIZE_MISMATCH";
      }
      const item = {
        ...baseItem({ classification, scope: "main_export", name: record.originalFilename, stat: physical.stat, reasonCode }),
        fileId: record.id, sourceType: logicalSourceType, taskId: record.taskId, runId: record.runId, databaseStatus: record.status,
      };
      if (!["active_or_recent", "size_mismatch"].includes(classification)) {
        try {
          item._hash = await hashFileStream(physical.absolutePath, { deadline: collected.deadline });
          item.shortHash = item._hash.slice(0, 12);
          if (!record.fileHash || item._hash.toLowerCase() !== String(record.fileHash).toLowerCase()) {
            item.classification = "hash_mismatch";
            item.categories = ["hash_mismatch"];
            item.reasonCode = "FILE_HASH_MISMATCH";
            item.suggestQuarantine = true;
          }
        } catch (error) {
          if (error?.code === "SCAN_TIMEOUT") scanTruncated = true;
          item.classification = "path_invalid";
          item.categories = ["path_invalid"];
          item.reasonCode = "HASH_READ_FAILED";
          item.errorCode = "HASH_READ_FAILED";
          item.suggestQuarantine = true;
        }
      }
      if (item.classification === "healthy" && !this.protectedFileIds.has(record.id)
        && isExpired(physical.stat, { sourceType: logicalSourceType, scope: "main_export", relativePath: normalized }, startedAt, this.policy)) {
        addCategory(item, "expired_candidate");
      }
      items.push(item);
    }

    for (const physical of collected.files) {
      if (matched.has(physical)) continue;
      if (physical.pathError || !physical.stat || !physical.absolutePath) {
        items.push(baseItem({ classification: "path_invalid", scope: physical.scope, name: physical.name, reasonCode: "PHYSICAL_PATH_INVALID", physicalStatus: "invalid", errorCode: physical.pathError }));
        continue;
      }
      let classification = "unknown_file";
      let reasonCode = "UNRECOGNIZED_STORED_FILE";
      const sourceType = physicalSource(physical.scope, physical.relativePath);
      if (isRecent(physical.stat, startedAt, this.policy)) {
        classification = "active_or_recent";
        reasonCode = "RECENT_FILE_SKIPPED";
      } else if (["main_temp", "ad_temp"].includes(physical.scope)
        && isExpired(physical.stat, { scope: physical.scope, sourceType, relativePath: physical.relativePath }, startedAt, this.policy)) {
        classification = "temp_stale";
        reasonCode = "TEMP_RETENTION_REACHED";
      } else if (["main_export", "main_upload", "ad_upload", "ad_output"].includes(physical.scope)) {
        classification = "metadata_missing";
        reasonCode = "PHYSICAL_FILE_WITHOUT_METADATA";
      }
      const item = { ...baseItem({ classification, scope: physical.scope, name: physical.name, stat: physical.stat, reasonCode }), sourceType };
      try {
        item._hash = await hashFileStream(physical.absolutePath, { deadline: collected.deadline });
        item.shortHash = item._hash.slice(0, 12);
        if (physical.scope === "main_export" && physical.relativePath.startsWith("manual/")
          && physical.stat.mtime < this.policy.legacyCutoff && path.extname(physical.name).toLowerCase() === ".xlsx"
          && !trackedHashes.has(item._hash.toLowerCase()) && !trackedNames.has(physical.name.toLowerCase())
          && await hasXlsxSignature(physical.absolutePath)) {
          item.classification = "legacy_untracked_export";
          item.categories = ["legacy_untracked_export", "metadata_missing"];
          item.reasonCode = "PRE_D2B1_MANUAL_EXPORT_WITHOUT_METADATA";
          item.suggestQuarantine = true;
        }
      } catch (error) {
        if (error?.code === "SCAN_TIMEOUT") scanTruncated = true;
        item.classification = "path_invalid";
        item.categories = ["path_invalid"];
        item.reasonCode = "HASH_READ_FAILED";
        item.errorCode = "HASH_READ_FAILED";
      }
      if (!["active_or_recent", "temp_stale"].includes(item.classification)
        && isExpired(physical.stat, { scope: physical.scope, sourceType, relativePath: physical.relativePath }, startedAt, this.policy)) {
        addCategory(item, "expired_candidate");
      }
      items.push(item);
    }

    const duplicates = new Map();
    for (const item of items) {
      if (!item._hash) continue;
      const group = duplicates.get(item._hash) || [];
      group.push(item);
      duplicates.set(item._hash, group);
    }
    for (const group of duplicates.values()) {
      if (group.length > 1) for (const item of group) addCategory(item, "duplicate_content");
    }

    const summary = Object.fromEntries([
      "healthy", "metadata_missing", "physical_missing", "size_mismatch", "hash_mismatch", "path_invalid",
      "temp_stale", "expired_candidate", "unknown_file", "duplicate_content", "legacy_untracked_export", "active_or_recent",
    ].map((category) => [category, items.filter((item) => item.categories.includes(category)).length]));
    const totalBytes = collected.files.reduce((total, file) => total + Number(file.stat?.size || 0), 0);
    for (const item of items) delete item._hash;
    return {
      items,
      summary,
      totalFiles: items.length,
      totalBytes,
      truncated: scanTruncated,
      scopeErrors: collected.scopeErrors,
      startedAt: startedAt.toISOString(),
      finishedAt: this.now().toISOString(),
    };
  }
}
