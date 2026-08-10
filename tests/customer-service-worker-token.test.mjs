import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  resolveCustomerServiceWorkerToken,
} from "../lib/customer-service/customer-service-worker-token.mjs";

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "commerce-ops-cs-token-"));
  t.after(() => rmSync(root, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 20,
  }));
  return {
    tokenFile: path.join(root, "secrets", "customer-service-worker-token"),
  };
}

test("an explicit Worker token takes precedence without writing a token file", async (t) => {
  const { tokenFile } = fixture(t);
  const token = await resolveCustomerServiceWorkerToken({
    configuredToken: "  explicitly-configured-token  ",
    tokenFile,
  });
  assert.equal(token, "explicitly-configured-token");
  assert.throws(() => readFileSync(tokenFile, "utf8"), { code: "ENOENT" });
});

test("a missing Worker token is generated once under runtime secrets and reused", async (t) => {
  const { tokenFile } = fixture(t);
  const generated = await resolveCustomerServiceWorkerToken({ tokenFile });
  assert.match(generated, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(readFileSync(tokenFile, "utf8"), `${generated}\n`);
  assert.equal(await resolveCustomerServiceWorkerToken({ tokenFile }), generated);
  if (process.platform !== "win32") {
    assert.equal(statSync(tokenFile).mode & 0o777, 0o600);
  }
});

test("concurrent first-start resolvers converge on the exclusively created token", async (t) => {
  const { tokenFile } = fixture(t);
  const tokens = await Promise.all(
    Array.from({ length: 50 }, () => resolveCustomerServiceWorkerToken({ tokenFile })),
  );
  assert.equal(new Set(tokens).size, 1);
  assert.equal(readFileSync(tokenFile, "utf8").trim(), tokens[0]);
});

test("an empty existing token file fails closed without exposing its path", async (t) => {
  const { tokenFile } = fixture(t);
  mkdirSync(path.dirname(tokenFile), { recursive: true });
  writeFileSync(tokenFile, "\n", "utf8");
  await assert.rejects(
    resolveCustomerServiceWorkerToken({ tokenFile }),
    (error) => !String(error.message).includes(tokenFile)
      && /empty, invalid or unreadable/.test(error.message),
  );
});

test("an EEXIST loser waits for the winner to finish writing before reusing its token", async () => {
  const winnerToken = "a".repeat(43);
  let reads = 0;
  const waits = [];
  const token = await resolveCustomerServiceWorkerToken({
    tokenFile: "C:/runtime/secrets/customer-service-worker-token",
    fsImpl: {
      async readFile() {
        reads += 1;
        if (reads === 1) {
          const error = new Error("missing");
          error.code = "ENOENT";
          throw error;
        }
        return reads < 4 ? "" : `${winnerToken}\n`;
      },
      async mkdir() {},
      async writeFile() {
        const error = new Error("winner owns the file");
        error.code = "EEXIST";
        throw error;
      },
    },
    sleep: async (milliseconds) => { waits.push(milliseconds); },
    readRetryAttempts: 5,
    readRetryDelayMs: 7,
  });
  assert.equal(token, winnerToken);
  assert.deepEqual(waits, [7, 7]);
});

test("a resolver that initially observes the winner's empty inode also waits for completion", async () => {
  const winnerToken = "b".repeat(43);
  let reads = 0;
  let writeAttempted = false;
  const token = await resolveCustomerServiceWorkerToken({
    tokenFile: "C:/runtime/secrets/customer-service-worker-token",
    fsImpl: {
      async readFile() {
        reads += 1;
        return reads < 3 ? "" : `${winnerToken}\n`;
      },
      async mkdir() {},
      async writeFile() { writeAttempted = true; },
    },
    sleep: async () => {},
    readRetryAttempts: 3,
  });
  assert.equal(token, winnerToken);
  assert.equal(writeAttempted, false);
});
