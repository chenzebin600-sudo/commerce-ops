import fsp from "node:fs/promises";
import path from "node:path";
import { decryptFile, readEncryptionKey } from "../lib/postgresql/infrastructure/encrypted-artifact.mjs";

function value(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

async function main() {
  const name = value("--name");
  const destination = value("--destination");
  const archiveDir = value("--archive-dir");
  const keyFile = value("--key-file");
  if (!name || !destination || !archiveDir || !keyFile) throw new Error("WAL restore arguments are incomplete");
  if (!/^[0-9A-F]{24}(?:\.[0-9A-F]{8}\.backup)?$/i.test(name)) throw new Error("WAL restore name is invalid");
  const source = path.resolve(archiveDir, `${name}.aes256gcm`);
  const target = path.resolve(destination);
  const temporary = `${target}.${process.pid}.tmp`;
  const key = await readEncryptionKey(path.resolve(keyFile));
  try {
    await decryptFile(source, temporary, key);
    await fsp.rename(temporary, target);
  } finally {
    await fsp.rm(temporary, { force: true }).catch(() => {});
  }
  return { status: "RESTORED", name };
}

main().then((result) => {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}).catch((error) => {
  process.stderr.write(`WAL restore failed: ${String(error?.message || error).split(/\r?\n/)[0].slice(0, 300)}\n`);
  process.exitCode = 1;
});

