import { randomUUID } from "node:crypto";
import { DATABASE_DIALECTS, assertDatabaseProvider } from "../database-provider.mjs";

function json(value, fallback) {
  if (value && typeof value === "object") return value;
  try { return JSON.parse(value || ""); } catch { return fallback; }
}
function taskRow(row, items = []) {
  if (!row) return null;
  return {
    id: row.id,
    productId: row.product_sku_id,
    listingDraftId: row.listing_draft_id || null,
    templateKey: row.template_key,
    provider: row.provider || null,
    model: row.model || null,
    contextHash: row.context_hash,
    context: json(row.context_json, {}),
    promptPlan: json(row.prompt_plan_json, {}),
    status: row.status,
    errorCode: row.error_code || null,
    errorMessage: row.error_message || null,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at || null,
    cancelledAt: row.cancelled_at || null,
    items,
  };
}

function itemRow(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    slotKey: row.slot_key,
    slotType: row.slot_type,
    slotIndex: Number(row.slot_index),
    label: row.label,
    aspectRatio: row.aspect_ratio || "1:1",
    prompt: row.prompt,
    negativePrompt: row.negative_prompt || "",
    status: row.status,
    generatedFileId: row.generated_file_id || null,
    errorCode: row.error_code || null,
    errorMessage: row.error_message || null,
    adoptedAt: row.adopted_at || null,
    adoptedBy: row.adopted_by || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function iso() { return new Date().toISOString(); }

export class ProductImageGenerationRepository {
  constructor({ provider }) {
    this.provider = assertDatabaseProvider(provider);
    this.prefix = provider.dialect === DATABASE_DIALECTS.POSTGRESQL ? "app." : "";
  }

  table(name) { return `${this.prefix}${name}`; }

  async createTask(input) {
    return this.provider.transaction(async (tx) => {
      const id = randomUUID();
      const now = iso();
      const taskValues = [id, input.productId, input.listingDraftId || null, input.templateKey, input.provider || null, input.model || null,
        input.contextHash, JSON.stringify(input.context), JSON.stringify(input.promptPlan), input.status || "waiting_generation", input.createdBy, now, now];
      await tx.execute(`INSERT INTO ${this.table("product_image_generation_tasks")} (
        id,product_sku_id,listing_draft_id,template_key,provider,model,context_hash,context_json,prompt_plan_json,status,created_by,created_at,updated_at
      ) VALUES (${taskValues.map((_, index) => tx.placeholder(index + 1)).join(",")})`, taskValues);
      for (const [index, item] of input.items.entries()) {
        const values = [randomUUID(), id, item.slotKey, item.slotType, index, item.label, item.aspectRatio,
          item.prompt, item.negativePrompt || null, item.status || "waiting", now, now];
        await tx.execute(`INSERT INTO ${this.table("product_image_generation_items")} (
          id,task_id,slot_key,slot_type,slot_index,label,aspect_ratio,prompt,negative_prompt,status,created_at,updated_at
        ) VALUES (${values.map((_, valueIndex) => tx.placeholder(valueIndex + 1)).join(",")})`, values);
      }
      return this.getTask(id, tx);
    });
  }

  async getTask(id, client = this.provider) {
    const row = (await client.query(`SELECT * FROM ${this.table("product_image_generation_tasks")} WHERE id=${client.placeholder(1)}`, [id])).rows[0];
    if (!row) return null;
    const items = await client.query(`SELECT * FROM ${this.table("product_image_generation_items")} WHERE task_id=${client.placeholder(1)} ORDER BY slot_index`, [id]);
    return taskRow(row, items.rows.map(itemRow));
  }

  async list(productId, limit = 20) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 100));
    const rows = await this.provider.query(`SELECT * FROM ${this.table("product_image_generation_tasks")}
      WHERE product_sku_id=${this.provider.placeholder(1)} ORDER BY created_at DESC LIMIT ${this.provider.placeholder(2)}`, [productId, safeLimit]);
    const tasks = [];
    for (const row of rows.rows) tasks.push(await this.getTask(row.id));
    return tasks;
  }

  async updateTask(id, changes = {}) {
    const allowed = { status: "status", errorCode: "error_code", errorMessage: "error_message", finishedAt: "finished_at", cancelledAt: "cancelled_at" };
    const entries = Object.entries(changes).filter(([key]) => allowed[key]);
    if (!entries.length) return this.getTask(id);
    const values = entries.map(([, value]) => value ?? null);
    values.push(iso(), id);
    const assignments = entries.map(([key], index) => `${allowed[key]}=${this.provider.placeholder(index + 1)}`);
    assignments.push(`updated_at=${this.provider.placeholder(entries.length + 1)}`);
    await this.provider.execute(`UPDATE ${this.table("product_image_generation_tasks")} SET ${assignments.join(",")} WHERE id=${this.provider.placeholder(entries.length + 2)}`, values);
    return this.getTask(id);
  }

  async updateItem(id, changes = {}) {
    const allowed = { status: "status", generatedFileId: "generated_file_id", errorCode: "error_code", errorMessage: "error_message", adoptedAt: "adopted_at", adoptedBy: "adopted_by" };
    const entries = Object.entries(changes).filter(([key]) => allowed[key]);
    if (!entries.length) return null;
    const values = entries.map(([, value]) => value ?? null);
    values.push(iso(), id);
    const assignments = entries.map(([key], index) => `${allowed[key]}=${this.provider.placeholder(index + 1)}`);
    assignments.push(`updated_at=${this.provider.placeholder(entries.length + 1)}`);
    await this.provider.execute(`UPDATE ${this.table("product_image_generation_items")} SET ${assignments.join(",")} WHERE id=${this.provider.placeholder(entries.length + 2)}`, values);
    const row = (await this.provider.query(`SELECT * FROM ${this.table("product_image_generation_items")} WHERE id=${this.provider.placeholder(1)}`, [id])).rows[0];
    return row ? itemRow(row) : null;
  }
}
