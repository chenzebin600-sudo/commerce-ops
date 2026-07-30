function scanFailureCategory(error) {
  const text = `${error?.code || ""} ${error?.message || ""}`;
  return /(LOGIN|AUTH|SESSION|UNAUTHENTICATED|COOKIE|CAPTCHA|登录|会话|验证码|未授权)/i.test(text) ? "login" : "scan";
}

export class FulfillmentPreviewScheduler {
  constructor({ config, service, services = null, scanSource = null, messageReviewRecovery = null, notifier = { notify() {} }, now = () => new Date(), logger = console,
    setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout }) {
    this.config = config;
    this.services = services?.length ? services : [service];
    this.service = service || this.services[0];
    this.now = now;
    this.logger = logger;
    this.notifier = notifier;
    this.scanSource = scanSource;
    this.messageReviewRecovery = messageReviewRecovery;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.timer = null;
    this.scanPromise = null;
    this.lastRunAt = null;
    this.lastOutcome = "not_run";
    this.lastMessage = "尚未执行扫描";
    this.nextRunAt = null;
    this.nextServiceIndex = 0;
    this.lastScanStrategy = null;
    this.lastSharedCollectionMs = null;
    this.lastManualRecoveries = [];
    this.lastTrackingRecoveries = [];
    this.lastMessageReviewRecovery = null;
    this.lastMessageReviewCheckAt = null;
    this.messageReviewFollowUpTimer = null;
    this.messageReviewFollowUpAt = null;
    this.pendingMessageReviewFollowUps = new Map();
  }

  status() {
    const activeBatch = this.service.getActiveBatch();
    const pendingPreviews = this.service.listPendingPreviewSummaries();
    const recentScans = this.service.listRecentScanRuns();
    const latestPersistedScan = recentScans[0] || null;
    return {
      enabled: Boolean(this.config.schedulerEnabled),
      autoFulfillEnabled: Boolean(this.config.autoFulfillEnabled),
      autoFulfillShops: this.services.filter((shopService) => shopService.config?.autoFulfillEnabled)
        .map((shopService) => ({ id: shopService.config.shopId, name: shopService.config.shopName })),
      intervalSeconds: this.config.schedulerIntervalSeconds,
      nextRunAt: this.nextRunAt,
      scanning: Boolean(this.scanPromise),
      lastRunAt: this.lastRunAt || latestPersistedScan?.startedAt || null,
      lastOutcome: this.lastRunAt ? this.lastOutcome : latestPersistedScan?.outcome || this.lastOutcome,
      lastMessage: this.lastRunAt ? this.lastMessage : latestPersistedScan?.message || this.lastMessage,
      activeBatch: activeBatch ? { id: activeBatch.id, status: activeBatch.status, createdAt: activeBatch.createdAt } : null,
      pendingPreview: pendingPreviews[0] || null,
      pendingPreviews,
      recentScans,
      lastScanStrategy: this.lastScanStrategy,
      lastSharedCollectionMs: this.lastSharedCollectionMs,
      lastManualRecoveries: this.lastManualRecoveries,
      lastTrackingRecoveries: this.lastTrackingRecoveries,
      messageReviewRecoveryEnabled: Boolean(this.config.messageReviewRecoveryEnabled),
      messageReviewRecoveryIntervalMinutes: this.config.messageReviewRecoveryIntervalMinutes,
      lastMessageReviewCheckAt: this.lastMessageReviewCheckAt,
      lastMessageReviewRecovery: this.lastMessageReviewRecovery,
      messageReviewFollowUpDelaySeconds: this.config.messageReviewFollowUpDelaySeconds,
      messageReviewFollowUpAt: this.messageReviewFollowUpAt,
      messageReviewFollowUpPendingCount: [...this.pendingMessageReviewFollowUps.values()]
        .reduce((sum, orderIds) => sum + orderIds.size, 0),
    };
  }

