import { createHash } from "node:crypto";

const IMAGE_URL_PATTERN = /^https?:\/\//i;
const IMAGE_EXTENSION_PATTERN = /\.(?:jpe?g|png|webp)(?:$|[?#])/i;
const FILENAME_SKU_PATTERN = /^(.+)_\d+\.(jpg|jpeg|png|webp)$/i;

function text(value) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
}

export function normalizeSku(value) {
  return text(value).toLocaleUpperCase("en-US");
}

function normalizedKey(value) {
  return text(value).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
}

function flatten(value, prefix = "", depth = 0, result = []) {
  if (depth > 5 || value == null) return result;
  if (Array.isArray(value)) {
    for (let index = 0; index < Math.min(value.length, 8); index += 1) {
      flatten(value[index], `${prefix}[${index}]`, depth + 1, result);
    }
    return result;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      flatten(item, prefix ? `${prefix}.${key}` : key, depth + 1, result);
    }
    return result;
  }
  result.push({ path: prefix, key: prefix.split(".").pop() || prefix, value });
  return result;
}

function isSkuKey(key) {
  const name = normalizedKey(key);
  return (name.includes("sku") || /库存.*(?:编号|编码)|(?:编号|编码).*库存/.test(name))
    && !/(image|img|pic|photo|file|filename|图片|文件)/.test(name);
}

function isImageKey(key) {
  return /(image|img|pic|photo|thumb|picture|图片|主图|缩略图)/.test(normalizedKey(key));
}

function isWarehouseKey(key) {
  return /(warehouse|storehouse|stockroom|仓库|库房)/.test(normalizedKey(key));
}

function isProductNameKey(key) {
  const name = normalizedKey(key);
  return /(productname|goodsname|itemname|chinesename|商品名称|产品名称|中文名称|品名|title)/.test(name)
    && !isImageKey(name);
}

function firstHttpUrl(value) {
  if (typeof value === "string") {
    const candidate = value.split(/\s*,\s*/).map((part) => part.trim().split(/\s+/, 1)[0])
      .find((part) => IMAGE_URL_PATTERN.test(part));
    return candidate || null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const candidate = firstHttpUrl(item);
      if (candidate) return candidate;
    }
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      const candidate = firstHttpUrl(item);
      if (candidate) return candidate;
    }
  }
  return null;
}

function detectedField(row, predicate, validator = () => true) {
  const fields = flatten(row);
  const direct = fields.find((field) => predicate(field.key) && validator(field.value));
  return direct || null;
}

function detectedImage(row) {
  const fields = flatten(row);
  const named = fields.find((field) => isImageKey(field.key) && firstHttpUrl(field.value));
  if (named) return { ...named, value: firstHttpUrl(named.value) };
  const extension = fields.find((field) => typeof field.value === "string"
    && IMAGE_URL_PATTERN.test(field.value) && IMAGE_EXTENSION_PATTERN.test(field.value));
  return extension || null;
}

function rowProjection(row) {
  const sku = detectedField(row, isSkuKey, (value) => {
    const candidate = text(value);
    return Boolean(candidate) && candidate.length <= 160 && !IMAGE_URL_PATTERN.test(candidate);
  });
  if (!sku) return null;
  const image = detectedImage(row);
  const warehouse = detectedField(row, isWarehouseKey, (value) => typeof value !== "object" && text(value).length <= 240);
  const productName = detectedField(row, isProductNameKey, (value) => typeof value !== "object" && text(value).length <= 500);
  return {
    sourceSku: text(sku.value),
    productName: productName ? text(productName.value) : null,
    warehouseName: warehouse ? text(warehouse.value) : null,
    sourceImageUrl: image ? text(image.value) : null,
    paths: {
      sku: sku.path,
      image: image?.path || null,
      warehouse: warehouse?.path || null,
      productName: productName?.path || null,
    },
  };
}

function objectArrays(value, prefix = "", depth = 0, result = []) {
  if (depth > 6 || value == null || typeof value !== "object") return result;
  if (Array.isArray(value)) {
    if (value.some((item) => item && typeof item === "object" && !Array.isArray(item))) {
      result.push({ path: prefix, rows: value });
    }
    for (let index = 0; index < Math.min(value.length, 4); index += 1) {
      objectArrays(value[index], `${prefix}[${index}]`, depth + 1, result);
    }
    return result;
  }
  for (const [key, item] of Object.entries(value)) {
    objectArrays(item, prefix ? `${prefix}.${key}` : key, depth + 1, result);
  }
  return result;
}

