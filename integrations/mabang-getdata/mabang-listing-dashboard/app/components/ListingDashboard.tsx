"use client";

import {
  Add20Regular,
  ArrowSync20Regular,
  BoxMultiple20Regular,
  CheckmarkCircle20Regular,
  ChevronDown16Regular,
  ChevronLeft16Regular,
  ChevronRight16Regular,
  ChevronUp16Regular,
  Dismiss16Regular,
  Info16Regular,
  Navigation20Regular,
  Open16Regular,
  Search20Regular,
  Warning20Regular,
} from "@fluentui/react-icons";
import {
  Badge,
  Button,
  Checkbox,
  FluentProvider,
  Input,
  Spinner,
  Tooltip,
  webLightTheme,
} from "@fluentui/react-components";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  PublisherSeedListing,
  PublisherWorkbench,
} from "./PublisherWorkbench";

const API_BASE = "http://127.0.0.1:8877/api";

type WarehouseStock = {
  stock?: number | string;
  warehouse_code?: string;
};

type ListingVariant = {
  variant_id: string | number;
  sku: string;
  stock_sku: string;
  price: string | number;
  sale_price: string | number;
  stock: string | number;
  warehouse_stock: WarehouseStock[];
  supply_price: string | number;
};

type Listing = {
  platform: string;
  platform_name: string;
  state: string;
  internal_id: string | number;
  product_id: string | number;
  product_url: string;
  title: string;
  parent_sku: string;
  currency: string;
  image: string;
  shop_id: string | number;
  shop_name: string;
  site: string;
  category_id: string | number;
  create_time: string;
  update_time: string;
  publish_time: string;
  variants: ListingVariant[];
};

type Shop = {
  id: string | number;
  name: string;
  site: string;
  currency: string;
  shop_type: string | number;
};

type PlatformState = {
  key: string;
  label: string;
  count_field?: string;
  count?: number;
};

type Platform = {
  key: string;
  name: string;
  platform_id?: number;
  states: PlatformState[];
  write_enabled?: boolean;
  write_fields?: string[];
  write_note?: string;
  shop_count?: number;
  listing_count?: number;
  shops?: Shop[];
};

type Snapshot = {
  meta: {
    source: string;
    generated_at: string;
    timezone: string;
    mode: string;
    platform_count: number;
    shop_count: number;
    listing_count: number;
  };
  platforms: Platform[];
  data_files: Record<string, Record<string, string[]>>;
  listings: Listing[];
};

type Session = {
  connected: boolean;
  username: string;
  account_host: string;
  connected_at: string;
};

type ListingPage = {
  items: Listing[];
  page: number;
  page_size: number;
  total: number;
  totals: Record<string, number | string>;
  fetched_at: string;
};

type Operation = {
  id: string;
  field: string;
  mode: string;
  value: string;
  spec_name: string;
};

type PreviewChange = {
  change_id: string;
  platform: string;
  internal_id: string;
  product_id: string;
  shop_name: string;
  title: string;
  variation_key: string;
  sku_id: string;
  sku: string;
  requested_sku: string;
  matched_sku: string;
  sku_match_type: "exact" | "virtual" | "all";
  virtual_suffix: string;
  field: string;
  spec_name?: string;
  field_label: string;
  old_value: string | number;
  new_value: string | number;
  affected_skus?: string[];
  source_command_index?: number;
};

type BatchPreview = {
  preview_token: string;
  created_at: string;
  expires_in_seconds: number;
  target_count: number;
  change_count: number;
  virtual_sku_count: number;
  command_count: number;
  match_sku: string;
  changes: PreviewChange[];
  warnings: string[];
  capability_note: string;
};

type JobResult = {
  platform: string;
  internal_id: string;
  product_id: string;
  shop_name: string;
  title: string;
  status: "submitting" | "verifying" | "success" | "failed";
  message: string;
  verified_changes: number;
  feedback_source?: "mabang_batch_status" | "detail_readback" | "";
  mabang_batch_id?: string;
  mabang_status?: "submitting" | "accepted" | "success" | "failed";
  verification_status?: "pending" | "verified" | "pending_refresh" | "failed";
};

type BatchJob = {
  job_id: string;
  state: "queued" | "running" | "completed" | "partial" | "failed";
  message: string;
  created_at: string;
  updated_at: string;
  total_products: number;
  submitted_products: number;
  processed_products: number;
  successful_products: number;
  failed_products: number;
  change_count: number;
  results: JobResult[];
};

type ApiEnvelope = {
  success: boolean;
  message?: string;
};

type AIParsedCommand = {
  action:
    | "price_update"
    | "promotion_update"
    | "stock_update"
    | "sku_replace"
    | "variation_update"
    | "unsupported";
  target: {
    sku: string;
    parent_sku: string;
    category: string;
  };
  scope: {
    platforms: string[];
    countries: string[];
    shop_ids: string[];
    shop_names: string[];
    categories: string[];
  };
  operation: {
    field: string;
    mode: string;
    value: unknown;
    unit: string;
  };
  need_confirm: true;
  risks: string[];
  clarifications: string[];
  confidence: number;
};

type AIIntentPreview = {
  phase: "AI_PARSE_ONLY";
  operation_type: string;
  risk_level: "low" | "medium" | "high";
  ready_for_scope_query: boolean;
  execution_allowed: false;
};

type AIResolvedScope = {
  platform: string;
  countries: string[];
  shops: { id: string; name: string; site: string }[];
  sku: string;
  parent_sku: string;
  category_ids: string[];
};

type AICommandItem = {
  command: AIParsedCommand;
  intentPreview: AIIntentPreview;
  resolvedScope: AIResolvedScope;
};

const mabangTheme = {
  ...webLightTheme,
  colorBrandForeground1: "#bd3f08",
  colorBrandForeground2: "#a73806",
  colorBrandBackground: "#e65718",
  colorBrandBackgroundHover: "#ca470d",
  colorBrandBackgroundPressed: "#a73806",
  colorBrandBackgroundSelected: "#bd3f08",
  colorCompoundBrandForeground1: "#bd3f08",
  colorCompoundBrandForeground1Hover: "#a73806",
  colorCompoundBrandForeground1Pressed: "#862d05",
  colorCompoundBrandStroke: "#e65718",
  colorCompoundBrandStrokeHover: "#ca470d",
  colorCompoundBrandStrokePressed: "#a73806",
  colorStrokeFocus2: "#e65718",
};

const platformShort: Record<string, string> = {
  lazada: "La",
  shopee: "Sh",
  tiktokshop: "Tk",
};

const searchOptions = [
  { value: "", label: "全部字段" },
  { value: "title", label: "商品标题" },
  { value: "sku", label: "SKU（父级/变体）" },
  { value: "product_id", label: "平台商品 ID" },
];

const batchFields = [
  { value: "price", label: "售价" },
  { value: "special_price", label: "促销价" },
  { value: "stock", label: "库存" },
  { value: "package_length", label: "包裹长度" },
  { value: "package_width", label: "包裹宽度" },
  { value: "package_height", label: "包裹高度" },
  { value: "package_weight", label: "包裹重量" },
  { value: "sku", label: "变体 SKU" },
  { value: "variation", label: "规格值" },
];

const batchModes = [
  { value: "set", label: "设为" },
  { value: "add", label: "增减" },
  { value: "percent", label: "按百分比调整" },
];

function numeric(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function compactNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function formatDate(value: string): string {
  if (!value) return "未记录";
  const normalized = value.replace("T", " ").replace(/[+-][0-9]{2}:[0-9]{2}$/, "");
  return normalized.slice(0, 16);
}

function formatDataTime(value: string): string {
  if (!value) return "尚未读取";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return formatDate(value);
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(parsed);
}

function rowKey(listing: Listing): string {
  return [
    listing.platform,
    listing.state,
    listing.internal_id,
    listing.product_id,
    listing.shop_id,
  ].join(":");
}

function firstImage(value: string): string {
  if (!value) return "";
  const candidate = value.split(",")[0]?.trim() ?? "";
  return /^https?:\/\//i.test(candidate) ? candidate : "";
}

function priceSummary(listing: Listing): { price: string; sale: string } {
  const prices = listing.variants
    .map((item) => numeric(item.price))
    .filter((item) => item > 0);
  const sales = listing.variants
    .map((item) => numeric(item.sale_price))
    .filter((item) => item > 0);
  const renderRange = (values: number[]) => {
    if (!values.length) return "未设置";
    const low = Math.min(...values);
    const high = Math.max(...values);
    return low === high ? low.toFixed(2) : `${low.toFixed(2)} ~ ${high.toFixed(2)}`;
  };
  return { price: renderRange(prices), sale: renderRange(sales) };
}

function stockSummary(listing: Listing): number {
  return listing.variants.reduce((sum, item) => sum + numeric(item.stock), 0);
}

function appendOperation(): Operation {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    field: "price",
    mode: "set",
    value: "",
    spec_name: "",
  };
}

