import { authorizedFetch } from "@/services/api";

export type ShopeeMethod = "GET" | "POST";

export interface ShopeeRelayRequest {
  shop_id: string;
  api_path: string;
  method: ShopeeMethod;
  params: Record<string, unknown>;
  body?: Record<string, unknown>;
}

export interface ShopeeRelayResponse {
  ok?: boolean;
  店编?: string;
  shop_id?: string | number;
  api_path?: string;
  耗时ms?: number;
  data?: Record<string, unknown>;
  error?: unknown;
  message?: string;
  [key: string]: unknown;
}

export class ShopeeConsoleRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly payload: unknown,
  ) {
    super(message);
  }
}

async function parsePayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, error: text };
  }
}

function payloadMessage(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object") return fallback;
  const record = payload as Record<string, unknown>;
  if (typeof record.error === "string" && record.error) return record.error;
  if (typeof record.message === "string" && record.message) return record.message;
  return fallback;
}

async function relayFetch(path: string, apiKey: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("X-Token-Key", apiKey);
  headers.set("Accept", "application/json");
  const response = await authorizedFetch(path, { ...init, headers });
  const payload = await parsePayload(response);
  if (!response.ok) {
    throw new ShopeeConsoleRequestError(
      payloadMessage(payload, `请求失败 (${response.status})`),
      response.status,
      payload,
    );
  }
  return payload;
}

export async function loadShopeeTokenShops(apiKey: string) {
  return relayFetch("/api/shopee-console/shops", apiKey);
}

export async function callShopeeRelay(apiKey: string, payload: ShopeeRelayRequest) {
  return relayFetch("/api/shopee-console/call", apiKey, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }) as Promise<ShopeeRelayResponse>;
}