  queueMessageReviewFollowUp(items, { delaySeconds = this.config.messageReviewFollowUpDelaySeconds } = {}) {
    for (const item of Array.isArray(items) ? items : []) {
      const shopId = String(item?.shopId || "").trim();
      const references = Array.isArray(item?.orderIds) ? item.orderIds
        : [item?.platformOrderId || item?.orderId].filter(Boolean);
      if (!shopId || !this.services.some((shopService) => String(shopService.config?.shopId) === shopId)) continue;
      const queued = this.pendingMessageReviewFollowUps.get(shopId) || new Set();
      for (const reference of references) {
        const orderId = String(reference || "").trim();
        if (orderId && queued.size < this.config.maxBatchSize) queued.add(orderId);
      }
      if (queued.size) this.pendingMessageReviewFollowUps.set(shopId, queued);
    }
    if (!this.pendingMessageReviewFollowUps.size || this.messageReviewFollowUpTimer) return;
    const seconds = Math.max(5, Math.min(Number(delaySeconds) || 30, 300));
    this.messageReviewFollowUpAt = new Date(this.now().getTime() + seconds * 1000).toISOString();
    this.messageReviewFollowUpTimer = this.setTimeoutFn(async () => {
      this.messageReviewFollowUpTimer = null;
      this.messageReviewFollowUpAt = null;
      if (this.scanPromise || this.service.getActiveBatch()) {
        this.queueMessageReviewFollowUp([], { delaySeconds: Math.min(seconds, 15) });
        return;
      }
      const targets = [...this.pendingMessageReviewFollowUps.entries()]
        .map(([shopId, orderIds]) => ({ shopId, orderIds: [...orderIds] }));
      this.pendingMessageReviewFollowUps.clear();
      try { await this.scanNow({ messageReviewFollowUp: targets }); }
      catch (error) { this.logger.error?.(`Message review follow-up scan failed: ${error?.code || "SCAN_FAILED"}`); }
    }, seconds * 1000);
    this.messageReviewFollowUpTimer.unref?.();
  }

  finishRun({ startedAt, outcome, message, eligibleCount = 0, excludedCount = 0, previewId = null, details = null }) {
    this.lastOutcome = outcome;
    this.lastMessage = message;
    this.service.recordScanRun({ startedAt, finishedAt: this.now().toISOString(), outcome, message,
      eligibleCount, excludedCount, previewId, details });
    if (outcome === "preview_created") this.notifier.notify({ title: "马帮有订单待确认", message });
    if (outcome === "auto_fulfillment_started") this.notifier.notify({ title: "马帮自动发货已启动", message });
    const loginFailures = details?.failures?.filter((failure) => failure.category === "login") || [];
    if (loginFailures.length) {
      const nowIso = this.now().toISOString();
      const due = loginFailures.filter((failure) => this.service.repository.claimAlertNotification({
        fingerprint: `login:${failure.shopId || failure.shopName || "account"}`, alertType: "login", nowIso, cooldownMinutes: 30,
      }));
      if (due.length) this.notifier.notify({ title: "马帮登录状态异常",
        message: `${due.map((item) => item.shopName).join("、")} 无法读取订单，请重新登录马帮后刷新。` });
    } else if (outcome === "scan_failed" || outcome === "partial_scan_failed") {
      this.notifier.notify({ title: "马帮定时扫描失败", message });
    }
    return this.status();
  }

  notifyPreviewRisks(previews) {
    const nowIso = this.now().toISOString();
    const fresh = { inventory: [], multi_warehouse: [] };
    for (const preview of previews) for (const order of preview.excludedOrders || []) {
      const codes = new Set(order.exclusions || []);
      const type = codes.has("MULTI_WAREHOUSE_REQUIRES_REVIEW") ? "multi_warehouse"
        : codes.has("OUT_OF_STOCK") || codes.has("INVENTORY_UNKNOWN") ? "inventory" : null;
      if (!type) continue;
      const claimed = this.service.repository.claimAlertNotification({
        fingerprint: `${type}:${preview.shop?.id}:${order.displayOrderId}`, alertType: type, nowIso, cooldownMinutes: 360,
      });
      if (claimed) fresh[type].push({ preview, order });
    }
    if (fresh.multi_warehouse.length) this.notifier.notify({ title: "发现多仓订单",
      message: `${fresh.multi_warehouse.length} 单因 SKU 仓库不一致已停止发货，请打开异常中心处理。` });
    if (fresh.inventory.length) this.notifier.notify({ title: "发现库存异常",
      message: `${fresh.inventory.length} 单库存不足或状态未知，系统未提交发货。` });
  }

