import {
  analyzeInventoryPayload,
  filenameSkuFromUrl,
  normalizeDiscoveryRow,
  normalizeSku,
  sanitizeInterfaceProfile,
} from "./extraction.mjs";

const INVENTORY_LABELS = ["库存查询", "库存", "stock", "inventory"];
const SAFE_MAX_PAGES = 10000;

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function publicError(code, message, status = 502) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function isMabangUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && (parsed.hostname === "mabangerp.com" || parsed.hostname.endsWith(".mabangerp.com"));
  } catch { return false; }
}

function setObjectPath(target, path, value) {
  const parts = String(path || "").replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  if (!parts.length) return false;
  let cursor = target;
  for (const key of parts.slice(0, -1)) {
    if (!cursor || typeof cursor !== "object" || !(key in cursor)) return false;
    cursor = cursor[key];
  }
  cursor[parts.at(-1)] = value;
  return true;
}

export function requestForPage(request, profile, pageNumber, pageSize = null) {
  const url = new URL(request.url);
  let postData = request.postData || "";
  const page = profile.pageParameter;
  const size = profile.pageSizeParameter;
  const updateQuery = (parameter, value) => {
    if (parameter?.source === "query" && value != null) url.searchParams.set(parameter.path, String(value));
  };
  updateQuery(page, pageNumber);
  updateQuery(size, pageSize);
  if ((page?.source === "json" || size?.source === "json") && postData) {
    const parsed = JSON.parse(postData);
    if (page?.source === "json") setObjectPath(parsed, page.path, pageNumber);
    if (size?.source === "json" && pageSize != null) setObjectPath(parsed, size.path, pageSize);
    postData = JSON.stringify(parsed);
  } else if ((page?.source === "form" || size?.source === "form") && postData) {
    const form = new URLSearchParams(postData);
    if (page?.source === "form") form.set(page.path, String(pageNumber));
    if (size?.source === "form" && pageSize != null) form.set(size.path, String(pageSize));
    postData = form.toString();
  }
  return { ...request, url: url.toString(), postData };
}

export function selectInventoryCapture(captures) {
  return (captures || []).map((capture) => {
    const analyzed = analyzeInventoryPayload(capture.payload, { request: capture.request, transport: capture.transport });
    return analyzed ? { ...capture, analyzed } : null;
  }).filter(Boolean).sort((left, right) => {
    const imageDelta = Number(right.analyzed.profile.hasImages) - Number(left.analyzed.profile.hasImages);
    return imageDelta || right.analyzed.confidence - left.analyzed.confidence || right.analyzed.rows.length - left.analyzed.rows.length;
  })[0] || null;
}

function safeReplayHeaders(headers = {}) {
  const blocked = /^(?:cookie|host|content-length|origin|referer|connection|accept-encoding|sec-|proxy-)/i;
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !blocked.test(name)));
}

