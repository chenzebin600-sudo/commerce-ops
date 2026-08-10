import { AgentRegistry } from "./agent-registry.mjs";
import { AgentTaskBridge } from "./agent-task-bridge.mjs";
import { AgentToolRuntime } from "../tools/agent-tool-runtime.mjs";

export class AgentFramework {
  constructor({ taskService, registry = new AgentRegistry(), toolRegistry, toolTrace }) {
    if (!toolRegistry) {
      throw Object.assign(new TypeError("Agent Framework requires a Tool Registry"), {
        code: "AGENT_TOOL_REGISTRY_REQUIRED",
      });
    }
    this.registry = registry;
    this.tasks = new AgentTaskBridge({ registry, taskService });
    this.toolRuntime = new AgentToolRuntime({
      agentRegistry: registry,
      toolRegistry,
      trace: toolTrace,
    });
  }

  register(definition) {
    return this.registry.register(definition);
  }

  get(name, version = "1.0.0") {
    return this.registry.get(name, version);
  }

  list() {
    return this.registry.list();
  }

  createTask(request) {
    return this.tasks.create(request);
  }

  executeTool(request) {
    return this.toolRuntime.execute(request);
  }
}