  notifyShippingDeadlines(previews) {
    const nowIso = this.now().toISOString();
    const due = [];
    for (const preview of previews) for (const order of [...(preview.eligibleOrders || []), ...(preview.excludedOrders || [])]) {
      if (order.shippingRemainingMinutes == null) continue;
      const minutes = Number(order.shippingRemainingMinutes);
      if (!Number.isFinite(minutes) || minutes > 1440) continue;
      const stage = minutes <= 0 ? "overdue" : minutes <= 120 ? "critical" : minutes <= 360 ? "urgent" : "due_soon";
      const claimed = this.service.repository.claimAlertNotification({
        fingerprint: `shipping_deadline:${preview.shop?.id}:${order.displayOrderId}:${stage}`,
        alertType: "shipping_deadline", nowIso, cooldownMinutes: 360,
      });
      if (claimed) due.push({ preview, order, minutes, stage });
    }
    if (!due.length) return;
    const critical = due.filter((item) => ["overdue", "critical"].includes(item.stage)).length;
    const urgent = due.filter((item) => item.stage === "urgent").length;
    const nearest = due.reduce((current, item) => item.minutes < current.minutes ? item : current, due[0]);
    const remaining = nearest.minutes <= 0 ? `已超时 ${Math.abs(nearest.minutes)} 分钟` : `剩余 ${nearest.minutes} 分钟`;
    this.notifier.notify({ title: critical ? "发现发货时效紧急订单" : "发现临近发货期限订单",
      message: `${due.length} 单进入时效预警（紧急 ${critical}，6 小时内 ${urgent}），最近一单 ${remaining}。系统仍会执行全部安全检查。` });
  }

