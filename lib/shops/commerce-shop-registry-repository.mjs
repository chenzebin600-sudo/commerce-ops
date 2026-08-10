import { createPortableRepositoryExecutor } from "../data/portable-repository-executor.mjs";
import { normalizeCanonicalShopName } from "../data-foundation/unified-normalizers.mjs";

function parseJson(value, fallback) {
  if (value !== null && typeof value === "object") return value;
  try { return JSON.parse(String(value || "")); } catch { return fallback; }
}

function normalizedDirectoryName(value) {
  return normalizeCanonicalShopName(value);
}

function shopRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    platform: row.platform,
    providerShopId: row.provider_shop_id,
    shopCode: row.shop_code || null,
    shopName: row.shop_name,
    normalizedShopName: row.normalized_shop_name,
    countryCode: row.source_country_code,
    siteCode: row.site_code,
    currency: row.currency || null,
    providerShopType: row.provider_shop_type || null,
    controlShopType: row.control_shop_type,
    managerName: row.manager_name || null,
    seniorManagerName: row.senior_manager_name || null,
    categoryName: row.category_name || null,
    platformShortCode: row.platform_short_code || null,
    platformShopId: row.platform_shop_id || null,
    directorySource: row.directory_source || "SYSTEM",
    directorySyncedAt: row.directory_synced_at || null,
    connectorSyncedAt: row.connector_synced_at || null,
    growthShopId: row.growth_shop_id || null,
    executionProvider: row.execution_provider,
    platformConnectorShopId: row.platform_connector_shop_id || null,
    identityStatus: row.identity_status,
    status: row.status,
    sourceMetadata: parseJson(row.source_metadata_json, {}),
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class CommerceShopRegistryRepository {
  constructor({ provider }) {
    if (!provider) throw new TypeError("Database provider is required");
    this.provider = createPortableRepositoryExecutor(provider);
  }

  async isReady() {
    try {
      await this.provider.query("SELECT 1 FROM commerce_shop_registry LIMIT 1");
      await this.provider.query("SELECT 1 FROM commerce_shop_account_bindings LIMIT 1");
      return true;
    } catch { return false; }
  }

  async isDirectoryReady() {
    try {
      await this.provider.query("SELECT shop_code,platform_shop_id,directory_source FROM commerce_shop_registry LIMIT 1");
      return true;
    } catch { return false; }
  }

  async findGrowthShop({ platform, normalizedShopName }) {
    const result = await this.provider.query(
      `SELECT shop.id
       FROM growth_shop_source_mappings mapping
       JOIN growth_shops shop ON shop.id=mapping.internal_shop_id
       WHERE mapping.source_system='mabang' AND LOWER(mapping.platform)=LOWER(?)
         AND mapping.normalized_source_shop_name=?
       ORDER BY shop.id LIMIT 2`,
      [platform.toLowerCase(), normalizedShopName],
    );
    return result.rows.length === 1 ? result.rows[0].id : null;
  }

  async synchronizeAccountScope({ accountId, sourceSystem, platform, shops, capabilities, observedAt }) {
    return this.provider.transaction(async (tx) => {
      const seenIds = [];
      let inserted = 0;
      let updated = 0;
      let linkedGrowthShops = 0;
      for (const shop of shops) {
        const existing = (await tx.query(
          "SELECT id,growth_shop_id FROM commerce_shop_registry WHERE platform=? AND provider_shop_id=?",
          [shop.platform, shop.providerShopId],
        )).rows[0];
        let incomingIdentityStatus = shop.identityStatus;
        if (!existing) {
          const possibleSameShops = (await tx.query(
            `SELECT id FROM commerce_shop_registry
             WHERE platform=? AND source_country_code=? AND normalized_shop_name=?
             ORDER BY id LIMIT 3`,
            [shop.platform, shop.countryCode, shop.normalizedShopName],
          )).rows;
          if (possibleSameShops.length) {
            incomingIdentityStatus = "REVIEW_REQUIRED";
            for (const candidate of possibleSameShops) {
              await tx.execute(
                "UPDATE commerce_shop_registry SET identity_status='REVIEW_REQUIRED',updated_at=? WHERE id=?",
                [observedAt, candidate.id],
              );
            }
          }
        }
        const growthShopId = existing?.growth_shop_id || shop.growthShopId || null;
        await tx.execute(
          `INSERT INTO commerce_shop_registry (
            id,platform,provider_shop_id,shop_name,normalized_shop_name,source_country_code,
            site_code,currency,provider_shop_type,control_shop_type,growth_shop_id,
            execution_provider,platform_connector_shop_id,identity_status,status,
            source_metadata_json,first_seen_at,last_seen_at,created_at,updated_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(platform,provider_shop_id) DO UPDATE SET
            shop_name=excluded.shop_name,normalized_shop_name=excluded.normalized_shop_name,
            source_country_code=excluded.source_country_code,site_code=excluded.site_code,
            currency=excluded.currency,provider_shop_type=excluded.provider_shop_type,
            growth_shop_id=COALESCE(commerce_shop_registry.growth_shop_id,excluded.growth_shop_id),
            status='ACTIVE',source_metadata_json=excluded.source_metadata_json,
            last_seen_at=excluded.last_seen_at,updated_at=excluded.updated_at`,
          [shop.id, shop.platform, shop.providerShopId, shop.shopName, shop.normalizedShopName,
            shop.countryCode, shop.siteCode, shop.currency, shop.providerShopType,
            shop.controlShopType, growthShopId, shop.executionProvider,
            shop.platformConnectorShopId, incomingIdentityStatus, "ACTIVE",
            JSON.stringify(shop.sourceMetadata || {}), observedAt, observedAt, observedAt, observedAt],
        );
        seenIds.push(existing?.id || shop.id);
        if (existing) updated += 1;
        else inserted += 1;
        if (growthShopId) linkedGrowthShops += 1;
        await tx.execute(
          `INSERT INTO commerce_shop_account_bindings (
            shop_id,account_id,source_system,status,capabilities_json,
            first_seen_at,last_seen_at,created_at,updated_at
          ) VALUES (?,?,?,?,?,?,?,?,?)
          ON CONFLICT(shop_id,account_id,source_system) DO UPDATE SET
            status='ACTIVE',capabilities_json=excluded.capabilities_json,
            last_seen_at=excluded.last_seen_at,updated_at=excluded.updated_at`,
          [existing?.id || shop.id, accountId, sourceSystem, "ACTIVE", JSON.stringify(capabilities || []),
            observedAt, observedAt, observedAt, observedAt],
        );
      }

      const activeBindings = (await tx.query(
        `SELECT binding.shop_id
         FROM commerce_shop_account_bindings binding
         JOIN commerce_shop_registry shop ON shop.id=binding.shop_id
         WHERE binding.account_id=? AND binding.source_system=? AND shop.platform=?
           AND binding.status='ACTIVE'`,
        [accountId, sourceSystem, platform],
      )).rows.map((row) => row.shop_id);
      const seen = new Set(seenIds);
      const inactiveIds = activeBindings.filter((id) => !seen.has(id));
      for (const shopId of inactiveIds) {
        await tx.execute(
          `UPDATE commerce_shop_account_bindings SET status='INACTIVE',updated_at=?
           WHERE shop_id=? AND account_id=? AND source_system=?`,
          [observedAt, shopId, accountId, sourceSystem],
        );
        const remaining = Number((await tx.query(
          `SELECT COUNT(*) AS total FROM commerce_shop_account_bindings
           WHERE shop_id=? AND status='ACTIVE'`,
          [shopId],
        )).rows[0]?.total || 0);
        if (!remaining) {
          await tx.execute(
            "UPDATE commerce_shop_registry SET status='INACTIVE',updated_at=? WHERE id=?",
            [observedAt, shopId],
          );
        }
      }
      return { platform, seen: shops.length, inserted, updated, linkedGrowthShops, deactivated: inactiveIds.length };
    });
  }

  async upsertDirectoryShops({ shops, source, observedAt }) {
    return this.provider.transaction(async (tx) => {
      const results = [];
      const markIdentityReview = async (candidates, reason) => {
        const ids = [...new Set((candidates || []).map((candidate) => candidate?.id).filter(Boolean))];
        for (const id of ids) {
          const candidate = (candidates || []).find((item) => item?.id === id)
            || (await tx.query("SELECT * FROM commerce_shop_registry WHERE id=?", [id])).rows[0];
          const metadata = {
            ...parseJson(candidate?.source_metadata_json, {}),
            identityReview: { reason, source, observedAt },
          };
          await tx.execute(
            `UPDATE commerce_shop_registry
             SET identity_status='REVIEW_REQUIRED',source_metadata_json=?,updated_at=? WHERE id=?`,
            [JSON.stringify(metadata), observedAt, id],
          );
        }
        return ids;
      };
      for (const shop of shops) {
        const apiSource = source === "API";
        let incomingIdentityStatus = shop.identityStatus;
        let candidateReviewRequired = false;
        let existing = null;
        let matchedBy = null;
        let codeMatch = null;
        let connectorIdMatch = null;
        let platformIdMatch = null;
        if (apiSource && shop.platformConnectorShopId) {
          const connectorMatches = (await tx.query(
            `SELECT * FROM commerce_shop_registry
             WHERE platform_connector_shop_id=? ORDER BY id LIMIT 2`,
            [shop.platformConnectorShopId],
          )).rows;
          if (connectorMatches.length > 1) {
            const ids = await markIdentityReview(connectorMatches, "AMBIGUOUS_CONNECTOR_SHOP_ID");
            results.push({ id: ids[0] || null, shopCode: shop.shopCode, status: "REVIEW_REQUIRED", reason: "AMBIGUOUS_CONNECTOR_SHOP_ID" });
            continue;
          }
          connectorIdMatch = connectorMatches[0] || null;
        }
        if (!apiSource && shop.shopCode) {
          codeMatch = (await tx.query(
            "SELECT * FROM commerce_shop_registry WHERE shop_code=? LIMIT 1",
            [shop.shopCode],
          )).rows[0] || null;
        }
        if (shop.platformShopId) {
          const platformMatches = (await tx.query(
            `SELECT * FROM commerce_shop_registry
             WHERE platform=? AND source_country_code=? AND platform_shop_id=? ORDER BY id LIMIT 2`,
            [shop.platform, shop.countryCode, shop.platformShopId],
          )).rows;
          if (platformMatches.length > 1) {
            const ids = await markIdentityReview(platformMatches, "AMBIGUOUS_PLATFORM_SHOP_ID");
            results.push({ id: ids[0] || null, shopCode: shop.shopCode, status: "REVIEW_REQUIRED", reason: "AMBIGUOUS_PLATFORM_SHOP_ID" });
            continue;
          }
          platformIdMatch = platformMatches[0] || null;
        }
        if (apiSource && connectorIdMatch && platformIdMatch && connectorIdMatch.id !== platformIdMatch.id) {
          const ids = await markIdentityReview([connectorIdMatch, platformIdMatch], "STRONG_CONNECTOR_ID_CONFLICT");
          results.push({ id: ids[0] || null, shopCode: shop.shopCode, status: "REVIEW_REQUIRED", reason: "STRONG_CONNECTOR_ID_CONFLICT" });
          continue;
        }
        if (apiSource) {
          existing = connectorIdMatch || platformIdMatch;
          matchedBy = connectorIdMatch ? "connector_shop_id" : platformIdMatch ? "platform_country_seller_id" : null;
          if (existing && (
            existing.platform !== shop.platform
              || existing.source_country_code !== shop.countryCode
              || (existing.platform_shop_id && String(existing.platform_shop_id) !== String(shop.platformShopId))
              || (existing.platform_connector_shop_id
                && String(existing.platform_connector_shop_id) !== String(shop.platformConnectorShopId))
          )) {
            const ids = await markIdentityReview([existing], "STRONG_CONNECTOR_ID_CONFLICT");
            results.push({ id: ids[0] || null, shopCode: shop.shopCode, status: "REVIEW_REQUIRED", reason: "STRONG_CONNECTOR_ID_CONFLICT" });
            continue;
          }

          const generatedCodeCollision = (await tx.query(
            "SELECT * FROM commerce_shop_registry WHERE shop_code=? AND id<>? LIMIT 1",
            [shop.shopCode, existing?.id || ""],
          )).rows[0] || null;
          if (generatedCodeCollision) {
            const ids = await markIdentityReview([generatedCodeCollision, existing].filter(Boolean), "API_PROJECTION_KEY_COLLISION");
            results.push({ id: ids[0] || null, shopCode: shop.shopCode, status: "REVIEW_REQUIRED", reason: "API_PROJECTION_KEY_COLLISION" });
            continue;
          }

          const countryCandidates = (await tx.query(
            `SELECT * FROM commerce_shop_registry
             WHERE platform=? AND source_country_code=? AND id<>? ORDER BY id`,
            [shop.platform, shop.countryCode, existing?.id || ""],
          )).rows;
          const providerCode = String(shop.platformShortCode || "");
          const codeCandidates = providerCode
            ? countryCandidates.filter((candidate) =>
                String(candidate.platform_short_code || "") === providerCode
                  || String(candidate.shop_code || "") === providerCode)
            : [];
          if (codeCandidates.length) {
            await markIdentityReview(codeCandidates, "CODE_REQUIRES_CONFIRMATION");
            candidateReviewRequired = true;
          }
          const nameCandidates = countryCandidates.filter((candidate) =>
            normalizedDirectoryName(candidate.shop_name) === shop.normalizedShopName);
          if (nameCandidates.length) {
            await markIdentityReview(nameCandidates, nameCandidates.length > 1
              ? "AMBIGUOUS_NAME_COUNTRY"
              : "NAME_COUNTRY_REQUIRES_CONFIRMATION");
            candidateReviewRequired = true;
          }
        }
        if (!apiSource && codeMatch && platformIdMatch && codeMatch.id !== platformIdMatch.id) {
          const ids = await markIdentityReview([codeMatch, platformIdMatch], "SHOP_CODE_PLATFORM_ID_CONFLICT");
          results.push({ id: ids[0] || null, shopCode: shop.shopCode, status: "REVIEW_REQUIRED", reason: "SHOP_CODE_PLATFORM_ID_CONFLICT" });
          continue;
        }
        if (!apiSource) {
          existing = platformIdMatch || codeMatch;
          matchedBy = platformIdMatch ? "platform_shop_id" : codeMatch ? "shop_code" : null;
        }
        if (existing && existing.platform !== shop.platform) {
          const ids = await markIdentityReview([existing], "SHOP_CODE_PLATFORM_CONFLICT");
          results.push({ id: ids[0] || null, shopCode: shop.shopCode, status: "REVIEW_REQUIRED", reason: "SHOP_CODE_PLATFORM_CONFLICT" });
          continue;
        }
        if (existing && existing.source_country_code !== shop.countryCode) {
          const ids = await markIdentityReview([existing], "SHOP_IDENTITY_COUNTRY_CONFLICT");
          results.push({ id: ids[0] || null, shopCode: shop.shopCode, status: "REVIEW_REQUIRED", reason: "SHOP_IDENTITY_COUNTRY_CONFLICT" });
          continue;
        }
        if (!existing && !apiSource) {
          const countryCandidates = (await tx.query(
            `SELECT * FROM commerce_shop_registry
             WHERE platform=? AND source_country_code=? ORDER BY id`,
            [shop.platform, shop.countryCode],
          )).rows;
          const candidates = countryCandidates.filter((candidate) =>
            normalizedDirectoryName(candidate.shop_name) === shop.normalizedShopName);
          if (candidates.length === 1) {
            const candidate = candidates[0];
            const candidateExternalIds = [candidate.platform_shop_id].filter(Boolean).map(String);
            if (shop.platformShopId && candidateExternalIds.some((value) => value !== String(shop.platformShopId))) {
              const ids = await markIdentityReview([candidate], "PLATFORM_SHOP_ID_CONFLICT");
              results.push({ id: ids[0] || null, shopCode: shop.shopCode, status: "REVIEW_REQUIRED", reason: "PLATFORM_SHOP_ID_CONFLICT" });
              continue;
            }
            existing = candidate;
            matchedBy = shop.platformShopId && candidateExternalIds.includes(String(shop.platformShopId))
              ? "external_id_name_country"
              : "name_country";
          } else if (candidates.length > 1) {
            const ids = await markIdentityReview(candidates, "AMBIGUOUS_NAME_COUNTRY");
            results.push({ id: ids[0] || null, shopCode: shop.shopCode, status: "REVIEW_REQUIRED", reason: "AMBIGUOUS_NAME_COUNTRY" });
            continue;
          }
        }
        const id = existing?.id || shop.id;
        const metadata = {
          ...parseJson(existing?.source_metadata_json, {}),
          directory: { source, syncedAt: observedAt },
          ...(shop.currencySource
            ? {
                currencyEvidence: {
                  source: shop.currencySource,
                  version: shop.currencySourceVersion || null,
                  countryCode: shop.countryCode,
                  isOrderSettlementCurrency: shop.currencyIsOrderSettlementCurrency === true,
                },
              }
            : {}),
        };
        if (existing) {
          const persistedShopCode = apiSource ? (existing.shop_code || shop.shopCode) : shop.shopCode;
          await tx.execute(
            `UPDATE commerce_shop_registry SET
               shop_code=?,shop_name=?,normalized_shop_name=?,source_country_code=?,site_code=?,
               currency=COALESCE(?,currency),
               control_shop_type=CASE WHEN ?='UNKNOWN' THEN control_shop_type ELSE ? END,
               manager_name=COALESCE(?,manager_name),senior_manager_name=COALESCE(?,senior_manager_name),
               category_name=COALESCE(?,category_name),platform_short_code=COALESCE(?,platform_short_code),
               platform_shop_id=COALESCE(?,platform_shop_id),directory_source=?,
               directory_synced_at=?,source_metadata_json=?,status=?,updated_at=?
             WHERE id=?`,
            [persistedShopCode, shop.shopName, shop.normalizedShopName, shop.countryCode, shop.siteCode,
              shop.currency, shop.controlShopType, shop.controlShopType, shop.managerName, shop.seniorManagerName,
              shop.categoryName, shop.platformShortCode, shop.platformShopId, source,
              observedAt, JSON.stringify(metadata), shop.status, observedAt, id],
          );
          results.push({ id, shopCode: shop.shopCode, status: "UPDATED", matchedBy });
          continue;
        }

        await tx.execute(
          `INSERT INTO commerce_shop_registry (
             id,platform,provider_shop_id,shop_code,shop_name,normalized_shop_name,
             source_country_code,site_code,currency,provider_shop_type,control_shop_type,
             manager_name,senior_manager_name,category_name,platform_short_code,platform_shop_id,
             directory_source,directory_synced_at,growth_shop_id,execution_provider,
             platform_connector_shop_id,identity_status,status,source_metadata_json,
             first_seen_at,last_seen_at,created_at,updated_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [id, shop.platform, shop.providerShopId, shop.shopCode, shop.shopName, shop.normalizedShopName,
            shop.countryCode, shop.siteCode, shop.currency, null, shop.controlShopType,
            shop.managerName, shop.seniorManagerName, shop.categoryName, shop.platformShortCode,
            shop.platformShopId, source, observedAt, null, "PLATFORM_GATEWAY", shop.platformConnectorShopId || null,
            incomingIdentityStatus, shop.status, JSON.stringify(metadata), observedAt, observedAt,
            observedAt, observedAt],
        );
        results.push({
          id,
          shopCode: shop.shopCode,
          status: "CREATED",
          identityStatus: incomingIdentityStatus,
          reason: null,
          candidateReviewRequired,
          matchedBy: null,
        });
      }
      return {
        total: shops.length,
        created: results.filter((item) => item.status === "CREATED").length,
        updated: results.filter((item) => item.status === "UPDATED").length,
        reviewRequired: results.filter((item) =>
          item.status === "REVIEW_REQUIRED" || item.identityStatus === "REVIEW_REQUIRED" || item.candidateReviewRequired).length,
        results,
      };
    });
  }

  async synchronizeConnectorProjection({ bindings, observedAt }) {
    if (!bindings.length) return { updated: 0 };
    return this.provider.transaction(async (tx) => {
      let updated = 0;
      for (const binding of bindings) {
        const current = (await tx.query(
          `SELECT platform_connector_shop_id,platform_shop_id,platform_short_code,identity_status,connector_synced_at
           FROM commerce_shop_registry WHERE id=?`,
          [binding.id],
        )).rows[0];
        if (!current) continue;
        const connectorShopId = binding.reviewRequired
          ? current.platform_connector_shop_id
          : binding.clearBinding
            ? null
            : binding.connectorShopId || current.platform_connector_shop_id;
        const platformShopId = binding.reviewRequired
          ? current.platform_shop_id
          : current.platform_shop_id || binding.platformShopId || null;
        const shortCode = binding.reviewRequired
          ? current.platform_short_code
          : current.platform_short_code || binding.platformShortCode || null;
        const identityStatus = binding.reviewRequired || current.identity_status === "REVIEW_REQUIRED"
          ? "REVIEW_REQUIRED"
          : "CONFIRMED";
        const changed = current.platform_connector_shop_id !== connectorShopId
          || current.platform_shop_id !== platformShopId
          || current.platform_short_code !== shortCode
          || current.identity_status !== identityStatus;
        const lastSyncedAt = Date.parse(current.connector_synced_at || "");
        const refreshDue = !Number.isFinite(lastSyncedAt) || Date.parse(observedAt) - lastSyncedAt >= 5 * 60 * 1000;
        if (!changed && !refreshDue) continue;
        await tx.execute(
          `UPDATE commerce_shop_registry SET platform_connector_shop_id=?,platform_shop_id=?,
             platform_short_code=?,identity_status=?,connector_synced_at=?,updated_at=? WHERE id=?`,
          [connectorShopId, platformShopId, shortCode, identityStatus, observedAt, observedAt, binding.id],
        );
        updated += 1;
      }
      return { updated };
    });
  }

  async getById(id) {
    const result = await this.provider.query("SELECT * FROM commerce_shop_registry WHERE id=? LIMIT 1", [String(id || "")]);
    return shopRow(result.rows[0]);
  }

  async list(filters = {}) {
    const where = [];
    const parameters = [];
    for (const [key, column] of [["platform", "platform"], ["countryCode", "source_country_code"],
      ["controlShopType", "control_shop_type"], ["status", "status"]]) {
      if (!filters[key]) continue;
      where.push(`shop.${column}=?`);
      parameters.push(String(filters[key]).toUpperCase());
    }
    if (filters.accountId) {
      where.push(`EXISTS (SELECT 1 FROM commerce_shop_account_bindings binding
        WHERE binding.shop_id=shop.id AND binding.account_id=? AND binding.status='ACTIVE')`);
      parameters.push(String(filters.accountId));
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const result = await this.provider.query(
      `SELECT shop.* FROM commerce_shop_registry shop ${clause}
       ORDER BY shop.platform,shop.source_country_code,shop.shop_name,shop.id`,
      parameters,
    );
    return result.rows.map(shopRow);
  }

  async getByIds(ids) {
    const unique = [...new Set((ids || []).map((id) => String(id || "").trim()).filter(Boolean))];
    if (!unique.length) return [];
    const rows = [];
    for (let offset = 0; offset < unique.length; offset += 500) {
      const chunk = unique.slice(offset, offset + 500);
      const result = await this.provider.query(
        `SELECT * FROM commerce_shop_registry WHERE id IN (${chunk.map(() => "?").join(",")})`,
        chunk,
      );
      rows.push(...result.rows);
    }
    const mapped = new Map(rows.map((row) => [row.id, shopRow(row)]));
    return unique.map((id) => mapped.get(id)).filter(Boolean);
  }

  async findCommonActiveAccount(shopIds, sourceSystem = "mabang", requiredCapabilities = []) {
    const unique = [...new Set((shopIds || []).map((id) => String(id || "").trim()).filter(Boolean))];
    if (!unique.length) return null;
    const required = [...new Set((requiredCapabilities || [])
      .map((capability) => String(capability || "").trim().toLowerCase())
      .filter(Boolean))];
    const result = await this.provider.query(
      `SELECT account_id,shop_id,capabilities_json
       FROM commerce_shop_account_bindings
       WHERE source_system=? AND status='ACTIVE'
         AND shop_id IN (${unique.map(() => "?").join(",")})
       ORDER BY account_id,shop_id`,
      [sourceSystem, ...unique],
    );
    const accounts = new Map();
    for (const row of result.rows) {
      const parsedCapabilities = parseJson(row.capabilities_json, []);
      const capabilities = new Set((Array.isArray(parsedCapabilities) ? parsedCapabilities : [])
        .map((capability) => String(capability || "").trim().toLowerCase())
        .filter(Boolean));
      if (!accounts.has(row.account_id)) accounts.set(row.account_id, new Map());
      accounts.get(row.account_id).set(row.shop_id, capabilities);
    }
    const matches = [...accounts.entries()].filter(([, bindings]) =>
      unique.every((shopId) => {
        const capabilities = bindings.get(shopId);
        return capabilities && required.every((capability) => capabilities.has(capability));
      }));
    return matches.length === 1 ? matches[0][0] : null;
  }

  async summary() {
    const result = await this.provider.query(
      `SELECT platform,source_country_code AS country_code,status,COUNT(*) AS shop_count
       FROM commerce_shop_registry
       GROUP BY platform,source_country_code,status
       ORDER BY platform,source_country_code,status`,
    );
    return result.rows.map((row) => ({
      platform: row.platform,
      countryCode: row.country_code,
      status: row.status,
      shopCount: Number(row.shop_count || 0),
    }));
  }
}
