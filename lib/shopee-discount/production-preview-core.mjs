export function indexActivitySelections(selections) {
  const byShop = new Map();
  for (const selection of selections) {
    if (!byShop.has(selection.shopId)) byShop.set(selection.shopId, []);
    byShop.get(selection.shopId).push(selection);
  }
  return byShop;
}

export function createProductionShardAccumulator({ shardSize, flushShard, observe = null }) {
  if (!Number.isSafeInteger(shardSize) || shardSize < 1) throw new TypeError("shardSize must be positive");
  let buffer = [], shardIndex = 0, itemCount = 0, maxBuffered = 0;
  const flush = async () => {
    if (!buffer.length) return;
    observe?.({ phase: "before-flush", buffered: buffer.length, shardIndex });
    const batch = buffer;
    buffer = [];
    await flushShard(batch, shardIndex++);
    observe?.({ phase: "after-flush", buffered: buffer.length, shardIndex });
  };
  return {
    add(item) {
      buffer.push(item); itemCount += 1; maxBuffered = Math.max(maxBuffered, buffer.length);
      observe?.({ phase: "after-add", buffered: buffer.length, shardIndex });
      return buffer.length === shardSize ? flush() : null;
    },
    flush,
    get size() { return buffer.length; },
    get itemCount() { return itemCount; },
    get shardCount() { return shardIndex + Number(buffer.length > 0); },
    get maxBuffered() { return maxBuffered; },
  };
}
