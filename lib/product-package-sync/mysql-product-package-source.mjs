import { PRODUCT_PACKAGE_SOURCE_COLUMNS } from "./product-package-source-contract.mjs";

function required(value) {
  return String(value || "").trim();
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? Math.max(minimum, Math.min(parsed, maximum)) : fallback;
}

function dateValue(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

export function resolveProductPackageSourceConfig(env = process.env) {
  const config = {
    host: required(env.PRODUCT_PACKAGE_MYSQL_HOST || env.PRICE_CONTROL_MYSQL_HOST),
    port: boundedInteger(env.PRODUCT_PACKAGE_MYSQL_PORT || env.PRICE_CONTROL_MYSQL_PORT, 3306, 1, 65535),
    database: required(env.PRODUCT_PACKAGE_MYSQL_DATABASE || env.PRICE_CONTROL_MYSQL_DATABASE),
    user: required(env.PRODUCT_PACKAGE_MYSQL_USER || env.PRICE_CONTROL_MYSQL_USER),
    password: required(env.PRODUCT_PACKAGE_MYSQL_PASSWORD || env.PRICE_CONTROL_MYSQL_PASSWORD),
    connectionLimit: boundedInteger(env.PRODUCT_PACKAGE_MYSQL_CONNECTION_LIMIT, 2, 1, 5),
    connectTimeout: boundedInteger(env.PRODUCT_PACKAGE_MYSQL_CONNECT_TIMEOUT_MS, 10_000, 1_000, 120_000),
    batchSize: boundedInteger(env.PRODUCT_PACKAGE_SYNC_BATCH_SIZE, 2_000, 100, 10_000),
  };
  return Object.freeze({
    ...config,
    configured: Boolean(config.host && config.database && config.user && config.password),
  });
}

export class MysqlProductPackageSource {
  constructor(config, { pool = null } = {}) {
    if (!config?.configured) throw new TypeError("Product package MySQL source is not configured");
    this.config = config;
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

  async withReadOnlySnapshot(callback) {
    const connection = await (await this.ensurePool()).getConnection();
    try {
      await connection.query("SET TRANSACTION READ ONLY");
      await connection.query("START TRANSACTION WITH CONSISTENT SNAPSHOT");
      try {
        return await callback(connection);
      } finally {
        await connection.rollback();
      }
    } finally {
      connection.release();
    }
  }

  async metadata(connection) {
    const [schemaRows] = await connection.query(
      "SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='product_package' ORDER BY ORDINAL_POSITION",
    );
    const actual = new Set(schemaRows.map((row) => String(row.COLUMN_NAME || row.column_name)));
    const missingColumns = PRODUCT_PACKAGE_SOURCE_COLUMNS.filter((column) => !actual.has(column));
    if (missingColumns.length) {
      const error = new Error(`产品包源表缺少字段：${missingColumns.join("、")}`);
      error.code = "PRODUCT_PACKAGE_SOURCE_SCHEMA_MISMATCH";
      throw error;
    }
    const [rows] = await connection.query(
      `SELECT COUNT(*) AS row_count,MIN(update_time) AS min_updated_at,MAX(update_time) AS max_updated_at,
        NOW() AS source_checked_at,
        (SELECT UPDATE_TIME FROM information_schema.tables
         WHERE table_schema=DATABASE() AND table_name='product_package') AS table_updated_at
       FROM product_package`,
    );
    const row = rows[0] || {};
    return Object.freeze({
      databaseName: this.config.database,
      tableName: "product_package",
      rowCount: Number(row.row_count || 0),
      minUpdatedAt: dateValue(row.min_updated_at),
      maxUpdatedAt: dateValue(row.max_updated_at),
      sourceCheckedAt: dateValue(row.source_checked_at),
      tableUpdatedAt: dateValue(row.table_updated_at),
      transactionReadOnly: true,
    });
  }

  async status() {
    return this.withReadOnlySnapshot(async (connection) => {
      const [server] = await connection.query("SELECT VERSION() AS server_version,DATABASE() AS database_name");
      return Object.freeze({
        connected: true,
        serverVersion: String(server[0]?.server_version || ""),
        databaseName: String(server[0]?.database_name || this.config.database),
        ...(await this.metadata(connection)),
      });
    });
  }

  async readSnapshot({ onBatch, batchSize = this.config.batchSize } = {}) {
    if (typeof onBatch !== "function") throw new TypeError("Product package snapshot batch callback is required");
    const safeBatchSize = boundedInteger(batchSize, this.config.batchSize, 100, 10_000);
    const selectColumns = PRODUCT_PACKAGE_SOURCE_COLUMNS.map((column) => `\`${column}\``).join(",");
    return this.withReadOnlySnapshot(async (connection) => {
      const metadata = await this.metadata(connection);
      let offset = 0;
      while (offset < metadata.rowCount) {
        const [rows] = await connection.query(
          `SELECT ${selectColumns} FROM product_package
           ORDER BY country,stock_sku,warehouse_id,sales_sku
           LIMIT ${safeBatchSize} OFFSET ${offset}`,
        );
        if (!rows.length) break;
        await onBatch(rows, { offset, metadata });
        offset += rows.length;
      }
      if (offset !== metadata.rowCount) {
        const error = new Error(`产品包一致性快照行数不一致：预期 ${metadata.rowCount}，实际 ${offset}`);
        error.code = "PRODUCT_PACKAGE_SOURCE_ROW_COUNT_MISMATCH";
        throw error;
      }
      return metadata;
    });
  }

  async close() {
    await this.pool?.end?.();
    this.pool = null;
  }
}

export function createMysqlProductPackageSource(env = process.env) {
  const config = resolveProductPackageSourceConfig(env);
  return config.configured ? new MysqlProductPackageSource(config) : null;
}
