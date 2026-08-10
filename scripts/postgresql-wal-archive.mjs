import fsp from "node:fs/promises";
import path from "node:path";
import { encryptFile, isEncryptedArtifact, readEncryptionKey } from "../lib/postgresql/infrastructure/encrypted-artifact.mjs";

function value(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

async function main() {
  const source = value("--source");
  const name = value("--name");
  const archiveDir = value("--archive-dir");
  const keyFile = value("--key-file");
  if (!source || !name || !archiveDir || !keyFile) throw new Error("WAL archive arguments are incomplete");
  if (!/^[0-9A-F]{24}(?:\.[0-9A-F]{8}\.backup)?$/i.test(name)) throw new Error("WAL archive name is invalid");
  const sourcePath = path.resolve(source);
  const archivePath = path.resolve(archiveDir, `${name}.aes256gcm`);
  if (await fsp.stat(archivePath).then(() => true).catch(() => false)) {
    if (!await isEncryptedArtifact(archivePath)) throw new Error("Existing WAL archive has an invalid encrypted header");
    return { status: "EXISTS", name };
  }
  const key = await readEncryptionKey(path.resolve(keyFile));
  const temporary = `${archivePath}.${process.pid}.tmp`;
  try {
    await encryptFile(sourcePath, temporary, key);
    await fsp.rename(temporary, archivePath);
  } finally {
    await fsp.rm(temporary, { force: true }).catch(() => {});
  }
  return { status: "ARCHIVED", name };
}

main().then((result) => {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}).catch((error) => {
  process.stderr.write(`WAL archive failed: ${String(error?.message || error).split(/\r?\n/)[0].slice(0, 300)}\n`);
  process.exitCode = 1;
});

