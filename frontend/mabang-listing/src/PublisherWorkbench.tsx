"use client";

import {
  Add20Regular,
  ArrowSync20Regular,
  CheckmarkCircle20Regular,
  Copy20Regular,
  Delete20Regular,
  Search20Regular,
  Sparkle20Regular,
} from "@fluentui/react-icons";
import {
  Badge,
  Button,
  Spinner,
} from "@fluentui/react-components";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type PublisherApiFetch = <T>(
  path: string,
  init?: RequestInit,
) => Promise<T>;

export type PublisherShop = {
  id: string | number;
  name: string;
  site: string;
  currency?: string;
};

export type PublisherSeedListing = {
  platform: string;
  internal_id: string | number;
  title: string;
  image?: string;
  shop_id?: string | number;
  site?: string;
  category_id?: string | number;
  variants?: Array<{
    sku: string;
    stock_sku?: string;
    price: string | number;
    sale_price?: string | number;
    stock: string | number;
  }>;
};

type DraftVariant = {
  id?: string;
  sku: string;
  specification_name: string;
  specification_value: string;
  price: string | number;
  special_price?: string | number | null;
  stock: string | number;
  product_sku_id?: string;
  properties?: Array<Record<string, unknown>>;
  images?: string[];
  warehouse_stock?: Array<Record<string, unknown>>;
};

type DraftAsset = {
  id?: string;
  url: string;
};

type PublisherDraft = {
  id: string;
  platform: string;
  shop_id: string;
  shop_name: string;
  site: string;
  title: string;
  category_id: string;
  category_name: string;
  brand: string;
  description: string;
  attributes: Record<string, unknown>;
  extended: Record<string, unknown>;
  weight: string;
  package_length: string;
  package_width: string;
  package_height: string;
  status: string;
  version: number;
  confirmed_version: number | null;
  mabang_task_id: string;
  last_error: string;
  updated_at: string;
  variants: DraftVariant[];
  assets: DraftAsset[];
};

type PublishEvent = {
  id: number;
  event_type: string;
  status: string;
  message: string;
  created_at: string;
};

type PublishJob = {
  id: string;
  status: string;
  mabang_batch_id: string;
  message: string;
};

type PlatformListing = {
  platform_product_id: string;
  product_url: string;
};

type DraftForm = Omit<
  PublisherDraft,
  | "id"
  | "status"
  | "version"
  | "confirmed_version"
  | "mabang_task_id"
  | "last_error"
  | "updated_at"
>;

type ApiEnvelope = {
  success: boolean;
  message?: string;
};

type ListingTemplate = PublisherSeedListing & {
  shop_name?: string;
  product_id?: string | number;
};

type CategoryItem = Record<string, unknown>;

type CategoryField = {
  name?: string;
  label?: string;
  name_zh?: string;
  input_type?: string;
  is_mandatory?: boolean | number | string;
  is_sale_prop?: boolean | number | string;
  options?: unknown[];
  values?: unknown[];
};

type CategorySchema = {
  normal: CategoryField[];
  sku: CategoryField[];
  public: CategoryField[];
  logics: CategoryField[];
};

type ProductModelVariant = {
  productSkuId: string;
  sku: string;
  productName: string;
  salesSpec: string | null;
  country: string | null;
  stock: number;
  priceTier20: number | null;
  priceTier25: number | null;
  priceTier35: number | null;
  weightG: number | null;
  packageLengthCm: number | null;
  packageWidthCm: number | null;
  packageHeightCm: number | null;
  externalImageUrl: string | null;
};

type ProductModel = {
  id: string;
  mainSku: string;
  name: string;
  categoryL1: string | null;
  categoryL2: string | null;
  variantCount: number;
  countryCount: number;
  variants: ProductModelVariant[];
};

const statusLabels: Record<string, string> = {
  LOCAL_DRAFT: "本地草稿",
  SAVING_TO_MABANG: "正在保存",
  MABANG_DRAFT: "马帮草稿",
  READBACK_OK: "回读一致",
  VALIDATED: "校验通过",
  WAIT_CONFIRM: "等待确认",
  PUBLISH_SUBMITTED: "已提交",
  MABANG_ACCEPTED: "马帮已受理",
  PLATFORM_PROCESSING: "平台处理中",
  PUBLISHED: "已发布",
  FAILED: "需要处理",
};

function emptyForm(shops: PublisherShop[]): DraftForm {
  const shop = shops[0];
  return {
    platform: "lazada",
    shop_id: String(shop?.id ?? ""),
    shop_name: shop?.name ?? "",
    site: shop?.site ?? "",
    title: "",
    category_id: "",
    category_name: "",
    brand: "No Brand",
    description: "",
    attributes: {},
    extended: { source_mode: "manual" },
    weight: "0.1",
    package_length: "10",
    package_width: "10",
    package_height: "10",
    variants: [
      {
        sku: "",
        specification_name: "规格",
        specification_value: "默认",
        price: "",
        special_price: "",
        stock: "",
      },
    ],
    assets: [{ url: "" }],
  };
}

