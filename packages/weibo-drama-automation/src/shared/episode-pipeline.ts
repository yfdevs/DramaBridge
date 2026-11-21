/** Inspect independently of repairs, so slow early episodes cannot block later valid files. */
export async function runWeiboEpisodePipeline<T>(options: {
  episodes: T[];
  signal?: AbortSignal;
  inspect: (episode: T, signal: AbortSignal) => Promise<boolean>;
  repair: (episode: T, signal: AbortSignal) => Promise<void>;
  onReady: (episode: T, signal: AbortSignal) => Promise<void>;
}) {
  const abort = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal;
  const repairs: T[] = [];
  const waiting = new Set<() => void>();
  let cursor = 0;
  let inspected = false;
  let readyTail = Promise.resolve();
  const wake = () => {
    for (const resolve of waiting) resolve();
    waiting.clear();
  };
  signal.addEventListener("abort", wake);
  const guard = async (action: () => Promise<void>) => {
    try {
      await action();
    } catch (error) {
      abort.abort(error);
      wake();
      throw error;
    }
  };
  const emitReady = (episode: T) => {
    const ready = readyTail.then(async () => {
      signal.throwIfAborted();
      await options.onReady(episode, signal);
    });
    // Serialize browser/file-input changes, while allowing other checks and repairs to run.
    readyTail = ready.catch(() => undefined);
    return ready;
  };
  const inspectors = Array.from({ length: Math.min(4, options.episodes.length) }, () =>
    guard(async () => {
      while (cursor < options.episodes.length) {
        signal.throwIfAborted();
        const episode = options.episodes[cursor++];
        if (await options.inspect(episode, signal)) await emitReady(episode);
        else {
          repairs.push(episode);
          wake();
        }
      }
    }),
  );
  const inspections = Promise.allSettled(inspectors)
    .then((results) => {
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    })
    .finally(() => {
      inspected = true;
      wake();
    });
  const workers = Array.from({ length: Math.min(3, options.episodes.length) }, () =>
    guard(async () => {
      while (true) {
        signal.throwIfAborted();
        const episode = repairs.shift();
        if (episode === undefined) {
          if (inspected) return;
          await new Promise<void>((resolve) => {
            waiting.add(resolve);
          });
          continue;
        }
        await options.repair(episode, signal);
        await emitReady(episode);
      }
    }),
  );
  try {
    // Never return while another worker is still converting or changing the page.
    const results = await Promise.allSettled([inspections, ...workers]);
    signal.throwIfAborted();
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  } finally {
    signal.removeEventListener("abort", wake);
  }
}
