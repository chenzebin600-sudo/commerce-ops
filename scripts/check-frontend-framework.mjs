import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const frontendDir = path.join(rootDir, "frontend");
const policy = JSON.parse(fs.readFileSync(path.join(frontendDir, "frontend-policy.json"), "utf8"));
const activeRoot = path.join(frontendDir, policy.activeWorkspace);
const activePackage = JSON.parse(fs.readFileSync(path.join(activeRoot, "package.json"), "utf8"));
const rootPackage = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
const dependencies = { ...activePackage.dependencies, ...activePackage.devDependencies };

for (const dependency of policy.requiredDependencies) {
  if (!dependencies[dependency]) throw new Error(`Active Vue workspace is missing ${dependency}.`);
}
for (const dependency of policy.forbiddenActiveDependencies) {
  if (dependencies[dependency]) throw new Error(`Active Vue workspace must not depend on ${dependency}.`);
}

const knownWorkspaces = new Set([policy.activeWorkspace, ...policy.legacyWorkspaces]);
for (const entry of fs.readdirSync(frontendDir, { withFileTypes: true })) {
  if (!entry.isDirectory() || !fs.existsSync(path.join(frontendDir, entry.name, "package.json"))) continue;
  if (!knownWorkspaces.has(entry.name)) {
    throw new Error(`Unknown frontend workspace ${entry.name}. New modules belong in ${policy.moduleDirectory}.`);
  }
}

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(fullPath) : [fullPath];
  });
}

const activeSources = walk(path.join(activeRoot, "src"));
for (const filePath of activeSources) {
  const relativePath = path.relative(rootDir, filePath).replaceAll("\\", "/");
  if (/\.(jsx|tsx)$/.test(filePath)) throw new Error(`React source is not allowed in the active Vue workspace: ${relativePath}`);
  if (!/\.(vue|ts|css)$/.test(filePath)) continue;
  const source = fs.readFileSync(filePath, "utf8");
  if (/from\s+["']react(?:-dom)?["']|require\(["']react(?:-dom)?["']\)/.test(source)) {
    throw new Error(`React import is not allowed in the active Vue workspace: ${relativePath}`);
  }
}

const defaultBuild = String(rootPackage.scripts?.build || "");
if (!defaultBuild.includes("build:vue")) throw new Error("Default build must include build:vue.");
for (const legacyScript of ["build:growth-radar:v2", "build:sales-assortment", "build:mabang-listing"]) {
  if (defaultBuild.includes(legacyScript)) throw new Error(`Default build must not invoke legacy script ${legacyScript}.`);
}

console.log(`Frontend policy OK: ${policy.activeWorkspace} is the only active workspace; ${policy.legacyWorkspaces.length} legacy workspaces are frozen.`);
