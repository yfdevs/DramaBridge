type CacheEntry<T> = {
  expiresAt: number;
  value: T;
};

export function createAsyncCache<T>(loader: () => Promise<T>, ttlMs: number) {
  let cached: CacheEntry<T> | undefined;
  let pending: Promise<T> | undefined;

  return async function readCachedValue() {
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached.value;
    if (pending) return pending;

    pending = loader().then((value) => {
      cached = { value, expiresAt: Date.now() + ttlMs };
      return value;
    });

    try {
      return await pending;
    } finally {
      pending = undefined;
    }
  };
}
