import { randomUUID } from "node:crypto";
import { DATABASE_DIALECTS, assertDatabaseProvider } from "../database-provider.mjs";

function json(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function serialize(row) {
  if (!row) return null;
  return {
    id: row.id,
    productId: row.product_sku_id,
    country: row.country,
    sku: row.sku,
    provider: row.provider,
    model: row.model,
    contentType: row.content_type,
    listingDraftId: row.listing_draft_id || null,
    platform: row.platform || null,
    shopName: row.shop_name || null,
    contextHash: row.context_hash || null,
    previousContentId: row.previous_content_id || null,
    inputContext: json(row.input_context_json, {}),
    outputContent: json(row.output_content_json, {}),
    promptVersion: row.prompt_version,
    status: row.status,
    version: Number(row.version),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    confirmedAt: row.confirmed_at || null,
    confirmedBy: row.confirmed_by || null,
    archivedAt: row.archived_at || null,
    adoptedAt: row.adopted_at || row.confirmed_at || null,
    adoptedBy: row.adopted_by || row.confirmed_by || null,
    adoptedContent: json(row.adopted_content_json, null),
    isManuallyModified: Boolean(row.is_manually_modified),
    manualContent: json(row.manual_content_json, null),
  };
}

function iso(value = new Date()) {
  return value instanceof Date ? value.toISOString() : String(value);
}

export class ProductAiContentRepository {
  constructor({ provider }) {
    this.provider = assertDatabaseProvider(provider);
    this.prefix = provider.dialect === DATABASE_DIALECTS.POSTGRESQL ? "app." : "";
  }

  table(name) {
    return `${this.prefix}${name}`;
  }

  async nextVersion(productId, contentType = "selling_points_and_scenarios", client = this.provider) {
    const result = await client.query(`SELECT COALESCE(MAX(version),0)+1 next_version FROM ${this.table("product_ai_contents")}
      WHERE product_sku_id=${client.placeholder(1)} AND content_type=${client.placeholder(2)}`, [productId, contentType]);
    return Number(result.rows[0]?.next_version || 1);
  }

  async create(input) {
    return this.provider.transaction(async (tx) => {
      const now = iso();
      const version = await this.nextVersion(input.productId, input.contentType, tx);
      if (input.status === "confirmed") {
        await tx.execute(`UPDATE ${this.table("product_ai_contents")} SET status='archived',archived_at=${tx.placeholder(1)},updated_at=${tx.placeholder(2)}
          WHERE product_sku_id=${tx.placeholder(3)} AND content_type=${tx.placeholder(4)} AND status='confirmed'`,
        [now, now, input.productId, input.contentType]);
      }
      const values = [
        randomUUID(), input.productId, input.country, input.sku, input.provider, input.model, input.contentType,
        JSON.stringify(input.inputContext), JSON.stringify(input.outputContent), input.promptVersion, input.status, version,
        input.createdBy, input.requestId || null, now, now,
        input.status === "confirmed" ? now : null, input.status === "confirmed" ? input.createdBy : null, null,
        input.listingDraftId || null, input.platform || null, input.shopName || null, input.contextHash || null,
        input.previousContentId || null, input.status === "confirmed" ? now : null,
        input.status === "confirmed" ? input.createdBy : null, input.isManuallyModified ? 1 : 0,
        input.manualContent ? JSON.stringify(input.manualContent) : null,
      ];
      const p = values.map((_, index) => tx.placeholder(index + 1));
      await tx.execute(`INSERT INTO ${this.table("product_ai_contents")} (
        id,product_sku_id,country,sku,provider,model,content_type,input_context_json,output_content_json,prompt_version,
        status,version,created_by,request_id,created_at,updated_at,confirmed_at,confirmed_by,archived_at,
        listing_draft_id,platform,shop_name,context_hash,previous_content_id,adopted_at,adopted_by,is_manually_modified,manual_content_json
      ) VALUES (${p.join(",")})`, values);
      return this.get(values[0], tx);
    });
  }

  async get(id, client = this.provider) {
    const row = (await client.query(`SELECT * FROM ${this.table("product_ai_contents")} WHERE id=${client.placeholder(1)}`, [id])).rows[0];
    return serialize(row);
  }

  async latestConfirmed(productId, contentType = "selling_points_and_scenarios") {
    const row = (await this.provider.query(`SELECT * FROM ${this.table("product_ai_contents")}
      WHERE product_sku_id=${this.provider.placeholder(1)} AND content_type=${this.provider.placeholder(2)} AND status='confirmed'
      ORDER BY version DESC LIMIT 1`, [productId, contentType])).rows[0];
    return serialize(row);
  }

  async latestConfirmedByTypes(productId) {
    const rows = await this.provider.query(`SELECT * FROM ${this.table("product_ai_contents")}
      WHERE product_sku_id=${this.provider.placeholder(1)} AND status='confirmed' ORDER BY content_type,version DESC`, [productId]);
    const byType = {};
    for (const row of rows.rows) if (!byType[row.content_type]) byType[row.content_type] = serialize(row);
    return byType;
  }

  async list(productId, { page = 1, pageSize = 20, contentType = null } = {}) {
    const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
    const safeSize = Math.max(1, Math.min(Number.parseInt(pageSize, 10) || 20, 100));
    const filter = contentType ? ` AND content_type=${this.provider.placeholder(2)}` : "";
    const countParams = contentType ? [productId, contentType] : [productId];
    const count = await this.provider.query(`SELECT count(*) total FROM ${this.table("product_ai_contents")}
      WHERE product_sku_id=${this.provider.placeholder(1)}${filter}`, countParams);
    const limitIndex = countParams.length + 1;
    const offsetIndex = countParams.length + 2;
    const rows = await this.provider.query(`SELECT * FROM ${this.table("product_ai_contents")}
      WHERE product_sku_id=${this.provider.placeholder(1)}${filter} ORDER BY created_at DESC,version DESC
      LIMIT ${this.provider.placeholder(limitIndex)} OFFSET ${this.provider.placeholder(offsetIndex)}`,
    [...countParams, safeSize, (safePage - 1) * safeSize]);
    const total = Number(count.rows[0]?.total || 0);
    return { contents: rows.rows.map(serialize), total, page: safePage, pageSize: safeSize, totalPages: Math.max(1, Math.ceil(total / safeSize)) };
  }

  async confirm(productId, contentId, { operatorLabel, adoptedContent = null } = {}) {
    return this.provider.transaction(async (tx) => {
      const content = await this.get(contentId, tx);
      if (!content || content.productId !== productId) return null;
      if (content.status === "confirmed") return content;
      if (content.status !== "draft") throw Object.assign(new Error("只有草稿可以确认采用。"), { code: "PRODUCT_AI_STATE_INVALID", status: 409 });
      const now = iso();
      await tx.execute(`UPDATE ${this.table("product_ai_contents")} SET status='archived',archived_at=${tx.placeholder(1)},updated_at=${tx.placeholder(2)}
        WHERE product_sku_id=${tx.placeholder(3)} AND content_type=${tx.placeholder(4)} AND status='confirmed'`,
      [now, now, productId, content.contentType]);
      await tx.execute(`UPDATE ${this.table("product_ai_contents")} SET status='confirmed',confirmed_at=${tx.placeholder(1)},
        confirmed_by=${tx.placeholder(2)},adopted_at=${tx.placeholder(3)},adopted_by=${tx.placeholder(4)},
        adopted_content_json=${tx.placeholder(5)},updated_at=${tx.placeholder(6)},archived_at=NULL WHERE id=${tx.placeholder(7)}`,
      [now, operatorLabel || "local_session", now, operatorLabel || "local_session",
        adoptedContent === null ? null : JSON.stringify(adoptedContent), now, contentId]);
      return this.get(contentId, tx);
    });
  }

  async restore(productId, contentId, { operatorLabel, adoptedContent = undefined } = {}) {
    return this.provider.transaction(async (tx) => {
      const content = await this.get(contentId, tx);
      if (!content || content.productId !== productId) return null;
      const now = iso();
      await tx.execute(`UPDATE ${this.table("product_ai_contents")} SET status='archived',archived_at=${tx.placeholder(1)},updated_at=${tx.placeholder(2)}
        WHERE product_sku_id=${tx.placeholder(3)} AND content_type=${tx.placeholder(4)} AND status='confirmed'`,
      [now, now, productId, content.contentType]);
      await tx.execute(`UPDATE ${this.table("product_ai_contents")} SET status='confirmed',confirmed_at=${tx.placeholder(1)},confirmed_by=${tx.placeholder(2)},
        adopted_at=${tx.placeholder(3)},adopted_by=${tx.placeholder(4)},adopted_content_json=${tx.placeholder(5)},
        updated_at=${tx.placeholder(6)},archived_at=NULL WHERE id=${tx.placeholder(7)}`,
      [now, operatorLabel || "local_session", now, operatorLabel || "local_session",
        JSON.stringify(adoptedContent === undefined ? (content.adoptedContent ?? content.outputContent) : adoptedContent), now, contentId]);
      return this.get(contentId, tx);
    });
  }

  async markManual(productId, contentId, manualContent, { operatorLabel } = {}) {
    const content = await this.get(contentId);
    if (!content || content.productId !== productId) return null;
    const now = iso();
    await this.provider.execute(`UPDATE ${this.table("product_ai_contents")} SET is_manually_modified=1,
      manual_content_json=${this.provider.placeholder(1)},updated_at=${this.provider.placeholder(2)},adopted_by=${this.provider.placeholder(3)}
      WHERE id=${this.provider.placeholder(4)}`,
    [JSON.stringify(manualContent || {}), now, operatorLabel || "local_session", contentId]);
    return this.get(contentId);
  }
}
