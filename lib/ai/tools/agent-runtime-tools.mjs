const CONTEXT_RESOLVE_INPUT_SCHEMA = Object.freeze({
  type: "object",
  required: ["context_name", "context_version", "input"],
  additionalProperties: false,
  properties: {
    context_name: { type: "string", minLength: 1, maxLength: 120 },
    context_version: { type: "string", minLength: 1, maxLength: 80 },
    input: { type: "object" },
  },
});

const CONTEXT_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  required: ["contextVersion", "contextType", "subject", "data"],
});

const MESSAGE_SCHEMA = Object.freeze({
  type: "object",
  required: ["role", "content"],
  additionalProperties: false,
  properties: {
    role: { enum: ["system", "user", "assistant"] },
    content: { type: "string", minLength: 1, maxLength: 500_000 },
  },
});

const AI_GATEWAY_INPUT_SCHEMA = Object.freeze({
  type: "object",
  required: [
    "task_id",
    "module_id",
    "operation",
    "request_id",
    "prompt_id",
    "prompt_version",
    "model",
    "temperature",
    "max_tokens",
    "response_format",
    "thinking",
    "output_schema_id",
    "messages",
  ],
  additionalProperties: false,
  properties: {
    task_id: { type: "string", minLength: 1, maxLength: 200 },
    module_id: { type: "string", minLength: 1, maxLength: 120 },
    operation: { type: "string", minLength: 1, maxLength: 120 },
    request_id: { type: "string", minLength: 1, maxLength: 200 },
    prompt_id: { type: "string", minLength: 1, maxLength: 160 },
    prompt_version: { type: "string", minLength: 1, maxLength: 120 },
    model: { type: "string", minLength: 1, maxLength: 120 },
    temperature: { type: "number", minimum: 0, maximum: 2 },
    max_tokens: { type: "integer", minimum: 1, maximum: 32_768 },
    response_format: { type: "object" },
    thinking: { type: "object" },
    output_schema_id: { type: "string", minLength: 1, maxLength: 200 },
    messages: { type: "array", minItems: 1, maxItems: 20, items: MESSAGE_SCHEMA },
  },
});

const AI_GATEWAY_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  required: [
    "success",
    "resultStatus",
    "requestId",
    "provider",
    "model",
    "attempts",
    "durationMs",
  ],
  properties: {
    success: { type: "boolean" },
    resultStatus: { enum: ["succeeded", "failed"] },
    requestId: { type: "string" },
    provider: { type: "string" },
    model: { type: "string" },
    attempts: { type: "integer", minimum: 1 },
    durationMs: { type: "number", minimum: 0 },
  },
});

const TASK_CREATE_INPUT_SCHEMA = Object.freeze({
  type: "object",
  required: ["idempotency_key", "context_refs"],
  additionalProperties: true,
});

const TASK_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  required: ["id", "state", "taskKind"],
});

const TASK_TRANSITION_INPUT_SCHEMA = Object.freeze({
  type: "object",
  required: ["task_id", "to_state", "options"],
  additionalProperties: false,
  properties: {
    task_id: { type: "string", minLength: 1, maxLength: 200 },
    to_state: { type: "string", minLength: 1, maxLength: 40 },
    options: { type: "object" },
  },
});

const LEASE_ACQUIRE_INPUT_SCHEMA = Object.freeze({
  type: "object",
  required: ["task_id", "lease_owner", "ttl_ms"],
  additionalProperties: false,
  properties: {
    task_id: { type: "string", minLength: 1, maxLength: 200 },
    lease_owner: { type: "string", minLength: 1, maxLength: 200 },
    ttl_ms: { type: "integer", minimum: 1_000, maximum: 3_600_000 },
  },
});

const LEASE_ACQUIRE_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  required: ["acquired", "lease"],
  properties: {
    acquired: { type: "boolean" },
    lease: { type: ["object", "null"] },
  },
});

const LEASE_RELEASE_INPUT_SCHEMA = Object.freeze({
  type: "object",
  required: ["task_id", "lease_token"],
  additionalProperties: false,
  properties: {
    task_id: { type: "string", minLength: 1, maxLength: 200 },
    lease_token: { type: "string", minLength: 1, maxLength: 200 },
  },
});

function toolError(message, code) {
  return Object.assign(new Error(message), { code });
}

