import { AgentRegistry } from "./agent-registry.mjs";
import { AgentFramework } from "./agent-framework.mjs";
import { AgentOperationTaskService } from "./agent-operation-task-service.mjs";
import { createCommerceOpsToolRegistry } from "../tools/commerce-ops-tools.mjs";
import { registerAgentRuntimeTools } from "../tools/agent-runtime-tools.mjs";
import { AgentObservabilityService } from "../observability/agent-observability-service.mjs";

const AUTHORIZED_SCOPES = new WeakSet();
const FORBIDDEN_DEPENDENCY_KEY = /(?:repository|service|database|provider|gateway|http|client|file[_-]?system|filesystem|(?:^|[_-])fs(?:$|[_-]))/i;

function runtimeError(message, code) {
  return Object.assign(new Error(message), { code });
}

export function assertAgentRuntimeScope(value) {
  if (!value || !AUTHORIZED_SCOPES.has(value)) {
    throw runtimeError(
      "Agent must be created by the production Agent Runtime",
      "AGENT_RUNTIME_SCOPE_REQUIRED",
    );
  }
  return value;
}

function cloneConfig(value, path = "options") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return Object.freeze(value.map((item, index) => cloneConfig(item, `${path}[${index}]`)));
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw runtimeError("Agent options must contain only plain JSON values", "AGENT_RUNTIME_OPTIONS_INVALID");
  }
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "runtime" || FORBIDDEN_DEPENDENCY_KEY.test(key)) {
      throw runtimeError(
        `Agent option ${path}.${key} cannot inject an infrastructure dependency`,
        "AGENT_RUNTIME_DEPENDENCY_FORBIDDEN",
      );
    }
    output[key] = cloneConfig(child, `${path}.${key}`);
  }
  return Object.freeze(output);
}

export class AgentRuntime {
  #framework;
  #registry;
  #contextRegistry;
  #toolRegistry;
  #gateway;
  #taskService;
  #auditService;
  #observability;
  #clock;
  #agents = new Map();
  #ownedTasks = new Map();
  #outputValidators = new Map();

