import crypto from "node:crypto";

export function signLazadaRequest({ apiPath, parameters, appSecret }) {
  const path = String(apiPath || "").trim();
  const secret = String(appSecret || "").trim();
  if (!path.startsWith("/")) throw new TypeError("Lazada API path is required");
  if (!secret) throw new TypeError("Lazada app secret is required");
  const canonical = Object.entries(parameters || {})
    .filter(([key, value]) => key !== "sign" && value !== undefined && value !== null && String(value) !== "")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}${value}`)
    .join("");
  return crypto.createHmac("sha256", secret)
    .update(`${path}${canonical}`, "utf8")
    .digest("hex")
    .toUpperCase();
}
