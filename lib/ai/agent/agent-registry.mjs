import { assertAgentReference, defineAgent } from "./agent-contracts.mjs";

function keyOf(name, version) {
  return `${name}@${version}`;
}

export class AgentRegistry {
  constructor() {
    this.entries = new Map();
  }

  register(input) {
    const definition = defineAgent(input);
    const key = keyOf(definition.name, definition.version);
    const current = this.entries.get(key);
    if (current) {
      if (JSON.stringify(current) !== JSON.stringify(definition)) {
        throw Object.assign(new Error(`Agent ${key} is already registered with another definition`), {
          code: "AGENT_DEFINITION_CONFLICT",
        });
      }
      return current;
    }
    this.entries.set(key, definition);
    return definition;
  }

  get(name, version = "1.0.0") {
    const reference = assertAgentReference(name, version);
    return this.entries.get(keyOf(reference.name, reference.version)) || null;
  }

  require(name, version = "1.0.0") {
    const definition = this.get(name, version);
    if (!definition) {
      throw Object.assign(new Error(`Agent ${name}@${version} is not registered`), {
        code: "AGENT_NOT_REGISTERED",
      });
    }
    return definition;
  }

  list() {
    return [...this.entries.values()].sort((left, right) => (
      keyOf(left.name, left.version).localeCompare(keyOf(right.name, right.version))
    ));
  }
}
