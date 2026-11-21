import path from "node:path";
import { stat } from "node:fs/promises";
import {
  cleanupEpisodeUploadFiles,
  ensureVideoMinimumDimensions,
  findLocalEpisodeVideos,
  prepareEpisodeUploadFiles,
  readVideoDimensions,
} from "@dramabridge/media-assets";
import { log } from "./logger.js";
import { runWeiboEpisodePipeline } from "./episode-pipeline.js";
import type { ClaimedWeiboDramaTask, WeiboDramaRuntimeOptions } from "./types.js";

export async function prepareWeiboEpisodeFiles(
  task: ClaimedWeiboDramaTask,
  options: WeiboDramaRuntimeOptions,
  onReady?: (file: string, episodeIndex: number) => Promise<void>,
) {
  const episodes = await findLocalEpisodeVideos({
    localEpisodeVideoRoot: options.localEpisodeVideoRoot!,
    resourceName: task.originalTitle,
  });
  episodes.sort((a, b) => a.index - b.index);
  if (
    episodes.length !== task.playlet.episodeCount ||
    episodes.some((episode, index) => episode.index !== index + 1)
  )
    throw new Error("WEIBO_DRAMA_UPLOAD_FILE_INVALID: 剧集数量或集号不完整，无法开始上传");
  const batches: Awaited<ReturnType<typeof prepareEpisodeUploadFiles>>[] = [];
  const uploadOrderFiles: string[] = [];
  const filesByIndex = new Map<number, string>();
  const cleanup = async () => {
    await Promise.all(batches.map(cleanupEpisodeUploadFiles));
  };
  let completed = 0;
  let converted = 0;
  let reused = 0;
  const outputPath = (file: string) =>
    path.join(
      options.assetDownloadDir!,
      String(task.accountTaskId),
      "episode-1080p",
      path.basename(file),
    );
  const reportProgress = () =>
    log(
      options,
      `[weibo-drama] 视频准备进度：${completed}/${episodes.length}集可上传，已转换${converted}集，复用${reused}集1080p副本`,
      { accountTaskId: task.accountTaskId },
    );
  reportProgress();
  try {
    await runWeiboEpisodePipeline({
      episodes,
      signal: options.signal,
      inspect: async (episode, signal) => {
        const dimensions = await readVideoDimensions(episode.file, signal);
        if (Math.min(dimensions.width, dimensions.height) >= 1080) return true;
        const outputFile = outputPath(episode.file);
        const sourceStat = await stat(episode.file);
        const cachedStat = await stat(outputFile).catch(() => undefined);
        if (
          cachedStat?.isFile() &&
          cachedStat.size > 0 &&
          cachedStat.mtimeMs >= sourceStat.mtimeMs
        ) {
          const cachedDimensions = await readVideoDimensions(outputFile, signal).catch(
            () => undefined,
          );
          signal.throwIfAborted();
          if (
            cachedDimensions &&
            Math.min(cachedDimensions.width, cachedDimensions.height) >= 1080
          ) {
            episode.file = outputFile;
            reused++;
            return true;
          }
        }
        log(
          options,
          `[weibo-drama] 第${episode.index}集 ${dimensions.width}×${dimensions.height} 低于微博要求，加入后台转码队列，其他合格剧集继续上传`,
        );
        return false;
      },
      repair: async (episode, signal) => {
        const prepared = await ensureVideoMinimumDimensions({
          inputFile: episode.file,
          outputFile: outputPath(episode.file),
          minimumWidth: 1080,
          minimumHeight: 1080,
          signal,
          onLog: (message) => log(options, `[weibo-drama] ${message}`),
        });
        episode.file = prepared.file;
        converted++;
      },
      onReady: async (episode, signal) => {
        signal.throwIfAborted();
        const prepared = await prepareEpisodeUploadFiles({
          localEpisodeVideoRoot: options.localEpisodeVideoRoot!,
          resourceName: task.originalTitle,
          uploadRootDir: options.assetDownloadDir!,
          uploadBaseName: task.playlet.title,
          episodes: [episode],
        });
        batches.push(prepared);
        const file = prepared.files[0];
        signal.throwIfAborted();
        if (onReady) await onReady(file, episode.index);
        uploadOrderFiles.push(file);
        filesByIndex.set(episode.index, file);
        completed++;
        reportProgress();
      },
    });
    return {
      files: episodes.map((episode) => filesByIndex.get(episode.index)!),
      uploadOrderFiles,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
