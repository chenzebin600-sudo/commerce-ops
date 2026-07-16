export const DEFAULT_AI_TIMEOUT_MS = 120_000;
export const DEFAULT_AI_MAX_ATTEMPTS = 1;

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isInteger(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
}

export function resolveAiRequestPolicy(input = {}) {
  return Object.freeze({
    timeoutMs: boundedInteger(input.timeoutMs, DEFAULT_AI_TIMEOUT_MS, 1_000, 10 * 60_000),
    maxAttempts: boundedInteger(input.maxAttempts, DEFAULT_AI_MAX_ATTEMPTS, 1, 3),
    retryDelayMs: boundedInteger(input.retryDelayMs, 250, 0, 5_000),
  });
}
