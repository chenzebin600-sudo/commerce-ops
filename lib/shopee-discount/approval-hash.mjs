import { createHash } from "node:crypto";

const VERSION = "SHOPEE_DISCOUNT_APPROVAL_V2";
const FIELDS = [
  "shop_id",
  "item_id",
  "model_id",
  "country",
  "sku",
  "original_minor",
  "target_minor",
  "price_source",
  "price_tier",
  "rule_source",
  "warehouse_watermark",
  "warehouse_approved_at",
  "activity_type",
  "target_discount_id",
  "renewal_discount_name",
  "renewal_marker",
  "renewal_price_tier",
  "renewal_starts_at",
  "renewal_ends_at",
  "renewal_fingerprint",
];
const NULLABLE_FIELDS = new Set([
  "warehouse_approved_at",
  "target_discount_id",
  "renewal_discount_name",
  "renewal_marker",
  "renewal_price_tier",
  "renewal_starts_at",
  "renewal_ends_at",
  "renewal_fingerprint",
]);

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest();
}

function approvalItem(item) {
  if (!item || typeof item !== "object") throw new TypeError("approval item must be an object");
  const result = {};
  for (const field of FIELDS) {
    if (typeof item[field] !== "string" && !(NULLABLE_FIELDS.has(field) && item[field] === null)) {
      throw new TypeError(`approval item field ${field} must be a defined string${NULLABLE_FIELDS.has(field) ? " or null" : ""}`);
    }
    result[field] = item[field];
  }
  return result;
}

function merkleRoot(nodes) {
  let level = nodes;
  while (level.length > 1) {
    const next = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index];
      const right = level[index + 1] ?? left;
      next.push(sha256(Buffer.concat([left, right])));
    }
    level = next;
  }
  return level[0];
}

export function buildApprovalRoot(items, { shardSize = 1000 } = {}) {
  if (!Array.isArray(items)) throw new TypeError("approval items must be an array");
  if (!Number.isSafeInteger(shardSize) || shardSize < 1) {
    throw new RangeError("shardSize must be a positive safe integer");
  }
  const seen = new Set();
  const leaves = items.map((item) => {
    const immutable = approvalItem(item);
    const key = `${immutable.shop_id}\u001F${immutable.item_id}\u001F${immutable.model_id}`;
    if (seen.has(key)) throw new RangeError(`duplicate approval item key: ${key}`);
    seen.add(key);
    return { key, hash: sha256(Buffer.from(canonicalJson(immutable), "utf8")) };
  }).sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));

  const shardHashes = [];
  for (let start = 0; start < leaves.length; start += shardSize) {
    shardHashes.push(merkleRoot(leaves.slice(start, start + shardSize).map((leaf) => leaf.hash)).toString("hex"));
  }
  return buildApprovalRootFromShardHashes(shardHashes, leaves.length);
}

export function buildApprovalRootFromShardHashes(shardHashes, itemCount) {
  if (!Array.isArray(shardHashes) || shardHashes.some((hash) => !/^[a-f0-9]{64}$/.test(hash))) {
    throw new TypeError("shard hashes must be SHA-256 hex strings");
  }
  if (!Number.isSafeInteger(itemCount) || itemCount < 0) throw new RangeError("itemCount must be a non-negative safe integer");
  const root = sha256(Buffer.from(canonicalJson({ shard_hashes: shardHashes, version: VERSION }), "utf8")).toString("hex");
  return { version: VERSION, root, shardHashes: [...shardHashes], itemCount };
}

export function createApprovalShardAccumulator() {
  const hash = createHash("sha256");
  hash.update('{"shard_hashes":[');
  let shardCount = 0;
  return {
    add(shardHash) {
      if (!/^[a-f0-9]{64}$/.test(shardHash)) throw new TypeError("shard hash must be a SHA-256 hex string");
      if (shardCount) hash.update(",");
      hash.update(JSON.stringify(shardHash));
      shardCount += 1;
    },
    finish(itemCount) {
      if (!Number.isSafeInteger(itemCount) || itemCount < 0) throw new RangeError("itemCount must be a non-negative safe integer");
      hash.update(`],"version":${JSON.stringify(VERSION)}}`);
      return { version: VERSION, root: hash.digest("hex"), itemCount, shardCount };
    },
  };
}
