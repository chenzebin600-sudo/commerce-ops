import { createPortableRepositoryExecutor } from "../data/portable-repository-executor.mjs";

function parseJson(value, fallback) {
  if (value !== null && typeof value === "object") return value;
  try { return JSON.parse(String(value || "")); } catch { return fallback; }
}

function candidateRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    importBatchId: row.import_batch_id,
    assetId: row.asset_id,
    assetType: row.asset_type,
    targetDomain: row.target_domain,
    status: row.candidate_status,
    mappingStatus: row.mapping_status || null,
    riskLevel: row.risk_level,
    conflictStatus: row.conflict_status,
    canonicalCategoryName: row.canonical_category_name || null,
    productModelId: row.product_model_id || null,
    productSkuId: row.product_sku_id || null,
    sourceSku: row.source_sku || null,
    languageCode: row.language_code || null,
    scopeType: row.scope_type,
    countries: parseJson(row.country_scope_json, []),
    consumerScopes: parseJson(row.consumer_scopes_json, []),
    subject: parseJson(row.subject_json, {}),
    content: parseJson(row.content_json, {}),
    scope: parseJson(row.scope_json, {}),
    governance: parseJson(row.governance_json, {}),
    evidence: parseJson(row.evidence_json, {}),
    sourceId: row.source_id || null,
    sourceSha256: row.source_sha256 || null,
    sourceSheet: row.source_sheet || null,
    sourceLocation: row.source_location || null,
    contentDigest: row.content_digest,
    createdAt: row.created_at,
  };
}

function releaseRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    key: row.release_key,
    version: Number(row.version_no),
    consumerScope: row.consumer_scope,
    status: row.status,
    contentDigest: row.content_digest,
    notes: row.notes || null,
    createdBy: row.created_by,
    createdAt: row.created_at,
    publishedBy: row.published_by || null,
    publishedAt: row.published_at || null,
    effectiveFrom: row.effective_from || null,
    effectiveUntil: row.effective_until || null,
    retiredAt: row.retired_at || null,
    counts: {
      claims: Number(row.claim_count || 0),
      accessories: Number(row.accessory_count || 0),
      policies: Number(row.policy_count || 0),
      playbooks: Number(row.playbook_count || 0),
    },
  };
}

const CANDIDATE_COLUMNS = Object.freeze([
  "id", "import_batch_id", "asset_id", "asset_type", "target_domain", "candidate_status",
  "mapping_status", "risk_level", "conflict_status", "canonical_category_name", "product_model_id",
  "product_sku_id", "source_sku", "language_code", "scope_type", "country_scope_json",
  "consumer_scopes_json", "subject_json", "content_json", "scope_json", "governance_json",
  "evidence_json", "source_id", "source_sha256", "source_sheet", "source_location", "content_digest", "created_at",
]);

function candidateValues(candidate) {
  return [
    candidate.id, candidate.importBatchId, candidate.assetId, candidate.assetType, candidate.targetDomain,
    candidate.candidateStatus, candidate.mappingStatus, candidate.riskLevel, candidate.conflictStatus,
    candidate.canonicalCategoryName, candidate.productModelId, candidate.productSkuId, candidate.sourceSku,
    candidate.languageCode, candidate.scopeType, JSON.stringify(candidate.countries), JSON.stringify(candidate.consumers),
    JSON.stringify(candidate.subject), JSON.stringify(candidate.content), JSON.stringify(candidate.scope),
    JSON.stringify(candidate.governance), JSON.stringify(candidate.evidence), candidate.sourceId, candidate.sourceSha256,
    candidate.sourceSheet, candidate.sourceLocation, candidate.contentDigest, candidate.createdAt,
  ];
}

export class ProductKnowledgeRepository {
  constructor({ provider }) {
    if (!provider) throw new TypeError("Database provider is required");
    this.provider = createPortableRepositoryExecutor(provider);
  }

  async isReady() {
    try {
      await this.provider.query("SELECT 1 FROM product_knowledge_candidates LIMIT 1");
      await this.provider.query("SELECT 1 FROM product_knowledge_releases LIMIT 1");
      await this.provider.query("SELECT 1 FROM product_accessory_release_items LIMIT 1");
      await this.provider.query("SELECT 1 FROM customer_service_policy_release_items LIMIT 1");
      await this.provider.query("SELECT 1 FROM customer_service_playbook_release_items LIMIT 1");
      return true;
    } catch {
      return false;
    }
  }

