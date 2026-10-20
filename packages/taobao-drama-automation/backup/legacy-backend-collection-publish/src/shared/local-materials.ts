import {
  findLocalEpisodeVideos,
  listLocalPosterImages,
  validateLocalEpisodeVideos,
} from "@dramabridge/media-assets";
import type { ClaimedTaobaoDramaTask, TaobaoDramaRuntimeOptions } from "./types.js";

export function taobaoMaterialRoot(options: TaobaoDramaRuntimeOptions) {
  const root = options.localMaterialRoot?.trim();
  if (!root) throw new Error("TAOBAO_DRAMA_LOCAL_MATERIAL_ROOT_REQUIRED");
  return root;
}

export async function validateTaobaoEpisodeVideos(
  task: ClaimedTaobaoDramaTask,
  options: TaobaoDramaRuntimeOptions,
) {
  await validateLocalEpisodeVideos({
    localEpisodeVideoRoot: taobaoMaterialRoot(options),
    resourceName: task.originalTitle,
    episodeCount: task.playlet.episodeCount,
  });
}

export function findTaobaoEpisodeVideos(
  task: ClaimedTaobaoDramaTask,
  options: TaobaoDramaRuntimeOptions,
) {
  return findLocalEpisodeVideos({
    localEpisodeVideoRoot: taobaoMaterialRoot(options),
    resourceName: task.originalTitle,
  });
}

export async function findTaobaoSourcePoster(
  task: ClaimedTaobaoDramaTask,
  options: TaobaoDramaRuntimeOptions,
) {
  if (task.playlet.sourceCoverFile?.trim()) return task.playlet.sourceCoverFile.trim();
  const posters = await listLocalPosterImages({
    root: taobaoMaterialRoot(options),
    resourceName: task.originalTitle,
  });
  const poster = posters[0];
  return poster?.file;
}
