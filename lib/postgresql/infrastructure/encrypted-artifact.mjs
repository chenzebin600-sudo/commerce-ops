import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const MAGIC = Buffer.from("COMMERCEOPSPG-AES256GCM-1\n", "ascii");
const IV_BYTES = 12;
const TAG_BYTES = 16;

export async function sha256File(filePath) {
  const digest = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    fs.createReadStream(filePath)
      .on("data", (chunk) => digest.update(chunk))
      .once("end", resolve)
      .once("error", reject);
  });
  return digest.digest("hex");
}

export async function readEncryptionKey(keyFile) {
  const encoded = (await fsp.readFile(keyFile, "utf8")).trim();
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new Error("PostgreSQL encryption key must decode to exactly 32 bytes");
  return key;
}

export async function createEncryptionKey(keyFile) {
  await fsp.mkdir(path.dirname(keyFile), { recursive: true });
  try {
    await fsp.writeFile(keyFile, `${crypto.randomBytes(32).toString("base64")}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return { created: true, keyFile };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    await readEncryptionKey(keyFile);
    return { created: false, keyFile };
  }
}

export async function encryptFile(inputPath, outputPath, key, { exclusive = true } = {}) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  await new Promise((resolve, reject) => {
    const input = fs.createReadStream(inputPath);
    const output = fs.createWriteStream(outputPath, { flags: exclusive ? "wx" : "w", mode: 0o600 });
    const fail = (error) => reject(error);
    input.once("error", fail);
    cipher.once("error", fail);
    output.once("error", fail);
    output.once("finish", resolve);
    output.write(Buffer.concat([MAGIC, iv]));
    cipher.once("end", () => output.end(cipher.getAuthTag()));
    input.pipe(cipher).pipe(output, { end: false });
  });
}

export async function decryptFile(inputPath, outputPath, key, { exclusive = true } = {}) {
  const handle = await fsp.open(inputPath, "r");
  try {
    const stat = await handle.stat();
    if (stat.size <= MAGIC.length + IV_BYTES + TAG_BYTES) throw new Error("Encrypted PostgreSQL artifact is truncated");
    const header = Buffer.alloc(MAGIC.length + IV_BYTES);
    const tag = Buffer.alloc(TAG_BYTES);
    await handle.read(header, 0, header.length, 0);
    await handle.read(tag, 0, tag.length, stat.size - TAG_BYTES);
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new Error("Encrypted PostgreSQL artifact header is invalid");
    }
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, header.subarray(MAGIC.length));
    decipher.setAuthTag(tag);
    await new Promise((resolve, reject) => {
      const input = fs.createReadStream(inputPath, { start: header.length, end: stat.size - TAG_BYTES - 1 });
      const output = fs.createWriteStream(outputPath, { flags: exclusive ? "wx" : "w", mode: 0o600 });
      const fail = (error) => reject(error);
      input.once("error", fail);
      decipher.once("error", fail);
      output.once("error", fail);
      output.once("finish", resolve);
      input.pipe(decipher).pipe(output);
    });
  } finally {
    await handle.close();
  }
}

export async function isEncryptedArtifact(filePath) {
  const handle = await fsp.open(filePath, "r");
  try {
    const header = Buffer.alloc(MAGIC.length);
    const result = await handle.read(header, 0, header.length, 0);
    return result.bytesRead === MAGIC.length && header.equals(MAGIC);
  } finally {
    await handle.close();
  }
}

