export const UPLOAD_FILE_CONCURRENCY = 2;

/** Bounded work that stops scheduling on first failure and drains all peers. */
export async function runUploadJobs<T>(
  items: readonly T[],
  run: (item: T, signal: AbortSignal) => Promise<void>,
  concurrency: number,
  signal?: AbortSignal,
  warmupFirst = false,
) {
  signal?.throwIfAborted();
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("无效的上传并发数");
  if (!items.length) return;
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  let next = 0,
    failed = false;
  let failure: unknown;
  try {
    if (warmupFirst) await run(items[next++], controller.signal);
    const worker = async () => {
      while (!controller.signal.aborted && next < items.length) {
        const item = items[next++];
        try {
          await run(item, controller.signal);
        } catch (error) {
          if (!failed) {
            failed = true;
            failure = error;
          }
          controller.abort(error);
          return;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length - next) }, worker));
    if (failed) throw failure;
    controller.signal.throwIfAborted();
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