  async importPackage({ batch, candidates, chunkSize = 20 }) {
    return this.provider.transaction(async (tx) => {
      const existing = (await tx.query(
        "SELECT * FROM product_knowledge_import_batches WHERE package_digest=? LIMIT 1",
        [batch.packageDigest],
      )).rows[0];
      if (existing) {
        if (existing.status !== "IMPORTED") {
          const error = new Error("Knowledge package already has an incomplete import batch");
          error.code = "PK_IMPORT_INCOMPLETE_EXISTS";
          throw error;
        }
        return {
          duplicate: true,
          batchId: existing.id,
          importedCounts: parseJson(existing.imported_counts_json, {}),
        };
      }
      await tx.execute(
        `INSERT INTO product_knowledge_import_batches (
           id,contract_version,package_digest,package_name,status,declared_counts_json,imported_counts_json,
           source_manifest_json,error_json,created_by,created_at,completed_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [batch.id, batch.contractVersion, batch.packageDigest, batch.packageName, "IMPORTING",
          JSON.stringify(batch.declaredCounts || {}), "{}", JSON.stringify(batch.manifest || {}), "{}",
          batch.createdBy, batch.createdAt, null],
      );
      const counts = {};
      let chunk = [];
      const flush = async () => {
        if (!chunk.length) return;
        const parameters = [];
        const valuesSql = chunk.map((candidate) => {
          const placeholders = candidateValues(candidate).map((value) => {
            parameters.push(value);
            return tx.placeholder(parameters.length);
          });
          return `(${placeholders.join(",")})`;
        });
        await tx.execute(
          `INSERT INTO product_knowledge_candidates (${CANDIDATE_COLUMNS.join(",")})
           VALUES ${valuesSql.join(",")}
           ON CONFLICT(import_batch_id,asset_id) DO NOTHING`,
          parameters,
        );
        chunk = [];
      };
      for await (const candidate of candidates) {
        counts[candidate.assetType] = Number(counts[candidate.assetType] || 0) + 1;
        chunk.push(candidate);
        if (chunk.length >= chunkSize) await flush();
      }
      await flush();
      await tx.execute(
        `UPDATE product_knowledge_import_batches
         SET status='IMPORTED',imported_counts_json=?,completed_at=? WHERE id=?`,
        [JSON.stringify(counts), batch.completedAt, batch.id],
      );
      return { duplicate: false, batchId: batch.id, importedCounts: counts };
    });
  }

  async statusSnapshot() {
    const [batches, candidates, releases] = await Promise.all([
      this.provider.query("SELECT status,COUNT(*) total FROM product_knowledge_import_batches GROUP BY status"),
      this.provider.query(
        `SELECT candidate_status,target_domain,COUNT(*) total
         FROM product_knowledge_candidates GROUP BY candidate_status,target_domain`,
      ),
      this.provider.query("SELECT status,consumer_scope,COUNT(*) total FROM product_knowledge_releases GROUP BY status,consumer_scope"),
    ]);
    return {
      batches: batches.rows.map((row) => ({ status: row.status, total: Number(row.total || 0) })),
      candidates: candidates.rows.map((row) => ({
        status: row.candidate_status, targetDomain: row.target_domain, total: Number(row.total || 0),
      })),
      releases: releases.rows.map((row) => ({
        status: row.status, consumerScope: row.consumer_scope, total: Number(row.total || 0),
      })),
    };
  }

  async listCandidates({ status = null, targetDomain = null, riskLevel = null, limit = 100, offset = 0 } = {}) {
    const clauses = [];
    const parameters = [];
    const add = (column, value) => {
      if (!value) return;
      parameters.push(value);
      clauses.push(`${column}=${this.provider.placeholder(parameters.length)}`);
    };
    add("candidate_status", status);
    add("target_domain", targetDomain);
    add("risk_level", riskLevel);
    parameters.push(limit, offset);
    const rows = await this.provider.query(
      `SELECT * FROM product_knowledge_candidates
       ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
       ORDER BY created_at,asset_id
       LIMIT ${this.provider.placeholder(parameters.length - 1)} OFFSET ${this.provider.placeholder(parameters.length)}`,
      parameters,
    );
    return rows.rows.map(candidateRow);
  }

  async getCandidate(id) {
    return candidateRow((await this.provider.query(
      "SELECT * FROM product_knowledge_candidates WHERE id=? LIMIT 1", [id],
    )).rows[0]);
  }

  async getProductIdentity({ productModelId = null, productSkuId = null } = {}) {
    if (productSkuId) {
      const row = (await this.provider.query(
        "SELECT id,model_id,category_id FROM product_skus WHERE id=? LIMIT 1", [productSkuId],
      )).rows[0];
      if (row) return { productSkuId: row.id, productModelId: row.model_id || productModelId, categoryId: row.category_id };
    }
    if (productModelId) {
      const row = (await this.provider.query(
        "SELECT id,category_id FROM product_models WHERE id=? LIMIT 1", [productModelId],
      )).rows[0];
      if (row) return { productSkuId: null, productModelId: row.id, categoryId: row.category_id };
    }
    return null;
  }

  async reviewCandidate({ candidateId, action, reviewerId, reviewerRoles, reasonCode = null, comment = null,
    expectedContentDigest, reviewedScope, entity, now }) {
    return this.provider.transaction(async (tx) => {
      const candidate = candidateRow((await tx.query(
        "SELECT * FROM product_knowledge_candidates WHERE id=? LIMIT 1", [candidateId],
      )).rows[0]);
      if (!candidate) return null;
      if (candidate.contentDigest !== expectedContentDigest) {
        const error = new Error("Candidate content changed after review opened");
        error.code = "PK_CANDIDATE_DIGEST_MISMATCH";
        throw error;
      }
      if (!["REVIEW_REQUIRED", "MAPPING_REQUIRED", "SOURCE_READ_REQUIRED", "CONFLICT"].includes(candidate.status)) {
        const error = new Error("Candidate is no longer reviewable");
        error.code = "PK_CANDIDATE_NOT_REVIEWABLE";
        throw error;
      }
      const nextStatus = {
        APPROVE: "APPROVED",
        REJECT: "REJECTED",
        RETURN_FOR_MAPPING: "MAPPING_REQUIRED",
        RETURN_FOR_SOURCE: "SOURCE_READ_REQUIRED",
        RETURN_FOR_CONFLICT: "CONFLICT",
      }[action];
      if (!nextStatus) {
        const error = new Error("Review action is invalid");
        error.code = "PK_REVIEW_ACTION_INVALID";
        throw error;
      }
      const reviewId = entity.reviewId;
      await tx.execute(
        `INSERT INTO product_knowledge_reviews (
           id,candidate_id,action,reviewer_id,reviewer_roles_json,reason_code,comment,candidate_content_digest,created_at
         ) VALUES (?,?,?,?,?,?,?,?,?)`,
        [reviewId, candidateId, action, reviewerId, JSON.stringify(reviewerRoles || []), reasonCode, comment,
          expectedContentDigest, now],
      );

      let approvedEntity = null;
      if (action === "APPROVE") {
        if (candidate.assetType === "PRODUCT_KNOWLEDGE_CLAIM_CANDIDATE") {
          const current = (await tx.query(
            "SELECT COALESCE(MAX(version_no),0)+1 next_version FROM product_knowledge_claims WHERE claim_key=?",
            [entity.key],
          )).rows[0];
          const version = Number(current?.next_version || 1);
          await tx.execute(
            `INSERT INTO product_knowledge_claims (
               id,claim_key,version_no,claim_type,title,text_content,structured_json,product_model_id,product_sku_id,
               category_id,source_candidate_id,source_content_digest,approval_status,risk_level,approved_by,approved_at,created_at
             ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [entity.id, entity.key, version, entity.claimType, entity.title, entity.text,
              JSON.stringify(entity.structured || {}), entity.productModelId, entity.productSkuId, entity.categoryId,
              candidateId, expectedContentDigest, "APPROVED", candidate.riskLevel, reviewerId, now, now],
          );
          let scopeIndex = 0;
          for (const scope of reviewedScope.scopes) {
            scopeIndex += 1;
            await tx.execute(
              `INSERT INTO product_knowledge_claim_scopes (
                 id,claim_id,scope_type,country_code,language_code,consumer_scope,visibility,
                 effective_from,effective_until,created_at
               ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
              [`${entity.id}_scope_${scopeIndex}`, entity.id, scope.scopeType, scope.countryCode,
                scope.languageCode, scope.consumerScope, scope.visibility, scope.effectiveFrom,
                scope.effectiveUntil, now],
            );
          }
          approvedEntity = { type: "CLAIM", id: entity.id, key: entity.key, version };
        } else if (candidate.assetType === "PRODUCT_ACCESSORY_RELATION_CANDIDATE") {
          const current = (await tx.query(
            "SELECT COALESCE(MAX(version_no),0)+1 next_version FROM product_accessory_relations WHERE relation_key=?",
            [entity.key],
          )).rows[0];
          const version = Number(current?.next_version || 1);
          await tx.execute(
            `INSERT INTO product_accessory_relations (
               id,relation_key,version_no,product_model_id,product_sku_id,accessory_sku_code,
               accessory_product_sku_id,country_code,relation_json,source_candidate_id,approval_status,
               approved_by,approved_at,created_at
             ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [entity.id, entity.key, version, entity.productModelId, entity.productSkuId, entity.accessorySkuCode,
              entity.accessoryProductSkuId, entity.countryCode, JSON.stringify(entity.payload || {}), candidateId,
              "APPROVED", reviewerId, now, now],
          );
          approvedEntity = { type: "ACCESSORY", id: entity.id, key: entity.key, version };
        } else if (candidate.assetType === "SUPPORT_POLICY_CANDIDATE") {
          const current = (await tx.query(
            "SELECT COALESCE(MAX(version_no),0)+1 next_version FROM customer_service_policy_versions WHERE policy_key=?",
            [entity.key],
          )).rows[0];
          const version = Number(current?.next_version || 1);
          await tx.execute(
            `INSERT INTO customer_service_policy_versions (
               id,policy_key,version_no,country_code,category_name,policy_json,source_candidate_id,
               approval_status,approved_by,approved_at,effective_from,effective_until,created_at
             ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [entity.id, entity.key, version, entity.countryCode, entity.categoryName, JSON.stringify(entity.payload),
              candidateId, "APPROVED", reviewerId, now, entity.effectiveFrom, entity.effectiveUntil, now],
          );
          approvedEntity = { type: "POLICY", id: entity.id, key: entity.key, version };
        } else if (candidate.assetType === "SUPPORT_PLAYBOOK_CANDIDATE") {
          const current = (await tx.query(
            "SELECT COALESCE(MAX(version_no),0)+1 next_version FROM customer_service_playbook_versions WHERE playbook_key=?",
            [entity.key],
          )).rows[0];
          const version = Number(current?.next_version || 1);
          await tx.execute(
            `INSERT INTO customer_service_playbook_versions (
               id,playbook_key,version_no,intent_code,country_code,product_model_id,playbook_json,
               source_candidate_id,approval_status,approved_by,approved_at,effective_from,effective_until,created_at
             ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [entity.id, entity.key, version, entity.intentCode, entity.countryCode, entity.productModelId,
              JSON.stringify(entity.payload), candidateId, "APPROVED", reviewerId, now,
              entity.effectiveFrom, entity.effectiveUntil, now],
          );
          approvedEntity = { type: "PLAYBOOK", id: entity.id, key: entity.key, version };
        }
      }
      await tx.execute("UPDATE product_knowledge_candidates SET candidate_status=? WHERE id=?", [nextStatus, candidateId]);
      return { candidate: { ...candidate, status: nextStatus }, reviewId, approvedEntity };
    });
  }

  async getApprovedEntityForCandidate(candidateId) {
    const candidate = await this.getCandidate(candidateId);
    if (!candidate || candidate.status !== "APPROVED") return null;
    const definitions = [
      ["CLAIM", "product_knowledge_claims", "source_content_digest"],
      ["ACCESSORY", "product_accessory_relations", null],
      ["POLICY", "customer_service_policy_versions", null],
      ["PLAYBOOK", "customer_service_playbook_versions", null],
    ];
    for (const [type, table, digestColumn] of definitions) {
      const row = (await this.provider.query(
        `SELECT * FROM ${table} WHERE source_candidate_id=? AND approval_status='APPROVED' LIMIT 1`, [candidateId],
      )).rows[0];
      if (row) return {
        type,
        id: row.id,
        candidateId,
        contentDigest: digestColumn ? row[digestColumn] : candidate.contentDigest,
      };
    }
    return null;
  }

  async createRelease({ release, items }) {
    return this.provider.transaction(async (tx) => {
      const existing = (await tx.query(
        "SELECT * FROM product_knowledge_releases WHERE release_key=? AND content_digest=? LIMIT 1",
        [release.key, release.contentDigest],
      )).rows[0];
      if (existing) return { duplicate: true, release: releaseRow(existing) };
      const versionRow = (await tx.query(
        "SELECT COALESCE(MAX(version_no),0)+1 next_version FROM product_knowledge_releases WHERE release_key=?",
        [release.key],
      )).rows[0];
      const version = Number(versionRow?.next_version || 1);
      await tx.execute(
        `INSERT INTO product_knowledge_releases (
           id,release_key,version_no,consumer_scope,status,content_digest,notes,created_by,created_at,
           published_by,published_at,effective_from,effective_until,retired_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [release.id, release.key, version, release.consumerScope, "DRAFT", release.contentDigest,
          release.notes, release.createdBy, release.createdAt, null, null, release.effectiveFrom,
          release.effectiveUntil, null],
      );
      let rank = 0;
      for (const item of items) {
        rank += 1;
        const id = `${release.id}_item_${rank}`;
        if (item.type === "CLAIM") {
          await tx.execute(
            `INSERT INTO product_knowledge_release_items
             (id,release_id,claim_id,claim_content_digest,rank_no,created_at) VALUES (?,?,?,?,?,?)`,
            [id, release.id, item.id, item.contentDigest, rank, release.createdAt],
          );
        } else if (item.type === "ACCESSORY") {
          await tx.execute(
            `INSERT INTO product_accessory_release_items
             (id,release_id,relation_id,relation_content_digest,rank_no,created_at) VALUES (?,?,?,?,?,?)`,
            [id, release.id, item.id, item.contentDigest, rank, release.createdAt],
          );
        } else if (item.type === "POLICY") {
          await tx.execute(
            `INSERT INTO customer_service_policy_release_items
             (id,release_id,policy_version_id,policy_content_digest,rank_no,created_at) VALUES (?,?,?,?,?,?)`,
            [id, release.id, item.id, item.contentDigest, rank, release.createdAt],
          );
        } else if (item.type === "PLAYBOOK") {
          await tx.execute(
            `INSERT INTO customer_service_playbook_release_items
             (id,release_id,playbook_version_id,playbook_content_digest,rank_no,created_at) VALUES (?,?,?,?,?,?)`,
            [id, release.id, item.id, item.contentDigest, rank, release.createdAt],
          );
        }
      }
      return { duplicate: false, release: { ...release, version, status: "DRAFT" } };
    });
  }

  async listReleases({ consumerScope = null, status = null, limit = 100 } = {}) {
    const parameters = [];
    const clauses = [];
    if (consumerScope) { parameters.push(consumerScope); clauses.push(`release.consumer_scope=${this.provider.placeholder(parameters.length)}`); }
    if (status) { parameters.push(status); clauses.push(`release.status=${this.provider.placeholder(parameters.length)}`); }
    parameters.push(limit);
    const result = await this.provider.query(
      `SELECT release.*,
         (SELECT COUNT(*) FROM product_knowledge_release_items i WHERE i.release_id=release.id) claim_count,
         (SELECT COUNT(*) FROM product_accessory_release_items i WHERE i.release_id=release.id) accessory_count,
         (SELECT COUNT(*) FROM customer_service_policy_release_items i WHERE i.release_id=release.id) policy_count,
         (SELECT COUNT(*) FROM customer_service_playbook_release_items i WHERE i.release_id=release.id) playbook_count
       FROM product_knowledge_releases release
       ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
       ORDER BY release.created_at DESC,release.version_no DESC
       LIMIT ${this.provider.placeholder(parameters.length)}`,
      parameters,
    );
    return result.rows.map(releaseRow);
  }

  async getRelease(id) {
    return releaseRow((await this.provider.query(
      `SELECT release.*,
         (SELECT COUNT(*) FROM product_knowledge_release_items i WHERE i.release_id=release.id) claim_count,
         (SELECT COUNT(*) FROM product_accessory_release_items i WHERE i.release_id=release.id) accessory_count,
         (SELECT COUNT(*) FROM customer_service_policy_release_items i WHERE i.release_id=release.id) policy_count,
         (SELECT COUNT(*) FROM customer_service_playbook_release_items i WHERE i.release_id=release.id) playbook_count
       FROM product_knowledge_releases release WHERE release.id=? LIMIT 1`, [id],
    )).rows[0]);
  }

  async publishRelease({ id, expectedContentDigest, publishedBy, now }) {
    return this.provider.transaction(async (tx) => {
      const release = (await tx.query("SELECT * FROM product_knowledge_releases WHERE id=? LIMIT 1", [id])).rows[0];
      if (!release) return null;
      if (release.status !== "DRAFT") {
        const error = new Error("Only a draft release can be published");
        error.code = "PK_RELEASE_NOT_DRAFT";
        throw error;
      }
      if (release.content_digest !== expectedContentDigest) {
        const error = new Error("Release digest does not match the reviewed draft");
        error.code = "PK_RELEASE_DIGEST_MISMATCH";
        throw error;
      }
      if (release.created_by === publishedBy) {
        const error = new Error("Release publisher must be different from its creator");
        error.code = "PK_RELEASE_SEPARATION_REQUIRED";
        throw error;
      }
      const checks = await Promise.all([
        tx.query(`SELECT COUNT(*) total FROM product_knowledge_release_items item
          JOIN product_knowledge_claims entity ON entity.id=item.claim_id
          JOIN product_knowledge_candidates candidate ON candidate.id=entity.source_candidate_id
          WHERE item.release_id=? AND (entity.approval_status<>'APPROVED' OR candidate.candidate_status<>'APPROVED'
            OR candidate.content_digest<>item.claim_content_digest)`, [id]),
        tx.query(`SELECT COUNT(*) total FROM product_accessory_release_items item
          JOIN product_accessory_relations entity ON entity.id=item.relation_id
          JOIN product_knowledge_candidates candidate ON candidate.id=entity.source_candidate_id
          WHERE item.release_id=? AND (entity.approval_status<>'APPROVED' OR candidate.candidate_status<>'APPROVED'
            OR candidate.content_digest<>item.relation_content_digest)`, [id]),
        tx.query(`SELECT COUNT(*) total FROM customer_service_policy_release_items item
          JOIN customer_service_policy_versions entity ON entity.id=item.policy_version_id
          JOIN product_knowledge_candidates candidate ON candidate.id=entity.source_candidate_id
          WHERE item.release_id=? AND (entity.approval_status<>'APPROVED' OR candidate.candidate_status<>'APPROVED'
            OR candidate.content_digest<>item.policy_content_digest)`, [id]),
        tx.query(`SELECT COUNT(*) total FROM customer_service_playbook_release_items item
          JOIN customer_service_playbook_versions entity ON entity.id=item.playbook_version_id
          JOIN product_knowledge_candidates candidate ON candidate.id=entity.source_candidate_id
          WHERE item.release_id=? AND (entity.approval_status<>'APPROVED' OR candidate.candidate_status<>'APPROVED'
            OR candidate.content_digest<>item.playbook_content_digest)`, [id]),
      ]);
      if (checks.some((result) => Number(result.rows[0]?.total || 0) > 0)) {
        const error = new Error("Release contains stale or withdrawn reviewed content");
        error.code = "PK_RELEASE_CONTENT_STALE";
        throw error;
      }
      const counts = await Promise.all([
        tx.query("SELECT COUNT(*) total FROM product_knowledge_release_items WHERE release_id=?", [id]),
        tx.query("SELECT COUNT(*) total FROM product_accessory_release_items WHERE release_id=?", [id]),
        tx.query("SELECT COUNT(*) total FROM customer_service_policy_release_items WHERE release_id=?", [id]),
        tx.query("SELECT COUNT(*) total FROM customer_service_playbook_release_items WHERE release_id=?", [id]),
      ]);
      if (!counts.some((result) => Number(result.rows[0]?.total || 0) > 0)) {
        const error = new Error("An empty release cannot be published");
        error.code = "PK_RELEASE_EMPTY";
        throw error;
      }
      await tx.execute(
        `UPDATE product_knowledge_releases SET status='RETIRED',retired_at=?
         WHERE release_key=? AND status='PUBLISHED' AND id<>?`, [now, release.release_key, id],
      );
      await tx.execute(
        "UPDATE product_knowledge_releases SET status='PUBLISHED',published_by=?,published_at=? WHERE id=?",
        [publishedBy, now, id],
      );
      return releaseRow({ ...release, status: "PUBLISHED", published_by: publishedBy, published_at: now });
    });
  }

  async searchPublished({ productModelId, productSkuId = null, categoryId = null, countryCode, languageCode = null,
    consumerScope = "CUSTOMER_SERVICE", keyword = null, now, limit = 20 } = {}) {
    if (!productModelId && !productSkuId && !categoryId) return [];
    const parameters = [consumerScope, now, now, now, now];
    const clauses = [
      "release.status='PUBLISHED'",
      `release.consumer_scope=${this.provider.placeholder(1)}`,
      `(release.effective_from IS NULL OR release.effective_from<=${this.provider.placeholder(2)})`,
      `(release.effective_until IS NULL OR release.effective_until>${this.provider.placeholder(3)})`,
      `(scope.effective_from IS NULL OR scope.effective_from<=${this.provider.placeholder(4)})`,
      `(scope.effective_until IS NULL OR scope.effective_until>${this.provider.placeholder(5)})`,
      "claim.approval_status='APPROVED'",
      "scope.visibility<>'INTERNAL_ONLY'",
      "scope.consumer_scope=release.consumer_scope",
    ];
    const add = (sql, value) => {
      parameters.push(value);
      clauses.push(sql.replaceAll("$P", this.provider.placeholder(parameters.length)));
    };
    if (productSkuId) {
      parameters.push(productSkuId, productModelId || "");
      clauses.push(`(claim.product_sku_id=${this.provider.placeholder(parameters.length - 1)}
        OR (claim.product_sku_id IS NULL AND claim.product_model_id=${this.provider.placeholder(parameters.length)}))`);
    } else if (productModelId) add("claim.product_model_id=$P", productModelId);
    else add("claim.category_id=$P", categoryId);
    if (countryCode) {
      parameters.push(countryCode);
      clauses.push(`(scope.scope_type='COMMON' OR scope.country_code=${this.provider.placeholder(parameters.length)})`);
    } else clauses.push("scope.scope_type='COMMON'");
    if (languageCode) add("scope.language_code=$P", languageCode);
    if (keyword) {
      parameters.push(`%${String(keyword).toLocaleLowerCase("zh-CN")}%`);
      clauses.push(`LOWER(COALESCE(claim.title,'') || ' ' || claim.text_content) LIKE ${this.provider.placeholder(parameters.length)}`);
    }
    parameters.push(limit);
    const result = await this.provider.query(
      `SELECT claim.*,scope.scope_type,scope.country_code,scope.language_code,scope.consumer_scope,scope.visibility,
         release.id release_id,release.release_key,release.version_no release_version,release.content_digest release_digest,
         candidate.source_id,candidate.source_sha256,candidate.source_sheet,candidate.source_location,candidate.evidence_json
       FROM product_knowledge_release_items item
       JOIN product_knowledge_releases release ON release.id=item.release_id
       JOIN product_knowledge_claims claim ON claim.id=item.claim_id
       JOIN product_knowledge_claim_scopes scope ON scope.claim_id=claim.id
       JOIN product_knowledge_candidates candidate ON candidate.id=claim.source_candidate_id
       WHERE ${clauses.join(" AND ")}
       ORDER BY CASE WHEN scope.scope_type='COUNTRY_OVERRIDE' THEN 0 ELSE 1 END,
         release.published_at DESC,item.rank_no,claim.id
       LIMIT ${this.provider.placeholder(parameters.length)}`,
      parameters,
    );
    const seen = new Set();
    return result.rows.filter((row) => {
      const key = `${row.id}:${row.country_code || "COMMON"}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).map((row) => ({
      id: row.id,
      claimKey: row.claim_key,
      version: Number(row.version_no),
      claimType: row.claim_type,
      title: row.title || null,
      text: row.text_content,
      structured: parseJson(row.structured_json, {}),
      productModelId: row.product_model_id || null,
      productSkuId: row.product_sku_id || null,
      categoryId: row.category_id || null,
      riskLevel: row.risk_level,
      scope: {
        type: row.scope_type,
        countryCode: row.country_code || null,
        languageCode: row.language_code,
        consumerScope: row.consumer_scope,
        visibility: row.visibility,
      },
      release: {
        id: row.release_id,
        key: row.release_key,
        version: Number(row.release_version),
        digest: row.release_digest,
      },
      evidence: {
        sourceId: row.source_id || null,
        sourceSha256: row.source_sha256 || null,
        sheet: row.source_sheet || null,
        location: row.source_location || null,
        detail: parseJson(row.evidence_json, {}),
      },
    }));
  }

  async searchPublishedAccessories({ productModelId, productSkuId = null, countryCode = null, now, limit = 20 } = {}) {
    if (!productModelId && !productSkuId) return [];
    const parameters = ["CUSTOMER_SERVICE", now, now, now, now];
    const clauses = [
      "release.status='PUBLISHED'",
      `release.consumer_scope=${this.provider.placeholder(1)}`,
      `(release.effective_from IS NULL OR release.effective_from<=${this.provider.placeholder(2)})`,
      `(release.effective_until IS NULL OR release.effective_until>${this.provider.placeholder(3)})`,
      `(entity.approved_at<=${this.provider.placeholder(4)})`,
      "entity.approval_status='APPROVED'",
      `candidate.created_at<=${this.provider.placeholder(5)}`,
    ];
    if (productSkuId) {
      parameters.push(productSkuId, productModelId || "");
      clauses.push(`(entity.product_sku_id=${this.provider.placeholder(parameters.length - 1)}
        OR (entity.product_sku_id IS NULL AND entity.product_model_id=${this.provider.placeholder(parameters.length)}))`);
    } else {
      parameters.push(productModelId);
      clauses.push(`entity.product_model_id=${this.provider.placeholder(parameters.length)}`);
    }
    if (countryCode) {
      parameters.push(countryCode);
      clauses.push(`(entity.country_code IS NULL OR entity.country_code=${this.provider.placeholder(parameters.length)})`);
    } else clauses.push("entity.country_code IS NULL");
    parameters.push(limit);
    const result = await this.provider.query(
      `SELECT entity.*,release.id release_id,release.release_key,release.version_no release_version,
         release.content_digest release_digest,candidate.content_digest,candidate.evidence_json,
         candidate.source_id,candidate.source_sha256,candidate.source_sheet,candidate.source_location
       FROM product_accessory_release_items item
       JOIN product_knowledge_releases release ON release.id=item.release_id
       JOIN product_accessory_relations entity ON entity.id=item.relation_id
       JOIN product_knowledge_candidates candidate ON candidate.id=entity.source_candidate_id
       WHERE ${clauses.join(" AND ")}
       ORDER BY CASE WHEN entity.country_code IS NULL THEN 1 ELSE 0 END,release.published_at DESC,item.rank_no
       LIMIT ${this.provider.placeholder(parameters.length)}`,
      parameters,
    );
    return result.rows.map((row) => ({
      id: row.id,
      relationKey: row.relation_key,
      version: Number(row.version_no),
      productModelId: row.product_model_id || null,
      productSkuId: row.product_sku_id || null,
      accessorySkuCode: row.accessory_sku_code,
      accessoryProductSkuId: row.accessory_product_sku_id || null,
      countryCode: row.country_code || null,
      relation: parseJson(row.relation_json, {}),
      release: { id: row.release_id, key: row.release_key, version: Number(row.release_version), digest: row.release_digest },
      evidence: {
        sourceId: row.source_id || null, sourceSha256: row.source_sha256 || null,
        sheet: row.source_sheet || null, location: row.source_location || null,
        detail: parseJson(row.evidence_json, {}),
      },
    })).filter((item) => item.relation?.reviewedScope?.visibility !== "INTERNAL_ONLY");
  }

  async searchPublishedPolicies({ categoryName = null, countryCode = null, now, limit = 20 } = {}) {
    const parameters = ["CUSTOMER_SERVICE", now, now, now, now];
    const clauses = [
      "release.status='PUBLISHED'",
      `release.consumer_scope=${this.provider.placeholder(1)}`,
      `(release.effective_from IS NULL OR release.effective_from<=${this.provider.placeholder(2)})`,
      `(release.effective_until IS NULL OR release.effective_until>${this.provider.placeholder(3)})`,
      `(entity.effective_from IS NULL OR entity.effective_from<=${this.provider.placeholder(4)})`,
      `(entity.effective_until IS NULL OR entity.effective_until>${this.provider.placeholder(5)})`,
      "entity.approval_status='APPROVED'",
    ];
    if (categoryName) {
      parameters.push(categoryName);
      clauses.push(`(entity.category_name IS NULL OR entity.category_name=${this.provider.placeholder(parameters.length)})`);
    } else clauses.push("entity.category_name IS NULL");
    if (countryCode) {
      parameters.push(countryCode);
      clauses.push(`(entity.country_code IS NULL OR entity.country_code=${this.provider.placeholder(parameters.length)})`);
    } else clauses.push("entity.country_code IS NULL");
    parameters.push(limit);
    const result = await this.provider.query(
      `SELECT entity.*,release.id release_id,release.release_key,release.version_no release_version,
         release.content_digest release_digest,candidate.evidence_json,candidate.source_id,candidate.source_sha256,
         candidate.source_sheet,candidate.source_location
       FROM customer_service_policy_release_items item
       JOIN product_knowledge_releases release ON release.id=item.release_id
       JOIN customer_service_policy_versions entity ON entity.id=item.policy_version_id
       JOIN product_knowledge_candidates candidate ON candidate.id=entity.source_candidate_id
       WHERE ${clauses.join(" AND ")}
       ORDER BY CASE WHEN entity.country_code IS NULL THEN 1 ELSE 0 END,release.published_at DESC,item.rank_no
       LIMIT ${this.provider.placeholder(parameters.length)}`,
      parameters,
    );
    return result.rows.map((row) => ({
      id: row.id,
      policyKey: row.policy_key,
      version: Number(row.version_no),
      countryCode: row.country_code || null,
      categoryName: row.category_name || null,
      policy: parseJson(row.policy_json, {}),
      release: { id: row.release_id, key: row.release_key, version: Number(row.release_version), digest: row.release_digest },
      evidence: {
        sourceId: row.source_id || null, sourceSha256: row.source_sha256 || null,
        sheet: row.source_sheet || null, location: row.source_location || null,
        detail: parseJson(row.evidence_json, {}),
      },
    })).filter((item) => item.policy?.reviewedScope?.visibility !== "INTERNAL_ONLY");
  }

  async searchPublishedPlaybooks({ productModelId, countryCode = null, now, limit = 20 } = {}) {
    if (!productModelId) return [];
    const parameters = ["CUSTOMER_SERVICE", now, now, now, now, productModelId];
    const clauses = [
      "release.status='PUBLISHED'",
      `release.consumer_scope=${this.provider.placeholder(1)}`,
      `(release.effective_from IS NULL OR release.effective_from<=${this.provider.placeholder(2)})`,
      `(release.effective_until IS NULL OR release.effective_until>${this.provider.placeholder(3)})`,
      `(entity.effective_from IS NULL OR entity.effective_from<=${this.provider.placeholder(4)})`,
      `(entity.effective_until IS NULL OR entity.effective_until>${this.provider.placeholder(5)})`,
      `entity.product_model_id=${this.provider.placeholder(6)}`,
      "entity.approval_status='APPROVED'",
    ];
    if (countryCode) {
      parameters.push(countryCode);
      clauses.push(`(entity.country_code IS NULL OR entity.country_code=${this.provider.placeholder(parameters.length)})`);
    } else clauses.push("entity.country_code IS NULL");
    parameters.push(limit);
    const result = await this.provider.query(
      `SELECT entity.*,release.id release_id,release.release_key,release.version_no release_version,
         release.content_digest release_digest,candidate.evidence_json,candidate.source_id,candidate.source_sha256,
         candidate.source_sheet,candidate.source_location
       FROM customer_service_playbook_release_items item
       JOIN product_knowledge_releases release ON release.id=item.release_id
       JOIN customer_service_playbook_versions entity ON entity.id=item.playbook_version_id
       JOIN product_knowledge_candidates candidate ON candidate.id=entity.source_candidate_id
       WHERE ${clauses.join(" AND ")}
       ORDER BY CASE WHEN entity.country_code IS NULL THEN 1 ELSE 0 END,release.published_at DESC,item.rank_no
       LIMIT ${this.provider.placeholder(parameters.length)}`,
      parameters,
    );
    return result.rows.map((row) => ({
      id: row.id,
      playbookKey: row.playbook_key,
      version: Number(row.version_no),
      intentCode: row.intent_code || null,
      countryCode: row.country_code || null,
      productModelId: row.product_model_id,
      playbook: parseJson(row.playbook_json, {}),
      release: { id: row.release_id, key: row.release_key, version: Number(row.release_version), digest: row.release_digest },
      evidence: {
        sourceId: row.source_id || null, sourceSha256: row.source_sha256 || null,
        sheet: row.source_sheet || null, location: row.source_location || null,
        detail: parseJson(row.evidence_json, {}),
      },
    })).filter((item) => item.playbook?.reviewedScope?.visibility !== "INTERNAL_ONLY");
  }
}

export { candidateRow as serializeProductKnowledgeCandidate };
