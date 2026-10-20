import type { BrowserContext, Page } from "playwright";
import { isNonRetryableBaiduNetdiskResourceError } from "@dramabridge/media-assets";
import type { ClaimedMeituanDramaTask, MeituanCreationRuntimeOptions } from "../shared/types.js";
import { log, saveCredentialState, waitForPublishPageReady } from "./browser-session.js";
import {
  getMeituanLocalEpisodeVideoRoot,
  getMeituanOriginalTitle,
  validateLocalEpisodeVideos,
} from "../shared/local-episode-videos.js";
import { prepareMeituanPosterMaterial } from "../shared/poster-materials.js";
import { prepareMeituanCopyrightProofMaterials } from "../shared/copyright-proof-materials.js";
import { clickWhenReady } from "./form-controls.js";
import { uploadEpisodeVideosStep } from "./steps/episodes.js";
import { selectPublishTargetStep } from "./steps/select-author.js";
import { submitPublishStep } from "./steps/submit.js";

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function ensureBaiduNetdiskResourceReady(
  task: ClaimedMeituanDramaTask,
  options: MeituanCreationRuntimeOptions,
) {
  const baiduPanResourceLink = task.playlet.baiduPanResourceLink?.trim();
  if (!baiduPanResourceLink) return;

  if (!options.ensureBaiduNetdiskResource) {
    throw new Error("任务包含百度网盘资源链接，但当前美团运行时未接入百度网盘下载能力。");
  }

  const localEpisodeVideoRoot = getMeituanLocalEpisodeVideoRoot(options);
  const resourceName = getMeituanOriginalTitle(task);
  const episodeCount = task.playlet.totalEpisodes;
  const retryAttempts = Math.max(0, options.baiduNetdiskDownloadRetryAttempts ?? 3);
  const maxAttempts = retryAttempts + 1;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      log(
        options,
        `[meituan-drama] ensuring baidu netdisk resource: accountTaskId=${task.accountTaskId} ` +
          `resourceName=${resourceName} episodeCount=${episodeCount} attempt=${attempt}/${maxAttempts}`,
      );
      return await options.ensureBaiduNetdiskResource({
        shareText: baiduPanResourceLink,
        resourceName,
        localEpisodeVideoRoot,
        episodeCount,
        // Meituan copyright proofs come from the task payload, not the netdisk share.
        requiredOwnership: { minimumImages: 0 },
        requiredOwnershipFiles: 0,
        requiredPosterImages: 1,
        posterFallback: {
          title: task.playlet.collectionTitle,
          summary: task.playlet.plotSynopsisText,
        },
      });
    } catch (error) {
      lastError = error;
      const message = errorMessage(error);
      const nonRetryable = isNonRetryableBaiduNetdiskResourceError(error);
      if (nonRetryable || attempt >= maxAttempts) break;

      log(
        options,
        `[meituan-drama] baidu netdisk resource failed, retrying: ` +
          `accountTaskId=${task.accountTaskId} nextAttempt=${attempt + 1}/${maxAttempts} error=${message}`,
      );
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function openPublishPage(
  context: BrowserContext,
  page: Page,
  options: MeituanCreationRuntimeOptions,
) {
  log(options, "[meituan-drama] opening publish page");
  await waitForPublishPageReady(page, options);
  await saveCredentialState(context, options);
}

export async function runPublishTask(
  context: BrowserContext,
  page: Page,
  options: MeituanCreationRuntimeOptions,
  task: ClaimedMeituanDramaTask | null,
) {
  if (!task) {
    await openPublishPage(context, page, options);
    log(options, "[meituan-drama] claimed task not provided, browser is ready");
    return;
  }

  const taskConfig = task.playlet;
  log(
    options,
    `[meituan-drama] starting claimed task: accountTaskId=${task.accountTaskId} originalTitle=${task.originalTitle}`,
  );
  const baiduNetdiskResource = await ensureBaiduNetdiskResourceReady(task, options);
  log(options, "[meituan-drama] validating local episode videos before publishing");
  await validateLocalEpisodeVideos(task, options);
  log(options, "[meituan-drama] matching local collection cover before publishing");
  const poster = await prepareMeituanPosterMaterial(task, options);
  log(options, `[meituan-drama] local collection cover ready: ${poster.file}`);
  log(options, "[meituan-drama] preparing copyright proof materials");
  const copyrightProofMaterials = await prepareMeituanCopyrightProofMaterials(task, options);

  await openPublishPage(context, page, options);
  log(options, "[meituan-drama] clicking publish-to-collection entry");
  await clickWhenReady(page, page.getByText("发布至合集"));
  await selectPublishTargetStep(page, taskConfig, options, copyrightProofMaterials.files);
  await uploadEpisodeVideosStep(page, task, options);
  await submitPublishStep(page, options);
  log(options, "[meituan-drama] publish task completed");
  return baiduNetdiskResource;
}
