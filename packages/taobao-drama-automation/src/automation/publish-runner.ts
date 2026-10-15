import type { BrowserContext, Page } from "playwright";
import { isNonRetryableBaiduNetdiskResourceError } from "@drama/drama-media-assets";
import { taobaoMaterialRoot, validateTaobaoEpisodeVideos } from "../shared/local-materials.js";
import { prepareTaobaoCollectionCover } from "../shared/cover.js";
import { log } from "../shared/logger.js";
import type { TaobaoBatchUploadTask, TaobaoDramaRuntimeOptions } from "../shared/types.js";
import { saveTaobaoCredentialState, waitForTaobaoPage } from "./browser-session.js";
import { uploadAndPublishTaobaoEpisodes } from "./episodes.js";
import {
  createTaobaoCollectionMetadata,
  prepareTaobaoEpisodeMetadata,
} from "../shared/episode-metadata.js";
import { fillAndCreateTaobaoCollection } from "./collection.js";

export function taobaoBaiduResourceRequest(
  task: TaobaoBatchUploadTask,
  options: TaobaoDramaRuntimeOptions,
) {
  return {
    shareText: task.baiduPanResourceLink,
    resourceName: task.originalTitle,
    localEpisodeVideoRoot: taobaoMaterialRoot(options),
    episodeCount: task.episodeCount,
    requiredPosterImages: 0,
    // Creating a collection also needs synopsis/poster materials when the share contains them.
    downloadAssetMaterials: true,
    forceAssetDownload: true,
    requireAllDiscoveredAssets: true,
    requiredMetadataTextFiles: 0,
  };
}

async function ensureResource(
  task: TaobaoBatchUploadTask,
  options: TaobaoDramaRuntimeOptions,
) {
  if (!options.ensureBaiduNetdiskResource) {
    throw new Error("淘宝短剧运行时未接入百度网盘下载能力。");
  }
  const retries = Math.max(0, options.baiduNetdiskDownloadRetryAttempts ?? 3);
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await options.ensureBaiduNetdiskResource(taobaoBaiduResourceRequest(task, options));
    } catch (error) {
      lastError = error;
      if (isNonRetryableBaiduNetdiskResourceError(error) || attempt >= retries) break;
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
  throw lastError;
}

export async function runTaobaoPublishTask(
  page: Page,
  context: BrowserContext,
  task: TaobaoBatchUploadTask,
  options: TaobaoDramaRuntimeOptions,
) {
  log(options, `[taobao-drama] 开始创建合集并批量上传：${task.originalTitle}`);
  // Navigate immediately so a task never presents an about:blank window while a
  // lengthy Baidu download or local resource check is running.
  await waitForTaobaoPage(page, "batch", options);
  await saveTaobaoCredentialState(context, options);
  const baiduNetdiskResource = await ensureResource(task, options);
  await validateTaobaoEpisodeVideos(task, options);
  const metadata = await prepareTaobaoEpisodeMetadata(task, options);
  const collectionMetadata = createTaobaoCollectionMetadata(task, metadata);
  const coverFile = await prepareTaobaoCollectionCover(task, collectionMetadata, options);

  await waitForTaobaoPage(page, "collection", options);
  await saveTaobaoCredentialState(context, options);
  await fillAndCreateTaobaoCollection(page, collectionMetadata, coverFile, options);

  await waitForTaobaoPage(page, "batch", options);
  await saveTaobaoCredentialState(context, options);
  await uploadAndPublishTaobaoEpisodes(page, task, metadata, options);
  log(options, `[taobao-drama] ${task.originalTitle} 合集创建及 ${task.episodeCount} 集批量发布完成`);
  return baiduNetdiskResource;
}
