import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const exceptions = JSON.parse(await fs.readFile(path.join(rootDir, "config", "portable-path-exceptions.json"), "utf8"));
const excluded = new Set([".git", ".venv", ".venv-mabang", "node_modules", "storage", "data", "backups", "ui-check", "dist", "build", "packaged-skills"]);
const extensions = new Set([".js", ".mjs", ".cjs", ".json", ".md", ".py", ".ps1", ".sh"]);
const patterns = [
  { name: "Windows drive path", regex: /(^|[^A-Za-z])(?:[A-Za-z]:[\\/])/m },
  { name: "private user directory", regex: /C:[\\/]Users[\\/]/i },
  { name: "legacy advertising directory", regex: /D:[\\/]codex[\\/]/i },
  { name: "legacy project name", regex: /New project2|Lazada-Sponsored Max analysis/i },
];
const violations = [];

async function visit(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && excluded.has(entry.name.toLowerCase())) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) await visit(fullPath);
    else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) {
      const relative = path.relative(rootDir, fullPath).split(path.sep).join("/");
      if (relative === "config/portable-path-exceptions.json" || relative === "scripts/check-portable-paths.mjs") continue;
      if (exceptions.some((item) => relative.startsWith(item.prefix))) continue;
      const text = await fs.readFile(fullPath, "utf8");
      for (const pattern of patterns) if (pattern.regex.test(text)) violations.push(`${relative}: ${pattern.name}`);
    }
  }
}

await visit(rootDir);
if (violations.length) {
  console.error(violations.join("\n"));
  process.exit(1);
}
console.log("Portable path check passed.");