function numericMetadata(payload, minimum) {
  const fields = flatten(payload).filter((field) => Number.isFinite(Number(field.value)));
  const find = (pattern) => fields.find((field) => pattern.test(normalizedKey(field.key))
    && Number(field.value) >= minimum);
  return {
    total: find(/^(total|totalcount|recordcount|recordstotal|总数|总条数|总记录数)$/),
    page: find(/^(page|pagenum|pageno|currentpage|current|页码|当前页)$/),
    pageSize: find(/^(pagesize|rowsperpage|limit|perpage|每页数量|每页条数)$/),
    totalPages: find(/^(totalpages|pagecount|pages|总页数)$/),
  };
}

function parseRequestParameters(request = {}) {
  const values = [];
  try {
    const parsed = new URL(request.url || "https://invalid.local/");
    for (const [key, value] of parsed.searchParams) values.push({ source: "query", path: key, key, value });
  } catch {}
  const body = String(request.postData || "").trim();
  if (!body) return values;
  try {
    const json = JSON.parse(body);
    for (const field of flatten(json)) values.push({ source: "json", ...field });
    return values;
  } catch {}
  for (const [key, value] of new URLSearchParams(body)) values.push({ source: "form", path: key, key, value });
  return values;
}

function requestPagination(request) {
  const parameters = parseRequestParameters(request);
  const page = parameters.find((item) => /^(page|pagenum|pageno|currentpage|current|页码|当前页)$/.test(normalizedKey(item.key)));
  const pageSize = parameters.find((item) => /^(pagesize|rowsperpage|limit|perpage|每页数量|每页条数)$/.test(normalizedKey(item.key)));
  return {
    pageParameter: page ? { source: page.source, path: page.path, value: Number(page.value) || 1 } : null,
    pageSizeParameter: pageSize ? { source: pageSize.source, path: pageSize.path, value: Number(pageSize.value) || null } : null,
  };
}

export function analyzeInventoryPayload(payload, { request = {}, transport = "xhr" } = {}) {
  const candidates = objectArrays(payload).map((candidate) => {
    const rows = candidate.rows.map(rowProjection).filter(Boolean);
    const imageCount = rows.filter((row) => row.sourceImageUrl).length;
    const warehouseCount = rows.filter((row) => row.warehouseName).length;
    const nameCount = rows.filter((row) => row.productName).length;
    return {
      ...candidate,
      rows,
      imageCount,
      score: rows.length * 8 + imageCount * 12 + warehouseCount * 2 + nameCount,
    };
  }).filter((candidate) => candidate.rows.length > 0)
    .sort((left, right) => right.score - left.score || right.rows.length - left.rows.length);
  const best = candidates[0];
  if (!best) return null;
  const metadata = numericMetadata(payload, best.rows.length);
  const requestFields = requestPagination(request);
  const first = best.rows[0];
  return {
    transport,
    request,
    rows: best.rows.map(({ paths, ...row }) => row),
    confidence: Math.min(100, Math.round(best.score / Math.max(1, best.rows.length))),
    profile: {
      transport,
      url: request.url || null,
      method: String(request.method || "GET").toUpperCase(),
      parameterKeys: parseRequestParameters(request).map((item) => item.path).slice(0, 50),
      rowsPath: best.path,
      skuPath: first.paths.sku,
      imagePath: first.paths.image,
      warehousePath: first.paths.warehouse,
      productNamePath: first.paths.productName,
      totalPath: metadata.total?.path || null,
      pagePath: metadata.page?.path || null,
      pageSizePath: metadata.pageSize?.path || null,
      totalPagesPath: metadata.totalPages?.path || null,
      pageParameter: requestFields.pageParameter,
      pageSizeParameter: requestFields.pageSizeParameter,
      total: metadata.total ? Number(metadata.total.value) : null,
      currentPage: metadata.page ? Number(metadata.page.value) : requestFields.pageParameter?.value || null,
      pageSize: metadata.pageSize ? Number(metadata.pageSize.value) : requestFields.pageSizeParameter?.value || null,
      totalPages: metadata.totalPages ? Number(metadata.totalPages.value) : null,
      hasImages: best.imageCount > 0,
    },
  };
}

export function filenameSkuFromUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    const filename = decodeURIComponent(parsed.pathname.split("/").pop() || "");
    return text(filename.match(FILENAME_SKU_PATTERN)?.[1] || "") || null;
  } catch {
    return null;
  }
}

function srcsetUrl(value) {
  return String(value || "").split(",").map((item) => item.trim().split(/\s+/, 1)[0])
    .find((item) => IMAGE_URL_PATTERN.test(item)) || null;
}

function backgroundUrl(value) {
  const match = String(value || "").match(/url\(["']?([^"')]+)["']?\)/i);
  return match && IMAGE_URL_PATTERN.test(match[1]) ? match[1] : null;
}

