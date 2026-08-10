export class FulfillmentPreviewScheduler {
  constructor({ config, service, services = null, scanSource = null, messageReviewRecovery = null,
    notifier = { notify() {} }, now = () => new Date(), logger = console,
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
    this.dispatchPromise = null;
    this.dispatchPaused = false;
    this.dispatchPauseReason = null;
    this.consecutiveDispatchFailures = 0;
    this.catchUpRefillTimer = null;
    this.catchUp = { active: false, startedAt: null, finishedAt: null, reason: null,
      detectedOrders: 0, oldestOrderAt: null, refillCount: 0, nextRefillAt: null };
    this.stopping = false;
    this.lastRunAt = null;
    this.lastOutcome = "not_run";
    this.lastMessage = "尚未执行扫描";
    this.nextRunAt = null;
    this.nextServiceIndex = 0;
    this.lastScanStrategy = null;
    this.lastSharedCollectionMs = null;
    this.lastManualRecoveries = [];
    this.lastTrackingRecoveries = [];
    this.lastRestartReconciliations = [];
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
    const dispatchQueue = typeof this.service.getDispatchQueueStatus === "function"
      ? this.service.getDispatchQueueStatus() : null;
    return {
      enabled: Boolean(this.config.schedulerEnabled),
      autoFulfillEnabled: Boolean(this.config.autoFulfillEnabled),
      autoFulfillShops: this.services.filter((shopService) => this.automaticFulfillmentEnabled(shopService))
        .map((shopService) => ({ id: shopService.config.shopId, name: shopService.config.shopName })),
      intervalSeconds: this.config.schedulerIntervalSeconds,
      nextRunAt: this.nextRunAt,
      scanning: Boolean(this.scanPromise),
      lastRunAt: this.lastRunAt || latestPersistedScan?.startedAt || null,
      lastOutcome: this.lastRunAt ? this.lastOutcome : latestPersistedScan?.outcome || this.lastOutcome,
      lastMessage: this.lastRunAt ? this.lastMessage : latestPersistedScan?.message || this.lastMessage,
      activeBatch: activeBatch ? { id: activeBatch.id, status: activeBatch.status, createdAt: activeBatch.createdAt } : null,
      dispatchQueue: dispatchQueue ? { ...dispatchQueue, draining: Boolean(this.dispatchPromise),
        paused: this.dispatchPaused, pauseReason: this.dispatchPauseReason } : null,
      catchUp: { ...this.catchUp, enabled: this.catchUpEnabled(),
        consecutiveDispatchFailures: this.consecutiveDispatchFailures,
        circuitThreshold: this.dispatchFailureThreshold() },
      pendingPreview: pendingPreviews[0] || null,
      pendingPreviews,
      recentScans,
      lastScanStrategy: this.lastScanStrategy,
      lastSharedCollectionMs: this.lastSharedCollectionMs,
      lastManualRecoveries: this.lastManualRecoveries,
      lastTrackingRecoveries: this.lastTrackingRecoveries,
      lastRestartReconciliations: this.lastRestartReconciliations,
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

  automaticFulfillmentEnabled(shopService) {
    return Boolean(this.config.autoFulfillEnabled && shopService?.config?.autoFulfillEnabled);
  }

  catchUpEnabled() { return this.config.catchUpEnabled !== false; }
  catchUpThreshold() { return Math.max(10, Number(this.config.catchUpThresholdOrders) || 20); }
  catchUpLowWater() { return Math.max(0, Number(this.config.catchUpLowWaterOrders) || 10); }
  catchUpMaxWaitMs() { return Math.max(5, Number(this.config.catchUpMaxWaitMinutes) || 30) * 60000; }
  catchUpRefillDelayMs() { return Math.max(1, Number(this.config.catchUpRefillDelaySeconds) || 3) * 1000; }
  dispatchFailureThreshold() { return Math.max(2, Number(this.config.dispatchFailureCircuitThreshold) || 3); }

  updateCatchUp({ detectedOrders = 0, oldestOrderAt = null, queueOrders = 0 } = {}) {
    if (!this.catchUpEnabled()) return;
    const oldestMs = Date.parse(oldestOrderAt || "");
    const oldOrderWaiting = Number.isFinite(oldestMs) && this.now().getTime() - oldestMs >= this.catchUpMaxWaitMs();
    const shouldStart = detectedOrders >= this.catchUpThreshold() || queueOrders >= this.catchUpThreshold() || oldOrderWaiting;
    if (shouldStart && !this.catchUp.active) {
      this.catchUp = { ...this.catchUp, active: true, startedAt: this.now().toISOString(), finishedAt: null,
        reason: oldOrderWaiting ? "oldest_order_waiting" : "order_backlog", refillCount: 0 };
      this.notifier.notify({ title: "自动发货进入积压恢复", message: `检测到 ${Math.max(detectedOrders, queueOrders)} 笔待处理订单，将按旧单优先连续补充队列。` });
    }
    this.catchUp.detectedOrders = Math.max(0, Number(detectedOrders) || 0, Number(queueOrders) || 0);
    this.catchUp.oldestOrderAt = oldestOrderAt || this.catchUp.oldestOrderAt;
  }

  finishCatchUpIfDrained({ detectedOrders = 0, queueOrders = 0 } = {}) {
    if (!this.catchUp.active || detectedOrders > 0 || queueOrders > 0) return false;
    this.catchUp = { ...this.catchUp, active: false, finishedAt: this.now().toISOString(), reason: "backlog_cleared",
      detectedOrders: 0, oldestOrderAt: null, nextRefillAt: null };
    this.notifier.notify({ title: "自动发货积压已清空", message: "积压恢复完成，系统已回到正常定时扫描。" });
    return true;
  }

  pauseDispatch(reason = "已由操作员暂停自动发货队列") {
    this.dispatchPaused = true;
    this.dispatchPauseReason = String(reason).slice(0, 300);
    return this.status();
  }

  resumeDispatch() {
    this.dispatchPaused = false;
    this.dispatchPauseReason = null;
    this.consecutiveDispatchFailures = 0;
    this.triggerDispatchDrain();
    return this.status();
  }

  recordDispatchFailure(errorCode, errorMessage) {
    this.consecutiveDispatchFailures += 1;
    if (this.consecutiveDispatchFailures < this.dispatchFailureThreshold()) return false;
    this.dispatchPaused = true;
    this.dispatchPauseReason = `${errorCode || "DISPATCH_FAILED"}: ${errorMessage || "连续发货失败，需要人工核查"}`;
    this.notifier.notify({ title: "自动发货队列已熔断", message: this.dispatchPauseReason });
    return true;
  }

  scheduleCatchUpRefill() {
    if (!this.catchUp.active || this.dispatchPaused || this.stopping || this.catchUpRefillTimer || this.scanPromise) return;
    const delayMs = this.catchUpRefillDelayMs();
    this.catchUp.nextRefillAt = new Date(this.now().getTime() + delayMs).toISOString();
    this.catchUpRefillTimer = this.setTimeoutFn(async () => {
      this.catchUpRefillTimer = null;
      this.catchUp.nextRefillAt = null;
      if (this.dispatchPaused || this.stopping) return;
      this.catchUp.refillCount += 1;
      try { await this.scanNow({ catchUpRefill: true }); }
      catch (error) { this.logger.error?.(`Fulfillment catch-up refill failed: ${error?.code || "SCAN_FAILED"}`); }
    }, delayMs);
    this.catchUpRefillTimer.unref?.();
  }

  queueAutoPreview(shopService, preview, shopName) {
    if (!this.automaticFulfillmentEnabled(shopService)) return null;
    if (typeof shopService.queuePreviewDispatch === "function") {
      const dispatch = shopService.queuePreviewDispatch(preview.previewId);
      return dispatch ? { id: `dispatch-${dispatch.id}`, shopName, orderCount: preview.eligibleOrders.length,
        status: dispatch.status, dispatchId: dispatch.id, previewId: preview.previewId } : null;
    }
    const batch = shopService.enqueuePreview(preview.previewId, preview.confirmationToken);
    return { id: batch.id, shopName, orderCount: preview.eligibleOrders.length, status: batch.status };
  }

  fatalDispatchFailure(batch) {
    const uncertainCodes = new Set(["SERVICE_RESTARTED_DURING_BATCH", "FULFILLMENT_SUBMIT_UNCERTAIN",
      "TRACKING_RESUBMIT_STATE_UNCERTAIN"]);
    return batch?.orders?.find((order) => uncertainCodes.has(order.errorCode)
      || String(order.errorCode || "").includes("AUTH")
      || String(order.errorCode || "").includes("CAPTCHA")) || null;
  }

  triggerDispatchDrain() {
    if (this.dispatchPromise || this.dispatchPaused || typeof this.service.getNextQueuedDispatch !== "function") return this.dispatchPromise;
    this.dispatchPromise = this.drainDispatchQueue().finally(() => {
      this.dispatchPromise = null;
      this.scheduleCatchUpRefill();
    });
    return this.dispatchPromise;
  }

  async drainDispatchQueue() {
    while (!this.dispatchPaused && !this.stopping) {
      const active = this.service.getActiveBatch();
      if (active) {
        await Promise.allSettled(this.services.map((shopService) => shopService.waitForIdle?.()));
        if (this.service.getActiveBatch()) return;
      }
      const dispatch = this.service.getNextQueuedDispatch();
      if (!dispatch) return;
      const shopService = this.services.find((item) => String(item.config?.shopId) === String(dispatch.shopId));
      if (!shopService || shopService.config?.mode === "paused" || !this.automaticFulfillmentEnabled(shopService)) {
        this.service.finishDispatch(dispatch.id, "failed", "SHOP_AUTO_FULFILL_DISABLED",
          "店铺已暂停或关闭自动发货，候选未执行。");
        continue;
      }
      let batch;
      try {
        batch = shopService.enqueueQueuedPreview(dispatch.previewId);
        this.service.markDispatchRunning(dispatch.id, batch.id);
        await shopService.waitForIdle();
        const finished = shopService.getBatch(batch.id);
        const fatal = this.fatalDispatchFailure(finished);
        const succeeded = ["success", "partial_success"].includes(finished?.status);
        this.service.finishDispatch(dispatch.id, succeeded ? "completed" : "failed",
          fatal?.errorCode || finished?.orders?.find((order) => order.errorCode)?.errorCode || null,
          fatal?.errorMessage || finished?.orders?.find((order) => order.errorMessage)?.errorMessage || null);
        if (fatal) {
          this.dispatchPaused = true;
          this.dispatchPauseReason = `${fatal.errorCode}: ${fatal.errorMessage || "需要人工核查"}`;
          this.notifier.notify({ title: "自动发货队列已安全暂停", message: this.dispatchPauseReason });
        } else if (succeeded) {
          this.consecutiveDispatchFailures = 0;
        } else {
          const failure = finished?.orders?.find((order) => order.errorCode);
          this.recordDispatchFailure(failure?.errorCode || "BATCH_FAILED", failure?.errorMessage);
        }
      } catch (error) {
        if (error?.code === "BATCH_ALREADY_RUNNING") continue;
        this.service.finishDispatch(dispatch.id, "failed", error?.code || "DISPATCH_FAILED", error?.message || "自动发货调度失败");
        this.logger.error?.(`Fulfillment dispatch failed: ${error?.code || "DISPATCH_FAILED"}`);
        this.recordDispatchFailure(error?.code || "DISPATCH_FAILED", error?.message);
      }
      const queue = this.service.getDispatchQueueStatus?.();
      const queueOrders = Number(queue?.queuedOrders || 0) + Number(queue?.runningOrders || 0);
      if (this.catchUp.active && queueOrders <= this.catchUpLowWater()) this.scheduleCatchUpRefill();
    }
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

  finishRun({ startedAt, outcome, message, eligibleCount = 0, excludedCount = 0, previewId = null }) {
    this.lastOutcome = outcome;
    this.lastMessage = message;
    this.service.recordScanRun({ startedAt, finishedAt: this.now().toISOString(), outcome, message,
      eligibleCount, excludedCount, previewId });
    if (outcome === "preview_created") this.notifier.notify({ title: "马帮有订单待确认", message });
    if (outcome === "auto_fulfillment_started") this.notifier.notify({ title: "马帮自动发货已启动", message });
    if (outcome === "scan_failed" || outcome === "partial_scan_failed") this.notifier.notify({ title: "马帮定时扫描失败", message });
    return this.status();
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
      if (!shopService || shopService.config?.mode === "paused") {
        failures.push({ shopId: target.shopId, shopName: "未知店铺", code: "SHOP_NOT_CONFIGURED",
          message: "留言恢复订单对应店铺未配置或已暂停" });
        continue;
      }
      const shopName = shopService.config?.shopName || "未知店铺";
      if (shopService.getLatestPendingPreview()) {
        deferred.push({ shopId: target.shopId, orderIds: target.orderIds });
        this.queueMessageReviewFollowUp([{ shopId: target.shopId, orderIds: target.orderIds }], { delaySeconds: 15 });
        continue;
      }
      try {
        const preview = await shopService.createPreview({ orderIds: target.orderIds });
        createdPreviews.push(preview);
        if (this.automaticFulfillmentEnabled(shopService) && preview.eligibleOrders.length) {
          autoBatch = { shopName, preview,
            batch: shopService.enqueuePreview(preview.previewId, preview.confirmationToken) };
        }
      } catch (error) {
        failures.push({ shopId: shopService.config?.shopId, shopName,
          code: error?.code || "MESSAGE_REVIEW_FOLLOW_UP_FAILED",
          message: String(error?.message || "留言恢复后的定向扫描失败").slice(0, 120) });
      }
    }
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
      previewId: firstPreview?.previewId || null });
    return { ...result, createdPreview: firstPreview, createdPreviews, failures,
      autoBatch: autoBatch ? { id: autoBatch.batch.id, shopName: autoBatch.shopName,
        orderCount: autoBatch.preview.eligibleOrders.length, status: autoBatch.batch.status } : null };
  }

  async performScan({ messageReviewFollowUp = null, catchUpRefill = false } = {}) {
    const startedAt = this.now().toISOString();
    this.lastRunAt = startedAt;
    const activeBatch = this.service.getActiveBatch();
    if (activeBatch && !this.scanSource) {
      if (messageReviewFollowUp?.length) this.queueMessageReviewFollowUp(messageReviewFollowUp, { delaySeconds: 15 });
      return this.finishRun({ startedAt, outcome: "skipped_active_batch",
        message: `批次 ${activeBatch.id} 正在运行，本次未扫描。` });
    }
    if (activeBatch && messageReviewFollowUp?.length) {
      this.queueMessageReviewFollowUp(messageReviewFollowUp, { delaySeconds: 15 });
      messageReviewFollowUp = null;
    }
    if (messageReviewFollowUp?.length) return this.performMessageReviewFollowUp(startedAt, messageReviewFollowUp);
    this.lastTrackingRecoveries = [];
    this.lastRestartReconciliations = [];
    this.lastMessageReviewRecovery = null;
    for (const shopService of activeBatch ? [] : this.services) {
      if (shopService.config?.mode === "paused") continue;
      try {
        const reconciliation = await shopService.reconcileInterruptedOrders?.({ limit: 5 });
        if (reconciliation?.checked) this.lastRestartReconciliations.push(reconciliation);
        const recovery = await shopService.recoverPendingTrackingNumbers?.({ limit: 5 });
        if (recovery?.checked) this.lastTrackingRecoveries.push(recovery);
      } catch (error) {
        this.lastTrackingRecoveries.push({ shop: { id: shopService.config.shopId, name: shopService.config.shopName },
          checked: 0, results: [{ status: "check_failed", errorCode: error?.code || "TRACKING_RECOVERY_CHECK_FAILED" }] });
      }
    }
    const messageReviewIntervalMs = Math.max(5, Number(this.config.messageReviewRecoveryIntervalMinutes) || 30) * 60000;
    const messageReviewDue = !activeBatch && this.config.messageReviewRecoveryEnabled && this.messageReviewRecovery
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
          return { ...result, createdPreview: null, createdPreviews: [], failures: [], autoBatch: null,
            lastMessageReviewRecovery: this.lastMessageReviewRecovery };
        }
      } catch (error) {
        this.lastMessageReviewRecovery = { checked: 0, moved: [], errorCode: error?.code || "MESSAGE_REVIEW_RECOVERY_FAILED" };
      }
    }
    const createdPreviews = [];
    const existingPreviews = [];
    const failures = [];
    let autoBatch = null;
    const autoBatches = [];
    const backlogPreviewGroups = [];
    const orderedServices = this.services.map((_, offset) => {
      const serviceIndex = (this.nextServiceIndex + offset) % this.services.length;
      return { shopService: this.services[serviceIndex], serviceIndex };
    });
    let sharedRecordsByShopId = null;
    this.lastSharedCollectionMs = null;
    const needsFreshPreview = (shopService) => {
      const preview = shopService.getLatestPendingPreview();
      if (!preview) return true;
      const dispatch = shopService.getDispatchByPreview?.(preview.previewId);
      return Boolean(this.automaticFulfillmentEnabled(shopService) && ["queued", "running"].includes(dispatch?.status));
    };
    const servicesNeedingPreview = orderedServices.filter(({ shopService }) => shopService.config?.mode !== "paused"
      && needsFreshPreview(shopService));
    if (this.scanSource && servicesNeedingPreview.length) {
      const collectionStartedMs = Date.now();
      try {
        sharedRecordsByShopId = await this.scanSource.listPendingByShop({
          shopIds: servicesNeedingPreview.map(({ shopService }) => shopService.config.shopId),
          limit: this.config.maxBatchSize * (Number(this.config.backlogBatchesPerScan) || 5),
        });
        this.lastScanStrategy = "shared_account_scan";
        this.lastSharedCollectionMs = Date.now() - collectionStartedMs;
      } catch (error) {
        this.lastScanStrategy = "per_shop_fallback";
        this.lastSharedCollectionMs = Date.now() - collectionStartedMs;
        this.logger.warn?.(`Shared fulfillment scan failed; using per-shop fallback: ${error?.code || "SCAN_FAILED"}`);
        if (activeBatch) {
          return this.finishRun({ startedAt, outcome: "read_only_scan_failed",
            message: `批次 ${activeBatch.id} 执行期间的独立只读扫描失败，本次未追加候选；当前发货批次不受影响。` });
        }
      }
    } else {
      this.lastScanStrategy = this.scanSource ? "pending_previews_only" : "per_shop_scan";
    }
    for (const { shopService, serviceIndex } of orderedServices) {
      const shopName = shopService.config?.shopName || "未知店铺";
      if (shopService.config?.mode === "paused") continue;
      const existingPreview = shopService.getLatestPendingPreview();
      const existingDispatch = existingPreview && shopService.getDispatchByPreview?.(existingPreview.previewId);
      const refreshQueuedAutoPreview = Boolean(existingPreview && this.automaticFulfillmentEnabled(shopService)
        && ["queued", "running"].includes(existingDispatch?.status));
      if (existingPreview && !refreshQueuedAutoPreview) {
        existingPreviews.push(existingPreview);
        if (this.automaticFulfillmentEnabled(shopService) && existingPreview.eligibleOrders.length) {
          try {
            const refreshed = typeof shopService.queuePreviewDispatch === "function"
              ? existingPreview : shopService.issueConfirmationToken(existingPreview.previewId);
            const queued = this.queueAutoPreview(shopService, refreshed, shopName);
            if (queued) {
              const queuedBatch = { shopName, preview: refreshed, batch: queued };
              autoBatches.push(queuedBatch);
              if (!autoBatch) autoBatch = queuedBatch;
            }
            this.nextServiceIndex = (serviceIndex + 1) % this.services.length;
          } catch (error) {
            failures.push({ shopName, message: String(error?.message || "自动发货启动失败").slice(0, 120) });
          }
        }
        continue;
      }
      try {
        const shopLimit = Math.min(this.config.maxBatchSize, Number(shopService.config?.maxBatchSize) || this.config.maxBatchSize);
        const records = sharedRecordsByShopId?.get(String(shopService.config.shopId)) || [];
        const previews = sharedRecordsByShopId && this.automaticFulfillmentEnabled(shopService)
          && typeof shopService.createBacklogPreviewsFromRecords === "function"
          ? shopService.createBacklogPreviewsFromRecords(records, { limit: shopLimit,
            maxPreviews: Number(this.config.backlogBatchesPerScan) || 5 })
          : [sharedRecordsByShopId
            ? shopService.createPreviewFromRecords(records, { limit: shopLimit })
            : await shopService.createPreview({ limit: shopLimit })];
        createdPreviews.push(...previews);
        if (this.automaticFulfillmentEnabled(shopService) && previews.some((preview) => preview.eligibleOrders.length)) {
          if (sharedRecordsByShopId) {
            backlogPreviewGroups.push({ shopService, shopName, serviceIndex, previews });
          } else {
            const preview = previews.find((item) => item.eligibleOrders.length);
            const queued = this.queueAutoPreview(shopService, preview, shopName);
            if (queued) {
              const queuedBatch = { shopName, preview, batch: queued };
              autoBatches.push(queuedBatch);
              if (!autoBatch) autoBatch = queuedBatch;
            }
          }
          this.nextServiceIndex = (serviceIndex + 1) % this.services.length;
        }
      } catch (error) {
        failures.push({ shopName, message: String(error?.message || "扫描失败").slice(0, 120) });
      }
    }
    const paidAtMs = (preview) => {
      const timestamp = Date.parse(preview?.oldestEligiblePaidAt || "");
      return Number.isFinite(timestamp) ? timestamp : Number.MAX_SAFE_INTEGER;
    };
    backlogPreviewGroups.sort((left, right) => paidAtMs(left.previews[0]) - paidAtMs(right.previews[0])
      || left.serviceIndex - right.serviceIndex);
    const backlogRounds = backlogPreviewGroups.reduce((maximum, group) => Math.max(maximum, group.previews.length), 0);
    for (let round = 0; round < backlogRounds; round += 1) {
      for (const group of backlogPreviewGroups) {
        const preview = group.previews[round];
        if (!preview?.eligibleOrders.length) continue;
        const queued = this.queueAutoPreview(group.shopService, preview, group.shopName);
        if (!queued) continue;
        const queuedBatch = { shopName: group.shopName, preview, batch: queued };
        autoBatches.push(queuedBatch);
        if (!autoBatch) autoBatch = queuedBatch;
        this.nextServiceIndex = (group.serviceIndex + 1) % this.services.length;
      }
    }
    this.lastManualRecoveries = [];
    if (!autoBatch && !this.service.getActiveBatch()) {
      for (const { shopService } of orderedServices) {
        if (shopService.config?.mode === "paused") continue;
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
    const eligibleCount = [...createdPreviews, ...existingPreviews]
      .reduce((sum, preview) => sum + preview.eligibleOrders.length, 0);
    const excludedCount = [...createdPreviews, ...existingPreviews]
      .reduce((sum, preview) => sum + preview.excludedOrders.length, 0);
    const firstEligible = createdPreviews.find((preview) => preview.eligibleOrders.length) || createdPreviews[0] || existingPreviews[0] || null;
    const queuedOrderCount = autoBatches.reduce((sum, item) => sum + item.preview.eligibleOrders.length, 0);
    const oldestOrderAt = [...createdPreviews, ...existingPreviews]
      .map((preview) => preview.oldestEligiblePaidAt).filter(Boolean).sort()[0] || null;
    const queueState = this.service.getDispatchQueueStatus?.();
    const activeQueueOrders = Number(queueState?.queuedOrders || 0) + Number(queueState?.runningOrders || 0);
    this.updateCatchUp({ detectedOrders: Math.max(eligibleCount, queuedOrderCount), oldestOrderAt,
      queueOrders: activeQueueOrders });
    if (catchUpRefill && !queuedOrderCount) this.finishCatchUpIfDrained({ detectedOrders: eligibleCount,
      queueOrders: activeQueueOrders });
    let outcome; let message;
    if (autoBatch) {
      outcome = "auto_fulfillment_started";
      const queuedShopCount = new Set(autoBatches.map((item) => item.preview.shop?.id || item.shopName)).size;
      message = `${activeBatch ? `批次 ${activeBatch.id} 执行期间已完成独立只读扫描；` : "已扫描全部店铺，"}${queuedShopCount} 个店铺的 ${autoBatches.length} 个批次共 ${queuedOrderCount} 单已按旧单优先追加到自动发货队列；首批为 ${autoBatch.shopName}。`;
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
      previewId: firstEligible?.previewId || null });
    if (outcome === "scan_failed") {
      const error = new Error(message); error.code = "SCHEDULER_SCAN_FAILED"; throw error;
    }
    this.triggerDispatchDrain();
    return { ...result, createdPreview: firstEligible, createdPreviews, failures,
      autoBatch: autoBatch ? { id: autoBatch.batch.id, shopName: autoBatch.shopName,
        orderCount: autoBatch.preview.eligibleOrders.length, status: autoBatch.batch.status } : null,
      queuedAutoBatches: autoBatches.map((item) => ({ id: item.batch.id, shopName: item.shopName,
        orderCount: item.preview.eligibleOrders.length, status: item.batch.status })) };
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
    this.stopping = false;
    this.nextRunAt = new Date(this.now().getTime() + this.config.schedulerIntervalSeconds * 1000).toISOString();
    this.timer = setInterval(() => {
      this.nextRunAt = new Date(this.now().getTime() + this.config.schedulerIntervalSeconds * 1000).toISOString();
      this.scanNow().catch((error) => this.logger.error(`Fulfillment scheduler scan failed: ${error?.code || "SCAN_FAILED"}`));
    }, this.config.schedulerIntervalSeconds * 1000);
    this.timer.unref?.();
    const startupQueue = this.service.getDispatchQueueStatus?.();
    const startupOrders = Number(startupQueue?.queuedOrders || 0) + Number(startupQueue?.runningOrders || 0);
    this.updateCatchUp({ detectedOrders: startupOrders, queueOrders: startupOrders });
    this.triggerDispatchDrain();
  }

  stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    if (this.messageReviewFollowUpTimer) this.clearTimeoutFn(this.messageReviewFollowUpTimer);
    if (this.catchUpRefillTimer) this.clearTimeoutFn(this.catchUpRefillTimer);
    this.timer = null;
    this.messageReviewFollowUpTimer = null;
    this.catchUpRefillTimer = null;
    this.messageReviewFollowUpAt = null;
    this.nextRunAt = null;
  }

  async waitForIdle() {
    if (this.scanPromise) await Promise.allSettled([this.scanPromise]);
    if (this.dispatchPromise) await Promise.allSettled([this.dispatchPromise]);
  }
}
