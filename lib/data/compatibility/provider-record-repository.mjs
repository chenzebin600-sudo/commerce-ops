import { DATABASE_DIALECTS, assertDatabaseProvider } from "../database-provider.mjs";
import {
  encodePostgresqlMigrationValue,
  normalizeMigrationValue,
  quoteIdentifier,
} from "../../postgresql/sqlite-migration.mjs";

const PROVIDER_NAMES = new Set(["sqlite", "postgres", "postgresql"]);

function encodeSqliteValue(value, column) {
  if (value === null || value === undefined) return null;
  const normalized = normalizeMigrationValue(value, column);
  if (column.logicalType === "boolean") return normalized ? 1 : 0;
  if (column.logicalType === "json") return JSON.stringify(normalized);
  return normalized;
}

function encodeValue(value, column, dialect) {
  return dialect === DATABASE_DIALECTS.POSTGRESQL
    ? encodePostgresqlMigrationValue(value, column)
    : encodeSqliteValue(value, column);
}

function normalizedRow(row, table) {
  if (!row) return null;
  return Object.fromEntries(table.columns.map((column) => [
    column.name,
    normalizeMigrationValue(row[column.name], column),
  ]));
}

function errorCode(error) {
  const code = String(error?.code || "");
  const message = String(error?.message || error || "");
  if (code === "23505" || /UNIQUE constraint failed/i.test(message)) return "UNIQUE_CONSTRAINT";
  if (code === "23503" || /FOREIGN KEY constraint failed/i.test(message)) return "FOREIGN_KEY_CONSTRAINT";
  if (code === "23502" || /NOT NULL constraint failed/i.test(message)) return "NOT_NULL_CONSTRAINT";
  if (code === "23514" || /CHECK constraint failed/i.test(message)) return "CHECK_CONSTRAINT";
  return "DATABASE_OPERATION_FAILED";
}

export class RepositoryCompatibilityError extends Error {
  constructor(code, cause) {
    super(code);
    this.name = "RepositoryCompatibilityError";
    this.code = code;
    this.cause = cause;
  }
}

function normalizeError(error) {
  if (error instanceof RepositoryCompatibilityError) return error;
  return new RepositoryCompatibilityError(errorCode(error), error);
}

function assertTable(table) {
  if (!table || typeof table.name !== "string" || !Array.isArray(table.columns) || !table.columns.length) {
    throw new TypeError("Repository table metadata is invalid");
  }
  if (!Array.isArray(table.primaryKey) || !table.primaryKey.length) {
    throw new TypeError(`Repository table ${table.name} requires a primary key`);
  }
  return table;
}

function keyObject(table, key) {
  if (table.primaryKey.length === 1 && (typeof key !== "object" || key === null || Array.isArray(key))) {
    return { [table.primaryKey[0]]: key };
  }
  if (!key || typeof key !== "object" || Array.isArray(key)) throw new TypeError("Repository key is invalid");
  const result = {};
  for (const column of table.primaryKey) {
    if (key[column] === undefined) throw new TypeError(`Repository key ${column} is required`);
    result[column] = key[column];
  }
  return result;
}

export function resolveCompatibilityProviderName(env = process.env) {
  const configured = String(env.DATABASE_PROVIDER || "sqlite").trim().toLowerCase();
  if (!PROVIDER_NAMES.has(configured)) throw new TypeError("DATABASE_PROVIDER must be sqlite or postgres");
  return configured === "postgresql" ? "postgres" : configured;
}

export class ProviderRecordRepository {
  constructor({ provider, executor = provider, table }) {
    assertDatabaseProvider(provider);
    if (!executor || typeof executor.query !== "function" || typeof executor.execute !== "function"
      || typeof executor.placeholder !== "function") {
      throw new TypeError("Repository database executor is incomplete");
    }
    this.provider = provider;
    this.executor = executor;
    this.table = assertTable(table);
    this.columns = new Map(this.table.columns.map((column) => [column.name, column]));
    this.tableSql = quoteIdentifier(this.table.name);
  }

  column(name) {
    const column = this.columns.get(name);
    if (!column) throw new TypeError(`Unknown ${this.table.name} column: ${name}`);
    return column;
  }

