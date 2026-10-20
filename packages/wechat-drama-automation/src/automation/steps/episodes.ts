import type { Locator, Page } from "playwright";
import { resolveRunDataPath } from "../../shared/config.js";
import { createLogger } from "../../shared/logger.js";
import { getWechatVideoRuntimeSettings } from "../../shared/runtime-settings.js";
import { integerSetting, secondsSettingToMs } from "../../shared/settings-value.js";
import type { Config, PreparedEpisodeVideo } from "../../shared/types.js";
import {
  cleanupEpisodeUploadFiles,
  prepareEpisodeUploadFiles,
} from "@dramabridge/media-assets";
import {
  fileInputByLabelPrefix,
  setInputFilesByLocator
} from "../upload/upload-helpers.js";

interface EpisodeUploadStepOptions {
  episodeVideos?: PreparedEpisodeVideo[];
  videoAccountLabel?: string;
}

const uploadLogger = createLogger("upload");
async function cleanupEpisodeUploadDir(uploadDir: string, videoAccountLabel?: string): Promise<void> {
  await cleanupEpisodeUploadFiles({ uploadDir, files: [] }).catch((error: unknown) => {
    uploadLogger.warn("临时剧集目录清理失败", {
      accountName: videoAccountLabel,
      path: uploadDir,
      error,
    });
  });
}

function normalizeUiText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

async function collectVisibleTopTipTexts(page: Page): Promise<string[]> {
  const texts: string[] = [];
  const topTips = page.locator(".weui-toptips__inner");
  const count = await topTips.count();
  for (let index = 0; index < count; index += 1) {
    const tip = topTips.nth(index);
    if (!await tip.isVisible().catch(() => false)) continue;
    const text = normalizeUiText(
      await tip.innerText().catch(() => "") || await tip.textContent().catch(() => ""),
    );
    if (text) texts.push(text);
  }
  return Array.from(new Set(texts));
}

async function assertNoEpisodeUploadTopTipErrors(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const texts = await collectVisibleTopTipTexts(page);
    if (texts.length > 0) {
      throw new Error(`[episode-upload-validation-failed] 顶部提示：${texts.join("；")}`);
    }
    await page.waitForTimeout(300);
  }
}

function episodeUploadWaitTimeoutMs(): number {
  return secondsSettingToMs(getWechatVideoRuntimeSettings().episodeUploadWaitTimeoutSeconds, 240 * 60);
}

function episodeUploadFailedRetryAttempts(): number {
  return integerSetting(getWechatVideoRuntimeSettings().episodeUploadFailedRetryAttempts, 3);
}

async function retryFailedEpisodeRows(
  app: Locator,
  retryAttemptsByFile: Map<string, number>,
  videoAccountLabel?: string,
  maxRetryAttempts = episodeUploadFailedRetryAttempts(),
): Promise<void> {
  while (true) {
    const failureStatus = app.locator("div.status-error:visible")
      .filter({ hasText: "未能上传" })
      .first();
    if (await failureStatus.count() === 0) return;

    const row = failureStatus.locator("xpath=ancestor::tr[1]");
    const fileName = normalizeUiText(await row.locator("td.table-name").innerText().catch(() => "未知剧集文件"));
    const attempts = retryAttemptsByFile.get(fileName) ?? 0;
    if (attempts >= maxRetryAttempts) {
      throw new Error(`[upload-failed] 剧集视频 ${fileName}: 重试 ${attempts} 次后仍提示“未能上传”。`);
    }

    const retryLink = row.locator("a.action-link", { hasText: /^重试$/ }).first();
    if (await retryLink.count() === 0) {
      throw new Error(`[upload-failed] 剧集视频 ${fileName}: 提示“未能上传”，但找不到重试按钮。`);
    }

    const nextAttempt = attempts + 1;
    retryAttemptsByFile.set(fileName, nextAttempt);
    uploadLogger.warn("剧集上传失败，准备重试", {
      accountName: videoAccountLabel,
      fileName,
      attempt: nextAttempt,
      maxAttempts: maxRetryAttempts,
    });
    await retryLink.scrollIntoViewIfNeeded();
    await retryLink.click({ timeout: 10000 });
    uploadLogger.info("已点击重新上传", { accountName: videoAccountLabel, fileName });

    const leftFailureState = await failureStatus.waitFor({
      state: "hidden",
      timeout: 30000,
    }).then(() => true, () => false);

    if (!leftFailureState && nextAttempt >= maxRetryAttempts) {
      throw new Error(`[upload-failed] 剧集视频 ${fileName}: 重试 ${nextAttempt} 次后仍提示“未能上传”。`);
    }
  }
}