const DOM_INVENTORY_SCRIPT = String.raw`(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
  const rowSelectors = ['table tbody tr', '[role="rowgroup"] [role="row"]', '.el-table__body-wrapper tbody tr', '.ant-table-tbody tr'];
  const allRows = () => [...new Set(rowSelectors.flatMap((selector) => [...document.querySelectorAll(selector)]))].filter(visible);
  const containers = [...document.querySelectorAll('*')].filter((el) => visible(el) && el.scrollHeight > el.clientHeight + 40);
  containers.sort((a, b) => (allRows().some((row) => a.contains(row)) ? -1 : 1) - (allRows().some((row) => b.contains(row)) ? -1 : 1));
  const scroller = containers.find((el) => allRows().some((row) => el.contains(row))) || document.scrollingElement;
  if (scroller) {
    for (let top = 0; top < scroller.scrollHeight; top += Math.max(160, Math.floor(scroller.clientHeight * 0.7))) {
      scroller.scrollTop = top;
      await sleep(120);
    }
    scroller.scrollTop = scroller.scrollHeight;
    await sleep(500);
  }
  const rows = allRows();
  const headerCells = [...document.querySelectorAll('table thead th,[role="columnheader"]')];
  const headers = headerCells.map((el) => (el.innerText || el.textContent || '').trim().toLowerCase());
  const skuIndexes = headers.map((value, index) => /(^|\s)sku($|\s)|库存.*(?:编号|编码)|(?:编号|编码).*库存/i.test(value) ? index : -1).filter((index) => index >= 0);
  const nameIndexes = headers.map((value, index) => /商品名称|产品名称|品名|product.*name|item.*name/i.test(value) ? index : -1).filter((index) => index >= 0);
  const warehouseIndexes = headers.map((value, index) => /仓库|库房|warehouse/i.test(value) ? index : -1).filter((index) => index >= 0);
  const readCell = (cells, indexes) => indexes.map((index) => (cells[index]?.innerText || cells[index]?.textContent || '').trim()).find(Boolean) || null;
  const data = rows.map((row, index) => {
    const cells = [...row.querySelectorAll(':scope > td,:scope > [role="cell"]')];
    const explicitSku = row.querySelector('[data-sku],[data-field*="sku" i],[class*="sku" i]');
    const sourceSku = readCell(cells, skuIndexes) || explicitSku?.getAttribute('data-sku') || explicitSku?.innerText?.trim() || null;
    if (!sourceSku) return null;
    const image = row.querySelector('img');
    const backgroundNode = [...row.querySelectorAll('*')].find((el) => /url\(/i.test(getComputedStyle(el).backgroundImage));
    return {
      sourceSku,
      productName: readCell(cells, nameIndexes),
      warehouseName: readCell(cells, warehouseIndexes),
      imageSrc: image?.getAttribute('src') || image?.currentSrc || null,
      imageDataSrc: image?.getAttribute('data-src') || image?.getAttribute('data-original') || image?.getAttribute('data-lazy-src') || null,
      imageSrcset: image?.getAttribute('srcset') || image?.getAttribute('data-srcset') || null,
      imageBackgroundUrl: backgroundNode ? getComputedStyle(backgroundNode).backgroundImage : null,
      rowNumber: index + 1,
    };
  }).filter(Boolean);
  const text = document.body?.innerText || '';
  const current = document.querySelector('[aria-current="page"],.active.el-pager__number,.ant-pagination-item-active');
  const totalMatch = text.match(/共\s*(\d+)\s*(?:条|项|页)/);
  const next = [...document.querySelectorAll('button,a,li')].find((el) => visible(el) && /下一页|next/i.test((el.innerText || el.getAttribute('aria-label') || el.title || '').trim()));
  return {
    rows: data,
    currentPage: Number((current?.innerText || current?.textContent || '').trim()) || null,
    total: totalMatch ? Number(totalMatch[1]) : null,
    nextDisabled: !next || next.disabled || next.getAttribute('aria-disabled') === 'true' || next.classList.contains('disabled'),
    rowCount: data.length,
  };
})()`;

const NAVIGATE_INVENTORY_SCRIPT = String.raw`(() => {
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const labels = ['商品', '库存查询'];
  let clicked = false;
  for (const label of labels) {
    const node = [...document.querySelectorAll('a,button,[role="menuitem"],li,span')]
      .find((el) => visible(el) && (el.innerText || el.textContent || '').trim() === label);
    if (node) { node.click(); clicked = true; }
  }
  return { clicked, title: document.title, bodyText: (document.body?.innerText || '').slice(0, 5000) };
})()`;

const NEXT_PAGE_SCRIPT = String.raw`(() => {
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const next = [...document.querySelectorAll('button,a,li')].find((el) => visible(el) && /下一页|next/i.test((el.innerText || el.getAttribute('aria-label') || el.title || '').trim()));
  if (!next || next.disabled || next.getAttribute('aria-disabled') === 'true' || next.classList.contains('disabled')) return false;
  next.click(); return true;
})()`;

const PAGE_SIZE_SCRIPT = String.raw`(() => {
  const roots = [...document.querySelectorAll('[class*="pagination" i],[class*="pager" i],[aria-label*="page" i]')];
  const values = roots.flatMap((root) => [...root.querySelectorAll('option,[role="option"]')])
    .map((node) => Number((node.value || node.innerText || node.textContent || '').match(/\d+/)?.[0]))
    .filter((value) => Number.isInteger(value) && value >= 10 && value <= 1000);
  return values.length ? Math.max(...values) : null;
})()`;

const INITIALIZATION_JSON_SCRIPT = String.raw`(() => [...document.querySelectorAll('script[type="application/json"],script#__NEXT_DATA__')]
  .slice(0,20).map((node) => (node.textContent || '').trim()).filter((text) => text.length > 1 && text.length <= 2000000))()`;

