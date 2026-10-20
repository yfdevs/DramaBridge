import { validateLocalEpisodeVideos as validateSharedLocalEpisodeVideos } from "@dramabridge/media-assets";
import type { ClaimedQqDramaTask, QqDramaRuntimeOptions } from "./types.js";

export function getQqDramaOriginalTitle(task: ClaimedQqDramaTask) {
  const originalTitle = task.originalTitle.trim();
  if (!originalTitle) {
    throw new Error("originalTitle is required for local episode videos.");
  }
  return originalTitle;
}

export function getQqDramaLocalEpisodeVideoRoot(options: QqDramaRuntimeOptions) {
  const localEpisodeVideoRoot = options.localEpisodeVideoRoot?.trim();
  if (!localEpisodeVideoRoot) {
    throw new Error("请先配置 QQ 短剧本地剧集视频目录。");
  }
  return localEpisodeVideoRoot;
}

export async function validateQqDramaLocalEpisodeVideos(
  task: ClaimedQqDramaTask,
  options: QqDramaRuntimeOptions,
) {
  const episodeCount = task.playlet.episodeCount;
  if (!episodeCount) return;

  await validateSharedLocalEpisodeVideos({
    localEpisodeVideoRoot: getQqDramaLocalEpisodeVideoRoot(options),
    resourceName: getQqDramaOriginalTitle(task),
    episodeCount,
  });
}