async function waitForEpisodeUploadResult(
  page: Page,
  expectedCount: number,
  videoAccountLabel?: string,
  timeout = episodeUploadWaitTimeoutMs(),
): Promise<void> {
  const deadline = Date.now() + timeout;
  uploadLogger.info("正在等待剧集上传完成", {
    accountName: videoAccountLabel,
    timeoutMinutes: Math.round(timeout / 60 / 1000),
  });
  const app = page.locator("wujie-app:visible").first();
  const status = app.locator(".table-operation-left:visible").last();
  const retryAttemptsByFile = new Map<string, number>();
  let lastStatusText = "";

  while (Date.now() < deadline) {
    await retryFailedEpisodeRows(app, retryAttemptsByFile, videoAccountLabel);

    const statusText = normalizeUiText(await status.innerText().catch(() => ""));
    const errorTexts = (await app.locator(".errmsg:visible").allInnerTexts().catch(() => []))
      .map(normalizeUiText)
      .filter(Boolean);

    if (statusText && statusText !== lastStatusText) {
      uploadLogger.info("剧集上传状态已更新", {
        accountName: videoAccountLabel,
        status: statusText,
      });
      lastStatusText = statusText;
    }

    if (errorTexts.length > 0) {
      const failureText = errorTexts.join("；");
      throw new Error(`[upload-failed] 微信页面提示：${failureText}`);
    }

    const match = statusText.match(/已上传成功\s*(\d+)\s*\/\s*(\d+)\s*集/);
    const uploadedCount = Number(match?.[1] ?? -1);
    const totalCount = Number(match?.[2] ?? -1);
    const failedCount = await app.locator("div.status-error:visible", { hasText: "未能上传" }).count();
    const succeeded = uploadedCount === expectedCount
      && totalCount === expectedCount
      && failedCount === 0;

    if (succeeded) {
      uploadLogger.info("剧集上传完成", {
        accountName: videoAccountLabel,
        status: statusText,
      });
      return;
    }

    await page.waitForTimeout(3000);
  }

  throw new Error(
    `[upload-failed] 等待微信“已上传成功”状态超时。当前剧集上传组件最后状态：${lastStatusText || "未读取到状态"}`,
  );
}

async function readCurrentStepText(page: Page): Promise<string> {
  const steps = page.locator("wujie-app:visible li.weui-desktop-step.current");
  const count = await steps.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const step = steps.nth(index);
    if (!await step.isVisible().catch(() => false)) continue;
    const text = normalizeUiText(await step.innerText().catch(() => ""));
    if (text) return text;
  }
  return "";
}

async function waitForReviewConfirmStep(page: Page, timeout = 60000): Promise<string> {
  const deadline = Date.now() + timeout;
  let lastStepText = "";

  while (Date.now() < deadline) {
    const currentStepText = await readCurrentStepText(page);
    if (currentStepText) {
      lastStepText = currentStepText;
      if (!currentStepText.includes("剧集文件选取")) {
        return currentStepText;
      }
    }

    await page.waitForTimeout(500);
  }

  throw new Error(
    `[step-transition-failed] 点击“确认提审”后仍停留在“${lastStepText || "未知步骤"}”，未进入提审确认页。`,
  );
}

async function collectVisibleConfirmReviewErrors(page: Page): Promise<string[]> {
  const texts: string[] = [];
  const errors = page.locator(".table-operation-left > .errmsg.marginleft");
  const count = await errors.count();
  for (let index = 0; index < count; index += 1) {
    const error = errors.nth(index);
    if (!await error.isVisible().catch(() => false)) continue;
    const text = normalizeUiText(
      await error.innerText().catch(() => "") || await error.textContent().catch(() => ""),
    );
    if (text) texts.push(text);
  }
  return Array.from(new Set(texts));
}

async function assertNoConfirmReviewErrors(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const texts = await collectVisibleConfirmReviewErrors(page);
    if (texts.length > 0) {
      throw new Error(`[confirm-review-validation-failed] ${texts.join("；")}`);
    }
    await page.waitForTimeout(300);
  }
}

async function clickConfirmReviewButton(page: Page): Promise<void> {
  const app = page.locator("wujie-app:visible").first();
  const button = app.getByRole("button", { name: /^确认提审$/ }).first();

  await button.waitFor({ state: "visible", timeout: 30000 });
  await button.scrollIntoViewIfNeeded();
  await button.click({ timeout: 30000 });
  uploadLogger.info("已点击确认提审");

  await page.waitForTimeout(1000);
  await assertNoConfirmReviewErrors(page);

  const nextStepText = await waitForReviewConfirmStep(page);
  uploadLogger.info("剧集上传步骤已完成", { nextStep: nextStepText });
}

export async function uploadEpisodeFilesStep(
  page: Page,
  config: Config,
  options: EpisodeUploadStepOptions = {},
): Promise<void> {
  await page.waitForTimeout(1000);
  await page.locator("div")
    .filter({ hasText: /^请选择要上传的视频文件$/ })
    .first()
    .waitFor({ state: "visible", timeout: 30000 });
  const prepared = await prepareEpisodeUploadFiles({
    localEpisodeVideoRoot: getWechatVideoRuntimeSettings().localEpisodeVideoRoot,
    resourceName: config.originalTitle,
    uploadRootDir: resolveRunDataPath(),
    uploadBaseName: config.playlet.name,
    episodes: options.episodeVideos,
  });
  try {
    const videoFiles = prepared.files;
    if (!videoFiles.length) {
      throw new Error("No existing episode video files found.");
    }
    if (videoFiles.length !== config.playlet.episodeCount) {
      throw new Error(`[upload-failed] 剧集视频: expected ${config.playlet.episodeCount} local video file(s), got ${videoFiles.length}.`);
    }

    const expectedCount = config.playlet.episodeCount;
    const videoInput = await fileInputByLabelPrefix(page, "选取视频");
    await setInputFilesByLocator(videoInput, videoFiles, "剧集视频", 120000);
    await assertNoEpisodeUploadTopTipErrors(page);

    uploadLogger.info("视频文件已提交，正在等待上传结果", {
      accountName: options.videoAccountLabel,
    });
    await waitForEpisodeUploadResult(page, expectedCount, options.videoAccountLabel);

    await page.waitForTimeout(3000);
    await clickConfirmReviewButton(page);
  } finally {
    await cleanupEpisodeUploadDir(prepared.uploadDir, options.videoAccountLabel);
  }
}
