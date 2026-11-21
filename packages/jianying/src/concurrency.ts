/** Stop scheduling on the first failure, cancel siblings, and drain active work. */
export async function runConcurrent<T>(items: readonly T[], concurrency: number, signal: AbortSignal | undefined,
  work: (item: T, signal: AbortSignal) => Promise<void>) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 6) throw new Error("并发数必须为 1–6");
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  let next = 0;
  let failed = false;
  let failure: unknown;
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (!controller.signal.aborted && next < items.length) {
        const item = items[next++];
        try { await work(item, controller.signal); }
        catch (error) {
          if (!failed) { failed = true; failure = error; }
          controller.abort();
        }
      }
    }));
    if (failed) throw failure;
    signal?.throwIfAborted();
  } finally { signal?.removeEventListener("abort", abort); }
}
