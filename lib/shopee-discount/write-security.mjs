const MODES = new Set(["trusted_single_role", "separate_execute_identity"]);
const MANAGED_ATTESTATION = "I_ATTEST_ALL_CREDENTIAL_HOLDERS_ARE_AUTHORIZED";
const PRIVILEGED_IDENTITY = "privileged_execute_identity";

function isTrue(value) {
  return value === true || value === "true";
}

function configuredList(value, pattern) {
  if (typeof value !== "string" || value.length === 0) return false;
  const entries = value.split(",").map((entry) => entry.trim());
  return entries.length > 0 && entries.every((entry) => pattern.test(entry));
}

function transportSecurity(relay) {
  let https = false;
  try {
    https = new URL(String(relay?.url || "")).protocol === "https:";
  } catch {
    https = false;
  }
  const mtls = relay?.mtls?.verified === true;
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
  const listenerPrivate = listener.exposure === "private" && !new Set(["0.0.0.0", "::", "[::]"]).has(listener.host);
  const trustedProxy = listener.behindTrustedProxy === true && listener.exposure === "proxy_only";
  const checks = {
    switchProtected: isTrue(env.SHOPEE_REAL_WRITE_SWITCH_PROTECTED),
    managedAttestationPresent: env.SHOPEE_WRITE_MANAGED_ATTESTATION === MANAGED_ATTESTATION,
    listenerPrivate,
    trustedProxy,
    whitelistConfigured: configuredList(env.SHOPEE_WRITE_COUNTRY_WHITELIST, /^[A-Z]{2,3}$/) && configuredList(env.SHOPEE_WRITE_SHOP_WHITELIST, /^[1-9]\d*$/),
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

  return result(mode, privilegedApprovalRequired, transport, checks, reasonCode);
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
  if (security.mode !== "separate_execute_identity" || new Set(["preview", "edit"]).has(context.action)) return true;
  if (context.identity !== PRIVILEGED_IDENTITY) {
    throw authorizationError("SHOPEE_WRITE_PRIVILEGED_IDENTITY_REQUIRED", "A privileged execute identity is required");
  }
  if (context.action === "execute" && context.approvalIdentity !== PRIVILEGED_IDENTITY) {
    throw authorizationError("SHOPEE_WRITE_PRIVILEGED_APPROVAL_REQUIRED", "A privileged final approval is required");
  }
  return true;
}