  async performMessageReviewFollowUp(startedAt, targets) {
    const createdPreviews = [];
    const failures = [];
    const deferred = [];
    let autoBatch = null;
    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index];
      if (autoBatch) {
        this.queueMessageReviewFollowUp(targets.slice(index));
        break;
      }
      const shopService = this.services.find((item) => String(item.config?.shopId) === String(target.shopId));
      if (!shopService) {
        failures.push({ shopId:target.shopId,shopName:"未知店铺",code:"SHOP_NOT_CONFIGURED",category:"scan",
          message:"留言恢复订单对应店铺未配置" });
        continue;
      }
      const shopName = shopService.config?.shopName || "未知店铺";
      if (shopService.getLatestPendingPreview()) {
        deferred.push({ shopId:target.shopId,orderIds:target.orderIds });
        this.queueMessageReviewFollowUp([{ shopId:target.shopId,orderIds:target.orderIds }]);
        continue;
      }
      try {
        const preview = await shopService.createPreview({ orderIds: target.orderIds });
        createdPreviews.push(preview);
        if (shopService.config?.autoFulfillEnabled && preview.eligibleOrders.length) {
          autoBatch = { shopName, preview,
            batch: shopService.enqueuePreview(preview.previewId, preview.confirmationToken) };
        }
      } catch (error) {
        failures.push({ shopId:shopService.config?.shopId,shopName,code:error?.code || "MESSAGE_REVIEW_FOLLOW_UP_FAILED",
          category:scanFailureCategory(error),message:String(error?.message || "留言恢复后的定向扫描失败").slice(0,120) });
      }
    }
    this.notifyPreviewRisks(createdPreviews);
    this.notifyShippingDeadlines(createdPreviews);
    const eligibleCount = autoBatch ? autoBatch.preview.eligibleOrders.length
      : createdPreviews.reduce((sum, preview) => sum + preview.eligibleOrders.length, 0);
    const excludedCount = autoBatch ? autoBatch.preview.excludedOrders.length
      : createdPreviews.reduce((sum, preview) => sum + preview.excludedOrders.length, 0);
    const firstPreview = autoBatch?.preview || createdPreviews[0] || null;
    let outcome; let message;
    if (autoBatch) {
      outcome = "auto_fulfillment_started";
      message = `${autoBatch.shopName} 的留言恢复订单已完成定向安全检查，发货批次 ${autoBatch.batch.id} 已进入队列，共 ${autoBatch.preview.eligibleOrders.length} 单。`;
    } else if (eligibleCount) {
      outcome = "preview_created";
      message = `${eligibleCount} 笔留言恢复订单已通过定向安全检查，已生成待确认预览。`;
    } else if (deferred.length) {
      outcome = "message_review_followup_deferred";
      message = `${deferred.reduce((sum, item) => sum + item.orderIds.length, 0)} 笔留言恢复订单因已有待处理任务暂缓，将自动重试。`;
    } else if (failures.length) {
      outcome = "message_review_followup_failed";
      message = `留言恢复后的定向扫描失败：${failures.map((item) => item.shopName).join("、")}。`;
    } else {
      outcome = "message_review_followup_no_eligible";
      message = `已定向复查留言恢复订单，本次没有订单通过完整发货安全检查，排除 ${excludedCount} 单。`;
    }
    const result = this.finishRun({ startedAt, outcome, message, eligibleCount, excludedCount,
      previewId:firstPreview?.previewId || null,details:failures.length ? { failures,source:"message_review_follow_up" } : { source:"message_review_follow_up" } });
    return { ...result,createdPreview:firstPreview,createdPreviews,failures,
      autoBatch:autoBatch ? { id:autoBatch.batch.id,shopName:autoBatch.shopName,
        orderCount:autoBatch.preview.eligibleOrders.length,status:autoBatch.batch.status } : null };
  }

  async performScan({ messageReviewFollowUp = null } = {}) {
    const startedAt = this.now().toISOString();
    this.lastRunAt = startedAt;
    const activeBatch = this.service.getActiveBatch();
    if (activeBatch) {
      if (messageReviewFollowUp?.length) this.queueMessageReviewFollowUp(messageReviewFollowUp, { delaySeconds: 15 });
      return this.finishRun({ startedAt, outcome: "skipped_active_batch",
        message: `批次 ${activeBatch.id} 正在运行，本次未扫描。` });
    }
    if (messageReviewFollowUp?.length) return this.performMessageReviewFollowUp(startedAt, messageReviewFollowUp);
    this.lastTrackingRecoveries = [];
    for (const shopService of this.services) {
      try {
        const recovery = await shopService.recoverPendingTrackingNumbers?.({ limit: 5 });
        if (recovery?.checked) this.lastTrackingRecoveries.push(recovery);
      } catch (error) {
        this.lastTrackingRecoveries.push({ shop: { id: shopService.config.shopId, name: shopService.config.shopName },
          checked: 0, results: [{ status: "check_failed", errorCode: error?.code || "TRACKING_RECOVERY_CHECK_FAILED" }] });
      }
    }
    const messageReviewIntervalMs = Math.max(5, Number(this.config.messageReviewRecoveryIntervalMinutes) || 30) * 60000;
    const messageReviewDue = this.config.messageReviewRecoveryEnabled && this.messageReviewRecovery
      && (!this.lastMessageReviewCheckAt
        || Date.parse(startedAt) - Date.parse(this.lastMessageReviewCheckAt) >= messageReviewIntervalMs);
    if (messageReviewDue) {
      this.lastMessageReviewCheckAt = startedAt;
      try {
        this.lastMessageReviewRecovery = await this.messageReviewRecovery.run({ limit: this.config.messageReviewRecoveryLimit });
        const moved = this.lastMessageReviewRecovery.moved?.length || 0;
        if (moved) {
          this.queueMessageReviewFollowUp(this.lastMessageReviewRecovery.moved);
          const delay = Math.max(5, Number(this.config.messageReviewFollowUpDelaySeconds) || 30);
          const message = `${moved} 笔仅因留言进入待审核的单仓有货订单已转回待处理；约 ${delay} 秒后将自动定向扫描，并重新完成全部安全检查。`;
          const result = this.finishRun({ startedAt, outcome: "message_review_recovered", message });
          return { ...result, createdPreview:null,createdPreviews:[],failures:[],autoBatch:null,
            lastMessageReviewRecovery:this.lastMessageReviewRecovery };
        }
      } catch (error) {
        this.lastMessageReviewRecovery = { checked:0,moved:[],errorCode:error?.code || "MESSAGE_REVIEW_RECOVERY_FAILED" };
      }
    }
    const createdPreviews = [];
    const existingPreviews = [];
    const failures = [];
    let autoBatch = null;
    const orderedServices = this.services.map((_, offset) => {
      const serviceIndex = (this.nextServiceIndex + offset) % this.services.length;
      return { shopService: this.services[serviceIndex], serviceIndex };
    });
    let sharedRecordsByShopId = null;
    this.lastSharedCollectionMs = null;
    const servicesNeedingPreview = orderedServices.filter(({ shopService }) => !shopService.getLatestPendingPreview());
    if (this.scanSource && servicesNeedingPreview.length) {
      const collectionStartedMs = Date.now();
      try {
        sharedRecordsByShopId = await this.scanSource.listPendingByShop({
          shopIds: servicesNeedingPreview.map(({ shopService }) => shopService.config.shopId),
          limit: this.config.maxBatchSize,
        });
        this.lastScanStrategy = "shared_account_scan";
        this.lastSharedCollectionMs = Date.now() - collectionStartedMs;
      } catch (error) {
        this.lastScanStrategy = "per_shop_fallback";
        this.lastSharedCollectionMs = Date.now() - collectionStartedMs;
        this.logger.warn?.(`Shared fulfillment scan failed; using per-shop fallback: ${error?.code || "SCAN_FAILED"}`);
      }
    } else {
      this.lastScanStrategy = this.scanSource ? "pending_previews_only" : "per_shop_scan";
    }
    for (const { shopService, serviceIndex } of orderedServices) {
      const shopName = shopService.config?.shopName || "未知店铺";
      const existingPreview = shopService.getLatestPendingPreview();
      if (existingPreview) {
        existingPreviews.push(existingPreview);
        if (shopService.config?.autoFulfillEnabled && existingPreview.eligibleOrders.length) {
          try {
            const refreshed = shopService.issueConfirmationToken(existingPreview.previewId);
            autoBatch = { shopName, preview: refreshed,
              batch: shopService.enqueuePreview(refreshed.previewId, refreshed.confirmationToken) };
            this.nextServiceIndex = (serviceIndex + 1) % this.services.length;
            break;
          } catch (error) {
            failures.push({ shopId: shopService.config?.shopId, shopName, code: error?.code || "AUTO_FULFILLMENT_FAILED",
              category: scanFailureCategory(error), message: String(error?.message || "自动发货启动失败").slice(0, 120) });
          }
        }
        continue;
      }
      try {
        const preview = sharedRecordsByShopId
          ? shopService.createPreviewFromRecords(sharedRecordsByShopId.get(String(shopService.config.shopId)) || [], { limit: this.config.maxBatchSize })
          : await shopService.createPreview({ limit: this.config.maxBatchSize });
        createdPreviews.push(preview);
        if (shopService.config?.autoFulfillEnabled && preview.eligibleOrders.length) {
          autoBatch = { shopName, preview,
            batch: shopService.enqueuePreview(preview.previewId, preview.confirmationToken) };
          this.nextServiceIndex = (serviceIndex + 1) % this.services.length;
          break;
        }
      } catch (error) {
        failures.push({ shopId: shopService.config?.shopId, shopName, code: error?.code || "SCAN_FAILED",
          category: scanFailureCategory(error), message: String(error?.message || "扫描失败").slice(0, 120) });
      }
    }
    this.notifyPreviewRisks(createdPreviews);
    this.notifyShippingDeadlines(createdPreviews);
    this.lastManualRecoveries = [];
    if (!autoBatch && !this.service.getActiveBatch()) {
      for (const { shopService } of orderedServices) {
        try {
          const records = sharedRecordsByShopId?.get(String(shopService.config.shopId));
          const recovery = await shopService.autoRecoverManualReviews?.({ records: Array.isArray(records) ? records : null });
          if (recovery?.checked) this.lastManualRecoveries.push(recovery);
        } catch (error) {
          this.lastManualRecoveries.push({ shop: { id: shopService.config.shopId, name: shopService.config.shopName },
            checked: 0, firstPass: [], released: [], retained: [{ code: error?.code || "AUTO_RECOVERY_FAILED" }] });
        }
      }
    }
    const eligibleCount = autoBatch ? autoBatch.preview.eligibleOrders.length
      : createdPreviews.reduce((sum, preview) => sum + preview.eligibleOrders.length, 0);
    const excludedCount = autoBatch ? autoBatch.preview.excludedOrders.length
      : createdPreviews.reduce((sum, preview) => sum + preview.excludedOrders.length, 0);
    const firstEligible = createdPreviews.find((preview) => preview.eligibleOrders.length) || createdPreviews[0] || existingPreviews[0] || null;
    let outcome; let message;
    if (autoBatch) {
      outcome = "auto_fulfillment_started";
      message = `${autoBatch.shopName} 已通过安全检查，自动发货批次 ${autoBatch.batch.id} 已进入队列，共 ${autoBatch.preview.eligibleOrders.length} 单。`;
    } else if (eligibleCount) {
      outcome = failures.length ? "partial_scan_failed" : "preview_created";
      const shops = createdPreviews.filter((preview) => preview.eligibleOrders.length).map((preview) => `${preview.shop?.name || "默认店铺"} ${preview.eligibleOrders.length}单`).join("、");
      message = `已生成 ${createdPreviews.filter((preview) => preview.eligibleOrders.length).length} 个店铺预览：${shops}。`;
    } else if (failures.length) {
      outcome = failures.length === this.services.length ? "scan_failed" : "partial_scan_failed";
      message = `店铺扫描失败：${failures.map((item) => item.shopName).join("、")}。`;
    } else if (!createdPreviews.length && existingPreviews.length) {
      outcome = "skipped_pending_preview";
      message = `已有 ${existingPreviews.length} 个店铺预览待确认，本次未重复生成。`;
    } else {
      outcome = "no_eligible_orders";
      message = `已扫描 ${this.services.length} 个店铺，本次没有符合条件的订单，排除 ${excludedCount} 单。`;
    }
    const releasedCount = this.lastManualRecoveries.reduce((sum, recovery) => sum + (recovery.released?.length || 0), 0);
    const firstPassCount = this.lastManualRecoveries.reduce((sum, recovery) => sum + (recovery.firstPass?.length || 0), 0);
    if (releasedCount) message += ` ${releasedCount} 笔人工处理订单连续两轮复核通过，已解除锁，将从下一轮重新发货。`;
    else if (firstPassCount) message += ` ${firstPassCount} 笔人工处理订单已通过第 1/2 轮自动复核。`;
    const result = this.finishRun({ startedAt, outcome, message, eligibleCount, excludedCount,
      previewId: firstEligible?.previewId || null, details: failures.length ? { failures } : null });
    if (outcome === "scan_failed") {
      const error = new Error(message); error.code = "SCHEDULER_SCAN_FAILED"; throw error;
    }
    return { ...result, createdPreview: firstEligible, createdPreviews, failures,
      autoBatch: autoBatch ? { id: autoBatch.batch.id, shopName: autoBatch.shopName,
        orderCount: autoBatch.preview.eligibleOrders.length, status: autoBatch.batch.status } : null };
  }

  scanNow(options = {}) {
    if (this.scanPromise) return this.scanPromise;
    this.scanPromise = this.performScan(options)
      .then((result) => ({ ...result, scanning: false }))
      .finally(() => { this.scanPromise = null; });
    return this.scanPromise;
  }

  start() {
    if (!this.config.schedulerEnabled || this.timer) return;
    this.nextRunAt = new Date(this.now().getTime() + this.config.schedulerIntervalSeconds * 1000).toISOString();
    this.timer = setInterval(() => {
      this.nextRunAt = new Date(this.now().getTime() + this.config.schedulerIntervalSeconds * 1000).toISOString();
      this.scanNow().catch((error) => this.logger.error(`Fulfillment scheduler scan failed: ${error?.code || "SCAN_FAILED"}`));
    }, this.config.schedulerIntervalSeconds * 1000);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.messageReviewFollowUpTimer) this.clearTimeoutFn(this.messageReviewFollowUpTimer);
    this.timer = null;
    this.messageReviewFollowUpTimer = null;
    this.messageReviewFollowUpAt = null;
    this.nextRunAt = null;
  }

  async waitForIdle() {
    if (this.scanPromise) await Promise.allSettled([this.scanPromise]);
  }
}
