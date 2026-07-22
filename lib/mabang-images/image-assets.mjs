import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  atomicMoveFile,
  createTemporaryFilePath,
  removeFileInsideRoot,
  sanitizeFilename,
} from "../security/file-policy.mjs";
import { sanitizeStoredSourceUrl } from "./extraction.mjs";

const MIME_EXTENSIONS = Object.freeze({
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
});

export class ImageValidationError extends Error {
  constructor(code, message, { status = 422, httpStatus = null } = {}) {
    super(message);
    this.name = "ImageValidationError";
    this.code = code;
    this.status = status;
    this.httpStatus = httpStatus;
  }
}

function normalizedContentType(value) {
  const type = String(value || "").split(";", 1)[0].trim().toLowerCase();
  return type === "image/jpg" ? "image/jpeg" : type;
}

function uint24le(buffer, offset) {
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
}

function pngDimensions(buffer) {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return width > 0 && height > 0 ? { mimeType: "image/png", width, height } : null;
}

function jpegDimensions(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 8 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    while (buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) break;
    const isSof = (marker >= 0xc0 && marker <= 0xc3)
      || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb)
      || (marker >= 0xcd && marker <= 0xcf);
    if (isSof && length >= 7) {
      const height = buffer.readUInt16BE(offset + 3);
      const width = buffer.readUInt16BE(offset + 5);
      return width > 0 && height > 0 ? { mimeType: "image/jpeg", width, height } : null;
    }
    offset += length;
  }
  return null;
}

function webpDimensions(buffer) {
  if (buffer.length < 30 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP") return null;
  const chunk = buffer.toString("ascii", 12, 16);
  if (chunk === "VP8X" && buffer.length >= 30) {
    return { mimeType: "image/webp", width: uint24le(buffer, 24) + 1, height: uint24le(buffer, 27) + 1 };
  }
  if (chunk === "VP8 " && buffer.length >= 30 && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
    return {
      mimeType: "image/webp",
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunk === "VP8L" && buffer.length >= 25 && buffer[20] === 0x2f) {
    const bits = buffer.readUInt32LE(21);
    return { mimeType: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  return null;
}

export function inspectImageBuffer(buffer, { contentType = "", maxBytes = 10 * 1024 * 1024 } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new ImageValidationError("IMAGE_EMPTY", "图片响应为空。", { status: 422 });
  }
  if (buffer.length > maxBytes) {
    throw new ImageValidationError("IMAGE_TOO_LARGE", "图片超过允许大小。", { status: 413 });
  }
  const declared = normalizedContentType(contentType);
  if (!MIME_EXTENSIONS[declared]) {
    throw new ImageValidationError("IMAGE_CONTENT_TYPE_INVALID", "响应 Content-Type 不是支持的图片类型。");
  }
  const inspected = pngDimensions(buffer) || jpegDimensions(buffer) || webpDimensions(buffer);
  if (!inspected || inspected.width <= 0 || inspected.height <= 0) {
    throw new ImageValidationError("IMAGE_CORRUPTED", "图片文件头或宽高无效。");
  }
  if (inspected.mimeType !== declared) {
    throw new ImageValidationError("IMAGE_CONTENT_TYPE_MISMATCH", "图片文件头与 Content-Type 不一致。");
  }
  return Object.freeze({
    ...inspected,
    extension: MIME_EXTENSIONS[inspected.mimeType],
    fileSize: buffer.length,
    sha256: createHash("sha256").update(buffer).digest("hex"),
  });
}

function originalFilename(sourceUrl, extension) {
  try {
    const basename = decodeURIComponent(new URL(sourceUrl).pathname.split("/").pop() || "");
    return sanitizeFilename(basename, { fallback: `mabang-image${extension}` });
  } catch {
    return `mabang-image${extension}`;
  }
}

export class MabangImageAssetService {
  constructor({ repository, tempRoot, imageRoot, maxBytes = 10 * 1024 * 1024 }) {
    this.repository = repository;
    this.tempRoot = path.resolve(tempRoot);
    this.imageRoot = path.resolve(imageRoot);
    this.maxBytes = maxBytes;
  }

  async store({ buffer, contentType, sourceUrl }) {
    const inspected = inspectImageBuffer(buffer, { contentType, maxBytes: this.maxBytes });
    const existing = await this.repository.findAssetBySha256(inspected.sha256);
    if (existing?.status === "available") return { asset: existing, duplicate: true };

    const storageFilename = `${inspected.sha256}${inspected.extension}`;
    const relativePath = `mabang/${inspected.sha256.slice(0, 2)}/${storageFilename}`;
    const temporary = await createTemporaryFilePath(this.tempRoot, { prefix: "mabang-image", extension: inspected.extension });
    let moved = null;
    try {
      await fs.writeFile(temporary.path, buffer, { flag: "wx" });
      moved = await atomicMoveFile({
        sourceRoot: this.tempRoot,
        sourcePath: temporary.path,
        destinationRoot: this.imageRoot,
        destinationRelativePath: relativePath,
        allowedExtensions: Object.values(MIME_EXTENSIONS),
      });
      try {
        const asset = await this.repository.createAsset({
          id: randomUUID(),
          sourceSystem: "mabang",
          sourceUrl: sanitizeStoredSourceUrl(sourceUrl),
          storageFileId: randomUUID(),
          originalFilename: originalFilename(sourceUrl, inspected.extension),
          storageFilename,
          relativePath: moved.relativePath,
          sha256: inspected.sha256,
          mimeType: inspected.mimeType,
          width: inspected.width,
          height: inspected.height,
          fileSize: inspected.fileSize,
          status: "available",
        });
        return { asset, duplicate: false };
      } catch (error) {
        const concurrent = await this.repository.findAssetBySha256(inspected.sha256).catch(() => null);
        if (concurrent) {
          await removeFileInsideRoot(this.imageRoot, moved.path).catch(() => {});
          return { asset: concurrent, duplicate: true };
        }
        await removeFileInsideRoot(this.imageRoot, moved.path).catch(() => {});
        throw error;
      }
    } finally {
      await removeFileInsideRoot(this.tempRoot, temporary.path).catch(() => {});
    }
  }
}