  constructor({
    taskService,
    registry = new AgentRegistry(),
    contextRegistry,
    toolRegistry,
    gateway,
    auditService,
    clock = () => new Date(),
  } = {}) {
    if (!taskService || typeof taskService.create !== "function"
      || typeof taskService.transition !== "function"
      || typeof taskService.acquireLease !== "function"
      || typeof taskService.releaseLease !== "function") {
      throw new TypeError("Foundation task lifecycle service is required");
    }
    if (!registry || typeof registry.register !== "function" || typeof registry.require !== "function") {
      throw new TypeError("Agent Registry is required");
    }
    if (!contextRegistry || typeof contextRegistry.require !== "function"
      || typeof contextRegistry.resolve !== "function") {
      throw new TypeError("Context Registry is required");
    }
    if (!toolRegistry || typeof toolRegistry.register !== "function"
      || typeof toolRegistry.require !== "function" || typeof toolRegistry.execute !== "function") {
      throw new TypeError("Tool Registry is required");
    }
    if (!gateway || typeof gateway.complete !== "function") throw new TypeError("AI Gateway is required");
    if (!auditService || typeof auditService.recordSafely !== "function") {
      throw new TypeError("Audit Service is required");
    }
    if (typeof clock !== "function") throw new TypeError("Agent Runtime clock is required");
    this.#registry = registry;
    this.#contextRegistry = contextRegistry;
    this.#toolRegistry = toolRegistry;
    this.#gateway = gateway;
    this.#taskService = taskService;
    this.#auditService = auditService;
    this.#observability = new AgentObservabilityService({ audit: auditService, now: clock });
    this.#clock = clock;
    const operationTasks = new AgentOperationTaskService({ registry, taskService });
    createCommerceOpsToolRegistry({
      registry: toolRegistry,
      contextRegistry,
      createOperationTask: (input) => operationTasks.create(input),
    });
    registerAgentRuntimeTools({
      registry: toolRegistry,
      contextRegistry,
      gateway,
      resolveOutputValidator: (agent, schemaId) => this.#resolveOutputValidator(agent, schemaId),
      createAgentTask: async (input) => {
        const task = await this.#framework.createTask(input);
        this.#ownedTaskSet(input.agent_name, input.agent_version).add(task.id);
        return task;
      },
      transitionAgentTask: (agent, taskId, state, options) => {
        this.#requireOwnedTask(agent, taskId);
        return this.#taskService.transition(taskId, state, options);
      },
      acquireAgentTaskLease: (agent, taskId, options) => {
        this.#requireOwnedTask(agent, taskId);
        return this.#taskService.acquireLease(taskId, options);
      },
      releaseAgentTaskLease: (agent, taskId, leaseToken) => {
        this.#requireOwnedTask(agent, taskId);
        return this.#taskService.releaseLease(taskId, leaseToken);
      },
    });
    this.#framework = new AgentFramework({
      taskService,
      registry,
      toolRegistry,
      toolTrace: (entry) => this.#observability.recordToolInvocation(entry),
    });
  }

  #agentKey(name, version) {
    return `${name}@${version}`;
  }

  #ownedTaskSet(name, version) {
    const key = this.#agentKey(name, version);
    if (!this.#ownedTasks.has(key)) this.#ownedTasks.set(key, new Set());
    return this.#ownedTasks.get(key);
  }

  #requireOwnedTask(agent, taskId) {
    if (!this.#ownedTaskSet(agent.name, agent.version).has(String(taskId || ""))) {
      throw runtimeError("Agent cannot access a task outside its runtime scope", "AGENT_TASK_FORBIDDEN");
    }
  }

  #resolveOutputValidator(agent, schemaId) {
    const key = this.#agentKey(agent.name, agent.version);
    const registered = this.#outputValidators.get(key);
    if (!registered || registered.schemaId !== schemaId) {
      throw runtimeError("Agent output validator is not registered", "AGENT_OUTPUT_VALIDATOR_NOT_REGISTERED");
    }
    return registered;
  }

  createAgent({ definition, Agent, options = {}, outputValidator = null } = {}) {
    if (typeof Agent !== "function") throw new TypeError("Agent class is required");
    const config = cloneConfig(options);
    const registered = this.#framework.register(definition);
    const key = this.#agentKey(registered.name, registered.version);
    if (this.#agents.has(key)) {
      throw runtimeError(`Agent ${key} is already created`, "AGENT_RUNTIME_DUPLICATE");
    }
    for (const context of registered.input_context) {
      this.#contextRegistry.require(context.type, context.version);
    }
    for (const declaredTool of registered.tools) {
      const tool = this.#toolRegistry.require(declaredTool.name, declaredTool.version).definition;
      if (tool.access !== declaredTool.access || tool.permission !== declaredTool.permission) {
        throw runtimeError("Agent Tool contract does not match the Runtime registry", "AGENT_TOOL_PERMISSION_MISMATCH");
      }
    }
    if (registered.tools.some((tool) => tool.name === "ai.gateway.complete")) {
      const expectedSchemaId = `${registered.output_schema.id}@${registered.output_schema.version}`;
      if (!outputValidator || typeof outputValidator.validate !== "function"
        || outputValidator.schemaId !== expectedSchemaId) {
        throw runtimeError("Agent requires its registered output validator", "AGENT_OUTPUT_VALIDATOR_REQUIRED");
      }
      this.#outputValidators.set(key, outputValidator);
    }
    this.#ownedTaskSet(registered.name, registered.version);
    const scope = {
      definition: registered,
      executeTool: (request = {}) => {
        const declaredTool = registered.tools.find((tool) => tool.name === request.tool_name);
        return this.#framework.executeTool({
          ...request,
          tool_version: request.tool_version || declaredTool?.version,
          agent_name: registered.name,
          agent_version: registered.version,
        });
      },
      resolveContext: (request = {}) => {
        const declaredTool = registered.tools.find((tool) => tool.name === "context.resolve");
        return this.#framework.executeTool({
          request_id: request.request_id,
          requested_by: request.requested_by,
          tool_name: "context.resolve",
          tool_version: declaredTool?.version,
          agent_name: registered.name,
          agent_version: registered.version,
          input: {
            context_name: request.context_name,
            context_version: request.context_version,
            input: request.input || {},
          },
        });
      },
      now: () => {
        const value = this.#clock();
        const instant = value instanceof Date ? new Date(value.getTime()) : new Date(value);
        if (Number.isNaN(instant.getTime())) {
          throw runtimeError("Agent Runtime clock returned an invalid time", "AGENT_RUNTIME_CLOCK_INVALID");
        }
        return instant;
      },
    };
    AUTHORIZED_SCOPES.add(scope);
    Object.freeze(scope);
    const agent = new Agent({ ...config, runtime: scope });
    if (!agent || typeof agent.run !== "function") {
      throw new TypeError("Agent factory must return a runnable Agent");
    }
    const run = agent.run.bind(agent);
    const observability = this.#observability;
    const observed = new Proxy(agent, {
      get(target, property) {
        if (property === "run") {
          return async (...args) => {
            const observation = await observability.beginRun(
              { name: registered.name, version: registered.version },
              registered,
              args,
            );
            try {
              const result = await run(...args);
              await observability.completeRun(observation, result);
              return result;
            } catch (error) {
              await observability.failRun(observation, error);
              throw error;
            }
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    this.#agents.set(key, observed);
    return observed;
  }

  get(name, version = "1.0.0") {
    return this.#framework.get(name, version);
  }

  list() {
    return this.#framework.list();
  }
}
