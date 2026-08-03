import { apiJson } from "@/services/api";

export async function loadAdvertisingStatus() {
  return apiJson<{ url: string; started?: boolean; ok?: boolean }>("/api/ad-analyzer/status", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
}

export function loadAdvertisingFiles() {
  return apiJson<{ files: Array<Record<string, unknown>>; total: number }>("/api/files?page=1&page_size=100&scope=ads");
}
