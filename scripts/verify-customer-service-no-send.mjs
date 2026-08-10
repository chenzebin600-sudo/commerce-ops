import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const edgeDir = path.join(rootDir, "integrations", "liaoliao-ai-assistant");
const pythonCandidates = process.platform === "win32"
  ? [path.join(edgeDir, ".venv", "Scripts", "python.exe")]
  : [path.join(edgeDir, ".venv", "bin", "python")];
const python = pythonCandidates.find((candidate) => fs.existsSync(candidate));
if (!python) throw new Error("LiaoLiao edge virtual environment is missing; create integrations/liaoliao-ai-assistant/.venv first");

function run(label, command, args, cwd = rootDir) {
  process.stdout.write(`\n[customer-service verify] ${label}\n`);
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status}`);
  }
}

const npmExecPath = process.env.npm_execpath;
if (!npmExecPath || !fs.existsSync(npmExecPath)) {
  throw new Error("npm CLI path is unavailable; run this verifier through npm run verify:customer-service:no-send");
}
run("Node control plane, knowledge link and Vue policy tests", process.execPath, [
  "--test",
  "tests/customer-service-control-plane.test.mjs",
  "tests/customer-service-deployment-readiness.test.mjs",
  "tests/customer-service-local-runtime.test.mjs",
  "tests/customer-service-ui-fixture.test.mjs",
  "tests/product-knowledge-context-link.test.mjs",
  "tests/commerce-ops-vue-workspace.test.mjs",
]);
run("Deterministic reply-quality replay without a model call", process.execPath, [
  "scripts/evaluate-customer-service-replies.mjs",
  "--dataset", "contracts/customer-service/cs-reply-evaluation-v1.example.jsonl",
]);
run("Python Playwright edge safety and fleet tests", python, [
  "-m", "pytest", "-q",
  "tests/test_command_contract.py",
  "tests/test_config.py",
  "tests/test_central_client.py",
  "tests/test_browser_session.py",
  "tests/test_reply_editor.py",
  "tests/test_fleet.py",
  "tests/test_assistant.py",
], edgeDir);
run("Multi-account manifest validation", python, [
  "-m", "app.cli", "fleet", "validate", "--manifest", "fleet.example.json",
], edgeDir);
run("Vue customer-service type safety", process.execPath, [
  npmExecPath, "--prefix", "frontend/commerce-ops-vue", "run", "check",
]);

process.stdout.write(`\n${JSON.stringify({
  ok: true,
  acceptance: "CUSTOMER_SERVICE_NO_SEND_OFFLINE",
  automaticSend: false,
  realBrowserUsed: false,
  realCustomerMessageSent: false,
}, null, 2)}\n`);
