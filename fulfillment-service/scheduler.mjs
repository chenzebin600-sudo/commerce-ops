export class FulfillmentPreviewScheduler {
  constructor({ config, service, services = null, scanSource = null, notifier = { notify() {} }, now = () => new Date(), logger = console }) {
    this.config = config;
    this.services = services?.length ? services : [service];
    this.service = service || this.services[0];
    this.now = now;
    this.logger = logger;
    this.notifier = notifier;
    this.scanSource = scanSource;
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
    };
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

  async performScan() {
    const startedAt = this.now().toISOString();
    this.lastRunAt = startedAt;
    const activeBatch = this.service.getActiveBatch();
    if (activeBatch) {
      return this.finishRun({ startedAt, outcome: "skipped_active_batch",
        message: `批次 ${activeBatch.id} 正在运行，本次未扫描。` });
    }
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
            failures.push({ shopName, message: String(error?.message || "自动发货启动失败").slice(0, 120) });
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
        failures.push({ shopName, message: String(error?.message || "扫描失败").slice(0, 120) });
      }
    }
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
      previewId: firstEligible?.previewId || null });
    if (outcome === "scan_failed") {
      const error = new Error(message); error.code = "SCHEDULER_SCAN_FAILED"; throw error;
    }
    return { ...result, createdPreview: firstEligible, createdPreviews, failures,
      autoBatch: autoBatch ? { id: autoBatch.batch.id, shopName: autoBatch.shopName,
        orderCount: autoBatch.preview.eligibleOrders.length, status: autoBatch.batch.status } : null };
  }

  scanNow() {
    if (this.scanPromise) return this.scanPromise;
    this.scanPromise = this.performScan()
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
    this.timer = null;
    this.nextRunAt = null;
  }

  async waitForIdle() {
    if (this.scanPromise) await Promise.allSettled([this.scanPromise]);
  }
}
