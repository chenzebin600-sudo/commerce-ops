import { createHash } from "node:crypto";

function normalizedShopIds(shopIds) {
  return [...new Set([...(shopIds || [])]
    .map((value) => String(value || "").trim()).filter(Boolean))];
}

export function fulfillmentAccountIdentityKey(account) {
  const username = String(account?.username || "").trim().toLocaleLowerCase();
  if (!username) return "";
  const usernameFingerprint = createHash("sha256").update(username, "utf8").digest("hex");
  const profileId = String(account?.id || "").trim();
  return `${profileId ? `profile:${profileId}` : "environment"}:${usernameFingerprint}`;
}

export function authorizedShopIdsForIdentity(settings, account, staticShopIds = []) {
  const identityKey = fulfillmentAccountIdentityKey(account);
  const stored = identityKey ? settings?.[identityKey] : null;
  if (Array.isArray(stored)) return new Set(normalizedShopIds(stored));
  return account?.source === "environment" ? new Set(normalizedShopIds(staticShopIds)) : new Set();
}

export function authorizationSettingsForIdentity(settings, account, shopIds) {
  const identityKey = fulfillmentAccountIdentityKey(account);
  if (!identityKey) return { ...(settings || {}) };
  return { ...(settings || {}), [identityKey]: normalizedShopIds(shopIds) };
}
