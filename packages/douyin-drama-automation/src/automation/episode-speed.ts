import { stat } from "node:fs/promises";
import path from "node:path";
import {
  adjustVideoPlaybackSpeed,
  readVideoDurationSeconds,
  type AdjustedVideoPlaybackSpeed,
} from "@dramabridge/media-assets";

export type PreparedDouyinEpisodeSpeed = {
  file: string;
  sourceDurationSeconds: number;
  adjusted?: AdjustedVideoPlaybackSpeed;
};

async function readEpisodeDurationWithSourceFallback(options: {
  file: string;
  sourceFile: string;
  signal?: AbortSignal;
  readDuration: typeof readVideoDurationSeconds;
  onLog?: (message: string) => void;
}) {
  try {
    return await options.readDuration(options.file, options.signal);
  } catch (temporaryFileError) {
    if (path.resolve(options.file) === path.resolve(options.sourceFile)) throw temporaryFileError;
    options.onLog?.(
      `[douyin-drama] 临时上传文件时长读取失败，改用原始视频复核：${options.sourceFile}`,
    );
    try {
      return await options.readDuration(options.sourceFile, options.signal);
    } catch (sourceFileError) {
      if (sourceFileError === temporaryFileError) throw sourceFileError;
      const temporaryMessage = temporaryFileError instanceof Error
        ? temporaryFileError.message
        : String(temporaryFileError);
      const sourceMessage = sourceFileError instanceof Error
        ? sourceFileError.message
        : String(sourceFileError);
      throw Object.assign(
        new Error(`${sourceMessage}; temporary-file-probe=${temporaryMessage}`),
        { cause: sourceFileError },
      );
    }
  }
}

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
    sourceFiles?: string[];
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
      const sourceFile = options.sourceFiles?.[position] ?? file;
      let sourceDurationSeconds: number;
      try {
        sourceDurationSeconds = await readEpisodeDurationWithSourceFallback({
          file,
          sourceFile,
          signal: options.signal,
          readDuration,
          onLog: options.onLog,
        });
      } catch (error) {
        const fileStat = await stat(sourceFile).catch(() => undefined);
        const rawMessage = error instanceof Error ? error.message : String(error);
        const reason = /moov atom not found/iu.test(rawMessage)
          ? "moov-atom-not-found"
          : /invalid data found when processing input/iu.test(rawMessage)
            ? "invalid-media-data"
            : "duration-read-failed";
        const episode = path.basename(file).match(/第\s*(\d+)\s*集/u)?.[1] ?? String(position + 1);
        throw Object.assign(
          new Error(
            `DOUYIN_DRAMA_EPISODE_VIDEO_INVALID: episode=${episode}; `
              + `file=${JSON.stringify(path.basename(file))}; `
              + `source=${JSON.stringify(sourceFile)}; sizeBytes=${fileStat?.size ?? "unknown"}; `
              + `reason=${reason}`,
          ),
          { cause: error },
        );
      }
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
