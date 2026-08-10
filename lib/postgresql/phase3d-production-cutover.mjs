import path from "node:path";
import { PHASE3D_PRODUCTION_CANDIDATE_DATABASE } from "./phase3d-production-candidate.mjs";

export const PHASE3D_PRODUCTION_CUTOVER_CONTRACT = "COMMERCE-OPS-PG-PHASE3D-PRODUCTION-CUTOVER-1.0.0";
export const PHASE3D_PRODUCTION_CUTOVER_CONFIRMATION = "FINAL_SQLITE_FREEZE_SYNC_AND_POSTGRES_SWITCH";
export const PHASE3D_PRODUCTION_FREEZE_CONFIRMATION = "STOP_SQLITE_MAIN_AND_SCHEDULER_WRITERS";
export const PHASE3D_PRODUCTION_ROLLBACK_LIMIT_CONFIRMATION = "NO_REVERSE_SYNC_AFTER_POSTGRES_WRITES";

const CONFIRM_DATABASE_PREFIX = "--confirm-database=";
const CONFIRM_CUTOVER_PREFIX = "--confirm-cutover=";
const CONFIRM_FREEZE_PREFIX = "--confirm-freeze=";
const CONFIRM_ROLLBACK_PREFIX = "--confirm-rollback-limit=";

function singleValue(values, prefix, label) {
  const matches = values.filter((value) => value.startsWith(prefix));
  if (matches.length > 1) throw new TypeError(`${label} may only be specified once`);
  return matches[0]?.slice(prefix.length) || null;
}

export function resolveProductionCutoverInvocation(argv, config) {
  const values = [...(argv || [])];
  const allowed = values.filter((value) => value === "--apply"
    || value.startsWith(CONFIRM_DATABASE_PREFIX)
    || value.startsWith(CONFIRM_CUTOVER_PREFIX)
    || value.startsWith(CONFIRM_FREEZE_PREFIX)
    || value.startsWith(CONFIRM_ROLLBACK_PREFIX));
  if (allowed.length !== values.length) {
    throw new TypeError(`Unknown production cutover arguments: ${values.filter((value) => !allowed.includes(value)).join(", ")}`);
  }
  if (new Set(values).size !== values.length) throw new TypeError("Production cutover arguments may only be specified once");
  if (config?.database !== PHASE3D_PRODUCTION_CANDIDATE_DATABASE) {
    throw Object.assign(new Error(`Production cutover requires configured database ${PHASE3D_PRODUCTION_CANDIDATE_DATABASE}`), { code: "PRODUCTION_CUTOVER_TARGET_REJECTED" });
  }

  const invocation = Object.freeze({
    apply: values.includes("--apply"),
    targetDatabase: config.database,
    confirmedDatabase: singleValue(values, CONFIRM_DATABASE_PREFIX, "Database confirmation"),
    confirmedCutover: singleValue(values, CONFIRM_CUTOVER_PREFIX, "Cutover confirmation"),
    confirmedFreeze: singleValue(values, CONFIRM_FREEZE_PREFIX, "Freeze confirmation"),
    confirmedRollbackLimit: singleValue(values, CONFIRM_ROLLBACK_PREFIX, "Rollback-limit confirmation"),
  });
  const confirmations = [
    invocation.confirmedDatabase,
    invocation.confirmedCutover,
    invocation.confirmedFreeze,
    invocation.confirmedRollbackLimit,
  ];
  if (!invocation.apply && confirmations.some(Boolean)) {
    throw new Error("Production cutover confirmations require --apply");
  }
  if (!invocation.apply) return invocation;
  if (invocation.confirmedDatabase !== PHASE3D_PRODUCTION_CANDIDATE_DATABASE) {
    throw Object.assign(new Error(`Production cutover requires --confirm-database=${PHASE3D_PRODUCTION_CANDIDATE_DATABASE}`), { code: "PRODUCTION_CUTOVER_CONFIRMATION_REQUIRED" });
  }
  if (invocation.confirmedCutover !== PHASE3D_PRODUCTION_CUTOVER_CONFIRMATION) {
    throw Object.assign(new Error(`Production cutover requires --confirm-cutover=${PHASE3D_PRODUCTION_CUTOVER_CONFIRMATION}`), { code: "PRODUCTION_CUTOVER_CONFIRMATION_REQUIRED" });
  }
  if (invocation.confirmedFreeze !== PHASE3D_PRODUCTION_FREEZE_CONFIRMATION) {
    throw Object.assign(new Error(`Production cutover requires --confirm-freeze=${PHASE3D_PRODUCTION_FREEZE_CONFIRMATION}`), { code: "PRODUCTION_CUTOVER_CONFIRMATION_REQUIRED" });
  }
  if (invocation.confirmedRollbackLimit !== PHASE3D_PRODUCTION_ROLLBACK_LIMIT_CONFIRMATION) {
    throw Object.assign(new Error(`Production cutover requires --confirm-rollback-limit=${PHASE3D_PRODUCTION_ROLLBACK_LIMIT_CONFIRMATION}`), { code: "PRODUCTION_CUTOVER_CONFIRMATION_REQUIRED" });
  }
  return invocation;
}

