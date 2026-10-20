import type { BrowserContext, Page } from "playwright";
import {
  captureAutomationFailureDiagnostics,
  formatAutomationErrorReport,
} from "@dramabridge/automation-logging";
import { isNonRetryableBaiduNetdiskResourceError } from "@dramabridge/media-assets";
import { QQ_DRAMA_ADD_URL, QQ_DRAMA_LOGIN_URL, QQ_DRAMA_PLATFORM } from "../shared/constants.js";
import {
  cleanupOldLogFiles,
  configureQqDramaLogger,
  errorLog,
  log,
  runWithLogContext,
} from "../shared/logger.js";
import type {
  ClaimedQqDramaTask,
  QqDramaRuntime,
  QqDramaRuntimeOptions,
  QqDramaRuntimeStatus,
  QqDramaTaskFailStage,
} from "../shared/types.js";
import {
  getQqDramaLocalEpisodeVideoRoot,
  getQqDramaOriginalTitle,
  validateQqDramaLocalEpisodeVideos,
} from "../shared/local-episode-videos.js";
import { prepareQqDramaPosterMaterials } from "../shared/poster-materials.js";
import {
  createQqDramaPublishVariants,
  shouldOpenNewQqDramaVariantPage,
} from "../shared/publish-variants.js";
import {
  launchQqDramaBrowserContext,
  qqDramaLoginStateFromUrl,
  saveCredentialState,
  waitForLoginIfNeeded,
} from "../automation/browser-session.js";
import { openQqDramaAddPage, runQqDramaPublishTask } from "../automation/publish-runner.js";
import { findUploadedQqDramaByExactTitle } from "../automation/drama-list.js";
import {
  claimNextQqDramaTaskApi,
  reportQqDramaTaskErrorApi,
  reportQqDramaTaskSuccessApi,
} from "../api/task.js";

type LastTaskStatus = QqDramaRuntimeStatus["lastTask"];

const defaultTaskPollIntervalMs = 10_000;
const reportMaxAttempts = 3;
const reportRetryDelayMs = 5_000;

function pollIntervalMs(options: QqDramaRuntimeOptions) {
  return Math.max(1_000, options.taskPollIntervalMs ?? defaultTaskPollIntervalMs);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function reportWithRetry(
  options: QqDramaRuntimeOptions,
  accountTaskId: number,
  callback: () => Promise<void>,
) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= reportMaxAttempts; attempt += 1) {
    try {
      await callback();
      return;
    } catch (error) {
      lastError = error;
      if (attempt >= reportMaxAttempts) break;
      log(
        options,
        `[qq-drama] task report failed, retrying: accountTaskId=${accountTaskId} ` +
          `attempt=${attempt}/${reportMaxAttempts} error=${errorMessage(error)}`,
      );
      await new Promise((resolve) => setTimeout(resolve, reportRetryDelayMs));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function setFixedPageTitle(page: Page, title: string) {
  await page
    .evaluate((value) => {
      const windowState = window as unknown as { __qqDramaAccountFixedTitle?: string };
      windowState.__qqDramaAccountFixedTitle = value;
      document.title = value;
    }, title)
    .catch(() => undefined);
}

async function installFixedPageTitle(context: BrowserContext, title: string) {
  await context.addInitScript((fixedTitle) => {
    const windowState = window as unknown as {
      __qqDramaAccountFixedTitle?: string;
      __qqDramaAccountFixedTitleInstalled?: boolean;
    };
    windowState.__qqDramaAccountFixedTitle = fixedTitle;
    const applyTitle = () => {
      const title = windowState.__qqDramaAccountFixedTitle ?? fixedTitle;
      if (document.title !== title) document.title = title;
    };
    const watchTitle = () => {
      applyTitle();
      const titleElement =
        document.querySelector("title") ??
        document.head?.appendChild(document.createElement("title"));
      if (!titleElement || titleElement.dataset.fixedQqDramaAccountTitle === "true") return;

      titleElement.dataset.fixedQqDramaAccountTitle = "true";
      new MutationObserver(applyTitle).observe(titleElement, {
        characterData: true,
        childList: true,
        subtree: true,
      });
    };

    if (windowState.__qqDramaAccountFixedTitleInstalled) {
      applyTitle();
      return;
    }
    windowState.__qqDramaAccountFixedTitleInstalled = true;
    watchTitle();
    window.addEventListener("DOMContentLoaded", watchTitle);
    window.addEventListener("load", watchTitle);
    window.setInterval(applyTitle, 1_000);
  }, title);

  const keepPageTitle = (page: Page) => {
    const applyTitle = () => {
      void setFixedPageTitle(page, title);
    };
    page.on("domcontentloaded", applyTitle);
    page.on("load", applyTitle);
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) applyTitle();
    });
    applyTitle();
  };
  context.on("page", keepPageTitle);
  for (const page of context.pages()) keepPageTitle(page);
}

