import { findLocalEpisodeVideos as findSharedLocalEpisodeVideos } from "@dramabridge/media-assets";
import { validateLocalEpisodeVideos as validateSharedLocalEpisodeVideos } from "@dramabridge/media-assets";
import { getWechatVideoRuntimeSettings } from "./runtime-settings.js";
import type { Config } from "./types.js";

export interface LocalEpisodeVideo {
  index: number;
  title: string;
  file: string;
}

function getOriginalTitle(config: Config): string {
  const originalTitle = config.originalTitle?.trim();
  if (!originalTitle) {
    throw new Error("originalTitle is required for local episode videos.");
  }
  return originalTitle;
}

function getLocalEpisodeVideoRoot() {
  const localEpisodeVideoRoot = getWechatVideoRuntimeSettings().localEpisodeVideoRoot.trim();
  if (!localEpisodeVideoRoot) {
    throw new Error("localEpisodeVideoRoot is required for local episode videos.");
  }
  return localEpisodeVideoRoot;
}

export async function findLocalEpisodeVideos(config: Config): Promise<LocalEpisodeVideo[]> {
  return findSharedLocalEpisodeVideos({
    localEpisodeVideoRoot: getLocalEpisodeVideoRoot(),
    resourceName: getOriginalTitle(config),
  });
}

export async function validateLocalEpisodeVideos(config: Config): Promise<void> {
  await validateSharedLocalEpisodeVideos({
    localEpisodeVideoRoot: getLocalEpisodeVideoRoot(),
    resourceName: getOriginalTitle(config),
    episodeCount: config.playlet.episodeCount,
  });
}