export function productionCutoverApplyCommand() {
  return [
    "node scripts/postgresql-production-cutover.mjs",
    "--apply",
    `--confirm-database=${PHASE3D_PRODUCTION_CANDIDATE_DATABASE}`,
    `--confirm-freeze=${PHASE3D_PRODUCTION_FREEZE_CONFIRMATION}`,
    `--confirm-cutover=${PHASE3D_PRODUCTION_CUTOVER_CONFIRMATION}`,
    `--confirm-rollback-limit=${PHASE3D_PRODUCTION_ROLLBACK_LIMIT_CONFIRMATION}`,
  ].join(" ");
}

function normalized(value) {
  return path.normalize(String(value || "")).toLocaleLowerCase("en-US");
}

export function classifyProductionProcesses(processes, rootDir) {
  const exactScripts = new Map([
    [normalized(path.join(rootDir, "server.mjs")), "main"],
    [normalized(path.join(rootDir, "scheduler.mjs")), "scheduler"],
  ]);
  const matched = [];
  for (const process of processes || []) {
    const commandLine = normalized(process.commandLine);
    const role = [...exactScripts].find(([script]) => commandLine.includes(script))?.[1] || null;
    if (!role) continue;
    matched.push(Object.freeze({
      pid: Number(process.pid),
      parentPid: Number(process.parentPid || 0),
      role,
      commandLine: String(process.commandLine || ""),
    }));
  }
  const childParentPids = new Set(matched.map((process) => process.parentPid).filter(Boolean));
  for (const process of processes || []) {
    if (!childParentPids.has(Number(process.pid))) continue;
    const commandLine = normalized(process.commandLine);
    if (!commandLine.includes(normalized(path.join("scripts", "start-all.mjs")))) continue;
    matched.push(Object.freeze({
      pid: Number(process.pid),
      parentPid: Number(process.parentPid || 0),
      role: "supervisor",
      commandLine: String(process.commandLine || ""),
    }));
  }
  return Object.freeze(matched.sort((left, right) => left.pid - right.pid));
}

export function resolveProductionWriterState(processes) {
  const main = (processes || []).filter((process) => process.role === "main");
  const scheduler = (processes || []).filter((process) => process.role === "scheduler");
  const state = main.length === 1 && scheduler.length === 1
    ? "RUNNING"
    : main.length === 0 && scheduler.length === 0
      ? "FROZEN"
      : "INCONSISTENT";
  return Object.freeze({ state, main, scheduler, safe: state !== "INCONSISTENT" });
}

export function applyProductionEnvironment(content) {
  const updates = new Map([
    ["DATABASE_PROVIDER", "postgres"],
    ["POSTGRES_SHADOW_MODE", "false"],
    ["POSTGRES_STAGING_MODE", "false"],
    ["POSTGRES_CUTOVER_REHEARSAL_MODE", "false"],
    ["POSTGRES_PRODUCTION_CANDIDATE_MODE", "false"],
    ["POSTGRES_PRODUCTION_MODE", "true"],
    ["POSTGRES_PRODUCTION_CONFIRM_DATABASE", PHASE3D_PRODUCTION_CANDIDATE_DATABASE],
    ["POSTGRES_PRODUCTION_CONFIRM_SCOPE", "FORMAL_CUTOVER"],
  ]);
  const seen = new Set();
  const lines = String(content || "").split(/\r?\n/).filter((line, index, all) => line !== "" || index < all.length - 1).map((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (!match || !updates.has(match[1])) return line;
    seen.add(match[1]);
    return `${match[1]}=${updates.get(match[1])}`;
  });
  for (const [key, value] of updates) if (!seen.has(key)) lines.push(`${key}=${value}`);
  return `${lines.join("\r\n")}\r\n`;
}
