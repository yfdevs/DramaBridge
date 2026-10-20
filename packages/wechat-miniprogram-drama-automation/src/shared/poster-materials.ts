import { listLocalPosterImages } from "@dramabridge/media-assets";
import { getWechatMiniProgramRuntimeSettings } from "./runtime-settings.js";
import type { Config } from "./types.js";

export async function prepareWechatPosterMaterials(config: Config) {
  const localEpisodeVideoRoot = getWechatMiniProgramRuntimeSettings().localEpisodeVideoRoot.trim();
  const files = await listLocalPosterImages({
    root: localEpisodeVideoRoot,
    resourceName: config.originalTitle,
  });
  if (files.length < 1) {
    throw new Error(
      `[poster-material-invalid] 未找到文件名或目录名包含“封面”或“海报”的图片；` +
        `扫描目录=${localEpisodeVideoRoot}`,
    );
  }

  const selected = files[0];
  config.playlet.posters = {
    main: selected.file,
    promotion: selected.file,
  };
  return config.playlet.posters;
}
