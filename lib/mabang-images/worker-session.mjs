import {
  analyzeInventoryPayload,
  normalizeDiscoveryRow,
  sanitizeInterfaceProfile,
} from "./extraction.mjs";

function sessionError(code, message, status = 502) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function decodeHtmlText(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, " ")
    .trim();
}

function attribute(tag, name) {
  const match = String(tag || "").match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match ? match[1] ?? match[2] ?? match[3] ?? null : null;
}

function htmlField(payload) {
  return Object.values(payload || {})
    .filter((value) => typeof value === "string" && /\bshopStock\b/i.test(value))
    .sort((left, right) => right.length - left.length)[0] || null;
}

export function parseInventoryHtmlRows(html, pageNumber = 1) {
  if (typeof html !== "string" || !html.trim()) return [];
  const rows = [];
  const skuPattern = /<([a-z0-9]+)\b[^>]*class\s*=\s*(?:"[^"]*\bshopStock\b[^"]*"|'[^']*\bshopStock\b[^']*')[^>]*>([\s\S]*?)<\/\1>/gi;
  let match;
  while ((match = skuPattern.exec(html))) {
    const prefixStart = Math.max(0, match.index - 15000);
    const prefix = html.slice(prefixStart, match.index);
    const rowStarts = [...prefix.matchAll(/<li\b[^>]*>\s*<ul\b/gi)];
    const rowStart = rowStarts.length ? prefixStart + rowStarts.at(-1).index : Math.max(0, match.index - 4000);
    const rowEndMarker = html.indexOf("</ul></li>", skuPattern.lastIndex);
    const rowEnd = rowEndMarker >= 0 ? rowEndMarker + 10 : Math.min(html.length, skuPattern.lastIndex + 5000);
    const segment = html.slice(rowStart, rowEnd);
    const imageTags = [...segment.matchAll(/<img\b[^>]*>/gi)].map((item) => item[0]);
    const backgroundStyles = [...segment.matchAll(/\bstyle\s*=\s*(?:"([^"]*url\([^"]*)"|'([^']*url\([^']*)')/gi)]
      .map((item) => item[1] || item[2]).filter(Boolean);
    const imageCandidates = [];
    for (const tag of imageTags) {
      for (const [url, sourceKind] of [
        [attribute(tag, "src"), "src"],
        [attribute(tag, "data-src") || attribute(tag, "data-original") || attribute(tag, "data-lazy-src"), "data_src"],
        [attribute(tag, "srcset") || attribute(tag, "data-srcset"), "srcset"],
      ]) {
        if (url) imageCandidates.push({ url, sourceKind });
      }
    }
    for (const style of backgroundStyles) {
      for (const found of style.matchAll(/url\(["']?([^"')]+)["']?\)/gi)) {
        if (found[1]) imageCandidates.push({ url: found[1], sourceKind: "background" });
      }
    }
    const imageTag = imageTags[0] || "";
    const warehouseMatch = segment.match(/<[^>]*class\s*=\s*(?:"[^"]*\bwarehouseIds\b[^"]*"|'[^']*\bwarehouseIds\b[^']*')[^>]*>([\s\S]*?)<\/[^>]+>/i);
    const productNames = [...segment.matchAll(/<(?:p|span)\b[^>]*(?:class\s*=\s*(?:"[^"]*\bellipsis\b[^"]*"|'[^']*\bellipsis\b[^']*')|data-field\s*=\s*(?:"[^"]*name[^"]*"|'[^']*name[^']*'))[^>]*>([\s\S]*?)<\/(?:p|span)>/gi)]
      .map((item) => decodeHtmlText(item[1])).filter(Boolean);
    const normalized = normalizeDiscoveryRow({
      sourceSku: decodeHtmlText(match[2]),
      productName: productNames.join(" / ") || null,
      warehouseName: decodeHtmlText(warehouseMatch?.[1]) || null,
      imageSrc: attribute(imageTag, "src"),
      imageDataSrc: attribute(imageTag, "data-src")
        || attribute(imageTag, "data-original")
        || attribute(imageTag, "data-lazy-src"),
      imageSrcset: attribute(imageTag, "srcset") || attribute(imageTag, "data-srcset"),
      imageBackgroundUrl: backgroundStyles[0] || null,
      imageCandidates,
    }, {
      pageNumber,
      rowNumber: rows.length + 1,
      sourceKind: "interface",
    });
    if (normalized) rows.push(normalized);
  }
  return rows;
}

function isMabangImageUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    return parsed.protocol === "https:"
      && (parsed.hostname === "mabangerp.com" || parsed.hostname.endsWith(".mabangerp.com"))
      && !parsed.username
      && !parsed.password;
  } catch {
    return false;
  }
}

async function readBoundedResponse(response, maxBytes) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) return { tooLarge: true, buffer: Buffer.alloc(0) };
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    return { tooLarge: buffer.length > maxBytes, buffer };
  }
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) {
      await reader.cancel();
      return { tooLarge: true, buffer: Buffer.alloc(0) };
    }
    chunks.push(Buffer.from(value));
  }
  return { tooLarge: false, buffer: Buffer.concat(chunks, size) };
}

