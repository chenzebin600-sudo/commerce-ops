import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createSystemServiceDefinitions, loopbackProbeHost, nextRestartDelay } from "../lib/system-startup-policy.mjs";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("unified production startup owns main, scheduler and fulfillment without changing ports", () => {
  const definitions = createSystemServiceDefinitions({
    rootDir,
    appConfig: { host:"127.0.0.1", port:3101 },
    fulfillmentConfig: { host:"127.0.0.1", port:3112 },
  });
  assert.deepEqual(definitions.map((item) => item.name), ["main", "scheduler", "fulfillment"]);
  assert.equal(definitions[0].healthUrl, "http://127.0.0.1:3101/api/health");
  assert.equal(definitions[1].requiresOwned, "main");
  assert.equal(definitions[2].healthUrl, "http://127.0.0.1:3112/health");
  assert.ok(definitions[2].entry.endsWith(path.join("scripts", "fulfillment-supervisor.mjs")));
});

test("health probes use loopback when a service listens on all interfaces", () => {
  assert.equal(loopbackProbeHost("0.0.0.0"), "127.0.0.1");
  assert.equal(loopbackProbeHost("::"), "127.0.0.1");
  assert.equal(loopbackProbeHost("127.0.0.1"), "127.0.0.1");
});

test("unexpected exits use bounded backoff and stable services reset it", () => {
  assert.equal(nextRestartDelay({ previousDelay:2000, runtimeMs:100 }), 4000);
  assert.equal(nextRestartDelay({ previousDelay:60000, runtimeMs:100 }), 60000);
  assert.equal(nextRestartDelay({ previousDelay:60000, runtimeMs:60000 }), 2000);
});

test("package commands expose one-command development and production startup", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
  assert.match(pkg.scripts.dev, /start-dev\.mjs/);
  assert.match(pkg.scripts.start, /start:all/);
  assert.match(pkg.scripts["start:all"], /system-supervisor\.mjs/);
  assert.match(pkg.scripts["start:core"], /start-all\.mjs/);
});

test("development startup watches both HTTP services and rejects duplicate ports", () => {
  const source = fs.readFileSync(path.join(rootDir, "scripts", "start-dev.mjs"), "utf8");
  assert.match(source, /server\.mjs/);
  assert.match(source, /fulfillment-service/);
  assert.match(source, /--watch/);
  assert.match(source, /services are already running/);
  assert.match(source, /stop-system\.cmd/);
});

test("Windows startup migrates the legacy task only after installing the unified task", () => {
  const installer = fs.readFileSync(path.join(rootDir, "scripts", "install-fulfillment-startup.cmd"), "utf8");
  const unifiedCreate = installer.indexOf('/Create /TN "%TASK_NAME%"');
  const legacyDelete = installer.indexOf('/Delete /TN "%LEGACY_TASK_NAME%"');
  assert.ok(unifiedCreate >= 0);
  assert.ok(legacyDelete > unifiedCreate);
  assert.match(installer, /run-system-supervisor\.cmd/);
  assert.match(installer, /http:\/\/127\.0\.0\.1:3101/);
  assert.match(installer, /http:\/\/127\.0\.0\.1:3112\/docs/);
});

test("Windows development entry elevates a truthful safe stop before automatic reload", () => {
  const stopCmd = fs.readFileSync(path.join(rootDir, "scripts", "stop-system.cmd"), "utf8");
  const stopScript = fs.readFileSync(path.join(rootDir, "scripts", "stop-system.ps1"), "utf8");
  const developmentEntry = fs.readFileSync(path.join(rootDir, "scripts", "start-development-mode.cmd"), "utf8");
  const developmentScript = fs.readFileSync(path.join(rootDir, "scripts", "start-development-mode.ps1"), "utf8");
  assert.match(stopCmd, /stop-system\.ps1/);
  assert.match(stopCmd, /if errorlevel 1/);
  assert.match(stopScript, /-Verb RunAs/);
  assert.match(stopScript, /commerce-ops-supervisor\.lock/);
  assert.match(stopScript, /fulfillment-supervisor\.lock/);
  assert.match(stopScript, /status\.data\.scanning/);
  assert.match(stopScript, /Startup folder instead of Task Scheduler/);
  assert.match(stopScript, /3101/);
  assert.match(stopScript, /3112/);
  assert.match(developmentEntry, /start-development-mode\.ps1/);
  assert.match(developmentScript, /-Verb RunAs/);
  assert.match(developmentScript, /stop-system\.ps1/);
  assert.match(developmentScript, /npm\.cmd run dev/);
});
