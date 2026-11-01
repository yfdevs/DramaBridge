import { rm } from "node:fs/promises";
import path from "node:path";

/** Callers must validate downloadDir as a dedicated disposable download directory. */
export async function resetLocalResourceForRedownload(options: {
  localRoot: string;
  resourceName: string;
  downloadDir: string;
  cancelDownloads: () => Promise<void>;
}) {
  const root = path.resolve(options.localRoot);
  const target = path.resolve(root, options.resourceName);
  const downloadDir = path.resolve(options.downloadDir);
  // Validate every target before cancelling tasks or deleting any files.
  if (
    !options.resourceName.trim()
    || /[\\/]/.test(options.resourceName)
    || target === root
    || path.dirname(target).toLowerCase() !== root.toLowerCase()
    || downloadDir === root
    || root.startsWith(`${downloadDir}${path.sep}`)
    || downloadDir === path.parse(downloadDir).root
  ) {
    throw new Error(`拒绝清理不安全的重新下载目录：${target}`);
  }
  // Confirm native writers have stopped before removing either directory.
  await options.cancelDownloads();
  await rm(downloadDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
  await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
}
