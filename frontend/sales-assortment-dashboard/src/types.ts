export type AuthorizedFetch = typeof fetch;

export interface SourceRecord {
  source_filename?: string;
  source_period?: string;
  row_count?: number;
  collected_at?: string;
  imported_at?: string;
  applied_at?: string;
  created_at?: string;
}

export interface DashboardData {
  contract: {
    version: string;
    amountBasis: string;
    orderStatuses: string[];
    aggregationKey: string;
  };
  sourceStatus: {
    order: SourceRecord | null;
    inventory: SourceRecord | null;
    productPackage: SourceRecord | null;
  };
  filters: {
    selected: {
      country: string;
      categoryL1: string;
      categoryL2: string;
      style: string;
      periodDays: number;
    };
    options: {
      countries: string[];
      categoryL1: string[];
      categoryL2: string[];
      styles: string[];
    };
  };
  period: {
    days: number;
    orderDateFrom: string | null;
    orderDateTo: string | null;
    availableOrderDays: number;
    sufficient: boolean;
  };
  summary: {
    assortmentQuantity: number;
    assortmentAmount: number;
    predictedDailySales: number;
    availableQuantity: number;
    inTransitQuantity: number;
    ownQuantity: number;
    ownAmount: number;
    ownShare: number;
    dailySalesGap: number;
    skuCount: number;
    countryCount: number;
    productCount: number;
    storeCount: number;
  };
  hierarchy: {
    dimension: "country" | "categoryL1" | "categoryL2" | "style";
    rows: PerformanceRow[];
  };
  opportunityMatrix: Array<PerformanceRow & {
    country: string;
    category: string;
    opportunityScore: number;
  }>;
  trend: Array<{
    date: string;
    ownAmount: number;
    ownQuantity: number;
    assortmentDailyAmount: number;
  }>;
  topProducts: ProductRow[];
  stores: StoreRow[];
  quality: {
    inventoryRows: number;
    orderRows: number;
    productPackageRows: number;
    priceCoverage: number;
    unmatchedInventoryProducts: number;
  };
}

export interface PerformanceRow {
  label: string;
  assortmentQuantity: number;
  assortmentAmount: number;
  predictedDailySales: number;
  availableQuantity: number;
  inTransitQuantity: number;
  ownQuantity: number;
  ownAmount: number;
  ownShare: number;
  dailySalesGap: number;
  skuCount: number;
}

export interface ProductRow extends PerformanceRow {
  key: string;
  country: string;
  productName: string;
  categoryL1: string;
  categoryL2: string;
  style: string;
  mainSku: string;
  activity: string;
  isNew: boolean;
  productStatus: string;
  daysOfSupply: number;
  gapAmount: number;
}

export interface StoreRow {
  store: string;
  country: string;
  manager: string;
  platform: string;
  ownAmount: number;
  ownQuantity: number;
  countryShare: number;
  strength: string;
  weakness: string;
  opportunityCount: number;
  opportunityProducts: string[];
}
