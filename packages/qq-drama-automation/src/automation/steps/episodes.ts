import type { Page } from "playwright";
import {
  cleanupEpisodeUploadFiles,
  prepareEpisodeUploadFiles,
  type PreparedEpisodeUploadFiles,
} from "@dramabridge/media-assets";
import { log } from "../../shared/logger.js";
import {
  getQqDramaLocalEpisodeVideoRoot,
  getQqDramaOriginalTitle,
  validateQqDramaLocalEpisodeVideos,
} from "../../shared/local-episode-videos.js";
import type { ClaimedQqDramaTask, QqDramaRuntimeOptions } from "../../shared/types.js";
import { clickNextStep, uploadLocalFilesByTarget } from "./form-controls.js";
import { taskTitle } from "./payload.js";

type EpisodeUploadStatus = {
  status: "failed" | "processing" | "succeeded" | "waiting";
  text: string;
  failedText?: string;
};

type FailedEpisodeUpload = {
  fileName: string;
  errorMessage: string;
  retryAttempts: number;
};

function normalizeUiText(value: string | null | undefined) {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

async function collectFailedEpisodeUploads(
  page: Page,
  retryAttemptsByFile: Map<string, number>,
): Promise<FailedEpisodeUpload[]> {
  const rows = page.locator(".episode-row.ep-error:visible");
  const failures: FailedEpisodeUpload[] = [];
  for (let index = 0; index < await rows.count(); index += 1) {
    const row = rows.nth(index);
    const fileName = normalizeUiText(
      await row.locator(".ep-file-name").first().textContent().catch(() => ""),
    ) || `未知剧集-${index + 1}`;
    const errorMessage = normalizeUiText(
      await row.locator(".ep-error-msg").first().textContent().catch(() => ""),
    ) || "页面未提供失败原因";
    failures.push({
      fileName,
      errorMessage,
      retryAttempts: retryAttemptsByFile.get(fileName) ?? 0,
    });
  }
  return failures;
}

function failedEpisodeUploadError(
  failures: FailedEpisodeUpload[],
  maxRetryAttempts: number,
) {
  const details = failures.map((failure) =>
    `${failure.fileName}：${failure.errorMessage}（已重试 ${failure.retryAttempts}/${maxRetryAttempts} 次）`
  ).join("；");
  return new Error(`[upload-failed] QQ 剧集视频上传失败：${details || "未读取到失败集信息"}`);
}

async function retryFailedEpisodeRows(
  page: Page,
  retryAttemptsByFile: Map<string, number>,
  maxRetryAttempts: number,
  options: QqDramaRuntimeOptions,
) {
  while (true) {
    const failures = await collectFailedEpisodeUploads(page, retryAttemptsByFile);
    if (failures.length === 0) return;

    const failure = failures[0];
    if (failure.retryAttempts >= maxRetryAttempts) {
      throw failedEpisodeUploadError(failures, maxRetryAttempts);
    }

    const row = page
      .locator(".episode-row.ep-error:visible")
      .filter({
        has: page.locator(".ep-file-name").filter({
          hasText: new RegExp(`^\\s*${failure.fileName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`),
        }),
      })
      .first();
    const retryButton = row.getByRole("button", { name: "重试", exact: true }).first();
    if (await retryButton.count() === 0) {
      throw failedEpisodeUploadError(failures, maxRetryAttempts);
    }

    const nextAttempt = failure.retryAttempts + 1;
    retryAttemptsByFile.set(failure.fileName, nextAttempt);
    log(
      options,
      `[qq-drama] retrying failed episode: file=${failure.fileName} ` +
        `attempt=${nextAttempt}/${maxRetryAttempts} error=${failure.errorMessage}`,
    );
    await retryButton.scrollIntoViewIfNeeded();
    await retryButton.click({ timeout: 10_000 });

    const leftErrorState = await row.waitFor({
      state: "hidden",
      timeout: 30_000,
    }).then(() => true, () => false);
    if (!leftErrorState && nextAttempt >= maxRetryAttempts) {
      throw failedEpisodeUploadError(
        await collectFailedEpisodeUploads(page, retryAttemptsByFile),
        maxRetryAttempts,
      );
    }
  }
}

async function readEpisodeUploadStatus(page: Page, episodeCount: number): Promise<EpisodeUploadStatus> {
  return page.evaluate((expectedCount): EpisodeUploadStatus => {
    const normalize = (value: string | null | undefined) =>
      value?.replace(/\s+/g, " ").trim() ?? "";
    const uploadHeader = document.querySelector<HTMLElement>(".upload-header-left");
    const root = uploadHeader ?? document.body;
    const text = normalize(root.textContent);
    const failedText = normalize(root.querySelector<HTMLElement>(".stat-error")?.textContent);
    const hasFailure =
      Boolean(failedText) || /(?:\d+\s*集)?失败|上传失败|未能上传|上传异常/.test(text);

    if (hasFailure) {
      return {
        status: "failed",
        text,
        failedText,
      };
    }

    const completedMatch = text.match(/(\d+)\s*\/\s*(\d+)\s*集已完成/);
    const completedCount = Number(completedMatch?.[1] ?? -1);
    const totalCount = Number(completedMatch?.[2] ?? -1);
    const hasSuccess =
      (completedCount === expectedCount && totalCount === expectedCount) ||
      text.includes(`全部 ${expectedCount} 集上传完成`);

    if (hasSuccess) {
      return {
        status: "succeeded",
        text,
      };
    }

    if (/处理中|上传中|等待上传|进度\s*\d+\s*\/\s*\d+\s*集/.test(text)) {
      return {
        status: "processing",
        text,
      };
    }

    return {
      status: "waiting",
      text,
    };
  }, episodeCount);
}

async function waitForEpisodeUploadComplete(
  page: Page,
  episodeCount: number,
  options: QqDramaRuntimeOptions,
) {
  const timeoutMinutes = Math.max(1, options.episodeUploadWaitTimeoutMinutes ?? 120);
  const timeoutMs = timeoutMinutes * 60 * 1000;
  const pollMs = 2_000;
  const startedAt = Date.now();
  const maxRetryAttempts = Math.max(0, options.episodeUploadFailedRetryAttempts ?? 3);
  const retryAttemptsByFile = new Map<string, number>();
  let lastText = "";

  while (Date.now() - startedAt < timeoutMs) {
    await retryFailedEpisodeRows(page, retryAttemptsByFile, maxRetryAttempts, options);
    const result = await readEpisodeUploadStatus(page, episodeCount);
    if (result.text && result.text !== lastText) {
      lastText = result.text;
      log(options, `[qq-drama] episode upload status: ${result.text}`);
    }

    if (result.status === "succeeded") {
      return;
    }

    await page.waitForTimeout(pollMs);
  }

  const failures = await collectFailedEpisodeUploads(page, retryAttemptsByFile);
  if (failures.length > 0) {
    throw failedEpisodeUploadError(failures, maxRetryAttempts);
  }
  throw new Error(
    `[upload-failed] 等待 QQ 剧集视频上传完成超时（上限 ${timeoutMinutes} 分钟）。` +
      `当前状态：${lastText || "未读取到上传状态"}`,
  );
}

async function uploadEpisodeVideosIfPresent(
  page: Page,
  task: ClaimedQqDramaTask,
  options: QqDramaRuntimeOptions,
): Promise<PreparedEpisodeUploadFiles | null> {
  // 没有集数说明这个任务不需要上传正片视频，直接跳过剧集上传步骤。
  const episodeCount = task.playlet.episodeCount;
  if (!episodeCount) return null;

  // 剧集上传依赖本地视频根目录和临时上传目录，缺任意一个都无法准备文件。
  const localEpisodeVideoRoot = getQqDramaLocalEpisodeVideoRoot(options);
  if (!options.assetDownloadDir) {
    throw new Error("请先配置 QQ 短剧素材下载目录。");
  }

  const resourceName = getQqDramaOriginalTitle(task);
  // 先校验本地目录中是否刚好存在第 1 集到第 N 集，避免页面上传到一半才失败。
  await validateQqDramaLocalEpisodeVideos(task, options);

  // 为 Playwright 文件上传准备临时文件名；共享包会创建硬链接，外层 finally 负责清理。
  const prepared = await prepareEpisodeUploadFiles({
    localEpisodeVideoRoot,
    resourceName,
    uploadRootDir: options.assetDownloadDir,
    uploadBaseName: taskTitle(task.playlet),
  });

  // 双重确认准备出来的上传文件数量，防止校验后目录内容发生变化。
  if (prepared.files.length !== episodeCount) {
    throw new Error(
      `[upload-failed] 剧集视频: expected ${episodeCount} local video file(s), got ${prepared.files.length}.`,
    );
  }

  await uploadLocalFilesByTarget(page, {
    files: prepared.files,
    queueTimeoutMs: Math.min(
      5 * 60_000,
      Math.max(2 * 60_000, (options.episodeUploadWaitTimeoutMinutes ?? 120) * 60_000),
    ),
  });
  await waitForEpisodeUploadComplete(page, episodeCount, options);
  return prepared;
}

export async function uploadEpisodeVideosStep(
  page: Page,
  task: ClaimedQqDramaTask,
  options: QqDramaRuntimeOptions,
) {
  let preparedEpisodes: PreparedEpisodeUploadFiles | null = null;
  try {
    preparedEpisodes = await uploadEpisodeVideosIfPresent(page, task, options);

    await clickNextStep(page, options);
  } finally {
    if (preparedEpisodes) {
      await cleanupEpisodeUploadFiles(preparedEpisodes);
    }
  }
}
