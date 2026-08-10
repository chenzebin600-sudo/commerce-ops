import pg from "pg";

const { Pool } = pg;

export class FulfillmentV2PostgresqlProvider {
  constructor({ connectionString, pool = null, PoolClass = Pool } = {}) {
    const normalized = String(connectionString || "").trim();
    if (!pool && !normalized) throw new TypeError("Fulfillment V2 PostgreSQL connection string is required");
    this.ownsPool = !pool;
    this.pool = pool || new PoolClass({
      connectionString: normalized,
      ssl: { rejectUnauthorized: true },
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      application_name: "commerce-ops-fulfillment-v2",
    });
  }

  async query(text, values = []) {
    return this.pool.query({ text: String(text), values });
  }

  async transaction(callback) {
    if (typeof callback !== "function") throw new TypeError("Fulfillment V2 transaction callback is required");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const transaction = { query: (text, values = []) => client.query({ text: String(text), values }) };
      const result = await callback(transaction);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }

  async readiness() {
    const result = await this.query(`SELECT version
      FROM fulfillment.schema_migrations
      ORDER BY applied_at DESC
      LIMIT 1`);
    const version = result.rows?.[0]?.version || null;
    if (!version) throw new Error("Fulfillment V2 schema migration is missing");
    return Object.freeze({ ready: true, schemaVersion: version });
  }

  async close() {
    if (this.ownsPool) await this.pool.end();
  }
}
