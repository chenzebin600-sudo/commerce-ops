type TimerHandle = ReturnType<typeof setTimeout>;

interface FulfillmentConnectionRecoveryOptions {
  probe: () => Promise<unknown>;
  onRecovered: () => void;
  intervalMs?: number;
  schedule?: (callback: () => void, delayMs: number) => TimerHandle;
  cancel?: (handle: TimerHandle) => void;
}

export function createFulfillmentConnectionRecovery({
  probe,
  onRecovered,
  intervalMs = 2_000,
  schedule = (callback, delayMs) => setTimeout(callback, delayMs),
  cancel = (handle) => clearTimeout(handle),
}: FulfillmentConnectionRecoveryOptions) {
  let active = false;
  let timer: TimerHandle | undefined;

  const queue = (delayMs: number) => {
    timer = schedule(() => { void check(); }, delayMs);
  };
  const check = async () => {
    if (!active) return;
    try {
      await probe();
      if (!active) return;
      active = false;
      timer = undefined;
      onRecovered();
    } catch {
      if (active) queue(intervalMs);
    }
  };

  return {
    start() {
      if (active) return;
      active = true;
      queue(0);
    },
    stop() {
      active = false;
      if (timer !== undefined) cancel(timer);
      timer = undefined;
    },
  };
}
