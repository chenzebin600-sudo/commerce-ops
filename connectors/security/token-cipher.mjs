import crypto from "node:crypto";

function keyBuffer(value) {
  const configured = String(value || "").trim();
  if (!configured) throw new Error("COMMERCE_CONNECTOR_ENCRYPTION_KEY is not configured");
  let key;
  try { key = Buffer.from(configured, "base64url"); } catch { key = Buffer.alloc(0); }
  if (key.length !== 32) throw new Error("Connector encryption key must be a 32-byte base64url value");
  return key;
}

export class ConnectorTokenCipher {
  constructor(encryptionKey) {
    this.key = keyBuffer(encryptionKey);
  }

  encrypt(value) {
    const text = String(value || "");
    if (!text) return "";
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
    return [
      "v1",
      iv.toString("base64url"),
      cipher.getAuthTag().toString("base64url"),
      encrypted.toString("base64url"),
    ].join(":");
  }

  decrypt(value) {
    const text = String(value || "");
    if (!text) return "";
    const [version, iv, tag, encrypted] = text.split(":");
    if (version !== "v1" || !iv || !tag || encrypted === undefined) {
      throw new Error("Unsupported encrypted connector token format");
    }
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }
}

export function resolveConnectorEncryptionKey(env = process.env) {
  return String(env.COMMERCE_CONNECTOR_ENCRYPTION_KEY || env.LAZADA_TOKEN_ENCRYPTION_KEY || "").trim();
}
