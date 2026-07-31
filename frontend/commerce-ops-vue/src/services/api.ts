export const ACCESS_TOKEN_SESSION_KEY = "commerce-ops-access-token";

export interface AuthenticationStatus {
  authenticationEnabled: boolean;
  authenticated: boolean;
  localCompatibilityMode: boolean;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function authorizedFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  const token = sessionStorage.getItem(ACCESS_TOKEN_SESSION_KEY);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(input, { ...init, headers });
  if (response.status === 401) sessionStorage.removeItem(ACCESS_TOKEN_SESSION_KEY);
  return response;
}

export async function getAuthenticationStatus(): Promise<AuthenticationStatus> {
  const response = await authorizedFetch("/api/auth/status");
  if (!response.ok) throw new ApiError("无法读取认证状态", response.status);
  return response.json() as Promise<AuthenticationStatus>;
}

export async function verifyAccessToken(token: string): Promise<void> {
  const response = await fetch("/api/auth/verify", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  const payload = await response.json().catch(() => ({})) as { authenticated?: boolean; error?: string };
  if (!response.ok || !payload.authenticated) {
    throw new ApiError(payload.error || "访问密钥错误", response.status);
  }
  sessionStorage.setItem(ACCESS_TOKEN_SESSION_KEY, token);
}

export async function logout(): Promise<void> {
  await authorizedFetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
  sessionStorage.removeItem(ACCESS_TOKEN_SESSION_KEY);
}

export async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await authorizedFetch(path, init);
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || payload.ok === false || payload.success === false) {
    const error = payload.error as { message?: string } | string | undefined;
    const message = typeof error === "string" ? error : error?.message;
    throw new ApiError(message || `请求失败 (${response.status})`, response.status);
  }
  return ((payload.data ?? payload.dashboard ?? payload) as T);
}