  encodedEntries(record) {
    if (!record || typeof record !== "object" || Array.isArray(record)) throw new TypeError("Repository record is invalid");
    return Object.entries(record)
      .filter(([, value]) => value !== undefined)
      .map(([name, value]) => {
        const column = this.column(name);
        return [column, encodeValue(value, column, this.provider.dialect)];
      });
  }

  where(criteria, offset = 0) {
    if (!criteria || typeof criteria !== "object" || Array.isArray(criteria)) throw new TypeError("Repository criteria are invalid");
    const values = [];
    const clauses = [];
    for (const [name, value] of Object.entries(criteria)) {
      const column = this.column(name);
      if (value === null) {
        clauses.push(`${quoteIdentifier(name)} IS NULL`);
      } else {
        values.push(encodeValue(value, column, this.provider.dialect));
        clauses.push(`${quoteIdentifier(name)} = ${this.executor.placeholder(offset + values.length)}`);
      }
    }
    if (!clauses.length) throw new TypeError("Repository criteria cannot be empty");
    return { sql: clauses.join(" AND "), values };
  }

  async insert(record) {
    const entries = this.encodedEntries(record);
    if (!entries.length) throw new TypeError("Repository insert requires values");
    const columns = entries.map(([column]) => quoteIdentifier(column.name)).join(", ");
    const placeholders = entries.map((_, index) => this.executor.placeholder(index + 1)).join(", ");
    try {
      await this.executor.execute(
        `INSERT INTO ${this.tableSql} (${columns}) VALUES (${placeholders})`,
        entries.map(([, value]) => value),
      );
      const key = Object.fromEntries(this.table.primaryKey.map((name) => [name, record[name]]));
      if (Object.values(key).some((value) => value === undefined)) return null;
      return this.get(key);
    } catch (error) {
      throw normalizeError(error);
    }
  }

  async get(key) {
    const condition = this.where(keyObject(this.table, key));
    try {
      const result = await this.executor.query(
        `SELECT * FROM ${this.tableSql} WHERE ${condition.sql}`,
        condition.values,
      );
      return normalizedRow(result.rows[0], this.table);
    } catch (error) {
      throw normalizeError(error);
    }
  }

  async list(criteria = null) {
    const condition = criteria && Object.keys(criteria).length ? this.where(criteria) : null;
    const order = this.table.primaryKey.map(quoteIdentifier).join(", ");
    try {
      const result = await this.executor.query(
        `SELECT * FROM ${this.tableSql}${condition ? ` WHERE ${condition.sql}` : ""} ORDER BY ${order}`,
        condition?.values || [],
      );
      return result.rows.map((row) => normalizedRow(row, this.table));
    } catch (error) {
      throw normalizeError(error);
    }
  }

  async update(key, changes) {
    const entries = this.encodedEntries(changes);
    if (!entries.length) throw new TypeError("Repository update requires values");
    const assignments = entries.map(([column], index) => (
      `${quoteIdentifier(column.name)} = ${this.executor.placeholder(index + 1)}`
    ));
    const condition = this.where(keyObject(this.table, key), entries.length);
    try {
      const result = await this.executor.execute(
        `UPDATE ${this.tableSql} SET ${assignments.join(", ")} WHERE ${condition.sql}`,
        [...entries.map(([, value]) => value), ...condition.values],
      );
      if (Number(result.rowCount || 0) === 0) return null;
      return this.get(key);
    } catch (error) {
      throw normalizeError(error);
    }
  }

  async delete(key) {
    const condition = this.where(keyObject(this.table, key));
    try {
      const result = await this.executor.execute(
        `DELETE FROM ${this.tableSql} WHERE ${condition.sql}`,
        condition.values,
      );
      return Number(result.rowCount || 0);
    } catch (error) {
      throw normalizeError(error);
    }
  }
}

export function createRepositoryTableMap(schema) {
  if (!schema || !Array.isArray(schema.tables)) throw new TypeError("Repository schema inventory is required");
  return new Map(schema.tables.map((table) => [table.name, assertTable(table)]));
}

export const COMPATIBILITY_PROVIDER_NAMES = Object.freeze(["sqlite", "postgres"]);
