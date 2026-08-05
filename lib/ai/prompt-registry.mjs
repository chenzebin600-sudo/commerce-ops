const PROMPT_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const PROMPT_VERSION_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;

function bounded(value, maximum) {
  return String(value || "").trim().slice(0, maximum);
}

export function assertPromptReference(input = {}) {
  const id = bounded(input.id, 120);
  const version = bounded(input.version, 80);
  if (!PROMPT_ID_PATTERN.test(id)) throw Object.assign(new TypeError("AI prompt id is invalid"), {
    code: "AI_PROMPT_ID_INVALID",
  });
  if (!PROMPT_VERSION_PATTERN.test(version)) throw Object.assign(new TypeError("AI prompt version is invalid"), {
    code: "AI_PROMPT_VERSION_INVALID",
  });
  return Object.freeze({ id, version });
}

export class AiPromptRegistry {
  constructor() {
    this.entries = new Map();
  }

  register(input = {}) {
    const reference = assertPromptReference(input);
    const moduleId = bounded(input.moduleId, 80);
    const operation = bounded(input.operation, 80);
    const key = `${reference.id}@${reference.version}`;
    const current = this.entries.get(key);
    if (current && current.moduleId !== moduleId) {
      throw Object.assign(new Error(`AI prompt reference ${key} is already registered for another module`), {
        code: "AI_PROMPT_REFERENCE_CONFLICT",
      });
    }
    const operations = [...new Set([...(current?.operations || []), operation].filter(Boolean))].sort();
    const entry = Object.freeze({ ...reference, moduleId, operations: Object.freeze(operations) });
    this.entries.set(key, entry);
    return entry;
  }

  get(id, version) {
    const reference = assertPromptReference({ id, version });
    return this.entries.get(`${reference.id}@${reference.version}`) || null;
  }

  list() {
    return [...this.entries.values()];
  }
}

export function resolvePromptRegistration({ registry, moduleId, operation, promptId, promptVersion }) {
  const hasId = String(promptId || "").trim() !== "";
  const hasVersion = String(promptVersion || "").trim() !== "";
  if (hasId !== hasVersion) throw Object.assign(new TypeError("AI prompt id and version must be provided together"), {
    code: "AI_PROMPT_REFERENCE_INCOMPLETE",
  });
  if (!hasId) return Object.freeze({
    id: `legacy.${moduleId}.${operation}`.toLowerCase().replace(/[^a-z0-9._-]+/g, "_"),
    version: "legacy-unversioned",
    managed: false,
  });
  const entry = registry.register({ id: promptId, version: promptVersion, moduleId, operation });
  return Object.freeze({ id: entry.id, version: entry.version, managed: true });
}
