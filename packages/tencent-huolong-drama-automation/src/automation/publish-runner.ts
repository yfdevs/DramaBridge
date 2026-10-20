import type { BrowserContext, Page } from "playwright";
import {
  cleanupEpisodeUploadFiles,
  prepareEpisodeUploadFiles,
} from "@dramabridge/media-assets";
import { TENCENT_HUOLONG_DRAMA_ADD_URL } from "../shared/constants.js";
import { prepareTencentHuolongCovers } from "../shared/covers.js";
import {
  materialRoot,
  prepareTencentHuolongRequiredMaterials,
  sourcePoster,
  validateEpisodeVideos,
} from "../shared/local-materials.js";
import { log } from "../shared/logger.js";
import { resolveTencentHuolongCreativeMetadata } from "../shared/subtitle.js";
import type { ClaimedTencentHuolongDramaTask, TencentHuolongRuntimeOptions } from "../shared/types.js";
import { saveCredentialState, waitForLoginIfNeeded } from "./browser-session.js";
import {
  fillTencentHuolongFirstPage,
  submitAndOpenVideoStep,
  submitTencentHuolongVideos,
} from "./form-controls.js";

export async function openTencentHuolongAddPage(page: Page, context: BrowserContext, options: TencentHuolongRuntimeOptions) {
  await page.goto(TENCENT_HUOLONG_DRAMA_ADD_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await waitForLoginIfNeeded(page, context, options);
  if (page.url() !== TENCENT_HUOLONG_DRAMA_ADD_URL) {
    await page.goto(TENCENT_HUOLONG_DRAMA_ADD_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  }
  await page.locator('[data-field-name="user_title"] input').waitFor({ state: "visible", timeout: 60_000 });
}

type FailedEpisodeUpload = {
  episodeNumber: string;
  title: string;
};

type EpisodeUploadRowSnapshot = FailedEpisodeUpload & {
  statuses: string[];
};

type EpisodeUploadProgress = {
  completed: number;
  total: number;
};

const maxEpisodeFilesPerSelection = 60;

export function splitTencentHuolongEpisodeUploadBatches(files: string[]) {
  const batches: string[][] = [];
  for (let offset = 0; offset < files.length; offset += maxEpisodeFilesPerSelection) {
    batches.push(files.slice(offset, offset + maxEpisodeFilesPerSelection));
  }
  return batches;
}

export function parseTencentHuolongEpisodeUploadProgress(
  titles: string[],
): EpisodeUploadProgress | undefined {
  for (const title of titles) {
    if (!/(?:正在上传|上传完成)/u.test(title)) continue;
    const match = title.match(/[（(]\s*(\d+)\s*\/\s*(\d+)\s*[)）]/u);
    if (!match) continue;
    return { completed: Number(match[1]), total: Number(match[2]) };
  }
  return undefined;
}

export function findFailedEpisodeUploads(rows: EpisodeUploadRowSnapshot[]): FailedEpisodeUpload[] {
  return rows
    .filter(({ statuses }) => statuses.includes("上传失败"))
    .map(({ episodeNumber, title }) => ({ episodeNumber, title }));
}

export async function readFailedEpisodeUploads(page: Page): Promise<FailedEpisodeUpload[]> {
  const rows = await page.locator("section[data-g-index]").evaluateAll((elements) => elements.map((row) => {
    const episodeNumber = row.getAttribute("data-g-index")?.trim() ?? "未知";
    const titleInput = row.querySelector<HTMLInputElement>('[data-field-name$=".video_title"] input');
    const statuses = Array.from(row.querySelectorAll("header div, header span"))
      .map((element) => element.textContent?.trim() ?? "")
      .filter(Boolean);
    return {
      episodeNumber,
      title: titleInput?.value.trim() ?? "",
      statuses,
    };
  }));
  return findFailedEpisodeUploads(rows);
}

async function readSuccessfulEpisodeUploadCount(page: Page) {
  return page.locator("section[data-g-index]").evaluateAll((elements) => elements.filter((row) => {
    const statuses = Array.from(row.querySelectorAll("header div, header span"))
      .map((element) => element.textContent?.trim() ?? "");
    return statuses.some((status) => /上传成功|上传完成/u.test(status));
  }).length);
}

async function waitForEpisodeUploadBatch(options: {
  page: Page;
  runtimeOptions: TencentHuolongRuntimeOptions;
  batchNumber: number;
  batchSize: number;
  uploadedBeforeBatch: number;
  expectedUploadedTotal: number;
  deadline: number;
}) {
  const {
    page,
    runtimeOptions,
    batchNumber,
    batchSize,
    uploadedBeforeBatch,
    expectedUploadedTotal,
    deadline,
  } = options;
  const progressTitles = page.locator('header[class*="_header_"] div[class*="_title_"]').filter({ visible: true });
  let lastProgress = "";
  let sawCurrentBatchInProgress = false;

  while (Date.now() < deadline) {
    const failedUploads = await readFailedEpisodeUploads(page);
    if (failedUploads.length > 0) {
      const failedEpisodes = failedUploads
        .map(({ episodeNumber, title }) => `视频${episodeNumber}${title ? `（${title}）` : ""}`)
        .join("、");
      throw new Error(
        `TENCENT_HUOLONG_DRAMA_EPISODE_UPLOAD_FAILED: failed=${failedEpisodes}`
        + (lastProgress ? `; progress=${lastProgress}` : ""),
      );
    }

    const bodyText = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    if (/上传失败/.test(bodyText)) {
      throw new Error(`TENCENT_HUOLONG_DRAMA_EPISODE_UPLOAD_FAILED${lastProgress ? `: progress=${lastProgress}` : ""}`);
    }

    const successfulCount = await readSuccessfulEpisodeUploadCount(page);
    if (successfulCount >= expectedUploadedTotal) {
      log(
        runtimeOptions,
        `[tencent-huolong-drama] 第${batchNumber}批剧集视频已上传完成：累计${expectedUploadedTotal}集`,
      );
      return;
    }

    const progress = parseTencentHuolongEpisodeUploadProgress(await progressTitles.allInnerTexts());
    if (progress) {
      const isCumulativeProgress = progress.total >= expectedUploadedTotal;
      const isCurrentBatchProgress = progress.total === batchSize;
      if (!isCumulativeProgress && !isCurrentBatchProgress) {
        await page.waitForTimeout(1_000);
        continue;
      }
      if (isCurrentBatchProgress && progress.completed < progress.total) {
        sawCurrentBatchInProgress = true;
      }
      const cumulativeCompleted = isCumulativeProgress
        ? progress.completed
        : uploadedBeforeBatch + progress.completed;
      const cumulativeTotal = isCumulativeProgress
        ? progress.total
        : uploadedBeforeBatch + progress.total;
      const progressText = `${Math.min(cumulativeCompleted, expectedUploadedTotal)}/${cumulativeTotal}`;
      if (progressText !== lastProgress) {
        log(runtimeOptions, `[tencent-huolong-drama] 剧集视频上传进度：${progressText}`);
        lastProgress = progressText;
      }

      const currentBatchFinished = progress.completed >= progress.total
        && (
          isCumulativeProgress
          || (isCurrentBatchProgress && (batchNumber === 1 || sawCurrentBatchInProgress || batchSize < maxEpisodeFilesPerSelection))
        );
      if (currentBatchFinished) {
        log(
          runtimeOptions,
          `[tencent-huolong-drama] 第${batchNumber}批剧集视频已上传完成：累计${expectedUploadedTotal}集`,
        );
        return;
      }
    }
    await page.waitForTimeout(1_000);
  }

  throw new Error(
    `TENCENT_HUOLONG_DRAMA_EPISODE_UPLOAD_TIMEOUT: batch=${batchNumber}`
    + (lastProgress ? `; progress=${lastProgress}` : ""),
  );
}

async function uploadEpisodeVideos(
  page: Page,
  task: ClaimedTencentHuolongDramaTask,
  options: TencentHuolongRuntimeOptions,
) {
  if (!options.assetDownloadDir) throw new Error("TENCENT_HUOLONG_DRAMA_ASSET_DIR_REQUIRED");
  await validateEpisodeVideos(task, options);
  const prepared = await prepareEpisodeUploadFiles({
    localEpisodeVideoRoot: materialRoot(options),
    resourceName: task.originalTitle,
    uploadRootDir: options.assetDownloadDir,
    uploadBaseName: task.playlet.title,
  });
  try {
    if (prepared.files.length !== task.playlet.episodeCount) {
      throw new Error(`TENCENT_HUOLONG_DRAMA_EPISODE_COUNT_MISMATCH: expected=${task.playlet.episodeCount} actual=${prepared.files.length}`);
    }
    const timeoutMs = Math.max(1, options.episodeUploadWaitTimeoutMinutes ?? 120) * 60_000;
    const deadline = Date.now() + timeoutMs;
    const batches = splitTencentHuolongEpisodeUploadBatches(prepared.files);
    let uploadedCount = 0;
    for (const [batchIndex, batch] of batches.entries()) {
      const batchNumber = batchIndex + 1;
      log(
        options,
        `[tencent-huolong-drama] 开始上传第${batchNumber}/${batches.length}批剧集视频：${batch.length}集`,
      );
      const input = page.locator('input[type="file"][accept*="video"],input[type="file"][accept*="mp4"]').first();
      await input.setInputFiles(batch, { timeout: 120_000 });
      await waitForEpisodeUploadBatch({
        page,
        runtimeOptions: options,
        batchNumber,
        batchSize: batch.length,
        uploadedBeforeBatch: uploadedCount,
        expectedUploadedTotal: uploadedCount + batch.length,
        deadline,
      });
      uploadedCount += batch.length;
    }
    log(options, `[tencent-huolong-drama] 剧集视频已全部上传完成：${uploadedCount}/${prepared.files.length}`);
  } finally {
    await cleanupEpisodeUploadFiles(prepared);
  }
}

export async function runTencentHuolongPublishTask(
  page: Page,
  context: BrowserContext,
  task: ClaimedTencentHuolongDramaTask,
  options: TencentHuolongRuntimeOptions,
) {
  await openTencentHuolongAddPage(page, context, options);
  await prepareTencentHuolongRequiredMaterials(task, options);
  const poster = await sourcePoster(task, options);
  const metadata = await resolveTencentHuolongCreativeMetadata(task.playlet, options);
  const covers = await prepareTencentHuolongCovers(poster, task, options);
  await fillTencentHuolongFirstPage(page, task, metadata.subtitle, metadata.keywords, covers, options);
  await submitAndOpenVideoStep(page, options);
  await uploadEpisodeVideos(page, task, options);
  await submitTencentHuolongVideos(page, options);
  await saveCredentialState(context, options).catch(() => undefined);
  log(options, `[tencent-huolong-drama] 视频已添加并提交：${task.playlet.episodeCount} 集`);
}
