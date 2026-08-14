import { pathToFileURL } from "node:url";
import { createProductionShardAccumulator, indexActivitySelections } from "../lib/shopee-discount/production-preview-core.mjs";

const LOCKED_SCALE = Object.freeze({ shopCount: 1_000, linksPerShop: 1_000, variantsPerShop: 10_000 });
const MAX_PAGE_SIZE = 10_000;

function capacityError(code, message) {
  return Object.assign(new Error(message), { code });
}

function positiveInteger(value, name) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw new TypeError(`${name} must be a positive safe integer`);
  return result;
}

function syntheticItems(kind, shopOffset, offset, count) {
  return Array.from({ length: count }, (_, index) => ({
    kind,
    id: `${kind}-${shopOffset}-${offset + index}`,
    shopOffset,
    ordinal: offset + index,
  }));
}

/**
 * Exercises the production scale as pages, never as one materialized collection.
 * PostgreSQL mode deliberately requires an injected/configured source; dry-run never opens a socket.
 */
export async function runCapacityCheck({
  shopCount = LOCKED_SCALE.shopCount,
  linksPerShop = LOCKED_SCALE.linksPerShop,
  variantsPerShop = LOCKED_SCALE.variantsPerShop,
  pageSize = 1_000,
  mode = "dry-run",
  databaseUrl = "",
  postgresSource = null,
  now = () => performance.now(),
  heapUsed = () => process.memoryUsage().heapUsed,
  maxHeapGrowthBytes = 256 * 1024 * 1024,
} = {}) {
  const shops = positiveInteger(shopCount, "shopCount");
  const links = positiveInteger(linksPerShop, "linksPerShop");
  const variants = positiveInteger(variantsPerShop, "variantsPerShop");
  const batch = positiveInteger(pageSize, "pageSize");
  if (batch > MAX_PAGE_SIZE) {
    throw capacityError("SHOPEE_DISCOUNT_CAPACITY_PAGE_UNBOUNDED", `pageSize must not exceed ${MAX_PAGE_SIZE}`);
  }
  if (!new Set(["dry-run", "postgresql"]).has(mode)) throw new TypeError("mode must be dry-run or postgresql");
  if (mode === "postgresql" && (!String(databaseUrl).trim() || !postgresSource)) {
    throw capacityError(
      "SHOPEE_DISCOUNT_CAPACITY_POSTGRES_CONFIG_REQUIRED",
      "PostgreSQL capacity mode requires an explicit database URL and configured paged source",
    );
  }

  const startedAt = Number(now());
  const initialHeap = Number(heapUsed());
  let peakHeap = initialHeap;
  let maxResidentRecords = 0, currentSourcePageRecords = 0;
  let maxSourcePlusShardRecords = 0;
  const pages = { shops: 0, links: 0, variants: 0 };
  const observed = { shops: 0, links: 0, variants: 0 };
  const activitySelectionsByShop = indexActivitySelections(Array.from({ length: mode === "dry-run" ? shops : 0 }, (_, shopOffset) => ({
    shopId: `shop-0-${shopOffset}`, discountId: `discount-${shopOffset}`, priceTier: "DAILY",
  })));
  let persistedShards = 0, selectedVariants = 0;
  const samplePlannerResident = ({ buffered }) => {
    peakHeap = Math.max(peakHeap, Number(heapUsed()));
    maxSourcePlusShardRecords = Math.max(maxSourcePlusShardRecords, currentSourcePageRecords + buffered);
  };
  const plannerAccumulator = createProductionShardAccumulator({ shardSize: batch, observe: samplePlannerResident, async flushShard(items) {
    if (items.some(({ activity }) => !activity)) throw capacityError("SHOPEE_DISCOUNT_CAPACITY_PLANNER_MISMATCH", "Planner selection lost an indexed activity");
    persistedShards += 1;
  } });

  const observe = (records) => {
    if (!Array.isArray(records) || records.length > batch) {
      throw capacityError("SHOPEE_DISCOUNT_CAPACITY_PAGE_UNBOUNDED", "A source page exceeded the configured bound");
    }
    maxResidentRecords = Math.max(maxResidentRecords, records.length);
    peakHeap = Math.max(peakHeap, Number(heapUsed()));
  };

  const source = mode === "postgresql" ? postgresSource : {
    async shops(cursor, limit) {
      const offset = cursor == null ? 0 : Number(cursor);
      const count = Math.min(limit, shops - offset);
      const nextOffset = offset + count;
      return { items: syntheticItems("shop", 0, offset, count), nextCursor: nextOffset < shops ? String(nextOffset) : null, total: shops };
    },
    async links(shop, cursor, limit) {
      const offset = cursor == null ? 0 : Number(cursor);
      const count = Math.min(limit, links - offset);
      const nextOffset = offset + count;
      return { items: syntheticItems("link", shop.shopOffset, offset, count), nextCursor: nextOffset < links ? String(nextOffset) : null, total: links };
    },
    async variants(shop, cursor, limit) {
      const offset = cursor == null ? 0 : Number(cursor);
      const count = Math.min(limit, variants - offset);
      const nextOffset = offset + count;
      return { items: syntheticItems("variant", shop.shopOffset, offset, count), nextCursor: nextOffset < variants ? String(nextOffset) : null, total: variants };
    },
  };

  const consume = async (kind, expected, fetchPage, onItems = null) => {
    let cursor = null;
    let count = 0;
    const seenCursors = new Set();
    for (;;) {
      const requestedLimit = Math.min(batch, expected - count);
      const page = await fetchPage(cursor, requestedLimit);
      if (!page || !Array.isArray(page.items) || !Number.isSafeInteger(Number(page.total)) || Number(page.total) !== expected) {
        throw capacityError("SHOPEE_DISCOUNT_CAPACITY_INCOMPLETE", `${kind} source did not prove its declared total`);
      }
      observe(page.items);
      pages[kind] += 1;
      count += page.items.length;
      if (!page.items.length || count > expected || (page.nextCursor != null && page.items.length !== requestedLimit)
        || (count === expected && page.nextCursor != null)) {
        throw capacityError("SHOPEE_DISCOUNT_CAPACITY_INCOMPLETE", `${kind} source did not make bounded progress`);
      }
      await onItems?.(page.items);
      if (page.nextCursor == null) break;
      const next = String(page.nextCursor);
      if (!next || seenCursors.has(next)) {
        throw capacityError("SHOPEE_DISCOUNT_CAPACITY_INCOMPLETE", `${kind} source repeated a cursor`);
      }
      seenCursors.add(next);
      cursor = next;
    }
    if (count !== expected) throw capacityError("SHOPEE_DISCOUNT_CAPACITY_INCOMPLETE", `${kind} source ended before its declared total`);
    observed[kind] += count;
  };

  await consume("shops", shops, (cursor, limit) => source.shops(cursor, limit), async (shopPage) => {
    for (const shop of shopPage) {
      await consume("links", links, (cursor, limit) => source.links(shop, cursor, limit));
      await consume("variants", variants, (cursor, limit) => source.variants(shop, cursor, limit), async (variantPage) => {
        currentSourcePageRecords = variantPage.length;
        const shopId = String(shop.shopId ?? shop.id);
        if (!activitySelectionsByShop.has(shopId)) activitySelectionsByShop.set(shopId, [{ shopId, discountId: `discount-${shopId}`, priceTier: "DAILY" }]);
        const activity = activitySelectionsByShop.get(shopId)?.[0] || null;
        for (const variant of variantPage) {
          const pending = plannerAccumulator.add({ variant, activity });
          selectedVariants += Number(Boolean(activity));
          if (pending) await pending;
        }
        currentSourcePageRecords = 0;
      });
    }
  });
  await plannerAccumulator.flush();

  const heapGrowthBytes = Math.max(0, peakHeap - initialHeap);
  if (heapGrowthBytes > maxHeapGrowthBytes) {
    throw capacityError("SHOPEE_DISCOUNT_CAPACITY_HEAP_EXCEEDED", "Capacity check exceeded the bounded heap budget");
  }
  return Object.freeze({
    scale: { shops, links: shops * links, variants: shops * variants },
    observed,
    pages,
    bounds: { pageSize: batch,
      maxResidentRecords: maxSourcePlusShardRecords + activitySelectionsByShop.size,
      maxResidentComponents: { sourcePageRecords: maxResidentRecords, plannerShardRecords: plannerAccumulator.maxBuffered,
        sourcePlusShardRecords: maxSourcePlusShardRecords, activitySelectionEntries: activitySelectionsByShop.size },
      heapGrowthBytes, maxHeapGrowthBytes },
    productionCore: { activitySelection: "indexed-by-shop", selectedVariants, shardAccumulator: "production-preview-core", persistedShards,
      repositoryPaging: mode === "postgresql" ? "injected-repository-seam" : "bounded-dry-source" },
    elapsedMs: Number(now()) - startedAt,
    databaseMode: mode === "postgresql" ? "POSTGRESQL_PAGED_BENCHMARK" : "SIMULATED_PAGED_DRY_RUN",
    livePostgresqlDdlExecuted: false,
  });
}

async function main() {
  if (process.argv.includes("--postgresql")) {
    throw capacityError(
      "SHOPEE_DISCOUNT_CAPACITY_POSTGRES_CONFIG_REQUIRED",
      "Use the programmatic PostgreSQL mode with an explicitly configured paged source; this command never infers credentials",
    );
  }
  const report = await runCapacityCheck();
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((cause) => {
    process.stderr.write(`${cause?.code || "SHOPEE_DISCOUNT_CAPACITY_FAILED"}: ${cause?.message || "capacity check failed"}\n`);
    process.exitCode = 1;
  });
}
