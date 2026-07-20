import { randomUUID } from "node:crypto";
import { DATABASE_DIALECTS, assertDatabaseProvider } from "./database-provider.mjs";
import { DATABASE_VALUE_TYPES, encodeDatabaseValue, normalizeDatabaseValue } from "./database-compatibility.mjs";

const CONTRACT_TABLE = "f2_provider_contract";
const CONTRACT_CHILD_TABLE = "f2_provider_contract_child";
const CONTRACT_INDEX = "idx_f2_provider_contract_observed_at";

function contractDdl(dialect) {
  if (dialect === DATABASE_DIALECTS.SQLITE) {
    return `DROP TABLE IF EXISTS ${CONTRACT_CHILD_TABLE};
      DROP TABLE IF EXISTS ${CONTRACT_TABLE};
      CREATE TABLE ${CONTRACT_TABLE} (
        id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        sequence_value INTEGER NOT NULL
      );
      CREATE TABLE ${CONTRACT_CHILD_TABLE} (
        id TEXT PRIMARY KEY,
        parent_id TEXT NOT NULL REFERENCES ${CONTRACT_TABLE}(id) ON DELETE CASCADE
      );
      CREATE INDEX ${CONTRACT_INDEX} ON ${CONTRACT_TABLE}(observed_at);`;
  }
  if (dialect === DATABASE_DIALECTS.POSTGRESQL) {
    return `DROP TABLE IF EXISTS ${CONTRACT_CHILD_TABLE};
      DROP TABLE IF EXISTS ${CONTRACT_TABLE};
      CREATE TABLE ${CONTRACT_TABLE} (
        id uuid PRIMARY KEY,
        enabled boolean NOT NULL,
        payload_json jsonb NOT NULL,
        observed_at timestamptz NOT NULL,
        sequence_value bigint NOT NULL
      );
      CREATE TABLE ${CONTRACT_CHILD_TABLE} (
        id uuid PRIMARY KEY,
        parent_id uuid NOT NULL REFERENCES ${CONTRACT_TABLE}(id) ON DELETE CASCADE
      );
      CREATE INDEX ${CONTRACT_INDEX} ON ${CONTRACT_TABLE}(observed_at);`;
  }
  throw new TypeError("Provider contract dialect is unsupported");
}

function insertSql(provider) {
  const placeholders = Array.from({ length: 5 }, (_, index) => provider.placeholder(index + 1));
  return `INSERT INTO ${CONTRACT_TABLE} (id, enabled, payload_json, observed_at, sequence_value) VALUES (${placeholders.join(", ")})`;
}

function encodedRecord(provider, id) {
  return [
    encodeDatabaseValue(id, DATABASE_VALUE_TYPES.UUID, provider.dialect),
    encodeDatabaseValue(true, DATABASE_VALUE_TYPES.BOOLEAN, provider.dialect),
    encodeDatabaseValue({ source: "provider-contract", version: 1 }, DATABASE_VALUE_TYPES.JSON, provider.dialect),
    encodeDatabaseValue("2026-07-20T08:09:10.000Z", DATABASE_VALUE_TYPES.TIMESTAMP, provider.dialect),
    encodeDatabaseValue("9007199254740991", DATABASE_VALUE_TYPES.BIGINT, provider.dialect),
  ];
}

function assertContractRow(row, expectedId) {
  const normalized = {
    id: normalizeDatabaseValue(row.id, DATABASE_VALUE_TYPES.UUID),
    enabled: normalizeDatabaseValue(row.enabled, DATABASE_VALUE_TYPES.BOOLEAN),
    payload: normalizeDatabaseValue(row.payload_json, DATABASE_VALUE_TYPES.JSON),
    observedAt: normalizeDatabaseValue(row.observed_at, DATABASE_VALUE_TYPES.TIMESTAMP),
    sequenceValue: normalizeDatabaseValue(row.sequence_value, DATABASE_VALUE_TYPES.BIGINT),
  };
  if (normalized.id !== expectedId || normalized.enabled !== true
    || normalized.payload.source !== "provider-contract" || normalized.payload.version !== 1
    || normalized.observedAt !== "2026-07-20T08:09:10.000Z"
    || normalized.sequenceValue !== "9007199254740991") {
    throw new Error("Database provider returned an incompatible row structure");
  }
}

