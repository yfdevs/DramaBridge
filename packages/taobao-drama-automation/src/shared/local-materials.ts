import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  cleanupEpisodeUploadFiles,
  ensureVideoMinimumDimensions,
  findLocalEpisodeVideos,
  listLocalPosterImages,
  validateLocalEpisodeVideos,
} from "@dramabridge/media-assets";
import { TAOBAO_DRAMA_MIN_VIDEO_DIMENSION } from "./constants.js";
import { log } from "./logger.js";
import type { TaobaoBatchUploadTask, TaobaoDramaRuntimeOptions } from "./types.js";

export function taobaoMaterialRoot(options: TaobaoDramaRuntimeOptions) {
  const root = options.localMaterialRoot?.trim();
  if (!root) throw new Error("TAOBAO_DRAMA_LOCAL_MATERIAL_ROOT_REQUIRED");
  return root;
}

export async function validateTaobaoEpisodeVideos(
  task: TaobaoBatchUploadTask,
  options: TaobaoDramaRuntimeOptions,
) {
  await validateLocalEpisodeVideos({
    localEpisodeVideoRoot: taobaoMaterialRoot(options),
    resourceName: task.originalTitle,
    episodeCount: task.episodeCount,
  });
}

export function findTaobaoEpisodeVideos(
  task: TaobaoBatchUploadTask,
  options: TaobaoDramaRuntimeOptions,
) {
  return findLocalEpisodeVideos({
    localEpisodeVideoRoot: taobaoMaterialRoot(options),
    resourceName: task.originalTitle,
  });
}

export async function findTaobaoSourcePoster(
  task: TaobaoBatchUploadTask,
  options: TaobaoDramaRuntimeOptions,
) {
  const posters = await listLocalPosterImages({
    root: taobaoMaterialRoot(options),
    resourceName: task.originalTitle,
  });
  return posters[0]?.file;
}

export async function prepareTaobaoEpisodeVideos(
  task: TaobaoBatchUploadTask,
  options: TaobaoDramaRuntimeOptions,
) {
  await validateTaobaoEpisodeVideos(task, options);
  const sourceEpisodes = await findTaobaoEpisodeVideos(task, options);
  const uploadRootDir = path.join(
    options.assetDownloadDir?.trim() || os.tmpdir(),
    "taobao-video-preflight",
  );
  await mkdir(uploadRootDir, { recursive: true });
  const uploadDir = await mkdtemp(path.join(uploadRootDir, "episode-upload-"));
  const prepared = { uploadDir, files: [] as string[] };
  const episodes = sourceEpisodes.map((episode) => ({ ...episode, sourceFile: episode.file }));
  log(options, `[taobao-drama] 视频文件校验完成：${episodes.length} 集，先上传原文件，仅在淘宝明确提示分辨率不符合要求时转换对应剧集`);
  return { episodes, prepared };
}

export async function convertTaobaoEpisodeForResolutionFailure(
  inputFile: string,
  prepared: { uploadDir: string; files: string[] },
  options: TaobaoDramaRuntimeOptions,
) {
  const outputFile = path.join(prepared.uploadDir, `${path.basename(inputFile, path.extname(inputFile))}.mp4`);
  const result = await ensureVideoMinimumDimensions({
    inputFile, outputFile,
    minimumWidth: TAOBAO_DRAMA_MIN_VIDEO_DIMENSION,
    minimumHeight: TAOBAO_DRAMA_MIN_VIDEO_DIMENSION,
    onLog: (message) => log(options, `[taobao-drama] ${message}`),
  });
  if (!result.transcoded) {
    throw new Error(`TAOBAO_DRAMA_VIDEO_RESOLUTION_REPAIR_NOT_POSSIBLE: 淘宝报告视频分辨率不符，但当前文件已达到转换目标，请检查平台要求。文件：${path.basename(inputFile)}，分辨率：${result.source.width}x${result.source.height}`);
  }
  prepared.files.push(result.file);
  return result.file;
}

export { cleanupEpisodeUploadFiles };
