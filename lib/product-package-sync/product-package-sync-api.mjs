import { ProductPackageSyncError } from "./product-package-sync-service.mjs";

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
  return true;
}

function actor(req) {
  return req.auditContext?.annotations?.actorIdentifier
    || req.auditContext?.actorIdentifier
    || req.auditContext?.actorType
    || "local_session";
}

export function createProductPackageSyncApi({ service, accessPolicy }) {
  return async function handleProductPackageSyncApi(req, res, url) {
    if (!url.pathname.startsWith("/api/product-package-sync")) return false;
    try {
      if (url.pathname === "/api/product-package-sync/status" && req.method === "GET") {
        accessPolicy.assert("product.view");
        return sendJson(res, 200, { ok: true, status: await service.status({ probe: url.searchParams.get("probe") === "1" }) });
      }
      if (url.pathname === "/api/product-package-sync/runs" && req.method === "GET") {
        accessPolicy.assert("product.view");
        return sendJson(res, 200, {
          ok: true,
          ...(await service.listRuns({
            page: url.searchParams.get("page"),
            pageSize: url.searchParams.get("page_size"),
          })),
        });
      }
      if (url.pathname === "/api/product-package-sync/changes" && req.method === "GET") {
        accessPolicy.assert("product.view");
        return sendJson(res, 200, {
          ok: true,
          ...(await service.listChanges({
            runId: url.searchParams.get("run_id"),
            page: url.searchParams.get("page"),
            pageSize: url.searchParams.get("page_size"),
            country: url.searchParams.get("country"),
            sku: url.searchParams.get("sku"),
            field: url.searchParams.get("field"),
            changeType: url.searchParams.get("change_type"),
          })),
        });
      }
      if (url.pathname === "/api/product-package-sync/run" && req.method === "POST") {
        accessPolicy.assert("product.edit");
        const result = await service.sync({ triggerType: "manual", requestedBy: actor(req) });
        req.auditContext?.annotate({
          runId: result.run.id,
          metadata: {
            result: result.run.status,
            sourceRowCount: result.run.sourceRowCount,
            fieldChangeCount: result.run.fieldChangeCount,
          },
        });
        return sendJson(res, result.skipped ? 200 : 202, { ok: true, ...result });
      }
      return sendJson(res, 405, { ok: false, error: "Method not allowed" });
    } catch (error) {
      const publicCodes = new Set([
        "PRODUCT_PACKAGE_SYNC_SCHEMA_NOT_READY",
        "PRODUCT_PACKAGE_SOURCE_NOT_CONFIGURED",
        "PRODUCT_PACKAGE_SYNC_DISABLED",
        "PRODUCT_PACKAGE_MANUAL_SYNC_DISABLED",
        "PRODUCT_PACKAGE_SYNC_BUSY",
        "PRODUCT_PACKAGE_SOURCE_EMPTY",
        "PRODUCT_PACKAGE_REMOVAL_SAFETY_LIMIT",
        "PRODUCT_PACKAGE_SOURCE_SCHEMA_MISMATCH",
        "PRODUCT_PACKAGE_SOURCE_ROW_COUNT_MISMATCH",
        "PRODUCT_PACKAGE_STAGE_VALIDATION_FAILED",
        "PRODUCT_PACKAGE_TARGET_ROW_COUNT_MISMATCH",
        "PRODUCT_PERMISSION_DENIED",
      ]);
      const code = String(error?.code || "PRODUCT_PACKAGE_SYNC_FAILED").slice(0, 80);
      const publicError = error instanceof ProductPackageSyncError || publicCodes.has(code);
      req.auditContext?.annotate({
        errorStage: "product_package_sync",
        errorCode: code,
        errorSummary: error,
      });
      return sendJson(res, publicError ? Number(error?.status || 400) : 500, {
        ok: false,
        code: publicError ? code : "PRODUCT_PACKAGE_SYNC_FAILED",
        error: publicError
          ? String(error?.message || "产品包同步失败。").split(/\r?\n/, 1)[0].slice(0, 200)
          : "产品包同步失败。",
      });
    }
  };
}
