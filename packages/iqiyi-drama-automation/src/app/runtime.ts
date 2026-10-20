import type { BrowserContext, Page } from "playwright";
import {
  captureAutomationFailureDiagnostics,
  formatAutomationErrorReport,
} from "@dramabridge/automation-logging";
import { isNonRetryableBaiduNetdiskResourceError } from "@dramabridge/media-assets";

import {
  claimNextIqiyiDramaTaskApi,
  reportIqiyiDramaTaskErrorApi,
  reportIqiyiDramaTaskSuccessApi,
} from "../api/task.js";
import {
  IQIYI_COMIC_DRAMA_CREATE_URL,
  IQIYI_DRAMA_LOGIN_URL,
  IQIYI_DRAMA_PLATFORM,
  IQIYI_SHORT_DRAMA_CREATE_URL,
} from "../shared/constants.js";
import {
  cleanupOldLogFiles,
  configureIqiyiDramaLogger,
  errorLog,
  log,
  runWithLogContext,
} from "../shared/logger.js";
import { prepareIqiyiMaterials } from "../shared/materials.js";
import type {
  ClaimedIqiyiDramaTask,
  IqiyiDramaRuntime,
  IqiyiDramaRuntimeOptions,
  IqiyiDramaRuntimeStatus,
  IqiyiDramaTaskFailStage,
} from "../shared/types.js";
import {
  iqiyiDramaLoginStateFromUrl,
  launchIqiyiDramaBrowserContext,
  saveCredentialState,
  waitForIqiyiLogin,
} from "../automation/browser-session.js";
import { runIqiyiPublishTask } from "../automation/publish-runner.js";

type LastTask = IqiyiDramaRuntimeStatus["lastTask"];
const iqiyiMaterialPreparationTimeoutMs = 15 * 60 * 1_000;

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number, errorCode: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(errorCode)), timeoutMs);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function failStage(error: unknown, fallback: IqiyiDramaTaskFailStage) {
  const value = message(error);
  if (/LOGIN|登录/i.test(value)) return "LOGIN";
  if (/cover|poster|ownership|copyright|asset|upload|封面|海报|权属|版权|上传|文件/i.test(value)) {
    return "UPLOAD_FILE";
  }
  if (/SUBMIT|提交/i.test(value)) return "SUBMIT";
  if (/FIELD|FORM|表单|字段/i.test(value)) return "FILL_FORM";
  return fallback;
}

async function reportWithRetry(
  options: IqiyiDramaRuntimeOptions,
  accountTaskId: number,
  action: () => Promise<void>,
) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await action();
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        log(
          options,
          `[iqiyi-drama] task report retry ${attempt}/3: ` +
            `accountTaskId=${accountTaskId} error=${message(error)}`,
        );
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function iqiyiBaiduMaterialRequirements() {
  return {
    forceAssetDownload: true,
    requiredOwnership: { minimumImages: 0 },
    requiredOwnershipFiles: 0,
    requiredPosterImages: 1,
    requireAllDiscoveredAssets: false,
  } as const;
}

