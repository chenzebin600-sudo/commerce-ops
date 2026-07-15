export const ACCESS_TOKEN_SESSION_KEY = "commerce-ops-access-token";

export function readSessionToken(storage = globalThis.sessionStorage) {
  try {
    return String(storage?.getItem(ACCESS_TOKEN_SESSION_KEY) || "");
  } catch {
    return "";
  }
}

export function saveSessionToken(token, storage = globalThis.sessionStorage) {
  const value = String(token || "");
  if (!value) return clearSessionToken(storage);
  storage?.setItem(ACCESS_TOKEN_SESSION_KEY, value);
}

export function clearSessionToken(storage = globalThis.sessionStorage) {
  try {
    storage?.removeItem(ACCESS_TOKEN_SESSION_KEY);
  } catch {
    // Session storage is optional in privacy-restricted browser contexts.
  }
}

export function authorizationHeaders(token, initialHeaders) {
  const headers = new Headers(initialHeaders || undefined);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return headers;
}

export function createAuthorizedFetch({
  fetchImpl = globalThis.fetch,
  storage = globalThis.sessionStorage,
  onUnauthorized = () => {},
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");

  return async function authorizedFetch(input, init = {}) {
    const response = await fetchImpl(input, {
      ...init,
      headers: authorizationHeaders(readSessionToken(storage), init.headers),
    });
    if (response.status === 401) {
      clearSessionToken(storage);
      onUnauthorized();
    }
    return response;
  };
}
