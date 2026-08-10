function joinedKeys(value) {
  return Array.isArray(value) ? value.join(";") : "";
}

export function createAgentToolAuditTracer({ audit, resolveRunId = () => null } = {}) {
  if (!audit || typeof audit.recordSafely !== "function") {
    throw new TypeError("Operation audit service is required");
  }
  return (entry) => audit.recordSafely({
    requestId: entry.requestId,
    runId: entry.runId || resolveRunId(entry),
    module: "ai",
    action: "agent.tool.invoke",
    status: entry.success ? "success" : "failed",
    durationMs: entry.durationMs,
    errorStage: entry.success ? null : "tool_runtime",
    errorCode: entry.errorCode,
    metadata: {
      agentName: entry.agent?.name ?? null,
      agentVersion: entry.agent?.version ?? null,
      toolName: entry.tool?.name ?? null,
      toolVersion: entry.tool?.version ?? null,
      access: entry.tool?.access ?? null,
      permission: entry.tool?.permission ?? null,
      inputDigest: entry.inputSummary?.digest ?? null,
      inputBytes: entry.inputSummary?.bytes ?? null,
      inputKeys: joinedKeys(entry.inputSummary?.keys),
      outputDigest: entry.outputSummary?.digest ?? null,
      outputBytes: entry.outputSummary?.bytes ?? null,
      outputKeys: joinedKeys(entry.outputSummary?.keys),
      resultDigest: entry.resultDigest ?? null,
      resultStatus: entry.resultStatus ?? null,
      contextVersion: entry.contextVersion ?? null,
      inputTokens: entry.usage?.inputTokens ?? null,
      outputTokens: entry.usage?.outputTokens ?? null,
      totalTokens: entry.usage?.totalTokens ?? null,
      cacheHitTokens: entry.usage?.cacheHitTokens ?? null,
      cacheMissTokens: entry.usage?.cacheMissTokens ?? null,
    },
  });
}
