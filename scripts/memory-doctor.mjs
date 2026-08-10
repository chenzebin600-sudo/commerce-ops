import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REQUIRED_FILES = [
  "AGENTS.md",
  "memory/INDEX.md",
  "memory/PERMANENT.md",
  "memory/SOP.md",
  "memory/projects/commerce-ops.md",
];

const PERMANENT_WARN_LINES = 120;
const PERMANENT_WARN_BYTES = 12 * 1024;
const PERMANENT_ERROR_LINES = 180;
const PERMANENT_ERROR_BYTES = 18 * 1024;

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function listMarkdownFiles(directory) {
  if (!(await exists(directory))) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return listMarkdownFiles(fullPath);
      return entry.isFile() && entry.name.endsWith(".md") ? [fullPath] : [];
    }),
  );
  return nested.flat();
}

function parseUpdatedAt(content, fallbackMs) {
  const match = content.match(/^updated_at:\s*(.+?)\s*$/m);
  const parsed = match ? Date.parse(match[1]) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallbackMs;
}

function displayPath(root, filePath) {
  return path.relative(root, filePath).replaceAll(path.sep, "/");
}

export async function auditMemory(root = process.cwd()) {
  const errors = [];
  const warnings = [];
  const facts = new Map();
  const pointers = [];

  for (const required of REQUIRED_FILES) {
    if (!(await exists(path.join(root, required)))) {
      errors.push(`Missing required file: ${required}`);
    }
  }

  const memoryRoot = path.join(root, "memory");
  const markdownFiles = await listMarkdownFiles(memoryRoot);
  const documents = [];

  for (const filePath of markdownFiles) {
    const [content, fileStat] = await Promise.all([
      readFile(filePath, "utf8"),
      stat(filePath),
    ]);
    const relativePath = displayPath(root, filePath);
    const updatedAt = parseUpdatedAt(content, fileStat.mtimeMs);
    documents.push({ filePath, relativePath, content, updatedAt, fileStat });

    for (const match of content.matchAll(/<!--\s*fact-id:\s*([a-z0-9._:-]+)\s*-->/gi)) {
      const id = match[1].toLowerCase();
      const locations = facts.get(id) ?? [];
      locations.push({ relativePath, updatedAt, mtimeMs: fileStat.mtimeMs });
      facts.set(id, locations);
    }

    for (const match of content.matchAll(/<!--\s*memory-pointer:\s*([^\s]+)\s*-->/gi)) {
      pointers.push({ source: relativePath, target: match[1] });
    }
  }

  for (const [id, locations] of facts) {
    if (locations.length < 2) continue;
    const newest = [...locations].sort(
      (left, right) =>
        right.updatedAt - left.updatedAt || right.mtimeMs - left.mtimeMs,
    )[0];
    errors.push(
      `Duplicate fact-id ${id}: ${locations.map((item) => item.relativePath).join(", ")}. ` +
        `Temporary winner (newest file): ${newest.relativePath}`,
    );
  }

  for (const pointer of pointers) {
    if (!pointer.target.startsWith("memory/")) {
      errors.push(
        `Invalid memory pointer in ${pointer.source}: ${pointer.target} (must start with memory/)`,
      );
      continue;
    }
    const targetPath = path.resolve(root, pointer.target);
    const relativeTarget = path.relative(root, targetPath);
    if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) {
      errors.push(`Pointer escapes repository in ${pointer.source}: ${pointer.target}`);
      continue;
    }
    if (!(await exists(targetPath))) {
      errors.push(`Broken pointer in ${pointer.source}: ${pointer.target}`);
    }
  }

  const dailyDirectory = path.join(memoryRoot, "daily");
  for (const document of documents) {
    if (path.dirname(document.filePath) !== dailyDirectory) continue;
    const fileName = path.basename(document.filePath);
    if (fileName === "_template.md") continue;
    if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(fileName)) {
      errors.push(`Daily memory file must use YYYY-MM-DD.md: ${document.relativePath}`);
    }
  }

  const permanent = documents.find(
    (document) => document.relativePath === "memory/PERMANENT.md",
  );
  if (permanent) {
    const lineCount = permanent.content.split(/\r?\n/).length;
    const byteCount = Buffer.byteLength(permanent.content, "utf8");
    if (lineCount > PERMANENT_ERROR_LINES || byteCount > PERMANENT_ERROR_BYTES) {
      errors.push(
        `Permanent memory needs cleanup now: ${lineCount} lines, ${byteCount} bytes ` +
          `(limits ${PERMANENT_ERROR_LINES} lines / ${PERMANENT_ERROR_BYTES} bytes).`,
      );
    } else if (lineCount > PERMANENT_WARN_LINES || byteCount > PERMANENT_WARN_BYTES) {
      warnings.push(
        `Permanent memory is getting large: ${lineCount} lines, ${byteCount} bytes. ` +
          `Move detail to dated or on-demand files.`,
      );
    }
  }

  return {
    errors,
    warnings,
    counts: {
      files: markdownFiles.length,
      facts: facts.size,
      pointers: pointers.length,
    },
  };
}

async function main() {
  const result = await auditMemory(process.cwd());
  console.log(
    `Memory audit: ${result.counts.files} files, ${result.counts.facts} facts, ` +
      `${result.counts.pointers} pointers.`,
  );
  for (const warning of result.warnings) console.warn(`WARN: ${warning}`);
  for (const error of result.errors) console.error(`ERROR: ${error}`);
  if (result.errors.length === 0) {
    console.log("Memory system is healthy.");
  } else {
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  await main();
}

