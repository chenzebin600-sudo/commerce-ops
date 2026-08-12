import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSqliteMigrationSnapshot } from "../lib/postgresql/sqlite-migration.mjs";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.resolve(argument("--source") || path.join(projectRoot, "storage", "commerce-ops.sqlite"));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const destinationPath = path.resolve(argument("--destination") || path.join(projectRoot, "storage", "backups", `commerce-ops-pre-postgresql-${stamp}.sqlite`));

await fs.access(sourcePath);
await fs.mkdir(path.dirname(destinationPath), { recursive: true });
try { await fs.access(destinationPath); throw new Error("Snapshot destination already exists"); } catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const result = await createSqliteMigrationSnapshot({ sourcePath, destinationPath });
if (result.integrity !== "ok" || result.foreignKeyViolations !== 0 || !result.readOnly) {
  throw new Error("SQLite cutover snapshot validation failed");
}
process.stdout.write(`${JSON.stringify({ destinationPath, createdAt: new Date().toISOString(), ...result }, null, 2)}\n`);