async function ensureRemoteMaterials(
  task: ClaimedIqiyiDramaTask,
  options: IqiyiDramaRuntimeOptions,
) {
  const shareText = task.playlet.baiduPanResourceLink?.trim();
  if (!shareText) return;
  if (!options.ensureBaiduNetdiskResource) {
    throw new Error("任务包含百度网盘资源链接，但爱奇艺运行时未接入百度网盘下载能力。");
  }
  const localMaterialRoot = options.localMaterialRoot?.trim();
  if (!localMaterialRoot) throw new Error("请先配置爱奇艺本地素材根目录。");

  const maximumAttempts = Math.max(0, options.baiduNetdiskDownloadRetryAttempts ?? 3) + 1;
  const downloadEpisodeVideos = true;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      log(options, "[iqiyi-drama] downloading task materials", {
        attempt,
        maximumAttempts,
        downloadEpisodeVideos,
        episodeCount: task.playlet.episodeCount,
        resourceName: task.originalTitle,
      });
      return await options.ensureBaiduNetdiskResource({
        shareText,
        resourceName: task.originalTitle,
        localEpisodeVideoRoot: localMaterialRoot,
        episodeCount: task.playlet.episodeCount,
        downloadEpisodeVideos,
        ...iqiyiBaiduMaterialRequirements(),
        posterFallback: {
          title: task.playlet.title,
          summary: task.playlet.summary,
        },
      });
    } catch (error) {
      lastError = error;
      if (isNonRetryableBaiduNetdiskResourceError(error) || attempt >= maximumAttempts) break;
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function executeTask(
  page: Page,
  context: BrowserContext,
  task: ClaimedIqiyiDramaTask,
  options: IqiyiDramaRuntimeOptions,
  setLastTask: (task: LastTask) => void,
) {
  setLastTask({
    accountTaskId: task.accountTaskId,
    originalTitle: task.originalTitle,
    dramaType: task.playlet.dramaType,
    status: "running",
    updatedAt: new Date().toISOString(),
  });
  let published = false;
  let baiduNetdiskResource: unknown;
  try {
    await runWithLogContext(
      {
        accountTaskId: task.accountTaskId,
        iqiyiAccountId: task.iqiyiAccountId,
        iqiyiAccountName: task.iqiyiAccountName,
      },
      async () => {
        baiduNetdiskResource = await ensureRemoteMaterials(task, options);
        const materials = await withTimeout(
          prepareIqiyiMaterials(task, options),
          iqiyiMaterialPreparationTimeoutMs,
          `IQIYI_DRAMA_MATERIAL_PREPARATION_TIMEOUT: ${
            iqiyiMaterialPreparationTimeoutMs / 60_000
          } minutes`,
        );
        await runIqiyiPublishTask(page, context, task, options, materials);
      },
    );
    published = true;
    await reportWithRetry(options, task.accountTaskId, () =>
      reportIqiyiDramaTaskSuccessApi({
        apiConfig: options.apiConfig,
        runtimeOptions: options,
        accountTaskId: task.accountTaskId,
        resultJson: {
          activeUrl: page.url(),
          accountId: task.iqiyiAccountId,
          accountName: task.iqiyiAccountName,
          dramaType: task.playlet.dramaType,
          generatedLandscapeCover: task.playlet.horizontalCoverFile,
        },
      }),
    );
    await options.cleanupBaiduNetdiskResourceAfterTaskSuccess?.(baiduNetdiskResource).catch(
      (error) => log(options, "[iqiyi-drama] task succeeded but baidu netdisk cleanup failed", { error }),
    );
    setLastTask({
      accountTaskId: task.accountTaskId,
      originalTitle: task.originalTitle,
      dramaType: task.playlet.dramaType,
      status: "succeeded",
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    const errorMessage = formatAutomationErrorReport(error, {
      fallbackMessage: "爱奇艺任务提交失败，未获取到具体错误原因",
    });
    const stage = failStage(error, "FILL_FORM");
    const diagnostics = await captureAutomationFailureDiagnostics({
      platform: "iqiyi-drama",
      error,
      page,
      logFilePath: options.logFilePath,
      stage,
      task: {
        accountTaskId: task.accountTaskId,
        title: task.originalTitle,
        dramaType: task.playlet.dramaType,
      },
    });
    setLastTask({
      accountTaskId: task.accountTaskId,
      originalTitle: task.originalTitle,
      dramaType: task.playlet.dramaType,
      status: "failed",
      errorMessage,
      updatedAt: new Date().toISOString(),
    });
    if (!published) {
      await reportWithRetry(options, task.accountTaskId, () =>
        reportIqiyiDramaTaskErrorApi({
          apiConfig: options.apiConfig,
          runtimeOptions: options,
          accountTaskId: task.accountTaskId,
          failStage: stage,
          errorMessage,
          resultJson: { activeUrl: page.url(), dramaType: task.playlet.dramaType },
        }),
      ).catch((reportError) => {
        errorLog(options, `[iqiyi-drama] fail callback failed: ${message(reportError)}`);
      });
    }
    errorLog(options, `[iqiyi-drama] failure diagnostics: ${diagnostics?.directory ?? "unavailable"}`);
    throw error;
  }
}

async function installFixedTitle(context: BrowserContext, title: string) {
  await context.addInitScript((fixedTitle) => {
    const apply = () => {
      if (document.title !== fixedTitle) document.title = fixedTitle;
    };
    window.addEventListener("DOMContentLoaded", apply);
    window.addEventListener("load", apply);
    window.setInterval(apply, 1_000);
  }, title);
}

export async function startIqiyiDramaRuntime(
  options: IqiyiDramaRuntimeOptions = {},
): Promise<IqiyiDramaRuntime> {
  if (!options.userDataDir) throw new Error("爱奇艺浏览器用户数据目录未配置。");
  configureIqiyiDramaLogger(options);
  cleanupOldLogFiles(options);

  let running = true;
  let lastTask: LastTask;
  let loopTimer: ReturnType<typeof setTimeout> | null = null;
  let wakeLoop: (() => void) | null = null;
  const context = await launchIqiyiDramaBrowserContext(options.userDataDir, options);
  await installFixedTitle(
    context,
    options.iqiyiAccountName?.trim() || options.iqiyiAccountId?.trim() || "爱奇艺",
  );
  context.on("close", () => {
    running = false;
    wakeLoop?.();
  });
  const page = await context.newPage();

  const waitNext = () =>
    new Promise<void>((resolve) => {
      wakeLoop = resolve;
      loopTimer = setTimeout(resolve, Math.max(1_000, options.taskPollIntervalMs ?? 10_000));
    }).finally(() => {
      if (loopTimer) clearTimeout(loopTimer);
      loopTimer = null;
      wakeLoop = null;
    });

  const loop = (async () => {
    await page
      .goto(IQIYI_COMIC_DRAMA_CREATE_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      .catch((error) => errorLog(options, `[iqiyi-drama] initial page failed: ${message(error)}`));
    while (running && !page.isClosed()) {
      try {
        await waitForIqiyiLogin(page, context, options);
        if (!running || page.isClosed()) break;
        if (iqiyiDramaLoginStateFromUrl(page.url()) !== "logged-in") continue;
        const task = await claimNextIqiyiDramaTaskApi({
          apiConfig: options.apiConfig,
          runtimeOptions: options,
        });
        if (task) {
          const taskPage = await context.newPage();
          let taskFailed = false;
          try {
            await executeTask(taskPage, context, task, options, (value) => {
              lastTask = value;
            });
          } catch (error) {
            taskFailed = true;
            throw error;
          } finally {
            if (!taskFailed || options.closeFailedTaskPages === true) {
              await taskPage.close().catch(() => undefined);
            } else {
              log(options, "[iqiyi-drama] failed task page retained for inspection", {
                accountTaskId: task.accountTaskId,
                activeUrl: taskPage.url(),
              });
            }
          }
        } else {
          log(options, "[iqiyi-drama] no claimable task");
        }
      } catch (error) {
        errorLog(options, `[iqiyi-drama] task loop tick failed: ${message(error)}`);
      }
      if (!running || page.isClosed()) break;
      await waitNext();
    }
  })();

  return {
    getStatus() {
      return {
        platform: IQIYI_DRAMA_PLATFORM,
        running,
        loginState: iqiyiDramaLoginStateFromUrl(page.url()),
        activeUrl: page.url(),
        shortDramaCreateUrl: IQIYI_SHORT_DRAMA_CREATE_URL,
        comicDramaCreateUrl: IQIYI_COMIC_DRAMA_CREATE_URL,
        loginUrl: IQIYI_DRAMA_LOGIN_URL,
        userDataDir: options.userDataDir!,
        accountProfileName: options.accountProfileName,
        accountDir: options.accountDir,
        credentialStatePath: options.credentialStatePath,
        assetDownloadDir: options.assetDownloadDir,
        logFilePath: options.logFilePath,
        lastTask,
      };
    },
    async stop() {
      running = false;
      if (loopTimer) clearTimeout(loopTimer);
      wakeLoop?.();
      await saveCredentialState(context, options).catch(() => undefined);
      await context.close().catch(() => undefined);
      await loop.catch(() => undefined);
      log(options, "[iqiyi-drama] runtime stopped");
    },
  };
}
