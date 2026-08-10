import path from "node:path";
import { fileURLToPath } from "node:url";
import { runShadowIncrementalSync } from "../lib/postgresql/incremental-sync/shadow-sync-runtime.mjs";

function argument(name, fallback = null) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

async function main() {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const command = argument("command", "sync");
  if (!new Set(["sync", "validate", "status", "pause", "resume"]).has(command)) {
    throw new Error("--command must be sync, validate, status, pause, or resume");
  }
  const result = await runShadowIncrementalSync({
    rootDir,
    command,
    apply: process.argv.includes("--apply"),
    fullReconcile: process.argv.includes("--full-reconcile"),
    pauseReason: argument("reason", "paused by operator"),
    deleteMode: argument("delete-mode", "BLOCK"),
    deleteConfirmation: argument("confirm-delete-database"),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status === "FAIL") process.exitCode = 1;
}

main().catch((error) => {
  const code = String(error?.code || "POSTGRESQL_INCREMENTAL_SYNC_FAILED").slice(0, 80);
  const message = String(error?.message || error).split(/\r?\n/)[0].slice(0, 500);
  process.stderr.write(`PostgreSQL incremental sync failed [${code}]: ${message}\n`);
  process.exitCode = 1;
});
