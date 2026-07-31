const ACCESS_TOKEN_SESSION_KEY = "commerce-ops-access-token";

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