export function normalizeDiscoveryRow(input, { pageNumber = 1, rowNumber = 1, sourceKind = "interface" } = {}) {
  const sourceSku = text(input.sourceSku ?? input.source_sku);
  const normalized = normalizeSku(sourceSku);
  if (!normalized) return null;
  const sourceImageUrl = firstHttpUrl(input.sourceImageUrl ?? input.source_image_url)
    || firstHttpUrl(input.imageSrc ?? input.image_src)
    || firstHttpUrl(input.imageDataSrc ?? input.image_data_src)
    || srcsetUrl(input.imageSrcset ?? input.image_srcset)
    || backgroundUrl(input.imageBackgroundUrl ?? input.image_background_url);
  const filenameSku = filenameSkuFromUrl(sourceImageUrl);
  const mismatch = filenameSku && normalizeSku(filenameSku) !== normalized;
  return {
    sourceSku,
    sourceSkuNormalized: normalized,
    productName: text(input.productName ?? input.product_name) || null,
    warehouseName: text(input.warehouseName ?? input.warehouse_name) || null,
    sourceImageUrl,
    imageSrc: firstHttpUrl(input.imageSrc ?? input.image_src),
    imageDataSrc: firstHttpUrl(input.imageDataSrc ?? input.image_data_src),
    imageSrcset: text(input.imageSrcset ?? input.image_srcset) || null,
    imageBackgroundUrl: backgroundUrl(input.imageBackgroundUrl ?? input.image_background_url),
    sourceKind,
    sourcePage: Math.max(1, Number(pageNumber) || 1),
    sourceRowNumber: Math.max(1, Number(rowNumber) || 1),
    filenameSku,
    validationStatus: sourceImageUrl ? (mismatch ? "warning" : "pending") : "missing",
    qualityIssueCode: mismatch ? "IMAGE_FILENAME_SKU_MISMATCH" : null,
    downloadStatus: sourceImageUrl ? "pending" : "missing",
  };
}

export function deduplicateDiscoveryRows(rows) {
  const result = [];
  const seen = new Set();
  for (const row of rows) {
    if (!row) continue;
    const key = [row.sourceSkuNormalized, row.sourceImageUrl || "", row.warehouseName || ""].join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(row);
  }
  return result;
}

export function inventoryPageHash(rows) {
  const payload = rows.map((row) => [
    row.sourceSkuNormalized,
    row.sourceImageUrl || "",
    row.warehouseName || "",
  ]);
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function redactProfileUrl(value) {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    const labels = parsed.hostname.split(".");
    if (labels.length > 2 && labels.slice(-2).join(".") === "mabangerp.com") {
      parsed.hostname = ["redacted", ...labels.slice(-2)].join(".");
    }
    for (const key of [...parsed.searchParams.keys()]) parsed.searchParams.set(key, "<redacted>");
    return parsed.toString();
  } catch {
    return null;
  }
}

export function sanitizeInterfaceProfile(profile = {}) {
  return {
    transport: text(profile.transport).slice(0, 24) || "unknown",
    url: redactProfileUrl(profile.url),
    method: text(profile.method).toUpperCase().slice(0, 12) || "GET",
    parameterKeys: [...new Set((profile.parameterKeys || []).map((item) => text(item).slice(0, 120)).filter(Boolean))].slice(0, 50),
    pageParameter: profile.pageParameter?.path ? text(profile.pageParameter.path).slice(0, 120) : null,
    pageSizeParameter: profile.pageSizeParameter?.path ? text(profile.pageSizeParameter.path).slice(0, 120) : null,
    currentPage: Number.isFinite(Number(profile.currentPage)) ? Number(profile.currentPage) : null,
    pageSize: Number.isFinite(Number(profile.pageSize)) ? Number(profile.pageSize) : null,
    total: Number.isFinite(Number(profile.total)) ? Number(profile.total) : null,
    totalPages: Number.isFinite(Number(profile.totalPages)) ? Number(profile.totalPages) : null,
    totalPath: text(profile.totalPath).slice(0, 160) || null,
    rowsPath: text(profile.rowsPath).slice(0, 160) || null,
    skuPath: text(profile.skuPath).slice(0, 160) || null,
    imagePath: text(profile.imagePath).slice(0, 160) || null,
    warehousePath: text(profile.warehousePath).slice(0, 160) || null,
    productNamePath: text(profile.productNamePath).slice(0, 160) || null,
    hasImages: Boolean(profile.hasImages),
  };
}

export function sanitizeStoredSourceUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) return null;
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (/(token|auth|sign|signature|secret|key|credential|expires)/i.test(key)) parsed.searchParams.delete(key);
    }
    return parsed.toString().slice(0, 2000);
  } catch {
    return null;
  }
}
