import { validateLocalEpisodeVideos as validateSharedLocalEpisodeVideos } from "@dramabridge/media-assets";
import type { KuaishouDramaRuntimeOptions, KuaishouDramaTaskConfig } from "./types.js";

export function getKuaishouDramaLocalEpisodeVideoRoot(options: KuaishouDramaRuntimeOptions) {
  const root = options.localEpisodeVideoRoot?.trim();
  if (!root) {
    throw new Error("请先配置快手短剧本地剧集视频目录。");
  }
  return root;
}

export async function validateKuaishouDramaLocalEpisodeVideos(
  task: KuaishouDramaTaskConfig,
  resourceName: string,
  options: KuaishouDramaRuntimeOptions,
) {
  await validateSharedLocalEpisodeVideos({
    localEpisodeVideoRoot: getKuaishouDramaLocalEpisodeVideoRoot(options),
    resourceName,
    episodeCount: task.episodeCount,
  });
}
