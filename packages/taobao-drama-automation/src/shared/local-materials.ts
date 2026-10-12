import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  cleanupEpisodeUploadFiles,
  ensureVideoMinimumDimensions,
  findLocalEpisodeVideos,
  validateLocalEpisodeVideos,
} from "@drama/drama-media-assets";
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
  try {
    const episodes = [];
    for (const sourceEpisode of sourceEpisodes) {
      const convertedFile = path.join(
        uploadDir,
        `${path.basename(sourceEpisode.file, path.extname(sourceEpisode.file))}.taobao.mp4`,
      );
      const result = await ensureVideoMinimumDimensions({
        inputFile: sourceEpisode.file,
        outputFile: convertedFile,
        minimumWidth: TAOBAO_DRAMA_MIN_VIDEO_DIMENSION,
        minimumHeight: TAOBAO_DRAMA_MIN_VIDEO_DIMENSION,
        onLog: (message) => log(options, `[taobao-drama] ${message}`),
      });
      prepared.files.push(result.file);
      episodes.push({
        ...sourceEpisode,
        sourceFile: sourceEpisode.file,
        file: result.file,
      });
    }
    log(
      options,
      `[taobao-drama] 上传前视频校验完成：${episodes.length} 集，` +
        `宽高均至少 ${TAOBAO_DRAMA_MIN_VIDEO_DIMENSION}px`,
    );
    return { episodes, prepared };
  } catch (error) {
    await cleanupEpisodeUploadFiles(prepared);
    throw error;
  }
}

export { cleanupEpisodeUploadFiles };
