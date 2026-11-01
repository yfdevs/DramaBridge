import { runUploadJobs } from "./upload-scheduler.js";

export const UPLOAD_PART_CONCURRENCY = 4;

/** Warm up the chosen server once, then transfer independent indexed parts.
 * A failed part cancels peers and waits for their promises before the caller
 * can close the file handle or consider committing the upload session.
 */
export async function uploadBaiduParts(
  indexes: readonly number[],
  upload: (index: number, signal: AbortSignal) => Promise<void>,
  signal?: AbortSignal,
  options: { warmup?: boolean } = {},
) {
  return runUploadJobs(indexes, upload, UPLOAD_PART_CONCURRENCY, signal, options.warmup !== false);
}
