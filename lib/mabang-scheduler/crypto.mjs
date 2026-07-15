import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

function encryptionKey() {
  const configured = String(process.env.APP_ENCRYPTION_KEY || "").trim();
  if (!configured) throw new Error("缺少 APP_ENCRYPTION_KEY，无法安全保存服务端凭证。");
  return createHash("sha256").update(configured, "utf8").digest();
}

export function encryptSecret(value) {
  const text = String(value ?? "");
  if (!text) return "";
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(":");
}

export function decryptSecret(value) {
  const text = String(value || "");
  if (!text) return "";
  const [version, ivText, tagText, dataText] = text.split(":");
  if (version !== "v1" || !ivText || !tagText || !dataText) throw new Error("加密凭证格式无效。");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(dataText, "base64url")), decipher.final()]).toString("utf8");
}

export function maskUsername(username) {
  const text = String(username || "").trim();
  if (text.length <= 2) return text ? `${text[0]}*` : "";
  if (text.length <= 5) return `${text.slice(0, 1)}***${text.slice(-1)}`;
  return `${text.slice(0, 2)}***${text.slice(-2)}`;
}

export function maskMobile(mobile) {
  const text = String(mobile || "").trim();
  if (text.length < 7) return text ? "***" : "";
  return `${text.slice(0, 3)}****${text.slice(-4)}`;
}
