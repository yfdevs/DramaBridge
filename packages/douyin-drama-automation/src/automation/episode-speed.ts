import {
  adjustVideoPlaybackSpeed,
  readVideoDurationSeconds,
  type AdjustedVideoPlaybackSpeed,
} from "@drama/drama-media-assets";

export type PreparedDouyinEpisodeSpeed = {
  file: string;
  sourceDurationSeconds: number;
  adjusted?: AdjustedVideoPlaybackSpeed;
};

export async function prepareShortDouyinEpisodeVideos(
  files: string[],
  options: {
    thresholdSeconds?: number;
    speed?: number;
    concurrency?: number;
    signal?: AbortSignal;
    onLog?: (message: string) => void;
    readDuration?: typeof readVideoDurationSeconds;
    adjustSpeed?: typeof adjustVideoPlaybackSpeed;
  } = {},
) {
  const thresholdSeconds = options.thresholdSeconds ?? 30;
  const speed = options.speed ?? 0.9;
  const readDuration = options.readDuration ?? readVideoDurationSeconds;
  const adjustSpeed = options.adjustSpeed ?? adjustVideoPlaybackSpeed;
  const results = new Array<PreparedDouyinEpisodeSpeed>(files.length);
  const concurrency = Math.min(files.length, Math.max(1, Math.floor(options.concurrency ?? 2)));
  let cursor = 0;

  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < files.length) {
      options.signal?.throwIfAborted();
      const position = cursor;
      cursor += 1;
      const file = files[position];
      const sourceDurationSeconds = await readDuration(file, options.signal);
      if (sourceDurationSeconds > thresholdSeconds) {
        results[position] = { file, sourceDurationSeconds };
        continue;
      }
      options.onLog?.(
        `[douyin-drama] 检测到短视频，上传前执行 FFmpeg ${speed} 倍速处理：`
          + `${file} duration=${sourceDurationSeconds.toFixed(2)}s`,
      );
      results[position] = {
        file,
        sourceDurationSeconds,
        adjusted: await adjustSpeed({
          inputFile: file,
          speed,
          sourceDurationSeconds,
          signal: options.signal,
          onLog: options.onLog,
        }),
      };
    }
  }));
  return results;
}
