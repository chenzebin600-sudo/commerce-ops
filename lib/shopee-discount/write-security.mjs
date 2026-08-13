const MODES = new Set(["trusted_single_role", "separate_execute_identity"]);
const MANAGED_ATTESTATION = "I_ATTEST_ALL_CREDENTIAL_HOLDERS_ARE_AUTHORIZED";
const PRIVILEGED_IDENTITY = "privileged_execute_identity";

function isTrue(value) {
  return value === true || value === "true";
}

function configuredList(value, pattern) {
  if (typeof value !== "string" || value.length === 0) return null;
  const entries = value.split(",").map((entry) => entry.trim());
  return entries.length > 0 && entries.every((entry) => pattern.test(entry)) ? Object.freeze([...new Set(entries)]) : null;
}

function isPrivateIpv4(host) {
  const parts = host.split(".");
  const octets = parts.map(Number);
  if (octets.length !== 4 || octets.some((part, index) => !Number.isInteger(part) || part < 0 || part > 255 || String(part) !== parts[index])) return false;
  return octets[0] === 10 || octets[0] === 127 || (octets[0] === 192 && octets[1] === 168) || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31);
}

function trustedListener(listener) {
  if (listener?.trustedTopology === true && typeof listener.host === "string" && /^[A-Za-z0-9.-]+$/.test(listener.host)) return true;
  if (typeof listener?.host !== "string" || !/^[A-Za-z0-9:.]+$/.test(listener.host)) return false;
  if (["localhost", "::1"].includes(listener.host)) return true;
  return isPrivateIpv4(listener.host);
}

function transportSecurity(relay) {
  let https = false;
  try {
    https = new URL(String(relay?.url || "")).protocol === "https:";
  } catch {
    https = false;
  }
  const mtls = https && relay?.mtls?.verified === true;
  const signed = relay?.signedRequestCapability;
  const signedRequests = Boolean(
    signed?.bindsMethod
    && signed?.bindsPath
    && signed?.bindsTimestamp
    && signed?.bindsNonce
    && signed?.bindsBodyHash
    && signed?.bindsRequestId
    && Number.isSafeInteger(signed?.clockWindowSeconds)
    && signed.clockWindowSeconds > 0
    && signed.clockWindowSeconds <= 300
    && signed.replayCache === true,
  );
  return Object.freeze({ https, mtls, signedRequests, replayProtected: signedRequests && signed.replayCache === true });
}

function safeStatus({ enabled, mode, privilegedApprovalRequired, reasonCode, checks }) {
  return Object.freeze({
    enabled,
    mode,
    privilegedApprovalRequired,
    reasonCode,
    switchProtected: checks.switchProtected,
    managedAttestationPresent: checks.managedAttestationPresent,
    listenerPrivate: checks.listenerPrivate,
    trustedProxy: checks.trustedProxy,
    whitelistConfigured: checks.whitelistConfigured,
    batchCapConfigured: checks.batchCapConfigured,
    transportSecure: checks.transportSecure,
    independentExecuteIdentity: checks.independentExecuteIdentity,
  });
}

function result(mode, privilegedApprovalRequired, transport, checks, reasonCode) {
  const enabled = reasonCode === "SHOPEE_WRITE_ENABLED";
  const value = {
    enabled,
    mode,
    privilegedApprovalRequired,
    transportSecurity: transport,
    reasonCode,
  };
  value.safeStatus = safeStatus({ ...value, checks });
  return Object.freeze(value);
}

