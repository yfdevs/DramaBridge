import {
  findLocalEpisodeVideos as findSharedLocalEpisodeVideos,
  validateLocalEpisodeVideos as validateSharedLocalEpisodeVideos,
  type LocalEpisodeVideo,
} from "@dramabridge/media-assets";
import type {
  ClaimedMeituanDramaTask,
  MeituanCreationRuntimeOptions,
} from "./types.js";

export type MeituanCreationLocalEpisodeVideo = LocalEpisodeVideo;

export function getMeituanOriginalTitle(task: ClaimedMeituanDramaTask) {
  const originalTitle = task.originalTitle.trim();
  if (!originalTitle) {
    throw new Error("originalTitle is required for local episode videos.");
  }
  return originalTitle;
}

export function getMeituanLocalEpisodeVideoRoot(
  options: MeituanCreationRuntimeOptions,
) {
  const localEpisodeVideoRoot = options.config?.localEpisodeVideoRoot?.trim();
  if (!localEpisodeVideoRoot) {
    throw new Error("请先配置美团短剧本地剧集视频目录。");
  }
  return localEpisodeVideoRoot;
}

export async function findRequiredLocalEpisodeVideos(
  task: ClaimedMeituanDramaTask,
  options: MeituanCreationRuntimeOptions,
): Promise<MeituanCreationLocalEpisodeVideo[]> {
  const episodes = await findSharedLocalEpisodeVideos({
    localEpisodeVideoRoot: getMeituanLocalEpisodeVideoRoot(options),
    resourceName: getMeituanOriginalTitle(task),
  });

  return episodes.filter((episode) => (
    episode.index >= 1 && episode.index <= task.playlet.totalEpisodes
  ));
}

export async function validateLocalEpisodeVideos(
  task: ClaimedMeituanDramaTask,
  options: MeituanCreationRuntimeOptions,
): Promise<void> {
  await validateSharedLocalEpisodeVideos({
    localEpisodeVideoRoot: getMeituanLocalEpisodeVideoRoot(options),
    resourceName: getMeituanOriginalTitle(task),
    episodeCount: task.playlet.totalEpisodes,
  });
}
