import { assertDatabaseProvider, DATABASE_DIALECTS } from "./database-provider.mjs";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function identifier(value, label) {
  const normalized = String(value || "");
  if (!IDENTIFIER.test(normalized)) throw new TypeError(`${label} is invalid`);
  return normalized;
}

export class RepositorySql {
  constructor({ provider, postgresqlSchema = "app" }) {
    this.provider = assertDatabaseProvider(provider);
    this.postgresqlSchema = identifier(postgresqlSchema, "PostgreSQL schema");
  }

  get isPostgresql() {
    return this.provider.dialect === DATABASE_DIALECTS.POSTGRESQL;
  }

  table(name) {
    const tableName = identifier(name, "Table name");
    return this.isPostgresql ? `${this.postgresqlSchema}.${tableName}` : tableName;
  }

  placeholder(index) {
    return this.provider.placeholder(index);
  }

  placeholders(count, startAt = 1) {
    if (!Number.isInteger(count) || count < 0) throw new TypeError("Placeholder count is invalid");
    return Array.from({ length: count }, (_, offset) => this.placeholder(startAt + offset));
  }

  async relationExists(name) {
    const relation = identifier(name, "Relation name");
    if (this.isPostgresql) {
      const result = await this.provider.query(
        `SELECT 1 AS found
         FROM information_schema.tables
         WHERE table_schema=${this.placeholder(1)} AND table_name=${this.placeholder(2)}
         UNION ALL
         SELECT 1 AS found
         FROM information_schema.views
         WHERE table_schema=${this.placeholder(3)} AND table_name=${this.placeholder(4)}
         LIMIT 1`,
        [this.postgresqlSchema, relation, this.postgresqlSchema, relation],
      );
      return result.rows.length > 0;
    }
    const result = await this.provider.query(
      `SELECT 1 AS found FROM sqlite_master
       WHERE type IN ('table','view') AND name=${this.placeholder(1)} LIMIT 1`,
      [relation],
    );
    return result.rows.length > 0;
  }

  async columnExists(tableName, columnName) {
    const table = identifier(tableName, "Table name");
    const column = identifier(columnName, "Column name");
    if (this.isPostgresql) {
      const result = await this.provider.query(
        `SELECT 1 AS found FROM information_schema.columns
         WHERE table_schema=${this.placeholder(1)}
           AND table_name=${this.placeholder(2)}
           AND column_name=${this.placeholder(3)}
         LIMIT 1`,
        [this.postgresqlSchema, table, column],
      );
      return result.rows.length > 0;
    }
    const result = await this.provider.query(`PRAGMA table_info('${table}')`);
    return result.rows.some((item) => item.name === column);
  }

  jsonText(expression, key) {
    const jsonKey = identifier(key, "JSON key");
    return this.isPostgresql
      ? `(COALESCE(${expression}, '{}')::jsonb ->> '${jsonKey}')`
      : `json_extract(COALESCE(${expression}, '{}'),'$.${jsonKey}')`;
  }

  jsonNumber(expression, key) {
    const text = this.jsonText(expression, key);
    return this.isPostgresql
      ? `COALESCE(NULLIF(${text}, '')::numeric, 0)`
      : `COALESCE(${text}, 0)`;
  }
}

export function createRepositorySql(provider, options = {}) {
  return new RepositorySql({ provider, ...options });
}
