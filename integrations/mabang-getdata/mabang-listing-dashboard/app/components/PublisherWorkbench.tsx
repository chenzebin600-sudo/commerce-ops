"use client";

import {
  Add20Regular,
  ArrowSync20Regular,
  CheckmarkCircle20Regular,
  Copy20Regular,
  Delete20Regular,
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
  attributes: Record<string, string>;
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

export function PublisherWorkbench({
  connected,
  platform,
  shops,
  apiFetch,
  seedListing,
  onSeedConsumed,
  onNotice,
  onError,
}: {
  connected: boolean;
  platform: string;
  shops: PublisherShop[];
  apiFetch: PublisherApiFetch;
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
        body: JSON.stringify(form),
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
            <label>
              <span>平台类目 ID</span>
              <input
                value={form.category_id}
                onChange={(event) =>
                  setForm((value) => ({ ...value, category_id: event.target.value }))
                }
              />
            </label>
            <label>
              <span>类目名称</span>
              <input
                value={form.category_name}
                onChange={(event) =>
                  setForm((value) => ({ ...value, category_name: event.target.value }))
                }
              />
            </label>
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
