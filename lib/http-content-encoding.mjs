import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";

const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

function qualityFor(header, name) {
  let wildcard = 0;
  for (const entry of String(header || "").toLowerCase().split(",")) {
    const [encoding, ...parameters] = entry.trim().split(";");
    if (!encoding) continue;
    const qValue = parameters
      .map((parameter) => parameter.trim().match(/^q=([0-9.]+)$/)?.[1])
      .find(Boolean);
    const quality = qValue === undefined ? 1 : Math.max(0, Math.min(1, Number(qValue) || 0));
    if (encoding === name) return quality;
    if (encoding === "*") wildcard = quality;
  }
  return wildcard;
}

export function preferredContentEncoding(acceptEncoding) {
  const brQuality = qualityFor(acceptEncoding, "br");
  const gzipQuality = qualityFor(acceptEncoding, "gzip");
  if (brQuality <= 0 && gzipQuality <= 0) return null;
  return brQuality >= gzipQuality ? "br" : "gzip";
}

export async function encodeHttpBody(value, acceptEncoding, { minBytes = 1024 } = {}) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (body.length < minBytes) return { body, encoding: null };
  const encoding = preferredContentEncoding(acceptEncoding);
  if (encoding === "br") {
    return {
      body: await brotli(body, {
        params: { [constants.BROTLI_PARAM_QUALITY]: 4 },
      }),
      encoding,
    };
  }
  if (encoding === "gzip") {
    return { body: await gzipAsync(body, { level: 6 }), encoding };
  }
  return { body, encoding: null };
}

export function appendVaryHeader(current, value) {
  const values = new Set(String(current || "").split(",").map((item) => item.trim()).filter(Boolean));
  values.add(value);
  return [...values].join(", ");
}
