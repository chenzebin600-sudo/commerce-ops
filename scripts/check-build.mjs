import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
for (const file of ["public/app.js", "public/auth-client.mjs", "lib/app-access.mjs", "server.mjs", "scheduler.mjs"]) {
  const result = spawnSync(process.execPath, ["--check", file], { cwd: rootDir, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `${file} syntax check failed`);
}
const html = readFileSync(path.join(rootDir, "public", "index.html"), "utf8");
const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
if (duplicates.length) throw new Error(`Duplicate HTML ids: ${[...new Set(duplicates)].join(", ")}`);
const app = readFileSync(path.join(rootDir, "public", "app.js"), "utf8");
const referencedIds = [...new Set([...app.matchAll(/\$\("([^"]+)"\)/g)].map((match) => match[1]))];
const dynamicIds = new Set(["retryExtractBtn"]);
const missingIds = referencedIds.filter((id) => !ids.includes(id) && !dynamicIds.has(id));
if (missingIds.length) throw new Error(`JavaScript references missing HTML ids: ${missingIds.join(", ")}`);
console.log(`Frontend checks passed: ${ids.length} unique element ids, ${referencedIds.length} static bindings.`);
