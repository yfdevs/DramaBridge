import type { BrowserContext, Page } from "playwright";
import {
  captureAutomationFailureDiagnostics,
  formatAutomationErrorReport,
} from "@drama/automation-logging";
import { isNonRetryableBaiduNetdiskResourceError } from "@drama/drama-media-assets";
import {
  TENCENT_HUOLONG_DRAMA_ADD_URL,
  TENCENT_HUOLONG_DRAMA_LOGIN_URL,
  TENCENT_HUOLONG_DRAMA_PLATFORM,
} from "../shared/constants.js";
import {
  cleanupOldLogFiles,
  configureTencentHuolongLogger,
  errorLog,
  log,
  runWithLogContext,
} from "../shared/logger.js";
import {
  materialRoot,
  validateTencentHuolongTaskMaterialReferences,
} from "../shared/local-materials.js";
import type {
  ClaimedTencentHuolongDramaTask,
  TencentHuolongRuntime,
  TencentHuolongRuntimeOptions,
  TencentHuolongRuntimeStatus,
  TencentHuolongTaskFailStage,
} from "../shared/types.js";
import {
  launchTencentHuolongBrowserContext,
  saveCredentialState,
  tencentHuolongLoginStateFromUrl,
  waitForLoginIfNeeded,
} from "../automation/browser-session.js";
import {
  openTencentHuolongAddPage,
  runTencentHuolongPublishTask,
} from "../automation/publish-runner.js";
import {
  claimNextTencentHuolongDramaTaskApi,
  reportTencentHuolongDramaTaskErrorApi,
  reportTencentHuolongDramaTaskSuccessApi,
} from "../api/task.js";

type LastTask = TencentHuolongRuntimeStatus["lastTask"];

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function failStage(error: unknown): TencentHuolongTaskFailStage {
  const message = errorMessage(error);
  if (/LOGIN/i.test(message)) return "LOGIN";
  if (/UPLOAD|FILE|poster|cover|素材|封面|视频/i.test(message)) return "UPLOAD_FILE";
  if (/SUBMIT/i.test(message)) return "SUBMIT";
  if (/FORM|FIELD|RADIO|OPTION/i.test(message)) return "FILL_FORM";
  return "OTHER";
}

async function ensureResource(
  task: ClaimedTencentHuolongDramaTask,
  options: TencentHuolongRuntimeOptions,
) {
  const link = task.playlet.baiduPanResourceLink?.trim();
  if (!link) return;
  if (!options.ensureBaiduNetdiskResource) {
    throw new Error("任务包含百度网盘链接，但腾讯火龙漫剧运行时未接入网盘下载能力。");
  }
  const retries = Math.max(0, options.baiduNetdiskDownloadRetryAttempts ?? 3);
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await options.ensureBaiduNetdiskResource({
        shareText: link,
        resourceName: task.originalTitle,
        localEpisodeVideoRoot: materialRoot(options),
        episodeCount: task.playlet.episodeCount,
        requiredPosterImages: 1,
        posterFallback: { title: task.playlet.title, summary: task.playlet.summary },
      });
    } catch (error) {
      lastError = error;
      if (isNonRetryableBaiduNetdiskResourceError(error) || attempt >= retries) break;
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
  throw lastError;
}

export async function ensureTencentHuolongTaskResource(
  task: ClaimedTencentHuolongDramaTask,
  options: TencentHuolongRuntimeOptions,
) {
  validateTencentHuolongTaskMaterialReferences(task);
  log(options, "[tencent-huolong-drama] 任务必需合同材料校验通过");
  return ensureResource(task, options);
}

async function runTask(
  page: Page,
  context: BrowserContext,
  task: ClaimedTencentHuolongDramaTask,
  options: TencentHuolongRuntimeOptions,
  setLastTask: (value: LastTask) => void,
) {
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
        accountId: task.accountId,
        accountName: task.accountName,
        accountTaskId: task.accountTaskId,
      },
      async () => {
        baiduNetdiskResource = await ensureTencentHuolongTaskResource(task, options);
        await runTencentHuolongPublishTask(page, context, task, options);
      },
    );
    await reportTencentHuolongDramaTaskSuccessApi({
      apiConfig: options.apiConfig,
      runtimeOptions: options,
      accountTaskId: task.accountTaskId,
      resultJson: { activeUrl: page.url(), accountId: task.accountId },
    });
    await options.cleanupBaiduNetdiskResourceAfterTaskSuccess?.(baiduNetdiskResource).catch(
      (error) => log(options, "[tencent-huolong-drama] 任务成功，但百度网盘剧目目录清理失败。", { error }),
    );
    setLastTask({
      accountTaskId: task.accountTaskId,
      originalTitle: task.originalTitle,
      status: "succeeded",
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    const message = formatAutomationErrorReport(error, {
      fallbackMessage: "腾讯火龙漫剧任务提交失败，未获取到具体错误原因",
    });
    const stage = failStage(error);
    const diagnostics = await captureAutomationFailureDiagnostics({
      platform: "tencent-huolong-drama",
      error,
      page,
      logFilePath: options.logFilePath,
      stage,
      task: { accountTaskId: task.accountTaskId, title: task.originalTitle },
    });
    setLastTask({
      accountTaskId: task.accountTaskId,
      originalTitle: task.originalTitle,
      status: "failed",
      errorMessage: message,
      updatedAt: new Date().toISOString(),
    });
    await reportTencentHuolongDramaTaskErrorApi({
      apiConfig: options.apiConfig,
      runtimeOptions: options,
      accountTaskId: task.accountTaskId,
      failStage: stage,
      errorMessage: message,
      resultJson: { activeUrl: page.url(), accountId: task.accountId },
    }).catch((reportError) =>
      errorLog(options, `[tencent-huolong-drama] 失败回调异常：${errorMessage(reportError)}`),
    );
    errorLog(
      options,
      `[tencent-huolong-drama] 失败诊断目录：${diagnostics?.directory ?? "不可用"}`,
    );
    throw error;
  }
}

