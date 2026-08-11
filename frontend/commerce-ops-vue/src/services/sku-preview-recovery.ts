export async function recoverSkuPreviewWithRetry<T>(
  recover: () => Promise<T>,
  { attempts = 1, delayMs = 3000, sleep = (milliseconds: number) => new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds)) }:
    { attempts?: number; delayMs?: number; sleep?: (milliseconds: number) => Promise<void> } = {},
): Promise<T> {
  const totalAttempts = Math.max(1, Math.trunc(attempts));
  let lastError: unknown;
  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    try { return await recover(); }
    catch (error) { lastError = error; }
    if (attempt < totalAttempts) await sleep(delayMs);
  }
  throw lastError;
}
