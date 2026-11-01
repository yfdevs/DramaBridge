/** Serialized into the client page; keep this function independent of module scope.
 * Entries are scoped to one download operation, never shared between accounts.
 */
export function createBaiduDirectoryCache<T>(load: (key: string) => Promise<T>) {
  const entries = new Map<string, Promise<T>>();
  return {
    get(key: string, refresh = false): Promise<T> {
      if (refresh) entries.delete(key);
      const cached = entries.get(key);
      if (cached) return cached;
      // Cache the pending read too, so parallel users do not duplicate requests.
      const pending = Promise.resolve().then(() => load(key));
      entries.set(key, pending);
      void pending.catch(() => {
        // A stale read must not evict the fresh read started after a mutation.
        if (entries.get(key) === pending) entries.delete(key);
      });
      return pending;
    },
    invalidate(key?: string) {
      if (key === undefined) entries.clear();
      else entries.delete(key);
    },
  };
}
