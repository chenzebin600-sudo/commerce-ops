import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const buildDir = path.join(rootDir, "public", "vue-preview");
const textExtensions = new Set([".css", ".html", ".js", ".json", ".map"]);

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(fullPath) : [fullPath];
  });
}

if (!fs.existsSync(buildDir)) throw new Error("Vue build output does not exist.");
let normalized = 0;
for (const filePath of walk(buildDir)) {
  if (!textExtensions.has(path.extname(filePath))) continue;
  const source = fs.readFileSync(filePath, "utf8");
  const next = source.replace(/\r\r\n|\r\n|\r/g, "\n");
  if (next !== source) {
    fs.writeFileSync(filePath, next, "utf8");
    normalized += 1;
  }
}
console.log(`Normalized Vue build line endings in ${normalized} file(s).`);
