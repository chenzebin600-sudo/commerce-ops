import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

function value(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function base64Url(value) {
  return Buffer.from(value, "base64").toString("base64url");
}

function certificatePem(encoded) {
  const lines = Buffer.from(encoded, "base64").toString("base64").match(/.{1,64}/g) || [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
}

async function main() {
  const inputFile = value("--input");
  const outputDirectory = value("--output-directory");
  if (!inputFile || !outputDirectory) throw new Error("TLS export arguments are incomplete");
  const payload = JSON.parse(await fsp.readFile(path.resolve(inputFile), "utf8"));
  const jwk = { kty: "RSA" };
  for (const field of ["n", "e", "d", "p", "q", "dp", "dq", "qi"]) {
    if (!payload.rsa?.[field]) throw new Error(`TLS RSA field is missing: ${field}`);
    jwk[field] = base64Url(payload.rsa[field]);
  }
  const privateKey = crypto.createPrivateKey({ key: jwk, format: "jwk" });
  const output = path.resolve(outputDirectory);
  await fsp.writeFile(path.join(output, "root.crt"), certificatePem(payload.rootDer), { mode: 0o600 });
  await fsp.writeFile(path.join(output, "server.crt"), certificatePem(payload.serverDer), { mode: 0o600 });
  await fsp.writeFile(path.join(output, "server.key"), privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  const server = new crypto.X509Certificate(Buffer.from(payload.serverDer, "base64"));
  const root = new crypto.X509Certificate(Buffer.from(payload.rootDer, "base64"));
  if (!server.checkIssued(root)) throw new Error("PostgreSQL server certificate is not issued by the generated root CA");
  if (!server.checkHost("localhost") || !server.checkIP("127.0.0.1")) {
    throw new Error("PostgreSQL server certificate identity does not cover localhost and 127.0.0.1");
  }
  return { status: "EXPORTED", subject: server.subject, issuer: server.issuer, validTo: server.validTo };
}

main().then((result) => {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}).catch((error) => {
  process.stderr.write(`TLS material export failed: ${String(error?.message || error).split(/\r?\n/)[0].slice(0, 300)}\n`);
  process.exitCode = 1;
});

