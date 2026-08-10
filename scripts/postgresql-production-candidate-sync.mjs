import path from "node:path";
import { pathToFileURL } from "node:url";
import { runProductionCandidateSync } from "./postgresql-phase3d-cutover-rehearsal.mjs";

function safeError(error) {
  return {
    code: String(error?.code || "PRODUCTION_CANDIDATE_SYNC_FAILED").slice(0, 80),
    message: String(error?.message || error).split(/\r?\n/)[0].slice(0, 500),
  };
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (entry === import.meta.url) {
  runProductionCandidateSync(process.argv.slice(2)).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    const safe = safeError(error);
    process.stderr.write(`PostgreSQL production candidate synchronization failed [${safe.code}]: ${safe.message}\n`);
    process.exitCode = 1;
  });
}