async function responseJson<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as T & ApiEnvelope;
  if (!response.ok || payload.success === false) {
    throw new Error(payload.message || `请求失败，状态码 ${response.status}`);
  }
  return payload;
}

async function fetchSnapshot(): Promise<Snapshot> {
  const indexResponse = await fetch("/listings-index.json", { cache: "no-store" });
  if (!indexResponse.ok) {
    throw new Error(`快照索引请求失败，状态码 ${indexResponse.status}`);
  }
  const index = (await indexResponse.json()) as Omit<Snapshot, "listings">;
  const files = Object.values(index.data_files)
    .flatMap((platformFiles) => Object.values(platformFiles))
    .flat();
  const chunks = await Promise.all(
    files.map(async (file) => {
      const response = await fetch(file, { cache: "no-store" });
      if (!response.ok) throw new Error(`刊登分片请求失败，状态码 ${response.status}`);
      return (await response.json()) as Listing[];
    }),
  );
  return { ...index, listings: chunks.flat() };
}

function operationFromAI(
  command: AIParsedCommand,
): Omit<Operation, "id"> | null {
  const field = command.operation.field;
  if (field === "sku" && command.operation.mode === "replace") {
    return {
      field,
      mode: "replace",
      value: String(command.operation.value ?? "").trim(),
      spec_name: "",
    };
  }
  if (
    field === "variation" &&
    command.operation.mode === "replace" &&
    typeof command.operation.value === "object" &&
    command.operation.value !== null
  ) {
    const variation = command.operation.value as {
      name?: unknown;
      spec_name?: unknown;
      value?: unknown;
    };
    return {
      field,
      mode: "replace",
      value: String(variation.value ?? "").trim(),
      spec_name: String(variation.name ?? variation.spec_name ?? "").trim(),
    };
  }
  const rawValue = Number(command.operation.value);
  if (!batchFields.some((item) => item.value === field) || !Number.isFinite(rawValue)) {
    return null;
  }
  switch (command.operation.mode) {
    case "set":
      return { field, mode: "set", value: String(rawValue), spec_name: "" };
    case "increase_amount":
      return { field, mode: "add", value: String(Math.abs(rawValue)), spec_name: "" };
    case "decrease_amount":
      return { field, mode: "add", value: String(-Math.abs(rawValue)), spec_name: "" };
    case "increase_percent":
      return field === "stock"
        ? null
        : { field, mode: "percent", value: String(Math.abs(rawValue)), spec_name: "" };
    case "decrease_percent":
      return field === "stock"
        ? null
        : { field, mode: "percent", value: String(-Math.abs(rawValue)), spec_name: "" };
    default:
      return null;
  }
}

