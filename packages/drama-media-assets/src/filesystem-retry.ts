import { rm } from "node:fs/promises";

export type FileSystemRetryOptions = {
  maximumAttempts?: number;
  initialDelayMs?: number;
  maximumDelayMs?: number;
};

const transientWindowsFileSystemCodes = new Set([
  "EACCES",
  "EBUSY",
  "EMFILE",
  "ENFILE",
  "ENOTEMPTY",
  "EPERM",
]);

export function isTransientFileSystemError(error: unknown) {
  return transientWindowsFileSystemCodes.has((error as NodeJS.ErrnoException)?.code ?? "");
}

export async function retryFileSystemOperation<T>(
  operation: () => Promise<T>,
  options: FileSystemRetryOptions = {},
): Promise<T> {
  const maximumAttempts = Math.max(1, Math.trunc(options.maximumAttempts ?? 7));
  const initialDelayMs = Math.max(0, Math.trunc(options.initialDelayMs ?? 100));
  const maximumDelayMs = Math.max(initialDelayMs, Math.trunc(options.maximumDelayMs ?? 1_500));

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransientFileSystemError(error) || attempt >= maximumAttempts) throw error;
      const delayMs = Math.min(maximumDelayMs, initialDelayMs * 2 ** (attempt - 1));
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

export function removePathWithRetry(
  targetPath: string,
  options: Parameters<typeof rm>[1] = { force: true },
  retryOptions?: FileSystemRetryOptions,
) {
  return retryFileSystemOperation(() => rm(targetPath, options), retryOptions);
}
