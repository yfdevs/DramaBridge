import path from "node:path";
import {
  listLocalPosterImages,
  prepareCroppedImageVariant,
} from "@dramabridge/media-assets";
import { log } from "../automation/browser-session.js";
import type {
  ClaimedMeituanDramaTask,
  MeituanCreationRuntimeOptions,
} from "./types.js";
import {
  getMeituanLocalEpisodeVideoRoot,
  getMeituanOriginalTitle,
} from "./local-episode-videos.js";

export async function prepareMeituanPosterMaterial(
  task: ClaimedMeituanDramaTask,
  options: MeituanCreationRuntimeOptions,
) {
  const localEpisodeVideoRoot = getMeituanLocalEpisodeVideoRoot(options);
  const resourceName = getMeituanOriginalTitle(task);
  const files = await listLocalPosterImages({
    root: localEpisodeVideoRoot,
    resourceName,
  });
  if (files.length < 1) {
    throw new Error(
      `[poster-material-invalid] 未找到文件名或目录名包含“封面”或“海报”的图片；` +
      `扫描目录=${localEpisodeVideoRoot}`,
    );
  }

  const selected = files[0];
  const platformMinimumWidth = 672;
  const platformMinimumHeight = 504;
  const requiresResize =
    selected.width === undefined
    || selected.height === undefined
    || selected.width <= platformMinimumWidth
    || selected.height <= platformMinimumHeight;

  if (!requiresResize) {
    log(
      options,
      `[meituan-drama] collection cover dimensions accepted: ` +
        `${selected.width}x${selected.height} file=${selected.file}`,
    );
    task.playlet.collectionCoverFile = selected.file;
    return selected;
  }

  if (!options.assetDownloadDir) {
    throw new Error("MEITUAN_ASSET_DOWNLOAD_DIR_REQUIRED_FOR_COVER_RESIZE");
  }

  const outputFile = path.join(
    options.assetDownloadDir,
    "poster-upload",
    "meituan-cover-1344x1008.jpg",
  );
  const prepared = await prepareCroppedImageVariant({
    inputFile: selected.file,
    outputFile,
    width: 1_344,
    height: 1_008,
    jpegQuality: 92,
    maxFileBytes: 5_000_000,
    onLog: (message) => log(options, `[meituan-drama] ${message}`),
  });
  task.playlet.collectionCoverFile = prepared.file;
  return {
    ...selected,
    file: prepared.file,
    size: prepared.size,
    width: prepared.width,
    height: prepared.height,
  };
}
