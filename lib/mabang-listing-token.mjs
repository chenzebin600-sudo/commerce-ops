import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export async function resolveMabangListingInternalToken({
  configuredToken,
  tokenFile,
} = {}) {
  const explicit = String(configuredToken || "").trim();
  if (explicit) return explicit;

  try {
    const existing = String(await fs.readFile(tokenFile, "utf8")).trim();
    if (existing) return existing;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw new Error("Unable to read Mabang listing internal token file");
    }
  }

  const generated = randomBytes(32).toString("base64url");
  await fs.mkdir(path.dirname(tokenFile), { recursive: true });
  try {
    await fs.writeFile(tokenFile, `${generated}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    return generated;
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw new Error("Unable to create Mabang listing internal token file");
    }
    const existing = String(await fs.readFile(tokenFile, "utf8")).trim();
    if (!existing) throw new Error("Mabang listing internal token file is empty");
    return existing;
  }
}