async function evaluate(cdp, expression, { awaitPromise = true, contextId = null } = {}) {
  const message = await cdp.send("Runtime.evaluate", {
    expression, awaitPromise, returnByValue: true, userGesture: true,
    ...(contextId ? { contextId } : {}),
  });
  if (message?.error) throw publicError("MABANG_CDP_REQUEST_FAILED", "马帮浏览器调试请求失败。 ");
  const result = message?.result || message;
  if (result?.exceptionDetails) throw publicError("MABANG_PAGE_EVALUATION_FAILED", "马帮库存页面读取失败。 ");
  return result?.result?.value ?? result?.value;
}

export class MabangInventoryBrowserSession {
  constructor({ targetProvider, connectCdp, wait = delay, responseWindowMs = 2500, maxPages = SAFE_MAX_PAGES }) {
    this.targetProvider = targetProvider;
    this.connect = connectCdp;
    this.wait = wait;
    this.responseWindowMs = responseWindowMs;
    this.maxPages = Math.max(1, Math.min(Number(maxPages) || SAFE_MAX_PAGES, SAFE_MAX_PAGES));
    this.cdp = null;
    this.capture = null;
    this.captures = [];
    this.responseRequests = new Map();
    this.currentDomPage = 1;
    this.cosImageUrls = new Set();
    this.pageSizeMaximum = null;
    this.frameContexts = new Map();
    this.topFrameId = null;
  }

  async refreshFrameContexts() {
    const message = await this.cdp.send("Page.getFrameTree");
    const frameTree = (message?.result || message)?.frameTree;
    const frames = [];
    const visit = (node) => {
      if (!node?.frame?.id) return;
      frames.push(node.frame);
      for (const child of node.childFrames || []) visit(child);
    };
    visit(frameTree);
    this.topFrameId = frames[0]?.id || null;
    this.frameContexts.clear();
    for (const frame of frames) {
      try {
        const world = await this.cdp.send("Page.createIsolatedWorld", {
          frameId: frame.id,
          worldName: `commerce-ops-mabang-images-${frame.id}`,
          grantUniveralAccess: false,
        });
        const contextId = Number((world?.result || world)?.executionContextId || 0);
        if (contextId) this.frameContexts.set(frame.id, contextId);
      } catch {}
    }
  }

  async evaluateAcrossFrames(expression, options = {}) {
    const contexts = this.frameContexts.size ? [...this.frameContexts.entries()] : [[null, null]];
    const results = [];
    for (const [frameId, contextId] of contexts) {
      try { results.push({ frameId, value: await evaluate(this.cdp, expression, { ...options, contextId }) }); } catch {}
    }
    return results;
  }

