import { pathToFileURL } from "node:url";

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

function syntheticPage(kind, shopOffset, offset, count) {
  return Array.from({ length: count }, (_, index) => ({
    kind,
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
  let maxResidentRecords = 0;
  const pages = { shops: 0, links: 0, variants: 0 };

  const observe = (records) => {
    if (!Array.isArray(records) || records.length > batch) {
      throw capacityError("SHOPEE_DISCOUNT_CAPACITY_PAGE_UNBOUNDED", "A source page exceeded the configured bound");
    }
    maxResidentRecords = Math.max(maxResidentRecords, records.length);
    peakHeap = Math.max(peakHeap, Number(heapUsed()));
  };

  const source = mode === "postgresql" ? postgresSource : {
    async shops(offset, limit) { return syntheticPage("shop", 0, offset, Math.min(limit, shops - offset)); },
    async links(shopOffset, offset, limit) { return syntheticPage("link", shopOffset, offset, Math.min(limit, links - offset)); },
    async variants(shopOffset, offset, limit) { return syntheticPage("variant", shopOffset, offset, Math.min(limit, variants - offset)); },
  };

  for (let shopCursor = 0; shopCursor < shops; shopCursor += batch) {
    const shopPage = await source.shops(shopCursor, Math.min(batch, shops - shopCursor));
    observe(shopPage);
    pages.shops += 1;
    for (let pageShopIndex = 0; pageShopIndex < shopPage.length; pageShopIndex += 1) {
      const shopOffset = shopCursor + pageShopIndex;
      for (let cursor = 0; cursor < links; cursor += batch) {
        observe(await source.links(shopOffset, cursor, Math.min(batch, links - cursor)));
        pages.links += 1;
      }
      for (let cursor = 0; cursor < variants; cursor += batch) {
        observe(await source.variants(shopOffset, cursor, Math.min(batch, variants - cursor)));
        pages.variants += 1;
      }
    }
  }

  const heapGrowthBytes = Math.max(0, peakHeap - initialHeap);
  if (heapGrowthBytes > maxHeapGrowthBytes) {
    throw capacityError("SHOPEE_DISCOUNT_CAPACITY_HEAP_EXCEEDED", "Capacity check exceeded the bounded heap budget");
  }
  return Object.freeze({
    scale: { shops, links: shops * links, variants: shops * variants },
    pages,
    bounds: { pageSize: batch, maxResidentRecords, heapGrowthBytes, maxHeapGrowthBytes },
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