function draftToForm(draft: PublisherDraft): DraftForm {
  return {
    platform: draft.platform,
    shop_id: draft.shop_id,
    shop_name: draft.shop_name,
    site: draft.site,
    title: draft.title,
    category_id: draft.category_id,
    category_name: draft.category_name,
    brand: draft.brand,
    description: draft.description,
    attributes: draft.attributes,
    extended: draft.extended ?? {},
    weight: draft.weight,
    package_length: draft.package_length,
    package_width: draft.package_width,
    package_height: draft.package_height,
    variants: draft.variants.map((item) => ({ ...item })),
    assets: draft.assets.map((item) => ({ ...item })),
  };
}

function statusColor(status: string): "success" | "warning" | "danger" | "informative" {
  if (status === "PUBLISHED") return "success";
  if (status === "FAILED") return "danger";
  if (["WAIT_CONFIRM", "MABANG_ACCEPTED", "PLATFORM_PROCESSING"].includes(status)) {
    return "warning";
  }
  return "informative";
}

function fieldLabel(field: CategoryField) {
  return String(field.name_zh || field.label || field.name || "平台属性");
}

function fieldRequired(field: CategoryField) {
  return [true, 1, "1", "true", "yes", "required"].includes(
    field.is_mandatory as true | 1 | string,
  );
}

function fieldOptions(field: CategoryField) {
  const options = field.options ?? field.values ?? [];
  return options.map((item) => {
    if (item && typeof item === "object") {
      const option = item as Record<string, unknown>;
      return {
        value: String(option.value ?? option.id ?? option.name ?? ""),
        label: String(option.label ?? option.name_zh ?? option.name ?? option.value ?? ""),
      };
    }
    return { value: String(item ?? ""), label: String(item ?? "") };
  }).filter((item) => item.value);
}

