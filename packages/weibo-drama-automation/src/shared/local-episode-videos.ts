import { validateLocalEpisodeVideos as validateSharedLocalEpisodeVideos } from "@dramabridge/media-assets";
import type { ClaimedWeiboDramaTask, WeiboDramaRuntimeOptions } from "./types.js";

export function getWeiboDramaOriginalTitle(task: ClaimedWeiboDramaTask) {
  const originalTitle = task.originalTitle.trim();
  if (!originalTitle) {
    throw new Error("originalTitle is required for local episode videos.");
  }
  return originalTitle;
}

export function getWeiboDramaLocalEpisodeVideoRoot(options: WeiboDramaRuntimeOptions) {
  const localEpisodeVideoRoot = options.localEpisodeVideoRoot?.trim();
  if (!localEpisodeVideoRoot) {
    throw new Error("请先配置 微博 短剧本地剧集视频目录");
  }
  return localEpisodeVideoRoot;
}

export async function validateWeiboDramaLocalEpisodeVideos(
  task: ClaimedWeiboDramaTask,
  options: WeiboDramaRuntimeOptions,
) {
  const episodeCount = task.playlet.episodeCount;
  if (!episodeCount) return;

  await validateSharedLocalEpisodeVideos({
    localEpisodeVideoRoot: getWeiboDramaLocalEpisodeVideoRoot(options),
    resourceName: getWeiboDramaOriginalTitle(task),
    episodeCount,
  });
}
