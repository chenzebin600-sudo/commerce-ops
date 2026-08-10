export const DAILY_REPORT_CONTEXT_REGISTRY_VERSION = "2.1.0";

const DAILY_CONTEXT_INPUT_SCHEMA = Object.freeze({
  type: "object",
  required: ["evidence_pack", "generated_at"],
  additionalProperties: false,
  properties: {
    evidence_pack: { type: "object" },
    generated_at: { type: "string", minLength: 20, maxLength: 40 },
  },
});

export function registerDailyReportContext({ registry, contextService } = {}) {
  if (!registry || typeof registry.register !== "function") {
    throw new TypeError("Context Registry is required");
  }
  if (!contextService || typeof contextService.create !== "function") {
    throw new TypeError("Daily Report Context service is required");
  }
  return registry.register({
    type: "daily_report",
    version: DAILY_REPORT_CONTEXT_REGISTRY_VERSION,
    description: "Validated deterministic Daily Report Evidence Pack prepared before Agent Runtime.",
    inputSchema: DAILY_CONTEXT_INPUT_SCHEMA,
    resolve: (input) => contextService.create({
      evidencePack: input.evidence_pack,
      generatedAt: new Date(input.generated_at),
    }),
  });
}
