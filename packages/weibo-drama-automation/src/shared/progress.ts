import { errorLog, log } from "./logger.js";
import type { WeiboDramaRuntimeOptions } from "./types.js";

export async function withWeiboProgress<T>(
  options: WeiboDramaRuntimeOptions,
  stage: string,
  action: () => Promise<T>,
  fields: Record<string, unknown> = {},
) {
  const startedAt = Date.now();
  log(options, `[weibo-drama] ${stage}：开始`, fields);
  const timer = setInterval(
    () =>
      log(
        options,
        `[weibo-drama] ${stage}：仍在执行，已等待${Math.floor((Date.now() - startedAt) / 1_000)}秒`,
        fields,
      ),
    15_000,
  );
  timer.unref();
  try {
    const result = await action();
    log(options, `[weibo-drama] ${stage}：完成`, { ...fields, durationMs: Date.now() - startedAt });
    return result;
  } catch (error) {
    errorLog(options, `[weibo-drama] ${stage}：失败`, {
      ...fields,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    clearInterval(timer);
  }
}
