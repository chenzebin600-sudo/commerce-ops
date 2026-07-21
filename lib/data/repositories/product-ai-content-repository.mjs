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
      ];
      const p = values.map((_, index) => tx.placeholder(index + 1));
      await tx.execute(`INSERT INTO ${this.table("product_ai_contents")} (
        id,product_sku_id,country,sku,provider,model,content_type,input_context_json,output_content_json,prompt_version,
        status,version,created_by,request_id,created_at,updated_at,confirmed_at,confirmed_by,archived_at
      ) VALUES (${p.join(",")})`, values);
      return this.get(values[0], tx);
    });
  }

  async get(id, client = this.provider) {
    const row = (await client.query(`SELECT * FROM ${this.table("product_ai_contents")} WHERE id=${client.placeholder(1)}`, [id])).rows[0];
    return serialize(row);
  }

  async latestConfirmed(productId) {
    const row = (await this.provider.query(`SELECT * FROM ${this.table("product_ai_contents")}
      WHERE product_sku_id=${this.provider.placeholder(1)} AND status='confirmed'
      ORDER BY version DESC LIMIT 1`, [productId])).rows[0];
    return serialize(row);
  }

  async list(productId, { page = 1, pageSize = 20 } = {}) {
    const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
    const safeSize = Math.max(1, Math.min(Number.parseInt(pageSize, 10) || 20, 100));
    const count = await this.provider.query(`SELECT count(*) total FROM ${this.table("product_ai_contents")}
      WHERE product_sku_id=${this.provider.placeholder(1)}`, [productId]);
    const rows = await this.provider.query(`SELECT * FROM ${this.table("product_ai_contents")}
      WHERE product_sku_id=${this.provider.placeholder(1)} ORDER BY version DESC
      LIMIT ${this.provider.placeholder(2)} OFFSET ${this.provider.placeholder(3)}`,
    [productId, safeSize, (safePage - 1) * safeSize]);
    const total = Number(count.rows[0]?.total || 0);
    return { contents: rows.rows.map(serialize), total, page: safePage, pageSize: safeSize, totalPages: Math.max(1, Math.ceil(total / safeSize)) };
  }

  async confirm(productId, contentId, { operatorLabel } = {}) {
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
        confirmed_by=${tx.placeholder(2)},updated_at=${tx.placeholder(3)},archived_at=NULL WHERE id=${tx.placeholder(4)}`,
      [now, operatorLabel || "local_session", now, contentId]);
      return this.get(contentId, tx);
    });
  }
}
