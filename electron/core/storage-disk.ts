import { statfs } from "node:fs/promises";
import path from "node:path";

export async function readStorageDiskStatus(directory: string) {
  let existingPath = path.resolve(directory);
  while (true) {
    try {
      const stats = await statfs(existingPath);
      const totalBytes = stats.blocks * stats.bsize;
      const usedBytes = (stats.blocks - stats.bfree) * stats.bsize;
      return {
        directory,
        totalBytes,
        usedBytes,
        availableBytes: stats.bavail * stats.bsize,
        usedPercent: totalBytes > 0 ? usedBytes / totalBytes * 100 : 0,
      };
    } catch (error) {
      // Default directories may not exist until the first download.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
      const parent = path.dirname(existingPath);
      if (parent === existingPath) return null;
      existingPath = parent;
    }
  }
}