function classifyFailStage(error: unknown, fallback: QqDramaTaskFailStage): QqDramaTaskFailStage {
  const message = errorMessage(error);
  if (message.includes("LOGIN")) return "LOGIN";
  if (
    /\[local-video-invalid\]|\[poster-material-invalid\]|\[copyright-proof-invalid\]|local episode videos|剧集视频|本地剧集视频|封面|海报|权属|FILE|UPLOAD/i.test(
      message,
    )
  ) {
    return "UPLOAD_FILE";
  }
  if (message.includes("FIELD") || message.includes("FORM")) return "FILL_FORM";
  return fallback;
}

async function ensureBaiduNetdiskResourceReady(
  task: ClaimedQqDramaTask,
  options: QqDramaRuntimeOptions,
) {
  const baiduPanResourceLink = task.playlet.baiduPanResourceLink?.trim();
  const episodeCount = task.playlet.episodeCount;
  if (!baiduPanResourceLink || !episodeCount) return;

  if (!options.ensureBaiduNetdiskResource) {
    throw new Error("任务包含百度网盘资源链接，但当前 QQ 运行时未接入百度网盘下载能力。");
  }

  const localEpisodeVideoRoot = getQqDramaLocalEpisodeVideoRoot(options);
  const resourceName = getQqDramaOriginalTitle(task);
  const retryAttempts = Math.max(0, options.baiduNetdiskDownloadRetryAttempts ?? 3);
  const maxAttempts = retryAttempts + 1;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      log(options, "[qq-drama] ensuring baidu netdisk resource", {
        accountTaskId: task.accountTaskId,
        resourceName,
        episodeCount,
        attempt,
        maxAttempts,
      });
      return await options.ensureBaiduNetdiskResource({
        shareText: baiduPanResourceLink,
        resourceName,
        localEpisodeVideoRoot,
        episodeCount,
        requiredPosterImages: 1,
        posterFallback: {
          title: task.playlet.title,
          summary: task.playlet.summary,
        },
      });
    } catch (error) {
      lastError = error;
      const message = errorMessage(error);
      const nonRetryable = isNonRetryableBaiduNetdiskResourceError(error);
      if (nonRetryable || attempt >= maxAttempts) break;
      log(options, "[qq-drama] baidu netdisk resource failed, retrying", {
        accountTaskId: task.accountTaskId,
        attempt,
        nextAttempt: attempt + 1,
        maxAttempts,
        errorMessage: message,
      });
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function runTask(
  page: Page,
  context: BrowserContext,
  task: ClaimedQqDramaTask,
  options: QqDramaRuntimeOptions,
  setLastTask: (status: LastTaskStatus) => void,
) {
  let publishSucceeded = false;
  let activeVariantPage = page;
  const additionalVariantPages: Page[] = [];
  const variantResults = new Map<
    "primary" | "secondary",
    { kind: "primary" | "secondary"; title: string; existing: boolean; dramaId?: string }
  >();
  let baiduNetdiskResource: unknown;
  setLastTask({
    accountTaskId: task.accountTaskId,
    originalTitle: task.originalTitle,
    status: "running",
    updatedAt: new Date().toISOString(),
  });

  try {
    await runWithLogContext(
      {
        accountTaskId: task.accountTaskId,
        qqAccountId: task.qqAccountId,
        qqAccountName: task.qqAccountName,
      },
      async () => {
        const variants = createQqDramaPublishVariants(task, options.acceptSecondVersion !== false);
        const missingVariants: typeof variants = [];
        for (const variant of variants) {
          const existingDrama = await findUploadedQqDramaByExactTitle(context, variant.title);
          if (existingDrama) {
            variantResults.set(variant.kind, {
              ...variant,
              existing: true,
              dramaId: existingDrama.drama_id,
            });
            log(options, `[qq-drama] variant already exists; skipping upload`, {
              kind: variant.kind,
              title: variant.title,
              dramaId: existingDrama.drama_id,
              approvalStatus: existingDrama.approval_status,
              uploadedEpisodeCount: existingDrama.uploaded_episode_count,
            });
          } else {
            missingVariants.push(variant);
            log(options, `[qq-drama] variant not found; upload required`, {
              kind: variant.kind,
              title: variant.title,
            });
          }
        }

        if (missingVariants.length === 0) {
          log(options, `[qq-drama] all publish variants already exist; reporting task success`);
          return;
        }

        baiduNetdiskResource = await ensureBaiduNetdiskResourceReady(task, options);
        await validateQqDramaLocalEpisodeVideos(task, options);
        const posters = await prepareQqDramaPosterMaterials(task, options);
        log(options, `[qq-drama] publish covers ready`, posters);
        for (const variant of missingVariants) {
          const variantIndex = variants.findIndex((candidate) => candidate.kind === variant.kind);
          const variantPage = shouldOpenNewQqDramaVariantPage(variantIndex)
            ? await context.newPage()
            : page;
          activeVariantPage = variantPage;
          if (variantPage !== page) {
            additionalVariantPages.push(variantPage);
            log(options, `[qq-drama] opened dedicated variant page`, {
              kind: variant.kind,
              title: variant.title,
            });
          }
          const localCoverFile = variant.kind === "primary" ? posters.primary : posters.secondary;
          if (!localCoverFile) {
            throw new Error(`QQ_DRAMA_VARIANT_COVER_MISSING: ${variant.kind}`);
          }
          const variantTask: ClaimedQqDramaTask = {
            ...task,
            playlet: {
              ...task.playlet,
              title: variant.title,
              localCoverFile,
            },
          };
          log(options, `[qq-drama] publishing variant`, {
            kind: variant.kind,
            title: variant.title,
          });
          await runQqDramaPublishTask(variantPage, context, variantTask, options);
          variantResults.set(variant.kind, { ...variant, existing: false });
        }
      },
    );
    publishSucceeded = true;
    const publishedVariants = createQqDramaPublishVariants(
      task,
      options.acceptSecondVersion !== false,
    ).map((variant) => {
      const result = variantResults.get(variant.kind);
      if (!result) throw new Error(`QQ_DRAMA_VARIANT_RESULT_MISSING: ${variant.kind}`);
      return result;
    });
    await reportWithRetry(options, task.accountTaskId, () =>
      reportQqDramaTaskSuccessApi({
        apiConfig: options.apiConfig,
        runtimeOptions: options,
        accountTaskId: task.accountTaskId,
        resultJson: {
          activeUrl: activeVariantPage.url(),
          accountId: task.qqAccountId,
          accountName: task.qqAccountName,
          variants: publishedVariants,
        },
      }),
    );
    if (baiduNetdiskResource && options.cleanupBaiduNetdiskResourceAfterTaskSuccess) {
      try {
        await options.cleanupBaiduNetdiskResourceAfterTaskSuccess(baiduNetdiskResource);
      } catch (error) {
        log(options, `[qq-drama] task succeeded but baidu netdisk cleanup failed`, {
          accountTaskId: task.accountTaskId,
          errorMessage: errorMessage(error),
        });
      }
    }
    setLastTask({
      accountTaskId: task.accountTaskId,
      originalTitle: task.originalTitle,
      status: "succeeded",
      updatedAt: new Date().toISOString(),
    });
    log(options, `[qq-drama] task succeeded: accountTaskId=${task.accountTaskId}`);
  } catch (error) {
    const message = formatAutomationErrorReport(error, {
      fallbackMessage: "QQ 任务提交失败，未获取到具体错误原因",
    });
    const failStage = classifyFailStage(error, "FILL_FORM");
    const diagnostics = await captureAutomationFailureDiagnostics({
      platform: "qq-drama",
      error,
      page: activeVariantPage,
      logFilePath: options.logFilePath,
      stage: failStage,
      task: { accountTaskId: task.accountTaskId, title: task.originalTitle },
    });
    setLastTask({
      accountTaskId: task.accountTaskId,
      originalTitle: task.originalTitle,
      status: "failed",
      errorMessage: message,
      updatedAt: new Date().toISOString(),
    });
    if (!publishSucceeded) {
      await reportWithRetry(options, task.accountTaskId, () =>
        reportQqDramaTaskErrorApi({
          apiConfig: options.apiConfig,
          runtimeOptions: options,
          accountTaskId: task.accountTaskId,
          dramaId: task.dramaId,
          failStage,
          errorMessage: message,
          resultJson: {
            activeUrl: activeVariantPage.url(),
            accountId: task.qqAccountId,
            accountName: task.qqAccountName,
          },
        }),
      ).catch((callbackError) => {
        errorLog(options, `[qq-drama] fail callback failed: ${errorMessage(callbackError)}`);
      });
    } else {
      errorLog(
        options,
        `[qq-drama] publish succeeded but success callback failed: ` +
          `accountTaskId=${task.accountTaskId} error=${message}`,
      );
    }
    errorLog(options, `[qq-drama] failure diagnostics: ${diagnostics?.directory ?? "unavailable"}`);
    throw error;
  } finally {
    await Promise.allSettled(additionalVariantPages.map((variantPage) => variantPage.close()));
  }
}

export async function startQqDramaRuntime(
  options: QqDramaRuntimeOptions = {},
): Promise<QqDramaRuntime> {
  if (!options.userDataDir) {
    throw new Error("QQ drama userDataDir is required.");
  }

  const userDataDir = options.userDataDir;

  // Runtime 生命周期状态：Electron 通过返回的 getStatus/stop 控制这一个浏览器实例。
  let running = true;
  let page: Page | null = null;
  let context: BrowserContext | null = null;

  // 任务轮询相关状态。
  let taskLoopPromise: Promise<void> | null = null;
  let taskLoopTimer: ReturnType<typeof setTimeout> | null = null;
  let wakeTaskLoop: (() => void) | null = null;
  let lastTask: LastTaskStatus;

  function setLastTask(status: LastTaskStatus) {
    lastTask = status;
  }

  async function waitForNextPoll() {
    // 等待下一轮领取任务；stop 时会调用 wakeTaskLoop 立即唤醒并退出。
    await new Promise<void>((resolve) => {
      wakeTaskLoop = resolve;
      taskLoopTimer = setTimeout(resolve, pollIntervalMs(options));
    });
    if (taskLoopTimer) {
      clearTimeout(taskLoopTimer);
      taskLoopTimer = null;
    }
    wakeTaskLoop = null;
  }

  function stopTaskLoopWait() {
    // 停止服务时清掉定时器，防止后台轮询继续挂着。
    if (taskLoopTimer) {
      clearTimeout(taskLoopTimer);
      taskLoopTimer = null;
    }
    wakeTaskLoop?.();
    wakeTaskLoop = null;
  }

  async function runTaskLoop(activePage: Page, activeContext: BrowserContext) {
    // 正式运行模式：确认登录 -> 领取任务 -> 准备百度网盘资源 -> 上剧 -> 回调结果。
    while (running && !activePage.isClosed()) {
      try {
        await waitForLoginIfNeeded(activePage, activeContext, options);
        const task = await claimNextQqDramaTaskApi({
          apiConfig: options.apiConfig,
          runtimeOptions: options,
        });

        if (task) {
          const taskPage = await activeContext.newPage();
          log(
            options,
            `[qq-drama] opened dedicated task page: accountTaskId=${task.accountTaskId}`,
          );
          try {
            await runTask(taskPage, activeContext, task, options, setLastTask);
          } finally {
            await taskPage.close().catch(() => undefined);
            log(
              options,
              `[qq-drama] closed dedicated task page: accountTaskId=${task.accountTaskId}`,
            );
          }
        } else {
          log(options, "[qq-drama] no claimable task");
        }
      } catch (error) {
        errorLog(options, `[qq-drama] task loop tick failed: ${errorMessage(error)}`);
      }

      if (!running || activePage.isClosed()) break;
      await waitForNextPoll();
    }
  }

  configureQqDramaLogger(options);
  cleanupOldLogFiles(options);

  // QQ 有反爬要求，这里启动的是本机正式版 Chrome，并复用 userDataDir 保存登录态。
  log(options, `[qq-drama] starting browser: userDataDir=${userDataDir}`);
  context = await launchQqDramaBrowserContext(userDataDir, options);
  await installFixedPageTitle(
    context,
    options.qqAccountName?.trim() || options.qqAccountId?.trim() || "QQ短剧",
  );
  context.on("close", () => {
    running = false;
    stopTaskLoopWait();
  });

  // 不复用 Chromium 恢复出来的旧标签；旧标签可能仍停留在上一任务的提交成功页。
  page = await context.newPage();
  taskLoopPromise = (async () => {
    await openQqDramaAddPage(page!, context!, options).catch((error) => {
      errorLog(options, `[qq-drama] failed to open add page: ${errorMessage(error)}`);
    });
    if (!running || page!.isClosed()) return;
    await runTaskLoop(page!, context!);
  })();

  return {
    getStatus(): QqDramaRuntimeStatus {
      const activeUrl = page?.url();
      return {
        platform: QQ_DRAMA_PLATFORM,
        running,
        loginState: qqDramaLoginStateFromUrl(activeUrl),
        activeUrl,
        addUrl: QQ_DRAMA_ADD_URL,
        loginUrl: QQ_DRAMA_LOGIN_URL,
        userDataDir,
        accountProfileName: options.accountProfileName,
        accountDir: options.accountDir,
        credentialStatePath: options.credentialStatePath,
        assetDownloadDir: options.assetDownloadDir,
        logFilePath: options.logFilePath,
        lastTask,
      };
    },
    async stop() {
      // stop 会保存一次 storage-state，再关闭持久化浏览器上下文。
      running = false;
      stopTaskLoopWait();
      if (context) {
        await saveCredentialState(context, options).catch(() => undefined);
      }
      await context?.close();
      await taskLoopPromise?.catch(() => undefined);
      log(options, "[qq-drama] runtime stopped");
    },
  };
}
