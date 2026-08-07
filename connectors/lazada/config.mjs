import { ConnectorConfigurationError } from "../base/errors.mjs";

export const LAZADA_COUNTRY_ENDPOINTS = Object.freeze({
  ID: "https://api.lazada.co.id/rest",
  MY: "https://api.lazada.com.my/rest",
  PH: "https://api.lazada.com.ph/rest",
  SG: "https://api.lazada.sg/rest",
  TH: "https://api.lazada.co.th/rest",
  VN: "https://api.lazada.vn/rest",
});

export function normalizeLazadaCountry(value) {
  const country = String(value || "").trim().toUpperCase();
  if (!LAZADA_COUNTRY_ENDPOINTS[country]) {
    throw new ConnectorConfigurationError(`Unsupported Lazada country: ${country || "missing"}`, { platform: "lazada" });
  }
  return country;
}

export function lazadaApiBaseUrl(country) {
  return LAZADA_COUNTRY_ENDPOINTS[normalizeLazadaCountry(country)];
}
