import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  FILE_ERROR_CODES,
  FilePolicyError,
  atomicMoveFile,
  createTemporaryFilePath,
  hashFileBuffer,
  removeFileInsideRoot,
  resolveExistingFile,
  sanitizeFilename,
} from "../security/file-policy.mjs";

const IMAGE_TYPES = Object.freeze({
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
});
const IMAGE_EXTENSIONS = Object.freeze(Object.keys(IMAGE_TYPES));

function validSignature(buffer, mimeType) {
  if (mimeType === "image/jpeg") return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mimeType === "image/png") return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mimeType === "image/webp") return buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP";
  return false;
}

export class ProductImageService {
  constructor({ repository, tempRoot, imageRoot, maxBytes = 10 * 1024 * 1024 }) {
    this.repository = repository;
    this.tempRoot = path.resolve(tempRoot);
    this.imageRoot = path.resolve(imageRoot);
    this.maxBytes = maxBytes;
  }

  async upload(productId, { filename, mimeType, buffer, operatorLabel, requestId }) {
    const product = await this.repository.get(productId);
    if (!product) throw Object.assign(new Error("产品不存在。"), { code: "PRODUCT_NOT_FOUND", status: 404 });
    const safeName = sanitizeFilename(filename, { fallback: "product-image" });
    const extension = path.extname(safeName).toLowerCase();
    const declaredType = String(mimeType || "").split(";", 1)[0].trim().toLowerCase();
    if (!IMAGE_EXTENSIONS.includes(extension) || IMAGE_TYPES[extension] !== declaredType) {
      throw new FilePolicyError(FILE_ERROR_CODES.FILE_TYPE_NOT_ALLOWED);
    }
    if (!Buffer.isBuffer(buffer) || !buffer.length || !validSignature(buffer, declaredType)) {
      throw new FilePolicyError(FILE_ERROR_CODES.FILE_SIGNATURE_INVALID);
    }
    if (buffer.length > this.maxBytes) throw new FilePolicyError(FILE_ERROR_CODES.FILE_TOO_LARGE);

    const temporary = await createTemporaryFilePath(this.tempRoot, { prefix: "product-image", extension });
    const storageFilename = `${crypto.randomUUID()}${extension === ".jpeg" ? ".jpg" : extension}`;
    const relativePath = `${productId}/${new Date().toISOString().slice(0, 7)}/${storageFilename}`;
    try {
      await fs.writeFile(temporary.path, buffer, { flag: "wx" });
      const moved = await atomicMoveFile({
        sourceRoot: this.tempRoot,
        sourcePath: temporary.path,
        destinationRoot: this.imageRoot,
        destinationRelativePath: relativePath,
        allowedExtensions: IMAGE_EXTENSIONS,
      });
      try {
        return await this.repository.createImage({
          productId,
          originalFilename: safeName,
          storageFilename,
          relativePath: moved.relativePath,
          mimeType: declaredType,
          fileSize: buffer.length,
          fileHash: hashFileBuffer(buffer),
          operatorLabel: operatorLabel || "local_session",
          requestId: requestId || null,
        });
      } catch (error) {
        await removeFileInsideRoot(this.imageRoot, moved.path);
        throw error;
      }
    } finally {
      await removeFileInsideRoot(this.tempRoot, temporary.path);
    }
  }

  async read(productId, imageId) {
    const image = await this.repository.getImage(imageId);
    if (!image || image.productId !== productId || image.status !== "available") {
      throw new FilePolicyError(FILE_ERROR_CODES.FILE_NOT_FOUND);
    }
    const resolved = await resolveExistingFile(this.imageRoot, image.relativePath, { allowedExtensions: IMAGE_EXTENSIONS });
    if (Number(resolved.stat.size) !== Number(image.fileSize)) throw new FilePolicyError(FILE_ERROR_CODES.FILE_INTEGRITY_FAILED);
    const buffer = await fs.readFile(resolved.path);
    if (hashFileBuffer(buffer) !== image.fileHash) throw new FilePolicyError(FILE_ERROR_CODES.FILE_INTEGRITY_FAILED);
    return { image, buffer };
  }

  async remove(productId, imageId) {
    const removed = await this.repository.deleteImage(productId, imageId);
    if (!removed) throw new FilePolicyError(FILE_ERROR_CODES.FILE_NOT_FOUND);
    return true;
  }
}