function ListingRows({
  rows,
  selected,
  expanded,
  onToggleSelected,
  onToggleExpanded,
  onCopyToDraft,
}: {
  rows: Listing[];
  selected: Set<string>;
  expanded: Set<string>;
  onToggleSelected: (listing: Listing) => void;
  onToggleExpanded: (key: string) => void;
  onCopyToDraft?: (listing: Listing) => void;
}) {
  return rows.map((listing) => {
    const key = rowKey(listing);
    const prices = priceSummary(listing);
    const image = firstImage(listing.image);
    const isExpanded = expanded.has(key);
    return (
      <tbody key={key}>
        <tr>
          <td className="checkbox-col">
            <Checkbox
              aria-label={`选择 ${listing.title}`}
              checked={selected.has(key)}
              onChange={() => onToggleSelected(listing)}
            />
          </td>
          <td className="product-col">
            <div className="product-cell">
              {image ? (
                // Marketplace image hosts are dynamic and cannot be safely allowlisted.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  className="product-image"
                  src={image}
                  alt={`${listing.title} 主图`}
                  loading="lazy"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <span className="product-image-fallback">无图</span>
              )}
              <div className="product-copy">
                {listing.product_url ? (
                  <a
                    className="product-title product-title-link"
                    href={listing.product_url}
                    target="_blank"
                    rel="noreferrer"
                    title={listing.title}
                  >
                    {listing.title || "未命名商品"}
                  </a>
                ) : (
                  <span className="product-title">{listing.title || "未命名商品"}</span>
                )}
                <span className="product-id">
                  平台 ID: {listing.product_id || "未记录"} · 马帮 ID:{" "}
                  {listing.internal_id || "未记录"}
                </span>
                {listing.product_url ? (
                  <a
                    className="product-url"
                    href={listing.product_url}
                    target="_blank"
                    rel="noreferrer"
                    title={listing.product_url}
                  >
                    <span className="product-url-label">商品链接</span>
                    <span className="product-url-value">{listing.product_url}</span>
                  </a>
                ) : null}
              </div>
            </div>
          </td>
          <td className="shop-col">
            <span className="shop-name" title={listing.shop_name}>
              {listing.shop_name || "未识别店铺"}
            </span>
            <span className="shop-site">{listing.site || "未标记站点"}</span>
          </td>
          <td className="sku-col">
            <span className="sku-value mono" title={listing.parent_sku}>
              {listing.parent_sku || "未设置"}
            </span>
            <span className="variant-count">{listing.variants.length} 个变体</span>
          </td>
          <td className="number-col">
            <span className="numeric">
              {listing.currency ? `${listing.currency} ` : ""}
              {prices.price}
            </span>
            {prices.sale !== "未设置" ? (
              <span className="price-sale">促销 {prices.sale}</span>
            ) : null}
          </td>
          <td className="number-col">
            <span className="numeric">{compactNumber(stockSummary(listing))}</span>
          </td>
          <td className="time-col">
            <span className="time-value">发布 {formatDate(listing.publish_time)}</span>
            <span className="time-value">更新 {formatDate(listing.update_time)}</span>
          </td>
          <td className="action-col">
            <div className="row-actions">
              {onCopyToDraft ? (
                <Tooltip content="复制为刊登草稿" relationship="label">
                  <Button
                    aria-label="复制为刊登草稿"
                    appearance="subtle"
                    icon={<Add20Regular />}
                    onClick={() => onCopyToDraft(listing)}
                  />
                </Tooltip>
              ) : null}
              <Tooltip content={isExpanded ? "收起变体" : "展开变体"} relationship="label">
                <Button
                  aria-label={isExpanded ? "收起变体" : "展开变体"}
                  appearance="subtle"
                  icon={isExpanded ? <ChevronUp16Regular /> : <ChevronDown16Regular />}
                  onClick={() => onToggleExpanded(key)}
                />
              </Tooltip>
              {listing.product_url ? (
                <Tooltip content="打开平台商品" relationship="label">
                  <Button
                    aria-label="打开平台商品"
                    appearance="subtle"
                    as="a"
                    href={listing.product_url}
                    target="_blank"
                    icon={<Open16Regular />}
                  />
                </Tooltip>
              ) : null}
            </div>
          </td>
        </tr>
        {isExpanded ? (
          <tr className="variant-detail-row">
            <td colSpan={8}>
              <div className="variant-panel">
                <table className="variant-table">
                  <thead>
                    <tr>
                      <th>变体 SKU</th>
                      <th>库存 SKU</th>
                      <th>SKU ID</th>
                      <th>价格</th>
                      <th>促销价</th>
                      <th>库存</th>
                      <th>供货价</th>
                    </tr>
                  </thead>
                  <tbody>
                    {listing.variants.length ? (
                      listing.variants.map((variant, index) => (
                        <tr key={`${key}:${variant.variant_id}:${index}`}>
                          <td className="mono">{variant.sku || "未设置"}</td>
                          <td className="mono">{variant.stock_sku || "未设置"}</td>
                          <td className="mono">{variant.variant_id || "未记录"}</td>
                          <td className="numeric">
                            {listing.currency ? `${listing.currency} ` : ""}
                            {numeric(variant.price).toFixed(2)}
                          </td>
                          <td className="numeric">
                            {numeric(variant.sale_price) > 0
                              ? `${listing.currency ? `${listing.currency} ` : ""}${numeric(
                                  variant.sale_price,
                                ).toFixed(2)}`
                              : "未设置"}
                          </td>
                          <td className="numeric">{compactNumber(numeric(variant.stock))}</td>
                          <td className="numeric">
                            {numeric(variant.supply_price) > 0
                              ? numeric(variant.supply_price).toFixed(2)
                              : "未设置"}
                          </td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan={7}>该商品未返回变体信息</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </td>
          </tr>
        ) : null}
      </tbody>
    );
  });
}

export function ListingDashboard() {
  const [localToken, setLocalToken] = useState("");
  const [session, setSession] = useState<Session | null>(null);
  const [mode, setMode] = useState<"checking" | "disconnected" | "connected" | "snapshot">(
    "checking",
  );
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [activePlatform, setActivePlatform] = useState("lazada");
  const [activeState, setActiveState] = useState("online");
  const [shops, setShops] = useState<Shop[]>([]);
  const [listingPage, setListingPage] = useState<ListingPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [username, setUsername] = useState("陈泽彬");
  const [password, setPassword] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [searchType, setSearchType] = useState("");
  const [query, setQuery] = useState("");
  const [selectedShops, setSelectedShops] = useState<string[]>([]);
  const [selectedRows, setSelectedRows] = useState<Map<string, Listing>>(new Map());
  const [allFilteredSelected, setAllFilteredSelected] = useState(false);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [command, setCommand] = useState("");
  const [aiCommandItems, setAICommandItems] = useState<AICommandItem[]>([]);
  const [aiParsing, setAIParsing] = useState(false);
  const [matchSku, setMatchSku] = useState("");
  const [operations, setOperations] = useState<Operation[]>([appendOperation()]);
  const [preview, setPreview] = useState<BatchPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [job, setJob] = useState<BatchJob | null>(null);
  const [workspaceMode, setWorkspaceMode] = useState<"manage" | "publish">("manage");
  const [publisherSeed, setPublisherSeed] =
    useState<PublisherSeedListing | null>(null);

  const apiFetch = useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      if (!localToken) throw new Error("本地桥接服务授权尚未建立。");
      const headers = new Headers(init?.headers);
      headers.set("X-Mabang-Local-Token", localToken);
      if (init?.body) headers.set("Content-Type", "application/json");
      const response = await fetch(`${API_BASE}${path}`, {
        ...init,
        headers,
        cache: "no-store",
      });
      return responseJson<T>(response);
    },
    [localToken],
  );

  const loadSnapshotFallback = useCallback(async () => {
    const data = await fetchSnapshot();
    setSnapshot(data);
    setPlatforms(data.platforms);
    setMode("snapshot");
    setLoading(false);
  }, []);

  const loadCatalog = useCallback(async () => {
    const payload = await apiFetch<
      ApiEnvelope & { session: Session; platforms: Platform[] }
    >("/platforms");
    setSession(payload.session);
    setPlatforms(payload.platforms);
    setMode("connected");
  }, [apiFetch]);

  const loadDynamicData = useCallback(
    async (requestedPage = page) => {
      if (mode !== "connected") return;
      setLoading(true);
      setError("");
      try {
        const shopPromise =
          shops.length && activePlatform === listingPage?.items[0]?.platform
            ? Promise.resolve({ shops })
            : apiFetch<ApiEnvelope & { shops: Shop[] }>(
                `/shops?platform=${encodeURIComponent(activePlatform)}`,
              );
        const params = new URLSearchParams({
          platform: activePlatform,
          state: activeState,
          page: String(requestedPage),
          page_size: String(pageSize),
        });
        if (selectedShops.length) params.set("shop_id", selectedShops.join(","));
        if (query.trim()) {
          params.set("search_type", searchType);
          params.set("search_value", query.trim());
        }
        const [shopPayload, pagePayload] = await Promise.all([
          shopPromise,
          apiFetch<ApiEnvelope & ListingPage>(`/listings?${params.toString()}`),
        ]);
        setShops(shopPayload.shops);
        setListingPage(pagePayload);
        setPage(requestedPage);
        setSelectedRows(new Map());
        setExpandedRows(new Set());
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "无法读取马帮刊登数据。");
      } finally {
        setLoading(false);
      }
    },
    [
      activePlatform,
      activeState,
      apiFetch,
      listingPage,
      mode,
      page,
      pageSize,
      query,
      searchType,
      selectedShops,
      shops,
    ],
  );

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/health`, { cache: "no-store" })
      .then((response) =>
        responseJson<
          ApiEnvelope & { local_token?: string; session: Session }
        >(response),
      )
      .then((health) => {
        if (cancelled) return;
        if (!health.local_token) throw new Error("本地桥接服务未授权当前页面。");
        setLocalToken(health.local_token);
        setSession(health.session);
        setUsername(health.session.username || "陈泽彬");
        setMode(health.session.connected ? "connected" : "disconnected");
      })
      .catch(() => {
        if (!cancelled) {
          loadSnapshotFallback().catch((reason: unknown) => {
            setError(reason instanceof Error ? reason.message : "无法加载刊登数据。");
            setLoading(false);
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [loadSnapshotFallback]);

  useEffect(() => {
    if (!localToken || mode !== "connected") return;
    queueMicrotask(() => {
      loadCatalog().catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : "无法读取马帮平台信息。");
        setLoading(false);
      });
    });
  }, [loadCatalog, localToken, mode]);

  useEffect(() => {
    if (mode !== "connected" || !platforms.length || listingPage) return;
    queueMicrotask(() => loadDynamicData(1));
  }, [listingPage, loadDynamicData, mode, platforms.length]);

  useEffect(() => {
    if (!job || !["queued", "running"].includes(job.state)) return;
    const timer = window.setInterval(() => {
      apiFetch<ApiEnvelope & BatchJob>(`/jobs/${job.job_id}`)
        .then((next) => {
          setJob(next);
          if (!["queued", "running"].includes(next.state)) {
            setNotice(next.message);
            loadDynamicData(page);
          }
        })
        .catch((reason: unknown) => {
          setError(reason instanceof Error ? reason.message : "无法读取同步任务状态。");
        });
    }, 600);
    return () => window.clearInterval(timer);
  }, [apiFetch, job, loadDynamicData, page]);

  const platform =
    platforms.find((item) => item.key === activePlatform) ?? platforms[0] ?? null;
  const availableBatchFields = batchFields.filter(
    (item) => !platform?.write_fields?.length || platform.write_fields.includes(item.value),
  );
  const state =
    platform?.states.find((item) => item.key === activeState) ?? platform?.states[0];

  const snapshotRows = useMemo(() => {
    if (!snapshot || mode !== "snapshot") return [];
    const shopSet = new Set(selectedShops);
    const needle = query.trim().toLocaleLowerCase();
    return snapshot.listings.filter((listing) => {
      if (listing.platform !== activePlatform || listing.state !== activeState) return false;
      if (shopSet.size && !shopSet.has(String(listing.shop_id))) return false;
      if (!needle) return true;
      const values = [
        listing.title,
        listing.parent_sku,
        String(listing.product_id),
        ...listing.variants.flatMap((item) => [item.sku, item.stock_sku]),
      ];
      return values.some((value) => String(value).toLocaleLowerCase().includes(needle));
    });
  }, [activePlatform, activeState, mode, query, selectedShops, snapshot]);

  const rows = mode === "snapshot" ? snapshotRows : listingPage?.items ?? [];
  const total = mode === "snapshot" ? snapshotRows.length : listingPage?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const visibleRows =
    mode === "snapshot"
      ? rows.slice((page - 1) * pageSize, page * pageSize)
      : rows;
  const pageKeys = visibleRows.map(rowKey);
  const selectedKeys = allFilteredSelected
    ? new Set(pageKeys)
    : new Set(selectedRows.keys());
  const selectionCount = allFilteredSelected ? total : selectedRows.size;
  const allPageSelected =
    allFilteredSelected ||
    (pageKeys.length > 0 && pageKeys.every((key) => selectedKeys.has(key)));
  const somePageSelected = pageKeys.some((key) => selectedKeys.has(key));

  const currentShops =
    mode === "snapshot"
      ? platform?.shops ?? []
      : shops;

  const stateCount = (item: PlatformState): number => {
    if (mode === "snapshot") return item.count ?? 0;
    if (item.count_field && listingPage?.totals) {
      return numeric(listingPage.totals[item.count_field]);
    }
    return item.key === activeState ? total : 0;
  };

  const connectAccount = async (event: FormEvent) => {
    event.preventDefault();
    setConnecting(true);
    setError("");
    setNotice("");
    try {
      const payload = await apiFetch<
        ApiEnvelope & { session: Session }
      >("/session/login", {
        method: "POST",
        body: JSON.stringify({
          username,
          password,
          account_host: "900445.private.mabangerp.com",
        }),
      });
      setPassword("");
      setSession(payload.session);
      setMode("connected");
      setListingPage(null);
      setNotice("马帮刊登连接成功，正在读取 Lazada、Shopee 与 TikTok Shop 授权范围。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "马帮连接失败。");
    } finally {
      setConnecting(false);
    }
  };

  const disconnectAccount = async () => {
    try {
      await apiFetch<ApiEnvelope>("/session", { method: "DELETE" });
      setSession((current) =>
        current ? { ...current, connected: false, connected_at: "" } : current,
      );
      setMode("disconnected");
      setListingPage(null);
      setShops([]);
      setSelectedRows(new Map());
      setAllFilteredSelected(false);
      setNotice("马帮连接已断开，密码没有保存在本机。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法断开马帮连接。");
    }
  };

  const switchPlatform = (key: string) => {
    const next = platforms.find((item) => item.key === key);
    setActivePlatform(key);
    setActiveState(next?.states[0]?.key ?? "online");
    setSelectedShops([]);
    setSelectedRows(new Map());
    setAllFilteredSelected(false);
    setExpandedRows(new Set());
    setShops([]);
    setListingPage(null);
    setPage(1);
    setBatchOpen(false);
    setOperations([appendOperation()]);
    setMatchSku("");
    setPreview(null);
    setJob(null);
    setSidebarOpen(false);
    if (key !== "lazada") setWorkspaceMode("manage");
    setPublisherSeed(null);
  };

  const switchState = (key: string) => {
    setActiveState(key);
    setSelectedRows(new Map());
    setAllFilteredSelected(false);
    setExpandedRows(new Set());
    setListingPage(null);
    setPage(1);
  };

  const toggleRow = (listing: Listing) => {
    const key = rowKey(listing);
    if (allFilteredSelected) {
      const next = new Map<string, Listing>();
      visibleRows.forEach((item) => {
        if (rowKey(item) !== key) next.set(rowKey(item), item);
      });
      setAllFilteredSelected(false);
      setSelectedRows(next);
      return;
    }
    setSelectedRows((current) => {
      const next = new Map(current);
      if (next.has(key)) next.delete(key);
      else next.set(key, listing);
      return next;
    });
  };

  const togglePageRows = () => {
    if (allFilteredSelected) {
      setAllFilteredSelected(false);
      setSelectedRows(new Map());
      return;
    }
    setSelectedRows((current) => {
      const next = new Map(current);
      if (allPageSelected) visibleRows.forEach((item) => next.delete(rowKey(item)));
      else visibleRows.forEach((item) => next.set(rowKey(item), item));
      return next;
    });
  };

  const selectAllFilteredResults = () => {
    if (!total) return;
    setSelectedRows(new Map());
    setAllFilteredSelected(true);
    setBatchOpen(true);
    setPreview(null);
    setJob(null);
  };

  const toggleExpanded = (key: string) => {
    setExpandedRows((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const generateAIPreview = async () => {
    if (mode !== "connected") {
      setError("AI 范围预览需要实时读取马帮，请先连接本地桥接服务。");
      return;
    }
    if (!command.trim()) {
      setError("请先输入平台、国家、店铺、类目或 SKU 以及要执行的动作。");
      return;
    }
    setError("");
    setNotice("");
    setAICommandItems([]);
    setPreview(null);
    setJob(null);
    setAIParsing(true);
    setPreviewing(true);
    try {
      const payload = await apiFetch<
        ApiEnvelope & {
          command: AIParsedCommand;
          intent_preview: AIIntentPreview;
          resolved_scope: AIResolvedScope;
          commands?: AIParsedCommand[];
          intent_previews?: AIIntentPreview[];
          resolved_scopes?: AIResolvedScope[];
          batch_preview: BatchPreview;
        }
      >("/ai/preview", {
        method: "POST",
        body: JSON.stringify({ command }),
      });
      const parsedCommands = payload.commands ?? [payload.command];
      const intentPreviews = payload.intent_previews ?? [payload.intent_preview];
      const resolvedScopes = payload.resolved_scopes ?? [payload.resolved_scope];
      setAICommandItems(
        parsedCommands.map((parsedCommand, index) => ({
          command: parsedCommand,
          intentPreview: intentPreviews[index] ?? payload.intent_preview,
          resolvedScope: resolvedScopes[index] ?? payload.resolved_scope,
        })),
      );
      setMatchSku(
        parsedCommands.length === 1 ? parsedCommands[0].target.sku : "",
      );
      const executableOperations = parsedCommands
        .map(operationFromAI)
        .filter((item): item is Omit<Operation, "id"> => Boolean(item))
        .map((item) => ({ id: appendOperation().id, ...item }));
      if (executableOperations.length) setOperations(executableOperations);
      setPreview(payload.batch_preview);
      setBatchOpen(false);
      setNotice(
        `AI已识别 ${parsedCommands.length} 条指令，跨页找到 ${payload.batch_preview.target_count} 个商品，生成 ${payload.batch_preview.change_count} 项差异；尚未写入。`,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "AI无法生成范围预览。");
    } finally {
      setAIParsing(false);
      setPreviewing(false);
    }
  };

  const updateOperation = (id: string, values: Partial<Operation>) => {
    setOperations((current) =>
      current.map((item) => (item.id === id ? { ...item, ...values } : item)),
    );
    setPreview(null);
  };

  const generatePreview = async () => {
    if (mode !== "connected") {
      setError("当前是只读快照模式，请先通过本地启动器连接马帮。");
      return;
    }
    if (!selectionCount) {
      setError("请先在商品表中选择至少一个在线商品。");
      return;
    }
    setPreviewing(true);
    setError("");
    setNotice("");
    setPreview(null);
    setJob(null);
    try {
      const payload = await apiFetch<ApiEnvelope & BatchPreview>("/batch/preview", {
        method: "POST",
        body: JSON.stringify({
          ...(allFilteredSelected
            ? {
                target_query: {
                  platform: activePlatform,
                  state: activeState,
                  shop_ids: selectedShops,
                  search_type: query.trim() ? searchType : "",
                  search_value: query.trim(),
                },
              }
            : {
                targets: Array.from(selectedRows.values()).map((item) => ({
                  platform: item.platform,
                  internal_id: item.internal_id,
                  product_id: item.product_id,
                  shop_name: item.shop_name,
                  title: item.title,
                })),
              }),
          match_sku: matchSku,
          operations: operations.map(({ field, mode: operationMode, value, spec_name }) => ({
            field,
            mode: operationMode,
            value,
            spec_name,
          })),
        }),
      });
      setPreview(payload);
      setNotice(`已读取最新详情并生成 ${payload.change_count} 项差异，尚未写入。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法生成批量差异预览。");
    } finally {
      setPreviewing(false);
    }
  };

  const executePreview = async (selectedChangeIds: string[]) => {
    if (!preview) return;
    if (!selectedChangeIds.length) {
      setError("请至少勾选一个 SKU 变更后再提交。");
      return;
    }
    setError("");
    try {
      const payload = await apiFetch<ApiEnvelope & BatchJob>("/batch/execute", {
        method: "POST",
        body: JSON.stringify({
          preview_token: preview.preview_token,
          selected_change_ids: selectedChangeIds,
        }),
      });
      setJob(payload);
      setNotice("任务已创建；马帮受理后会立即显示，回读核验在后台并行进行。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法启动批量同步。");
    }
  };

  const goPage = (nextPage: number) => {
    const safe = Math.min(pageCount, Math.max(1, nextPage));
    if (mode === "connected") loadDynamicData(safe);
    else setPage(safe);
  };

  const queryListings = () => {
    setPage(1);
    setSelectedRows(new Map());
    setAllFilteredSelected(false);
    if (mode === "connected") loadDynamicData(1);
  };

  const resetFilters = () => {
    setQuery("");
    setSearchType("");
    setSelectedShops([]);
    setPage(1);
    setSelectedRows(new Map());
    setAllFilteredSelected(false);
    if (mode === "connected") {
      setListingPage(null);
    }
  };

  const connected = mode === "connected";
  const activeWriteEnabled =
    connected && Boolean(platform?.write_enabled) && activeState === "online";
  const currentDataTime =
    mode === "snapshot" ? snapshot?.meta.generated_at ?? "" : listingPage?.fetched_at ?? "";

  return (
    <FluentProvider theme={mabangTheme}>
      <div className="app-shell">
        <header className="topbar">
          <div className="topbar-left">
            <Button
              className="menu-button"
              appearance="subtle"
              aria-label="打开平台导航"
              icon={<Navigation20Regular />}
              onClick={() => setSidebarOpen((value) => !value)}
            />
            <div className="brand-lockup">
              <span className="brand-mark">MB</span>
              <span className="brand-name">马帮 ERP</span>
            </div>
            <span className="topbar-divider" />
            <span className="topbar-title">多店铺刊登控制台</span>
          </div>
          <div className="topbar-right">
            <Badge
              appearance="tint"
              color={connected ? "success" : mode === "snapshot" ? "warning" : "informative"}
            >
              {connected ? "实时接口" : mode === "snapshot" ? "只读快照" : "等待连接"}
            </Badge>
            {session?.connected ? <span>操作账号 {session.username}</span> : null}
            <span className="snapshot-time">数据 {formatDataTime(currentDataTime)}</span>
          </div>
        </header>

        <div className="workspace">
          {sidebarOpen ? (
            <button
              className="sidebar-scrim"
              aria-label="关闭平台导航"
              onClick={() => setSidebarOpen(false)}
            />
          ) : null}
          <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
            <div className="nav-section">
              <p className="nav-heading">产品刊登</p>
              <nav className="platform-nav" aria-label="刊登平台">
                {(platforms.length
                  ? platforms
                  : [
                      { key: "lazada", name: "Lazada", states: [], write_enabled: true },
                      { key: "shopee", name: "Shopee", states: [], write_enabled: true },
                      {
                        key: "tiktokshop",
                        name: "TikTokShop",
                        states: [],
                        write_enabled: true,
                      },
                    ]
                ).map((item) => (
                  <button
                    key={item.key}
                    className="platform-nav-button"
                    aria-current={activePlatform === item.key ? "page" : undefined}
                    onClick={() => switchPlatform(item.key)}
                  >
                    <span className={`platform-glyph ${item.key}`}>
                      {platformShort[item.key]}
                    </span>
                    <span className="platform-nav-copy">
                      <span className="platform-nav-name">{item.name} 刊登</span>
                      <span className="platform-nav-count">
                        {item.write_enabled ? "可预览并同步" : "动态查询"}
                      </span>
                    </span>
                  </button>
                ))}
              </nav>
            </div>
            <div className="sidebar-capability">
              <strong>当前写入边界</strong>
              <p>Lazada 在线商品：价格、促销价、库存、包裹尺寸与重量。</p>
              <p>Shopee / TikTok Shop：已接入 SKU 替换与规格值修改。</p>
              <p>所有写入必须先预览、逐项勾选，再由用户确认提交。</p>
            </div>
          </aside>

          <main className="content">
            {mode === "checking" ? (
              <div className="workspace-panel loading-state">
                <div className="state-content">
                  <Spinner size="large" label="正在检查本地马帮桥接服务" />
                </div>
              </div>
            ) : null}

            {mode === "disconnected" ? (
              <section className="connection-panel" aria-labelledby="connection-title">
                <div className="connection-copy">
                  <span className="connection-icon">
                    <BoxMultiple20Regular />
                  </span>
                  <div>
                    <h1 id="connection-title">连接马帮刊登</h1>
                    <p>
                      默认以陈泽彬为操作账号。连接成功后，页面会直接读取当前授权店铺和在线商品；密码只保存在本次本地运行的内存中。
                    </p>
                    <ol className="connection-flow" aria-label="连接后的操作流程">
                      <li>
                        <span>1</span>
                        <div>
                          <strong>读取授权范围</strong>
                          <small>同步当前账号可管理的平台与店铺</small>
                        </div>
                      </li>
                      <li>
                        <span>2</span>
                        <div>
                          <strong>生成批量差异</strong>
                          <small>按店铺、商品和 SKU 精确预览修改</small>
                        </div>
                      </li>
                      <li>
                        <span>3</span>
                        <div>
                          <strong>确认并回读</strong>
                          <small>逐商品同步，并再次读取结果验证</small>
                        </div>
                      </li>
                    </ol>
                  </div>
                </div>
                <form className="connection-form" onSubmit={connectAccount}>
                  <label>
                    <span>马帮登录账号</span>
                    <Input
                      value={username}
                      autoComplete="username"
                      onChange={(_event, data) => setUsername(data.value)}
                    />
                    <small>已默认填写“陈泽彬”；如果登录名不同，可直接修改。</small>
                  </label>
                  <label>
                    <span>马帮密码</span>
                    <Input
                      type="password"
                      value={password}
                      autoComplete="current-password"
                      onChange={(_event, data) => setPassword(data.value)}
                    />
                  </label>
                  <Button
                    type="submit"
                    appearance="primary"
                    disabled={!username.trim() || !password || connecting}
                  >
                    {connecting ? "正在连接…" : "连接马帮刊登"}
                  </Button>
                </form>
              </section>
            ) : null}

            {error ? (
              <div className="feedback-bar error-feedback" role="alert">
                <Warning20Regular />
                <span>{error}</span>
                <Button
                  appearance="subtle"
                  aria-label="关闭错误提示"
                  icon={<Dismiss16Regular />}
                  onClick={() => setError("")}
                />
              </div>
            ) : null}

            {notice ? (
              <div className="feedback-bar success-feedback" role="status">
                <CheckmarkCircle20Regular />
                <span>{notice}</span>
                <Button
                  appearance="subtle"
                  aria-label="关闭状态提示"
                  icon={<Dismiss16Regular />}
                  onClick={() => setNotice("")}
                />
              </div>
            ) : null}

            {mode === "connected" || mode === "snapshot" ? (
              <>
                <div className="page-head">
                  <div className="platform-title">
                    <span className={`platform-glyph ${activePlatform}`}>
                      {platformShort[activePlatform]}
                    </span>
                    <div>
                      <h1>{platform?.name ?? "刊登"} 商品</h1>
                      <p>
                        {connected
                          ? "数据直接来自当前马帮会话；每次写入前都会重新读取详情。"
                          : "本地桥接服务未启动，当前仅展示上次导出的只读快照。"}
                      </p>
                    </div>
                  </div>
                  <div className="snapshot-meta">
                    <Info16Regular aria-hidden />
                    <span>
                      {currentShops.length} 家店铺，当前筛选 {compactNumber(total)} 条
                    </span>
                    {connected ? (
                      <Button appearance="subtle" size="small" onClick={disconnectAccount}>
                        断开账号
                      </Button>
                    ) : null}
                  </div>
                </div>

                <div className="workspace-mode-switch" role="tablist" aria-label="工作台模式">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={workspaceMode === "manage"}
                    onClick={() => setWorkspaceMode("manage")}
                  >
                    在线商品修改
                    <span>批量 SKU、价格、库存与规格</span>
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={workspaceMode === "publish"}
                    disabled={!connected || activePlatform !== "lazada"}
                    onClick={() => setWorkspaceMode("publish")}
                  >
                    新建商品刊登
                    <span>手动创建、复制模板与 AI 资料</span>
                  </button>
                </div>

                {workspaceMode === "manage" ? (
                  <>
                <section className="ai-command-center" aria-labelledby="ai-command-title">
                  <div className="ai-command-intro">
                    <div>
                      <span className="ai-eyebrow">AI 运营入口</span>
                      <h2 id="ai-command-title">直接描述范围和动作</h2>
                      <p>
                        无需先翻页选商品。系统会解析平台、国家、店铺、类目与 SKU，
                        跨页查找影响链接，并读取最新详情生成差异。
                      </p>
                    </div>
                    <Badge appearance="tint" color={connected ? "success" : "warning"}>
                      {connected ? "马帮实时范围" : "连接后可用"}
                    </Badge>
                  </div>
                  <div className="ai-command-composer">
                    <textarea
                      value={command}
                      rows={3}
                      placeholder={
                        "支持多行指令，每行独立执行范围。例如：\n" +
                        "把imii店铺中的T5CC2561011库存数量修改为0\n" +
                        "把3C COMBO店铺中的T3CC1970671库存数量修改为99"
                      }
                      onChange={(event) => {
                        setCommand(event.target.value);
                        setAICommandItems([]);
                        setPreview(null);
                        setJob(null);
                      }}
                      onKeyDown={(event) => {
                        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                          event.preventDefault();
                          generateAIPreview();
                        }
                      }}
                    />
                    <div className="ai-command-actions">
                      <span>每行一条指令 · Ctrl + Enter 快速生成</span>
                      <Button
                        appearance="primary"
                        disabled={!connected || aiParsing || !command.trim()}
                        onClick={generateAIPreview}
                      >
                        {aiParsing || previewing ? "正在解析并跨页查找…" : "AI解析并生成预览"}
                      </Button>
                    </div>
                  </div>
                  <div className="ai-examples" aria-label="指令示例">
                    <span>试试：</span>
                    {[
                      "泰国 Lazada SKU A 售价上涨 10%",
                      "Shopee AbbyMall 店铺 SKU A 改成 SKU B",
                      "TikTok Shop Handy Tools 店铺 SKU A 的 Color 改为 Blue",
                    ].map((example) => (
                      <button key={example} type="button" onClick={() => setCommand(example)}>
                        {example}
                      </button>
                    ))}
                  </div>

                  {aiCommandItems.length ? (
                    <div className="ai-parse-result ai-scope-result" aria-live="polite">
                      <div className="ai-parse-heading">
                        <div>
                          <strong>
                            AI已识别 {aiCommandItems.length} 条独立指令
                          </strong>
                          <span>
                            每条指令将分别匹配店铺、SKU 与目标值，再合并为一次确认
                          </span>
                        </div>
                        <Badge appearance="tint" color="success">
                          全部范围已解析
                        </Badge>
                      </div>
                      <div className="ai-command-result-list">
                        {aiCommandItems.map(
                          ({ command: parsedCommand, intentPreview, resolvedScope }, index) => (
                            <div
                              className="ai-command-result-item"
                              key={`${parsedCommand.target.sku}:${index}`}
                            >
                              <span className="ai-command-index">指令 {index + 1}</span>
                              <div>
                                <span>店铺</span>
                                <strong>
                                  {resolvedScope.shops.length
                                    ? resolvedScope.shops
                                        .map((shop) => shop.name)
                                        .join("、")
                                    : "全部授权店铺"}
                                </strong>
                              </div>
                              <div>
                                <span>SKU / 类目</span>
                                <strong>
                                  {resolvedScope.sku ||
                                    resolvedScope.parent_sku ||
                                    resolvedScope.category_ids.join("、") ||
                                    "未限定"}
                                </strong>
                              </div>
                              <div>
                                <span>操作</span>
                                <strong>{intentPreview.operation_type}</strong>
                              </div>
                              <div>
                                <span>目标</span>
                                <strong>
                                  {String(parsedCommand.operation.value ?? "—")}
                                  {parsedCommand.operation.unit === "percent"
                                    ? "%"
                                    : parsedCommand.operation.unit === "quantity"
                                      ? " 件"
                                      : ""}
                                </strong>
                              </div>
                              <Badge
                                appearance="tint"
                                color={
                                  intentPreview.risk_level === "high"
                                    ? "danger"
                                    : intentPreview.risk_level === "medium"
                                      ? "warning"
                                      : "success"
                                }
                              >
                                {Math.round(parsedCommand.confidence * 100)}%
                              </Badge>
                            </div>
                          ),
                        )}
                      </div>
                      {aiCommandItems.some((item) => item.command.risks.length) ? (
                        <ul className="ai-parse-messages risk">
                          {aiCommandItems.flatMap((item, commandIndex) =>
                            item.command.risks.map((risk) => (
                              <li key={`${commandIndex}:${risk}`}>
                                指令 {commandIndex + 1}：{risk}
                              </li>
                            )),
                          )}
                        </ul>
                      ) : null}
                      <details>
                        <summary>查看标准 JSON</summary>
                        <pre>
                          {JSON.stringify(
                            {
                              commands: aiCommandItems.map(
                                (item) => item.command,
                              ),
                            },
                            null,
                            2,
                          )}
                        </pre>
                      </details>
                      <span className="ai-phase-note">
                        AI只负责识别范围和生成差异；点击“确认并同步到店铺”前不会写入。
                      </span>
                    </div>
                  ) : null}

                  {!batchOpen ? (
                    <>
                      {preview ? (
                        <BatchPreviewPanel
                          key={preview.preview_token}
                          preview={preview}
                          job={job}
                          onExecute={executePreview}
                        />
                      ) : null}
                      <BatchJobPanel job={job} />
                    </>
                  ) : null}
                </section>

                <section className="metric-strip" aria-label="刊登概览">
                  <div className="metric">
                    <span className="metric-label">已接入店铺</span>
                    <span className="metric-value">{compactNumber(currentShops.length)}</span>
                  </div>
                  <div className="metric">
                    <span className="metric-label">当前结果</span>
                    <span className="metric-value">{compactNumber(total)}</span>
                  </div>
                  {(platform?.states ?? []).slice(0, 4).map((item) => (
                    <div className="metric" key={item.key}>
                      <span className="metric-label">{item.label}</span>
                      <span
                        className={`metric-value ${
                          item.key === "online"
                            ? "online"
                            : ["prohibited", "deactivated"].includes(item.key)
                              ? "problem"
                              : ""
                        }`}
                      >
                        {compactNumber(stateCount(item))}
                      </span>
                    </div>
                  ))}
                </section>

                <section className="workspace-panel" aria-label="马帮商品列表">
                  <div className="status-tabs" role="tablist" aria-label="刊登状态">
                    {(platform?.states ?? []).map((item) => (
                      <button
                        key={item.key}
                        className="status-tab"
                        role="tab"
                        aria-selected={state?.key === item.key}
                        onClick={() => switchState(item.key)}
                      >
                        {item.label}
                        <span className="tab-count">{compactNumber(stateCount(item))}</span>
                      </button>
                    ))}
                  </div>

                  <div className="filter-bar">
                    <div className="filter-field compact-field">
                      <label htmlFor="search-type">搜索字段</label>
                      <select
                        id="search-type"
                        value={searchType}
                        onChange={(event) => setSearchType(event.target.value)}
                      >
                        {searchOptions.map((item) => (
                          <option key={item.value} value={item.value}>
                            {item.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="filter-field keyword-field">
                      <label htmlFor="keyword">关键词</label>
                      <Input
                        id="keyword"
                        value={query}
                        contentBefore={<Search20Regular />}
                        placeholder="输入标题、SKU 或平台商品 ID"
                        onChange={(_event, data) => setQuery(data.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") queryListings();
                        }}
                      />
                    </div>
                    <div className="filter-field shop-filter-field">
                      <label htmlFor="shop-filter">店铺</label>
                      <select
                        id="shop-filter"
                        value={selectedShops[0] ?? ""}
                        onChange={(event) => {
                          setSelectedShops(event.target.value ? [event.target.value] : []);
                          setPage(1);
                          setSelectedRows(new Map());
                          setAllFilteredSelected(false);
                        }}
                      >
                        <option value="">全部店铺</option>
                        {currentShops.map((shop) => (
                          <option key={String(shop.id)} value={String(shop.id)}>
                            {shop.name || String(shop.id)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="toolbar-actions">
                      <Button appearance="primary" icon={<Search20Regular />} onClick={queryListings}>
                        查询
                      </Button>
                      <Button icon={<Dismiss16Regular />} onClick={resetFilters}>
                        重置
                      </Button>
                      <Tooltip
                        content={connected ? "重新调用马帮接口" : "重新读取本地快照"}
                        relationship="description"
                      >
                        <Button
                          icon={<ArrowSync20Regular />}
                          onClick={() =>
                            connected ? loadDynamicData(page) : loadSnapshotFallback()
                          }
                        >
                          刷新
                        </Button>
                      </Tooltip>
                    </div>
                  </div>

                  <div className="list-toolbar">
                    <div className="selection-tools">
                      <span>
                        {allFilteredSelected ? "已选择全部筛选结果" : "已选择"}{" "}
                        <span className="selection-count">{selectionCount}</span> 个商品
                      </span>
                      {allPageSelected &&
                      !allFilteredSelected &&
                      total > visibleRows.length ? (
                        <Button
                          size="small"
                          appearance="subtle"
                          onClick={selectAllFilteredResults}
                        >
                          选择全部 {compactNumber(total)} 条筛选结果
                        </Button>
                      ) : null}
                      {allFilteredSelected ? (
                        <Button
                          size="small"
                          appearance="subtle"
                          onClick={() => {
                            setAllFilteredSelected(false);
                            setSelectedRows(new Map());
                            setBatchOpen(false);
                          }}
                        >
                          清除全部选择
                        </Button>
                      ) : null}
                      <Button
                        size="small"
                        appearance={batchOpen ? "primary" : "secondary"}
                        icon={<BoxMultiple20Regular />}
                        disabled={!activeWriteEnabled || selectionCount === 0}
                        onClick={() => setBatchOpen((value) => !value)}
                      >
                        手动批量修改
                      </Button>
                      {!activeWriteEnabled ? (
                        <span className="write-boundary">
                          {mode === "snapshot"
                            ? "快照不可写入"
                            : !platform?.write_enabled
                              ? "当前平台仅查询"
                              : "仅在线商品可写入"}
                        </span>
                      ) : null}
                    </div>
                    <span className="result-count">当前筛选共 {compactNumber(total)} 条</span>
                  </div>

                  {batchOpen ? (
                    <section className="batch-workbench" aria-labelledby="batch-title">
                      <div className="batch-heading">
                        <div>
                          <h2 id="batch-title">手动批量变更</h2>
                          <p>对已选商品设置精确字段规则，再从马帮读取最新详情生成差异。</p>
                        </div>
                        <Badge appearance="outline">
                          {allFilteredSelected ? "全部筛选结果" : `${selectionCount} 个商品`}
                        </Badge>
                      </div>

                      <div className="batch-rule-grid">
                        <label className="batch-sku-field">
                          <span>匹配变体 SKU</span>
                          <input
                            value={matchSku}
                            placeholder="留空表示选中商品的全部变体"
                            onChange={(event) => {
                              setMatchSku(event.target.value);
                              setPreview(null);
                            }}
                          />
                        </label>
                        <div className="operation-list">
                          <span className="operation-label">修改字段</span>
                          {operations.map((operation) => {
                            const textOperation = ["sku", "variation"].includes(
                              operation.field,
                            );
                            return (
                              <div className="operation-row" key={operation.id}>
                                <select
                                  aria-label="修改字段"
                                  value={operation.field}
                                  onChange={(event) => {
                                    const field = event.target.value;
                                    updateOperation(operation.id, {
                                      field,
                                      mode: ["sku", "variation"].includes(field)
                                        ? "replace"
                                        : "set",
                                      spec_name: field === "variation" ? operation.spec_name : "",
                                    });
                                  }}
                                >
                                  {availableBatchFields.map((item) => (
                                    <option key={item.value} value={item.value}>
                                      {item.label}
                                    </option>
                                  ))}
                                </select>
                                {operation.field === "variation" ? (
                                  <input
                                    aria-label="规格名称"
                                    type="text"
                                    value={operation.spec_name}
                                    placeholder="规格名，如 Color"
                                    onChange={(event) =>
                                      updateOperation(operation.id, {
                                        spec_name: event.target.value,
                                      })
                                    }
                                  />
                                ) : (
                                  <span className="operation-spec-placeholder" aria-hidden />
                                )}
                                <select
                                  aria-label="修改方式"
                                  value={textOperation ? "replace" : operation.mode}
                                  disabled={textOperation}
                                  onChange={(event) =>
                                    updateOperation(operation.id, { mode: event.target.value })
                                  }
                                >
                                  {textOperation ? (
                                    <option value="replace">替换为</option>
                                  ) : (
                                    batchModes.map((item) => (
                                      <option key={item.value} value={item.value}>
                                        {item.label}
                                      </option>
                                    ))
                                  )}
                                </select>
                                <input
                                  aria-label={textOperation ? "目标文本" : "目标数值"}
                                  type={textOperation ? "text" : "number"}
                                  step={textOperation ? undefined : "any"}
                                  value={operation.value}
                                  placeholder={
                                    operation.field === "sku"
                                      ? "新 SKU"
                                      : operation.field === "variation"
                                        ? "新规格值"
                                        : operation.mode === "add"
                                          ? "可填负数"
                                          : "目标值"
                                  }
                                  onChange={(event) =>
                                    updateOperation(operation.id, { value: event.target.value })
                                  }
                                />
                                <Button
                                  appearance="subtle"
                                  aria-label="删除修改项"
                                  icon={<Dismiss16Regular />}
                                  disabled={operations.length === 1}
                                  onClick={() =>
                                    setOperations((current) =>
                                      current.filter((item) => item.id !== operation.id),
                                    )
                                  }
                                />
                              </div>
                            );
                          })}
                          <Button
                            appearance="subtle"
                            size="small"
                            icon={<Add20Regular />}
                            onClick={() => setOperations((current) => [...current, appendOperation()])}
                          >
                            添加字段
                          </Button>
                        </div>
                      </div>

                      <div className="preview-actions">
                        <Button
                          appearance="primary"
                          disabled={
                            previewing ||
                            operations.some(
                              (item) =>
                                !item.value ||
                                (item.field === "variation" && !item.spec_name.trim()),
                            )
                          }
                          onClick={generatePreview}
                        >
                          {previewing ? "正在读取最新详情…" : "生成差异预览"}
                        </Button>
                        <span>每次最多 100 个商品；执行时按商品串行提交。</span>
                      </div>

                      {preview ? (
                        <BatchPreviewPanel
                          key={preview.preview_token}
                          preview={preview}
                          job={job}
                          onExecute={executePreview}
                        />
                      ) : null}
                      <BatchJobPanel job={job} />
                    </section>
                  ) : null}

                  {loading ? (
                    <div className="loading-state table-loading">
                      <div className="state-content">
                        <Spinner size="large" label="正在读取马帮刊登数据" />
                      </div>
                    </div>
                  ) : visibleRows.length ? (
                    <>
                      <div className="table-region">
                        <table className="listing-table">
                          <thead>
                            <tr>
                              <th className="checkbox-col">
                                <Checkbox
                                  aria-label="选择本页商品"
                                  checked={
                                    allPageSelected
                                      ? true
                                      : somePageSelected
                                        ? "mixed"
                                        : false
                                  }
                                  onChange={togglePageRows}
                                />
                              </th>
                              <th className="product-col">商品信息</th>
                              <th className="shop-col">店铺 / 站点</th>
                              <th className="sku-col">父 SKU / 变体</th>
                              <th className="number-col">价格</th>
                              <th className="number-col">库存</th>
                              <th className="time-col">刊登时间</th>
                              <th className="action-col">操作</th>
                            </tr>
                          </thead>
                          <ListingRows
                            rows={visibleRows}
                            selected={selectedKeys}
                            expanded={expandedRows}
                            onToggleSelected={toggleRow}
                            onToggleExpanded={toggleExpanded}
                            onCopyToDraft={
                              connected && activePlatform === "lazada"
                                ? (listing) => {
                                    setPublisherSeed({
                                      platform: listing.platform,
                                      internal_id: listing.internal_id,
                                      title: listing.title,
                                      image: listing.image,
                                      shop_id: listing.shop_id,
                                      site: listing.site,
                                      category_id: listing.category_id,
                                      variants: listing.variants,
                                    });
                                    setWorkspaceMode("publish");
                                  }
                                : undefined
                            }
                          />
                        </table>
                      </div>
                      <div className="pagination-bar">
                        <div className="page-size-control">
                          <span>每页</span>
                          <select
                            value={pageSize}
                            aria-label="每页显示条数"
                            onChange={(event) => {
                              setPageSize(Number(event.target.value));
                              setPage(1);
                              setSelectedRows(new Map());
                              setAllFilteredSelected(false);
                              if (connected) setListingPage(null);
                            }}
                          >
                            {[20, 50, 100].map((size) => (
                              <option key={size} value={size}>
                                {size}
                              </option>
                            ))}
                          </select>
                          <span>条</span>
                        </div>
                        <div className="pagination">
                          <Button
                            aria-label="上一页"
                            icon={<ChevronLeft16Regular />}
                            disabled={page <= 1}
                            onClick={() => goPage(page - 1)}
                          />
                          <span className="page-indicator">
                            {page} / {pageCount}
                          </span>
                          <Button
                            aria-label="下一页"
                            icon={<ChevronRight16Regular />}
                            disabled={page >= pageCount}
                            onClick={() => goPage(page + 1)}
                          />
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="empty-state">
                      <div className="state-content">
                        <span className="state-icon">
                          <BoxMultiple20Regular />
                        </span>
                        <h2>{state?.label ?? "当前状态"}下没有匹配商品</h2>
                        <p>请调整搜索关键词、店铺筛选，或切换其他刊登状态。</p>
                        <Button onClick={resetFilters}>清除筛选</Button>
                      </div>
                    </div>
                  )}
                </section>
                  </>
                ) : (
                  <PublisherWorkbench
                    connected={connected}
                    platform={activePlatform}
                    shops={currentShops}
                    apiFetch={apiFetch}
                    seedListing={publisherSeed}
                    onSeedConsumed={() => setPublisherSeed(null)}
                    onNotice={setNotice}
                    onError={setError}
                  />
                )}
              </>
            ) : null}
          </main>
        </div>
      </div>
    </FluentProvider>
  );
}

function BatchPreviewPanel({
  preview,
  job,
  onExecute,
}: {
  preview: BatchPreview;
  job: BatchJob | null;
  onExecute: (selectedChangeIds: string[]) => void;
}) {
  const [selectedChangeIds, setSelectedChangeIds] = useState<Set<string>>(
    () => new Set(preview.changes.map((change) => change.change_id)),
  );
  const allSelected =
    preview.changes.length > 0 &&
    selectedChangeIds.size === preview.changes.length;
  const toggleAllChanges = (checked: boolean) => {
    setSelectedChangeIds(
      checked
        ? new Set(preview.changes.map((change) => change.change_id))
        : new Set(),
    );
  };
  const toggleChange = (changeId: string, checked: boolean) => {
    setSelectedChangeIds((current) => {
      const next = new Set(current);
      if (checked) next.add(changeId);
      else next.delete(changeId);
      return next;
    });
  };

  return (
    <div className="preview-result">
      <div className="preview-summary">
        <div>
          <strong>
            {preview.command_count} 条指令 · {preview.target_count} 个商品 ·{" "}
            已选 {selectedChangeIds.size}/{preview.change_count} 项变更
          </strong>
          <span>{preview.capability_note}</span>
        </div>
        <div className="preview-badges">
          {preview.virtual_sku_count ? (
            <Badge appearance="tint" color="warning">
              {preview.virtual_sku_count} 个虚拟 SKU 待确认
            </Badge>
          ) : null}
          <Badge appearance="tint" color="warning">
            尚未写入
          </Badge>
        </div>
      </div>
      {preview.warnings.length ? (
        <ul className="preview-warnings">
          {preview.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
      <div className="preview-table-wrap">
        <table className="preview-table">
          <thead>
            <tr>
              <th className="preview-select-col">
                <Checkbox
                  aria-label="选择全部 SKU 变更"
                  checked={
                    allSelected
                      ? true
                      : selectedChangeIds.size
                        ? "mixed"
                        : false
                  }
                  onChange={(_event, data) =>
                    toggleAllChanges(data.checked === true)
                  }
                />
              </th>
              <th>店铺</th>
              <th>商品 / SKU</th>
              <th>字段</th>
              <th>原值</th>
              <th>新值</th>
            </tr>
          </thead>
          <tbody>
            {preview.changes.map((change, index) => (
              <tr
                className={
                  [
                    change.sku_match_type === "virtual"
                      ? "preview-row-virtual"
                      : "",
                    selectedChangeIds.has(change.change_id)
                      ? ""
                      : "preview-row-unselected",
                  ]
                    .filter(Boolean)
                    .join(" ") || undefined
                }
                key={`${change.internal_id}:${change.variation_key}:${change.field}:${index}`}
              >
                <td className="preview-select-col">
                  <Checkbox
                    aria-label={`选择 ${change.matched_sku || change.sku} 的${change.field_label}变更`}
                    checked={selectedChangeIds.has(change.change_id)}
                    onChange={(_event, data) =>
                      toggleChange(change.change_id, data.checked === true)
                    }
                  />
                </td>
                <td>{change.shop_name || "未识别店铺"}</td>
                <td>
                  <span className="mono">{change.product_id}</span>
                  <span className="preview-sku mono">
                    {change.matched_sku || change.sku}
                  </span>
                  {change.sku_match_type === "virtual" ? (
                    <span className="virtual-sku-note">
                      虚拟 SKU {change.virtual_suffix} · 基础 SKU{" "}
                      <span className="mono">{change.requested_sku}</span>
                    </span>
                  ) : change.field === "variation" &&
                    (change.affected_skus?.length ?? 0) > 1 ? (
                    <span className="virtual-sku-note">
                      同一规格选项同时影响 {change.affected_skus?.length} 个 SKU
                    </span>
                  ) : (
                    <span className="exact-sku-note">精确 SKU</span>
                  )}
                </td>
                <td>{change.field_label}</td>
                <td className="numeric">{String(change.old_value)}</td>
                <td className="numeric change-new">{String(change.new_value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="confirmation-strip">
        <div className="confirmation-copy">
          <strong>
            {preview.virtual_sku_count
              ? "请确认虚拟 SKU 与修改差异"
              : "差异已核对"}
          </strong>
          <span>
            {preview.virtual_sku_count
              ? `包含 ${preview.virtual_sku_count} 个 S1～S9 虚拟 SKU；确认无误后才会提交。`
              : "点击后将立即提交，并回读店铺结果验证。"}
          </span>
        </div>
        <Button
          appearance="primary"
          disabled={
            !selectedChangeIds.size ||
            Boolean(job && ["queued", "running"].includes(job.state))
          }
          onClick={() => onExecute(Array.from(selectedChangeIds))}
        >
          确认并同步已选 {selectedChangeIds.size} 项
        </Button>
      </div>
    </div>
  );
}

function BatchJobPanel({ job }: { job: BatchJob | null }) {
  if (!job) return null;
  return (
    <div className={`job-panel job-${job.state}`}>
      <div className="job-head">
        <div>
          <strong>{job.message}</strong>
          <span>
            已提交 {job.submitted_products}/{job.total_products} · 已核验{" "}
            {job.processed_products}/{job.total_products}
          </span>
        </div>
        <Badge
          appearance="tint"
          color={
            job.state === "completed"
              ? "success"
              : job.state === "failed"
                ? "danger"
                : "warning"
          }
        >
          {job.state === "queued"
            ? "等待"
            : job.state === "running"
              ? "执行中"
              : job.state === "completed"
                ? "全部成功"
                : job.state === "partial"
                  ? "部分成功"
                  : "失败"}
        </Badge>
      </div>
      <div
        className="job-progress job-submit-progress"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={job.total_products}
        aria-valuenow={job.submitted_products}
      >
        <span
          style={{
            width: `${
              job.total_products
                ? (job.submitted_products / job.total_products) * 100
                : 0
            }%`,
          }}
        />
      </div>
      <div
        className="job-progress job-verify-progress"
        role="progressbar"
        aria-label="回读核验进度"
        aria-valuemin={0}
        aria-valuemax={job.total_products}
        aria-valuenow={job.processed_products}
      >
        <span
          style={{
            width: `${
              job.total_products
                ? (job.processed_products / job.total_products) * 100
                : 0
            }%`,
          }}
        />
      </div>
      {job.results.length ? (
        <ul className="job-results">
          {job.results.map((result) => (
            <li key={`${result.internal_id}:${result.status}`}>
              <span
                className={`result-status ${
                  result.status === "success"
                    ? "ok"
                    : result.status === "failed"
                      ? "failed"
                      : "pending"
                }`}
              >
                {result.status === "success"
                  ? "成功"
                  : result.status === "failed"
                    ? "失败"
                    : result.status === "verifying"
                      ? "核验中"
                      : "提交中"}
              </span>
              <strong>{result.shop_name || result.product_id}</strong>
              <span>
                {result.message}
                {result.feedback_source ? (
                  <small className="result-source">
                    {result.feedback_source === "mabang_batch_status"
                      ? "依据：马帮任务状态"
                      : "依据：刊登详情回读"}
                  </small>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
