import { AgentRegistry } from "./agent-registry.mjs";
import { AgentTaskBridge } from "./agent-task-bridge.mjs";

export class AgentFramework {
  constructor({ taskService, registry = new AgentRegistry() }) {
    this.registry = registry;
    this.tasks = new AgentTaskBridge({ registry, taskService });
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
}
