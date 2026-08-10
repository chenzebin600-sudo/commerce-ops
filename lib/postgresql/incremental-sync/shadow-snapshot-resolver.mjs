import fs from "node:fs";
import path from "node:path";

const REPORT_PATTERN = /^COMMERCE-OPS-POSTGRESQL-INCREMENTAL-SYNC-.*\.json$/;

function workspacePath(rootDir, value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const relative = text.replace(/^<workspace>[\\/]?/, "");
  return path.resolve(relative === text ? text : path.join(rootDir, relative));
}

export function resolveShadowSqliteSnapshot({ rootDir, env = process.env } = {}) {
  const resolvedRoot = path.resolve(rootDir || process.cwd());
  const configured = String(env.POSTGRES_SHADOW_SQLITE_SNAPSHOT || "").trim();
  if (configured) return path.resolve(configured);

  const reportsDir = path.join(resolvedRoot, "docs", "reports");
  const candidates = [];
  if (fs.existsSync(reportsDir)) {
    for (const name of fs.readdirSync(reportsDir).filter((entry) => REPORT_PATTERN.test(entry))) {
      try {
        const report = JSON.parse(fs.readFileSync(path.join(reportsDir, name), "utf8"));
        if (report.status !== "PASS" || !report.snapshot?.path) continue;
        const snapshotPath = workspacePath(resolvedRoot, report.snapshot.path);
        if (!snapshotPath || !fs.existsSync(snapshotPath)) continue;
        candidates.push({
          path: snapshotPath,
          time: Date.parse(report.snapshot.time || "") || fs.statSync(snapshotPath).mtimeMs,
        });
      } catch {}
    }
  }
  candidates.sort((left, right) => right.time - left.time || right.path.localeCompare(left.path));
  if (candidates[0]) return candidates[0].path;
  return path.join(resolvedRoot, "tmp", "postgresql-shadow-phase1", "commerce-ops-shadow-source.sqlite");
}
