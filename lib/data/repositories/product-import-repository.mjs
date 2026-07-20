import { randomUUID } from "node:crypto";
import { DATABASE_DIALECTS, assertDatabaseProvider } from "../database-provider.mjs";

function iso(value = new Date()) {
  return value instanceof Date ? value.toISOString() : String(value);
}

function jsonValue(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function number(value) {
  return Number(value || 0);
}

function serializeBatch(row) {
  if (!row) return null;
  return {
    id: row.id,
    sourceSystem: row.source_system,
    sourcePeriod: row.source_period || null,
    sourceCountryRaw: row.source_country_raw || null,
    sourceFilename: row.source_filename || null,
    fileSha256: row.file_sha256,
    headerFingerprint: row.header_fingerprint || null,
    status: row.status,
    rowCount: number(row.row_count),
    newCount: number(row.new_count),
    updatedCount: number(row.updated_count),
    unchangedCount: number(row.unchanged_count),
    conflictCount: number(row.conflict_count),
    exceptionCount: number(row.exception_count),
    blockerCount: number(row.blocker_count),
    reminderCount: number(row.reminder_count),
    informationCount: number(row.information_count),
    mapping: jsonValue(row.mapping_json, []),
    unknownFields: jsonValue(row.unknown_fields_json, []),
    validationSummary: jsonValue(row.validation_summary_json, {}),
    operatorLabel: row.operator_label,
    requestId: row.request_id || null,
    revision: number(row.revision),
    errorCode: row.error_code || null,
    errorSummary: row.error_summary || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    appliedAt: row.applied_at || null,
    cancelledAt: row.cancelled_at || null,
  };
}

function serializeRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    batchId: row.batch_id,
    sourceRowNumber: number(row.source_row_number),
    sourceSku: row.source_sku || null,
    rowSha256: row.row_sha256,
    rawPayload: jsonValue(row.raw_payload_json, {}),
    normalizedPayload: jsonValue(row.normalized_payload_json, {}),
    validationCodes: jsonValue(row.validation_codes_json, []),
    outcome: row.outcome,
    targetSkuId: row.target_sku_id || null,
    appliedAt: row.applied_at || null,
    createdAt: row.created_at,
  };
}

