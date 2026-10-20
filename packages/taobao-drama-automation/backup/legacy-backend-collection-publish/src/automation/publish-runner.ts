import type { BrowserContext, Page } from "playwright";
import { isNonRetryableBaiduNetdiskResourceError } from "@dramabridge/media-assets";
import { prepareTaobaoCollectionCover } from "../shared/cover.js";
import { taobaoMaterialRoot, validateTaobaoEpisodeVideos } from "../shared/local-materials.js";
import { log } from "../shared/logger.js";
import type { ClaimedTaobaoDramaTask, TaobaoDramaRuntimeOptions } from "../shared/types.js";
import { waitForTaobaoPage, saveTaobaoCredentialState } from "./browser-session.js";
import { uploadAndPublishTaobaoEpisodes } from "./episodes.js";
import { fillAndCreateTaobaoCollection } from "./form-controls.js";

async function ensureResource(
  task: ClaimedTaobaoDramaTask,
  options: TaobaoDramaRuntimeOptions,
) {
  const link = task.playlet.baiduPanResourceLink?.trim();
  if (!link) return;
  if (!options.ensureBaiduNetdiskResource) {
    throw new Error("任务包含百度网盘链接，但淘宝短剧运行时未接入网盘下载能力。");
  }
  const retries = Math.max(0, options.baiduNetdiskDownloadRetryAttempts ?? 3);
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      await options.ensureBaiduNetdiskResource({
        shareText: link,
        resourceName: task.originalTitle,
        localEpisodeVideoRoot: taobaoMaterialRoot(options),
        episodeCount: task.playlet.episodeCount,
        requiredPosterImages: 0,
        posterFallback: { title: task.playlet.title, summary: task.playlet.summary },
      });
      return;
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
  task: ClaimedTaobaoDramaTask,
  options: TaobaoDramaRuntimeOptions,
) {
  log(options, `[taobao-drama] 开始任务：${task.originalTitle}`);
  await ensureResource(task, options);
  await validateTaobaoEpisodeVideos(task, options);
  const coverFile = await prepareTaobaoCollectionCover(task, options);

  await waitForTaobaoPage(page, "collection", options);
  await saveTaobaoCredentialState(context, options);
  await fillAndCreateTaobaoCollection(page, task.playlet, coverFile, options);

  await waitForTaobaoPage(page, "batch", options);
  await uploadAndPublishTaobaoEpisodes(page, task, options);
  log(options, `[taobao-drama] 合集创建与 ${task.playlet.episodeCount} 集批量发布全部完成`);
}
