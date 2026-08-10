import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const pidPath = resolve(root, ".lazada-inventory-sync.execute.pid.json");
const stdoutPath = resolve(root, ".lazada-inventory-sync.execute.out.log");
const stderrPath = resolve(root, ".lazada-inventory-sync.execute.err.log");

if (existsSync(pidPath)) {
  try {
    const previous = JSON.parse(readFileSync(pidPath, "utf8"));
    if (Number.isInteger(previous.pid)) {
      process.kill(previous.pid, 0);
      console.error(`Lazada inventory sync is already running (PID ${previous.pid}).`);
      process.exit(2);
    }
  } catch {
    // A missing process means the pid file is stale and can be replaced.
  }
}

const stdout = openSync(stdoutPath, "w");
const stderr = openSync(stderrPath, "w");
const child = spawn(
  process.execPath,
  [
    resolve(root, "scripts/lazada-inventory-sync.mjs"),
    "--execute",
    "--confirm=CONFIRM_LAZADA_INVENTORY_SYNC",
  ],
  {
    cwd: root,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", stdout, stderr],
  },
);

closeSync(stdout);
closeSync(stderr);
child.unref();

writeFileSync(
  pidPath,
  `${JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString(), stdoutPath, stderrPath }, null, 2)}\n`,
  "utf8",
);

console.log(JSON.stringify({ pid: child.pid, stdoutPath, stderrPath }));
