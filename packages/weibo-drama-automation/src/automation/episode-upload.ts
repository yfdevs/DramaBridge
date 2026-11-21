import path from "node:path";
import type { Page } from "playwright";
import { ensureVideoMinimumDimensions } from "@dramabridge/media-assets";
import { log } from "../shared/logger.js";
import type { WeiboDramaRuntimeOptions } from "../shared/types.js";
import { removeWeiboUploadItem } from "./remove-upload-item.js";

export function classifyWeiboUploadError(message: string) {
  if (/清晰度|分辨率|尺寸|1080/i.test(message)) return "resolution";
  if (/格式|编码|解码|时长|损坏|权限|授权|登录|违规|封禁/i.test(message)) return "manual";
  return "retry";
}

export async function expandWeiboEpisodeGrid(page: Page) {
  const expand = page.locator(".expand-btn").filter({ hasText: /^展开\s*$/ });
  if (await expand.isVisible()) await expand.click();
}

export async function waitForWeiboEpisodeUploads(
  page: Page,
  files: string[],
  options: WeiboDramaRuntimeOptions,
) {
  await expandWeiboEpisodeGrid(page);
  const deadline = Date.now() + (options.episodeUploadWaitTimeoutMinutes ?? 120) * 60_000;
  const attempts = new Map<number, number>();
  const maxRetries = options.episodeUploadFailedRetryAttempts ?? 3;
  let lastProgressLog = 0;
  let lastProgress = "";
  let lastProgressAt = Date.now();
  while (Date.now() < deadline) {
    options.signal?.throwIfAborted();
    const cards = page.locator(".video-card");
    const count = await cards.count();
    if (count !== files.length)
      throw new Error(`WEIBO_DRAMA_UPLOAD_COUNT_INVALID: 页面有${count}/${files.length}集，数量异常，已停止等待和提交，请检查重复或缺失视频`);
    const progress = await cards.evaluateAll((nodes) => nodes.map((node) => ({
      text: node.textContent,
      complete: !!node.querySelector(".play-icon"),
      error: !!node.querySelector(".error-btn"),
      bars: [...node.querySelectorAll('[role="progressbar"],.el-progress-bar__inner')]
        .map((bar) => [bar.getAttribute("aria-valuenow"), bar.getAttribute("style")]),
    })));
    const signature = JSON.stringify(progress);
    if (signature !== lastProgress) {
      lastProgress = signature;
      lastProgressAt = Date.now();
    } else if (Date.now() - lastProgressAt >= 10 * 60_000) {
      throw new Error(`WEIBO_DRAMA_UPLOAD_STALLED: 视频上传连续10分钟无进展，已停止等待；请检查网络及微博页面后重试`);
    }
    if (Date.now() - lastProgressLog >= 30_000) {
      log(
        options,
        `[weibo-drama] 视频上传进度：${await page.locator(".video-card .play-icon").count()}/${files.length}集完成`,
      );
      lastProgressLog = Date.now();
    }
    for (let index = 0; index < (await cards.count()); index++) {
      const card = cards.nth(index);
      const errorIcon = card.locator(".error-btn");
      if (!(await errorIcon.count())) continue;
      await errorIcon.hover();
      const errorId = await errorIcon.getAttribute("aria-describedby");
      const message = errorId
        ? await page.locator(`[id="${errorId}"]`).innerText()
        : await page
            .locator(".el-popper:visible")
            .allInnerTexts()
            .then((values) => values.join("；"));
      const file = files[index];
      const episodeNumber = file
        ? (path.basename(file).match(/第(\d+)集/)?.[1] ?? index + 1)
        : index + 1;
      const attempt = attempts.get(index) ?? 0;
      const kind = classifyWeiboUploadError(message);
      if (!file || kind === "manual" || attempt >= maxRetries) {
        throw new Error(
          `WEIBO_DRAMA_UPLOAD_FILE_FAILED: 第${episodeNumber}集 ${file ? path.basename(file) : "未知文件"}：${message || "平台拒绝上传"}；已重试${attempt}/${maxRetries}次，请检查视频后在后台重试任务`,
        );
      }
      let uploadFile = file;
      if (kind === "resolution") {
        const result = await ensureVideoMinimumDimensions({
          inputFile: file,
          outputFile: path.join(
            options.assetDownloadDir!,
            "resolution-repair",
            path.basename(file),
          ),
          minimumWidth: 1080,
          minimumHeight: 1080,
          signal: options.signal,
          onLog: (message) => log(options, `[weibo-drama] ${message}`),
        });
        if (!result.transcoded)
          throw new Error(
            `WEIBO_DRAMA_UPLOAD_FILE_FAILED: 第${episodeNumber}集本地分辨率已符合要求，微博仍拒绝：${message}；请人工检查编码及清晰度`,
          );
        uploadFile = result.file;
      }
      attempts.set(index, attempt + 1);
      log(
        options,
        `[weibo-drama] 第${episodeNumber}集上传失败，${kind === "resolution" ? "修复分辨率后" : ""}重新上传 (${attempt + 1}/${maxRetries})：${message}`,
      );
      // The site's retry button uses mismatched uuid/id fields. Remove and re-add
      // the original file, then restore its position rather than clicking that button.
      await removeWeiboUploadItem(page, card, async () => {
        await card.locator(".video-cover").hover();
        await card.locator(".close-btn").click();
      });
      await page.locator(".upload-card input[type=file]").setInputFiles(uploadFile);
      await page.waitForFunction(
        (count) => document.querySelectorAll(".video-card").length === count,
        files.length,
        { timeout: 15_000 },
      );
      if (index < files.length - 1) {
        await cards.last().locator(".video-cover").dragTo(cards.nth(index).locator(".video-cover"));
        await cards.nth(index).locator(".video-cover .el-tooltip__trigger").first().hover();
        await page
          .getByRole("tooltip")
          .filter({ hasText: path.basename(uploadFile) })
          .waitFor({ timeout: 10_000 });
      }
      lastProgressAt = Date.now();
      break;
    }
    if (
      (await cards.count()) === files.length &&
      (await page.locator(".video-card .play-icon").count()) === files.length
    )
      return;
    await page.waitForTimeout(1_000);
  }
  throw new Error(
    `WEIBO_DRAMA_UPLOAD_TIMEOUT: 上传超时，已完成${await page.locator(".video-card .play-icon").count()}/${files.length}集，请检查网络及失败集`,
  );
}

