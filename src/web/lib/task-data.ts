/** One request at a time. Disposal aborts I/O and suppresses late results. */
export function createTaskPoller<T>(options: {
  load: (signal: AbortSignal) => Promise<T>;
  receive: (value: T) => void;
  failed?: (error: unknown) => void;
  delay: (value: T | undefined) => number | null;
  schedule?: (job: () => void, ms: number) => () => void;
}) {
  const schedule = options.schedule ?? ((job, ms) => { const timer = setTimeout(job, ms); return () => clearTimeout(timer); });
  let stopped = false;
  let pending = false;
  let inFlight = false;
  let controller: AbortController | undefined;
  let cancelTimer: (() => void) | undefined;
  let value: T | undefined;
  async function run() {
    if (stopped || inFlight) return;
    cancelTimer?.(); cancelTimer = undefined;
    inFlight = true;
    controller = new AbortController();
    try {
      const next = await options.load(controller.signal);
      if (!stopped) { value = next; options.receive(next); }
    } catch (error) {
      if (!stopped) options.failed?.(error);
    } finally {
      inFlight = false;
      if (!stopped) {
        if (pending) { pending = false; void run(); }
        else { const ms = options.delay(value); if (ms !== null) cancelTimer = schedule(() => void run(), ms); }
      }
    }
  }
  void run();
  return {
    refresh() { if (stopped) return; if (inFlight) pending = true; else void run(); },
    stop() { stopped = true; pending = false; cancelTimer?.(); controller?.abort(); },
  };
}

export async function readTaskJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(typeof body.error === 'string' ? body.error : `HTTP ${response.status}`);
  }
  return response.json();
}