function serializeIssue(row) {
  if (!row) return null;
  return {
    id: row.id,
    batchId: row.batch_id,
    rowId: row.row_id || null,
    sourceRowNumber: row.source_row_number == null ? null : number(row.source_row_number),
    code: row.issue_code,
    severity: row.severity,
    fieldCode: row.field_code || null,
    currentValue: jsonValue(row.current_value_json, null),
    suggestedValue: jsonValue(row.suggested_value_json, null),
    message: row.message,
    suggestion: row.suggestion || null,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ProductImportRepository {
  constructor({ provider }) {
    this.provider = assertDatabaseProvider(provider);
    this.prefix = provider.dialect === DATABASE_DIALECTS.POSTGRESQL ? "app." : "";
  }

  table(name) {
    return `${this.prefix}${name}`;
  }

  placeholders(client, count, offset = 0) {
    return Array.from({ length: count }, (_, index) => client.placeholder(offset + index + 1));
  }

  async createBatch(input) {
    const id = input.id || randomUUID();
    const now = iso(input.createdAt || new Date());
    const p = this.placeholders(this.provider, 9);
    await this.provider.execute(`INSERT INTO ${this.table("product_import_batches")} (
      id,source_system,file_sha256,status,operator_label,request_id,created_at,updated_at,validation_summary_json
    ) VALUES (${p.join(",")})`, [
      id,
      input.sourceSystem || "company_product_center",
      input.fileSha256,
      input.status || "uploaded",
      input.operatorLabel || "local_session",
      input.requestId || null,
      now,
      now,
      JSON.stringify({}),
    ]);
    return this.getBatch(id);
  }

  async findBatchByFileHash(fileSha256, sourceSystem = "company_product_center") {
    const p = this.placeholders(this.provider, 2);
    const result = await this.provider.query(`SELECT b.*,ef.original_filename source_filename
      FROM ${this.table("product_import_batches")} b
      LEFT JOIN ${this.table("product_import_files")} pf ON pf.batch_id=b.id AND pf.file_role='source'
      LEFT JOIN ${this.table("export_files")} ef ON ef.id=pf.export_file_id
      WHERE b.source_system=${p[0]} AND b.file_sha256=${p[1]} ORDER BY b.created_at DESC LIMIT 1`, [sourceSystem, fileSha256]);
    return serializeBatch(result.rows[0]);
  }

  async getBatch(id) {
    const p = this.provider.placeholder(1);
    const result = await this.provider.query(`SELECT b.*,ef.original_filename source_filename
      FROM ${this.table("product_import_batches")} b
      LEFT JOIN ${this.table("product_import_files")} pf ON pf.batch_id=b.id AND pf.file_role='source'
      LEFT JOIN ${this.table("export_files")} ef ON ef.id=pf.export_file_id
      WHERE b.id=${p}`, [id]);
    return serializeBatch(result.rows[0]);
  }

  async attachFile({ batchId, exportFileId, fileRole = "source" }) {
    const p = this.placeholders(this.provider, 5);
    const id = randomUUID();
    await this.provider.execute(`INSERT INTO ${this.table("product_import_files")} (id,batch_id,export_file_id,file_role,created_at)
      VALUES (${p.join(",")})`, [id, batchId, exportFileId, fileRole, iso()]);
    return id;
  }

  async getBatchFile(batchId) {
    const p = this.provider.placeholder(1);
    const result = await this.provider.query(`SELECT f.*,ef.original_filename source_filename
      FROM ${this.table("product_import_files")} f
      JOIN ${this.table("export_files")} ef ON ef.id=f.export_file_id
      WHERE f.batch_id=${p} AND f.file_role='source' LIMIT 1`, [batchId]);
    const row = result.rows[0];
    return row ? {
      id: row.id,
      batchId: row.batch_id,
      exportFileId: row.export_file_id,
      fileRole: row.file_role,
      sourceFilename: row.source_filename,
      createdAt: row.created_at,
    } : null;
  }

  async updateBatchStatus(id, status, { errorCode = null, errorSummary = null } = {}) {
    const p = this.placeholders(this.provider, 5);
    await this.provider.execute(`UPDATE ${this.table("product_import_batches")}
      SET status=${p[0]},error_code=${p[1]},error_summary=${p[2]},updated_at=${p[3]},revision=revision+1 WHERE id=${p[4]}`,
    [status, errorCode, errorSummary ? String(errorSummary).slice(0, 300) : null, iso(), id]);
    return this.getBatch(id);
  }

  async existingRowHashes(sourceSkus) {
    const unique = [...new Set(sourceSkus.filter(Boolean))];
    const result = new Map();
    for (let offset = 0; offset < unique.length; offset += 500) {
      const values = unique.slice(offset, offset + 500);
      const placeholders = this.placeholders(this.provider, values.length);
      const query = await this.provider.query(`SELECT s.normalized_sku,r.row_sha256
        FROM ${this.table("product_skus")} s
        JOIN ${this.table("product_import_rows")} r ON r.id=s.current_source_row_id
        WHERE s.source_system='company_product_center' AND s.normalized_sku IN (${placeholders.join(",")})`, values);
      for (const row of query.rows) result.set(row.normalized_sku, row.row_sha256);
    }
    return result;
  }

  async replaceValidation(batchId, validation) {
    const now = iso();
    await this.provider.transaction(async (tx) => {
      const one = tx.placeholder(1);
      await tx.execute(`DELETE FROM ${this.table("product_import_issues")} WHERE batch_id=${one}`, [batchId]);
      await tx.execute(`DELETE FROM ${this.table("product_import_rows")} WHERE batch_id=${one}`, [batchId]);
      const rowIds = new Map();
      for (const row of validation.rows) {
        rowIds.set(row.sourceRowNumber, row.id);
        const p = this.placeholders(tx, 12);
        await tx.execute(`INSERT INTO ${this.table("product_import_rows")} (
          id,batch_id,source_row_number,source_sku,row_sha256,raw_payload_json,normalized_payload_json,
          validation_codes_json,outcome,target_sku_id,applied_at,created_at
        ) VALUES (${p.join(",")})`, [
          row.id, batchId, row.sourceRowNumber, row.sourceSku, row.rowHash,
          JSON.stringify(row.rawPayload), JSON.stringify(row.normalizedPayload), JSON.stringify(row.validationCodes),
          row.outcome, null, null, now,
        ]);
      }
      for (const item of validation.issues) {
        const p = this.placeholders(tx, 14);
        await tx.execute(`INSERT INTO ${this.table("product_import_issues")} (
          id,batch_id,row_id,source_row_number,issue_code,severity,field_code,current_value_json,
          suggested_value_json,message,suggestion,status,created_at,updated_at
        ) VALUES (${p.join(",")})`, [
          item.id, batchId, item.sourceRowNumber ? rowIds.get(item.sourceRowNumber) || null : null,
          item.sourceRowNumber, item.code, item.severity, item.fieldCode,
          item.currentValue === undefined ? null : JSON.stringify(item.currentValue),
          item.suggestedValue === undefined ? null : JSON.stringify(item.suggestedValue),
          item.message, item.suggestion, "open", now, now,
        ]);
      }
      const p = this.placeholders(tx, 17);
      await tx.execute(`UPDATE ${this.table("product_import_batches")} SET
        source_period=${p[0]},source_country_raw=${p[1]},header_fingerprint=${p[2]},status='preview_ready',
        row_count=${p[3]},new_count=${p[4]},updated_count=${p[5]},unchanged_count=${p[6]},conflict_count=${p[7]},
        exception_count=${p[8]},blocker_count=${p[9]},reminder_count=${p[10]},information_count=${p[11]},
        mapping_json=${p[12]},unknown_fields_json=${p[13]},validation_summary_json=${p[14]},
        error_code=NULL,error_summary=NULL,updated_at=${p[15]},revision=revision+1 WHERE id=${p[16]}`, [
        validation.summary.sourcePeriod,
        validation.summary.sourceCountryRaw,
        validation.headerFingerprint,
        validation.counts.rowCount,
        validation.counts.newCount,
        validation.counts.updatedCount,
        validation.counts.unchangedCount,
        validation.counts.conflictCount,
        validation.counts.exceptionCount,
        validation.counts.blockerCount,
        validation.counts.reminderCount,
        validation.counts.informationCount,
        JSON.stringify(validation.mapping),
        JSON.stringify(validation.unknownFields),
        JSON.stringify(validation.summary),
        now,
        batchId,
      ]);
    });
    return this.getBatch(batchId);
  }

  async listBatches({ page = 1, pageSize = 20 } = {}) {
    const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
    const safePageSize = Math.max(1, Math.min(Number.parseInt(pageSize, 10) || 20, 100));
    const totalResult = await this.provider.query(`SELECT count(*) total FROM ${this.table("product_import_batches")}`);
    const p = this.placeholders(this.provider, 2);
    const rows = await this.provider.query(`SELECT b.*,ef.original_filename source_filename
      FROM ${this.table("product_import_batches")} b
      LEFT JOIN ${this.table("product_import_files")} pf ON pf.batch_id=b.id AND pf.file_role='source'
      LEFT JOIN ${this.table("export_files")} ef ON ef.id=pf.export_file_id
      ORDER BY b.created_at DESC,b.id DESC LIMIT ${p[0]} OFFSET ${p[1]}`, [safePageSize, (safePage - 1) * safePageSize]);
    const total = number(totalResult.rows[0]?.total);
    return { batches: rows.rows.map(serializeBatch), total, page: safePage, pageSize: safePageSize, totalPages: Math.max(1, Math.ceil(total / safePageSize)) };
  }

  async listRows(batchId, { page = 1, pageSize = 100, outcome = null } = {}) {
    const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
    const safePageSize = Math.max(1, Math.min(Number.parseInt(pageSize, 10) || 100, 200));
    const clauses = [`batch_id=${this.provider.placeholder(1)}`];
    const values = [batchId];
    if (outcome) {
      clauses.push(`outcome=${this.provider.placeholder(values.length + 1)}`);
      values.push(outcome);
    }
    const where = clauses.join(" AND ");
    const total = number((await this.provider.query(`SELECT count(*) total FROM ${this.table("product_import_rows")} WHERE ${where}`, values)).rows[0]?.total);
    const limit = this.provider.placeholder(values.length + 1);
    const offset = this.provider.placeholder(values.length + 2);
    const rows = await this.provider.query(`SELECT * FROM ${this.table("product_import_rows")} WHERE ${where}
      ORDER BY source_row_number LIMIT ${limit} OFFSET ${offset}`, [...values, safePageSize, (safePage - 1) * safePageSize]);
    return { rows: rows.rows.map(serializeRow), total, page: safePage, pageSize: safePageSize, totalPages: Math.max(1, Math.ceil(total / safePageSize)) };
  }

  async listIssues(batchId, { page = 1, pageSize = 100, severity = null } = {}) {
    const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
    const safePageSize = Math.max(1, Math.min(Number.parseInt(pageSize, 10) || 100, 200));
    const clauses = [`batch_id=${this.provider.placeholder(1)}`];
    const values = [batchId];
    if (severity) {
      clauses.push(`severity=${this.provider.placeholder(values.length + 1)}`);
      values.push(severity);
    }
    const where = clauses.join(" AND ");
    const total = number((await this.provider.query(`SELECT count(*) total FROM ${this.table("product_import_issues")} WHERE ${where}`, values)).rows[0]?.total);
    const limit = this.provider.placeholder(values.length + 1);
    const offset = this.provider.placeholder(values.length + 2);
    const rows = await this.provider.query(`SELECT * FROM ${this.table("product_import_issues")} WHERE ${where}
      ORDER BY CASE severity WHEN 'blocker' THEN 1 WHEN 'reminder' THEN 2 ELSE 3 END,source_row_number,id
      LIMIT ${limit} OFFSET ${offset}`, [...values, safePageSize, (safePage - 1) * safePageSize]);
    return { issues: rows.rows.map(serializeIssue), total, page: safePage, pageSize: safePageSize, totalPages: Math.max(1, Math.ceil(total / safePageSize)) };
  }

  async getBatchDetail(id) {
    const batch = await this.getBatch(id);
    if (!batch) return null;
    const [file, rows, issues] = await Promise.all([
      this.getBatchFile(id),
      this.listRows(id, { pageSize: 100 }),
      this.listIssues(id, { pageSize: 100 }),
    ]);
    return { batch, file, rows, issues };
  }

  async applyBatch(batchId, { operatorLabel, requestId = null } = {}) {
    return this.provider.transaction(async (tx) => {
      const pId = tx.placeholder(1);
      const lock = this.provider.dialect === DATABASE_DIALECTS.POSTGRESQL ? " FOR UPDATE" : "";
      const batchResult = await tx.query(`SELECT * FROM ${this.table("product_import_batches")} WHERE id=${pId}${lock}`, [batchId]);
      const batch = serializeBatch(batchResult.rows[0]);
      if (!batch) throw Object.assign(new Error("导入批次不存在。"), { code: "PRODUCT_IMPORT_NOT_FOUND", status: 404 });
      if (batch.status === "applied") return batch;
      if (batch.status !== "preview_ready") throw Object.assign(new Error("当前批次不能确认入库。"), { code: "PRODUCT_IMPORT_STATE_INVALID", status: 409 });
      if (batch.blockerCount > 0) throw Object.assign(new Error("当前批次仍有阻断问题，不能入库。"), { code: "PRODUCT_IMPORT_BLOCKED", status: 409 });
      const started = iso();
      await tx.execute(`UPDATE ${this.table("product_import_batches")} SET status='applying',updated_at=${tx.placeholder(1)},revision=revision+1 WHERE id=${tx.placeholder(2)}`, [started, batchId]);
      const rowsResult = await tx.query(`SELECT * FROM ${this.table("product_import_rows")} WHERE batch_id=${pId} ORDER BY source_row_number`, [batchId]);
      for (const source of rowsResult.rows.map(serializeRow)) {
        if (source.outcome === "exception") continue;
        const data = source.normalizedPayload;
        const categoryL1 = await this.upsertCategory(tx, { level: 1, parentId: null, sourceName: data.category_l1, batchId });
        const categoryL2 = await this.upsertCategory(tx, { level: 2, parentId: categoryL1, sourceName: data.category_l2, batchId });
        const modelId = data.main_sku_code ? await this.upsertModel(tx, { mainSku: data.main_sku_code, categoryId: categoryL2, name: data.style_name || data.product_name, batchId }) : null;
        const skuId = await this.upsertSku(tx, { source, data, categoryId: categoryL2, modelId, batchId });
        await this.upsertLifecycle(tx, { skuId, data, batchId, operatorLabel, requestId });
        await this.upsertPackaging(tx, { skuId, sourceRowId: source.id, data });
        await this.insertCostSnapshot(tx, { skuId, batchId, data });
        await this.insertInventorySnapshot(tx, { skuId, batchId, data });
        await tx.execute(`UPDATE ${this.table("product_import_rows")} SET target_sku_id=${tx.placeholder(1)},applied_at=${tx.placeholder(2)} WHERE id=${tx.placeholder(3)}`, [skuId, started, source.id]);
      }
      await tx.execute(`UPDATE ${this.table("product_import_batches")} SET status='applied',applied_at=${tx.placeholder(1)},updated_at=${tx.placeholder(2)},revision=revision+1 WHERE id=${tx.placeholder(3)}`, [started, started, batchId]);
      const applied = await tx.query(`SELECT * FROM ${this.table("product_import_batches")} WHERE id=${pId}`, [batchId]);
      return serializeBatch(applied.rows[0]);
    });
  }

  async upsertCategory(tx, { level, parentId, sourceName, batchId }) {
    const normalized = String(sourceName || "").trim().toLocaleLowerCase("zh-CN");
    const parentKey = parentId || "ROOT";
    const values = ["company_product_center", level, parentKey, normalized];
    const p = this.placeholders(tx, values.length);
    const found = await tx.query(`SELECT id FROM ${this.table("product_categories")}
      WHERE source_system=${p[0]} AND level=${p[1]} AND parent_key=${p[2]} AND normalized_name=${p[3]} LIMIT 1`, values);
    if (found.rows[0]) {
      await tx.execute(`UPDATE ${this.table("product_categories")} SET last_seen_batch_id=${tx.placeholder(1)},updated_at=${tx.placeholder(2)} WHERE id=${tx.placeholder(3)}`, [batchId, iso(), found.rows[0].id]);
      return found.rows[0].id;
    }
    const id = randomUUID();
    const now = iso();
    const insert = this.placeholders(tx, 12);
    await tx.execute(`INSERT INTO ${this.table("product_categories")} (
      id,parent_id,parent_key,level,source_system,source_name,normalized_name,status,first_seen_batch_id,last_seen_batch_id,created_at,updated_at
    ) VALUES (${insert.join(",")})`, [id, parentId, parentKey, level, "company_product_center", sourceName, normalized, "active", batchId, batchId, now, now]);
    return id;
  }

  async upsertModel(tx, { mainSku, categoryId, name, batchId }) {
    const found = await tx.query(`SELECT id FROM ${this.table("product_models")} WHERE source_system=${tx.placeholder(1)} AND source_main_sku=${tx.placeholder(2)} LIMIT 1`, ["company_product_center", mainSku]);
    if (found.rows[0]) {
      await tx.execute(`UPDATE ${this.table("product_models")} SET category_id=${tx.placeholder(1)},canonical_name=${tx.placeholder(2)},last_seen_batch_id=${tx.placeholder(3)},updated_at=${tx.placeholder(4)},revision=revision+1 WHERE id=${tx.placeholder(5)}`, [categoryId, name, batchId, iso(), found.rows[0].id]);
      return found.rows[0].id;
    }
    const id = randomUUID();
    const now = iso();
    const p = this.placeholders(tx, 11);
    await tx.execute(`INSERT INTO ${this.table("product_models")} (
      id,source_system,source_main_sku,category_id,canonical_name,identity_status,first_seen_batch_id,last_seen_batch_id,revision,created_at,updated_at
    ) VALUES (${p.join(",")})`, [id, "company_product_center", mainSku, categoryId, name, "confirmed", batchId, batchId, 1, now, now]);
    return id;
  }

  async upsertSku(tx, { source, data, categoryId, modelId, batchId }) {
    const found = await tx.query(`SELECT id FROM ${this.table("product_skus")} WHERE source_system=${tx.placeholder(1)} AND normalized_sku=${tx.placeholder(2)} LIMIT 1`, ["company_product_center", data.sku_code]);
    const now = iso();
    if (found.rows[0]) {
      const p = this.placeholders(tx, 12);
      await tx.execute(`UPDATE ${this.table("product_skus")} SET
        category_id=${p[0]},model_id=${p[1]},source_product_name=${p[2]},source_main_sku=${p[3]},source_style_code=${p[4]},
        source_style_name=${p[5]},source_sales_spec=${p[6]},source_status_raw=${p[7]},current_source_row_id=${p[8]},
        last_seen_batch_id=${p[9]},updated_at=${p[10]},revision=revision+1 WHERE id=${p[11]}`, [
        categoryId, modelId, data.product_name, data.main_sku_code, data.style_code, data.style_name, data.sales_spec,
        data.source_status, source.id, batchId, now, found.rows[0].id,
      ]);
      return found.rows[0].id;
    }
    const id = randomUUID();
    const p = this.placeholders(tx, 18);
    await tx.execute(`INSERT INTO ${this.table("product_skus")} (
      id,source_system,source_sku,normalized_sku,category_id,model_id,source_product_name,source_main_sku,
      source_style_code,source_style_name,source_sales_spec,source_status_raw,current_source_row_id,
      first_seen_batch_id,last_seen_batch_id,revision,created_at,updated_at
    ) VALUES (${p.join(",")})`, [
      id, "company_product_center", data.sku_code, data.sku_code, categoryId, modelId, data.product_name, data.main_sku_code,
      data.style_code, data.style_name, data.sales_spec, data.source_status, source.id, batchId, batchId, 1, now, now,
    ]);
    return id;
  }

  async upsertLifecycle(tx, { skuId, data, batchId, operatorLabel, requestId }) {
    const current = await tx.query(`SELECT status_code FROM ${this.table("product_sku_lifecycle")} WHERE sku_id=${tx.placeholder(1)}`, [skuId]);
    const previous = current.rows[0]?.status_code || null;
    const now = iso();
    if (previous) {
      await tx.execute(`UPDATE ${this.table("product_sku_lifecycle")} SET status_code=${tx.placeholder(1)},revision=revision+1,decision_source='central',source_status_raw=${tx.placeholder(2)},source_batch_id=${tx.placeholder(3)},reason_code=${tx.placeholder(4)},operator_label=${tx.placeholder(5)},request_id=${tx.placeholder(6)},effective_at=${tx.placeholder(7)},updated_at=${tx.placeholder(8)} WHERE sku_id=${tx.placeholder(9)}`, [data.lifecycle_status, data.source_status, batchId, data.lifecycle_reason_code, operatorLabel, requestId, now, now, skuId]);
    } else {
      const p = this.placeholders(tx, 11);
      await tx.execute(`INSERT INTO ${this.table("product_sku_lifecycle")} (sku_id,status_code,revision,decision_source,source_status_raw,source_batch_id,reason_code,operator_label,request_id,effective_at,updated_at)
        VALUES (${p.join(",")})`, [skuId, data.lifecycle_status, 1, "central", data.source_status, batchId, data.lifecycle_reason_code, operatorLabel, requestId, now, now]);
    }
    if (previous !== data.lifecycle_status) {
      const p = this.placeholders(tx, 10);
      await tx.execute(`INSERT INTO ${this.table("product_sku_lifecycle_events")} (id,sku_id,from_status_code,to_status_code,decision_source,source_batch_id,reason_code,operator_label,request_id,occurred_at)
        VALUES (${p.join(",")})`, [randomUUID(), skuId, previous, data.lifecycle_status, "central", batchId, data.lifecycle_reason_code, operatorLabel, requestId, now]);
    }
  }

  async upsertPackaging(tx, { skuId, sourceRowId, data }) {
    const found = await tx.query(`SELECT sku_id FROM ${this.table("product_packaging_profiles")} WHERE sku_id=${tx.placeholder(1)}`, [skuId]);
    const values = [sourceRowId, data.item_dimensions_raw, data.item_net_weight_g, data.item_gross_weight_g, data.carton_length_cm, data.carton_width_cm, data.carton_height_cm, data.carton_quantity, data.shipping_method, iso(), skuId];
    if (found.rows[0]) {
      const p = this.placeholders(tx, values.length);
      await tx.execute(`UPDATE ${this.table("product_packaging_profiles")} SET source_row_id=${p[0]},item_dimensions_raw=${p[1]},item_net_weight_g=${p[2]},item_gross_weight_g=${p[3]},carton_length_cm=${p[4]},carton_width_cm=${p[5]},carton_height_cm=${p[6]},carton_quantity=${p[7]},shipping_method=${p[8]},updated_at=${p[9]} WHERE sku_id=${p[10]}`, values);
      return;
    }
    const p = this.placeholders(tx, 11);
    await tx.execute(`INSERT INTO ${this.table("product_packaging_profiles")} (source_row_id,item_dimensions_raw,item_net_weight_g,item_gross_weight_g,carton_length_cm,carton_width_cm,carton_height_cm,carton_quantity,shipping_method,updated_at,sku_id)
      VALUES (${p.join(",")})`, values);
  }

  async insertCostSnapshot(tx, { skuId, batchId, data }) {
    const existing = await tx.query(`SELECT id FROM ${this.table("product_cost_snapshots")} WHERE sku_id=${tx.placeholder(1)} AND batch_id=${tx.placeholder(2)}`, [skuId, batchId]);
    if (existing.rows[0]) return;
    const p = this.placeholders(tx, 14);
    await tx.execute(`INSERT INTO ${this.table("product_cost_snapshots")} (id,sku_id,batch_id,country_raw,cost_cny,exchange_rate,exchange_direction,cost_local,price_tier_20,price_tier_25,price_tier_35,price_tier_45,attach_rate,created_at)
      VALUES (${p.join(",")})`, [randomUUID(), skuId, batchId, data.country_raw, data.cost_cny, data.exchange_rate, data.exchange_direction, data.cost_local, data.price_tier_20, data.price_tier_25, data.price_tier_35, data.price_tier_45, data.attach_rate, iso()]);
  }

  async insertInventorySnapshot(tx, { skuId, batchId, data }) {
    const warehouse = String(data.warehouse_raw || "未指定").trim();
    const existing = await tx.query(`SELECT id FROM ${this.table("product_inventory_snapshots")} WHERE sku_id=${tx.placeholder(1)} AND batch_id=${tx.placeholder(2)} AND warehouse_raw=${tx.placeholder(3)}`, [skuId, batchId, warehouse]);
    if (existing.rows[0]) return;
    const p = this.placeholders(tx, 7);
    await tx.execute(`INSERT INTO ${this.table("product_inventory_snapshots")} (id,sku_id,batch_id,warehouse_raw,warehouse_stock,planned_warehouse_raw,captured_at)
      VALUES (${p.join(",")})`, [randomUUID(), skuId, batchId, warehouse, data.warehouse_stock, data.planned_warehouse_raw, iso()]);
  }
}
