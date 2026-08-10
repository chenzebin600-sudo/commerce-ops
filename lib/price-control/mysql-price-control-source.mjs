import { APPROVED_STATUS, batchEffectiveAt, stableHash } from "./price-control-contracts.mjs";

export const PRICE_CONTROL_SOURCE_COLUMNS = Object.freeze([
  "id", "apply_no", "country_code", "categrory", "sku", "sku_status",
  "lazada_rc_price", "lazada_hd_price", "lazada_dc_price",
  "lazada_mall_rc_price", "lazada_mall_hd_price", "lazada_mall_dc_price",
  "shopee_rc_price", "shopee_hd_price", "shopee_dc_price",
  "shopee_mall_rc_price", "shopee_mall_hd_price", "shopee_mall_dc_price",
  "seq", "tiktok_rc_price", "tiktok_hd_price", "tiktok_dc_price",
  "apply_date", "curr_approve_status", "apply_create_time", "approve_time", "submit_time",
]);

function required(value) {
  return String(value || "").trim();
}

function safeLimit(value, fallback = 40, maximum = 200) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? Math.max(1, Math.min(parsed, maximum)) : fallback;
}

function safeTimeout(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? Math.max(1_000, Math.min(parsed, 10 * 60_000)) : fallback;
}

function mysqlDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export function resolvePriceControlSourceConfig(env = process.env) {
  const config = {
    host: required(env.PRICE_CONTROL_MYSQL_HOST),
    port: Number.parseInt(env.PRICE_CONTROL_MYSQL_PORT || "3306", 10),
    database: required(env.PRICE_CONTROL_MYSQL_DATABASE),
    user: required(env.PRICE_CONTROL_MYSQL_USER),
    password: required(env.PRICE_CONTROL_MYSQL_PASSWORD),
    connectionLimit: safeLimit(env.PRICE_CONTROL_MYSQL_CONNECTION_LIMIT, 2, 5),
    connectTimeout: safeTimeout(env.PRICE_CONTROL_MYSQL_CONNECT_TIMEOUT_MS, 10_000),
    queryTimeout: safeTimeout(env.PRICE_CONTROL_MYSQL_QUERY_TIMEOUT_MS, 120_000),
  };
  return Object.freeze({
    ...config,
    configured: Boolean(config.host && config.database && config.user && config.password),
  });
}

export class MysqlPriceControlSource {
  constructor(config, { pool = null } = {}) {
    if (!config?.configured) throw new TypeError("Price control MySQL source is not configured");
    this.config = Object.freeze({
      ...config,
      connectTimeout: safeTimeout(config.connectTimeout, 10_000),
      queryTimeout: safeTimeout(config.queryTimeout, 120_000),
    });
    this.pool = pool;
  }

  async ensurePool() {
    if (this.pool) return this.pool;
    const mysql = (await import("mysql2/promise")).default;
    this.pool = mysql.createPool({
      host: this.config.host,
      port: this.config.port,
      database: this.config.database,
      user: this.config.user,
      password: this.config.password,
      waitForConnections: true,
      connectionLimit: this.config.connectionLimit,
      queueLimit: 0,
      connectTimeout: this.config.connectTimeout,
      enableKeepAlive: true,
      keepAliveInitialDelay: 0,
      decimalNumbers: false,
      dateStrings: true,
      charset: "utf8mb4",
    });
    return this.pool;
  }

  query(connection, sql, values = undefined) {
    const options = { sql, timeout: this.config.queryTimeout };
    return values === undefined ? connection.query(options) : connection.query(options, values);
  }

  execute(connection, sql, values = []) {
    return connection.execute({ sql, timeout: this.config.queryTimeout }, values);
  }

  async withReadOnlySnapshot(callback) {
    const connection = await (await this.ensurePool()).getConnection();
    try {
      await this.query(connection, "SET TRANSACTION READ ONLY");
      await this.query(connection, "START TRANSACTION WITH CONSISTENT SNAPSHOT");
      try {
        return await callback(connection);
      } finally {
        await connection.rollback();
      }
    } finally {
      connection.release();
    }
  }

  async status() {
    return { connected: true, transactionReadOnly: true, ...(await this.fetchMetadata()) };
  }

  async fetchMetadata() {
    return this.withReadOnlySnapshot(async (connection) => {
      const [rows] = await this.query(connection,
        `SELECT VERSION() AS server_version,DATABASE() AS database_name,
          @@global.read_only AS server_read_only,NOW() AS source_checked_at,
          (SELECT UPDATE_TIME FROM information_schema.tables
           WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='price_control') AS table_updated_at`,
      );
      return {
        serverVersion: String(rows[0]?.server_version || ""),
        databaseName: String(rows[0]?.database_name || ""),
        serverReadOnly: Number(rows[0]?.server_read_only || 0) === 1,
        sourceCheckedAt: mysqlDate(rows[0]?.source_checked_at),
        tableUpdatedAt: mysqlDate(rows[0]?.table_updated_at),
      };
    });
  }

