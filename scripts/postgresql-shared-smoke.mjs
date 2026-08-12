import { spawn } from "node:child_process";

if (!/_test$/.test(String(process.env.POSTGRES_DATABASE || ""))) {
  throw new Error("postgres:shared-smoke requires POSTGRES_DATABASE ending in _test");
}
if (!String(process.env.POSTGRES_APP_PASSWORD || "")) {
  throw new Error("postgres:shared-smoke requires POSTGRES_APP_PASSWORD from the local secret store");
}

const child = spawn(process.execPath, ["--test", "tests/postgresql-shared-development.integration.test.mjs"], {
  cwd: process.cwd(), stdio: "inherit", env: { ...process.env, COMMERCE_POSTGRES_SHARED_SMOKE: "1" },
});
child.once("error", (error) => { throw error; });
child.once("exit", (code, signal) => process.exitCode = signal ? 1 : Number(code || 0));