export async function runProviderContract(provider) {
  assertDatabaseProvider(provider);
  const committedId = randomUUID();
  const rolledBackId = randomUUID();
  const parameterizedInsert = insertSql(provider);
  let cleanupComplete = false;
  try {
    const migrations = await provider.migrate([{ id: "f2-provider-contract", up: contractDdl(provider.dialect) }]);
    await provider.execute(parameterizedInsert, encodedRecord(provider, committedId));
    const initial = await provider.query(`SELECT id, enabled, payload_json, observed_at, sequence_value FROM ${CONTRACT_TABLE} WHERE id = ${provider.placeholder(1)}`, [committedId]);
    if (initial.rowCount !== 1) throw new Error("Database provider query contract failed");
    assertContractRow(initial.rows[0], committedId);

    await provider.transaction((transaction) => transaction.execute(parameterizedInsert, encodedRecord(provider, randomUUID())));
    try {
      await provider.transaction(async (transaction) => {
        await transaction.execute(parameterizedInsert, encodedRecord(provider, rolledBackId));
        throw new Error("provider-contract-rollback");
      });
    } catch (error) {
      if (error?.message !== "provider-contract-rollback") throw error;
    }
    const rollbackCheck = await provider.query(`SELECT id FROM ${CONTRACT_TABLE} WHERE id = ${provider.placeholder(1)}`, [rolledBackId]);
    if (rollbackCheck.rowCount !== 0) throw new Error("Database provider transaction rollback failed");

    const childInsert = `INSERT INTO ${CONTRACT_CHILD_TABLE} (id, parent_id) VALUES (${provider.placeholder(1)}, ${provider.placeholder(2)})`;
    await provider.execute(childInsert, [randomUUID(), committedId]);
    let foreignKeyRejected = false;
    try {
      await provider.execute(childInsert, [randomUUID(), randomUUID()]);
    } catch {
      foreignKeyRejected = true;
    }
    if (!foreignKeyRejected) throw new Error("Database provider foreign-key contract failed");

    const indexQuery = provider.dialect === DATABASE_DIALECTS.SQLITE
      ? "SELECT name FROM sqlite_master WHERE type='index' AND name=?"
      : "SELECT indexname AS name FROM pg_indexes WHERE schemaname=current_schema() AND indexname=$1";
    const indexResult = await provider.query(indexQuery, [CONTRACT_INDEX]);
    if (indexResult.rowCount !== 1) throw new Error("Database provider index contract failed");

    let duplicateRejected = false;
    try {
      await provider.execute(parameterizedInsert, encodedRecord(provider, committedId));
    } catch {
      duplicateRejected = true;
    }
    if (!duplicateRejected) throw new Error("Database provider constraint contract failed");
    return Object.freeze({
      dialect: provider.dialect,
      migrations,
      query: true,
      execute: true,
      parameterizedQueries: true,
      commit: true,
      rollback: true,
      constraints: true,
      foreignKeys: true,
      indexes: true,
    });
  } finally {
    try {
      await provider.executeScript(`DROP TABLE IF EXISTS ${CONTRACT_CHILD_TABLE}; DROP TABLE IF EXISTS ${CONTRACT_TABLE}`);
      cleanupComplete = true;
    } finally {
      if (!cleanupComplete) throw new Error("Database provider contract cleanup failed");
    }
  }
}

export const PROVIDER_CONTRACT_TABLE = CONTRACT_TABLE;
export const PROVIDER_CONTRACT_TABLES = Object.freeze([CONTRACT_CHILD_TABLE, CONTRACT_TABLE]);