export class MabangInventoryWorkerSession {
  constructor({
    runWorker,
    username,
    password,
    maxPages = 10000,
    maxSkus = 100,
    startPage = 1,
    maxImageBytes = 10 * 1024 * 1024,
    requestTimeoutMs = 30_000,
    onVerification = null,
    fetchImpl = fetch,
  }) {
    this.runWorker = runWorker;
    this.username = username;
    this.password = password;
    this.maxPages = Math.max(1, Math.min(Number(maxPages) || 10000, 10000));
    this.maxSkus = Math.max(1, Math.min(Number(maxSkus) || 100, 10000));
    this.startPage = Math.max(1, Number(startPage) || 1);
    this.maxImageBytes = Math.max(1024, Number(maxImageBytes) || 10 * 1024 * 1024);
    this.requestTimeoutMs = Math.max(1000, Number(requestTimeoutMs) || 30_000);
    this.onVerification = onVerification;
    this.fetchImpl = fetchImpl;
    this.pages = new Map();
  }

  async open() {
    try {
      const result = await this.runWorker({
        action: "inventory-images",
        username: this.username,
        password: this.password,
        maxPages: this.maxPages,
        maxSkus: this.maxSkus,
        startPage: this.startPage,
      });
      this.pages.clear();
      for (const page of result.pages || []) {
        const pageNumber = Math.max(1, Number(page.pageNumber) || 1);
        const analyzed = analyzeInventoryPayload(page.payload, { request: page.request, transport: "worker" });
        const rows = analyzed?.rows?.length
          ? analyzed.rows.map((row, index) => normalizeDiscoveryRow(row, {
            pageNumber,
            rowNumber: index + 1,
            sourceKind: "interface",
          })).filter(Boolean)
          : parseInventoryHtmlRows(htmlField(page.payload), pageNumber);
        this.pages.set(pageNumber, rows);
      }
      const discoveredRows = [...this.pages.values()].reduce((total, rows) => total + rows.length, 0);
      if (!discoveredRows) {
        throw sessionError(
          "MABANG_INVENTORY_ROWS_MISSING",
          "后台登录成功，但库存查询没有识别到 SKU 图片数据。",
          409,
        );
      }
      this.totalPages = Math.max(this.pages.size, Number(result.totalPages || 0));
      await this.onVerification?.("success", "后台登录和库存图片读取成功。");
      return {
        strategy: "worker",
        interfaceProfile: sanitizeInterfaceProfile({
          transport: "worker",
          method: "POST",
          parameterKeys: ["page", "rowsPerPage"],
          hasImages: [...this.pages.values()].some((rows) => rows.some((row) => row.sourceImageUrl)),
          total: Number(result.recordCount || 0) || null,
          pageSize: null,
          totalPages: this.totalPages,
        }),
        totalPages: this.totalPages,
      };
    } catch (error) {
      const message = String(error?.message || "");
      const code = error?.code || (/验证码|人工验证/.test(message)
        ? "MABANG_LOGIN_VERIFICATION_REQUIRED"
        : /登录|账号|密码/.test(message) ? "MABANG_LOGIN_FAILED" : "MABANG_INVENTORY_SOURCE_FAILED");
      const publicMessage = code === "MABANG_LOGIN_VERIFICATION_REQUIRED"
        ? "马帮登录需要人工验证，请先在账号配置中处理登录验证。"
        : code === "MABANG_LOGIN_FAILED"
          ? "马帮后台登录失败，请检查所选账号的用户名和密码。"
          : code === "MABANG_INVENTORY_ROWS_MISSING"
            ? message
            : "马帮库存图片读取失败，请稍后重试。";
      await this.onVerification?.("failed", publicMessage);
      throw sessionError(code, publicMessage, Number(error?.status || 502));
    }
  }

  async page(pageNumber) {
    const current = Math.max(1, Number(pageNumber) || 1);
    const segmentExhausted = !this.pages.has(current) && current <= (this.totalPages || 0);
    const rows = this.pages.get(current) || [];
    return {
      rows,
      currentPage: current,
      totalPages: this.totalPages || this.pages.size,
      hasNext: current < (this.totalPages || this.pages.size),
      segmentExhausted,
      strategy: "worker",
    };
  }

  async fetchImage(sourceUrl) {
    if (!isMabangImageUrl(sourceUrl)) {
      throw sessionError("MABANG_IMAGE_HOST_BLOCKED", "图片地址未通过马帮域名校验。", 403);
    }
    let response;
    try {
      response = await this.fetchImpl(sourceUrl, {
        redirect: "follow",
        signal: AbortSignal.timeout(this.requestTimeoutMs),
        headers: { "user-agent": "Mozilla/5.0 CommerceOps-Mabang-Image-Collector" },
      });
    } catch (error) {
      throw sessionError(
        error?.name === "TimeoutError" ? "IMAGE_DOWNLOAD_TIMEOUT" : "IMAGE_NETWORK_ERROR",
        "图片下载失败。",
        502,
      );
    }
    if (!isMabangImageUrl(response.url)) {
      throw sessionError("MABANG_IMAGE_REDIRECT_BLOCKED", "图片跳转地址未通过马帮域名校验。", 403);
    }
    const result = await readBoundedResponse(response, this.maxImageBytes);
    return {
      status: response.status,
      contentType: response.headers.get("content-type") || "",
      tooLarge: result.tooLarge,
      buffer: result.buffer,
    };
  }

  async close() {
    this.pages.clear();
    this.totalPages = 0;
    this.username = null;
    this.password = null;
  }
}