export function PublisherWorkbench({
  connected,
  platform,
  shops,
  apiFetch,
  productApiFetch,
  seedListing,
  onSeedConsumed,
  onNotice,
  onError,
}: {
  connected: boolean;
  platform: string;
  shops: PublisherShop[];
  apiFetch: PublisherApiFetch;
  productApiFetch: PublisherApiFetch;
  seedListing: PublisherSeedListing | null;
  onSeedConsumed: () => void;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [drafts, setDrafts] = useState<PublisherDraft[]>([]);
  const [current, setCurrent] = useState<PublisherDraft | null>(null);
  const [form, setForm] = useState<DraftForm>(() => emptyForm(shops));
  const [events, setEvents] = useState<PublishEvent[]>([]);
  const [job, setJob] = useState<PublishJob | null>(null);
  const [listing, setListing] = useState<PlatformListing | null>(null);
  const [busy, setBusy] = useState("");
  const [aiOpen, setAiOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiWarnings, setAiWarnings] = useState<string[]>([]);
  const [sourceMode, setSourceMode] =
    useState<"manual" | "listing" | "product">("manual");
  const [sourceQuery, setSourceQuery] = useState("");
  const [listingTemplates, setListingTemplates] = useState<ListingTemplate[]>([]);
  const [productModels, setProductModels] = useState<ProductModel[]>([]);
  const [categoryQuery, setCategoryQuery] = useState("");
  const [categories, setCategories] = useState<CategoryItem[]>([]);
  const [categorySchema, setCategorySchema] = useState<CategorySchema | null>(null);
  const [sourceBusy, setSourceBusy] = useState("");
  const seedRef = useRef("");

  const loadDrafts = useCallback(async () => {
    if (!connected) return;
    const response = await apiFetch<ApiEnvelope & { drafts: PublisherDraft[] }>(
      "/publisher/drafts",
    );
    setDrafts(response.drafts);
    setCurrent((selected) => {
      if (!selected) return selected;
      return response.drafts.find((item) => item.id === selected.id) ?? selected;
    });
  }, [apiFetch, connected]);

  const loadEvents = useCallback(
    async (draftId: string) => {
      const response = await apiFetch<ApiEnvelope & { events: PublishEvent[] }>(
        `/publisher/drafts/${encodeURIComponent(draftId)}/events`,
      );
      setEvents(response.events);
    },
    [apiFetch],
  );

  const selectDraft = useCallback(
    (draft: PublisherDraft) => {
      setCurrent(draft);
      setForm(draftToForm(draft));
      setJob(null);
      setListing(null);
      setAiWarnings([]);
      const mode = String(draft.extended?.source_mode || "manual");
      setSourceMode(mode === "mabang_listing" ? "listing" : mode === "product_model" ? "product" : "manual");
      const schema = draft.extended?.category_schema;
      setCategorySchema(
        schema && typeof schema === "object" ? schema as CategorySchema : null,
      );
      loadEvents(draft.id).catch((reason: unknown) =>
        onError(reason instanceof Error ? reason.message : "无法读取草稿记录。"),
      );
    },
    [loadEvents, onError],
  );

  useEffect(() => {
    queueMicrotask(() => {
      loadDrafts().catch((reason: unknown) =>
        onError(reason instanceof Error ? reason.message : "无法读取刊登草稿。"),
      );
    });
  }, [loadDrafts, onError]);

  useEffect(() => {
    if (!seedListing || !connected) return;
    const seedKey = `${seedListing.platform}:${seedListing.internal_id}`;
    if (seedRef.current === seedKey) return;
    seedRef.current = seedKey;
    setBusy("copy");
    apiFetch<ApiEnvelope & { draft: PublisherDraft }>(
      "/publisher/drafts/from-listing",
      {
        method: "POST",
        body: JSON.stringify({
          platform: seedListing.platform,
          internal_id: seedListing.internal_id,
          listing_hint: seedListing,
        }),
      },
    )
      .then((response) => {
        selectDraft(response.draft);
        setDrafts((items) => [
          response.draft,
          ...items.filter((item) => item.id !== response.draft.id),
        ]);
        onNotice(`已把“${seedListing.title}”复制为本地刊登草稿。`);
      })
      .catch((reason: unknown) =>
        onError(reason instanceof Error ? reason.message : "复制商品模板失败。"),
      )
      .finally(() => {
        setBusy("");
        onSeedConsumed();
      });
  }, [
    apiFetch,
    connected,
    onError,
    onNotice,
    onSeedConsumed,
    seedListing,
    selectDraft,
  ]);

  useEffect(() => {
    if (!current || !["MABANG_ACCEPTED", "PLATFORM_PROCESSING"].includes(current.status)) {
      return;
    }
    const activeJob = job;
    if (!activeJob) return;
    const timer = window.setInterval(() => {
      apiFetch<
        ApiEnvelope & {
          draft: PublisherDraft;
          job: PublishJob;
          listing: PlatformListing | null;
        }
      >(`/publisher/jobs/${encodeURIComponent(activeJob.id)}/refresh`, {
        method: "POST",
        body: "{}",
      })
        .then((response) => {
          setCurrent(response.draft);
          setJob(response.job);
          setListing(response.listing);
          setDrafts((items) =>
            items.map((item) => (item.id === response.draft.id ? response.draft : item)),
          );
          if (["PUBLISHED", "FAILED"].includes(response.draft.status)) {
            loadEvents(response.draft.id);
          }
        })
        .catch(() => {
          // A transient poll failure is shown by the next explicit refresh.
        });
    }, 1500);
    return () => window.clearInterval(timer);
  }, [apiFetch, current, job, loadEvents]);

  const selectedShop = useMemo(
    () => shops.find((shop) => String(shop.id) === form.shop_id),
    [form.shop_id, shops],
  );

  const sourceCountryMatches = useCallback(
    (country: string | null) => {
      if (!country || !form.site) return false;
      const aliases: Record<string, string[]> = {
        TH: ["TH", "泰国"],
        PH: ["PH", "菲律宾"],
        ID: ["ID", "印度尼西亚", "印尼"],
        VN: ["VN", "越南"],
        MY: ["MY", "马来西亚", "马来"],
      };
      const target = aliases[form.site.toUpperCase()] ?? [form.site];
      return target.some((item) => item.toLocaleLowerCase("zh-CN") === country.toLocaleLowerCase("zh-CN"));
    },
    [form.site],
  );

  const searchExistingListings = async () => {
    setSourceBusy("listing-search");
    try {
      const params = new URLSearchParams({
        platform: "lazada",
        state: "online",
        page: "1",
        page_size: "20",
      });
      if (form.shop_id) params.set("shop_id", form.shop_id);
      if (sourceQuery.trim()) {
        params.set("search_type", "title");
        params.set("search_value", sourceQuery.trim());
      }
      const response = await apiFetch<ApiEnvelope & { items: ListingTemplate[] }>(
        `/listings?${params.toString()}`,
      );
      setListingTemplates(response.items ?? []);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "无法读取现有刊登链接。");
    } finally {
      setSourceBusy("");
    }
  };

  const useListingTemplate = async (template: ListingTemplate) => {
    setSourceBusy(`listing-${template.internal_id}`);
    try {
      const response = await apiFetch<ApiEnvelope & { draft: PublisherDraft }>(
        "/publisher/drafts/from-listing",
        {
          method: "POST",
          body: JSON.stringify({
            platform: "lazada",
            internal_id: template.internal_id,
            listing_hint: template,
          }),
        },
      );
      selectDraft(response.draft);
      setDrafts((items) => [
        response.draft,
        ...items.filter((item) => item.id !== response.draft.id),
      ]);
      onNotice("已复制现有链接的完整资料，可更换目标店铺后继续编辑。");
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "复制现有链接失败。");
    } finally {
      setSourceBusy("");
    }
  };

  const searchProductModels = async () => {
    setSourceBusy("product-search");
    try {
      const params = new URLSearchParams({
        keyword: sourceQuery.trim(),
        page: "1",
        page_size: "12",
      });
      const response = await productApiFetch<{ ok: boolean; models: ProductModel[] }>(
        `/api/product-center/product-models?${params.toString()}`,
      );
      setProductModels(response.models ?? []);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "无法读取产品中心款式。");
    } finally {
      setSourceBusy("");
    }
  };

  const useProductModel = (model: ProductModel) => {
    const countryVariants = model.variants.filter((item) =>
      sourceCountryMatches(item.country),
    );
    const variants = countryVariants.length ? countryVariants : model.variants;
    const images = [...new Set(variants.map((item) => item.externalImageUrl).filter(Boolean))] as string[];
    const first = variants[0];
    setForm((value) => ({
      ...value,
      title: model.name || value.title,
      category_name: [model.categoryL1, model.categoryL2].filter(Boolean).join(" / "),
      weight: first?.weightG ? String(first.weightG / 1000) : value.weight,
      package_length: first?.packageLengthCm ? String(first.packageLengthCm) : value.package_length,
      package_width: first?.packageWidthCm ? String(first.packageWidthCm) : value.package_width,
      package_height: first?.packageHeightCm ? String(first.packageHeightCm) : value.package_height,
      assets: images.map((url) => ({ url })),
      variants: variants.map((item) => ({
        sku: item.sku,
        product_sku_id: item.productSkuId,
        specification_name: "销售规格",
        specification_value: item.salesSpec || "默认",
        price: item.priceTier25 ?? item.priceTier20 ?? "",
        special_price: "",
        stock: item.stock,
        properties: [{ name: "variation", value: item.salesSpec || "Default" }],
        images: item.externalImageUrl ? [item.externalImageUrl] : [],
      })),
      extended: {
        ...value.extended,
        source_mode: "product_model",
        source_model_id: model.id,
        source_model_name: model.name,
        source_main_sku: model.mainSku,
      },
    }));
    onNotice(
      countryVariants.length
        ? `已按 ${form.site} 站点带入 ${variants.length} 个同款SKU。`
        : `该款式未找到与 ${form.site || "目标"} 站点一致的国家标记，已带入全部 ${variants.length} 个SKU，请人工筛选。`,
    );
  };

  const categoryLabel = (item: CategoryItem) =>
    String(
      item.name_zh ||
      item.category_name_zh ||
      item.name ||
      item.category_name_en ||
      item.category_name ||
      item.label ||
      "",
    );
  const categoryId = (item: CategoryItem) =>
    String(item.category_id || item.id || item.categoryId || "");

  const searchCategories = async () => {
    if (!form.shop_id || !form.site) {
      onError("请先选择目标店铺。");
      return;
    }
    setSourceBusy("category-search");
    try {
      const params = new URLSearchParams({
        platform: "lazada",
        shop_id: form.shop_id,
        site: form.site,
        parent_id: "-1",
        q: categoryQuery.trim(),
      });
      const response = await apiFetch<ApiEnvelope & { categories: CategoryItem[] }>(
        `/publisher/categories?${params.toString()}`,
      );
      setCategories(response.categories ?? []);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "无法查询平台类目。");
    } finally {
      setSourceBusy("");
    }
  };

  const loadCategorySchema = async (item?: CategoryItem) => {
    const selectedId = item ? categoryId(item) : form.category_id;
    if (!selectedId || !form.site) return;
    setSourceBusy("category-schema");
    try {
      const params = new URLSearchParams({
        platform: "lazada",
        site: form.site,
        category_id: selectedId,
      });
      const response = await apiFetch<ApiEnvelope & { schema: CategorySchema }>(
        `/publisher/category-schema?${params.toString()}`,
      );
      setCategorySchema(response.schema);
      setForm((value) => ({
        ...value,
        category_id: selectedId,
        category_name: item ? categoryLabel(item) : value.category_name,
        extended: {
          ...value.extended,
          category: item ?? value.extended.category ?? {},
          category_schema: response.schema,
          category_id_path: item?.category_id_path ?? item?.path ?? value.extended.category_id_path ?? [],
        },
        variants: value.variants.map((variant) => {
          const saleField = response.schema.sku.find((field) => field.name);
          if (!saleField || !["规格", "销售规格"].includes(variant.specification_name)) {
            return variant;
          }
          return {
            ...variant,
            specification_name: fieldLabel(saleField),
            properties: [{
              name: saleField.name,
              value: variant.specification_value,
            }],
          };
        }),
      }));
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "无法读取平台类目字段。");
    } finally {
      setSourceBusy("");
    }
  };

  const updateVariant = (index: number, patch: Partial<DraftVariant>) => {
    setForm((value) => ({
      ...value,
      variants: value.variants.map((item, itemIndex) =>
        itemIndex === index ? { ...item, ...patch } : item,
      ),
    }));
  };

  const saveLocal = async () => {
    setBusy("save");
    try {
      const path = current
        ? `/publisher/drafts/${encodeURIComponent(current.id)}/update`
        : "/publisher/drafts";
      const response = await apiFetch<ApiEnvelope & { draft: PublisherDraft }>(path, {
        method: "POST",
        body: JSON.stringify({
          ...form,
          variants: form.variants.map((variant) => {
            const saleField = categorySchema?.sku.find((field) => field.name);
            const hasCapturedProperties = variant.properties?.some(
              (item) => item.name && item.name !== "variation",
            );
            return saleField && !hasCapturedProperties
              ? {
                  ...variant,
                  specification_name: fieldLabel(saleField),
                  properties: [{
                    name: saleField.name,
                    value: variant.specification_value,
                  }],
                }
              : variant;
          }),
          extended: {
            ...form.extended,
            category_schema: categorySchema ?? form.extended.category_schema ?? {},
          },
        }),
      });
      selectDraft(response.draft);
      await loadDrafts();
      onNotice(current ? "本地刊登草稿已更新。" : "本地刊登草稿已创建。");
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "保存本地草稿失败。");
    } finally {
      setBusy("");
    }
  };

  const runDraftAction = async (
    action: "clone" | "save-to-mabang" | "confirm" | "publish",
  ) => {
    if (!current) return;
    setBusy(action);
    try {
      const response = await apiFetch<
        ApiEnvelope & {
          draft: PublisherDraft;
          job?: PublishJob;
          listing?: PlatformListing | null;
        }
      >(`/publisher/drafts/${encodeURIComponent(current.id)}/${action}`, {
        method: "POST",
        body: JSON.stringify(
          action === "confirm" ? { expected_version: current.version } : {},
        ),
      });
      selectDraft(response.draft);
      if (response.job) setJob(response.job);
      if (response.listing) setListing(response.listing);
      await loadDrafts();
      onNotice(
        action === "clone"
          ? "草稿副本已创建。"
          : action === "confirm"
            ? "当前草稿版本已人工确认。"
            : action === "publish"
              ? "刊登任务已提交马帮。"
              : "马帮草稿已保存并完成回读校验。",
      );
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "刊登流程操作失败。");
      if (current) {
        loadDrafts();
        loadEvents(current.id);
      }
    } finally {
      setBusy("");
    }
  };

  const generateMaterial = async () => {
    setBusy("ai");
    try {
      const response = await apiFetch<
        ApiEnvelope & {
          material: {
            title: string;
            brand: string;
            category_name: string;
            description: string;
            attributes: Record<string, string>;
            images: string[];
            variants: Array<{
              sku: string;
              specification_name: string;
              specification_value: string;
              price: number | null;
              stock: number | null;
            }>;
            warnings: string[];
            publishing_allowed: false;
          };
        }
      >("/publisher/ai/generate", {
        method: "POST",
        body: JSON.stringify({ prompt: aiPrompt }),
      });
      const material = response.material;
      setForm((value) => ({
        ...value,
        title: material.title || value.title,
        brand: material.brand || value.brand,
        category_name: material.category_name || value.category_name,
        description: material.description || value.description,
        attributes: material.attributes,
        assets: material.images.length
          ? material.images.map((url) => ({ url }))
          : value.assets,
        variants: material.variants.map((item) => ({
          sku: item.sku,
          specification_name: item.specification_name,
          specification_value: item.specification_value,
          price: item.price ?? "",
          special_price: "",
          stock: item.stock ?? "",
        })),
      }));
      setAiWarnings(material.warnings);
      onNotice("AI 商品资料已填入表单，请逐项检查后再保存。");
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "AI 商品资料生成失败。");
    } finally {
      setBusy("");
    }
  };

  if (!connected) {
    return (
      <section className="publisher-empty">
        <h2>连接马帮后创建刊登草稿</h2>
        <p>上架功能与商品修改共用同一套马帮登录会话，不需要再次输入账号。</p>
      </section>
    );
  }

  if (platform !== "lazada") {
    return (
      <section className="publisher-empty">
        <h2>第一阶段先接入 Lazada 上架闭环</h2>
        <p>Shopee 与 TikTok Shop 的在线修改功能保持不变，上架草稿将在接口捕获后逐步加入。</p>
      </section>
    );
  }

  return (
    <section className="publisher-workbench" aria-labelledby="publisher-title">
      <aside className="publisher-draft-rail">
        <div className="publisher-rail-head">
          <div>
            <span className="publisher-kicker">刊登草稿</span>
            <strong>{drafts.length} 个</strong>
          </div>
          <Button
            appearance="subtle"
            icon={<ArrowSync20Regular />}
            aria-label="刷新草稿"
            onClick={() => loadDrafts()}
          />
        </div>
        <Button
          appearance="primary"
          icon={<Add20Regular />}
          onClick={() => {
            setCurrent(null);
            setForm(emptyForm(shops));
            setSourceMode("manual");
            setCategorySchema(null);
            setEvents([]);
            setJob(null);
            setListing(null);
          }}
        >
          手动创建商品
        </Button>
        <div className="publisher-draft-list">
          {drafts.map((draft) => (
            <button
              type="button"
              key={draft.id}
              className={current?.id === draft.id ? "active" : ""}
              onClick={() => selectDraft(draft)}
            >
              <span>{draft.title}</span>
              <small>{draft.shop_name}</small>
              <Badge
                size="small"
                appearance="tint"
                color={statusColor(draft.status)}
              >
                {statusLabels[draft.status] ?? draft.status}
              </Badge>
            </button>
          ))}
          {!drafts.length ? (
            <p className="publisher-rail-empty">还没有草稿，可手动创建或从在线商品复制。</p>
          ) : null}
        </div>
      </aside>

      <div className="publisher-editor">
        <header className="publisher-editor-head">
          <div>
            <span className="publisher-kicker">Lazada · 单商品上架</span>
            <h2 id="publisher-title">
              {current ? "编辑刊登草稿" : "创建刊登草稿"}
            </h2>
            <p>资料保存到本地后，再经过马帮草稿回读、字段校验和人工确认。</p>
          </div>
          <div className="publisher-head-actions">
            {current ? (
              <Badge appearance="tint" color={statusColor(current.status)}>
                {statusLabels[current.status] ?? current.status}
              </Badge>
            ) : null}
            <Button
              icon={<Sparkle20Regular />}
              appearance={aiOpen ? "primary" : "secondary"}
              onClick={() => setAiOpen((value) => !value)}
            >
              AI 生成资料
            </Button>
            {current ? (
              <Button
                icon={<Copy20Regular />}
                onClick={() => runDraftAction("clone")}
                disabled={Boolean(busy)}
              >
                复制草稿
              </Button>
            ) : null}
          </div>
        </header>

        <div className="publisher-source-panel">
          <div className="publisher-section-head">
            <div>
              <span className="publisher-kicker">资料来源</span>
              <h3>选择一种起点，也可以完全手动填写</h3>
            </div>
            <div className="publisher-source-tabs" role="tablist" aria-label="刊登资料来源">
              {[
                ["manual", "手动创建"],
                ["listing", "复制现有链接"],
                ["product", "产品中心款式"],
              ].map(([value, label]) => (
                <button
                  type="button"
                  role="tab"
                  aria-selected={sourceMode === value}
                  className={sourceMode === value ? "active" : ""}
                  key={value}
                  onClick={() => {
                    setSourceMode(value as typeof sourceMode);
                    setSourceQuery("");
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          {sourceMode === "manual" ? (
            <p className="publisher-source-note">
              直接填写平台类目、属性和SKU；现有链接与产品中心都不是必选项。
            </p>
          ) : (
            <>
              <div className="publisher-source-search">
                <input
                  value={sourceQuery}
                  placeholder={
                    sourceMode === "listing"
                      ? "搜索当前账号的商品标题"
                      : "搜索款名、主SKU、SKU或产品名称"
                  }
                  onChange={(event) => setSourceQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      if (sourceMode === "listing") searchExistingListings();
                      else searchProductModels();
                    }
                  }}
                />
                <Button
                  icon={sourceBusy.endsWith("search") ? <Spinner size="tiny" /> : <Search20Regular />}
                  disabled={Boolean(sourceBusy)}
                  onClick={
                    sourceMode === "listing"
                      ? searchExistingListings
                      : searchProductModels
                  }
                >
                  搜索
                </Button>
              </div>
              <div className="publisher-source-results">
                {sourceMode === "listing"
                  ? listingTemplates.map((item) => (
                      <article key={String(item.internal_id)}>
                        {item.image ? <img src={item.image} alt="" /> : <span className="publisher-source-placeholder" />}
                        <div>
                          <strong>{item.title}</strong>
                          <small>{item.shop_name || "当前授权店铺"} · {item.site || "未标站点"}</small>
                          <span>{item.variants?.length ?? 0} 个变体</span>
                        </div>
                        <Button
                          size="small"
                          disabled={Boolean(sourceBusy)}
                          onClick={() => useListingTemplate(item)}
                        >
                          复制资料
                        </Button>
                      </article>
                    ))
                  : productModels.map((model) => (
                      <article key={model.id}>
                        <span className="publisher-source-placeholder publisher-model-mark">
                          {model.variantCount}
                        </span>
                        <div>
                          <strong>{model.name}</strong>
                          <small>{model.mainSku} · {[model.categoryL1, model.categoryL2].filter(Boolean).join(" / ") || "未分类"}</small>
                          <span>{model.variantCount} 个SKU · {model.countryCount} 个国家</span>
                        </div>
                        <Button
                          size="small"
                          disabled={Boolean(sourceBusy)}
                          onClick={() => useProductModel(model)}
                        >
                          使用整款
                        </Button>
                      </article>
                    ))}
              </div>
            </>
          )}
        </div>

        {aiOpen ? (
          <div className="publisher-ai-panel">
            <label htmlFor="publisher-ai-prompt">描述需要刊登的商品</label>
            <textarea
              id="publisher-ai-prompt"
              rows={4}
              value={aiPrompt}
              placeholder="例如：为一款 65W 三口氮化镓充电器生成 Lazada 英文商品资料，品牌 No Brand，颜色黑色。"
              onChange={(event) => setAiPrompt(event.target.value)}
            />
            <div>
              <span>AI 只生成可编辑资料，不能直接保存或发布。</span>
              <Button
                appearance="primary"
                icon={busy === "ai" ? <Spinner size="tiny" /> : <Sparkle20Regular />}
                disabled={!aiPrompt.trim() || Boolean(busy)}
                onClick={generateMaterial}
              >
                生成并填入
              </Button>
            </div>
            {aiWarnings.length ? (
              <ul>
                {aiWarnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        <div className="publisher-form-section">
          <h3>基础信息</h3>
          <div className="publisher-field-grid">
            <label>
              <span>目标店铺</span>
              <select
                value={form.shop_id}
                onChange={(event) => {
                  const shop = shops.find(
                    (item) => String(item.id) === event.target.value,
                  );
                  setForm((value) => ({
                    ...value,
                    shop_id: event.target.value,
                    shop_name: shop?.name ?? "",
                    site: shop?.site ?? "",
                  }));
                }}
              >
                <option value="">请选择店铺</option>
                {shops.map((shop) => (
                  <option key={String(shop.id)} value={String(shop.id)}>
                    {shop.name} {shop.site ? `· ${shop.site}` : ""}
                  </option>
                ))}
              </select>
              {selectedShop ? <small>站点：{selectedShop.site || "未标记"}</small> : null}
            </label>
            <label>
              <span>品牌</span>
              <input
                value={form.brand}
                onChange={(event) =>
                  setForm((value) => ({ ...value, brand: event.target.value }))
                }
              />
            </label>
            <label className="publisher-span-2">
              <span>商品标题</span>
              <input
                value={form.title}
                maxLength={500}
                onChange={(event) =>
                  setForm((value) => ({ ...value, title: event.target.value }))
                }
              />
            </label>
            <div className="publisher-category-picker publisher-span-2">
              <span>平台类目</span>
              <div className="publisher-source-search">
                <input
                  value={categoryQuery}
                  placeholder="输入类目名称，例如 Flower、Furniture"
                  onChange={(event) => setCategoryQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") searchCategories();
                  }}
                />
                <Button
                  icon={sourceBusy === "category-search" ? <Spinner size="tiny" /> : <Search20Regular />}
                  disabled={Boolean(sourceBusy)}
                  onClick={searchCategories}
                >
                  查平台类目
                </Button>
                {form.category_id ? (
                  <Button
                    disabled={Boolean(sourceBusy)}
                    onClick={() => loadCategorySchema()}
                  >
                    刷新字段
                  </Button>
                ) : null}
              </div>
              {form.category_id ? (
                <div className="publisher-category-current">
                  <strong>{form.category_name || "已选类目"}</strong>
                  <span>ID {form.category_id}</span>
                </div>
              ) : null}
              {categories.length ? (
                <div className="publisher-category-results">
                  {categories.slice(0, 12).map((item) => (
                    <button
                      type="button"
                      key={categoryId(item)}
                      onClick={() => loadCategorySchema(item)}
                    >
                      <strong>{categoryLabel(item) || "未命名类目"}</strong>
                      <span>ID {categoryId(item)}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <label className="publisher-span-2">
              <span>商品描述</span>
              <textarea
                rows={7}
                value={form.description}
                onChange={(event) =>
                  setForm((value) => ({ ...value, description: event.target.value }))
                }
              />
            </label>
          </div>
        </div>

        {categorySchema ? (
          <div className="publisher-form-section">
            <div className="publisher-section-head">
              <div>
                <h3>平台必填与类目属性</h3>
                <p>字段直接来自当前店铺、站点和类目；带 * 的字段发布前必须补齐。</p>
              </div>
              <Badge appearance="tint" color="informative">
                {[...categorySchema.normal, ...categorySchema.public, ...categorySchema.logics].length} 个字段
              </Badge>
            </div>
            <div className="publisher-attribute-grid">
              {[...categorySchema.normal, ...categorySchema.public, ...categorySchema.logics]
                .filter((field) => field.name)
                .map((field) => {
                  const name = String(field.name);
                  const options = fieldOptions(field);
                  const value = form.attributes[name];
                  return (
                    <label key={name}>
                      <span>
                        {fieldLabel(field)}
                        {fieldRequired(field) ? <b> *</b> : null}
                      </span>
                      {options.length ? (
                        <select
                          value={String(value ?? "")}
                          onChange={(event) =>
                            setForm((currentValue) => ({
                              ...currentValue,
                              attributes: {
                                ...currentValue.attributes,
                                [name]: event.target.value,
                              },
                            }))
                          }
                        >
                          <option value="">请选择</option>
                          {options.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          type={String(field.input_type || "").toLowerCase().includes("number") ? "number" : "text"}
                          value={String(value ?? "")}
                          onChange={(event) =>
                            setForm((currentValue) => ({
                              ...currentValue,
                              attributes: {
                                ...currentValue.attributes,
                                [name]: event.target.value,
                              },
                            }))
                          }
                        />
                      )}
                    </label>
                  );
                })}
            </div>
          </div>
        ) : null}

        <div className="publisher-form-section">
          <div className="publisher-section-head">
            <h3>变体与价格</h3>
            <Button
              size="small"
              icon={<Add20Regular />}
              onClick={() =>
                setForm((value) => ({
                  ...value,
                  variants: [
                    ...value.variants,
                    {
                      sku: "",
                      specification_name: "规格",
                      specification_value: "",
                      price: "",
                      special_price: "",
                      stock: "",
                    },
                  ],
                }))
              }
            >
              添加变体
            </Button>
          </div>
          <div className="publisher-variant-table-wrap">
            <table className="publisher-variant-table">
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>规格名</th>
                  <th>规格值</th>
                  <th>售价</th>
                  <th>促销价</th>
                  <th>库存</th>
                  <th aria-label="操作" />
                </tr>
              </thead>
              <tbody>
                {form.variants.map((variant, index) => (
                  <tr key={variant.id ?? index}>
                    <td>
                      <input
                        aria-label={`第 ${index + 1} 个变体 SKU`}
                        value={variant.sku}
                        onChange={(event) => updateVariant(index, { sku: event.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`第 ${index + 1} 个变体规格名`}
                        value={variant.specification_name}
                        onChange={(event) =>
                          updateVariant(index, { specification_name: event.target.value })
                        }
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`第 ${index + 1} 个变体规格值`}
                        value={variant.specification_value}
                        onChange={(event) =>
                          updateVariant(index, { specification_value: event.target.value })
                        }
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`第 ${index + 1} 个变体售价`}
                        type="number"
                        min="0"
                        step="0.01"
                        value={variant.price}
                        onChange={(event) => updateVariant(index, { price: event.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`第 ${index + 1} 个变体促销价`}
                        type="number"
                        min="0"
                        step="0.01"
                        value={variant.special_price ?? ""}
                        onChange={(event) =>
                          updateVariant(index, { special_price: event.target.value })
                        }
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`第 ${index + 1} 个变体库存`}
                        type="number"
                        min="0"
                        step="1"
                        value={variant.stock}
                        onChange={(event) => updateVariant(index, { stock: event.target.value })}
                      />
                    </td>
                    <td>
                      <Button
                        appearance="subtle"
                        icon={<Delete20Regular />}
                        aria-label={`删除第 ${index + 1} 个变体`}
                        disabled={form.variants.length === 1}
                        onClick={() =>
                          setForm((value) => ({
                            ...value,
                            variants: value.variants.filter(
                              (_item, itemIndex) => itemIndex !== index,
                            ),
                          }))
                        }
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="publisher-form-section publisher-logistics">
          <h3>图片与物流</h3>
          <label className="publisher-image-list">
            <span>商品图片链接（每行一张，第一张为主图）</span>
            <textarea
              rows={4}
              value={form.assets.map((item) => item.url).join("\n")}
              onChange={(event) =>
                setForm((value) => ({
                  ...value,
                  assets: event.target.value
                    .split("\n")
                    .map((url) => url.trim())
                    .filter(Boolean)
                    .map((url) => ({ url })),
                }))
              }
            />
          </label>
          <div className="publisher-dimension-grid">
            {[
              ["weight", "重量"],
              ["package_length", "包裹长"],
              ["package_width", "包裹宽"],
              ["package_height", "包裹高"],
            ].map(([key, label]) => (
              <label key={key}>
                <span>{label}</span>
                <input
                  type="number"
                  min="0.000001"
                  step="any"
                  value={String(form[key as keyof DraftForm])}
                  onChange={(event) =>
                    setForm((value) => ({
                      ...value,
                      [key]: event.target.value,
                    }))
                  }
                />
              </label>
            ))}
          </div>
        </div>

        <div className="publisher-save-bar">
          <div>
            <strong>{current ? `草稿版本 ${current.version}` : "尚未保存"}</strong>
            <span>修改表单后先保存本地草稿，远程写入不会自动发生。</span>
          </div>
          <Button
            appearance="primary"
            disabled={Boolean(busy)}
            icon={busy === "save" ? <Spinner size="tiny" /> : <CheckmarkCircle20Regular />}
            onClick={saveLocal}
          >
            保存本地草稿
          </Button>
        </div>

        {current ? (
          <div className="publisher-flow">
            <div className="publisher-flow-head">
              <div>
                <span className="publisher-kicker">安全发布流程</span>
                <h3>马帮草稿 → 回读校验 → 人工确认 → 平台发布</h3>
              </div>
              {current.mabang_task_id ? (
                <span className="mono">任务 ID：{current.mabang_task_id}</span>
              ) : null}
            </div>
            <div className="publisher-flow-actions">
              <Button
                appearance="primary"
                disabled={Boolean(busy) || !["LOCAL_DRAFT", "FAILED"].includes(current.status)}
                onClick={() => runDraftAction("save-to-mabang")}
              >
                1. 保存到马帮并回读
              </Button>
              <Button
                disabled={Boolean(busy) || current.status !== "WAIT_CONFIRM"}
                onClick={() => runDraftAction("confirm")}
              >
                2. 人工确认当前版本
              </Button>
              <Button
                appearance="primary"
                disabled={
                  Boolean(busy) ||
                  current.status !== "WAIT_CONFIRM" ||
                  current.confirmed_version !== current.version
                }
                onClick={() => runDraftAction("publish")}
              >
                3. 立即刊登
              </Button>
            </div>
            {current.last_error ? (
              <div className="publisher-protocol-note" role="status">
                <strong>当前阻塞点</strong>
                <p>{current.last_error}</p>
              </div>
            ) : null}
            {job ? (
              <div className="publisher-job">
                <Badge appearance="tint" color={statusColor(job.status)}>
                  {statusLabels[job.status] ?? job.status}
                </Badge>
                <span>{job.message}</span>
                <small>批次 ID：{job.mabang_batch_id}</small>
              </div>
            ) : null}
            {listing?.product_url ? (
              <a
                className="publisher-result-link"
                href={listing.product_url}
                target="_blank"
                rel="noreferrer"
              >
                查看平台商品 {listing.platform_product_id}
              </a>
            ) : null}
            {events.length ? (
              <ol className="publisher-events">
                {events.map((event) => (
                  <li key={event.id}>
                    <span />
                    <div>
                      <strong>{event.message}</strong>
                      <small>{new Date(event.created_at).toLocaleString("zh-CN")}</small>
                    </div>
                  </li>
                ))}
              </ol>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