export async function startTencentHuolongDramaRuntime(
  options: TencentHuolongRuntimeOptions = {},
): Promise<TencentHuolongRuntime> {
  if (!options.userDataDir) throw new Error("Tencent Huolong drama userDataDir is required.");
  configureTencentHuolongLogger(options);
  await cleanupOldLogFiles(options);

  let running = true;
  let page: Page | null = null;
  let context: BrowserContext | null = null;
  let lastTask: LastTask;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let wake: (() => void) | null = null;

  const waitPoll = () =>
    new Promise<void>((resolve) => {
      wake = resolve;
      timer = setTimeout(resolve, Math.max(1_000, options.taskPollIntervalMs ?? 10_000));
    }).finally(() => {
      if (timer) clearTimeout(timer);
      timer = null;
      wake = null;
    });

  context = await launchTencentHuolongBrowserContext(options.userDataDir, options);
  context.on("close", () => {
    running = false;
    wake?.();
  });
  page = await context.newPage();
  const activePage = page;
  const activeContext = context;

  const loop = (async () => {
    await openTencentHuolongAddPage(activePage, activeContext, options).catch((error) => {
      errorLog(options, `[tencent-huolong-drama] 打开上剧页失败：${errorMessage(error)}`);
    });
    while (running && !activePage.isClosed()) {
      try {
        await waitForLoginIfNeeded(activePage, activeContext, options);
        const task = await claimNextTencentHuolongDramaTaskApi({
          apiConfig: options.apiConfig,
          runtimeOptions: options,
        });
        if (task) {
          const taskPage = await activeContext.newPage();
          let taskFailed = false;
          log(
            options,
            `[tencent-huolong-drama] 已打开独立任务标签页：accountTaskId=${task.accountTaskId}`,
          );
          try {
            await runTask(taskPage, activeContext, task, options, (value) => {
              lastTask = value;
            });
          } catch (error) {
            taskFailed = true;
            throw error;
          } finally {
            if (taskPage.isClosed()) {
              log(
                options,
                `[tencent-huolong-drama] 任务标签页已被关闭：accountTaskId=${task.accountTaskId}`,
              );
            } else if (!taskFailed || options.closeFailedTaskPages === true) {
              await taskPage.close().catch(() => undefined);
              log(
                options,
                `[tencent-huolong-drama] 已关闭独立任务标签页：accountTaskId=${task.accountTaskId}`,
              );
            } else {
              log(options, `[tencent-huolong-drama] 已保留失败任务标签页供排查`, {
                accountTaskId: task.accountTaskId,
                activeUrl: taskPage.url(),
              });
            }
          }
        } else {
          log(options, "[tencent-huolong-drama] 暂无可领取任务");
        }
      } catch (error) {
        errorLog(options, `[tencent-huolong-drama] 任务轮询失败：${errorMessage(error)}`);
      }
      if (running && !activePage.isClosed()) await waitPoll();
    }
  })();

  return {
    getStatus() {
      const activeUrl = page?.url();
      return {
        platform: TENCENT_HUOLONG_DRAMA_PLATFORM,
        running,
        loginState: tencentHuolongLoginStateFromUrl(activeUrl),
        activeUrl,
        addUrl: TENCENT_HUOLONG_DRAMA_ADD_URL,
        loginUrl: TENCENT_HUOLONG_DRAMA_LOGIN_URL,
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
      wake?.();
      if (context) await saveCredentialState(context, options).catch(() => undefined);
      await context?.close();
      await loop.catch(() => undefined);
      log(options, "[tencent-huolong-drama] 运行时已停止");
    },
  };
}
