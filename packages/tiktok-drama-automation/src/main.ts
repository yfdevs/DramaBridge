import { mkdir } from "node:fs/promises";
import { formatAutomationErrorReport } from "@dramabridge/automation-logging";
import { FeishuNotifier } from "@dramabridge/feishu-notifier";
import { chromium, type BrowserContext, type Page } from "playwright";
import { claimNextTiktokDramaTaskApi } from "./api/index.js";
import { config, configureTiktokDramaCenterRuntimeSettings, logger } from "./config.js";
import { fillDraft, waitForDraftPage } from "./draft-form.js";
import { matchVideos, resolveCoverFile } from "./media.js";
import type { Scheme } from "./scheme.js";

async function main() {
  configureTiktokDramaCenterRuntimeSettings();
  const notifier = new FeishuNotifier({
    channelIdLabel: "platform",
    channelLabel: "TikTok",
    logger,
    webhookUrl: config.feishuBotWebhookUrl,
  });
  const context = await launchContext();
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(config.draftUrl, { waitUntil: "domcontentloaded" });
    await waitForDraftPage(page);

    logger.info("draft ready; claiming task");
    const task = await claimNextTiktokDramaTaskApi();
    if (!task) {
      logger.info("no tiktok drama task claimed");
      await keepBrowserOpen();
      return;
    }

    const scheme = task.scheme;
    const notificationPayload = {
      accountTaskId: task.accountTaskId,
      channelId: "tiktok-drama",
      channelName: "TikTok Drama Center",
      dramaId: task.dramaId,
      originalTitle: task.originalTitle,
    };
    logger.info(
      {
        accountTaskId: task.accountTaskId,
        dramaId: task.dramaId,
        taskId: scheme.id,
        title: scheme.title,
      },
      "claimed task",
    );

    await notifier.notifyTaskStarted({
      ...notificationPayload,
      mode: "run",
    });

    try {
      const videos = scheme.baiduPanResourceLink
        ? []
        : await resolveTaskVideos(scheme, task.originalTitle, task.allowMissingVideos);
      const coverFile = await resolveCoverFile(scheme.coverFile, scheme.id);

      logger.info(
        {
          accountTaskId: task.accountTaskId,
          dramaId: task.dramaId,
          taskId: scheme.id,
          title: scheme.title,
          videos: videos.length,
        },
        "starting task",
      );
      const stopWatchingToast = new AbortController();
      try {
        await Promise.race([
          runTask(page, scheme, coverFile, videos),
          watchToast(page, stopWatchingToast.signal),
        ]);
      } finally {
        stopWatchingToast.abort();
      }
      await notifier.notifyTaskSucceeded(notificationPayload);
    } catch (error) {
      await notifier.notifyTaskFailed({
        ...notificationPayload,
        errorMessage: formatAutomationErrorReport(error, {
          fallbackMessage: "TikTok 任务提交失败，未获取到具体错误原因",
        }),
      });
      throw error;
    }
    await keepBrowserOpen();
  } catch (error) {
    logger.error({ err: error }, "task failed");
    await keepBrowserOpen();
    await context.close();
    process.exitCode = 1;
  }
}

async function resolveTaskVideos(
  scheme: Scheme,
  originalTitle: string,
  allowMissingVideos = false,
) {
  try {
    return await matchVideos(config.videoDir, originalTitle, scheme.episodeCount);
  } catch (error) {
    if (!allowMissingVideos) throw error;
    logger.warn(
      {
        err: error,
        taskId: scheme.id,
        originalTitle,
        title: scheme.title,
        videoDir: config.videoDir,
      },
      "video files missing; skipping video upload for fake task",
    );
    return [];
  }
}

async function runTask(
  page: Page,
  scheme: Scheme,
  coverFile: string,
  videos: Awaited<ReturnType<typeof matchVideos>>,
) {
  await fillDraft(page, scheme, coverFile, videos);

  if (scheme.submit || config.submit) {
    await page.getByRole("button", { name: "提交" }).click();
    logger.info({ taskId: scheme.id }, "task submitted");
  } else {
    logger.info({ taskId: scheme.id }, "task finished without submit");
  }
  await page.waitForTimeout(config.postTaskWatchMs);
}

async function keepBrowserOpen() {
  if (!config.keepBrowserOpen) return;
  logger.warn("browser kept open; press Ctrl+C to exit");
  await new Promise(() => {});
}

async function watchToast(page: Page, signal: AbortSignal) {
  const portal = page.locator("[data-tux-toast-portal]").last();
  while (!signal.aborted) {
    await Promise.race([
      portal.waitFor({ state: "attached", timeout: 0 }),
      new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })),
    ]);
    if (signal.aborted) return await new Promise<never>(() => {});

    const message = (await portal.innerText()).replace(/\s*复制\s*$/, "").trim();
    if (await clickToastConfirm(page, message)) {
      continue;
    }
    logger.error({ toast: message }, "toast error");
    throw new Error(`toast error: ${message}`);
  }

  return await new Promise<never>(() => {});
}

async function clickToastConfirm(page: Page, message: string) {
  const confirmButton = page.getByRole("button", { name: /^(Confirm|确认|确定)$/i }).last();
  if (!(await confirmButton.isVisible({ timeout: 2_000 }).catch(() => false))) {
    return false;
  }

  await confirmButton.click();
  logger.warn({ toast: message }, "toast confirmed");
  await page.waitForTimeout(500);
  return true;
}

async function launchContext(): Promise<BrowserContext> {
  await mkdir(config.userDataDir, { recursive: true });
  logger.info({ userDataDir: config.userDataDir }, "using persistent browser profile");
  return chromium.launchPersistentContext(config.userDataDir, {
    headless: config.headless,
    viewport: null,
    acceptDownloads: true,
    timeout: 0,
  });
}

main().catch((error) => {
  logger.error({ err: error }, "task failed before browser was ready");
  process.exitCode = 1;
});
