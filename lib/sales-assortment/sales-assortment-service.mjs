const COUNTRY_ALIASES = Object.freeze({
  "ID": "印度尼西亚",
  "TH": "泰国",
  "PH": "菲律宾",
  "VN": "越南",
  "MY": "马来西亚",
  "SG": "新加坡",
  "印尼": "印度尼西亚",
  "印度尼西亚": "印度尼西亚",
  "泰国": "泰国",
  "菲律宾": "菲律宾",
  "越南": "越南",
  "马来": "马来西亚",
  "马来西亚": "马来西亚",
  "新加坡": "新加坡",
});

const PERIODS = new Set([7, 28, 42]);

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function text(value, fallback = "") {
  const result = String(value ?? "").trim();
  return result || fallback;
}

function number(value, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((number(value) + Number.EPSILON) * factor) / factor;
}

function canonicalCountry(value) {
  const normalized = text(value);
  return COUNTRY_ALIASES[normalized] || normalized || "待映射";
}

function countryFromWarehouse(value) {
  const warehouse = text(value);
  for (const [prefix, country] of Object.entries(COUNTRY_ALIASES)) {
    if (warehouse.startsWith(prefix)) return country;
  }
  return "待映射";
}

function dayKey(value) {
  const source = text(value);
  const match = source.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function dateFromDay(value) {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function addDays(value, days) {
  const result = new Date(value);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function percent(numerator, denominator) {
  return denominator > 0 ? round((numerator / denominator) * 100, 1) : 0;
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN"));
}

function mapKey(...parts) {
  return parts.map((part) => text(part).toLowerCase()).join("\u001f");
}

function mergeTotals(target, source) {
  target.assortmentQuantity += source.assortmentQuantity;
  target.assortmentAmount += source.assortmentAmount;
  target.predictedDailySales += source.predictedDailySales;
  target.availableQuantity += source.availableQuantity;
  target.inTransitQuantity += source.inTransitQuantity;
  target.ownQuantity += source.ownQuantity;
  target.ownAmount += source.ownAmount;
  target.skuSet.add(source.sku);
}

function publicTotals(value) {
  const dailyGap = value.predictedDailySales - value.ownQuantity / value.periodDays;
  return {
    assortmentQuantity: round(value.assortmentQuantity),
    assortmentAmount: round(value.assortmentAmount),
    predictedDailySales: round(value.predictedDailySales),
    availableQuantity: round(value.availableQuantity),
    inTransitQuantity: round(value.inTransitQuantity),
    ownQuantity: round(value.ownQuantity),
    ownAmount: round(value.ownAmount),
    ownShare: percent(value.ownAmount, value.assortmentAmount),
    dailySalesGap: round(dailyGap),
    skuCount: value.skuSet.size,
  };
}

function emptyTotals(periodDays) {
  return {
    periodDays,
    assortmentQuantity: 0,
    assortmentAmount: 0,
    predictedDailySales: 0,
    availableQuantity: 0,
    inTransitQuantity: 0,
    ownQuantity: 0,
    ownAmount: 0,
    skuSet: new Set(),
  };
}

function salesForPeriod(row, periodDays) {
  if (periodDays === 7) return number(row.source_visible_sales_7d);
  if (periodDays === 42) return number(row.source_visible_sales_42d);
  return number(row.source_visible_sales_28d);
}

function filterMatch(item, filters) {
  return (!filters.country || item.country === filters.country)
    && (!filters.categoryL1 || item.categoryL1 === filters.categoryL1)
    && (!filters.categoryL2 || item.categoryL2 === filters.categoryL2)
    && (!filters.style || item.style === filters.style);
}

export class SalesAssortmentService {
  constructor({ repository }) {
    this.repository = repository;
  }

  async dashboard(input = {}) {
    const periodDays = PERIODS.has(Number(input.periodDays)) ? Number(input.periodDays) : 7;
    const filters = {
      country: text(input.country),
      categoryL1: text(input.categoryL1),
      categoryL2: text(input.categoryL2),
      style: text(input.style),
    };

    const [sourceStatus, mappingRows, packageRows, inventoryResult, orderRows] = await Promise.all([
      this.repository.sourceStatus(),
      this.repository.warehouseMappings(),
      this.repository.productPackageRows(),
      this.repository.latestInventoryRows(),
      this.repository.currentOrderRows(),
    ]);

    const warehouseCountries = new Map();
    for (const row of mappingRows) {
      const country = canonicalCountry(row.country_name || row.country_code);
      warehouseCountries.set(text(row.normalized_warehouse_name || row.source_warehouse_name).toLowerCase(), country);
    }

    const exactProducts = new Map();
    const countryProducts = new Map();
    const skuProducts = new Map();
    for (const row of packageRows) {
      const payload = parseJson(row.normalized_payload_json);
      const country = canonicalCountry(row.country_normalized || payload.country_raw);
      const sku = text(row.sku_normalized || payload.sku_code);
      const warehouse = text(row.warehouse_normalized || payload.warehouse_raw);
      const exchangeRate = number(payload.exchange_rate);
      const localPrice = number(payload.price_tier_45);
      const costCny = number(payload.cost_cny);
      const costLocal = number(payload.cost_local);
      const standardPriceCny = costCny > 0 && costLocal > 0
        ? localPrice * (costCny / costLocal)
        : exchangeRate > 0
          ? localPrice / exchangeRate
          : costCny;
      const product = {
        country,
        sku,
        warehouse,
        productName: text(payload.product_name, sku),
        categoryL1: text(payload.category_l1, "未分类"),
        categoryL2: text(payload.category_l2, "未分类"),
        style: text(payload.style_name, text(payload.product_name, "未归款")),
        mainSku: text(payload.main_sku_code, sku),
        standardPriceCny,
      };
      if (!sku) continue;
      const exactKey = mapKey(warehouse, sku);
      if (!exactProducts.has(exactKey)) exactProducts.set(exactKey, product);
      const countryKey = mapKey(country, sku);
      if (!countryProducts.has(countryKey)) countryProducts.set(countryKey, product);
      if (!skuProducts.has(sku)) skuProducts.set(sku, product);
    }

    const productFor = (warehouse, sku) => {
      const warehouseName = text(warehouse);
      const normalizedSku = text(sku);
      const mappedCountry = warehouseCountries.get(warehouseName.toLowerCase())
        || countryFromWarehouse(warehouseName);
      return exactProducts.get(mapKey(warehouseName, normalizedSku))
        || countryProducts.get(mapKey(mappedCountry, normalizedSku))
        || skuProducts.get(normalizedSku)
        || null;
    };

    const products = new Map();
    const inventoryRows = inventoryResult.rows;
    for (const row of inventoryRows) {
      const raw = parseJson(row.raw_values_json);
      const sku = text(row.normalized_source_sku || row.source_sku);
      const warehouse = text(row.normalized_warehouse_name || row.warehouse_name);
      const matched = productFor(warehouse, sku);
      const country = matched?.country
        || warehouseCountries.get(warehouse.toLowerCase())
        || countryFromWarehouse(warehouse);
      const productName = matched?.productName || text(raw["中文名称"], text(row.product_name, sku));
      const key = mapKey(country, productName);
      const current = products.get(key) || {
        key,
        country,
        productName,
        categoryL1: matched?.categoryL1 || text(row.category_level_1, "未分类"),
        categoryL2: matched?.categoryL2 || text(row.category_level_2, "未分类"),
        style: matched?.style || productName,
        mainSku: matched?.mainSku || sku,
        activity: text(raw["活跃度"], "未标记"),
        isNew: text(raw["是否新款"]) === "是",
        productStatus: text(row.product_status, "未知"),
        daysOfSupply: number(raw["当前可售天数"], number(row.days_of_supply)),
        periodDays,
        assortmentQuantity: 0,
        assortmentAmount: 0,
        predictedDailySales: 0,
        availableQuantity: 0,
        inTransitQuantity: 0,
        ownQuantity: 0,
        ownAmount: 0,
        skuSet: new Set(),
        sku,
        priceCoverage: 0,
      };
      const assortmentQuantity = salesForPeriod(row, periodDays);
      const price = number(matched?.standardPriceCny);
      current.assortmentQuantity += assortmentQuantity;
      current.assortmentAmount += assortmentQuantity * price;
      current.predictedDailySales += number(row.source_predicted_daily_sales);
      current.availableQuantity += number(row.available_quantity);
      current.inTransitQuantity += number(row.in_transit_quantity);
      current.skuSet.add(sku);
      if (price > 0) current.priceCoverage += 1;
      current.isNew ||= text(raw["是否新款"]) === "是";
      current.daysOfSupply = Math.max(current.daysOfSupply, number(raw["当前可售天数"], number(row.days_of_supply)));
      products.set(key, current);
    }

    const maxOrderDay = orderRows.map((row) => dayKey(row.paid_at)).filter(Boolean).sort().at(-1) || null;
    const startOrderDay = maxOrderDay
      ? addDays(dateFromDay(maxOrderDay), -(periodDays - 1)).toISOString().slice(0, 10)
      : null;
    const orderFacts = [];
    const daily = new Map();
    for (const row of orderRows) {
      const paidDay = dayKey(row.paid_at);
      if (!paidDay || (startOrderDay && paidDay < startOrderDay) || (maxOrderDay && paidDay > maxOrderDay)) continue;
      const raw = parseJson(row.raw_values_json);
      const sku = text(row.normalized_source_sku || row.source_sku);
      const warehouse = text(row.normalized_source_warehouse_name || row.source_warehouse_name);
      const matched = productFor(warehouse, sku);
      const country = matched?.country
        || warehouseCountries.get(warehouse.toLowerCase())
        || countryFromWarehouse(warehouse);
      const productName = matched?.productName || text(row.product_name, sku);
      const productKey = mapKey(country, productName);
      const quantity = number(row.quantity);
      const price = number(matched?.standardPriceCny);
      const amount = quantity * price;
      const fact = {
        productKey,
        country,
        productName,
        categoryL1: matched?.categoryL1 || "未分类",
        categoryL2: matched?.categoryL2 || "未分类",
        style: matched?.style || productName,
        sku,
        store: text(row.source_shop_name, "未识别店铺"),
        manager: text(raw["店长"], "待补负责人"),
        platform: text(row.platform, "unknown").toLowerCase(),
        quantity,
        amount,
        paidDay,
      };
      orderFacts.push(fact);
      const product = products.get(productKey);
      if (product) {
        product.ownQuantity += quantity;
        product.ownAmount += amount;
      }
      const day = daily.get(paidDay) || { date: paidDay, amount: 0, quantity: 0 };
      day.amount += amount;
      day.quantity += quantity;
      daily.set(paidDay, day);
    }

    const allProducts = [...products.values()];
    const optionProducts = allProducts.filter((item) => (
      (!filters.country || item.country === filters.country)
      && (!filters.categoryL1 || item.categoryL1 === filters.categoryL1)
      && (!filters.categoryL2 || item.categoryL2 === filters.categoryL2)
    ));
    const filteredProducts = allProducts.filter((item) => filterMatch(item, filters));
    const selectedKeys = new Set(filteredProducts.map((item) => item.key));
    const filteredOrders = orderFacts.filter((item) => selectedKeys.has(item.productKey));

    const summaryTotals = emptyTotals(periodDays);
    for (const product of filteredProducts) mergeTotals(summaryTotals, product);

    const hierarchyDimension = !filters.country
      ? "country"
      : !filters.categoryL1
        ? "categoryL1"
        : !filters.categoryL2
          ? "categoryL2"
          : "style";
    const hierarchyMap = new Map();
    for (const product of filteredProducts) {
      const label = product[hierarchyDimension] || "未分类";
      const item = hierarchyMap.get(label) || { label, ...emptyTotals(periodDays) };
      mergeTotals(item, product);
      hierarchyMap.set(label, item);
    }
    const hierarchy = [...hierarchyMap.values()]
      .map((item) => ({ label: item.label, ...publicTotals(item) }))
      .sort((a, b) => b.assortmentAmount - a.assortmentAmount);

    const matrixMap = new Map();
    for (const product of allProducts) {
      const key = mapKey(product.country, product.categoryL1);
      const item = matrixMap.get(key) || {
        country: product.country,
        category: product.categoryL1,
        ...emptyTotals(periodDays),
      };
      mergeTotals(item, product);
      matrixMap.set(key, item);
    }
    const opportunityMatrix = [...matrixMap.values()].map((item) => ({
      country: item.country,
      category: item.category,
      ...publicTotals(item),
      opportunityScore: round(Math.max(0, 100 - percent(item.ownAmount, item.assortmentAmount))),
    }));

    const topProducts = filteredProducts
      .map((item) => ({
        key: item.key,
        country: item.country,
        productName: item.productName,
        categoryL1: item.categoryL1,
        categoryL2: item.categoryL2,
        style: item.style,
        mainSku: item.mainSku,
        activity: item.activity,
        isNew: item.isNew,
        productStatus: item.productStatus,
        daysOfSupply: round(item.daysOfSupply),
        ...publicTotals(item),
        gapAmount: round(Math.max(0, item.assortmentAmount - item.ownAmount)),
      }))
      .sort((a, b) => b.assortmentAmount - a.assortmentAmount)
      .slice(0, 80);

    const storeMap = new Map();
    for (const fact of filteredOrders) {
      const key = mapKey(fact.store, fact.country);
      const item = storeMap.get(key) || {
        store: fact.store,
        country: fact.country,
        manager: fact.manager,
        platform: fact.platform,
        ownAmount: 0,
        ownQuantity: 0,
        categoryAmounts: new Map(),
        productKeys: new Set(),
      };
      item.ownAmount += fact.amount;
      item.ownQuantity += fact.quantity;
      item.manager = item.manager === "待补负责人" ? fact.manager : item.manager;
      item.categoryAmounts.set(fact.categoryL1, (item.categoryAmounts.get(fact.categoryL1) || 0) + fact.amount);
      item.productKeys.add(fact.productKey);
      storeMap.set(key, item);
    }
    const countryTotals = new Map();
    for (const product of filteredProducts) {
      const item = countryTotals.get(product.country) || emptyTotals(periodDays);
      mergeTotals(item, product);
      countryTotals.set(product.country, item);
    }
    const stores = [...storeMap.values()].map((store) => {
      const countryTotal = countryTotals.get(store.country) || emptyTotals(periodDays);
      const strengths = [...store.categoryAmounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([name]) => name);
      const countryProducts = filteredProducts
        .filter((product) => product.country === store.country)
        .sort((a, b) => b.assortmentAmount - a.assortmentAmount);
      const opportunities = countryProducts
        .filter((product) => !store.productKeys.has(product.key) && product.availableQuantity > 0)
        .slice(0, 5);
      const countryCategoryTotals = new Map();
      for (const product of countryProducts) {
        countryCategoryTotals.set(
          product.categoryL1,
          (countryCategoryTotals.get(product.categoryL1) || 0) + product.assortmentAmount,
        );
      }
      const weakCategory = [...countryCategoryTotals.entries()]
        .filter(([label]) => !strengths.includes(label))
        .sort((a, b) => b[1] - a[1])[0]?.[0] || "暂无";
      return {
        store: store.store,
        country: store.country,
        manager: store.manager,
        platform: store.platform,
        ownAmount: round(store.ownAmount),
        ownQuantity: round(store.ownQuantity),
        countryShare: percent(store.ownAmount, countryTotal.assortmentAmount),
        strength: strengths.join("、") || "待观察",
        weakness: weakCategory,
        opportunityCount: opportunities.length,
        opportunityProducts: opportunities.map((item) => item.productName),
      };
    }).sort((a, b) => b.ownAmount - a.ownAmount);

    const coverageDays = startOrderDay && maxOrderDay
      ? Math.round((dateFromDay(maxOrderDay) - dateFromDay(startOrderDay)) / 86400000) + 1
      : 0;
    const packagePriced = packageRows.filter((row) => {
      const payload = parseJson(row.normalized_payload_json);
      return number(payload.price_tier_45) > 0 && number(payload.exchange_rate) > 0;
    }).length;

    return {
      contract: {
        version: "SALES-ASSORTMENT-1.0.0",
        amountBasis: "产品包4档价(45%)按同行人民币/国家币成本关系折算",
        orderStatuses: ["待处理", "配货中", "已发货", "已完成"],
        aggregationKey: "国家 + 商品中文名称",
      },
      sourceStatus,
      filters: {
        selected: { ...filters, periodDays },
        options: {
          countries: uniqueSorted(allProducts.map((item) => item.country)),
          categoryL1: uniqueSorted(allProducts
            .filter((item) => !filters.country || item.country === filters.country)
            .map((item) => item.categoryL1)),
          categoryL2: uniqueSorted(allProducts
            .filter((item) => (!filters.country || item.country === filters.country)
              && (!filters.categoryL1 || item.categoryL1 === filters.categoryL1))
            .map((item) => item.categoryL2)),
          styles: uniqueSorted(optionProducts.map((item) => item.style)),
        },
      },
      period: {
        days: periodDays,
        orderDateFrom: startOrderDay,
        orderDateTo: maxOrderDay,
        availableOrderDays: coverageDays,
        sufficient: coverageDays >= periodDays,
      },
      summary: {
        ...publicTotals(summaryTotals),
        countryCount: new Set(filteredProducts.map((item) => item.country)).size,
        productCount: filteredProducts.length,
        storeCount: new Set(filteredOrders.map((item) => item.store)).size,
      },
      hierarchy: {
        dimension: hierarchyDimension,
        rows: hierarchy,
      },
      opportunityMatrix,
      trend: [...daily.values()]
        .filter((item) => filteredOrders.some((fact) => fact.paidDay === item.date))
        .map((item) => ({
          date: item.date,
          ownAmount: round(filteredOrders.filter((fact) => fact.paidDay === item.date)
            .reduce((sum, fact) => sum + fact.amount, 0)),
          ownQuantity: round(filteredOrders.filter((fact) => fact.paidDay === item.date)
            .reduce((sum, fact) => sum + fact.quantity, 0)),
          assortmentDailyAmount: round(summaryTotals.assortmentAmount / periodDays),
        }))
        .sort((a, b) => a.date.localeCompare(b.date)),
      topProducts,
      stores: stores.slice(0, 100),
      quality: {
        inventoryRows: inventoryRows.length,
        orderRows: orderRows.length,
        productPackageRows: packageRows.length,
        priceCoverage: percent(packagePriced, packageRows.length),
        unmatchedInventoryProducts: filteredProducts.filter((item) => item.priceCoverage === 0).length,
      },
    };
  }
}
