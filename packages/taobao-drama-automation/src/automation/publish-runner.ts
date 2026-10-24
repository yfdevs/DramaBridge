import type { BrowserContext, Page } from "playwright";
import { isNonRetryableBaiduNetdiskResourceError } from "@dramabridge/media-assets";
import {
  queryAllTaobaoCollections,
  type TaobaoCollectionListItem,
} from "../api/collection-list.js";
import { taobaoMaterialRoot, validateTaobaoEpisodeVideos } from "../shared/local-materials.js";
import { prepareTaobaoCollectionCover } from "../shared/cover.js";
import { prepareTaobaoCostConfigImage } from "../shared/cost-material.js";
import { log } from "../shared/logger.js";
import type { TaobaoBatchUploadTask, TaobaoDramaRuntimeOptions } from "../shared/types.js";
import { saveTaobaoCredentialState, waitForTaobaoPage } from "./browser-session.js";
import { uploadAndPublishTaobaoEpisodes } from "./episodes.js";
import {
  createTaobaoCollectionMetadata,
  prepareTaobaoEpisodeMetadata,
} from "../shared/episode-metadata.js";
import { fillAndCreateTaobaoCollection } from "./collection.js";
import { queryTaobaoCollectionDetail } from "../api/collection-detail.js";
import { createTaobaoCollectionUploadPlan } from "../shared/collection-resume.js";
import { restoreTaobaoConfirmedSubmissions } from "./collection-progress.js";

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

