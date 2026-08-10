export function createAiAuditLogger({ audit, action = "ai.gateway.complete" } = {}) {
  if (!audit || typeof audit.recordSafely !== "function") throw new TypeError("Operation audit service is required");
  return (entry) => audit.recordSafely({
    requestId: entry.requestId,
    module: "ai",
    action,
    status: entry.success ? "success" : "failed",
    durationMs: entry.durationMs,
    errorStage: entry.success ? null : entry.outputValid === false ? "output_validation" : "provider",
    errorCode: entry.errorCode,
    metadata: {
      provider: entry.provider,
      agentName: entry.agent?.name ?? null,
      agentVersion: entry.agent?.version ?? null,
      agentTaskId: entry.agent?.taskId ?? null,
      moduleId: entry.moduleId,
      operation: entry.operation,
      model: entry.model,
      promptId: entry.promptId,
      promptVersion: entry.promptVersion,
      promptManaged: entry.promptManaged,
      attempts: entry.attempts,
      inputTokens: entry.usage?.inputTokens ?? null,
      outputTokens: entry.usage?.outputTokens ?? null,
      totalTokens: entry.usage?.totalTokens ?? null,
      cacheHitTokens: entry.usage?.cacheHitTokens ?? null,
      outputSchemaId: entry.outputSchemaId,
      outputValid: entry.outputValid,
      resultDigest: entry.resultDigest ?? null,
      resultStatus: entry.resultStatus || (entry.success ? "succeeded" : "failed"),
    },
  });
}