  async open() {
    const targets = await this.targetProvider();
    const target = (targets || []).find((item) => item.type === "page" && isMabangUrl(item.url));
    if (!target?.webSocketDebuggerUrl) {
      throw publicError("MABANG_SESSION_UNAVAILABLE", "未找到已登录的马帮浏览器页面，请先用现有马帮账号会话登录。", 409);
    }
    this.cdp = await this.connect(target.webSocketDebuggerUrl);
    this.cdp.on("Network.requestWillBeSent", ({ requestId, request, type, frameId }) => {
      if (/^https:\/\/stock-cos\.mabangerp\.com\//i.test(request.url || "")) this.cosImageUrls.add(request.url);
      if (["XHR", "Fetch"].includes(type) || /graphql/i.test(request.url || "")) this.responseRequests.set(requestId, { request, type, frameId });
    });
    this.cdp.on("Network.loadingFinished", async ({ requestId }) => {
      const entry = this.responseRequests.get(requestId);
      if (!entry) return;
      try {
        const message = await this.cdp.send("Network.getResponseBody", { requestId });
        const body = message.result || message;
        const source = body.base64Encoded ? Buffer.from(body.body, "base64").toString("utf8") : body.body;
        const payload = JSON.parse(source);
        this.captures.push({ payload, request: entry.request, frameId: entry.frameId,
          transport: /graphql/i.test(entry.request.url) ? "graphql" : entry.type.toLowerCase() });
      } catch {}
    });
    await this.cdp.send("Runtime.enable");
    await this.cdp.send("Page.enable");
    await this.cdp.send("Network.enable", { maxTotalBufferSize: 50 * 1024 * 1024, maxResourceBufferSize: 10 * 1024 * 1024 });
    await this.refreshFrameContexts();
    await this.evaluateAcrossFrames(NAVIGATE_INVENTORY_SCRIPT);
    await this.wait(500);
    await this.refreshFrameContexts();
    const navigationResults = await this.evaluateAcrossFrames(NAVIGATE_INVENTORY_SCRIPT);
    const navigation = navigationResults.map((item) => item.value).find((item) => INVENTORY_LABELS.some((label) => String(item?.bodyText || "").toLowerCase().includes(label.toLowerCase())))
      || navigationResults[0]?.value;
    await this.wait(this.responseWindowMs);
    if (!this.captures.length && INVENTORY_LABELS.some((label) => String(navigation?.bodyText || "").toLowerCase().includes(label.toLowerCase()))) {
      await this.cdp.send("Page.reload", { ignoreCache: false });
      await this.wait(this.responseWindowMs);
      await this.refreshFrameContexts();
    }
    const initializationResults = await this.evaluateAcrossFrames(INITIALIZATION_JSON_SCRIPT);
    for (const result of initializationResults) {
      for (const source of result.value || []) {
        try {
          this.captures.push({ payload: JSON.parse(source), request: { url: target.url, method: "GET" },
            frameId: result.frameId, transport: "initialization_json" });
        } catch {}
      }
    }
    const sizes = (await this.evaluateAcrossFrames(PAGE_SIZE_SCRIPT)).map((item) => Number(item.value)).filter(Number.isFinite);
    this.pageSizeMaximum = sizes.length ? Math.max(...sizes) : null;
    this.capture = selectInventoryCapture(this.captures.filter((item) => item.transport !== "initialization_json"))
      || selectInventoryCapture(this.captures);
    if (this.capture) {
      const profile = this.capture.analyzed.profile;
      this.interfaceEnabled = profile.hasImages && this.capture.transport !== "initialization_json";
      return {
        strategy: this.interfaceEnabled ? "interface" : "dom",
        interfaceProfile: sanitizeInterfaceProfile(profile),
        totalPages: profile.totalPages || (profile.total && profile.pageSize ? Math.ceil(profile.total / profile.pageSize) : null),
      };
    }
    return { strategy: "dom", interfaceProfile: sanitizeInterfaceProfile({ transport: "dom" }), totalPages: null };
  }

  async page(pageNumber) {
    if (!this.cdp) throw publicError("MABANG_SESSION_NOT_OPEN", "马帮浏览器会话尚未初始化。", 409);
    if (pageNumber > this.maxPages) throw publicError("SAFE_MAX_PAGES_REACHED", "已达到采集安全最大页数。", 409);
    if (this.interfaceEnabled) return this.interfacePage(pageNumber);
    return this.domPage(pageNumber);
  }

  async interfacePage(pageNumber) {
    const { request, analyzed } = this.capture;
    const profile = analyzed.profile;
    const preferredPageSize = Math.max(1, Math.min(1000, Number(this.pageSizeMaximum || profile.pageSize || analyzed.rows.length || 100)));
    const replay = requestForPage(request, profile, pageNumber, preferredPageSize);
    if (!isMabangUrl(replay.url)) throw publicError("MABANG_INTERFACE_HOST_BLOCKED", "库存接口域名未通过马帮域名校验。", 403);
    const input = JSON.stringify({ url: replay.url, method: replay.method || "GET", headers: safeReplayHeaders(replay.headers), body: replay.postData || null });
    const expression = `(async () => { const request=${input}; const response=await fetch(request.url,{method:request.method,headers:request.headers,body:/^(GET|HEAD)$/i.test(request.method)?undefined:request.body,credentials:'include',redirect:'follow'}); return {status:response.status,text:await response.text()}; })()`;
    const response = await evaluate(this.cdp, expression, { contextId: this.frameContexts.get(this.capture.frameId) || null });
    if (Number(response?.status) !== 200) throw publicError(`MABANG_INTERFACE_HTTP_${response?.status || 0}`, "马帮库存接口分页请求失败。 ");
    let payload;
    try { payload = JSON.parse(response.text); } catch { throw publicError("MABANG_INTERFACE_JSON_INVALID", "马帮库存接口返回了非 JSON 内容。 "); }
    const result = analyzeInventoryPayload(payload, { request: replay, transport: analyzed.transport });
    if (!result) throw publicError("MABANG_INTERFACE_ROWS_MISSING", "库存接口响应中没有识别到 SKU 行。 ");
    return {
      rows: result.rows.map((row, index) => normalizeDiscoveryRow(row, { pageNumber, rowNumber: index + 1, sourceKind: "interface" })).filter(Boolean),
      currentPage: result.profile.currentPage || pageNumber,
      totalPages: result.profile.totalPages || (result.profile.total && result.profile.pageSize ? Math.ceil(result.profile.total / result.profile.pageSize) : null),
      hasNext: result.rows.length > 0 && !(result.profile.totalPages && pageNumber >= result.profile.totalPages),
      strategy: "interface",
    };
  }

  async domPage(pageNumber) {
    if (pageNumber < this.currentDomPage) throw publicError("DOM_PAGE_SEQUENCE_INVALID", "页面兜底采集不能倒序翻页。", 409);
    while (pageNumber > this.currentDomPage) {
      const advanced = (await this.evaluateAcrossFrames(NEXT_PAGE_SCRIPT)).some((item) => item.value === true);
      if (!advanced) return { rows: [], currentPage: this.currentDomPage, totalPages: this.currentDomPage, hasNext: false, strategy: "dom" };
      this.currentDomPage += 1;
      await this.wait(800);
    }
    const payloads = (await this.evaluateAcrossFrames(DOM_INVENTORY_SCRIPT)).map((item) => item.value).filter(Boolean)
      .sort((left, right) => Number(right.rowCount || right.rows?.length || 0) - Number(left.rowCount || left.rows?.length || 0));
    const payload = payloads[0] || { rows: [], nextDisabled: true, rowCount: 0 };
    const rows = (payload?.rows || []).map((source, index) => {
      let sourceKind = "dom";
      let candidate = source;
      if (!normalizeDiscoveryRow(source, { pageNumber, rowNumber: source.rowNumber || index + 1, sourceKind })?.sourceImageUrl) {
        const networkUrl = [...this.cosImageUrls].find((url) => normalizeSku(filenameSkuFromUrl(url)) === normalizeSku(source.sourceSku));
        if (networkUrl) { candidate = { ...source, sourceImageUrl: networkUrl }; sourceKind = "cos_network"; }
      }
      return normalizeDiscoveryRow(candidate, {
        pageNumber, rowNumber: source.rowNumber || index + 1, sourceKind,
      });
    }).filter(Boolean);
    return {
      rows,
      currentPage: payload?.currentPage || pageNumber,
      totalPages: null,
      hasNext: !payload?.nextDisabled && rows.length > 0,
      strategy: "dom",
      visibleRowCount: Number(payload?.rowCount || rows.length),
    };
  }

  async fetchImage(sourceUrl, { maxBytes = 10 * 1024 * 1024, timeoutMs = 30000 } = {}) {
    if (!isMabangUrl(sourceUrl)) throw publicError("IMAGE_HOST_BLOCKED", "图片域名未通过马帮域名校验。", 403);
    const input = JSON.stringify({ url: sourceUrl, maxBytes, timeoutMs });
    const expression = `(async () => { const input=${input}; try { const response=await fetch(input.url,{credentials:'include',redirect:'follow',signal:AbortSignal.timeout(input.timeoutMs)}); const blob=await response.blob(); if(blob.size>input.maxBytes)return {status:response.status,responseUrl:response.url,contentType:response.headers.get('content-type'),tooLarge:true,size:blob.size}; const bytes=new Uint8Array(await blob.arrayBuffer()); let binary=''; for(let i=0;i<bytes.length;i+=0x8000)binary+=String.fromCharCode(...bytes.subarray(i,i+0x8000)); return {status:response.status,responseUrl:response.url,contentType:response.headers.get('content-type'),body:btoa(binary),size:bytes.length}; } catch(error) { return {networkError:error?.name==='TimeoutError'?'timeout':'network'}; } })()`;
    const contextId = this.frameContexts.get(this.capture?.frameId) || this.frameContexts.get(this.topFrameId) || null;
    const result = await evaluate(this.cdp, expression, { contextId });
    if (result?.networkError) throw publicError(result.networkError === "timeout" ? "IMAGE_DOWNLOAD_TIMEOUT" : "IMAGE_NETWORK_ERROR", "图片下载网络请求失败。", 502);
    if (result?.responseUrl && !isMabangUrl(result.responseUrl)) throw publicError("IMAGE_REDIRECT_BLOCKED", "图片跳转目标未通过马帮域名校验。", 403);
    return { ...result, buffer: result?.body ? Buffer.from(result.body, "base64") : Buffer.alloc(0) };
  }

  async close() {
    try { this.cdp?.close(); } catch {}
    this.cdp = null;
  }
}
