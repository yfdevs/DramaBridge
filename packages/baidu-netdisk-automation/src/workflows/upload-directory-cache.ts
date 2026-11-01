import path from "node:path";
import type { RemoteUploadEntry } from "./upload-directory-plan.js";

/** Scoped to one upload. Mutations invalidate ancestors and descendants before reuse. */
export function createUploadDirectoryCache(load: (directory: string) => Promise<RemoteUploadEntry[]>) {
  const entries = new Map<string, Promise<RemoteUploadEntry[]>>();
  return {
    async list(directory: string, refresh = false) {
      if (refresh) entries.delete(directory);
      let pending = entries.get(directory);
      if (!pending) {
        pending = load(directory);
        entries.set(directory, pending);
      }
      try { return await pending; }
      catch (error) {
        if (entries.get(directory) === pending) entries.delete(directory);
        throw error;
      }
    },
    invalidate(target: string) {
      entries.delete(path.posix.dirname(target));
      for (const directory of entries.keys()) {
        if (directory === target || directory.startsWith(target + "/")) entries.delete(directory);
      }
    },
    async remember(file: RemoteUploadEntry) {
      const directory = path.posix.dirname(file.path);
      const existing = entries.get(directory);
      if (!existing) return;
      // Publish the chained update before awaiting, so concurrent file commits
      // cannot replace one another with snapshots of the same old listing.
      const updated = existing.then(files => [...files.filter(entry => entry.path !== file.path), file]);
      entries.set(directory, updated);
      try { await updated; }
      catch (error) { if (entries.get(directory) === updated) entries.delete(directory); throw error; }
    },
  };
}
