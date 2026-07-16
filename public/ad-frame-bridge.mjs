export const AD_FRAME_READY = "commerce-ops:ads-ready";
export const AD_FRAME_AUTH = "commerce-ops:ads-auth";
export const AD_FRAME_CLEAR = "commerce-ops:ads-clear";
export const AD_FRAME_SESSION_EXPIRED = "commerce-ops:ads-session-expired";

function isMessage(value, type) {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && value.type === type
    && Object.keys(value).length === 1;
}

export function createAdFrameBridge({
  windowObject = globalThis.window,
  frame,
  getAuthContext,
  onSessionExpired = () => {},
} = {}) {
  if (!windowObject?.location?.origin) throw new Error("window origin is required");
  if (!frame) throw new Error("advertising iframe is required");
  if (typeof getAuthContext !== "function") throw new TypeError("getAuthContext must be a function");

  const expectedOrigin = windowObject.location.origin;

  function post(message) {
    const target = frame.contentWindow;
    if (!target) return false;
    target.postMessage(message, expectedOrigin);
    return true;
  }

  function sendAuthentication() {
    const context = getAuthContext() || {};
    const token = String(context.token || "");
    const localCompatibilityMode = Boolean(context.localCompatibilityMode);
    if (!token && !localCompatibilityMode) return false;
    return post({ type: AD_FRAME_AUTH, token, localCompatibilityMode });
  }

  function clear() {
    return post({ type: AD_FRAME_CLEAR });
  }

  function onMessage(event) {
    if (event.origin !== expectedOrigin) return;
    if (event.source !== frame.contentWindow) return;
    if (isMessage(event.data, AD_FRAME_READY)) {
      sendAuthentication();
      return;
    }
    if (isMessage(event.data, AD_FRAME_SESSION_EXPIRED)) onSessionExpired();
  }

  windowObject.addEventListener("message", onMessage);
  return Object.freeze({
    expectedOrigin,
    sendAuthentication,
    clear,
    dispose() {
      windowObject.removeEventListener("message", onMessage);
    },
  });
}
