import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const MANAGED_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function managedToken(value) {
  const token = String(value || "").trim();
  return MANAGED_TOKEN_PATTERN.test(token) ? token : null;
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function resolveCustomerServiceWorkerToken({
  configuredToken,
  tokenFile,
  fsImpl = fs,
  randomBytesImpl = randomBytes,
  sleep = defaultSleep,
  readRetryAttempts = 10,
  readRetryDelayMs = 20,
} = {}) {
  const explicit = String(configuredToken || "").trim();
  if (explicit) return explicit;

  const attempts = Math.max(1, Math.min(50, Math.trunc(Number(readRetryAttempts) || 10)));
  const delayMs = Math.max(1, Math.min(1_000, Number(readRetryDelayMs) || 20));
  const invalidFileError = () => new Error(
    "Customer-service Worker token file is empty, invalid or unreadable",
  );

  async function readCompleteManagedToken() {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const existing = managedToken(await fsImpl.readFile(tokenFile, "utf8"));
        if (existing) return existing;
      } catch (error) {
        if (error?.code !== "ENOENT") throw invalidFileError();
      }
      if (attempt + 1 < attempts) await sleep(delayMs);
    }
    throw invalidFileError();
  }

  let existingFileObserved = false;
  try {
    const existing = managedToken(await fsImpl.readFile(tokenFile, "utf8"));
    if (existing) return existing;
    existingFileObserved = true;
  } catch (error) {
    if (error?.code !== "ENOENT") throw invalidFileError();
  }
  if (existingFileObserved) return readCompleteManagedToken();

  const generated = randomBytesImpl(32).toString("base64url");
  try {
    await fsImpl.mkdir(path.dirname(tokenFile), { recursive: true });
    await fsImpl.writeFile(tokenFile, `${generated}\n`, {
      encoding: "utf8",
      // POSIX defense in depth; Windows deployments rely on the local storageRoot ACL.
      mode: 0o600,
      flag: "wx",
    });
    return generated;
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw new Error("Unable to create customer-service Worker token file");
    }
    return readCompleteManagedToken();
  }
}