  async fetchLatestApprovedBatches({ limit = 200, perCountry = 1 } = {}) {
    const boundedLimit = safeLimit(limit, 200, 500);
    const boundedPerCountry = safeLimit(perCountry, 1, 1);
    return this.withReadOnlySnapshot(async (connection) => {
      const [rows] = await this.query(connection,
        `WITH approved_batches AS (
           SELECT
             apply_no,country_code,categrory,MAX(curr_approve_status) AS approval_status,
             COUNT(*) AS source_row_count,
             MAX(apply_create_time) AS apply_created_at,
             MAX(submit_time) AS submitted_at,
             MAX(approve_time) AS approved_at,
             COALESCE(MAX(approve_time),MAX(submit_time),MAX(apply_create_time)) AS effective_at
           FROM price_control
           WHERE curr_approve_status='${APPROVED_STATUS}'
           GROUP BY apply_no,country_code,categrory
         ), ranked_batches AS (
           SELECT approved_batches.*,
             ROW_NUMBER() OVER (PARTITION BY country_code,categrory ORDER BY effective_at DESC,apply_no DESC) AS country_rank
           FROM approved_batches
         )
         SELECT apply_no,country_code,approval_status,source_row_count,
           apply_created_at,submitted_at,approved_at,effective_at
         FROM ranked_batches
         WHERE country_rank<=${boundedPerCountry}
         ORDER BY effective_at DESC,apply_no DESC
         LIMIT ${boundedLimit}`,
      );
      return rows.map((row) => ({
        applyNo: String(row.apply_no),
        countryCode: String(row.country_code || "").toUpperCase(),
        approvalStatus: String(row.approval_status || ""),
        sourceRowCount: Number(row.source_row_count || 0),
        applyCreatedAt: mysqlDate(row.apply_created_at),
        submittedAt: mysqlDate(row.submitted_at),
        approvedAt: mysqlDate(row.approved_at),
        effectiveAt: batchEffectiveAt({
          approvedAt: mysqlDate(row.approved_at),
          submittedAt: mysqlDate(row.submitted_at),
          applyCreatedAt: mysqlDate(row.apply_created_at),
        }),
      }));
    });
  }

  async fetchApprovedBatch(batch) {
    const applyNo = required(batch?.applyNo);
    if (!applyNo) throw new TypeError("Price control apply number is required");
    return this.withReadOnlySnapshot(async (connection) => {
      const [rows] = await this.execute(connection,
        `SELECT ${PRICE_CONTROL_SOURCE_COLUMNS.join(",")}
         FROM price_control
         WHERE apply_no=? AND curr_approve_status=?
         ORDER BY country_code,sku,seq,id`,
        [applyNo, APPROVED_STATUS],
      );
      await this.enrichProductNames(connection, rows);
      return rows.map((row) => ({ ...row, product_name_cn: row.product_name_cn || null }));
    });
  }

  async enrichProductNames(connection, rows) {
    const byCountry = new Map();
    for (const row of rows) {
      const country = String(row.country_code || "").trim().toUpperCase();
      const sku = String(row.sku || "").trim().toUpperCase();
      if (!country || !sku) continue;
      if (!byCountry.has(country)) byCountry.set(country, new Set());
      byCountry.get(country).add(sku);
    }
    const names = new Map();
    for (const [country, skuSet] of byCountry) {
      const skus = [...skuSet];
      for (let offset = 0; offset < skus.length; offset += 500) {
        const chunk = skus.slice(offset, offset + 500);
        const placeholders = chunk.map(() => "?").join(",");
        const [products] = await this.execute(connection,
          `SELECT country,stock_sku,MIN(NULLIF(TRIM(sku_name_cn),'')) AS sku_name_cn
           FROM product_package
           WHERE country=? AND stock_sku IN (${placeholders})
           GROUP BY country,stock_sku`,
          [country, ...chunk],
        );
        for (const product of products) {
          names.set(`${String(product.country).toUpperCase()}|${String(product.stock_sku).toUpperCase()}`, product.sku_name_cn || null);
        }
      }
    }
    for (const row of rows) {
      row.product_name_cn = names.get(`${String(row.country_code || "").toUpperCase()}|${String(row.sku || "").toUpperCase()}`) || null;
    }
  }

  sourceVersion(batches) {
    return stableHash(...batches.map((batch) => `${batch.applyNo}:${batch.effectiveAt}`));
  }

  async close() {
    await this.pool?.end();
    this.pool = null;
  }
}

export function createMysqlPriceControlSource(env = process.env) {
  const config = resolvePriceControlSourceConfig(env);
  return config.configured ? new MysqlPriceControlSource(config) : null;
}