function normalizedCollectionTitle(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function findReusableTaobaoCollection(
  items: TaobaoCollectionListItem[],
  title: string,
) {
  const expectedTitle = normalizedCollectionTitle(title);
  const matched = items.filter((item) => normalizedCollectionTitle(item.collectionInfo.title) === expectedTitle);
  if (matched.length > 1) throw new Error(
    `TAOBAO_DRAMA_COLLECTION_AMBIGUOUS: 找到 ${matched.length} 个同名合集“${title}”，无法确定补传目标，已停止上传，请先处理同名合集。`,
  );
  return matched[0];
}

export async function findExistingTaobaoCollectionPlan(
  context: BrowserContext,
  title: string,
  episodeCount: number,
  options: TaobaoDramaRuntimeOptions,
) {
  // A failed query is not evidence that a collection does not exist.
  const result = await queryAllTaobaoCollections(context, { keyword: title }).catch((error: unknown) => {
    throw new Error(`TAOBAO_DRAMA_COLLECTION_QUERY_FAILED: 查询已有合集失败，无法确认是否已上传，已停止创建和上传，请检查淘宝登录或网络后重试。原因：${error instanceof Error ? error.message : String(error)}`);
  });
  const reusable = findReusableTaobaoCollection(result.data, title);
  if (!reusable) {
    log(options, "[taobao-drama] 未找到同名合集，将创建新合集", { title });
    return;
  }
  const detail = await queryTaobaoCollectionDetail(context, String(reusable.collectionInfo.collectionId)).catch((error: unknown) => {
    throw new Error(`TAOBAO_DRAMA_COLLECTION_DETAIL_QUERY_FAILED: 已找到合集“${title}”，但未能完整读取已上传集数，已停止补传，请检查淘宝合集详情或网络后重试。原因：${error instanceof Error ? error.message : String(error)}`);
  });
  const plan = restoreTaobaoConfirmedSubmissions(createTaobaoCollectionUploadPlan(detail, title, episodeCount), options);
  log(options, plan.missingEpisodeNumbers.length === 0 ? "[taobao-drama] 各集已上传或已确认提交，跳过重复上传" :
    plan.uploadedEpisodeNumbers.length ? "[taobao-drama] 发现未传完整的合集，将只补传缺失集数" : "[taobao-drama] 发现同名空合集，跳过合集创建", {
    title, collectionId: plan.collectionId, episodeCount, uploadedEpisodeNumbers: plan.uploadedEpisodeNumbers,
    submittedEpisodeNumbers: plan.submittedEpisodeNumbers,
    missingEpisodeNumbers: plan.missingEpisodeNumbers,
  });
  return plan;
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
    const attemptNumber = attempt + 1;
    const attemptCount = retries + 1;
    const startedAt = Date.now();
    log(options, `[taobao-drama] 开始准备百度网盘资源（第 ${attemptNumber}/${attemptCount} 次）：${task.originalTitle}`);
    const heartbeat = setInterval(() => {
      const elapsedSeconds = Math.max(1, Math.floor((Date.now() - startedAt) / 1_000));
      const elapsedText = elapsedSeconds < 60
        ? `${elapsedSeconds} 秒`
        : `${Math.floor(elapsedSeconds / 60)} 分钟`;
      log(options, `[taobao-drama] 百度网盘资源仍在下载或校验，已等待 ${elapsedText}：${task.originalTitle}`);
    }, 30_000);
    try {
      const resource = await options.ensureBaiduNetdiskResource(taobaoBaiduResourceRequest(task, options));
      log(options, `[taobao-drama] 百度网盘资源准备完成：${task.originalTitle}`);
      return resource;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (isNonRetryableBaiduNetdiskResourceError(error) || attempt >= retries) {
        log(options, `[taobao-drama] 百度网盘资源准备失败：${message}`);
        break;
      }
      log(options, `[taobao-drama] 百度网盘资源准备失败，5 秒后重试：${message}`);
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    } finally {
      clearInterval(heartbeat);
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
  log(options, `[taobao-drama] 开始检查合集并批量上传：${task.originalTitle}`);
  const collectionTitle = task.title ?? task.originalTitle;
  let uploadPlan = await findExistingTaobaoCollectionPlan(context, collectionTitle, task.episodeCount, options);
  const reused = !!uploadPlan;
  if (uploadPlan?.missingEpisodeNumbers.length === 0) return;
  // Open only the page this task actually needs, before lengthy downloads.
  // Collection creation and every upload batch share this task's single tab.
  await waitForTaobaoPage(page, uploadPlan ? "batch" : "collection", options);
  await saveTaobaoCredentialState(context, options);
  const baiduNetdiskResource = await ensureResource(task, options);
  await validateTaobaoEpisodeVideos(task, options);
  const metadata = await prepareTaobaoEpisodeMetadata(task, options);
  if (!uploadPlan) {
    const collectionMetadata = createTaobaoCollectionMetadata(task, metadata);
    const coverFile = await prepareTaobaoCollectionCover(task, collectionMetadata, options);
    const costConfigImage = await prepareTaobaoCostConfigImage(task, options);

    await waitForTaobaoPage(page, "collection", options);
    await saveTaobaoCredentialState(context, options);
    await fillAndCreateTaobaoCollection(page, collectionMetadata, coverFile, costConfigImage, options);
    // Resolve the actual collection ID after creation, before selecting videos.
    for (let attempt = 0; attempt < 5 && !uploadPlan; attempt++) {
      uploadPlan = await findExistingTaobaoCollectionPlan(context, collectionTitle, task.episodeCount, options);
      if (!uploadPlan && attempt < 4) await page.waitForTimeout(1_000);
    }
    if (!uploadPlan) throw new Error("TAOBAO_DRAMA_COLLECTION_CREATED_NOT_FOUND: 合集创建后未能读到合集信息，已停止上传，请检查淘宝合集列表后重试。");
  }

  await waitForTaobaoPage(page, "batch", options);
  await saveTaobaoCredentialState(context, options);
  await uploadAndPublishTaobaoEpisodes(page, task, metadata, { ...options, collectionUploadPlan: uploadPlan });
  log(
    options,
    `[taobao-drama] ${task.originalTitle} ${reused ? "合集复用或补传" : "合集创建"}完成，各集已上传或已确认提交；作品列表可能延迟显示`,
  );
  return baiduNetdiskResource;
}
