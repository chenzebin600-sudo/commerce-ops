const TERMINAL_JOB_STATES = new Set(["completed", "partial", "failed"]);

function apiError(payload, status) {
  const error = new Error(String(payload?.message || payload?.error || `马帮刊登服务请求失败 (${status})`));
  error.status = status >= 400 && status < 500 ? status : 502;
  error.code = String(payload?.code || "MABANG_LISTING_REQUEST_FAILED");
  return error;
}

export class MabangListingInternalClient {
  constructor({ baseUrl, internalToken, fetchImpl = fetch, timeoutMs = 5 * 60_000, listingPageRetries = 2 }) {
    this.baseUrl = String(baseUrl || "").replace(/\/$/, "");
    this.internalToken = String(internalToken || "");
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.listingPageRetries = Math.max(0, Number(listingPageRetries || 0));
  }

  async request(path, { method = "GET", body, timeoutMs = this.timeoutMs } = {}) {
    const headers = { accept: "application/json", "x-commerce-ops-internal-token": this.internalToken };
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.success === false) throw apiError(payload, response.status);
    return payload;
  }

  login({ username, password, accountHost = "900445.private.mabangerp.com" }) {
    return this.request("/api/session/login", {
      method: "POST",
      body: { username, password, account_host: accountHost },
    });
  }

  async shops(platform) {
    const normalizedPlatform = String(platform || "").trim().toLowerCase();
    if (!new Set(["shopee", "lazada"]).has(normalizedPlatform)) {
      throw new Error(`Unsupported marketplace platform: ${normalizedPlatform || "empty"}`);
    }
    return (await this.request(`/api/shops?platform=${encodeURIComponent(normalizedPlatform)}`)).shops || [];
  }

  shopeeShops() {
    return this.shops("shopee");
  }

  lazadaShops() {
    return this.shops("lazada");
  }

  async listings(platform, shopIds, { refresh = true, pageSize = 500, onProgress } = {}) {
    const normalizedPlatform = String(platform || "").trim().toLowerCase();
    if (!new Set(["shopee", "lazada"]).has(normalizedPlatform)) {
      throw new Error(`Unsupported marketplace platform: ${normalizedPlatform || "empty"}`);
    }
    const platformLabel = normalizedPlatform === "lazada" ? "Lazada" : "Shopee";
    const normalizedShopIds = [...new Set((shopIds || []).map(String).map((value) => value.trim()).filter(Boolean))].sort();
    if (!normalizedShopIds.length) return [];
    const items = [];
    const startedAt = Date.now();
    let page = 1;
    let total = Number.POSITIVE_INFINITY;
    while (items.length < total) {
      const params = new URLSearchParams({
        platform: normalizedPlatform,
        state: "online",
        page: String(page),
        page_size: String(pageSize),
        shop_id: normalizedShopIds.join(","),
      });
      // Every page in a fresh read must bypass the page-keyed five-minute cache.
      // Refreshing page one only can otherwise mix new and stale listing pages.
      if (refresh) params.set("refresh", "1");
      let result;
      let rows;
      let reportedTotal;
      let retry = 0;
      while (true) {
        try {
          result = await this.request(`/api/listings?${params}`);
          rows = Array.isArray(result.items) ? result.items : [];
          reportedTotal = Math.max(0, Number(result.total ?? rows.length));
          const countDrift = page > 1 && reportedTotal !== total;
          const incompletePage = page > 1 && !rows.length && items.length < total;
          if (!countDrift && !incompletePage) break;
          const error = countDrift
            ? Object.assign(new Error(`${platformLabel} 在线商品分页总数发生变化：第一页 ${total}，第 ${page} 页 ${reportedTotal}。请重新预检。`), {
              code: "INVENTORY_SYNC_LISTING_COUNT_DRIFT",
            })
            : Object.assign(new Error(`${platformLabel} 在线商品第 ${page} 页为空，但仍有 ${total - items.length} 条未读取。`), {
              code: "INVENTORY_SYNC_LISTING_PAGE_INCOMPLETE",
            });
          if (retry >= this.listingPageRetries) throw error;
          retry += 1;
          await onProgress?.({ stage: "RETRYING", page, retry, fetched: items.length, total });
        } catch (error) {
          if (retry >= this.listingPageRetries) throw error;
          retry += 1;
          await onProgress?.({ stage: "RETRYING", page, retry, fetched: items.length, total: Number.isFinite(total) ? total : null });
        }
      }
      if (page === 1) total = reportedTotal;
      items.push(...rows);
      await onProgress?.({
        stage: "READING",
        page,
        pageCount: Number.isFinite(total) ? Math.max(1, Math.ceil(total / pageSize)) : null,
        fetched: Math.min(items.length, total),
        total,
        retry,
        elapsedMs: Date.now() - startedAt,
      });
      if (items.length >= total) break;
      if (!rows.length) {
        throw Object.assign(new Error(`${platformLabel} 在线商品第 ${page} 页为空，但仍有 ${total - items.length} 条未读取。`), {
          code: "INVENTORY_SYNC_LISTING_PAGE_INCOMPLETE",
        });
      }
      page += 1;
      if (page > 200) throw Object.assign(new Error(`${platformLabel} 在线商品分页超过安全上限。`), { code: "INVENTORY_SYNC_LISTING_PAGE_LIMIT" });
    }
    if (items.length !== total) {
      throw Object.assign(new Error(`${platformLabel} 在线商品读取数量不一致：预期 ${total}，实际 ${items.length}。`), {
        code: "INVENTORY_SYNC_LISTING_COUNT_MISMATCH",
      });
    }
    Object.defineProperty(items, "readMetrics", {
      value: {
        shopCount: normalizedShopIds.length,
        pageCount: page,
        listingCount: items.length,
        durationMs: Date.now() - startedAt,
        fresh: refresh === true,
      },
      enumerable: false,
    });
    return items;
  }

  shopeeListings(shopIds, options) {
    return this.listings("shopee", shopIds, options);
  }

  lazadaListings(shopIds, options) {
    return this.listings("lazada", shopIds, options);
  }

  inventoryPreview(items) {
    return this.request("/api/inventory-sync/preview", { method: "POST", body: { items } });
  }

  skuRebindPreview(items) {
    return this.request("/api/sku-rebind/preview", { method: "POST", body: { items } });
  }

  executePreview(previewToken, selectedChangeIds) {
    return this.request("/api/batch/execute", {
      method: "POST",
      body: { preview_token: previewToken, selected_change_ids: selectedChangeIds },
    });
  }

  job(jobId) {
    return this.request(`/api/jobs/${encodeURIComponent(jobId)}`);
  }

  async waitForJob(jobId, { timeoutMs = 2 * 60 * 60_000, intervalMs = 1_000, onProgress } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const job = await this.job(jobId);
      if (typeof onProgress === "function") await onProgress(job);
      if (TERMINAL_JOB_STATES.has(String(job.state || "").toLowerCase())) return job;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw Object.assign(new Error("马帮库存任务已提交，但等待回读超时。"), {
      code: "INVENTORY_SYNC_READBACK_TIMEOUT",
      resultUnknown: true,
      jobId,
    });
  }
}