export function registerAgentRuntimeTools({
  registry,
  contextRegistry,
  gateway,
  resolveOutputValidator,
  createAgentTask,
  transitionAgentTask,
  acquireAgentTaskLease,
  releaseAgentTaskLease,
} = {}) {
  if (!registry || typeof registry.register !== "function") throw new TypeError("Tool Registry is required");
  if (!contextRegistry || typeof contextRegistry.resolve !== "function") throw new TypeError("Context Registry is required");
  if (!gateway || typeof gateway.complete !== "function") throw new TypeError("AI Gateway is required");
  if (typeof resolveOutputValidator !== "function") throw new TypeError("AI output validator resolver is required");
  if (typeof createAgentTask !== "function" || typeof transitionAgentTask !== "function"
    || typeof acquireAgentTaskLease !== "function" || typeof releaseAgentTaskLease !== "function") {
    throw new TypeError("Agent task lifecycle callbacks are required");
  }

  registry.register({
    name: "context.resolve",
    version: "1.0.0",
    description: "Resolve one versioned Context declared by the registered Agent.",
    access: "read",
    permission: "context.resolve",
    database_access: "service_only",
    external_access: "forbidden",
    input_schema: CONTEXT_RESOLVE_INPUT_SCHEMA,
    output_schema: CONTEXT_OUTPUT_SCHEMA,
    execute: async ({ input, agentDefinition }) => {
      const declared = agentDefinition.input_context.find((entry) => (
        entry.type === input.context_name && entry.version === input.context_version
      ));
      if (!declared) {
        throw toolError("Agent did not declare this Context version", "AGENT_CONTEXT_VERSION_FORBIDDEN");
      }
      return contextRegistry.resolve(input.context_name, input.context_version, input.input);
    },
  });

  registry.register({
    name: "ai.gateway.complete",
    version: "1.0.0",
    description: "Call the unified AI Gateway with the Agent's registered output validator.",
    access: "read",
    permission: "ai.gateway.complete",
    database_access: "forbidden",
    external_access: "gateway_only",
    input_schema: AI_GATEWAY_INPUT_SCHEMA,
    output_schema: AI_GATEWAY_OUTPUT_SCHEMA,
    execute: async ({ input, agent, agentDefinition }) => {
      const outputValidator = resolveOutputValidator(agent, input.output_schema_id);
      return gateway.complete({
        moduleId: input.module_id,
        operation: input.operation,
        requestId: input.request_id,
        agent: { name: agent.name, version: agent.version, taskId: input.task_id },
        promptId: input.prompt_id,
        promptVersion: input.prompt_version,
        model: input.model,
        temperature: input.temperature,
        maxTokens: input.max_tokens,
        responseFormat: input.response_format,
        thinking: input.thinking,
        outputValidator,
        messages: input.messages,
        outputSchema: agentDefinition.output_schema,
      });
    },
  });

  registry.register({
    name: "agent.task.create",
    version: "1.0.0",
    description: "Create the current Agent's Foundation execution task.",
    access: "lifecycle",
    permission: "agent.task.lifecycle",
    database_access: "service_only",
    external_access: "forbidden",
    input_schema: TASK_CREATE_INPUT_SCHEMA,
    output_schema: TASK_OUTPUT_SCHEMA,
    execute: ({ input, agent, requestId, requestedBy }) => createAgentTask({
      ...input,
      agent_name: agent.name,
      agent_version: agent.version,
      request_id: requestId,
      requested_by: requestedBy,
    }),
  });

  registry.register({
    name: "agent.task.transition",
    version: "1.0.0",
    description: "Transition a Foundation task owned by the current Agent invocation.",
    access: "lifecycle",
    permission: "agent.task.lifecycle",
    database_access: "service_only",
    external_access: "forbidden",
    input_schema: TASK_TRANSITION_INPUT_SCHEMA,
    output_schema: TASK_OUTPUT_SCHEMA,
    execute: ({ input, agent }) => transitionAgentTask(agent, input.task_id, input.to_state, input.options),
  });

  registry.register({
    name: "agent.task.lease.acquire",
    version: "1.0.0",
    description: "Acquire a bounded execution lease for a task owned by the current Agent.",
    access: "lifecycle",
    permission: "agent.task.lifecycle",
    database_access: "service_only",
    external_access: "forbidden",
    input_schema: LEASE_ACQUIRE_INPUT_SCHEMA,
    output_schema: LEASE_ACQUIRE_OUTPUT_SCHEMA,
    execute: async ({ input, agent }) => {
      const lease = await acquireAgentTaskLease(agent, input.task_id, {
        leaseOwner: input.lease_owner,
        ttlMs: input.ttl_ms,
      });
      return { acquired: Boolean(lease), lease: lease || null };
    },
  });

  registry.register({
    name: "agent.task.lease.release",
    version: "1.0.0",
    description: "Release the current Agent's Foundation task lease.",
    access: "lifecycle",
    permission: "agent.task.lifecycle",
    database_access: "service_only",
    external_access: "forbidden",
    input_schema: LEASE_RELEASE_INPUT_SCHEMA,
    output_schema: {
      type: "object",
      required: ["released"],
      properties: { released: { type: "boolean" } },
    },
    execute: async ({ input, agent }) => ({
      released: Boolean(await releaseAgentTaskLease(agent, input.task_id, input.lease_token)),
    }),
  });

  return registry;
}
