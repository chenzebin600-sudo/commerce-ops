import fs from "node:fs/promises";
import path from "node:path";
import { createMabangImageAccessPolicy } from "./access-policy.mjs";
import { resolveExistingFile } from "../security/file-policy.mjs";
import { inspectImageBuffer } from "./image-assets.mjs";

const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];

function sendJson(res, status, data) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
  return true;
}

async function readJson(req, maxBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error("请求内容过大。"), { code: "REQUEST_TOO_LARGE", status: 413 });
    chunks.push(chunk);
  }
  const value = Buffer.concat(chunks).toString("utf8");
  return value ? JSON.parse(value) : {};
}

function publicAccounts(accounts) {
  return (accounts || []).map((account) => ({
    id: account.id,
    name: account.name || account.label || account.accountName || "马帮账号",
    usernameMasked: account.usernameMasked || account.maskedUsername || account.username || null,
    enabled: account.enabled !== false,
    verificationStatus: account.verificationStatus || null,
  }));
}

export function createMabangImageApi({ service, repository, accountRepository, imageRoot,
  accessPolicy = createMabangImageAccessPolicy() }) {
  const root = path.resolve(imageRoot);
  return async function handleMabangImageApi(req, res, url) {
    if (!url.pathname.startsWith("/api/mabang-images")) return false;
    try {
      const actor = req.auditContext?.actorType || "local_session";
      if (url.pathname === "/api/mabang-images/capabilities" && req.method === "GET") {
        return sendJson(res, 200, { ok: true, ...accessPolicy.publicCapabilities() });
      }
      if (url.pathname === "/api/mabang-images/accounts" && req.method === "GET") {
        accessPolicy.assert("mabang_images.view");
        return sendJson(res, 200, { ok: true, accounts: publicAccounts(await accountRepository.list()) });
      }
      if (url.pathname === "/api/mabang-images/batches" && req.method === "GET") {
        accessPolicy.assert("mabang_images.view");
        return sendJson(res, 200, { ok: true, batches: await repository.listBatches({ limit: url.searchParams.get("limit") }) });
      }
      if (url.pathname === "/api/mabang-images/batches" && req.method === "POST") {
        const body = await readJson(req);
        accessPolicy.assert(body.mode === "retry_failed" ? "mabang_images.retry" : "mabang_images.collect");
        accessPolicy.assert("mabang_images.link");
        const batch = await service.start({ accountId: body.accountId, mode: body.mode, sourceBatchId: body.sourceBatchId, createdBy: actor });
        req.auditContext?.annotate({ metadata: { batchId: batch.id, accountId: batch.accountId, mode: batch.mode } });
        return sendJson(res, 202, { ok: true, batch });
      }

      const batchMatch = url.pathname.match(/^\/api\/mabang-images\/batches\/([0-9a-f-]+)(?:\/(pause|resume|discoveries))?$/i);
      if (batchMatch) {
        const [, batchId, action] = batchMatch;
        if (!action && req.method === "GET") {
          accessPolicy.assert("mabang_images.view");
          const batch = await repository.getBatch(batchId);
          return batch ? sendJson(res, 200, { ok: true, batch }) : sendJson(res, 404, { ok: false, code: "MABANG_IMAGE_BATCH_NOT_FOUND", error: "采集批次不存在。" });
        }
        if (action === "discoveries" && req.method === "GET") {
          accessPolicy.assert("mabang_images.view");
          return sendJson(res, 200, { ok: true, discoveries: await repository.listDiscoveries(batchId, {
            status: url.searchParams.get("status"), limit: url.searchParams.get("limit"), offset: url.searchParams.get("offset"),
          }) });
        }
        if (action === "pause" && req.method === "POST") {
          accessPolicy.assert("mabang_images.collect");
          return sendJson(res, 200, { ok: true, batch: await service.pause(batchId, actor) });
        }
        if (action === "resume" && req.method === "POST") {
          accessPolicy.assert("mabang_images.retry");
          return sendJson(res, 202, { ok: true, batch: await service.resume(batchId, actor) });
        }
        return sendJson(res, 405, { ok: false, error: "Method not allowed" });
      }

      const assetMatch = url.pathname.match(/^\/api\/mabang-images\/assets\/([0-9a-f-]+)(?:\/(content|products))?$/i);
      if (assetMatch) {
        accessPolicy.assert("mabang_images.view");
        const [, assetId, action] = assetMatch;
        const asset = await repository.getAsset(assetId);
        if (!asset || asset.status !== "available") return sendJson(res, 404, { ok: false, code: "MABANG_IMAGE_ASSET_NOT_FOUND", error: "图片资源不存在。" });
        if (action === "products" && req.method === "GET") {
          return sendJson(res, 200, { ok: true, asset, products: await repository.linksForAsset(assetId) });
        }
        if (action === "content" && req.method === "GET") {
          const resolved = await resolveExistingFile(root, asset.relativePath, { allowedExtensions: IMAGE_EXTENSIONS });
          if (Number(resolved.stat.size) !== asset.fileSize) throw Object.assign(new Error("图片完整性校验失败。"), { code: "IMAGE_INTEGRITY_FAILED", status: 409 });
          const buffer = await fs.readFile(resolved.path);
          const inspected = inspectImageBuffer(buffer, { contentType: asset.mimeType, maxBytes: Math.max(asset.fileSize, 1) });
          if (inspected.sha256 !== asset.sha256) throw Object.assign(new Error("图片完整性校验失败。"), { code: "IMAGE_INTEGRITY_FAILED", status: 409 });
          res.writeHead(200, { "content-type": asset.mimeType, "content-length": String(buffer.length), "cache-control": "private, no-store", "x-content-type-options": "nosniff" });
          res.end(buffer);
          return true;
        }
        if (!action && req.method === "GET") return sendJson(res, 200, { ok: true, asset });
        return sendJson(res, 405, { ok: false, error: "Method not allowed" });
      }

      const primaryMatch = url.pathname.match(/^\/api\/mabang-images\/links\/([0-9a-f-]+)\/confirm-primary$/i);
      if (primaryMatch && req.method === "POST") {
        accessPolicy.assert("mabang_images.set_primary");
        const link = await service.confirmPrimary(primaryMatch[1], actor);
        req.auditContext?.annotate({ metadata: { linkId: link.id, assetId: link.assetId, productId: link.productId } });
        return sendJson(res, 200, { ok: true, link });
      }

      return sendJson(res, 404, { ok: false, error: "Not found" });
    } catch (error) {
      req.auditContext?.annotate({ errorCode: error?.code || "MABANG_IMAGE_API_FAILED", errorStage: "mabang_images" });
      return sendJson(res, Number(error?.status || 400), { ok: false, code: error?.code || "MABANG_IMAGE_API_FAILED", error: error?.message || "马帮图片操作失败。" });
    }
  };
}
