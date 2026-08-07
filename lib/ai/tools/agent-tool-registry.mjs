import {
  assertAgentToolName,
  assertAgentToolVersion,
  defineAgentTool,
} from "./agent-tool-contracts.mjs";

function keyOf(name, version) {
  return `${name}@${version}`;
}

export class AgentToolRegistry {
  constructor() {
    this.entries = new Map();
  }

  register(input) {
    if (typeof input?.execute !== "function") {
      throw Object.assign(new TypeError("Agent tool executor is required"), {
        code: "AGENT_TOOL_CONTRACT_INVALID",
      });
    }
    const definition = defineAgentTool(input);
    const key = keyOf(definition.name, definition.version);
    const current = this.entries.get(key);
    if (current) {
      if (JSON.stringify(current.definition) !== JSON.stringify(definition)) {
        throw Object.assign(
          new Error(`Agent tool ${definition.name} is already registered with another definition`),
          { code: "AGENT_TOOL_DEFINITION_CONFLICT" },
        );
      }
      return current.definition;
    }
    this.entries.set(key, { definition, execute: input.execute });
    return definition;
  }

  get(nameValue, version = "1.0.0") {
    const name = assertAgentToolName(nameValue);
    const normalizedVersion = assertAgentToolVersion(version);
    return this.entries.get(keyOf(name, normalizedVersion))?.definition || null;
  }

  require(nameValue, version = "1.0.0") {
    const name = assertAgentToolName(nameValue);
    const normalizedVersion = assertAgentToolVersion(version);
    const entry = this.entries.get(keyOf(name, normalizedVersion));
    if (!entry) {
      throw Object.assign(new Error(`Agent tool ${name}@${normalizedVersion} is not registered`), {
        code: "AGENT_TOOL_NOT_REGISTERED",
        toolName: name,
        toolVersion: normalizedVersion,
      });
    }
    return entry;
  }

  list() {
    return [...this.entries.values()]
      .map((entry) => entry.definition)
      .sort((left, right) => keyOf(left.name, left.version).localeCompare(keyOf(right.name, right.version)));
  }

  execute(nameValue, version, invocation) {
    return this.require(nameValue, version).execute(invocation);
  }
}