export async function restoreWeiboEpisodeOrder(
  page: Page,
  uploadOrderFiles: string[],
  sortedFiles: string[],
  options: WeiboDramaRuntimeOptions,
) {
  await expandWeiboEpisodeGrid(page);
  if (
    uploadOrderFiles.length !== sortedFiles.length ||
    new Set(uploadOrderFiles).size !== sortedFiles.length ||
    sortedFiles.some((file) => !uploadOrderFiles.includes(file))
  )
    throw new Error("WEIBO_DRAMA_UPLOAD_ORDER_INVALID: 上传文件与目标集数不一致，已停止提交");
  const current = [...uploadOrderFiles];
  const cards = page.locator(".video-card");
  if ((await cards.count()) !== sortedFiles.length)
    throw new Error("WEIBO_DRAMA_UPLOAD_ORDER_INVALID: 微博页面视频数量与目标集数不一致");
  for (let index = 0; index < sortedFiles.length; index++) {
    options.signal?.throwIfAborted();
    const source = current.indexOf(sortedFiles[index]);
    if (source !== index) {
      await cards
        .nth(source)
        .locator(".video-cover")
        .dragTo(cards.nth(index).locator(".video-cover"));
      current.splice(index, 0, current.splice(source, 1)[0]);
    }
    // Verify the site's visible filename, not just our in-memory ordering.
    const trigger = cards.nth(index).locator(".video-cover .el-tooltip__trigger").first();
    await trigger.hover();
    const tooltipId = await trigger.getAttribute("aria-describedby");
    if (!tooltipId)
      throw new Error(
        `WEIBO_DRAMA_UPLOAD_ORDER_INVALID: 无法确认第${index + 1}集的文件名，已停止提交`,
      );
    const tooltip = page.locator(`[id="${tooltipId}"]`);
    await tooltip.waitFor({ state: "visible", timeout: 10_000 });
    if ((await tooltip.innerText()).trim() !== path.basename(sortedFiles[index]))
      throw new Error(`WEIBO_DRAMA_UPLOAD_ORDER_INVALID: 第${index + 1}集文件顺序不符，已停止提交`);
  }
  log(options, `[weibo-drama] 已核对${sortedFiles.length}集上传视频，集号顺序正确`);
}
