import fs from "node:fs/promises";
import path from "node:path";
import {
  UNIFIED_IDENTITY_RULES,
  UNIFIED_SOURCE_FIELD_MAPPINGS,
  unifiedFieldMappingSummary,
  validateUnifiedFieldMappings,
} from "../lib/data-foundation/unified-field-mappings.mjs";

function option(name, fallback) {
  const prefix = `--${name}=`;
  const raw = process.argv.slice(2).find((item) => item.startsWith(prefix));
  return raw ? raw.slice(prefix.length) : fallback;
}

function csvCell(value) {
  const normalized = Array.isArray(value) ? value.join(" + ") : String(value ?? "");
  return `"${normalized.replaceAll('"', '""')}"`;
}

function csv(rows, columns) {
  return `\uFEFF${[
    columns.map(([heading]) => csvCell(heading)).join(","),
    ...rows.map((row) => columns.map(([, key]) => csvCell(row[key])).join(",")),
  ].join("\r\n")}\r\n`;
}

const fieldOutput = path.resolve(option(
  "output",
  "docs/reports/COMMERCE-OPS-UNIFIED-FIELD-MAPPING-20260808.csv",
));
const identityOutput = path.resolve(option(
  "identity-output",
  "docs/reports/COMMERCE-OPS-UNIFIED-IDENTITY-RULES-20260808.csv",
));

validateUnifiedFieldMappings();
await Promise.all([
  fs.mkdir(path.dirname(fieldOutput), { recursive: true }),
  fs.mkdir(path.dirname(identityOutput), { recursive: true }),
]);

await Promise.all([
  fs.writeFile(fieldOutput, csv(UNIFIED_SOURCE_FIELD_MAPPINGS, [
    ["source_code", "sourceCode"],
    ["dataset_code", "datasetCode"],
    ["source_relation", "sourceRelation"],
    ["source_field", "sourceField"],
    ["raw_target", "rawTarget"],
    ["canonical_field", "canonicalField"],
    ["target_relation", "targetRelation"],
    ["target_column", "targetColumn"],
    ["mapping_mode", "mode"],
    ["transform_code", "transformCode"],
    ["required_level", "requiredLevel"],
    ["null_semantics", "nullSemantics"],
    ["identity_role", "identityRole"],
    ["sensitivity", "sensitivity"],
    ["publication_scope", "publicationScope"],
    ["cardinality", "cardinality"],
    ["description", "description"],
  ]), "utf8"),
  fs.writeFile(identityOutput, csv(UNIFIED_IDENTITY_RULES, [
    ["rule_code", "code"],
    ["rule_kind", "ruleKind"],
    ["canonical_entity_type", "canonicalEntityType"],
    ["source_key_version", "sourceKeyVersion"],
    ["allowed_match_methods", "allowedMatchMethods"],
    ["source_dataset", "sourceDatasetCode"],
    ["target_dataset", "targetDatasetCode"],
    ["source_keys", "sourceKeys"],
    ["target_keys", "targetKeys"],
    ["cardinality", "cardinality"],
    ["acceptance_policy", "acceptance"],
    ["conflict_policy", "conflict"],
  ]), "utf8"),
]);

process.stdout.write(`${JSON.stringify({
  summary: unifiedFieldMappingSummary(),
  fieldOutput,
  identityOutput,
}, null, 2)}\n`);