export function resolveShopeeWriteSecurity({ env = {}, listener = {}, relay = {} } = {}) {
  const configuredMode = typeof env.SHOPEE_WRITE_SECURITY_MODE === "string" ? env.SHOPEE_WRITE_SECURITY_MODE : null;
  const mode = MODES.has(configuredMode) ? configuredMode : null;
  const transport = transportSecurity(relay);
  const batchCap = Number(env.SHOPEE_WRITE_MAX_BATCH_ITEMS);
  const countries = configuredList(env.SHOPEE_WRITE_COUNTRY_WHITELIST, /^[A-Z]{2,3}$/);
  const shops = configuredList(env.SHOPEE_WRITE_SHOP_WHITELIST, /^[1-9]\d*$/);
  const listenerPrivate = trustedListener(listener);
  const trustedProxy = listener.behindTrustedProxy === true && listener.exposure === "proxy_only";
  const checks = {
    switchProtected: isTrue(env.SHOPEE_REAL_WRITE_SWITCH_PROTECTED),
    managedAttestationPresent: env.SHOPEE_WRITE_MANAGED_ATTESTATION === MANAGED_ATTESTATION,
    listenerPrivate,
    trustedProxy,
    whitelistConfigured: Boolean(countries && shops),
    batchCapConfigured: Number.isSafeInteger(batchCap) && batchCap > 0 && batchCap <= 50,
    transportSecure: transport.https || transport.mtls || transport.signedRequests,
    independentExecuteIdentity: relay?.executeIdentity?.independent === true && relay?.executeIdentity?.trusted === true,
  };
  const privilegedApprovalRequired = mode === "separate_execute_identity";

  let reasonCode = "SHOPEE_WRITE_ENABLED";
  if (!MODES.has(configuredMode)) reasonCode = "SHOPEE_WRITE_MODE_INVALID";
  else if (!isTrue(env.SHOPEE_REAL_WRITE_ENABLED)) reasonCode = "SHOPEE_WRITE_SWITCH_DISABLED";
  else if (!checks.switchProtected) reasonCode = "SHOPEE_WRITE_SWITCH_UNPROTECTED";
  else if (!checks.whitelistConfigured) reasonCode = "SHOPEE_WRITE_WHITELIST_INVALID";
  else if (!checks.batchCapConfigured) reasonCode = "SHOPEE_WRITE_BATCH_CAP_INVALID";
  else if (mode === "trusted_single_role" && !checks.managedAttestationPresent) reasonCode = "SHOPEE_WRITE_ATTESTATION_INVALID";
  else if (mode === "trusted_single_role" && !checks.listenerPrivate) reasonCode = "SHOPEE_WRITE_LISTENER_MISMATCH";
  else if (mode === "separate_execute_identity" && (!checks.independentExecuteIdentity || !checks.trustedProxy)) reasonCode = "SHOPEE_WRITE_EXECUTE_IDENTITY_INVALID";
  else if (!checks.transportSecure) reasonCode = "SHOPEE_WRITE_TRANSPORT_INSECURE";

  return Object.freeze({ ...result(mode, privilegedApprovalRequired, transport, checks, reasonCode), constraints: Object.freeze({ countries, shops, maxBatchItems: checks.batchCapConfigured ? batchCap : null }) });
}

function authorizationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function assertShopeeWriteAuthorized(security, context = {}) {
  if (!security?.enabled) throw authorizationError("SHOPEE_WRITE_DISABLED", "Shopee writes are disabled");
  if (!new Set(["preview", "edit", "approve", "execute"]).has(context.action)) {
    throw authorizationError("SHOPEE_WRITE_ACTION_INVALID", "Shopee write action is invalid");
  }
  if (context.action === "execute") {
    const constraints = security.constraints;
    if (!constraints?.countries?.includes(context.country)
      || !constraints?.shops?.includes(context.shopId)
      || !Number.isSafeInteger(context.batchSize)
      || context.batchSize < 1
      || context.batchSize > constraints.maxBatchItems) {
      throw authorizationError("SHOPEE_WRITE_TARGET_NOT_AUTHORIZED", "Shopee write target or batch is not authorized");
    }
  }
  if (security.mode !== "separate_execute_identity" || new Set(["preview", "edit"]).has(context.action)) return true;
  if (context.identity !== PRIVILEGED_IDENTITY) {
    throw authorizationError("SHOPEE_WRITE_PRIVILEGED_IDENTITY_REQUIRED", "A privileged execute identity is required");
  }
  if (context.action === "execute" && context.approvalIdentity !== PRIVILEGED_IDENTITY) {
    throw authorizationError("SHOPEE_WRITE_PRIVILEGED_APPROVAL_REQUIRED", "A privileged final approval is required");
  }
  return true;
}
